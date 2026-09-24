# I/O 调优：调度器、队列与内核参数

网上搜"Linux 磁盘优化"，你会看到一大堆"十个让 I/O 性能翻倍的参数"：调度器改成 noop、`read_ahead_kb` 调到 16 MB、`vm.dirty_ratio` 改成 80、`swappiness` 改成 0……照着改完，机器好像快了，又好像没快，出了问题谁也说不清是哪一条惹的祸。这正是[性能分析方法论](/learn/methodology)里的随机调参反方法。

先泼一盆冷水：《Systems Performance》第 9 章 9.9 节说得很清楚，**这些参数的默认值通常是合理的，很少需要大改**。调参的收益往往比不上消除不必要的工作，也比不上换一种架构。但默认值是按"一般情况"选的，在你的负载下未必最优——大内存机器的脏页阈值、SATA 盘上的混合读写、跨 NUMA 访问 NVMe，这些都是真实存在、调了就能测出差别的地方。这一课讲：调之前测什么；如何选择 I/O 调度器；`nr_requests`、`read_ahead_kb`、`max_sectors_kb`、`rq_affinity`、`nomerges` 这几个队列参数各管什么；`vm.dirty_*` 和 `swappiness`；挂载选项和 XFS/ext4 的格式化参数；NVMe 中断与 NUMA 亲和；最后用 udev 规则和 tuned 把配置持久化，并且**给每一项都配上验证方法**。本课主要取材于《Systems Performance》第 8 章和第 9 章。

## 调优之前：先测量

调优是一个实验，不是一个动作。每改一项都走同一个闭环：

```text
基线测量 ──▶ 提出假设 ──▶ 只改一个参数 ──▶ 同样负载重测 ──▶ 对比 ──▶ 保留或回滚
（数据）     （为什么会变好）  （记录旧值）     （重复 3 次）    （均值±标准差）  （写进变更记录）
```

"提出假设"这一步最常被跳过。"把 `read_ahead_kb` 调大"不是假设；"这个负载是单线程的大文件顺序读，设备延迟 1 ms，128 KiB 的预读窗口让吞吐被限制在约 128 MB/s，调到 4 MiB 后应该能接近设备带宽上限"才是假设——它告诉你该用什么负载验证、预期看到什么。

动手前先给当前配置拍个快照。`grep . 文件...` 会以"文件名:内容"的格式打印，非常适合批量查看 sysfs：

```bash title="io-snapshot.sh"
#!/usr/bin/env bash
# 保存当前的 I/O 相关配置，调优前后各跑一次，用 diff 对比
out=io-snapshot-$(hostname)-$(date +%F-%H%M).txt
{
  uname -r
  for q in /sys/block/{sd*,nvme*n*,vd*}/queue; do
    [ -d "$q" ] || continue
    grep -H . "$q"/{scheduler,nr_requests,read_ahead_kb,max_sectors_kb,max_hw_sectors_kb,rq_affinity,nomerges,rotational,wbt_lat_usec} 2>/dev/null
  done
  sysctl vm.dirty_ratio vm.dirty_background_ratio vm.dirty_bytes vm.dirty_background_bytes \
         vm.dirty_expire_centisecs vm.dirty_writeback_centisecs vm.swappiness vm.vfs_cache_pressure
  findmnt -rno TARGET,SOURCE,FSTYPE,OPTIONS -t xfs,ext4
  command -v tuned-adm >/dev/null && tuned-adm active
} > "$out"
echo "saved to $out"
```

> [!PROD] 参数变更要当成代码变更
> 每一项调优都应该有：变更前后的快照 diff、验证数据、回滚方法，并且最终落进配置管理（Ansible、udev 规则、tuned profile），而不是某个人某天手敲的 `echo`。重启后消失的调优是最危险的——你以为它在生效，其实没有。

## I/O 调度器

### 四个选项

截至本文写作时，Ubuntu 24.04 的 6.8 内核提供四个多队列（blk-mq）调度器：

