# Ceph 架构：RADOS、CRUSH 与 PG

前面几课的概念——确定性放置、主副本复制、Paxos、故障域、EC、MDS——Ceph 全都用上了，而且组合得相当漂亮。它也是阶段 4 的主角：部署、运维、排障都围绕它展开。动手之前得先把架构吃透，否则 `ceph -s` 里冒出一句 `12 pgs undersized+degraded`，你只能干着急。

学完这一课，你能画出 Ceph 的整体架构，说清 MON、MGR、OSD、MDS、RGW 各自干什么；理解 BlueStore 为什么绕过文件系统直接管理裸盘；讲清楚一个对象如何经过 Pool → PG → OSD 两次映射落到具体的盘上；读懂 CRUSH 规则和 PG 状态；并在单台虚拟机上用 MicroCeph 亲手观察这一切。

## 一点历史：统一存储的由来

Ceph 起源于 Sage Weil 在加州大学圣克鲁兹分校（UCSC）的博士研究，2006 年发表于 OSDI。它最初的目标是一个 PB 级的分布式文件系统，但设计上先造了一个通用的分布式对象存储层 RADOS，再把文件系统放在上面。后来的发展正是沿着这个分层展开的：

| 年份 | 事件 |
|---|---|
| 2006 | OSDI 论文《Ceph: A Scalable, High-Performance Distributed File System》 |
| 2010 | CephFS 内核客户端合入 Linux 2.6.34 |
| 2012 | Inktank 公司成立，首个稳定版 Argonaut 发布 |
| 2014 | Red Hat 收购 Inktank |
| 2017 | Luminous（12）：BlueStore 成为默认后端，MGR 成为必需组件 |
| 2018 | Ceph 基金会在 Linux 基金会下成立 |
| 2020 | Octopus（15）：cephadm 编排工具，pg_autoscaler 默认开启 |

