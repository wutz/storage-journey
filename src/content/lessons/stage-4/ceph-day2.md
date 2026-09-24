# Ceph Day-2 运维

部署是 Day-1，只做一次。之后几年的日常都属于 Day-2：每天看一眼集群状态，每个月换几块坏盘，每个季度扩一次容，每年做一两次大版本升级。真正决定一套 Ceph 稳不稳的是这些重复操作，而且这些操作里的每一步都可能引发大规模数据迁移，甚至让业务停摆。

这一课把最常见的 Day-2 操作整理成可以照做的流程：巡检、扩容、换盘、维护模式、升级、参数管理、恢复限速和容量水位。每个流程我都会讲清楚"为什么这么做"，这样你遇到文档没写到的情况，也能自己判断。

> [!NOTE] 本课需要的环境
> - 按 [用 cephadm 部署 Ceph 集群](/learn/cephadm-deploy) 搭好的 3 节点集群（`ceph1`～`ceph3`，每台 3 块 20 GiB OSD 盘），已经建好上一课的 RBD 池并写入一些数据（恢复过程才有东西可看）。
> - **额外一台** `ceph4`（`192.168.10.14`，集群网 `192.168.20.14`），配置和前三台相同，也带 3 块空盘，用来练习扩容。
> - 虚拟机平台要能在线**拔掉或挂上一块虚拟盘**，用来模拟坏盘。
> - 升级练习需要能拉取两个相邻小版本的镜像，比如 v20.2.3 和 v20.2.4（截至本文写作时 Tentacle 的最新两个小版本，以官方发布页为准）。

## 每日巡检清单

每天早上花五分钟，把这几条命令跑一遍。最好写成脚本，定时跑，并把输出发到群里：

```bash title="ceph-daily.sh"
#!/usr/bin/env bash
ceph -s                          # 总体状态、IO、恢复进度
ceph health detail               # 每条告警的具体对象
ceph df                          # 各池用量与剩余可用空间
ceph osd df tree                 # 每块 OSD 的使用率与分布偏差
ceph pg stat                     # PG 状态汇总
ceph crash ls-new                # 新的守护进程崩溃记录
ceph orch ps | grep -v running   # 不在运行状态的守护进程
```

每条命令重点看什么：

| 命令 | 关注点 | 危险信号 |
| --- | --- | --- |
| `ceph -s` | health、OSD `up`/`in` 数、`pgs:` 行 | 不是 `HEALTH_OK`；`up` 小于 `in`；出现 `recovery`/`backfill` 却没有人在做变更 |
| `ceph health detail` | 告警涉及的具体 OSD、PG、池 | 同一块 OSD 反复出现在 `SLOW_OPS` 里 |
| `ceph df` | 每个池的 `MAX AVAIL` | `MAX AVAIL` 下降速度超过你的扩容节奏 |
| `ceph osd df tree` | `%USE` 和 `VAR` 列 | 某块 OSD 的 `VAR` 超过 1.1（比平均值高 10%），或者 `%USE` 接近 85% |
| `ceph pg stat` | 是否全部 `active+clean` | 出现 `inconsistent`、`incomplete`、`stale` |
| `ceph crash ls-new` | 新崩溃 | 同一个守护进程反复崩溃 |

```console
# ceph osd df tree
ID  CLASS  WEIGHT   REWEIGHT  SIZE     RAW USE  DATA     OMAP     META     AVAIL    %USE   VAR   PGS  STATUS  TYPE NAME
-1         0.17578         -  180 GiB   61 GiB   58 GiB   12 KiB  2.9 GiB  119 GiB  33.84  1.00    -          root default
-3         0.05859         -   60 GiB   20 GiB   19 GiB    4 KiB  1.0 GiB   40 GiB  33.61  0.99    -              host ceph1
 0    hdd  0.01953   1.00000   20 GiB  6.9 GiB  6.6 GiB    1 KiB  336 MiB   13 GiB  34.56  1.02   45      up          osd.0
 1    hdd  0.01953   1.00000   20 GiB  6.4 GiB  6.1 GiB    1 KiB  335 MiB   14 GiB  32.04  0.95   42      up          osd.1
...
```

`VAR` 是这块 OSD 的使用率和平均值之比。分布不均时，最满的那块盘决定了集群还能写多少，所以要打开均衡器（balancer），用 upmap 模式把 PG 挪匀：

```bash
ceph balancer status            # 默认已开启，mode 应为 upmap
ceph balancer mode upmap        # 需要 ceph osd set-require-min-compat-client luminous
ceph balancer on
```

