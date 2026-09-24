# 基准测试：fio 与 elbencho

"新买的 NVMe 我测过了，fio 跑出 3 GB/s 随机读，比规格书还快！"——恭喜，你测到的是页缓存。基准测试是存储工作里最容易上手、也最容易出错的事情：命令一行就能敲完，数字一分钟就能出来，但这个数字测的是不是你以为的东西、换一天能不能复现、和生产负载有没有关系，没人替你保证。Brendan Gregg 在书里说得很直白：花不到一周研究的基准测试结果，大概率是错的。

这一课先讲基准测试最常见的失败方式和存储特有的坑（测到缓存、没预热、SSD 没进稳态、跑得太短、工具本身成了瓶颈），再讲贯穿全课的**主动基准测试**思想；然后把 fio 的关键参数、job 文件、输出逐行拆开讲透；接着用 elbencho 做文件系统和多客户端的分布式测试；最后给一份可以直接套用的测试报告模板。学完你能：设计一组有意义的存储基准测试；读懂 fio 输出的每一行并用 Little 定律验算；在测试进行时找出"到底是谁在限速"；写出一份别人能复现、能信任的测试报告。本课主要取材于《Systems Performance》第 12 章。

## 基准测试是怎么失败的

《Systems Performance》第 12 章 12.1.3 节列了一长串失败方式，这里挑出存储测试里最常踩的几个，用我自己的话讲：

| 失败方式 | 典型表现 |
|---|---|
| 随手测（Casual Benchmarking） | 你以为在测 A，实际测的是 B，得出了关于 C 的结论——测"磁盘"却测了页缓存，然后得出"这款盘很快" |
| 盲目相信（Blind Faith） | 结果和预期相符就不再追问；厂商给的数字直接写进方案 |
| 只有数字没有分析 | 一张表格几十个数字，说不出每个数字的瓶颈在哪 |
| 测到了测试工具 | 单线程工具 CPU 打满了，测出的是工具的上限，不是存储的上限 |
| 忽略错误 | 一半请求返回错误，错误路径很快，IOPS 反而"变高了" |
| 忽略方差 | 只跑一次、只报平均值，两次测试差 20% 却当成"A 比 B 快 20%" |
| 一次改多个变量 | 同时换了盘、内核和文件系统，测出的差异无法归因 |
| 基准悖论（Benchmark Paradox） | 客户要求你在三个测试上都赢；如果每个测试胜负五五开，全赢的概率只有 12.5% |

书里有个"忽略错误"的故事很典型：一次对比测试中，一方的结果好得离谱，后来发现防火墙拦掉了大部分请求，客户端收到的是飞快返回的错误。存储测试里的对应版本是：fio 的 `err=` 不为 0、elbencho 报了 I/O 错误，或者 NFS 客户端在疯狂重试，你却只看了最后那行吞吐。

### 存储测试特有的五个坑

**坑一：测到了缓存。** 不加 `direct=1`，读的数据可能全在页缓存里，你测的是内存带宽。加了 `direct=1` 也未必安全：RAID 卡的写缓存、SSD 内部的 DRAM 和 SLC 缓存、分布式存储客户端的缓存、甚至 NFS 服务端的页缓存，都可能让结果好看。经验做法是：**测试数据量远大于路径上所有缓存的总和**，并且知道每一层缓存有多大。

**坑二：读了从没写过的块。** 对一块刚做过安全擦除（或 TRIM）的 SSD 做随机读，控制器发现请求的 LBA 没有映射，直接返回全零，根本不碰 NAND。云盘和精简置备（Thin Provisioning）的卷也一样。**读测试之前，先把测试区域完整写一遍。**

**坑三：SSD 没进入稳态。** 新盘或刚擦除的盘处于"出厂状态（FOB, Fresh-Out-of-Box）"，有大量空闲块，写入不需要垃圾回收，写 IOPS 可能是稳态时的几倍。持续随机写一段时间后，垃圾回收开始和前台写争抢资源，性能掉到一个更低的平台——这才是生产上长期看到的数字。SNIA 的 SSD 性能测试规范（PTS）专门定义了预处理和稳态判定的流程，后面会用 fio 实现一个简化版。

**坑四：跑得太短。** 30 秒的写测试可能刚好落在 SLC 缓存和脏页缓冲里；一次运行没有方差信息。书里的建议是：每次测试至少覆盖足够长的时间让扰动显现，重复多次，报告标准差。存储上我的底线是：读测试 60 秒起、写测试在稳态后跑 5 分钟以上、每组重复 3 次。