| 调度器 | 原理 | 适合 | 代价 |
|---|---|---|---|
| `none` | 不排序、不调度，请求直接下发到硬件队列 | NVMe、高速 SSD、虚拟机里的虚拟盘、下层还有调度的设备 | 没有公平性和读写优先级 |
| `mq-deadline` | 按扇区排序合并，读写各有截止时间，读优先，防止饿死 | SATA/SAS 的 HDD 和 SSD、RAID 卷 | 一个全局锁，极高 IOPS 下 CPU 开销上升 |
| `bfq` | 按进程/cgroup 分配"预算"，追求公平与交互响应 | 桌面、需要按 cgroup 按比例分配带宽的场景 | CPU 开销最大，不适合高 IOPS 服务器 |
| `kyber` | 按读写延迟目标动态限制派发深度 | 快速设备上需要"读不被写拖垮"的场景 | 参数少、用得少 |

老教程里的 `noop`、`deadline`、`cfq` 是单队列时代的调度器，5.0 内核之后已经被移除，看到它们说明文档过时了。

查看和临时修改：

```console
$ cat /sys/block/nvme0n1/queue/scheduler
[none] mq-deadline
$ cat /sys/block/sda/queue/scheduler
none [mq-deadline]
$ echo bfq | sudo tee /sys/block/sda/queue/scheduler
bfq
$ cat /sys/block/sda/queue/scheduler
none mq-deadline [bfq]
```

方括号里是当前生效的调度器。列表里没有 `bfq` 或 `kyber` 时，它们可能是没加载的内核模块，`sudo modprobe bfq` 或 `sudo modprobe kyber-iosched` 之后再看。Ubuntu 的默认规则是：NVMe 用 `none`，SATA/SCSI 设备用 `mq-deadline`。

### 怎么选

我的建议很简单：

- **NVMe 保持 `none`。** 设备自己有几十上百个并行单元和多个硬件队列，内核再排序只会增加 CPU 开销和锁争用；
- **HDD 和 SATA 设备用 `mq-deadline`。** 它能把随机请求按扇区排序、合并相邻请求，并且保证读请求在 500 ms 内一定被派发，避免被大量写淹没；
- **虚拟机里的 `vda`/`sda` 通常用 `none`。** 真正的调度发生在宿主机或存储后端，客户机里再调度一次意义不大；
- **只有在确实需要按进程或 cgroup 做公平分配时才考虑 `bfq`**，并且要实测它的 CPU 开销。

`mq-deadline` 的参数在 `/sys/block/<dev>/queue/iosched/` 下：`read_expire`（默认 500 ms）、`write_expire`（默认 5000 ms）、`fifo_batch`（默认 16）、`writes_starved`（默认 2，读可以连续饿死写几轮）。绝大多数情况不需要动。

**验证方法**：调度器影响的主要是混合负载下的公平性和尾延迟，而不是单一负载的峰值。所以验证要用混合负载——比如在一块 HDD 上，一个 fio job 做大块顺序写、另一个做 4 KiB 随机读，比较不同调度器下随机读的 p99：

```bash
sudo fio --filename=/dev/sdb --direct=1 --ioengine=libaio --runtime=60 --time_based \
  --name=writer --rw=write --bs=1m --iodepth=16 \
  --name=reader --rw=randread --bs=4k --iodepth=1 --percentile_list=50:99
```

同时用 `sudo biolatency-bpfcc -Q -D 10 1` 看包含队列时间的延迟分布。只看 `writer` 的吞吐会得出错误的结论——`none` 下写吞吐可能更高，恰恰是因为读被饿着了。

## 队列参数

每个块设备在 `/sys/block/<dev>/queue/` 下有一组参数，先整体看一眼：

```console
$ grep -H . /sys/block/nvme0n1/queue/{nr_requests,read_ahead_kb,max_sectors_kb,max_hw_sectors_kb,rq_affinity,nomerges,wbt_lat_usec}
/sys/block/nvme0n1/queue/nr_requests:1023
/sys/block/nvme0n1/queue/read_ahead_kb:128
/sys/block/nvme0n1/queue/max_sectors_kb:1280
/sys/block/nvme0n1/queue/max_hw_sectors_kb:2048
/sys/block/nvme0n1/queue/rq_affinity:1
/sys/block/nvme0n1/queue/nomerges:0
/sys/block/nvme0n1/queue/wbt_lat_usec:2000
```

（具体数值取决于设备、驱动和内核版本。）

