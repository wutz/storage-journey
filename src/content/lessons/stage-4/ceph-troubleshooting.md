# Ceph 故障排查闯关

前几课的集群一直在正常运行，这一课专门来把它弄坏。Ceph 的故障很少凭空出现，大多数是某块盘变慢、某台主机时钟漂了、某个客户端握着锁不放，然后通过 PG、副本和 caps 层层放大，最后变成一整片 `HEALTH_WARN`，业务侧看到的是"存储卡了"。

排障的关键是**顺着告警找到具体的对象**：先定位是哪块 OSD、哪个 PG、哪个客户端，再下到系统层看盘和网络。本课先给出一条通用的排查路径，然后用 6 个关卡练习最常见的故障。每一关都按 **现象 → 排查命令 → 根因 → 修复 → 预防** 展开，并告诉你怎么在实验环境里复现。

> [!NOTE] 本课需要的环境
> - 按 [用 cephadm 部署 Ceph 集群](/learn/cephadm-deploy) 搭好的 3 节点集群（`ceph1`～`ceph3`，公共网 `192.168.10.0/24`，每台 3 块 OSD 盘），已经按 [RBD 与 CephFS](/learn/ceph-rbd-cephfs) 和 [RGW](/learn/ceph-rgw) 两课建好 RBD 池、CephFS `cfs01` 和 RGW 服务。
> - 客户端 `client1`（`192.168.10.21`）挂载了一块 RBD 盘和 CephFS。
> - 这是一套**可以随便弄坏的实验集群**。本课的复现步骤会停服务、塞满磁盘、改时钟，绝对不要在生产环境照做。
> - 装好 `jq`，用来过滤 JSON 输出；装好 `sysstat`，需要用到 `iostat`。

## 通用排查路径

```text
 ceph -s                     ← 1. 全局：健康状态、哪类组件异常、有没有恢复在跑
 ceph health detail          ← 2. 定位：具体是哪块 OSD / 哪个 PG / 哪个 MON / 哪个客户端
 ceph osd find N             ← 3. 找到主机：osd tree / osd metadata / orch ps
 cephadm logs --name <d>     ← 4. 守护进程日志：journald 里的报错
 ceph tell <d> ...           ← 5. 守护进程内部：in-flight 请求、会话、性能计数器
 dmesg / iostat / ping / ss  ← 6. 系统层：盘、网络、内存、时钟
```

三条原则。**先止血，再根治**：业务卡住时先把慢盘踢出去、把坏客户端驱逐掉，恢复服务之后再查根因。**一次只改一件事**：同时改三个参数，好了不知道是哪个起的作用，坏了更不知道。**改动都要记下来**：`ceph config log` 会自动记录配置变更，但设标志、`out` 某块盘这类手工操作要自己写进工单，事后复盘时最容易忘的就是"当时到底做了什么"。

`ceph health detail` 里常见的告警代码，先快速对应一下：

| 代码 | 含义 | 第一反应 |
| --- | --- | --- |
| `OSD_DOWN` | 有 OSD 心跳丢失 | 是盘坏了、进程挂了，还是网络断了 |
| `PG_DEGRADED` | 有对象的副本数不足（包括 `undersized`） | 通常是 OSD 故障的连带结果 |
| `PG_AVAILABILITY` | 有 PG 不可读写（`inactive`、`incomplete`、`down`） | **最高优先级**，业务已经受影响 |
| `SLOW_OPS` | 请求被阻塞超过 30 秒 | 找出是哪块 OSD，看盘和网络 |
| `MON_CLOCK_SKEW` | MON 之间时钟偏差过大 | 检查 chrony |
| `OSD_NEARFULL` / `POOL_NEAR_FULL` | OSD 快满了 / 池接近配额或容量上限 | 扩容或清理，检查均衡器 |
| `TOO_MANY_PGS` | 每块 OSD 上的 PG 数超过 `mon_max_pg_per_osd` | 建新池和扩 PG 都会被拒绝 |
| `OSD_SCRUB_ERRORS` / `PG_DAMAGED` | scrub 发现副本之间不一致 | 找到坏的那一份，修复 |
| `RECENT_CRASH` | 有守护进程崩溃过 | `ceph crash info <id>` 看调用栈 |