**坑五：工具本身成了瓶颈。** 一个 fio 进程能驱动的 IOPS 受单核 CPU 限制；一台 elbencho 客户端的吞吐受它的网卡限制。测一套能跑 2000 万 IOPS 的全闪集群，你需要足够多的客户端和进程，否则测出的是客户端的上限。

> [!WARNING] 先做合理性检查
> 书中 12.3.8 节的例子：有人报告 NFS 服务器跑出了 5 万 IOPS、每次 8 KB，可这台服务器只有一个 1 GbE 网口。5 万 × 8 KB = 400 MB/s，而 1 GbE 最多约 120 MB/s——这个结果在物理上不可能，测到的一定是客户端缓存。拿到任何数字，先用 `吞吐 = IOPS × 块大小` 和链路带宽上限算一遍。

## 主动基准测试

**被动基准测试（Passive Benchmarking）**是"启动工具，去喝杯咖啡，回来抄数字"。**主动基准测试（Active Benchmarking）**是《Systems Performance》第 12 章最核心的方法：**测试运行的同时，用观测工具分析它**，直到你能回答"是什么在限制这个结果"。

书里举的例子是 bonnie++：它有一项"Per Chr"测试，号称测磁盘的逐字节写性能。作者在它运行时开着 `iostat`，发现**没有任何磁盘 I/O**；用 bpftrace 数块层事件，只有"缓冲区被弄脏"，没有请求下发；`cachestat` 显示全是写入页缓存的脏页；VFS 层则是海量的 1 字节 `vfs_write()`。再加上 bonnie++ 自己报告这项测试 CPU 占用 99%——它测的是单线程的 CPU 和页缓存。结论不是"这块盘逐字节写很慢"，而是"这个测试根本没测到盘"。

在存储测试中，主动基准测试就是在 fio 跑的时候多开几个终端：

```bash
iostat -xz 1                    # 请求真的到达设备了吗？IOPS、块大小、aqu-sz 与 fio 设定一致吗？
mpstat -P ALL 1                 # 有没有某个核被打满（fio 进程或中断处理）？
pidstat -u -t -p $(pgrep -d, fio) 1   # fio 各线程的 CPU 占用
sudo biolatency-bpfcc -D 10 1   # 设备层的延迟分布，和 fio 报告的对得上吗？
```

然后用书里的基准测试检查清单（12.3.10 节）逐条问自己：

| 问题 | 实际在问什么 |
|---|---|
| 为什么不是翻倍？ | 限制因素是什么？如果限制因素不是你想测的对象，这个测试就测错了 |
| 突破物理极限了吗？ | 合理性检查：超过设备、链路、网卡的上限了吗？ |
| 出错了吗？ | 错误路径的性能和正常路径不同 |
| 能复现吗？ | 多次运行的一致性如何？标准差多大？ |
| 重要吗？ | 这个负载和生产负载有关系吗？ |
| 真的发生了吗？ | 请求真的到了设备上吗？（`iostat` 有没有看到） |

"为什么不是翻倍"是最有用的一问。fio 报告 40 万 IOPS，那为什么不是 80 万？可能的答案有：设备本身到顶了（`await` 随 QD 上升）、fio 进程 CPU 满了、中断集中在一个核上、PCIe 链路降速了。只有回答了这个问题，你才知道这个数字属于谁。

## fio 入门

fio（Flexible I/O Tester）是 Jens Axboe（Linux 块层维护者）写的 I/O 负载生成器，是存储测试的事实标准。截至本文写作时 Ubuntu 24.04 自带 fio 3.36：

```bash
sudo apt install -y fio
fio --version
fio --enghelp            # 列出本机可用的 I/O 引擎
```

> [!DANGER] 写测试会毁掉数据
> 对裸设备（`--filename=/dev/xxx`）做任何写测试都会覆盖整块盘，包括分区表和文件系统。执行前用 `lsblk` 确认设备名，永远不要对系统盘或有数据的盘做写测试。本课示例中只读的测试都带 `--readonly` 作为保险。

### 关键参数