| 参数 | 含义 | 什么时候调 | 怎么验证 |
|---|---|---|---|
| `nr_requests` | 每个硬件队列可分配的请求数（软件队列深度） | 使用调度器时默认较小（如 SATA + mq-deadline 常见 64）；应用并发很高、`blktrace` 频繁出现 `S`（睡眠等待 request）时可适当调大 | `blktrace` 中 `S` 事件是否减少；`biolatency -Q` 与不带 `-Q` 的差距 |
| `read_ahead_kb` | 顺序读时预读的最大量，默认 128 KiB | 大文件顺序读、高延迟设备（云盘、网络块设备、HDD 阵列）可调大到 1～4 MiB；随机读为主、内存紧张时调大反而会污染缓存 | 清缓存后 buffered 顺序读的吞吐；`iostat` 的 `rareq-sz` |
| `max_sectors_kb` | 单个请求的最大尺寸，不能超过 `max_hw_sectors_kb` | RAID 条带很宽时可以调大到接近条带宽度；对延迟敏感、需要把大 I/O 拆小时调小 | `iostat` 的 `areq-sz`、`bitesize-bpfcc` 的分布 |
| `rq_affinity` | 完成处理在哪个 CPU 上执行：`1` 同组 CPU（默认）、`2` 强制回到提交请求的那个 CPU、`0` 不做迁移 | 中断集中在少数核、完成处理成为瓶颈时试 `2` | `mpstat -P ALL 1` 看软中断分布；fio 的 IOPS 与 `cpu` 行 |
| `nomerges` | `0` 允许所有合并（默认）、`1` 只做简单的一次性合并、`2` 完全禁止合并 | NVMe 上纯随机小 I/O 负载可以设 `2`，省去合并查找的 CPU；有顺序成分的负载不要动 | fio 的 IOPS 与 `cpu` 行；`iostat` 的 `rrqm/s` `wrqm/s` |
| `wbt_lat_usec` | 回写节流（Writeback Throttling）的目标延迟，SSD 默认 2 ms，HDD 75 ms；`0` 关闭 | 后台回写拖慢前台读时，它已经在帮你；除非测出它限制了纯写吞吐，否则别关 | 回写期间前台读的 p99 |

> [!TIP] 预读和 Little 定律
> 单线程顺序读时，预读窗口就是"在途的数据量"。套用 Little 定律：吞吐 ≈ 预读窗口 ÷ 设备延迟。一块延迟约 1 ms 的云盘，128 KiB 的预读意味着吞吐上限大约 128 MB/s；调到 4 MiB 后，吞吐会一直涨到设备或云盘规格的带宽上限。这类设备上调大 `read_ahead_kb` 的收益非常明显，NVMe 上则几乎看不到差别。`blockdev --getra /dev/vdb` 也能查看预读，但它的单位是 512 字节扇区（`256` 就是 128 KiB）。

一个实际的验证例子——在云盘上验证预读假设：

```bash
for ra in 128 1024 4096; do
  echo $ra | sudo tee /sys/block/vdb/queue/read_ahead_kb >/dev/null
  sync; echo 3 | sudo tee /proc/sys/vm/drop_caches >/dev/null
  sudo fio --name=ra-$ra --filename=/mnt/test/bigfile --rw=read --bs=64k \
    --direct=0 --ioengine=psync --size=8g | grep -E 'READ:'
done
```

注意这里必须用 `direct=0`：预读是页缓存的行为，`O_DIRECT` 绕过了它，用 direct I/O 测预读永远测不出差别。分布式文件系统（NFS、CephFS）的预读不走块设备，而是通过 `/sys/class/bdi/<设备号>/read_ahead_kb` 或挂载选项（如 CephFS 的 `rasize`）控制。

## 脏页与回写：vm.dirty_*

[页缓存](/learn/page-cache)一课讲过：写入先进页缓存成为脏页，由后台回写线程异步落盘。控制这个过程的是四个参数：

| 参数 | 默认值 | 含义 |
|---|---|---|
| `vm.dirty_background_ratio` | 10 | 脏页超过可用内存的这个百分比，后台回写线程开始工作 |
| `vm.dirty_ratio` | 20 | 脏页超过这个百分比，**写入进程自己被限流**（阻塞在 `balance_dirty_pages`） |
| `vm.dirty_expire_centisecs` | 3000 | 脏页存在超过 30 秒就必须回写 |
| `vm.dirty_writeback_centisecs` | 500 | 回写线程每 5 秒醒来一次 |