> [!TIP] 巡检要留下记录
> 把每天的 `ceph df` 结果存下来，时间长了就是一条容量趋势线，扩容时机和采购量都靠它推算。监控系统可以代劳这件事，但很多团队的监控只告警、不留趋势。容量规划的方法见 [容量与性能规划](/learn/capacity-planning)。

## 扩容：加节点与加盘

### 加节点之前

有一步很多人会跳过：**确认新节点和所有客户端网络互通**。CephFS 和 RBD 客户端会直接连接每一块 OSD，新节点上的 OSD 一旦上线，就会开始承载 PG。如果某些客户端的网络到不了新节点，这些客户端的 I/O 就会挂住。检查方法是从 MDS 的会话列表里拿到所有客户端地址，逐个 ping 新节点：

```bash
ceph tell mds.cfs01:0 client ls | grep '"addr"' | sort -u    # CephFS 客户端地址
rbd status rbd01/img01                                       # RBD 镜像的 watcher 就是正在使用它的客户端
# 在新节点上逐个 ping 这些地址（MTU 9000 的网络顺便验证大包：ping -M do -s 8972）
```

还要确认新节点的内核、容器运行时、chrony、MTU 都和老节点一致。MTU 不一致是最隐蔽的问题：小包能通，大包丢弃，现象是 OSD 时上时下（flapping）。

### 加入主机

```bash
ssh-copy-id -f -i /etc/ceph/ceph.pub root@ceph4
ceph orch host add ceph4 192.168.10.14 --labels osd
```

如果 OSD 服务规格的 `placement` 匹配 `label:osd`，而新节点的盘也符合过滤条件，cephadm 会**自动**在上面创建 OSD，数据随即开始迁移。一次加入很多节点时，这会让集群反复重新计算和迁移。更可控的做法是先冻结数据迁移，等所有 OSD 都起来后再放开：

```bash
ceph osd set norebalance
ceph osd set nobackfill
ceph orch host add ceph4 192.168.10.14 --labels osd
# 等 ceph osd tree 里新 OSD 全部 up
ceph osd unset nobackfill
ceph osd unset norebalance
ceph -s          # 看 backfill 进度
```

对于延迟敏感的集群，还可以让新 OSD 以权重 0 加入（`ceph config set osd osd_crush_initial_weight 0`），然后分几次用 `ceph osd crush reweight osd.N <权重>` 调到满权重，把迁移分摊到几天内完成。加完之后记得把这个参数删掉，否则以后换盘时新 OSD 也是 0 权重。

## 换坏盘：完整流程

坏盘是 Day-2 最高频的操作。整个流程是：**确认 → 让数据迁走 → 删除并保留 ID → 换盘 → 新盘自动加入 → 确认恢复**。

### 第 1 步：确认是哪块盘

```console
# ceph health detail
HEALTH_WARN 1 osds down; Degraded data redundancy: 1203/36090 objects degraded (3.333%), 41 pgs degraded
[WRN] OSD_DOWN: 1 osds down
    osd.7 (root=default,host=ceph3) is down
...
# ceph osd metadata 7 | grep -E '"hostname"|"devices"|"device_ids"'
    "device_ids": "vdb=VIRTIO_vd-0201",
    "devices": "vdb",
    "hostname": "ceph3",
```

物理机上用序列号定位，再点亮盘位灯，避免拔错盘：

```bash
ceph device ls-by-daemon osd.7
ceph device light on <DEVICE_ID>        # 需要硬件和 libstoragemgmt 支持
cephadm shell -- smartctl -a /dev/sdX   # 在 ceph3 上看 SMART 信息
```

> [!WARNING] 先判断是盘坏了还是进程挂了
> OSD `down` 不一定是盘坏了，也可能是 OOM、进程崩溃或网络问题。先在对应主机上看 `cephadm logs --name osd.7` 和 `dmesg | grep -i -E 'error|sdX'`。进程问题重启一下（`ceph orch daemon restart osd.7`）就好了，不需要换盘。

### 第 2 步：让数据迁走

OSD `down` 之后，过了 `mon_osd_down_out_interval`（默认 600 秒），MON 会自动把它标记为 `out`，数据开始在其他 OSD 上重建。如果已经确认要换盘，可以手工提前：

```bash
ceph osd out 7
ceph -s     # 看到 recovery / backfill 进度，直到所有 PG 恢复 active+clean
```

