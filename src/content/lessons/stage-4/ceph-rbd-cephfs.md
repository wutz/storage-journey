# RBD 块存储与 CephFS 文件系统

上一课部署好的集群还只是一堆 OSD，业务真正用的是它上面的三种接口：块、文件、对象。这一课讲前两种。**RBD**（RADOS Block Device）把 RADOS 对象拼成一块虚拟盘，给虚拟机和数据库用。**CephFS** 在 RADOS 之上加了一个元数据服务（MDS），提供共享的 POSIX 文件系统。

两者都从存储池（pool）开始。池的规则、副本数和权限划分，决定了下游能拿到什么样的服务。所以本课先把池讲透，再分别讲 RBD 镜像的全生命周期和 CephFS 的 MDS、子卷与挂载。对象存储见 [RGW 对象网关](/learn/ceph-rgw)。

> [!NOTE] 本课需要的环境
> - 一套按 [用 cephadm 部署 Ceph 集群](/learn/cephadm-deploy) 搭好的 3 节点集群（`ceph1`～`ceph3`，每台 3 块 20 GiB OSD 盘），状态 `HEALTH_OK`。
> - **一台独立的客户端虚拟机** `client1`（`192.168.10.21`），2 vCPU、2 GiB 内存，内核 5.15 以上（Ubuntu 24.04 满足），装好 `ceph-common` 和 `ceph-fuse`。
> - 客户端和集群公共网 `192.168.10.0/24` 互通。
>
> 实验环境可以在 OSD 节点上直接 map/mount 试一试，**生产环境不要这样做**。在同一台主机上用内核客户端挂自己的 OSD，内存紧张时可能死锁。

## 存储池：一切的起点

池是 RADOS 里的逻辑分区。它决定四件事：数据用哪条 CRUSH 规则、几副本还是纠删码、分多少 PG、给哪种应用用。

```bash
# 副本池：32 个 PG，用上一课建的 rep_ssd 规则（实验环境没有 SSD 就用 rep_hdd）
ceph osd pool create rbd01 32 32 replicated rep_ssd
ceph osd pool set rbd01 bulk true              # 告诉 autoscaler 这是个大池，一开始就给足 PG
ceph osd pool application enable rbd01 rbd     # 声明用途，不声明会报 POOL_APP_NOT_ENABLED

ceph osd pool get rbd01 size        # size: 3
ceph osd pool get rbd01 min_size    # min_size: 2
```

几个关键属性：

| 属性 | 含义 | 建议 |
| --- | --- | --- |
| `size` / `min_size` | 副本数 / 可以接受写入的最少副本数 | 3 / 2。生产环境**不要**把 `min_size` 设成 1，那等于用数据安全换可用性 |
| `crush_rule` | 数据落在哪些 OSD 上 | 必须显式指定带设备类型的规则 |
| `pg_autoscale_mode` | PG 自动伸缩 | 保持 `on`，配合 `bulk` 或 `target_size_ratio` 让它提前扩 PG |
| `application` | `rbd` / `cephfs` / `rgw` | 每个池都要声明 |
| 配额 | `set-quota max_bytes/max_objects` | 多租户共用集群时一定要设 |

```bash
ceph osd pool set rbd01 target_size_ratio 0.3          # 预计占集群 30% 容量
ceph osd pool set-quota rbd01 max_bytes $((500 * 1024**3))
ceph osd pool autoscale-status
```

> [!TIP] PG 数不用算得很精确
> autoscaler 开着的时候，PG 数由它按容量占比自动调整，目标是每个 OSD 约 100 个 PG（`mon_target_pg_per_osd`）。你只需要告诉它哪些池会变大（`bulk` 或 `target_size_ratio`），免得数据写进来之后再分裂 PG，引发大量数据迁移。PG 的原理回顾 [Ceph 架构](/learn/ceph-architecture)。

**权限按池切分。**不要把 `client.admin` 的 keyring 交给任何业务方。每个业务一个用户，只给它能访问的池：

```bash
ceph auth get-or-create client.rbd01 \
  mon 'profile rbd' osd 'profile rbd pool=rbd01' mgr 'profile rbd pool=rbd01' \
  -o /etc/ceph/ceph.client.rbd01.keyring
```

## RBD：一块用 RADOS 对象拼成的盘

RBD 镜像（image）默认被切成 4 MiB 的对象，按 CRUSH 分布到整个池里。一块 100 GiB 的镜像就是 25600 个对象，读写一块盘相当于并行访问几十块 OSD。镜像是精简配置（thin provisioning）的，没写过的区域不占空间。