`*_ratio` 各有一个对应的 `*_bytes` 版本（`vm.dirty_bytes`、`vm.dirty_background_bytes`），用绝对字节数设定阈值。两者互斥：设置了 `_bytes`，对应的 `_ratio` 就会变成 0，反之亦然。

问题出在大内存机器上。一台 512 GB 内存的存储节点，`dirty_ratio=20` 意味着可以积累将近 100 GB 的脏页。设备每秒写 1 GB 的话，一次刷完要 100 秒：这期间任何 `fsync` 都要排在这 100 GB 后面，数据库提交从毫秒级跳到几十秒。这就是[用 BPF 看清 I/O](/learn/bpf-io-tracing)里后台回写和数据库提交抢盘的放大版。

大内存机器上我的建议是改用字节数，让回写**早开始、小批量、持续进行**：

```ini title="/etc/sysctl.d/90-storage.conf"
# 大内存存储节点：脏页阈值用绝对值，避免一次积累几十 GB
vm.dirty_background_bytes = 536870912    # 512 MiB 开始后台回写
vm.dirty_bytes = 4294967296              # 4 GiB 开始对写入进程限流
vm.swappiness = 10
```

```bash
sudo sysctl --system            # 加载 /etc/sysctl.d/ 下所有文件
sysctl vm.dirty_bytes vm.dirty_ratio
```

具体数值要按设备的写带宽定：一个经验值是让 `dirty_bytes` 大约对应设备几秒钟的写入量。

**验证方法**：一边用 `dd if=/dev/zero of=/mnt/test/big bs=1M count=20000` 持续写，一边运行：

```bash
watch -n1 "grep -E '^(Dirty|Writeback):' /proc/meminfo"     # 脏页是否被控制在阈值附近
sudo fio --name=commit --directory=/mnt/test --rw=write --bs=4k --size=64m \
  --fdatasync=1 --runtime=60 --time_based                    # 同时测同步写的 p99
```

对比调整前后：`Dirty` 的峰值、同步写的 `clat` p99、`iostat` 里写入是"一阵一阵的突发"还是"平稳的一条线"。

### swappiness

`vm.swappiness`（默认 60，5.8 内核起取值范围 0～200）控制内存回收时换出匿名内存与回收页缓存的倾向：值越低，内核越倾向于丢弃页缓存而保留进程的匿名内存。对自己管理缓存的数据库、对延迟敏感的存储服务，常见做法是设为 1～10；它**不是**"禁用交换"的开关，设为 0 也不等于没有 swap。验证看 `vmstat` 的 `si`/`so`、`/proc/vmstat` 中的 `pswpin`/`pswpout`，以及 `sar -B` 的 `majflt/s`。

元数据密集的负载（海量小文件）还可以关注 `vm.vfs_cache_pressure`（默认 100）：调低它会让内核更倾向于保留 dentry 和 inode 缓存，用 `slabtop` 观察 `dentry`、`xfs_inode`/`ext4_inode_cache` 的变化来验证。

## 文件系统：挂载选项与格式化参数

### 挂载选项

《Systems Performance》第 8 章 8.8 节提到，`noatime` 曾经是最常见的文件系统调优：避免每次读都要更新访问时间，从而产生额外的元数据写。自 2.6.30 起内核默认使用 `relatime`（只在访问时间早于修改时间、或超过一天时才更新），这个问题已经基本解决了。对于读密集且确实不需要 `atime` 的场景，`noatime` 仍能省掉一点元数据写：

```bash
findmnt -no OPTIONS /data              # 查看当前挂载选项
sudo mount -o remount,noatime /data    # 临时生效
# 永久生效：修改 /etc/fstab 对应行的选项，例如
# UUID=...  /data  xfs  defaults,noatime  0 0
```

**验证**：跑一个纯读负载（比如 `tar cf /dev/null /data/many-small-files`），对比调整前后 `iostat` 的 `w/s`——读负载下的写请求基本就是元数据更新。

其他值得了解的选项：