## 第 1 关：早上的一片黄

> [!QUEST] 第 1 关：五条告警同时出现
> 周一早上，监控面板上的 Ceph 集群显示 `HEALTH_WARN`，下面挂着五条告警。周末有同事重启过 `ceph3`，还有人在上面新建了几个测试池。业务方暂时没有投诉。你的任务是在一小时内把每条告警的原因理清楚，并决定先处理哪一条。

**现象**

```console
# ceph health detail
HEALTH_WARN clock skew detected on mon.ceph3; 1 osds down; Degraded data redundancy: 2201/66030 objects degraded (3.333%), 45 pgs degraded, 45 pgs undersized; 1 pool(s) nearfull; too many PGs per OSD (312 > max 250)
[WRN] MON_CLOCK_SKEW: clock skew detected on mon.ceph3
    mon.ceph3 clock skew 0.284s > max 0.05s (latency 0.0012s)
[WRN] OSD_DOWN: 1 osds down
    osd.5 (root=default,host=ceph2) is down
[WRN] PG_DEGRADED: Degraded data redundancy: 2201/66030 objects degraded (3.333%), 45 pgs degraded, 45 pgs undersized
    pg 2.1 is stuck undersized for 8m, current state active+undersized+degraded, last acting [3,7]
    ...
[WRN] POOL_NEAR_FULL: 1 pool(s) nearfull
    pool 'rbd01' is nearfull
[WRN] TOO_MANY_PGS: too many PGs per OSD (312 > max 250)
```

**排查命令**

```bash
chronyc tracking; systemctl status chrony               # 时钟：在 ceph3 上
ceph osd find 5; cephadm logs --name osd.5 | tail -30  # OSD：是进程还是盘（日志在 ceph2 上看）
dmesg -T | grep -i -E 'error|reset|I/O' | tail
ceph osd pool get-quota rbd01; ceph df detail          # 池容量：是配额还是真满了
ceph osd pool autoscale-status                         # PG 数：谁建了大量 PG、谁关了 autoscaler
```

**根因**

逐条分析下来，它们其实是四个互相独立的问题，外加一个连带结果：

- `MON_CLOCK_SKEW`：`ceph3` 重启后 chrony 没有设置开机自启，时钟漂了 0.28 秒。
- `OSD_DOWN`：`osd.5` 的日志里全是 `bluestore(/var/lib/ceph/osd/ceph-5) _read_bdev_label failed`，`dmesg` 里有大量 I/O error，是盘坏了。
- `PG_DEGRADED`：这是 `osd.5` 宕机的连带结果。`undersized` 表示 acting set 里的 OSD 数少于池的 `size`，`degraded` 表示有对象缺副本。只要还是 `active`，业务就能正常读写。
- `POOL_NEAR_FULL`：`rbd01` 设置了 500 GiB 配额，已经用了 430 GiB。池级别的这个告警**既可能是配额，也可能是 OSD 真的快满了**，一定要分清。
- `TOO_MANY_PGS`：新建的几个测试池关掉了 autoscaler，还手工设了 `pg_num 256`。

**修复**

优先级按"对数据安全的威胁"排：先处理 OSD（降级窗口里再坏一块盘就可能丢数据），再处理其他。

```bash
ceph osd out 5 && ceph orch osd rm 5 --replace --zap           # 1. 坏盘：确认不是进程问题后按换盘流程处理
systemctl enable --now chrony && chronyc makestep              # 2. 时钟（在 ceph3 上）
ceph osd pool set test-pool-1 pg_autoscale_mode on             # 3. 测试池：删掉，或者重新打开 autoscaler
ceph osd pool set-quota rbd01 max_bytes $((800 * 1024**3))     # 4. 配额：和业务方确认后调整
```

**预防**

chrony 的开机自启要写进节点初始化脚本并定期巡检；每个 OSD 主机的盘都要接入 SMART 监控；池的创建权限要收回，统一走变更流程，并且禁止关闭 autoscaler。换盘的完整流程见 [Ceph Day-2 运维](/learn/ceph-day2)。