| 参数 | 作用 | 要点 |
|---|---|---|
| `ioengine` | I/O 引擎 | `libaio`（Linux 原生异步 I/O）或 `io_uring`（5.1+ 内核，开销更低）；`psync` 是同步 `pread/pwrite`，`iodepth` 对它无效 |
| `direct` | `1` 表示用 `O_DIRECT` 绕过页缓存 | 测设备必须加。**`libaio` 在非 direct 模式下会退化为同步**，`iodepth` 形同虚设 |
| `bs` | 块大小 | `4k` 测 IOPS，`128k`～`1m` 测带宽；`bssplit=4k/50:64k/50` 可以混合 |
| `rw` | 访问模式 | `read` `write` `randread` `randwrite` `rw` `randrw`；混合时配合 `rwmixread=70` |
| `iodepth` | 每个 job 的在途 I/O 数 | 总并发 = `numjobs × iodepth` |
| `numjobs` | 并发 job（进程）数 | 单个 job 被 CPU 限制时加 job，而不是一味加 `iodepth` |
| `size` | 每个 job 的 I/O 范围 | 对设备默认是整盘；设小了只会反复读写开头一小段，容易命中 SSD 内部缓存 |
| `runtime` | 最长运行时间 | 配合 `time_based` 使用 |
| `time_based` | 按时间跑满 `runtime` | 不加时，`size` 读写完就结束，可能只跑了几秒 |
| `ramp_time` | 预热时间，不计入统计 | 让缓存、队列进入稳定状态再开始计数 |
| `group_reporting` | 把同组的所有 job 汇总成一份报告 | 不加时每个 job 单独输出一份，4 个 job 就是 4 份 |
| `filename` / `directory` | 测试目标：设备或文件 / 目录 | 多个设备用冒号分隔：`/dev/nvme0n1:/dev/nvme1n1` |
| `randrepeat` / `norandommap` | 随机序列是否可重复 / 是否保证覆盖每个块 | 大盘上 `norandommap` 能减少 fio 自身的 CPU 开销 |
| `output-format` | `normal` / `json` / `json+` | 需要脚本处理时用 `json`，`json+` 还带完整延迟直方图 |

### 命令行与 job 文件

简单测试用命令行，但一组正式测试应该写成 job 文件——它就是测试的"源代码"，可以版本管理、附在报告里、让别人一字不差地复现：

```ini title="nvme-baseline.fio"
; NVMe 基线测试：只读，可安全地在有数据的盘上运行
[global]
filename=/dev/nvme0n1
readonly
direct=1
ioengine=libaio
time_based
runtime=60
ramp_time=10
group_reporting
percentile_list=50:90:99:99.9:99.99

; 1. 延迟：单并发，看最好情况下的单次延迟
[lat-qd1]
rw=randread
bs=4k
iodepth=1
numjobs=1

; 2. IOPS：高并发 4K 随机读
[iops-randread]
stonewall
rw=randread
bs=4k
iodepth=32
numjobs=4

; 3. 带宽：1M 顺序读
[bw-seqread]
stonewall
rw=read
bs=1m
iodepth=16
numjobs=1
```

`[global]` 里的参数对所有 job 生效，每个 `[section]` 是一个 job。`stonewall` 表示"等前面的 job 全部结束再开始"，否则所有 job 会同时跑、互相干扰。运行：

```bash
sudo fio nvme-baseline.fio --output=nvme-baseline-$(date +%F).txt
sudo fio nvme-baseline.fio --section=iops-randread     # 只跑其中一个
```

### 逐行读懂 fio 输出

下面是 `iops-randread` 这一项的完整输出（一块 PCIe 4.0 企业级 NVMe）：

```console
iops-randread: (g=1): rw=randread, bs=(R) 4096B-4096B, (W) 4096B-4096B, (T) 4096B-4096B, ioengine=libaio, iodepth=32
...
fio-3.36
iops-randread: (groupid=1, jobs=4): err= 0: pid=12345: Thu Sep 24 14:20:31 2026
  read: IOPS=398k, BW=1555MiB/s (1631MB/s)(91.1GiB/60001msec)
    slat (nsec): min=1150, max=412k, avg=2540.12, stdev=1201.33
    clat (usec): min=18, max=5210, avg=318.55, stdev=120.44
     lat (usec): min=21, max=5213, avg=321.20, stdev=120.51
    clat percentiles (usec):
     |  1.00th=[  119],  5.00th=[  157], 10.00th=[  186], 20.00th=[  229],
     | 30.00th=[  262], 40.00th=[  289], 50.00th=[  310], 60.00th=[  334],
     | 70.00th=[  363], 80.00th=[  400], 90.00th=[  469], 95.00th=[  537],
     | 99.00th=[  652], 99.50th=[  725], 99.90th=[ 1045], 99.95th=[ 1319],
     | 99.99th=[ 2442]
   bw (  MiB/s): min= 1480, max= 1602, per=100.00%, avg=1556.20, stdev= 5.12, samples=476
   iops        : min=378912, max=410200, avg=398387.00, stdev=1310.55, samples=476
  lat (usec)   : 20=0.01%, 50=0.05%, 100=0.52%, 250=25.80%, 500=66.40%
  lat (usec)   : 750=6.80%, 1000=0.30%
  lat (msec)   : 2=0.10%, 4=0.01%, 10=0.01%
  cpu          : usr=12.50%, sys=38.20%, ctx=1520345, majf=0, minf=180
  IO depths    : 1=0.1%, 2=0.1%, 4=0.1%, 8=0.1%, 16=0.1%, 32=100.0%, >=64=0.0%
     submit    : 0=0.0%, 4=100.0%, 8=0.0%, 16=0.0%, 32=0.0%, 64=0.0%, >=64=0.0%
     complete  : 0=0.0%, 4=100.0%, 8=0.1%, 16=0.0%, 32=0.0%, 64=0.0%, >=64=0.0%
     issued rwts: total=23897000,0,0,0 short=0,0,0,0 dropped=0,0,0,0
     latency   : target=0, window=0, percentile=100.00%, depth=32

Run status group 1 (all jobs):
   READ: bw=1555MiB/s (1631MB/s), 1555MiB/s-1555MiB/s (1631MB/s-1631MB/s), io=91.1GiB (97.8GB), run=60001-60001msec

Disk stats (read/write):
  nvme0n1: ios=23880000/0, sectors=191040000/0, merge=0/0, ticks=7560000/0, in_queue=7560000, util=99.90%
```