| 选项 | 作用 | 建议 |
|---|---|---|
| `lazytime` | 时间戳只在内存中更新，稍后批量写回 | 与 `relatime` 配合，减少元数据写 |
| `discard` | 删除文件时实时下发 TRIM | 部分 SSD 上会引起延迟抖动；优先用定期的 `fstrim`，Ubuntu 默认启用了每周运行的 `fstrim.timer` |
| ext4 `commit=N` | 日志提交间隔，默认 5 秒 | 调大减少日志写，但崩溃时可能丢失更多数据 |
| XFS `logbsize=` | 内存日志缓冲区大小，最大 256k | 元数据密集的负载可以设 `logbsize=256k` |

> [!DANGER] 不要用安全换性能
> `nobarrier`、`barrier=0`、ext4 的 `data=writeback` 这类选项确实能让写变快，代价是掉电或崩溃后文件系统损坏或数据丢失。新内核的 XFS 已经不再接受 `nobarrier`。设备真的有掉电保护时，它的刷新本来就很快（[用 BPF 看清 I/O](/learn/bpf-io-tracing)里 `biolatency -F` 能看到），不需要这些选项。

### 格式化参数：与 RAID 条带对齐

格式化时最重要的参数是条带对齐：让文件系统的分配单元和 RAID 的条带对齐，避免一次写跨两个条带、触发额外的读-改-写（参见[RAID](/learn/raid)）。

以一个 RAID 6 为例：6 块盘（4 块数据盘 + 2 块校验盘），条带单元（chunk）64 KiB。

```bash
# XFS：su = 条带单元，sw = 数据盘数
sudo mkfs.xfs -d su=64k,sw=4 /dev/sdb
xfs_info /data | grep -E 'sunit|swidth'       # 验证：sunit=16 swidth=64 blks（单位 4 KiB 块）

# ext4：stride = chunk / 块大小 = 64K / 4K = 16；stripe_width = stride × 数据盘数 = 64
sudo mkfs.ext4 -E stride=16,stripe_width=64 /dev/sdb
sudo dumpe2fs -h /dev/sdb | grep -iE 'stride|stripe'
```

在 Linux 软 RAID（md）和 LVM 上，`mkfs.xfs` 通常能自动探测几何信息；硬件 RAID 卡往往不会把条带信息报告给操作系统，必须手动指定。格式化参数改错了只能重新格式化，这是少数必须**在上线前**做对的调优。

## NVMe 中断与 NUMA 亲和

在双路服务器上，每块 NVMe 都挂在某一颗 CPU 的 PCIe 根端口下。从另一颗 CPU 上的进程访问它，每次 DMA 和中断都要跨 CPU 互联，既增加延迟，也消耗跨路带宽。先找出设备属于哪个 NUMA 节点：

```console
$ cat /sys/class/nvme/nvme0/device/numa_node
1
$ lscpu | grep NUMA
NUMA node(s):                         2
NUMA node0 CPU(s):                    0-31,64-95
NUMA node1 CPU(s):                    32-63,96-127
```

NVMe 驱动为每个 CPU（或每组 CPU）建一个硬件队列，每个队列有自己的中断：

```console
$ grep -H . /sys/block/nvme0n1/mq/{0,1,2}/cpu_list
/sys/block/nvme0n1/mq/0/cpu_list:0, 64
/sys/block/nvme0n1/mq/1/cpu_list:1, 65
/sys/block/nvme0n1/mq/2/cpu_list:2, 66
$ grep -E 'nvme0q[0-3]$' /proc/interrupts      # 截取前 4 个 CPU 列
 134:          0          0          0          0  IR-PCI-MSIX-0000:c1:00.0    0-edge      nvme0q0
 135:    1820345          0          0          0  IR-PCI-MSIX-0000:c1:00.0    1-edge      nvme0q1
 136:          0    1790221          0          0  IR-PCI-MSIX-0000:c1:00.0    2-edge      nvme0q2
 137:          0          0    1802210          0  IR-PCI-MSIX-0000:c1:00.0    3-edge      nvme0q3
```

`nvme0q0` 是管理队列，其余是 I/O 队列，每个队列的中断只落在对应的 CPU 上。这些是内核管理的中断（Managed IRQ），亲和性由内核按 CPU 拓扑自动分配，`irqbalance` 不会移动它们，手动写 `/proc/irq/<N>/smp_affinity` 也会被拒绝（返回 I/O 错误）。

所以 NVMe 的 NUMA 调优**不是去改中断，而是把使用这块盘的进程放到正确的节点上**：