> [!LAB] 在实验环境复现
> 在 `ceph3` 上执行 `systemctl stop chrony && date -s "+1 sec"`，再在 `ceph2` 上执行 `systemctl stop ceph-<fsid>@osd.5`，然后 `ceph osd pool create test1 256 256 && ceph osd pool set test1 pg_autoscale_mode off`，观察告警依次出现。

## 第 2 关：scrub 抓到一块坏数据

> [!QUEST] 第 2 关：PG inconsistent
> 深夜，告警群里出现 `OSD_SCRUB_ERRORS`。集群还能正常读写，业务也没有感知。值班同事想直接执行 `ceph pg repair` 了事，你要先搞清楚：三个副本里到底哪一份坏了，修复会不会把坏数据复制成三份？

**现象**

```console
# ceph health detail
HEALTH_ERR 1 scrub errors; Possible data damage: 1 pg inconsistent
[ERR] OSD_SCRUB_ERRORS: 1 scrub errors
[ERR] PG_DAMAGED: Possible data damage: 1 pg inconsistent
    pg 2.1f is active+clean+inconsistent, acting [1,4,7]
```

**排查命令**

```bash
rados list-inconsistent-obj 2.1f --format=json-pretty
```

```json
{ "epoch": 1245, "inconsistents": [ {
    "object": { "name": "rbd_data.5e3c9a1b2f4d.0000000000000a1f", "snap": "head", "version": 3012 },
    "errors": [], "union_shard_errors": ["read_error"],
    "shards": [
        { "osd": 1, "primary": true,  "errors": [],             "size": 4194304 },
        { "osd": 4, "primary": false, "errors": [],             "size": 4194304 },
        { "osd": 7, "primary": false, "errors": ["read_error"], "size": 4194304 } ] } ] }
```

再到 `osd.7` 所在的主机看盘：

```bash
ceph osd find 7
dmesg -T | grep -i -E 'medium error|unrecovered read|sector'
cephadm shell -- smartctl -a /dev/sdc | grep -i -E 'reallocated|pending|uncorrectable'
```

**根因**

`osd.7` 所在的盘出现了坏扇区（SMART 里 `Current_Pending_Sector` 不为 0）。深度 scrub（deep scrub）读取对象时遇到读错误，发现这个副本和其他两个不一致。

**修复**

错误类型决定了能不能放心修复：

| 错误类型 | 含义 | 修复是否安全 |
| --- | --- | --- |
| `read_error` | 这个副本读不出来 | 安全，用其他副本覆盖 |
| `data_digest_mismatch_info` 等（只有一个分片出错） | 校验和和记录的不一致 | 安全，BlueStore 有校验和，能判断哪一份是好的 |
| 多个分片都有错误，或者 `size_mismatch` 出现在主副本 | 无法确定哪一份是对的 | **先别修**，逐份导出比较后再决定 |

这一关只有 `osd.7` 一份出错，所以可以直接修：

```bash
ceph pg repair 2.1f
ceph -w | grep 2.1f          # 看到 repair ok 之后
ceph pg deep-scrub 2.1f      # 再做一次深度 scrub 确认
```

盘既然已经出现坏扇区，修完之后要按换盘流程把 `osd.7` 换掉。

**预防**

保证深度 scrub 能按时跑完（`PG_NOT_DEEP_SCRUBBED` 告警不要长期 mute）。关注 `OSD_TOO_MANY_REPAIRS`：它统计的是客户端读取时自动修复的次数，是 scrub 之外发现坏盘的另一个信号。副本池修复前默认信任 BlueStore 的校验和，所以不要为了性能关闭校验和（`bluestore_csum_type`）。

## 第 3 关：慢请求

> [!QUEST] 第 3 关：数据库说存储卡了
> 业务方报告：跑在 RBD 上的数据库，每隔几分钟就出现一次 30 秒以上的卡顿。集群状态在 `HEALTH_OK` 和 `HEALTH_WARN` 之间反复切换。你要找出是哪块盘（或哪段网络）拖慢了整个池。

**现象**

```console
# ceph health detail
HEALTH_WARN 23 slow ops, oldest one blocked for 67 sec, daemons [osd.4,osd.7] have slow ops.
[WRN] SLOW_OPS: 23 slow ops, oldest one blocked for 67 sec, daemons [osd.4,osd.7] have slow ops.
```