### 创建与映射

```bash
rbd pool init rbd01
rbd create rbd01/img01 --size 10G
rbd info rbd01/img01
```

```text
rbd image 'img01':
	size 10 GiB in 2560 objects
	order 22 (4 MiB objects)
	snapshot_count: 0
	id: 5e3c9a1b2f4d
	block_name_prefix: rbd_data.5e3c9a1b2f4d
	format: 2
	features: layering, exclusive-lock, object-map, fast-diff, deep-flatten
	op_features:
	flags:
```

默认特性里，`exclusive-lock` 保证同一时刻只有一个客户端能写，`object-map` 和 `fast-diff` 让 `rbd du`、快照差异和删除变得很快。较新的内核都支持这些特性。老内核 map 时如果报 `feature set mismatch`，用 `rbd feature disable` 关掉不支持的特性。

在客户端上准备最小配置和密钥，然后映射：

```bash
# 在集群 _admin 节点上生成，复制到 client1:/etc/ceph/
ceph config generate-minimal-conf > ceph.conf
ceph auth get client.rbd01 > ceph.client.rbd01.keyring

# 在 client1 上
rbd device map rbd01/img01 --id rbd01        # 输出 /dev/rbd0
rbd device list
mkfs.xfs /dev/rbd0
mkdir -p /data && mount /dev/rbd0 /data
```

开机自动映射用 `rbdmap` 服务。在 `/etc/ceph/rbdmap` 里写一行 `rbd01/img01 id=rbd01,keyring=/etc/ceph/ceph.client.rbd01.keyring`，再在 fstab 里用 `/dev/rbd/rbd01/img01 /data xfs noauto,_netdev 0 0`，最后 `systemctl enable rbdmap`。`noauto` 的意思是交给 rbdmap 在映射后挂载，不要让 systemd 在映射之前抢着挂。

### 快照、回滚与克隆

```bash
fsfreeze -f /data                             # 先冻结文件系统，拿到一致性快照
rbd snap create rbd01/img01@before-upgrade
fsfreeze -u /data
rbd snap ls rbd01/img01
```

```text
SNAPID  NAME            SIZE    PROTECTED  TIMESTAMP
     4  before-upgrade  10 GiB             Wed Sep 24 10:12:31 2026
```

回滚要先卸载、解除映射，否则文件系统会看到一堆被"偷换"的块：

```bash
umount /data && rbd device unmap /dev/rbd0
rbd snap rollback rbd01/img01@before-upgrade
```

回滚的耗时和镜像大小成正比，因为要逐个对象恢复。如果只是想取回几个文件，更快的做法是从快照克隆一个新镜像挂上去拷贝。

**克隆**是 RBD 做"模板镜像"的方式：一个装好系统的黄金镜像，秒级克隆出上百台虚拟机的系统盘，只有写过的对象才占新空间。

```bash
rbd snap protect rbd01/img01@before-upgrade        # clone v1 要求父快照受保护
rbd clone rbd01/img01@before-upgrade rbd01/vm-001
rbd children rbd01/img01@before-upgrade            # rbd01/vm-001
rbd flatten rbd01/vm-001                           # 可选：把父镜像数据完整拷过来，断开依赖
```

> [!NOTE] clone v2 不需要 protect
> 当 `ceph osd set-require-min-compat-client mimic` 或更高时，新建的克隆默认是 v2 格式，父快照不需要 protect，删除有子镜像的快照会自动把它挪进"快照回收站"。上面保留 `protect` 是为了兼容老客户端，照做没有坏处。

### 扩容与缩容

```bash
rbd resize rbd01/img01 --size 20G       # 扩容在线进行
xfs_growfs /data                        # 文件系统也要跟着扩
```

缩容要加 `--allow-shrink`，而且**必须先缩文件系统**，否则末尾的数据直接丢失。XFS 根本不支持缩小。所以我的建议是：RBD 不缩，确实需要就新建一块小盘迁移数据。

### 删除与回收站

直接 `rbd rm` 没有后悔药，生产环境一律先进回收站：

```bash
rbd trash mv rbd01/vm-001
rbd trash ls rbd01                             # 5e7a1c2d3b4f vm-001
rbd trash restore rbd01/5e7a1c2d3b4f           # 后悔了还能恢复
rbd trash purge schedule add --pool rbd01 1d   # 每天清理一次过期条目
```

### 纠删码数据池