版本按字母顺序命名，大约每年一个大版本。截至本文写作时，最新稳定版是 20.x（Tentacle），19.x（Squid）仍在维护期，具体以 [Ceph 官方发布页](https://docs.ceph.com/en/latest/releases/) 为准。

"统一存储"（unified storage）的含义是：**一个 RADOS 集群同时提供块、文件、对象三种接口**，共享同一套盘、同一套可靠性机制和运维体系。

```text
   ┌──────────┐   ┌──────────────┐   ┌──────────────┐   ┌──────────────┐
   │ 应用直连 │   │   RBD 块设备  │   │ CephFS 文件  │   │ RGW 对象网关 │
   │ librados │   │ 虚拟机、K8s   │   │ POSIX, +MDS  │   │  S3 / Swift  │
   └────┬─────┘   └──────┬───────┘   └──────┬───────┘   └──────┬───────┘
        └────────────────┴───────┬──────────┴──────────────────┘
                                 ▼
   ┌───────────────────────────────────────────────────────────────────┐
   │  RADOS：可靠、自主、分布式的对象存储                               │
   │  MON ×3/5（cluster map, Paxos）   MGR（监控、模块）                │
   │  OSD ×N（每块盘一个，负责复制、恢复、校验）                        │
   └───────────────────────────────────────────────────────────────────┘
```

## RADOS 与各守护进程

RADOS（Reliable Autonomic Distributed Object Store）的关键词是"自主"：OSD 之间自己完成复制、故障检测、数据恢复和重平衡，不需要一个中心节点指挥每个对象该怎么搬。

### MON：集群的大脑

Monitor 维护 **cluster map**，也就是整个集群的"事实"：

| map | 内容 |
|---|---|
| MON map | 有哪些 MON、地址 |
| OSD map | 所有 OSD 的 up/down、in/out 状态，所有 Pool 的参数，版本号（epoch） |
| CRUSH map | 设备、层级拓扑、放置规则 |
| MGR map / FS map | 活跃与备用的 MGR、MDS 状态 |

MON 之间用 Paxos 保证这些 map 的一致性，所以要部署奇数个（3 或 5），理由在[分布式存储基础](/learn/distributed-basics)讲过。MON 还负责 cephx 认证。

有一点必须记住：**数据不经过 MON**。客户端启动时从 MON 拿一份 cluster map，之后自己计算对象位置、直接和 OSD 通信。map 有变化时（比如某个 OSD 挂了），新的 epoch 会在 OSD 和客户端之间逐步传播。MON 挂了一个不影响业务，挂了多数派则集群无法变更状态，新的客户端也连不上。

### MGR：运维入口

Manager 以主备方式运行，负责收集指标，并通过 Python 模块提供各种功能：Dashboard、Prometheus 导出、`pg_autoscaler`、`balancer`，以及 cephadm 编排器。MGR 全挂了不影响数据读写，但 `ceph -s` 的部分统计、自动扩缩 PG 和监控都会停摆。

### OSD：真正干活的

每块盘一个 OSD（Object Storage Daemon）进程。它负责：

- 存储对象（通过 BlueStore）；
- 作为主 OSD 时，把写入复制到其他副本或分发 EC 分片；
- 与同 PG 的其他 OSD 互相心跳，发现对方失联就报告给 MON；
- 故障后执行 **peering**、**recovery**、**backfill**，把数据恢复到应有的副本数；
- 定期 **scrub**（比对元数据）和 **deep scrub**（读出全部数据比对校验和），发现静默损坏。

### BlueStore：绕开文件系统

早期的 FileStore 把对象存成 XFS 上的文件，再加一层日志保证事务，结果是"双写"加上文件系统本身的开销。Ceph 团队后来在 SOSP'19 发表论文总结了这十年的教训：通用文件系统并不适合作为分布式存储的后端。于是有了 BlueStore，它**直接管理裸块设备**：

```text
            OSD
             │
        ┌────┴──────────────────────────────┐
        │             BlueStore             │
        │  ┌─────────────┐   对象数据直接写到 │
        │  │   RocksDB   │   裸设备上的空闲区 │
        │  │ (元数据、   │                    │
        │  │  omap、分配)│                    │
        │  └──────┬──────┘                    │
        │      BlueFS（给 RocksDB 用的极简文件系统）
        └────┬──────────────┬──────────────┬─┘
             ▼              ▼              ▼
          block          block.db       block.wal
         （主设备，HDD   （可选，放在    （可选，放在
          或 SSD）        更快的 SSD）    最快的设备）
```

- **数据**直接写到主设备的空闲空间，再把"对象 → 物理位置"的映射作为元数据提交到 RocksDB；
- **DB**（RocksDB 的 SST 文件）和 **WAL**（RocksDB 的预写日志）默认和数据放在同一块盘上；HDD 集群通常把 DB/WAL 放到 NVMe 上，小 I/O 和元数据性能会好很多；
- 小于最小分配单元的覆盖写会先写进 WAL 再异步落盘（deferred write），避免读-改-写；
- 每个块都带 crc32c 校验和，读出时校验，配合 deep scrub 发现[存储硬件](/learn/storage-hardware)那一课提到的静默数据损坏；
- 支持内联压缩；缓存大小由 `osd_memory_target`（默认 4 GiB）控制。

> [!TIP] 内存规划
> 每个 OSD 默认目标内存 4 GiB，一台 24 盘的服务器光 OSD 就要近 100 GiB 内存，还没算操作系统和恢复时的峰值。内存不足时 OSD 缓存缩小，性能明显下降，严重时触发 OOM。[容量与性能规划](/learn/capacity-planning)里会给出完整的配比。

### MDS 与 RGW：上层服务

- **MDS**（Metadata Server）只为 CephFS 服务，管理目录树和 caps，元数据本身存放在 RADOS 的元数据池里，[元数据与分布式文件系统](/learn/distributed-fs)已经介绍过；
- **RGW**（RADOS Gateway）是无状态的 HTTP 服务，把 S3/Swift 请求翻译成 RADOS 操作。桶索引、用户信息存在专门的池里，横向加实例即可扩展，细节见 [RGW 对象存储](/learn/ceph-rgw)。

RBD 没有独立的守护进程：块设备的逻辑在客户端库 librbd 或内核模块 `rbd` 里，一个镜像被切成默认 4 MiB 的对象存进 RADOS。

## Pool、PG 与 CRUSH

### Pool

Pool 是 RADOS 里的逻辑分区，定义了一组数据的存放策略：

| 属性 | 说明 |
|---|---|
| 类型 | replicated（副本）或 erasure（纠删码） |
| `size` / `min_size` | 副本数，以及允许 I/O 的最少在线副本数，见[副本与纠删码](/learn/replication-ec) |
| `crush_rule` | 用哪条 CRUSH 规则放置数据，决定用哪类盘、按什么故障域 |
| `pg_num` | 这个池切成多少个 PG |
| `application` | 用途标签：rbd、cephfs、rgw 或自定义 |

### PG：对象和盘之间的中间层

如果让 CRUSH 直接把每个对象映射到 OSD，集群就要为几十亿个对象分别跟踪状态、分别做恢复。PG（Placement Group，放置组）把对象分组，**集群只跟踪 PG 这一级的状态**：一个池通常只有几十到几千个 PG，每个 PG 里有大量对象。

PG 的数量是一个权衡：

- 太少：每个 PG 太大，数据分布不均（有的盘满了有的还空着），恢复时参与的盘少；
- 太多：每个 OSD 上的 PG 太多，peering 和内存开销上升。

经验值是**每个 OSD 承载 100 个左右的 PG 副本**（`mon_target_pg_per_osd` 默认 100），超过 `mon_max_pg_per_osd`（默认 250）时会拒绝创建新池。好在今天不需要手算了，交给下面要讲的 pg_autoscaler。

### 两次映射：对象 → PG → OSD

```text
 对象名 "myobject"，写入 pool "mypool"（id=2，pg_num=32）
        │
        │ ① hash = rjenkins("myobject") = 0xc5b6a3b1
        │   pg  = stable_mod(hash, pg_num=32) = 0x11
        ▼
   PG 2.11            ← "池 id . PG 序号(十六进制)"
        │
        │ ② CRUSH(PG 2.11, crush_rule, 当前 CRUSH map + OSD map)
        ▼
   [osd.3, osd.7, osd.1]      有序列表，第一个是主 OSD（primary）
      │       │       │
    host-a  host-c  host-b     ← 规则保证三个副本在三台不同主机
```

两步都是纯计算，任何持有同一份 map 的客户端、OSD 都会得到相同的结果，所以**不需要任何位置查询服务**。第一步只和对象名、`pg_num` 有关；第二步只和 PG、拓扑有关。这带来一个重要性质：扩容或坏盘时，只有第二步的结果变化，对象到 PG 的归属不变，数据以 PG 为单位整体迁移。

`stable_mod` 是 Ceph 对取模的改良：`pg_num` 不是 2 的幂时，它能保证 PG 分裂时只有部分对象移动。但非 2 的幂会导致各 PG 大小不均，所以**`pg_num` 始终用 2 的幂**。

### Up set 与 Acting set

`ceph osd map` 输出里有两个列表：

- **up set**：按当前 CRUSH map 计算出来"应该"在哪些 OSD 上；
- **acting set**：当前"实际"负责这个 PG 的 OSD。

通常两者相同。当新 OSD 刚加入、数据还没搬过去时，Ceph 会设置一个临时映射（pg_temp），让仍持有完整数据的旧 OSD 继续服务，这时两者不同，PG 状态里会出现 `remapped`，等 backfill 完成后 acting 再切换到 up。

### CRUSH map：拓扑与规则

CRUSH map 由三部分组成：

1. **设备**：每个 OSD，带设备类别（device class）`hdd`、`ssd` 或 `nvme`；
2. **bucket 层级**：内置类型从下到上有 `osd`、`host`、`chassis`、`rack`、`row`、`pdu`、`pod`、`room`、`datacenter`、`zone`、`region`、`root`。每个 bucket 的权重是其下所有设备权重之和（单位约为 TiB），挑选算法默认 straw2；
3. **规则**（rule）：从哪个 bucket 开始、选几个、在哪一层保证互不相同。

默认副本规则反编译出来是这样：

```text
rule replicated_rule {
    id 0
    type replicated
    step take default                      # 从 root "default" 开始
    step chooseleaf firstn 0 type host     # 选 N 个不同的 host，每个下面选 1 个 OSD（叶子）
    step emit
}
```

`firstn 0` 里的 0 表示"选 pool size 那么多个"。要按设备类别分池，用 `step take default class ssd`，或者直接用命令创建：

```bash
ceph osd crush rule create-replicated rep_ssd default host ssd
ceph osd crush rule create-replicated rep_hdd_rack default rack hdd
ceph osd pool set mypool crush_rule rep_ssd      # 修改规则会触发数据迁移
```

EC 池的规则由 erasure-code-profile 里的 `crush-failure-domain` 和 `crush-device-class` 自动生成。反编译整份 CRUSH map、离线模拟映射可以用 `crushtool`（`ceph osd getcrushmap -o crush.bin && crushtool -d crush.bin -o crush.txt`），它随 Ceph 的完整安装包提供，阶段 4 会用到。

## 写入流程

以三副本池为例，客户端写一个对象：

```text
 客户端                 主 OSD (osd.3)            副本 osd.7          副本 osd.1
   │ ① 计算 PG 和 acting set   │                        │                   │
   │── ② 写请求 ──────────────▶│                        │                   │
   │                           │── ③ 并行转发 ─────────▶│                   │
   │                           │── ③ ──────────────────────────────────────▶│
   │                           │ ④ 本地 BlueStore 事务  │ ④ 本地事务        │ ④ 本地事务
   │                           │◀─ ⑤ 已提交 ────────────│                   │
   │                           │◀─ ⑤ 已提交 ────────────────────────────────│
   │◀─ ⑥ ack（全部副本已持久化）│                        │                   │
```

几个要点：

- 客户端**只和主 OSD 通信**，复制是 OSD 之间的事，客户端的出口带宽只用一份；
- 主 OSD 要等 **acting set 中所有副本**都持久化后才确认，这是强一致的来源；也意味着一次写的延迟取决于最慢的那个副本；
- 每个 PG 维护一份 **PG log**，按顺序记录最近的操作和版本号，是故障后判断谁的数据最新、哪些对象需要恢复的依据；
- 默认读也只从主 OSD 读，保证读到的一定是最新提交的数据；
- EC 池的流程类似，区别是主 OSD 负责切分和编码，把 k+m 个分片发给各 OSD。

## PG 状态

`ceph -s` 和 `ceph pg stat` 里的 PG 状态是 Ceph 运维最重要的信号。它们是若干标志的组合：

| 状态 | 含义 | 需要担心吗 |
|---|---|---|
| `active` | 可以处理读写 | 正常 |
| `clean` | 所有副本齐全且都在正确的位置 | 正常 |
| `peering` | acting set 中的 OSD 正在就 PG 的状态达成一致 | 短暂出现正常，长时间卡住要查 |
| `degraded` | 部分对象的副本数不足 | 冗余降低，Ceph 会自动恢复 |
| `undersized` | acting set 里的 OSD 数少于 pool size | 通常伴随 degraded；持续存在说明没有地方放新副本 |
| `recovering` / `recovery_wait` | 正在 / 等待根据 PG log 补齐缺失的对象 | 恢复中 |
| `backfilling` / `backfill_wait` | 正在 / 等待全量扫描复制整个 PG（新 OSD 加入或 log 不够用时） | 迁移中 |
| `remapped` | acting set 与 up set 不同，数据正在迁往新位置 | 迁移中 |
| `scrubbing` / `deep` | 正在做一致性校验 | 正常 |
| `inconsistent` | scrub 发现副本不一致 | 要处理，见 [Ceph 排障](/learn/ceph-troubleshooting) |
| `stale` | 主 OSD 长时间没有向 MON 汇报 | 要查，可能相关 OSD 全挂了 |
| `down` / `incomplete` | 缺少足够的 OSD 来确定 PG 的权威历史 | 严重，I/O 被阻塞 |

**peering** 值得多说一句。每当 acting set 变化（OSD 挂掉、回来、新加入），这个 PG 的成员必须先交换 PG log，找出拥有最新数据的权威副本，确定哪些对象在哪个副本上缺失。peering 完成后 PG 才能进入 active。之后再根据缺失的程度走 recovery（按 log 补对象）或 backfill（log 不够用，全量对比复制）。

```text
 OSD 故障 ──▶ peering ──▶ active+undersized+degraded ──（选出新的 OSD）──▶ active+degraded+recovering
                                                                              │
                                                     active+clean ◀───────────┘
```

> [!WARNING] 维护前先设 noout
> OSD down 超过 `mon_osd_down_out_interval`（默认 600 秒）后会被自动标记为 out，Ceph 开始把它的数据重建到别处。计划内重启一台机器时，先 `ceph osd set noout`，维护完再 `ceph osd unset noout`，否则会凭空搬一大堆数据，机器回来后再搬回去。详见 [Ceph 日常运维](/learn/ceph-day2)。

## pg_autoscaler

从 Octopus 起，MGR 的 `pg_autoscaler` 模块默认开启，按池的实际（或预期）用量自动调整 `pg_num`。它只在当前值与建议值相差 3 倍以上时才动手，避免频繁迁移。几个需要知道的开关：

| 设置 | 作用 |
|---|---|
| `pg_autoscale_mode` on / warn / off | 自动调整、只告警、关闭 |
| `--bulk` 标志 | 告诉 autoscaler 这个池会装大量数据，一开始就给足 PG，而不是从小开始逐步分裂 |
| `target_size_ratio` | 预期占集群容量的比例，让空池也能提前拿到合适的 PG 数 |
| `target_size_bytes` | 预期的绝对大小 |

团队的做法是：数据池创建时就带上 `--bulk` 和 `target_size_ratio`，避免数据写进来后 PG 反复分裂带来的持续迁移：

```bash
ceph osd pool create mypool 32 32 rep_ssd --bulk
ceph osd pool set mypool target_size_ratio 0.3
ceph osd pool autoscale-status
```

## 动手：用 MicroCeph 在单机上观察

cephadm 要求真实的块设备，阶段 4 再用它做正式部署。这里用 Canonical 的 MicroCeph，一个 snap 包就能在单台 Ubuntu 24.04 虚拟机上拉起完整的 Ceph，并支持用 loop 文件做 OSD。建议虚拟机至少 4 GiB 内存、20 GiB 空闲磁盘。

```bash
sudo snap install microceph
sudo snap refresh --hold microceph        # 防止自动升级
sudo microceph cluster bootstrap
sudo microceph disk add loop,4G,3         # 3 个 4 GiB 的 loop OSD
sudo microceph status
sudo ceph -s
```

MicroCeph 会给 `ceph`、`rados`、`rbd` 创建 snap 别名；若提示找不到命令，改用 `sudo microceph.ceph`。

```console
$ sudo ceph -s
  cluster:
    id:     7d3c1f0a-5b2e-4c8d-9a61-3e4f5a6b7c8d
    health: HEALTH_OK

  services:
    mon: 1 daemons, quorum node1 (age 4m)
    mgr: node1(active, since 4m)
    osd: 3 osds: 3 up (since 1m), 3 in (since 1m)

  data:
    pools:   1 pools, 1 pgs
    objects: 2 objects, 449 KiB
    usage:   81 MiB used, 12 GiB / 12 GiB avail
    pgs:     1 active+clean
```

看拓扑和规则：

```bash
sudo ceph osd tree
sudo ceph osd crush rule ls
sudo ceph osd crush rule dump microceph_auto_osd
```

```console
$ sudo ceph osd tree
ID  CLASS  WEIGHT   TYPE NAME       STATUS  REWEIGHT  PRI-AFF
-1         0.01169  root default
-3         0.01169      host node1
 0    hdd  0.00389          osd.0       up   1.00000  1.00000
 1    hdd  0.00389          osd.1       up   1.00000  1.00000
 2    hdd  0.00389          osd.2       up   1.00000  1.00000
```

只有一台主机，按 host 做故障域根本凑不齐三副本，所以 MicroCeph 自动使用了以 osd 为故障域的规则 `microceph_auto_osd`；节点数达到 3 个后，它会切换到以 host 为故障域的规则。**生产环境绝不能以 osd 为故障域跑三副本**，否则一台机器宕机就可能带走一个 PG 的全部副本。

创建池、写对象、看映射：

```bash
sudo ceph osd pool create mypool 32
sudo ceph osd pool application enable mypool demo
echo "hello rados" | sudo rados -p mypool put myobject -
sudo rados -p mypool ls
sudo rados -p mypool get myobject -
sudo ceph osd map mypool myobject
```

```console
$ sudo ceph osd map mypool myobject
osdmap e28 pool 'mypool' (2) object 'myobject' -> pg 2.c5b6a3b1 (2.11) -> up ([1,0,2], p1) acting ([1,0,2], p1)
```

逐段对照前面的图：`2.c5b6a3b1` 是对象名的哈希，`(2.11)` 是 PG，`up` 和 `acting` 相同说明没有迁移，`p1` 表示 osd.1 是主 OSD。再看看这个 PG 的详细状态：

```bash
sudo ceph pg ls-by-pool mypool | head -5
sudo ceph pg 2.11 query | grep -m1 '"state"'
```

### 制造一次降级

把一个 OSD 标记为 out，观察 PG 状态变化：

```bash
sudo ceph osd out 2
watch -n 1 sudo ceph pg stat
```

```console
33 pgs: 33 active+undersized+degraded; 449 KiB data, 83 MiB used, 12 GiB / 12 GiB avail; 3/9 objects degraded (33.333%)
```

只剩 2 个 OSD，而池的 size 是 3、故障域是 osd，CRUSH 找不到第三个位置，于是所有 PG 都是 `undersized+degraded`：数据仍然可读写（在线副本数 2 满足 `min_size` 2），但冗余少了一份。把它加回来：

```bash
sudo ceph osd in 2
sudo ceph -s          # 短暂出现 peering / recovering，随后回到 active+clean
```

实验结束后可以用 `sudo snap remove --purge microceph` 清理。

## 动手练习

1. 按本课步骤部署 MicroCeph，创建 `pg_num` 为 32 的池，写入 10 个对象，对每个对象执行 `ceph osd map`，统计它们分布到了哪些 PG、主 OSD 各是谁。
2. 用 `ceph osd pool set mypool pg_num 64` 把 PG 数翻倍，再对同一批对象执行 `ceph osd map`，验证每个对象的新 PG 号要么不变、要么等于旧 PG 号加 32（0x20），理解 PG 分裂。
3. 执行 `ceph osd pool autoscale-status`，解释 `TARGET RATIO`、`PG_NUM`、`NEW PG_NUM` 和 `BULK` 各列的含义；给池加上 `--bulk` 标志（`ceph osd pool set mypool bulk true`）后观察建议值的变化。
4. 创建 `k=2 m=1 crush-failure-domain=osd` 的 EC 池，写入对象后对比 `ceph osd map` 输出中 acting set 的长度，并用 `ceph osd crush rule dump` 查看自动生成的 EC 规则。
5. 在 `ceph osd out 2` 之后执行 `ceph health detail` 和 `ceph pg dump_stuck undersized`，记录输出；然后 `ceph osd set noout`，再重复 out/in 操作，思考 noout 在什么情况下起作用、什么情况下不起作用。

## 自测

<details>
<summary>客户端读写数据时需要经过 MON 吗？MON 全部宕机会发生什么？</summary>

不需要。客户端从 MON 获取 cluster map 后，自己通过哈希和 CRUSH 计算出对象所在的 PG 与 OSD，直接和 OSD 通信。MON 失去多数派后，集群状态无法变更（OSD 上下线无法记录、map 无法更新），新客户端无法连接认证；已连接的客户端在拓扑不变时可能还能继续访问一段时间，但任何故障都无法被处理，所以必须尽快恢复 MON 仲裁。

</details>

<details>
<summary>为什么 Ceph 要在对象和 OSD 之间引入 PG 这一层？</summary>

直接按对象映射到 OSD 时，集群需要为数十亿对象分别跟踪状态、做 peering 和恢复，开销不可接受。PG 把对象分组，集群只跟踪数量少得多的 PG；拓扑变化时以 PG 为单位迁移和恢复，对象到 PG 的映射不变。PG 数量也提供了一个可调的粒度，在数据分布均匀性和每个 OSD 的管理开销之间取得平衡。

</details>

<details>
<summary>`ceph osd map` 输出 `-> pg 2.c5b6a3b1 (2.11) -> up ([1,0,2], p1) acting ([1,0,2], p1)`，每一部分分别是什么意思？</summary>

`2.c5b6a3b1` 是池 id 为 2、对象名的哈希值为 0xc5b6a3b1；`(2.11)` 是经过 stable_mod 后得到的 PG，池 2 的第 0x11 号 PG；`up` 是按当前 CRUSH map 计算出应该存放的 OSD 列表；`acting` 是当前实际负责的 OSD 列表；`p1` 表示主 OSD 是 osd.1。up 和 acting 相同说明该 PG 没有处于迁移中。

</details>

<details>
<summary>BlueStore 相比 FileStore 做了什么根本改变？DB/WAL 为什么常放在 NVMe 上？</summary>

FileStore 把对象存成本地文件系统上的文件，并额外写一份日志，造成双写和文件系统开销；BlueStore 直接管理裸块设备，对象数据写到空闲区，元数据和分配信息存在 RocksDB 中，并为每个块提供校验和。RocksDB 的 WAL 和 SST 文件承载了大量小 I/O 和元数据访问，放在 HDD 上会拖慢小写和元数据操作，放到 NVMe 上能显著改善 HDD 集群的延迟和 IOPS。

</details>

<details>
<summary>PG 处于 `active+undersized+degraded` 时，数据能读写吗？和 `down` 有什么区别？</summary>

能读写。active 表示 PG 可以处理 I/O，undersized+degraded 表示在线副本少于 pool size、部分对象冗余不足，但只要在线副本数不低于 min_size，读写就继续，Ceph 会在有可用位置时自动恢复。`down` 表示缺少足够的 OSD 来确定 PG 的权威历史，PG 无法 peering 完成，I/O 被阻塞，问题严重得多。

</details>

## 参考资料

- [Ceph 文档：Architecture](https://docs.ceph.com/en/latest/architecture/)
- [Ceph 文档：Placement Groups](https://docs.ceph.com/en/latest/rados/operations/placement-groups/)
- [Ceph 文档：Placement Group States](https://docs.ceph.com/en/latest/rados/operations/pg-states/)
- [Ceph 文档：CRUSH Maps](https://docs.ceph.com/en/latest/rados/operations/crush-map/)
- [Ceph 文档：BlueStore Configuration Reference](https://docs.ceph.com/en/latest/rados/configuration/bluestore-config-ref/)
- [Ceph 开发者文档：Peering](https://docs.ceph.com/en/latest/dev/peering/)
- [Ceph 发布版本列表](https://docs.ceph.com/en/latest/releases/)
- [MicroCeph 文档](https://canonical-microceph.readthedocs-hosted.com/)
- [Sage A. Weil 等：Ceph: A Scalable, High-Performance Distributed File System（OSDI'06）](https://www.usenix.org/legacy/event/osdi06/tech/full_papers/weil/weil.pdf)
- [Sage A. Weil 等：RADOS: A Scalable, Reliable Storage Service for Petabyte-scale Storage Clusters（PDSW'07）](https://ceph.io/assets/pdfs/weil-rados-pdsw07.pdf)
- [Abutalib Aghayev 等：File Systems Unfit as Distributed Storage Backends: Lessons from 10 Years of Ceph Evolution（SOSP'19）](https://dl.acm.org/doi/10.1145/3341301.3359656)