逐行看：

| 行 | 含义与读法 |
|---|---|
| `err= 0` | **第一眼先看这里**。不为 0 说明有 I/O 出错，后面的数字都要打问号 |
| `read: IOPS= BW=` | 汇总的 IOPS 和带宽，括号里分别是 1024 进制和 1000 进制，最后是总数据量和实际运行时长 |
| `slat` | 提交延迟（Submission Latency）：fio 把 I/O 交给内核所花的时间。几微秒是正常的，很大说明提交路径有问题（比如 CPU 争用） |
| `clat` | 完成延迟（Completion Latency）：从提交到完成，基本就是设备和块层的时间 |
| `lat` | 总延迟 = `slat + clat`，应用视角的延迟 |
| `clat percentiles` | 完成延迟的百分位，**最有价值的部分**。这里 p50 = 310 µs、p99 = 652 µs、p99.99 = 2.4 ms |
| `bw` / `iops` 行 | 按采样周期（默认 500 ms）统计的带宽/IOPS 分布。`stdev` 很大说明性能在波动，要查原因 |
| `lat (usec/msec)` | 延迟分桶的占比：`500=66.40%` 表示 66.4% 的请求落在 250～500 µs |
| `cpu` | 每个 job 的平均 CPU 占用（相对一个核）。`usr + sys` 接近 100% 说明 **fio 自己成了瓶颈** |
| `IO depths` | 实际达到的队列深度分布。`32=100.0%` 说明并发确实维持在设定值 |
| `issued rwts` | 读/写/trim/sync 各发出多少请求；`short`、`dropped` 应该为 0 |
| `Run status group` | 整组汇总，多组测试时方便对比 |
| `Disk stats` | 测试期间从 `/proc/diskstats` 取的设备统计；`util` 就是 `iostat` 的 `%util` |

验算一下：

- Little 定律：4 × 32 = 128 个在途请求，128 ÷ 321.2 µs ≈ 398k IOPS，与报告吻合，说明并发真的达到了设定值；
- 带宽公式：398k × 4 KiB ≈ 1555 MiB/s，吻合；
- `Disk stats` 的 `ios` 与 `issued` 基本一致、`sectors` = `ios × 8`：请求真的以 4 KiB 到达了设备，没有被缓存吸收或拆分；
- `cpu` 每个 job 约 51% 的核，fio 不是瓶颈。

这台设备 p99 只有 p50 的约 2 倍，但 p99.99 达到了 2.4 ms、max 5.2 ms——如果业务对尾延迟敏感，这就是要进一步用 `biosnoop` 追查的地方（见[用 BPF 看清 I/O](/learn/bpf-io-tracing)）。

> [!TIP] `ramp_time` 与 `util`
> 上面的 `Disk stats` 包含了 `ramp_time` 那 10 秒的 I/O，所以数字会比 `issued` 略有出入。另外记住 `util=99.90%` 对 NVMe 没有"满载"的意思，这点在[磁盘 I/O 观测](/learn/disk-observability)里讲过。

### 一组最小测试矩阵

不同的问题需要不同的测试，一个 IOPS 数字回答不了所有问题：