**排查命令**

先看所有 OSD 的延迟，找出离群值：

```console
# ceph osd perf
osd  commit_latency(ms)  apply_latency(ms)
  8                   3                  3
  7                 412                412
  6                   2                  2
  4                   5                  5
...
```

`osd.4` 和 `osd.7` 都有慢请求，但只有 `osd.7` 的延迟异常。再看 `osd.4` 上的慢请求具体卡在哪一步：

```bash
ceph tell osd.4 dump_historic_slow_ops | jq '.ops[0]'
```

```json
{ "description": "osd_op(client.84123.0:9921 2.1f ... rbd_data.5e3c9a1b2f4d.00000000000003b2:head [write 16384~4096] ...)",
  "duration": 38.917,
  "type_data": { "flag_point": "commit sent; apply or cleanup", "events": [
      { "event": "initiated",                   "duration": 0 },
      { "event": "queued_for_pg",               "duration": 0.0002 },
      { "event": "started",                     "duration": 0.0004 },
      { "event": "waiting for subops from 1,7", "duration": 0.0009 },
      { "event": "sub_op_commit_rec from 1",    "duration": 0.0021 },
      { "event": "sub_op_commit_rec from 7",    "duration": 38.9031 },
      { "event": "commit_sent",                 "duration": 0.0003 } ] } }
```

`events` 列表里**每个事件的 `duration` 表示从上一个事件到这个事件花了多长时间**。这里 38.9 秒都花在等 `osd.7` 的副本确认上。`osd.4` 是主 OSD，它只是受害者。常见模式：

| 耗时集中在 | 含义 |
| --- | --- |
| `waiting for subops` → `sub_op_commit_rec from N` | 副本 OSD N 慢：它的盘或者到它的网络有问题 |
| `started` 之后很久才有下一个事件 | 主 OSD 自己的盘 I/O 慢 |
| `queued_for_pg` → `reached_pg` | PG 队列积压，OSD 处理不过来（CPU 或负载太高） |
| `waiting for rw locks` | 多个请求在同一个对象上排队，通常是业务写热点 |

`throttled` 事件的耗时可能是一个异常大的数字（计数溢出），忽略它。在 cephadm 集群里，`ceph tell osd.N ...` 可以在任何管理节点上执行；想用 `ceph daemon`（admin socket）的话，要先 `cephadm enter --name osd.N` 进入容器。

最后到 `osd.7` 所在的主机看盘：

```console
# iostat -x 2 /dev/sdc
Device   r/s    w/s   rkB/s   wkB/s  r_await  w_await  aqu-sz  %util
sdc     12.0   85.5   480.0  6120.0   180.25   962.40   91.33  100.00
```

`w_await` 接近 1 秒，`%util` 100%，而同型号的其他盘只有几毫秒。`iostat` 各列的解读见 [磁盘 I/O 观测](/learn/disk-observability)。

**根因**

`osd.7` 的 HDD 正在老化，出现了大量内部重试（SMART 里 `Reallocated_Sector_Ct` 在增长），延迟飙升但还没到报错的程度。这种"慢盘"比"坏盘"更难发现：它不会 `down`，却拖慢所有经过它的写入。三副本的写入要等最慢的那个副本确认，所以一块慢盘能让整个池都慢下来。

**修复**

```bash
ceph osd out 7            # 先止血：让它不再承载 PG
# 数据迁走后，按换盘流程更换
```

如果多块 OSD 同时出现在慢请求里，并且集中在同一台主机上，就要怀疑网络：检查这台主机的网卡错误计数（`ethtool -S`、`ip -s link`）、交换机端口和 MTU。

**预防**

对每块 OSD 的 `commit_latency` 设置离群告警（比如超过同类盘中位数的 10 倍）。从 Squid 开始，BlueStore 在单个操作过慢时会报 `BLUESTORE_SLOW_OP_ALERT`，不要随手 mute。慢盘定期用 SMART 数据筛查。

## 第 4 关：MON 失去仲裁

> [!QUEST] 第 4 关：ceph 命令卡住不返回
> 所有 `ceph` 命令都卡住，最后超时退出。新的客户端挂载不上，老客户端暂时还能读写。三个 MON 里至少两个出了问题。你要让集群重新获得多数派（quorum）。