```bash
# 用 numactl 把进程绑到 NVMe 所在的 node 1（CPU 和内存都绑）
sudo numactl --cpunodebind=1 --membind=1 fio --name=local --filename=/dev/nvme0n1 \
  --readonly --direct=1 --ioengine=io_uring --rw=randread --bs=4k --iodepth=1 --runtime=30 --time_based

# fio 自身也支持 NUMA 绑定
sudo fio --name=remote --numa_cpu_nodes=0 --numa_mem_policy=bind:0 --filename=/dev/nvme0n1 \
  --readonly --direct=1 --ioengine=io_uring --rw=randread --bs=4k --iodepth=1 --runtime=30 --time_based
```

**验证**：比较两次测试 QD1 下的 `clat` 均值和 p99，以及高 QD 下的最大 IOPS 和 `cpu` 行。跨节点的差距在 QD1 延迟上通常只有几微秒，但在打满多块 NVMe 的高吞吐场景下，跨路互联可能成为整机的瓶颈。对服务进程，用 systemd 的 `NUMAPolicy=`、`CPUAffinity=` 或容器编排的拓扑管理做持久化绑定。同样的道理也适用于网络存储的网卡——网卡、NVMe 和处理进程最好在同一个 NUMA 节点上，这在 [RDMA](/learn/rdma) 一课里还会遇到。

## 持久化：udev、sysctl 与 tuned

`echo` 到 sysfs 的改动重启就没了。三种持久化手段各有分工。

### udev 规则：块设备参数

设备出现（包括热插拔和重启）时由 udev 设置参数，这是持久化 sysfs 队列参数最标准的方式：

```text title="/etc/udev/rules.d/60-io-tuning.rules"
# NVMe：不使用调度器；纯随机负载的节点可以关闭合并
ACTION=="add|change", KERNEL=="nvme[0-9]*n[0-9]*", ENV{DEVTYPE}=="disk", ATTR{queue/scheduler}="none"

# 机械盘：mq-deadline + 较大的预读
ACTION=="add|change", KERNEL=="sd[a-z]*", ENV{DEVTYPE}=="disk", ATTR{queue/rotational}=="1", ATTR{queue/scheduler}="mq-deadline", ATTR{queue/read_ahead_kb}="4096"

# SATA/SAS SSD：mq-deadline
ACTION=="add|change", KERNEL=="sd[a-z]*", ENV{DEVTYPE}=="disk", ATTR{queue/rotational}=="0", ATTR{queue/scheduler}="mq-deadline"
```

`ENV{DEVTYPE}=="disk"` 用来排除分区（分区没有 `queue/` 目录）。不重启就让规则生效，并验证：

```bash
sudo udevadm control --reload
sudo udevadm trigger --subsystem-match=block --action=change
grep -H . /sys/block/*/queue/scheduler
udevadm test /sys/block/sda 2>&1 | grep -i scheduler     # 调试：看规则是否匹配
```

### sysctl.d：内核参数

前面的 `/etc/sysctl.d/90-storage.conf` 就是持久化的方式，文件按名字顺序加载，数字大的后加载、会覆盖前面的设置。用 `sudo sysctl --system` 立即加载，用 `sysctl -a | grep dirty` 确认。

### tuned：成套的配置档

tuned 把磁盘、sysctl、CPU 等设置打包成一个"配置档（profile）"，可以一条命令切换，并能校验当前系统是否符合配置。Ubuntu 24.04 上需要单独安装：

```bash
sudo apt install -y tuned
tuned-adm list                         # 内置的 throughput-performance、latency-performance 等
sudo mkdir -p /etc/tuned/storage-node
```

```ini title="/etc/tuned/storage-node/tuned.conf"
[main]
summary=Storage node: based on throughput-performance
include=throughput-performance

[disk]
# 对所有磁盘生效；readahead 前的 > 表示只在当前值更小时才调大
elevator=none
readahead=>4096

[sysctl]
# throughput-performance 会把 vm.dirty_ratio 调到 40，这里覆盖掉
vm.dirty_background_bytes=536870912
vm.dirty_bytes=4294967296
vm.swappiness=10
```

```bash
sudo tuned-adm profile storage-node
tuned-adm active                       # Current active profile: storage-node
sudo tuned-adm verify                  # 检查当前系统设置是否与配置档一致
```