盘没完全坏、还能读的时候（比如 SMART 报预警），先 `out` 再等恢复，这是最安全的：数据是从这块盘上迁走的，任何时刻都保持完整副本数。

### 第 3 步：删除并保留 ID

```bash
ceph osd safe-to-destroy osd.7          # 确认删除它不会丢数据
ceph orch osd rm 7 --replace --zap
ceph orch osd rm status
```

```text
OSD  HOST   STATE     PGS  REPLACE  FORCE  ZAP   DRAIN STARTED AT
7    ceph3  draining  12   True     False  True  2026-09-24 10:31:07
```

`--replace` 不会把 OSD 从 CRUSH 里彻底删掉，而是标记为 `destroyed`，保留 ID 和 CRUSH 位置。之后新盘直接复用 `osd.7`，CRUSH 拓扑不变，所以只有这块盘上的数据需要回填，不会引起全集群的二次迁移。`--zap` 会清掉这个 OSD 相关的 LVM 卷。DB 放在共享 NVMe 上时，这一步会同时释放它在 NVMe 上的 DB 卷，新 OSD 才有空间可用。

```console
# ceph osd tree | grep osd.7
 7    hdd  0.01953  osd.7   destroyed         0  1.00000
```

### 第 4 步：换盘，新盘自动加入

物理更换硬盘（虚拟机里就是挂一块新虚拟盘）。只要 OSD 服务规格没有设置 `unmanaged`，而新盘符合过滤条件，cephadm 会在下一次设备刷新时自动在它上面建 OSD，并复用 ID 7：

```bash
ceph orch device ls ceph3 --refresh     # 新盘显示 AVAILABLE Yes
ceph -W cephadm                         # 看到 Deploying daemon osd.7 on ceph3
ceph osd tree | grep osd.7              # 状态变回 up
```

新盘如果带着旧分区，先 `ceph orch device zap ceph3 /dev/vdb --force`。

### 第 5 步：确认恢复

```bash
ceph -s                 # 回填完成后恢复 HEALTH_OK
ceph osd df tree        # 新 OSD 的 PGS 和 %USE 逐渐接近同类盘
```

> [!DANGER] 自动部署的反面：zap 错盘
> 正因为有自动创建，**zap 一块盘就等于让 cephadm 马上在它上面建 OSD**。想清空一块盘另作他用，先把 OSD 服务改成 `unmanaged: true`，或者先把这块盘从过滤条件里排除。

### 残留 LVM 的清理

偶尔 `orch osd rm` 没能清理干净，新盘或者旧盘位上留下了 LVM 卷，导致设备显示为不可用，或者报 `Can't open /dev/sdX exclusively`。先确认残留卷属于哪个 OSD：`ls -l /var/lib/ceph/<fsid>/osd.7/block` 指向的就是它的 LV。确认没有任何守护进程在用之后，按 `lvremove` → `vgremove` → `pvremove` → `sgdisk --zap-all` 的顺序清理。如果还有 device-mapper 映射残留，用 `dmsetup ls` 找出来，再 `dmsetup remove`。

## 运维标志与维护模式

### 集群级标志

| 标志 | 作用 | 典型场景 |
| --- | --- | --- |
| `noout` | OSD `down` 后不会被自动 `out` | 计划内重启，避免触发数据迁移 |
| `norebalance` | 不做负载均衡式的迁移（降级 PG 的恢复不受影响） | 批量扩容时 |
| `nobackfill` / `norecover` | 停止回填 / 恢复 | 业务高峰期临时止血 |
| `noscrub` / `nodeep-scrub` | 停止 scrub | 升级或恢复期间减少 I/O 压力 |
| `pause` | 停止所有读写 | 几乎不用，停整个集群时才用 |

```bash
ceph osd set noout
ceph osd unset noout
ceph osd set-group noout ceph2      # 只对某台主机（或某些 OSD）生效，更精确
ceph osd unset-group noout ceph2
```

**标志设了一定要记得取消。**`noout` 一直挂着，真坏了一块盘也不会触发恢复，集群会带着降级的副本一直运行下去。`ceph -s` 会用 `noout flag(s) set` 提醒你，巡检时要看这一行。

### 维护模式

重启一台主机、升级内核、换内存时，用 cephadm 的维护模式：

```bash
ceph orch host ok-to-stop ceph2           # 确认停掉这台主机上的所有守护进程是安全的
ceph orch host maintenance enter ceph2
# 在 ceph2 上做维护、重启……
ceph orch host maintenance exit ceph2
ceph -s
```