| 测试 | 参数 | 回答的问题 |
|---|---|---|
| 4K 随机读 QD1 | `rw=randread bs=4k iodepth=1 numjobs=1` | 最好情况下的单次读延迟 |
| 4K 随机读高 QD | `rw=randread bs=4k iodepth=32 numjobs=4` | 读 IOPS 上限 |
| 4K 随机写（稳态） | `rw=randwrite bs=4k iodepth=32 numjobs=4` | 写 IOPS 上限，必须先预处理 |
| 1M 顺序读/写 | `rw=read/write bs=1m iodepth=16` | 带宽上限 |
| 70/30 混合 | `rw=randrw rwmixread=70 bs=8k iodepth=16 numjobs=4` | 接近数据库的混合负载 |
| 同步写 | `rw=write bs=4k iodepth=1 fdatasync=1` | 每次提交都落盘的延迟，etcd、数据库 WAL 最关心 |

最后一项值得单独说：etcd 官方推荐用类似 `fio --rw=write --ioengine=sync --fdatasync=1 --bs=2300` 的方式测盘，看的是 `fsync/fdatasync` 的 p99。消费级 SSD 在这个测试里可能只有几百次每秒，而它的 4K 随机写 IOPS 标称几十万——两个数字测的根本不是一回事。

### 扫 QD 找拐点

书中 12.3.7 节的**逐步加压（Ramping Load）**方法：一点点增加负载，记录吞吐和延迟，画出扩展曲线。对存储来说就是扫 QD：

```bash title="qd-sweep.sh"
#!/usr/bin/env bash
# 扫描队列深度，输出 QD、IOPS、平均延迟、p99（单位 µs）
DEV=${1:?usage: $0 /dev/xxx}
echo "qd,iops,lat_avg_us,p99_us"
for qd in 1 2 4 8 16 32 64 128 256; do
  sudo fio --name=sweep --filename="$DEV" --readonly --direct=1 --ioengine=io_uring \
    --rw=randread --bs=4k --iodepth=$qd --numjobs=1 --runtime=30 --ramp_time=5 \
    --time_based --output-format=json |
  jq -r --arg qd "$qd" '.jobs[0].read |
    [$qd, (.iops|floor), (.lat_ns.mean/1000|floor), (.clat_ns.percentile."99.000000"/1000|floor)] | @csv'
done
```

把输出画成 IOPS-QD 和 p99-QD 两条曲线，拐点左侧是你能给业务承诺的区间（参见[性能指标](/learn/perf-metrics)里的曲线示意）。如果单个 job 的 IOPS 在某个 QD 后平了，但 `cpu` 已经接近 100%，那是 fio 到顶了，把 `numjobs` 加到 2、4 再看。

## SSD 预处理与稳态

测 SSD 写性能，必须先让它进入稳态。一个简化的流程（参考 SNIA PTS 的思路）：

```bash
DEV=/dev/nvme1n1        # 再确认一遍：这块盘上的数据会全部丢失

# 1. 回到出厂状态（可选）：整盘 TRIM
sudo blkdiscard $DEV

# 2. 顺序写满两遍，让每个 LBA 都有映射
sudo fio --name=prefill --filename=$DEV --direct=1 --ioengine=libaio \
  --rw=write --bs=128k --iodepth=32 --loops=2

# 3. 用目标负载持续随机写，直到 IOPS 稳定（fio 自带稳态检测）
sudo fio --name=ss-randwrite --filename=$DEV --direct=1 --ioengine=libaio \
  --rw=randwrite --bs=4k --iodepth=32 --numjobs=4 --group_reporting \
  --time_based --runtime=4h \
  --steadystate=iops_slope:0.3% --steadystate_duration=30m --steadystate_ramp_time=10m
```

`--steadystate=iops_slope:0.3%` 的意思是：在 30 分钟的滑动窗口内，IOPS 的线性拟合斜率小于均值的 0.3% 就判定为稳态并提前结束。输出里会有 `steadystate` 一段告诉你是否达到。进入稳态后再跑正式的写测试，结果才有意义。

> [!NOTE] 写 IOPS 从高到低的一条曲线
> 如果你把第 3 步的 IOPS 每分钟记一次画出来，会看到一条典型曲线：开始很高（空闲块多），几分钟到几十分钟内快速下降，然后在一个低得多的水平上稳定下来。规格书上的"随机写 IOPS"通常是稳态值，但各家定义不同；自己的测试一定要说清楚是 FOB 还是稳态。

## elbencho：文件系统与多客户端测试

fio 擅长单机、单设备的块级测试。到了分布式文件系统（GPFS、CephFS、Lustre、NFS 集群），你需要从很多台客户端同时施压，还要统一启停、汇总结果。**elbencho** 是 Sven Breuner（BeeGFS 的作者之一）写的分布式存储基准工具，同一个工具覆盖块设备、大文件、小文件、S3 和 GPU 直读，自带分布式模式。