**现象**

```console
# ceph -s
2026-09-24T03:12:41.118+0000 7f3a1c7fe640  0 monclient(hunting): authenticate timed out after 300
[errno 110] RADOS timed out (error connecting to the cluster)
```

**排查命令**

`ceph` 命令要靠 quorum 才能工作，现在用不了，只能到每台 MON 主机上通过 admin socket 直接问 MON 进程：

```bash
cephadm ls | jq -r '.[] | select(.name|startswith("mon")) | "\(.name) \(.state)"'
systemctl status ceph-<fsid>@mon.ceph2
cephadm logs --name mon.ceph2 | tail -30
cephadm enter --name mon.ceph1       # 进入还活着的 MON 容器
ceph daemon mon.ceph1 mon_status | jq '{state, quorum, outside_quorum}'
```

```json
{ "state": "probing", "quorum": [], "outside_quorum": ["ceph1"] }
```

`mon.ceph1` 处于 `probing` 状态，一直在找其他 MON。再看 `ceph2` 和 `ceph3` 的日志：

```text
mon.ceph2@1(peon) e3 reached critical levels of available space on local monitor storage -- shutdown!
```

在 `ceph2`、`ceph3` 上执行 `df -h /var/lib/ceph`，显示 100% 已用；再用 `du -sh /var/lib/ceph/<fsid>/mon.ceph2/store.db /var/log/* /var/lib/containers | sort -h` 找出是谁占的空间。

**根因**

`ceph2` 和 `ceph3` 的系统盘被某个调试任务的日志写满了。MON 数据所在分区的可用空间低于 `mon_data_avail_crit`（默认 5%）时，MON 会主动关闭自己，防止数据库损坏。三个 MON 里有两个关闭，剩下一个达不到多数派，集群就失去了仲裁。

**修复**

```bash
# 1. 在 ceph2、ceph3 上腾出空间：清理日志、旧镜像等（不要动 store.db）
journalctl --vacuum-size=500M
podman image prune -a       # 用 Docker 时是 docker image prune -a
# 2. 启动 MON
systemctl start ceph-<fsid>@mon.ceph2
systemctl start ceph-<fsid>@mon.ceph3
ceph -s                     # quorum 恢复
# 3. 集群恢复后压缩 MON 数据库，回收空间
ceph tell mon.ceph2 compact
```

> [!DANGER] 最后手段：修改 monmap
> 只有当多数 MON 的数据**确定无法恢复**时（比如两台 MON 主机的系统盘都坏了），才考虑把幸存的 MON 改成单成员 monmap：停掉 `mon.ceph1`，执行 `cephadm shell --name mon.ceph1`，在里面依次运行 `ceph-mon -i ceph1 --extract-monmap /tmp/monmap`、`monmaptool /tmp/monmap --rm ceph2 --rm ceph3`、`ceph-mon -i ceph1 --inject-monmap /tmp/monmap`，退出后启动它，再重新部署另外两个 MON。**操作之前先备份整个 MON 数据目录。**删错了成员、或者幸存 MON 的数据比实际旧，都可能导致集群状态回退。拿不准的时候，先去社区邮件列表求助。

**预防**

`/var/lib/ceph` 最好放在独立的 SSD 分区上，不和日志、容器镜像共用空间。重视 `MON_DISK_LOW`（可用空间低于 30%）告警，不要等到 `MON_DISK_CRIT`。集群长时间处于非 `HEALTH_OK` 状态时，MON 会保留大量历史 map，导致数据库膨胀（`MON_DISK_BIG`），所以集群异常时要尽快恢复。5 台以上主机时部署 5 个 MON，可以容忍两个同时故障。

## 第 5 关：CephFS 卡住了

> [!QUEST] 第 5 关：一个目录谁都打不开
> 训练平台报告：CephFS 上的某个数据集目录，`ls` 一执行就卡住，好几台 GPU 节点上的任务都挂在 `D` 状态。其他目录正常。你要找出是谁"锁住"了这个目录，并在不重启 MDS 的前提下恢复。

**现象**