`maintenance enter` 会给这台主机的 OSD 设置 `noout`、停掉并禁用所有 Ceph 守护进程；`exit` 时恢复。`ok-to-stop` 不通过时（比如 MON 只剩多数派的最低人数，或者某些 PG 只剩这台主机上的副本），**不要**加 `--force` 强行进入，先把集群恢复到 `HEALTH_OK`。

## 升级：换一个镜像

cephadm 的升级就是把所有守护进程滚动替换成新版本的镜像，顺序是固定的：MGR → MON → crash → OSD → MDS → RGW → 其他。每换一个守护进程，编排器都会确认它安全（比如 `ok-to-stop`）后再继续。

**升级前的准备：**

1. 读目标版本的 release notes，重点看"Upgrading"一节和已知问题。大版本升级要确认你的起始版本在支持的路径上（通常支持跨一到两个大版本，以 release notes 为准）。
2. 集群 `HEALTH_OK`，没有正在进行的恢复。
3. 私有仓库环境，先把新版本镜像同步过去（见 [部署一课的离线部署](/learn/cephadm-deploy)）。
4. 先在测试集群上升级一遍。

```bash
ceph orch upgrade check --image quay.io/ceph/ceph:v20.2.4
ceph orch upgrade start --image quay.io/ceph/ceph:v20.2.4
ceph orch upgrade status
```

```json
{
    "target_image": "quay.io/ceph/ceph@sha256:<digest>",
    "in_progress": true,
    "which": "Upgrading all daemon types on all hosts",
    "services_complete": ["mgr", "mon", "crash"],
    "progress": "11/27 daemons upgraded",
    "message": "Currently upgrading osd daemons",
    "is_paused": false
}
```

升级过程中用 `ceph -W cephadm` 看实时日志。发现问题时先 `ceph orch upgrade pause`，排查后 `resume`；要放弃就 `stop`。`stop` 不会回滚已经升级的守护进程，Ceph 不支持降级到更早的大版本。

**分批升级**适合大集群或者想更谨慎的场景：先升 MGR 和 MON，观察一天，再按主机分批升 OSD：

```bash
ceph orch upgrade start --image quay.io/ceph/ceph:v20.2.4 --daemon-types mgr,mon
ceph orch upgrade start --image quay.io/ceph/ceph:v20.2.4 --daemon-types osd --hosts ceph1
ceph orch upgrade start --image quay.io/ceph/ceph:v20.2.4 --services rgw.s3 --limit 2
```

升级完成后：

```bash
ceph versions          # 所有守护进程都在新版本
ceph health detail     # 大版本升级后可能提示需要设置 require-osd-release
ceph osd require-osd-release tentacle     # 仅大版本升级时需要，按提示执行
```

> [!PROD] 升级窗口的经验
> 升级期间 OSD 会逐个重启，每个 OSD 重启时它的 PG 会短暂 peering，客户端能感觉到几秒的延迟抖动。团队的做法是：在业务低峰期升级；先设置 `noscrub`/`nodeep-scrub` 减少干扰；升级完成、确认稳定后再取消。客户端（内核模块、librbd、ceph-fuse）不会跟着集群升级，要单独规划。

## 参数管理：ceph config

从 Mimic 开始，Ceph 的配置主要存在 MON 的**集中配置库**里，`ceph.conf` 只剩连接 MON 所需的最少信息。改参数用 `ceph config`，不要登录到各台主机上改文件。

```bash
ceph config set osd osd_memory_target 6442450944     # 所有 OSD
ceph config set osd.7 debug_osd 10                   # 单个 OSD
ceph config get osd.7 osd_memory_target              # 配置库里的值
ceph config show osd.7 osd_memory_target             # 这个进程实际在用的值
ceph config dump                                     # 所有显式设置过的参数
ceph config log 10                                   # 最近 10 次配置变更，可以用来追责和回滚
ceph config rm osd.7 debug_osd                       # 删除设置，回到默认值
```

`who` 部分可以写成不同的粒度，越具体的优先级越高：

| 写法 | 作用范围 |
| --- | --- |
| `global` | 所有守护进程和客户端 |
| `osd` / `mon` / `mds` / `client` | 某一类守护进程 |
| `osd.7`、`client.rgw` | 单个守护进程，或者某个名字前缀的一组守护进程 |
| `osd/class:ssd` | 带掩码：只对 SSD 类的 OSD 生效 |
| `osd/host:ceph3` | 带掩码：只对某台主机上的 OSD 生效 |