安装：GitHub Releases 页面提供静态编译版，下载解压即可用，不依赖系统库；也有 Docker 镜像 `breuner/elbencho`。常用参数：

| 参数 | 含义 |
|---|---|
| `-w` / `-r` | 写 / 读阶段（可同时给，按"先写后读"顺序执行） |
| `-d` / `--stat` / `-F` / `-D` | 创建目录 / stat 文件 / 删除文件 / 删除目录 |
| `-t N` | 每台机器的线程数 |
| `-n N` / `-N N` | 每个线程的目录数 / 每个目录的文件数；`-n 0` 表示文件直接放在测试目录下 |
| `-s SIZE` / `-b SIZE` | 每个文件的大小 / 每次 I/O 的块大小 |
| `--direct` | 使用 `O_DIRECT` |
| `--iodepth N` | 异步 I/O 深度（基于 libaio） |
| `--rand` | 随机偏移 |
| `--timelimit SEC` | 每个阶段的时间上限 |
| `--lat` | 输出延迟统计 |
| `--base10` | 用 1000 进制单位输出，方便和规格书比较（3.1 版起） |
| `--resfile FILE` | 把结果追加到文件 |
| `--service` / `--hosts` / `--quit` | 分布式模式：启动服务 / 指定客户端列表 / 结束服务 |

### 单机：块设备与大文件

先测这台机器的本地盘能跑多快，这是后面判断"集群是否达到硬件能力"的基准：

```bash
# 12 块 NVMe 同时顺序读，48 个线程，每次 4 MiB（只读，安全）
sudo elbencho -r -b 4M -t 48 --direct -s 100g /dev/nvme{0..11}n1
```

同时开一个 `iostat -xm 1` 观察每块盘的吞吐。如果 12 块盘里有一两块明显偏低，查一下它的 PCIe 链路：`sudo lspci -s <地址> -vvv | grep -E 'LnkCap|LnkSta'`，`LnkSta` 的速率或宽度低于 `LnkCap` 就是降速了。

大文件吞吐（文件系统上）：

```bash
TESTDIR=/fs1/testdir
# 写再读，每个线程一个 32 GB 文件；然后删除
elbencho -w -r -n 0 -t 1 -s 32g -b 4M --direct --base10 $TESTDIR
elbencho -F -n 0 -t 1 $TESTDIR
```

小块随机读的 IOPS：

```bash
elbencho -r -n 0 -t 16 -s 32g -b 4K --direct --iodepth 10 --rand --timelimit 120 --base10 $TESTDIR
```

### 小文件与元数据

AI 训练、代码仓库、日志这类负载的瓶颈往往在元数据，而不是带宽：

```bash
# 32 个线程，每个线程 1 个目录、每个目录 50000 个 4 KiB 文件：
# 建目录 → 写 → stat → 读 → 删文件 → 删目录，每个阶段单独出结果
elbencho -d -w --stat -r -F -D -t 32 -n 1 -N 50000 -s 4k -b 4k --direct --base10 $TESTDIR
```

这时要看的是每个阶段的 `Files/s`，而不是 MB/s。一个能跑 20 GB/s 的文件系统，创建小文件可能只有每秒几万个——这正是[分布式文件系统](/learn/distributed-fs)里元数据服务器的压力所在。

### 分布式模式

在每台客户端上启动 elbencho 服务，再由一台控制节点统一下发测试。所有客户端要在相同路径挂载同一个文件系统：

```bash
# 在所有客户端上启动服务（默认监听 1611 端口）
pdsh -R ssh -w client[01-04] elbencho --service

# 在控制节点上发起测试：4 台客户端 × 16 线程，每个线程写再读一个 16 GB 文件
elbencho --hosts client01,client02,client03,client04 \
  -w -r -n 0 -t 16 -s 16g -b 4M --direct --base10 \
  --resfile results-$(date +%F).txt /fs1/testdir

# 测完结束服务
elbencho --hosts client01,client02,client03,client04 --quit
```

各客户端的线程会按全局编号生成不同的文件名，不会互相覆盖。输出（格式随版本略有不同）：

```console
OPERATION RESULT TYPE        FIRST DONE  LAST DONE
========= ================   ==========  =========
WRITE     Elapsed ms       :      48210      53880
          IOPS             :       4797       4531
          Throughput MB/s  :      20120      19005
          Total MB         :     970000    1024000
---
READ      Elapsed ms       :      40150      43000
          IOPS             :       5865       5678
          Throughput MB/s  :      24600      23814
          Total MB         :     987690    1024000
---
```