RBD 的镜像元数据（header、omap）只能放在副本池，数据可以放在纠删码池，省一半以上空间：

```bash
ceph osd pool create rbd01-ec 32 32 erasure ec42_hdd
ceph osd pool set rbd01-ec allow_ec_overwrites true   # RBD 需要部分覆盖写
ceph osd pool application enable rbd01-ec rbd
rbd create rbd01/big01 --size 1T --data-pool rbd01-ec
```

`ec42` 在故障域为 host 时至少要 6 台主机，3 节点的实验环境只能用 `k=2 m=1` 体验一下。EC 的小块随机写性能明显差于副本，数据库类负载老老实实用副本池。

### rbd bench：先测一下

`rbd bench` 直接用 librbd 压测，不经过内核和文件系统，适合做"这个池到底有多快"的基线：

```console
# rbd bench --io-type write --io-size 4K --io-threads 16 --io-total 1G --io-pattern rand rbd01/img01
bench  type write io_size 4096 io_threads 16 bytes 1073741824 pattern random
  SEC       OPS   OPS/SEC   BYTES/SEC
    1      7952   7963.12    31 MiB/s
    2     15870   7932.40    31 MiB/s
  ...
elapsed: 33   ops: 262144   ops/sec: 7911.84   bytes/sec: 31 MiB/s
```

再用 `--io-type read --io-size 4M --io-pattern seq` 测顺序带宽。要模拟真实业务，还是在 `/dev/rbd0` 上跑 fio，方法见 [基准测试](/learn/benchmarking)。线上查看哪个镜像最忙，用 `rbd perf image iostat rbd01`。

## CephFS：给 RADOS 加一个元数据服务

CephFS 把数据和元数据分开处理：文件内容作为对象直接写 OSD，目录树、inode、权限这些元数据由 **MDS**（Metadata Server）管理，MDS 自己也把元数据持久化在 RADOS 的元数据池里。

```text
   client（内核 / ceph-fuse）
      │  ① open/stat/readdir ……         ② read/write 文件数据
      ▼                                   │
   MDS（active）  ◀── 日志回放 ── MDS（standby-replay）
      │ 元数据对象、日志                    │
      ▼                                   ▼
   cephfs.<fs>.meta（副本池，SSD）    cephfs.<fs>.data（副本或 EC）
```

客户端从 MDS 拿到能力（capability，简称 caps），比如"这个文件可以缓存读""可以缓冲写"。拿到 caps 以后，客户端直接和 OSD 读写数据。MDS 不在数据路径上，但**每一次元数据操作都要经过它**。所以 CephFS 的性能瓶颈往往在 MDS：海量小文件、`ls` 巨型目录、成千上万个客户端同时持有 caps。元数据服务的一般问题回顾 [元数据与分布式文件系统](/learn/distributed-fs)。

### 创建文件系统

最快的方式是一条命令，自动建池并部署 MDS：

```bash
ceph fs volume create cephfs --placement="2 label:mds"
```

它会创建 `cephfs.cephfs.meta` 和 `cephfs.cephfs.data` 两个池。生产环境我更推荐手工建池，这样可以把元数据池放到 SSD 上：

```bash
ceph osd pool create cfs01-meta 32 32 replicated rep_ssd
ceph osd pool create cfs01-data 64 64 replicated rep_hdd
ceph osd pool set cfs01-data bulk true
ceph fs new cfs01 cfs01-meta cfs01-data
ceph orch apply mds cfs01 --placement="3 label:mds"
```

> [!WARNING] 元数据池必须是副本池
> 元数据池不能用纠删码，而且应该放在 SSD/NVMe 上。它的容量很小（通常是数据量的千分之几），但每次 MDS 写日志、刷元数据都要访问它，慢盘会让整个文件系统卡顿。

```console
# ceph fs status cfs01
cfs01 - 2 clients
=====
RANK      STATE                MDS              ACTIVITY     DNS    INOS   DIRS   CAPS
 0        active      cfs01.ceph2.qwkfzp   Reqs:   12 /s  15.2k  14.9k  2104   13.1k
0-s   standby-replay  cfs01.ceph3.bnmxlr   Evts:    3 /s  15.2k  14.9k  2104      0
    POOL       TYPE     USED  AVAIL
 cfs01-meta  metadata   312M  56.1G
 cfs01-data    data    12.4G  56.1G
 STANDBY MDS
cfs01.ceph1.hjtrea
MDS version: ceph version 20.2.4 (...) tentacle (stable)
```