`get` 和 `show` 的区别要记住：`get` 查的是配置库里写了什么，`show` 查的是进程实际在用什么。两者不一样，说明参数需要重启才能生效，或者被命令行参数覆盖了。`ceph tell osd.* config set ...` 只改运行时的值，重启后就丢失，只适合临时调试。

> [!TIP] 每次改参数都要能回滚
> `ceph config log` 会列出每次变更的编号，`ceph config reset <编号>` 可以把整个配置库回退到那个时刻。重要变更前，先用 `ceph config dump > config-$(date +%F).txt` 备份一份。

## 恢复限速：mClock

故障恢复时，恢复流量和客户端 I/O 在同一批盘上竞争。恢复太快，业务会卡顿；恢复太慢，集群长时间处于降级状态，再坏一块盘就有丢数据的风险。

从 Quincy（v17）开始，OSD 默认使用 **mClock** 调度器。它根据每块 OSD 测出的 IOPS 能力，按"配置档"（profile）给客户端、恢复和后台任务分配份额：

| profile | 效果 | 什么时候用 |
| --- | --- | --- |
| `balanced`（默认） | 客户端和恢复大致平衡 | 平时 |
| `high_client_ops` | 优先保证客户端 I/O，恢复变慢 | 业务高峰期出现故障，恢复可以等 |
| `high_recovery_ops` | 优先恢复，客户端 I/O 让步 | 夜间，或者降级严重、要尽快恢复冗余 |

```bash
ceph config set osd osd_mclock_profile high_recovery_ops
ceph -s | grep -A2 io:
```

```text
  io:
    client:   12 MiB/s rd, 3.1 MiB/s wr, 210 op/s rd, 95 op/s wr
    recovery: 486 MiB/s, 121 objects/s
```

恢复结束后记得切回 `balanced`。在 mClock 下，`osd_max_backfills`、`osd_recovery_max_active` 这类老参数**默认会被忽略**。确实要手工调，先打开覆盖开关，调完再关上：

```bash
ceph config set osd osd_mclock_override_recovery_settings true
ceph config set osd osd_max_backfills 3
# ……恢复完成后
ceph config rm osd osd_max_backfills
ceph config set osd osd_mclock_override_recovery_settings false
```

mClock 的效果依赖 OSD 启动时测得的 IOPS（`osd_mclock_max_capacity_iops_[hdd|ssd]`）。如果某块盘测出的值明显偏离实际，可以用 `ceph config show osd.N | grep mclock_max_capacity` 查看，必要时手工设置。

## 容量水位：nearfull、backfillfull、full

| 阈值 | 默认值 | 超过之后 |
| --- | --- | --- |
| `nearfull_ratio` | 0.85 | 告警 `OSD_NEARFULL`，提醒你该扩容了 |
| `backfillfull_ratio` | 0.90 | 这块 OSD 不再接收回填，恢复可能卡住 |
| `full_ratio` | 0.95 | 告警 `OSD_FULL`，**集群停止接受写入** |

```bash
ceph osd dump | grep ratio
# full_ratio 0.95
# backfillfull_ratio 0.9
# nearfull_ratio 0.85
```

一块 OSD 满了就会阻塞整个池的写入，不管其他 OSD 还剩多少空间。所以真正需要盯住的是**最满的那块 OSD**，而不是集群平均使用率。

集群已经 `full`、业务停写时的应急步骤：

```bash
ceph osd set-full-ratio 0.96          # 临时调高一点点，只是为了能执行删除
# 删除可以删的数据（快照、回收站、过期对象……），或者尽快加盘
ceph osd set-full-ratio 0.95          # 马上改回去
```

> [!DANGER] 不要把 full_ratio 调到 0.97 以上
> BlueStore 自己也需要空间来做元数据操作和压缩整理。OSD 真正写满 100% 后可能根本起不来，恢复会非常痛苦。调高阈值只是为了争取几分钟删除数据的时间，不是扩容的替代品。

**什么时候该扩容？**要考虑一台主机故障后的情况：它上面的数据会重建到其他主机，其他主机的使用率会随之上升。3 台主机的集群平均使用率达到 60%，一台主机故障后，另外两台就会升到约 90%，直接超过 `backfillfull`，恢复卡住。所以节点越少，扩容线要设得越低。容量计算可以用 [容量计算器](/calculator)。

## 动手练习