**`FIRST DONE` 与 `LAST DONE` 是 elbencho 最有价值的设计**：

- `FIRST DONE` 是第一个线程完成时的统计。在那之前所有线程都在跑，所以它代表**全部客户端同时施压时的真实聚合吞吐**；
- `LAST DONE` 是最后一个线程完成时的统计，包含了"别人都跑完了，只剩几个慢线程"的尾巴。

两者差距小（这里写入 20.1 vs 19.0 GB/s），说明各客户端负载均衡；差距大，说明有掉队者（Straggler）——某台客户端网卡协商速率不对、某个存储节点慢、或数据分布不均。报告里应该以 `FIRST DONE` 作为聚合性能，同时说明两者的差距。

验算：64 个线程 × 16 GB = 1024 GB，与 `LAST DONE` 的 `Total MB` 一致；20120 MB/s ÷ 4.194 MB（4 MiB）≈ 4797 IOPS，一致。再做一次合理性检查：4 台客户端写 20 GB/s，每台平均 5 GB/s ≈ 40 Gbit/s，如果客户端是 25 GbE 单口，这个结果就不可能——要么有缓存、要么数字有问题。

> [!PROD] 集群基准测试的顺序
> 从下往上逐层测：单盘（fio）→ 单机所有盘（elbencho 块设备模式）→ 网络（`iperf3`、RDMA 用 `ib_write_bw`）→ 单客户端文件系统 → 多客户端文件系统。每一层的结果都是上一层的上限参考，哪一层掉得多，问题就在哪一层。直接从最上层开始测，结果不好时你不知道该怀疑什么。

## 测试报告模板

一份合格的报告，要让另一个人拿着它能**完整复现**你的测试，并且知道每个结论的依据：

```markdown title="benchmark-report-template.md"
# <测试对象> 性能测试报告（YYYY-MM-DD）

## 1. 目的
要回答的问题：例如"新 NVMe 型号能否满足数据库 4K 随机读 p99 < 1 ms、20 万 IOPS 的需求"。

## 2. 环境
- 硬件：CPU、内存、盘型号与固件版本、HBA/网卡、PCIe 链路（LnkSta）
- 软件：OS、内核版本、fio/elbencho 版本
- 配置：调度器、nr_requests、read_ahead_kb、文件系统与挂载选项、NUMA 绑定
- 拓扑：客户端数量、网络（型号、速率、MTU）、存储节点数量

## 3. 负载定义与方法
- 负载：块大小、读写比、随机/顺序、QD × jobs、数据量（与缓存大小的比较）
- 预处理：是否 TRIM、填充方式、稳态判定条件
- 时长与重复：每项 ramp X 秒 + 运行 Y 秒，重复 N 次
- job 文件 / 命令：见附件

## 4. 结果
| 测试项 | IOPS（均值 ± 标准差） | 带宽 | p50 | p99 | p99.9 |
|---|---|---|---|---|---|

## 5. 分析（主动基准测试）
- 每项的限制因素是什么？证据是什么（iostat / mpstat / biolatency 截图）？
- 合理性检查：是否超过设备与链路上限？
- 异常与波动：出现在何时，原因是什么？

## 6. 结论与局限
- 对"目的"中问题的直接回答
- 测试没有覆盖的情况（例如：未测满盘、未测故障降级状态）

## 7. 附件
job 文件、原始输出（JSON）、采集的 iostat/sar 日志
```

"局限"那一节最常被省略，却最能体现测试者的水平。一句"本测试未覆盖 SSD 写满后的稳态，写 IOPS 可能比报告低 50% 以上"，能帮读者避开一次错误的采购。

## 动手练习

1. **亲手测到缓存。** 在测试文件系统上用 `fio --name=cache --directory=/mnt/test --rw=randread --bs=4k --size=1g --runtime=30 --time_based` 分别以 `--direct=0` 和 `--direct=1` 运行，同时开着 `iostat -xz 1`，比较 IOPS 与 `iostat` 中的 `r/s`，解释差异。
2. **读懂一份输出。** 用本课的 `nvme-baseline.fio`（把 `filename` 改成你的测试盘）运行三组测试，对每组输出用 Little 定律和 `BW = IOPS × bs` 验算，并指出 p99 与 p50 的比值。
3. **扫 QD 并找出限制因素。** 运行 `qd-sweep.sh`，画出 IOPS-QD 和 p99-QD 曲线；在拐点附近用 `mpstat -P ALL 1` 和 fio 的 `cpu` 行判断，限制因素是设备还是 fio 本身；然后把 `numjobs` 改成 4 重做一遍，比较结果。
4. **观察写性能衰减。** 如果有一块可以随意擦写的 SSD（云上的临时盘也可以），按本课流程做预处理，用 `--write_iops_log=ss --log_avg_msec=60000` 记录每分钟的写 IOPS，画出从 FOB 到稳态的曲线。
5. **用 elbencho 做一次小文件测试。** 在单机上运行本课的小文件命令（把 `-N` 改成 5000），记录每个阶段的 `Files/s`，并用 `sudo ext4slower-bpfcc 1`（或 `xfsslower-bpfcc`）观察哪个阶段出现了慢操作。