```console
# ceph health detail
HEALTH_WARN 1 clients failing to respond to capability release; 1 MDSs report slow requests
[WRN] MDS_CLIENT_LATE_RELEASE: 1 clients failing to respond to capability release
    mds.cfs01.ceph2.qwkfzp(mds.0): Client gpu-node-17 failing to respond to capability release client_id: 4305
[WRN] MDS_SLOW_REQUEST: 1 MDSs report slow requests
    mds.cfs01.ceph2.qwkfzp(mds.0): 23 slow requests are blocked > 30 secs
```

**排查命令**

```bash
# MDS 在等什么
ceph tell mds.cfs01:0 dump_ops_in_flight | jq '.ops[] | {description, age, flag_point: .type_data.flag_point}' | head -20
# 所有客户端会话：按持有的 caps 数排序
ceph tell mds.cfs01:0 session ls | \
  jq -r '.[] | [.id, .num_caps, .client_metadata.hostname, .inst] | @tsv' | sort -k2 -n -r | head
```

```text
4305   1843221  gpu-node-17  client.4305 v1:192.168.10.57:0/3172389011
4412   20113    gpu-node-03  client.4412 v1:192.168.10.43:0/2291038475
...
```

慢请求的 `flag_point` 是 `failed to xlock, waiting`，说明它们在等 `client.4305` 释放锁。这个客户端握着 184 万个 caps。登录 `gpu-node-17` 看内核客户端的状态：

```bash
cat /sys/kernel/debug/ceph/*/mdsc | head      # 挂起的 MDS 请求
cat /sys/kernel/debug/ceph/*/osdc | head      # 挂起的 OSD 请求
dmesg -T | grep -i ceph | tail
```

**根因**

`gpu-node-17` 上的一个数据预处理脚本对整个数据集执行了递归遍历，客户端因此拿到了海量 caps。随后这台节点的内存吃紧，内核客户端卡在回写上，无法响应 MDS 的 caps 回收请求（`MDS_CLIENT_LATE_RELEASE`）。其他客户端访问同一个目录时要等这些 caps 被释放，于是全部卡住。

**修复**

先尝试在客户端上解决：结束那个进程，释放内存。如果客户端已经没有响应，就在 MDS 上**驱逐**（evict）它：

```bash
ceph tell mds.cfs01:0 client evict id=4305
ceph osd blocklist ls                         # 被驱逐的客户端会被加入黑名单
```

驱逐后，MDS 会回收这个客户端的所有 caps，其他客户端马上恢复。代价是：被驱逐的客户端上未写回的数据会丢失，它的挂载点会变成不可用，需要 `umount -f` 后重新挂载。内核挂载时加上 `recover_session=clean` 选项，客户端可以在被驱逐后自动重连（同样会丢弃未写回的数据）。确认客户端恢复正常后，可以用 `ceph osd blocklist rm <addr>` 提前移除黑名单条目。

**预防**

监控每个客户端的 `num_caps` 和 `MDS_CLIENT_RECALL`（客户端不响应缓存回收）告警。给 MDS 足够的 `mds_cache_memory_limit`，见 [RBD 与 CephFS 一课的 MDS 部分](/learn/ceph-rbd-cephfs)。和业务方约定：不要在 CephFS 上对海量文件做 `find`、`du`，统计目录大小改用 `getfattr -n ceph.dir.rbytes`。客户端内核要保持在较新的版本，老内核的 caps 回收问题很多。

## 第 6 关：RGW 5xx 风暴

> [!QUEST] 第 6 关：对象存储大面积 503
> 下午三点，多个业务同时报告对象存储上传失败，错误码大部分是 503，也有少量 504。RGW 进程都在运行，集群没有 OSD 故障。你要找出为什么 RGW "活着却不干活"。

**现象**

```console
# ceph health detail
HEALTH_WARN 1 large omap objects; 6 slow ops, oldest one blocked for 41 sec, osd.2 has slow ops
[WRN] LARGE_OMAP_OBJECTS: 1 large omap objects
    1 large objects found in pool 'cn-east-1.rgw.buckets.index'
[WRN] SLOW_OPS: 6 slow ops, oldest one blocked for 41 sec, osd.2 has slow ops
```

**排查命令**