`DNS`/`INOS` 是 MDS 缓存里的目录项和 inode 数，`CAPS` 是发给客户端的能力总数。**`CAPS` 长期接近甚至超过 `DNS` 时，说明客户端握着大量 caps 不释放，MDS 内存有风险。**排查方法见 [故障排查闯关](/learn/ceph-troubleshooting)。

### MDS 高可用与多活

| 模式 | 设置 | 效果 |
| --- | --- | --- |
| active + standby | 默认 | active 挂了，standby 接管前要从 RADOS 读日志、重建缓存，可能要几十秒 |
| standby-replay | `ceph fs set cfs01 allow_standby_replay true` | standby 持续回放 active 的日志，保持热缓存，切换快得多 |
| 多活（multi-active） | `ceph fs set cfs01 max_mds 2` | 多个 rank 分担目录子树，提高元数据吞吐 |

多活的前提是元数据负载确实能拆开。MDS 的动态负载均衡会在 rank 之间迁移子树，迁移本身有开销，负载高时还会来回抖。团队的做法是关掉动态均衡（`ceph config set mds mds_bal_interval 0`），用**目录钉扎**（pinning）手工分配：

```bash
setfattr -n ceph.dir.pin -v 0 /mnt/cfs01/volumes/team-a
setfattr -n ceph.dir.pin -v 1 /mnt/cfs01/volumes/team-b
# 或者让某个目录的直接子目录按哈希分散到所有 rank
setfattr -n ceph.dir.pin.distributed -v 1 /mnt/cfs01/home
```

记得保证 standby 的数量：`max_mds 2` 加上 standby-replay，至少需要 4 个 MDS 守护进程。

MDS 的缓存上限由 `mds_cache_memory_limit` 控制，默认只有 4 GiB，对生产环境来说太小。团队给每个 MDS 32～64 GiB，粗略按每个热 inode 几 KB 来估算：

```bash
ceph config set mds mds_cache_memory_limit 34359738368    # 32 GiB
```

### 子卷与子卷组：给租户分目录

直接把根目录挂给所有人，权限和配额很快就会失控。CephFS 的**子卷**（subvolume）是带配额、带独立路径、可单独做快照的目录，**子卷组**（subvolumegroup）用来按团队或业务归类。Kubernetes 的 CephFS CSI 驱动正是基于子卷工作的，见 [Kubernetes 存储与 CSI](/learn/k8s-csi)。

```bash
ceph fs subvolumegroup create cfs01 team-a
ceph fs subvolume create cfs01 proj1 --group_name team-a --size $((100 * 1024**3))
ceph fs subvolume getpath cfs01 proj1 --group_name team-a
# /volumes/team-a/proj1/8e2f5a3c-1d4b-4c7e-9a0f-2b6d8c1e4f37

ceph fs subvolume ls cfs01 --group_name team-a
ceph fs subvolume resize cfs01 proj1 $((200 * 1024**3)) --group_name team-a --no_shrink
ceph fs subvolume snapshot create cfs01 proj1 snap-20260924 --group_name team-a
```

`getpath` 返回的路径末尾有一串 UUID，这是子卷的真实数据目录，挂载时就用它。

### 授权：每个租户一把钥匙

```bash
ceph fs authorize cfs01 client.team-a /volumes/team-a rw
```

```text
[client.team-a]
	key = AQB...（示例，已省略）...==
```

`ceph fs authorize` 会同时生成 mon、mds、osd 三类权限，把用户限定在这个文件系统的指定路径下。常用写法：

| 写法 | 含义 |
| --- | --- |
| `/volumes/team-a rw` | 该路径读写，其他路径不可见 |
| `/ r /volumes/team-a rw` | 全局只读，指定路径读写 |
| `/volumes/team-a rwp` | 额外允许修改配额和布局（`ceph.quota.*`、`ceph.dir.layout.*`） |
| `/volumes/team-a rws` | 额外允许创建和删除快照 |
| `/volumes/team-a rw root_squash` | 把客户端的 root 降权，防止误删 |

### 客户端挂载

内核客户端性能最好，也是首选。新的挂载语法需要较新的内核（5.17 起）和 mount.ceph：

```bash
# client1 上：/etc/ceph 里放好 ceph.conf 和 ceph.client.team-a.keyring
mkdir -p /mnt/proj1
mount -t ceph team-a@.cfs01=/volumes/team-a/proj1/8e2f5a3c-1d4b-4c7e-9a0f-2b6d8c1e4f37 /mnt/proj1 \
  -o mon_addr=192.168.10.11:6789/192.168.10.12:6789/192.168.10.13:6789
df -h /mnt/proj1          # 容量显示为子卷配额 100G
```