1. 把本文的巡检脚本配置成每天定时运行，连续跑三天，对比 `ceph df` 的变化，估算按当前写入速度集群多久会达到 85%。
2. 设置 `norebalance` 和 `nobackfill` 后加入 `ceph4`，等新 OSD 全部 `up` 后取消标志，记录回填耗时，并对比回填前后 `ceph osd df tree` 的 `VAR` 列。
3. 在虚拟机平台上拔掉 `ceph3` 的一块数据盘，按本文五个步骤完成完整换盘，确认新 OSD 复用了原来的 ID，且 CRUSH 拓扑没有变化。
4. 在恢复过程中分别切换 `balanced`、`high_client_ops`、`high_recovery_ops`，同时在客户端用 fio 跑 4K 随机写，记录三种配置下的恢复速度和客户端 IOPS。
5. 用 v20.2.3 部署一套集群，先只升级 MGR 和 MON，再按主机升级 OSD，最后升级剩余服务，全程用 `ceph orch upgrade status` 和 `ceph versions` 记录进度。

## 自测

<details>
<summary>换盘时为什么要用 `ceph orch osd rm <id> --replace`，而不是直接删除 OSD？</summary>

`--replace` 会把 OSD 标记为 `destroyed`，保留它的 ID 和在 CRUSH 里的位置。新盘加入后复用这个 ID，CRUSH 拓扑不变，只需要把属于这块盘的 PG 回填回来。如果直接删除 OSD，CRUSH 结构会变化两次（删除时一次，新盘加入时又一次），导致两轮全集群范围的数据迁移。

</details>

<details>
<summary>计划重启一台存储主机，为什么要设 `noout`？忘记取消会怎样？</summary>

主机上的 OSD `down` 超过 `mon_osd_down_out_interval`（默认 600 秒）后会被自动标记为 `out`，触发数据重建。对于几分钟就能回来的计划内重启，这些迁移完全是浪费，还会增加 I/O 压力。设了 `noout`，这段时间只是降级，主机回来后增量恢复即可。忘记取消的话，真出现坏盘时也不会自动 `out`，集群会一直带着降级的副本运行，风险持续累积。维护模式会自动处理这件事。

</details>

<details>
<summary>`ceph config get` 和 `ceph config show` 有什么区别？</summary>

`get` 返回集中配置库里为这个守护进程设置的值，`show` 返回这个进程当前实际生效的值。两者不一致，通常是参数需要重启才能生效，或者被命令行参数、本地 `ceph.conf` 覆盖了，或者是用 `ceph tell ... config set` 临时改的运行时值。

</details>

<details>
<summary>mClock 调度器下调整 `osd_max_backfills` 为什么不生效？</summary>

mClock 根据配置档统一管理恢复相关的参数，默认会忽略 `osd_max_backfills`、`osd_recovery_max_active` 这些老参数的手工设置。优先的做法是切换 `osd_mclock_profile`（比如切到 `high_recovery_ops`）。确实需要手工调时，要先设置 `osd_mclock_override_recovery_settings true`，调完后再关掉。

</details>

<details>
<summary>集群平均使用率只有 70%，为什么会出现写入被阻塞？</summary>

写入阻塞看的是单块 OSD 是否达到 `full_ratio`（默认 95%），而不是平均值。数据分布不均（`VAR` 偏大），或者某台主机故障后数据集中重建到其他主机，都可能让个别 OSD 先满。要打开 upmap 均衡器让分布均匀，并按"失去一个故障域后仍低于 backfillfull"的标准规划扩容线。

</details>

## 参考资料

- [Ceph 文档：Upgrading Ceph（cephadm）](https://docs.ceph.com/en/latest/cephadm/upgrade/)
- [Ceph 文档：OSD Service（删除与替换 OSD）](https://docs.ceph.com/en/latest/cephadm/services/osd/)
- [Ceph 文档：Host Management（维护模式、drain）](https://docs.ceph.com/en/latest/cephadm/host-management/)
- [Ceph 文档：Configuring Ceph（集中配置库与 ceph config）](https://docs.ceph.com/en/latest/rados/configuration/ceph-conf/)
- [Ceph 文档：mClock Config Reference](https://docs.ceph.com/en/latest/rados/configuration/mclock-config-ref/)
- [Ceph 文档：Balancer](https://docs.ceph.com/en/latest/rados/operations/balancer/)
- [Ceph 文档：Health checks（OSD_NEARFULL / OSD_FULL 等）](https://docs.ceph.com/en/latest/rados/operations/health-checks/)
- [Ceph Releases](https://docs.ceph.com/en/latest/releases/)