## 自测

<details>
<summary>什么是主动基准测试？它和被动基准测试的核心区别是什么？</summary>

主动基准测试是在基准测试运行的同时用观测工具（`iostat`、`mpstat`、`biolatency`、CPU 剖析等）分析系统，直到能说清楚"是什么在限制这个结果"。被动基准测试只启动工具、记录最终数字。核心区别在于：主动基准测试能确认测试确实测到了预期的对象，能发现测到缓存、工具自身瓶颈、错误等问题，并给结果附上解释。

</details>

<details>
<summary>用 `ioengine=libaio`、`iodepth=64` 但没有加 `direct=1` 测试文件，结果的并发度是多少？为什么？</summary>

实际并发度基本是 1（每个 job）。Linux 原生 AIO 只对 `O_DIRECT` 的 I/O 真正异步；非 direct 的缓冲 I/O 在提交时就同步完成，`iodepth` 起不到作用。同时读写会经过页缓存，测到的可能是内存而不是设备。可以从 fio 输出的 `IO depths` 分布和 Little 定律的验算中发现这个问题。

</details>

<details>
<summary>一块刚做完 `blkdiscard` 的 NVMe，4K 随机读测出了远超规格书的 IOPS，4K 随机写的 IOPS 也比规格书高好几倍，分别可能是什么原因？</summary>

读：被 TRIM 过的 LBA 没有映射，控制器直接返回零数据，不访问 NAND，所以读得"飞快"，应先把测试区域完整写一遍再测读。写：盘处于出厂状态（FOB），有大量空闲块，写入不需要垃圾回收；持续写入进入稳态后 IOPS 会大幅下降。写测试应先预处理并确认进入稳态。

</details>

<details>
<summary>fio 报告 4 个 job、每个 iodepth=32，平均 `lat` 为 640 µs，IOPS 为 200k。这组数据一致吗？如果 IOPS 报告为 100k 呢？</summary>

按 Little 定律，IOPS ≈ 128 / 0.00064 s = 200k，与报告一致，说明实际并发达到了设定值。如果报告只有 100k，意味着实际平均在途请求只有约 64 个，并发没有达到设定值——可能是 fio job 的 CPU 打满了、I/O 引擎不支持异步（如 `psync` 或非 direct 的 `libaio`）、或者测试没有进入稳态，需要检查 `IO depths` 和 `cpu` 行。

</details>

<details>
<summary>elbencho 分布式测试中，`FIRST DONE` 为 20 GB/s，`LAST DONE` 为 12 GB/s，报告里应该怎么写？说明了什么？</summary>

聚合性能应以 `FIRST DONE` 为准（20 GB/s），因为它是所有线程同时运行时的统计；同时要报告两者的差距。差距很大说明存在掉队者：部分线程或客户端明显慢于其他，比如某台客户端网卡降速、某个存储节点或盘慢、数据分布不均。应该分别检查各客户端和存储节点，找出掉队的原因。

</details>

## 参考资料

- [Brendan Gregg：Systems Performance, 2nd Edition](https://www.brendangregg.com/systems-performance-2nd-edition-book.html)（第 12 章 基准测试）
- [Brendan Gregg：Active Benchmarking](https://www.brendangregg.com/activebenchmarking.html)
- [Brendan Gregg：The Benchmark Paradox](https://www.brendangregg.com/blog/2014-05-03/the-benchmark-paradox.html)
- [fio 官方文档](https://fio.readthedocs.io/en/latest/fio_doc.html)
- [fio 源码与示例 job 文件](https://github.com/axboe/fio/tree/master/examples)
- [elbencho 项目主页](https://github.com/breuner/elbencho)
- [SNIA：Solid State Storage Performance Test Specification](https://www.snia.org/tech_activities/standards/curr_standards/pts)
- [etcd 文档：硬件建议与磁盘测试](https://etcd.io/docs/v3.5/op-guide/hardware/)