设备串的格式是 `<用户>@<fsid>.<文件系统名>=<路径>`。fsid 可以省略，由 mount.ceph 从 ceph.conf 里读，但那个 `.` 不能省。密钥默认从 `/etc/ceph/ceph.client.<用户>.keyring` 读，也可以用 `secretfile=` 指定。老内核用旧语法 `mount -t ceph 192.168.10.11:6789:/volumes/... /mnt/proj1 -o name=team-a,fs=cfs01`（更早的版本叫 `mds_namespace=`，已弃用）。

写进 fstab 时一定要带 `_netdev`，否则开机时网络还没起来就去挂载，会卡住启动：

```text title="/etc/fstab"
team-a@.cfs01=/volumes/team-a/proj1/8e2f5a3c-1d4b-4c7e-9a0f-2b6d8c1e4f37  /mnt/proj1  ceph  mon_addr=192.168.10.11:6789/192.168.10.12:6789/192.168.10.13:6789,noatime,_netdev  0 0
```

内核太老，或者想让客户端 bug 不影响内核时，用 **ceph-fuse**。它跑在用户态，版本跟着 `ceph-fuse` 包走，功能总是最新，代价是性能低一些：

```bash
ceph-fuse --id team-a --client_fs cfs01 -r /volumes/team-a/proj1/8e2f5a3c-1d4b-4c7e-9a0f-2b6d8c1e4f37 /mnt/proj1
```

### 配额与目录统计

不用子卷时，也可以直接在任意目录上设配额（需要 `p` 权限）：

```bash
setfattr -n ceph.quota.max_bytes -v $((50 * 1024**3)) /mnt/cfs01/scratch
setfattr -n ceph.quota.max_files -v 1000000 /mnt/cfs01/scratch
getfattr -n ceph.quota.max_bytes /mnt/cfs01/scratch
getfattr -n ceph.dir.rbytes /mnt/cfs01/scratch    # 目录树总字节数，瞬间返回，不用 du
getfattr -n ceph.dir.rentries /mnt/cfs01/scratch  # 目录树文件与目录总数
```

> [!WARNING] CephFS 的配额是"尽力而为"
> 配额由客户端配合执行，而且有一定延迟。客户端可能超出配额写入一小段数据才被拦住，恶意或过老的客户端可能完全不遵守。多租户隔离要结合 `ceph fs authorize` 的路径限制一起用，不能只靠配额。

`ceph.dir.rbytes` 是运维里非常好用的一个属性：CephFS 递归维护每个目录的总大小，找"谁占满了空间"不需要跑几个小时的 `du`。

### 纠删码数据池

大文件为主的场景，可以给 CephFS 加一个 EC 数据池，用目录布局（layout）指定哪些目录的数据写到 EC 池：

```bash
ceph osd pool create cfs01-ec 64 64 erasure ec42_hdd
ceph osd pool set cfs01-ec allow_ec_overwrites true
ceph fs add_data_pool cfs01 cfs01-ec
setfattr -n ceph.dir.layout.pool -v cfs01-ec /mnt/cfs01/archive
```

默认数据池（`ceph fs new` 时指定的那个）最好保持副本池。每个文件的回溯信息（backtrace）都存在默认数据池里，放在 EC 池上会拖慢元数据操作。布局只对新建的文件生效，已有文件要重新拷贝才会迁移过去。

## RBD 还是 CephFS

| 需求 | 选择 | 理由 |
| --- | --- | --- |
| 虚拟机系统盘、数据库 | RBD | 单客户端独占，延迟低，快照和克隆方便 |
| 多台机器共享读写同一批文件 | CephFS | RBD 同一时刻只能被一个客户端安全写入 |
| 海量小文件、深目录 | 慎用 CephFS | 瓶颈在 MDS，需要多活和钉扎；也可以考虑对象存储 |
| Kubernetes RWO 卷 | RBD | 通过 CSI 动态供给，见 [Rook](/learn/rook-ceph) |
| Kubernetes RWX 卷 | CephFS | 基于子卷供给 |

## 动手练习