先看入口：haproxy 状态页（`http://<VIP 所在主机>:1967/stats`）显示所有后端都 `UP`，但响应时间很高，503 由后端返回。说明问题在 RGW 内部或者更下层。

```bash
# RGW 的请求队列是否堆积（指标名以你的版本实际输出为准）
curl -s http://ceph1:9926/metrics | grep -E 'rgw.*(qlen|qactive)'
# 是不是限流
radosgw-admin ratelimit get --ratelimit-scope=user --uid=team-a
# 索引分片是否过载
radosgw-admin bucket limit check | jq '.[] | .buckets[] | select(.fill_status != "OK")'
```

```json
{ "bucket": "app-logs", "tenant": "", "num_objects": 48213377, "num_shards": 11,
  "objects_per_shard": 4383034, "fill_status": "OVER 4383%" }
```

`osd.2` 上的慢请求都是对 `.dir.<bucket_id>.*` 对象的 omap 操作，它正是 `app-logs` 桶的索引分片之一。

**根因**

`app-logs` 桶存了 4800 万个对象，只有 11 个索引分片，每个分片承载 438 万条 omap，是建议值的 40 多倍。这个桶是从一个关闭了动态重分片的旧集群迁移过来的。每次写入都要更新一个巨大的 omap 对象，承载它的 `osd.2` 被拖慢，RGW 的请求在等待 RADOS 返回时不断堆积，并发数超过 `rgw_max_concurrent_requests` 后，新请求直接收到 503。haproxy 上等得太久的请求则变成了 504。

**修复**

```bash
# 选择低峰期；重分片期间该桶的写入可能被短暂阻塞
radosgw-admin bucket reshard --bucket=app-logs --num-shards=499
radosgw-admin reshard status --bucket=app-logs
# 重分片完成后，旧的索引对象会被清理；过几小时再触发一次深度 scrub，确认告警消失
ceph config get client.rgw rgw_dynamic_resharding     # 确认动态重分片已开启
```

在修复完成之前，可以临时给写入量最大的租户设置限流，保护其他租户。

**预防**

索引池放在 NVMe 上。预计会有上亿对象的桶在创建后就手工分片。定期执行 `radosgw-admin bucket limit check` 并对 `fill_status` 告警。日志类数据配置生命周期规则，自动过期。5xx 的完整排查路径见 [RGW 对象网关](/learn/ceph-rgw)。

## 排障工具速查

| 想知道 | 命令 |
| --- | --- |
| OSD 在哪台主机、哪块盘 | `ceph osd find N`、`ceph osd metadata N`、`ceph device ls-by-daemon osd.N` |
| PG 为什么不 `active+clean` | `ceph pg <pgid> query`（看 `recovery_state`）、`ceph pg dump_stuck` |
| OSD 在忙什么 | `ceph tell osd.N dump_ops_in_flight`、`dump_historic_slow_ops`、`ceph osd perf` |
| MDS 在等什么、谁占着 caps | `ceph tell mds.<fs>:0 dump_ops_in_flight`、`session ls` |
| 临时加大日志 | `ceph config set osd.N debug_osd 10`，查完用 `ceph config rm` 恢复 |
| 某条告警先静音 | `ceph health mute <CODE> 1h`（一定要带时间，不要永久静音） |

## 动手练习

1. 按第 1 关的"实验环境复现"同时制造时钟偏差、OSD 宕机和 PG 过多三个问题，只看 `ceph health detail` 写出每条告警的根因和处理优先级，再逐一修复。
2. 用 `ceph-objectstore-tool` 或直接覆盖 BlueStore 块的方法制造一个不一致对象（先停掉对应 OSD，只在实验环境做），然后等待或手工触发深度 scrub，用 `rados list-inconsistent-obj` 找出坏副本并修复。
3. 在一台 OSD 主机上用 `tc qdisc add dev eth0 root netem delay 200ms` 给集群网加延迟，在客户端跑 fio，用 `ceph osd perf` 和 `dump_historic_slow_ops` 定位到这台主机。练习结束后记得删掉这条 tc 规则。
4. 停掉三个 MON 中的两个，观察 `ceph -s` 的行为和客户端 I/O 的变化。用 admin socket 查看剩余 MON 的状态，然后恢复。
5. 在客户端对 CephFS 挂载点执行大规模 `find`，用 `session ls` 观察 `num_caps` 的变化，再用 `client evict` 驱逐这个客户端，观察客户端侧的报错和重新挂载的过程。