> [!WARNING] 只保留一个"真相来源"
> tuned 的 `[disk]` 和 udev 规则都能设调度器和预读，同时使用时谁后执行谁生效，排查时会非常困惑；而 `include` 进来的父配置档还会悄悄改掉你没注意的参数（比如上面的 `dirty_ratio`）。选定一种机制管理某一类参数，并在快照脚本里定期核对。

## 每一项怎么验证

把本课的内容汇总成一张表，这是调优时的核对清单：

| 调整项 | 验证负载 | 看什么 |
|---|---|---|
| I/O 调度器 | 混合负载：大块顺序写 + 4K 随机读 | 读的 p99（fio）、`biolatency -Q`；以及调度器的 CPU 开销 |
| `nr_requests` | 高并发随机读写 | `blktrace` 的 `S` 事件、`biolatency -Q` 与设备延迟的差距 |
| `read_ahead_kb` | 清缓存后 buffered 顺序读（`direct=0`） | 吞吐、`iostat` 的 `rareq-sz`、`cachestat` 命中率 |
| `max_sectors_kb` | 大块顺序读写 | `iostat` 的 `areq-sz`、`bitesize` 分布、吞吐 |
| `nomerges` / `rq_affinity` | 高 IOPS 随机小 I/O | fio 的 IOPS 与 `cpu` 行、`mpstat` 各核软中断 |
| `vm.dirty_*` | 持续大写入 + 同步写探针 | `Dirty` 峰值、同步写 p99、`iostat` 写入是否平稳 |
| `swappiness` | 内存压力下的真实业务 | `si`/`so`、`majflt/s`、业务延迟 |
| `noatime` | 纯读负载 | `iostat` 的 `w/s` |
| 条带对齐 | 小块随机写 | RAID 卡/md 的读-改-写次数、写 IOPS |
| NUMA 绑定 | QD1 延迟与高 QD 峰值 | `clat` 均值与 p99、IOPS、跨路带宽 |

> [!QUEST] 闯关：一份像样的调优报告
> 从上表中挑一项，按本课开头的闭环做完整个实验：写下假设和预期，保存变更前快照，每种配置用同样的负载各跑 3 次，报告均值 ± 标准差和 p99，最后给出"保留"或"回滚"的结论。报告格式参考[基准测试](/learn/benchmarking)的模板。如果结果是"没有显著差别"，这同样是一个有价值的结论——它说明默认值已经够用了。

## 动手练习

1. **拍快照。** 运行 `io-snapshot.sh`，找出你的实验机上每块盘的调度器、`nr_requests`、`read_ahead_kb`、`max_sectors_kb`，并解释为什么 NVMe 和 SATA 盘的默认值不同。
2. **调度器对比。** 在一块 HDD 或 SATA SSD 测试盘上，用本课的混合负载命令分别测试 `none`、`mq-deadline`、`bfq` 三种调度器，记录读 job 的 p99 和写 job 的吞吐，并用 `mpstat` 观察 CPU 开销的差异。
3. **验证预读假设。** 在测试文件系统上建一个 8 GiB 的文件，按本课的循环脚本测试 `read_ahead_kb` 为 128、1024、4096 时的 buffered 顺序读吞吐；再把 `--direct=0` 改成 `--direct=1` 重做一次，解释为什么差别消失了。
4. **观察脏页阈值。** 先记录默认设置下 `dd` 持续写入时 `Dirty` 的峰值和同步写 p99，再把 `vm.dirty_background_bytes` 设为 256 MiB、`vm.dirty_bytes` 设为 1 GiB 重做，比较两次的结果。做完用 `sudo sysctl --system` 恢复。
5. **写一条 udev 规则。** 为你的测试盘写一条规则，把调度器设为 `mq-deadline`、预读设为 1024 KiB，执行 `udevadm trigger` 使其生效并验证；然后重启机器，确认设置依然存在。

## 自测

<details>
<summary>为什么 NVMe 通常使用 `none` 调度器，而 HDD 通常使用 `mq-deadline`？</summary>

NVMe 内部有大量并行单元和多个硬件队列，请求的顺序对它影响很小，内核排序只会增加 CPU 开销和锁争用，所以直接下发（`none`）最好。HDD 的随机访问要付出寻道和旋转的代价，`mq-deadline` 能按扇区排序、合并相邻请求，并用截止时间保证读请求不会被大量写饿死，改善混合负载下的延迟。