1. 建一个 `rbd01` 池并启用 `rbd` 应用，设 50 GiB 配额。建一个只能访问该池的 `client.rbd01` 用户，在 `client1` 上 map 一块 10 GiB 镜像，格式化挂载后写入一些文件。
2. 对镜像打快照，删掉几个文件，然后用两种方法恢复：一是 `rbd snap rollback`，二是从快照克隆新镜像挂载后拷回来。对比两者的耗时和操作风险。
3. 用 `rbd bench` 分别测 4K 随机写和 4M 顺序读，再在 `/dev/rbd0` 上用 fio 跑同样的参数，比较差异并解释原因。
4. 创建 CephFS `cfs01`，开启 standby-replay。建子卷组 `team-a` 和一个 10 GiB 子卷，用 `ceph fs authorize` 生成只能访问该子卷的用户，分别用内核客户端和 ceph-fuse 挂载，用 `df -h` 确认看到的容量。
5. 在 CephFS 挂载点写入超过配额的数据，观察何时报 `Disk quota exceeded`，并用 `getfattr -n ceph.dir.rbytes` 与 `du -sh` 对比耗时。

## 自测

<details>
<summary>为什么生产环境不建议把 `min_size` 设成 1？</summary>

`min_size` 是 PG 允许接受写入的最少副本数。设成 1 时，只剩一个副本也能继续写。万一这块盘也坏了，这期间写入的数据就永久丢失，而且恢复时可能出现无法判断哪份数据最新的情况。3 副本配 `min_size 2`，意味着"宁可暂停写入，也不让数据只有一份"。

</details>

<details>
<summary>RBD 快照回滚为什么慢？只想找回几个文件时有什么更好的办法？</summary>

`rbd snap rollback` 要把镜像的每个对象恢复到快照时的状态，耗时和镜像大小成正比，而且回滚期间镜像不能使用。只想找回少量文件时，可以从快照克隆（或直接只读映射快照 `rbd device map rbd01/img01@snap`），挂载后把文件拷回来，原镜像可以不停机。

</details>

<details>
<summary>CephFS 的元数据池为什么必须用副本池，而且要放 SSD？</summary>

元数据池存放 MDS 的日志和目录、inode 对象，访问模式是大量小的随机 I/O 和 omap 操作。纠删码池不支持 omap，也不适合小写，所以元数据池只能是副本池。每个元数据操作最终都要落到这个池，它的延迟直接决定 `ls`、`stat`、`create` 这类操作的延迟，所以要放在 SSD/NVMe 上。

</details>

<details>
<summary>`ceph fs status` 里 CAPS 长期超过 DNS，说明什么？</summary>

说明客户端持有大量能力（caps）不释放。MDS 要为每个 cap 维护状态，还不能把对应的 inode 移出缓存，内存会持续上涨，最终可能报 `MDS_CACHE_OVERSIZED` 或 `MDS_CLIENT_RECALL`（客户端不响应回收请求）。常见原因是某个客户端遍历了海量文件，或者客户端版本过老、回收有 bug。需要找到占用最多的客户端（`client ls` 看 `num_caps`）处理。

</details>

<details>
<summary>什么场景下用 ceph-fuse 而不是内核客户端？</summary>

客户端内核太老、不支持需要的特性（比如新挂载语法或配额）时，或者希望客户端 bug 不会导致内核卡死时，用 ceph-fuse。它随用户态包升级，功能和集群同步，代价是经过 FUSE 多一次上下文切换，性能和延迟不如内核客户端。

</details>

## 参考资料

- [Ceph 文档：Pools](https://docs.ceph.com/en/latest/rados/operations/pools/)
- [Ceph 文档：Placement Groups（autoscaler）](https://docs.ceph.com/en/latest/rados/operations/placement-groups/)
- [Ceph 文档：Basic Block Device Commands](https://docs.ceph.com/en/latest/rbd/rados-rbd-cmds/)
- [Ceph 文档：Snapshots（RBD 快照与克隆）](https://docs.ceph.com/en/latest/rbd/rbd-snapshot/)
- [Ceph 文档：FS volumes and subvolumes](https://docs.ceph.com/en/latest/cephfs/fs-volumes/)
- [Ceph 文档：Mount CephFS using Kernel Driver](https://docs.ceph.com/en/latest/cephfs/mount-using-kernel-driver/)
- [Ceph 文档：CephFS Client Capabilities（fs authorize）](https://docs.ceph.com/en/latest/cephfs/client-auth/)
- [Ceph 文档：Configuring multiple active MDS daemons](https://docs.ceph.com/en/latest/cephfs/multimds/)
- [Ceph 文档：Quotas](https://docs.ceph.com/en/latest/cephfs/quota/)