## 自测

<details>
<summary>`active+undersized+degraded` 的 PG 业务还能读写吗？和 `inactive` 有什么区别？</summary>

能。`active` 表示 PG 可以处理读写请求，`undersized` 表示 acting set 里的 OSD 数少于池的 `size`，`degraded` 表示有对象缺副本。这种状态下数据冗余降低了，但服务不中断。`inactive`（包括 `incomplete`、`down` 等）表示 PG 无法处理请求，相关的读写会挂住，业务已经受到影响，应该最优先处理。

</details>

<details>
<summary>慢请求出现在 osd.4 上，是否说明 osd.4 的盘有问题？</summary>

不一定。需要看慢请求在哪个事件上花的时间最多。如果耗时集中在 `waiting for subops` 到 `sub_op_commit_rec from 7` 之间，说明 osd.4 作为主 OSD 在等副本 osd.7，真正慢的是 osd.7 的盘或到它的网络。结合 `ceph osd perf` 找延迟离群的 OSD，再到对应主机用 `iostat -x` 确认。

</details>

<details>
<summary>三个 MON 挂了两个时，为什么 `ceph -s` 卡住，而已经挂载的客户端还能暂时读写？</summary>

`ceph` 命令要通过 MON 的多数派获取集群状态、完成认证，没有 quorum 就无法响应。已经连接的客户端手里有 OSD map 和认证票据，可以直接和 OSD 通信，所以短时间内还能读写。但 map 不能更新，OSD 状态变化无法传播，票据过期后也无法续期，新客户端也连不上，所以必须尽快恢复 quorum。

</details>

<details>
<summary>驱逐（evict）一个 CephFS 客户端有什么代价？什么时候应该这样做？</summary>

被驱逐的客户端会被加入 OSD 黑名单，它未写回的脏数据会丢失，挂载点变得不可用，需要强制卸载后重新挂载（或者依赖 `recover_session=clean` 自动重连）。所以应该先尝试在客户端侧解决（结束进程、释放内存）。当客户端已经无响应，并且它持有的 caps 阻塞了其他客户端时，才用驱逐来恢复整体服务。

</details>

<details>
<summary>RGW 进程都在运行，却大量返回 503，可能的原因有哪些？</summary>

常见原因有三类：一是触发了用户或桶的限流；二是并发请求数超过 `rgw_max_concurrent_requests`，新请求被直接拒绝；三是后端 RADOS 太慢（比如桶索引分片过大导致索引 OSD 出现慢请求，或者数据池有慢盘），请求在 RGW 里不断堆积，最终触发第二种情况。排查时先确认 5xx 来自 haproxy 还是 RGW，再看 RGW 的队列指标，最后看 `ceph health detail` 里的 `SLOW_OPS` 和 `LARGE_OMAP_OBJECTS`。

</details>

## 参考资料

- [Ceph 文档：Health checks（所有告警代码说明）](https://docs.ceph.com/en/latest/rados/operations/health-checks/)
- [Ceph 文档：Troubleshooting OSDs（慢请求与 dump_historic_ops）](https://docs.ceph.com/en/latest/rados/troubleshooting/troubleshooting-osd/)
- [Ceph 文档：Troubleshooting PGs](https://docs.ceph.com/en/latest/rados/troubleshooting/troubleshooting-pg/)
- [Ceph 文档：Troubleshooting Monitors](https://docs.ceph.com/en/latest/rados/troubleshooting/troubleshooting-mon/)
- [Ceph 文档：Adding/Removing Monitors（从不健康集群中移除 MON）](https://docs.ceph.com/en/latest/rados/operations/add-or-rm-mons/)
- [Ceph 文档：CephFS Client eviction](https://docs.ceph.com/en/latest/cephfs/eviction/)
- [Ceph 文档：CephFS health messages](https://docs.ceph.com/en/latest/cephfs/health-messages/)
- [Ceph 文档：RGW Resharding](https://docs.ceph.com/en/latest/radosgw/dynamicresharding/)