</details>

<details>
<summary>把 `read_ahead_kb` 调大后用 fio `--direct=1` 测试，发现顺序读吞吐毫无变化，说明预读调整无效吗？</summary>

不说明。预读是页缓存的机制，`O_DIRECT` 绕过了页缓存，根本不会触发预读，所以 direct I/O 测不出预读的效果。应该用 `--direct=0` 的 buffered 顺序读，并在每次测试前清空页缓存。另外预读对高延迟设备（云盘、网络块设备、HDD 阵列）效果明显，在低延迟的 NVMe 上差别本来就很小。

</details>

<details>
<summary>一台 1 TB 内存的节点上，数据库每隔几十秒出现一次长达十几秒的提交卡顿，同时 `/proc/meminfo` 中 `Dirty` 周期性涨到上百 GB。原因可能是什么？怎么调？</summary>

默认 `vm.dirty_ratio=20`、`dirty_background_ratio=10` 按可用内存的百分比计算，在 1 TB 内存上允许积累上百 GB 脏页，回写时大量写请求占满设备，数据库的 `fsync` 只能排队等待，造成提交卡顿。应改用 `vm.dirty_background_bytes` 和 `vm.dirty_bytes` 设定较小的绝对阈值（例如几百 MiB 和几 GiB），让回写更早开始、更平稳；然后用 `Dirty` 峰值、同步写 p99 和 `iostat` 的写入曲线验证效果。

</details>

<details>
<summary>为什么写 `/proc/irq/<N>/smp_affinity` 无法修改 NVMe I/O 队列中断的亲和性？NVMe 的 NUMA 优化应该怎么做？</summary>

NVMe 驱动使用内核管理的中断（Managed IRQ），每个 I/O 队列与一组 CPU 绑定，亲和性由内核按 CPU 拓扑自动分配，不允许用户修改，`irqbalance` 也不会移动它们。优化方法是反过来：查出设备所在的 NUMA 节点（`/sys/class/nvme/nvmeX/device/numa_node`），用 `numactl`、systemd 的 CPU/NUMA 设置或 fio 的 `numa_cpu_nodes` 把使用该设备的进程和内存绑到同一节点上，并用延迟和 IOPS 对比验证。

</details>

<details>
<summary>在自定义 tuned 配置档中 `include=throughput-performance`，却发现 `vm.dirty_ratio` 变成了 40，这是为什么？如何避免这类问题？</summary>

`throughput-performance` 配置档本身会修改一些 sysctl，包括把 `vm.dirty_ratio` 调大到 40，`include` 会继承这些设置。应在自己的配置档 `[sysctl]` 中显式覆盖需要的值（例如设置 `vm.dirty_bytes`），用 `tuned-adm verify` 和配置快照核对实际生效的值，并且对同一类参数只用一种机制（tuned 或 udev/sysctl.d）管理，避免互相覆盖。

</details>

## 参考资料

- [Brendan Gregg：Systems Performance, 2nd Edition](https://www.brendangregg.com/systems-performance-2nd-edition-book.html)（第 8 章 8.8 调优、第 9 章 9.4 调度器与 9.9 调优）
- [Linux 内核文档：Queue sysfs files](https://docs.kernel.org/block/queue-sysfs.html)
- [Linux 内核文档：Deadline IO scheduler tunables](https://docs.kernel.org/block/deadline-iosched.html)
- [Linux 内核文档：BFQ (Budget Fair Queueing)](https://docs.kernel.org/block/bfq-iosched.html)
- [Linux 内核文档：Kyber I/O scheduler tunables](https://docs.kernel.org/block/kyber-iosched.html)
- [Linux 内核文档：/proc/sys/vm](https://docs.kernel.org/admin-guide/sysctl/vm.html)
- [Linux 内核文档：XFS](https://docs.kernel.org/admin-guide/xfs.html) / [ext4](https://docs.kernel.org/admin-guide/ext4.html)
- [tuned 项目](https://github.com/redhat-performance/tuned)
- [udev(7) man page](https://manpages.ubuntu.com/manpages/noble/man7/udev.7.html)
- [numactl(8) man page](https://manpages.ubuntu.com/manpages/noble/man8/numactl.8.html)
