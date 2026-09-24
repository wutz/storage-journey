# 磁盘 I/O 观测：iostat 到 blktrace

[上一课](/learn/methodology)讲了"怎么想"，这一课讲"用什么看"。磁盘是存储问题最常被指认的嫌疑人，也是最容易被冤枉的：`%util` 100% 不一定是盘满了，`await` 高不一定是盘慢，`iotop` 里看到的写入量也不一定是真的。工具本身没错，错的是没搞清楚每个数字是在哪一层、用什么方法算出来的。

这一课从最常用的 `iostat` 开始，把 `iostat -x` 的每一列拆开讲清楚，再往下挖到 `/proc/diskstats` 这个数据源；然后用 `sar`、`pidstat`、`iotop` 回答"历史上怎样"和"是谁干的"；最后用 `blktrace` 和 `perf` 看清一个 I/O 请求在块层里的完整生命周期。学完你能：准确解读 `iostat` 输出并知道它的盲区；从磁盘指标定位到具体进程；用 `btt` 分清"时间花在 OS 队列还是设备上"。本课主要取材于《Systems Performance》第 9 章 9.6 节（观测工具）。

实验环境是 Ubuntu 24.04（内核 6.8），先把工具装上：

```bash
sudo apt install -y sysstat iotop-c blktrace linux-tools-common linux-tools-$(uname -r)
```

## iostat：第一眼看磁盘

### 常用选项

| 选项 | 作用 |
|---|---|
| `-x` | 扩展统计，本课的主角 |
| `-z` | 跳过采样期间没有活动的设备，机器上盘多时必加 |
| `-s` | 短格式，窄屏友好，60 秒清单里用的就是它 |
| `-m` / `-k` | 以 MB / kB 为单位 |
| `-t` | 每次输出带时间戳，保存日志时必加 |
| `-p ALL` | 同时显示分区 |
| `-d` / `-c` | 只显示磁盘 / 只显示 CPU |
| `1 10` | 每 1 秒一次，共 10 次 |

> [!WARNING] 第一屏是"开机以来的平均值"
> `iostat 1` 输出的第一组数据是自开机以来的累计平均，不是当前状态。看实时情况要从第二组开始读；需要跳过它可以加 `-y`。很多人拿第一屏的数字下结论，结果把几天前的负载当成了现在。

### iostat -x 逐列解读

在一块 NVMe 上跑 4 KiB 随机读混合少量写，`iostat -xz 1` 的一行输出（截至本文写作时 Ubuntu 24.04 自带 sysstat 12.6，列比较多，下面折行显示）：

```console
$ iostat -xz 1
Device            r/s     rkB/s   rrqm/s  %rrqm r_await rareq-sz     w/s     wkB/s   wrqm/s  %wrqm w_await wareq-sz
nvme0n1      38212.00 152848.00     0.00   0.00    0.21     4.00 1520.00  48640.00    12.00   0.78    0.05    32.00

                  d/s     dkB/s   drqm/s  %drqm d_await dareq-sz     f/s f_await  aqu-sz  %util
                 0.00      0.00     0.00   0.00    0.00     0.00   40.00    0.30    8.12  99.60
```

按读、写、丢弃（Discard）、刷新（Flush）四组来看，每组的列含义相同：

| 列 | 含义 | 解读要点 |
|---|---|---|
| `r/s` `w/s` | 每秒完成的读/写请求数（合并后） | 这是块设备层的 IOPS，不是应用层的 |
| `rkB/s` `wkB/s` | 每秒读/写的 KiB 数 | 吞吐 |
| `rrqm/s` `wrqm/s` | 每秒被合并的请求数 | 大于 0 说明有相邻请求，负载偏顺序 |
| `%rrqm` `%wrqm` | 合并请求占比 | 同上 |
| `r_await` `w_await` | 读/写请求平均耗时（ms），**包含 OS 队列等待 + 设备服务** | 最重要的列，尤其是 `r_await` |
| `rareq-sz` `wareq-sz` | 读/写请求的平均大小（KiB） | 4～8 KiB 以下基本是随机小 I/O |
| `d/s` `dkB/s` `d_await`… | 丢弃（TRIM/Discard）请求 | 4.19 内核起才有 |
| `f/s` `f_await` | 刷新（Flush，把设备缓存落盘）请求 | 5.5 内核起才有；`fsync` 密集型负载会很多 |
| `aqu-sz` | 平均队列长度（含设备上正在执行的请求） | 饱和度指标 |
| `%util` | 设备"忙"的时间占比 | **并行设备上会误导**，见下文 |

几个值得自己心算的关系：

- `rkB/s ≈ r/s × rareq-sz`：38212 × 4 = 152848，完全吻合；
- `aqu-sz ≈ r/s × r_await + w/s × w_await + f/s × f_await`（把 ms 换成秒）：38212 × 0.00021 + 1520 × 0.00005 + 40 × 0.0003 ≈ 8.1。这就是[性能指标](/learn/perf-metrics)里的 Little 定律。

为什么 `r_await` 最重要？《Systems Performance》第 9 章的解释是：读通常是同步的，应用在等它返回；而写大多被页缓存吸收、由后台线程异步回写，`w_await` 高应用未必感受得到——除非是 `fsync`、`O_DIRECT` 或 `O_SYNC` 写。

> [!NOTE] `svctm` 去哪了
> 老教程里会有一列 `svctm`（平均服务时间），它是用 `%util ÷ IOPS` 推算出来的，对能并行处理请求的设备完全不准。sysstat 12 已经把它删掉了，别再找它，也别信老文档里基于它的推论。

### %util 为什么会骗人

`%util` 的定义是：采样间隔内，设备上**至少有一个请求在途**的时间占比。对一次只能服务一个请求的 HDD，它确实近似"忙碌度"。对 NVMe、RAID 卷、云盘、Ceph RBD 这类能同时处理几十上百个请求的设备，它只能说明"有没有闲着"。用 fio 做个对比实验，同一块 NVMe：

```console
# 1 个 job，iodepth=1
Device            r/s     rkB/s r_await rareq-sz  aqu-sz  %util
nvme0n1      11820.00  47280.00    0.08     4.00    0.95   96.40

# 1 个 job，iodepth=32
Device            r/s     rkB/s r_await rareq-sz  aqu-sz  %util
nvme0n1     312050.00 1248200.00   0.10     4.00   31.21  100.00
```

`%util` 从 96% 到 100% 几乎没变，IOPS 却差了 26 倍。第一种情况下这块盘只用了很小一部分能力，`%util` 却告诉你它"快满了"。

对并行设备，判断饱和要看：

1. 加负载时 IOPS/吞吐是否还在增长；
2. `r_await` 是否随 `aqu-sz` 上升而明显上升（开始排队）；
3. 设备标称能力与当前值的差距（基于容量的利用率）。

> [!TIP] 快速识别 I/O 模式
> 结合几列能很快猜出负载类型：`rareq-sz` 小、`rrqm/s` 为 0 → 随机小读；`wareq-sz` 大（几百 KiB）、`wrqm/s` 高 → 顺序写、有合并；`f/s` 高且 `w_await` 高 → `fsync` 密集（数据库、etcd），盘的刷新延迟是关键。

## /proc/diskstats：所有工具的数据源

`iostat`、`sar -d`、node_exporter 的磁盘指标，读的都是同一个文件：

```console
$ grep -w nvme0n1 /proc/diskstats
 259       0 nvme0n1 1523412 12 97480536 245120 88230 1520 5623104 41020 0 356780 286140 0 0 0 0 1204 0
```

设备名之后的字段（参见内核文档 `iostats.rst`）：

| 字段 | 含义 | 字段 | 含义 |
|---|---|---|---|
| 1 | 完成的读请求数 | 9 | 当前在途请求数（瞬时值） |
| 2 | 合并的读请求数 | 10 | 有 I/O 在途的累计毫秒数（io_ticks） |
| 3 | 读扇区数（512 字节） | 11 | 加权 I/O 毫秒数（每毫秒 × 在途数） |
| 4 | 读请求累计耗时（ms） | 12～15 | 丢弃：完成数、合并数、扇区数、耗时 |
| 5 | 完成的写请求数 | 16 | 完成的刷新请求数 |
| 6 | 合并的写请求数 | 17 | 刷新累计耗时（ms） |
| 7 | 写扇区数 | | |
| 8 | 写请求累计耗时（ms） | | |

全是单调递增的计数器（第 9 个除外），`iostat` 做的就是两次采样求差：

```text
r/s     = Δ字段1 / Δt
rkB/s   = Δ字段3 × 512 / 1024 / Δt
r_await = Δ字段4 / Δ字段1           （每个读请求的平均毫秒数）
aqu-sz  = Δ字段11 / Δt(ms)
%util   = Δ字段10 / Δt(ms) × 100
```

从公式可以直接看出 `%util` 的问题：字段 10 只关心"有没有请求在途"，不关心有几个。

还有一个配套的饱和度指标：PSI（Pressure Stall Information）。

```console
$ cat /proc/pressure/io
some avg10=42.18 avg60=38.02 avg300=20.11 total=812350120
full avg10=31.55 avg60=28.40 avg300=14.87 total=610224893
```

`some` 是"至少一个任务因等 I/O 而停顿"的时间占比，`full` 是"所有非空闲任务都在等 I/O"的占比。它衡量的是**任务被 I/O 拖住的程度**，比 `%util` 更接近"业务是否受影响"。

## sar -d：历史数据

`iostat` 只能看现在，出问题时往往已经错过了现场。sysstat 的历史采集（开启方法见[上一课](/learn/methodology)）每 10 分钟记录一次，可以回看：

```console
$ sar -dp -f /var/log/sysstat/sa23 -s 02:00:00 -e 03:30:00
02:00:01 AM       DEV       tps     rkB/s     wkB/s     dkB/s   areq-sz    aqu-sz     await     %util
02:10:01 AM   nvme0n1    812.35   3120.40  18422.10      0.00     26.52      0.21      0.26      8.91
02:20:01 AM   nvme0n1  15240.12 402110.55  12003.84      0.00     27.17     14.02      0.92     99.82
02:30:01 AM   nvme0n1  15102.87 398775.02  11820.40      0.00     27.19     13.87      0.92     99.80
02:40:01 AM   nvme0n1    798.10   3080.22  18220.05      0.00     26.69      0.20      0.25      8.70
```

凌晨 2:10 到 2:30 之间（02:20 和 02:30 两个采样点）读吞吐从 3 MB/s 涨到 400 MB/s，`await` 翻了近 4 倍——对照一下 crontab 和备份计划，多半就是它。`-p` 让设备显示为 `nvme0n1` 而不是 `dev259-0`。

> [!NOTE] 10 分钟平均会抹平突发
> sysstat 默认 10 分钟一个点，一个持续 20 秒的 I/O 风暴在里面几乎看不出来。需要更细粒度可以改 `sysstat-collect.timer` 的间隔，或者用 Prometheus + node_exporter 做 15 秒粒度的长期采集（见[存储监控与告警](/learn/storage-monitoring)）。

## 找到进程：pidstat 与 iotop

磁盘指标只告诉你盘有多忙，不告诉你是谁在用。

### pidstat -d

```console
$ pidstat -d 1 3
Linux 6.8.0-45-generic (lab1)   09/24/2026   _x86_64_   (8 CPU)

14:12:01      UID       PID   kB_rd/s   kB_wr/s kB_ccwr/s iodelay  Command
14:12:02        0      3321 152400.00      0.00      0.00      98  fio
14:12:02      999      1788      0.00   2048.00      0.00       0  postgres
14:12:02        0       512      0.00    612.00      0.00       0  jbd2/nvme0n1p2-
```

| 列 | 含义 |
|---|---|
| `kB_rd/s` | 该进程每秒导致从存储读取的 KiB（真的到达块层的读，不含缓存命中） |
| `kB_wr/s` | 该进程每秒**产生**的写入量（写入页缓存时即计入，不代表已落盘） |
| `kB_ccwr/s` | 被取消的写：写进页缓存后，还没回写就被截断或删除了 |
| `iodelay` | 该进程等待块 I/O 的时间（时钟 tick），包括换入 |

`iodelay` 是个好东西：`kB_rd/s` 回答"谁读得多"，`iodelay` 回答"谁被 I/O 拖得最惨"，两者往往不是同一个进程。看其他用户的进程需要 root 权限。

### iotop

`iotop` 以类似 `top` 的方式按线程排序。Ubuntu 24.04 上有两个版本：`iotop`（Python 原版）和 `iotop-c`（C 重写版，更轻量，推荐）。

```console
$ sudo iotop-c -bod5
Total DISK READ:       148.83 M/s | Total DISK WRITE:         2.61 M/s
Current DISK READ:     148.80 M/s | Current DISK WRITE:        9.40 M/s
    TID  PRIO  USER     DISK READ DISK WRITE>    SWAPIN      IO    COMMAND
   3321 be/4 root      148.83 M/s    0.00 B/s    0.00 %  92.14 % fio --name=randread ...
   1788 be/4 postgres    0.00 B/s    2.00 M/s    0.00 %   0.35 % postgres: checkpointer
    512 be/3 root        0.00 B/s  612.00 K/s    0.00 %   1.02 % [jbd2/nvme0n1p2-8]
```

`-b` 批处理模式、`-o` 只显示有 I/O 的、`-d5` 每 5 秒刷新，适合记录到日志。`Total` 是进程层面发起的量，`Current` 是块设备层实际发生的量，两者的差就是缓存和回写的效果。

> [!WARNING] iotop 的两个坑
> 第一，`SWAPIN` 和 `IO` 百分比依赖内核的延迟统计，5.14 之后默认关闭，看到 `?unavailable?` 需要 `sudo sysctl kernel.task_delayacct=1`（有少量开销，用完可关）。第二，《Systems Performance》第 9 章指出 iotop 的写入量**会少算**：异步回写由内核线程在稍后完成，不会记到发起写的进程头上。要可靠地按进程归因块层 I/O，用基于 BPF 的 `biotop`/`biosnoop`（见[用 BPF 看清 I/O](/learn/bpf-io-tracing)）。

## blktrace：请求的一生

`iostat` 给的是平均值，`blktrace` 给的是每一个请求在块层经历的每一个事件。它通过块层的追踪点采集数据，是分析"时间花在块层哪个阶段"的传统利器。

### 请求生命周期

一个 bio 从文件系统下来，到设备完成，会触发这些事件（blkparse 的 action 字母）：

```text
  Q  queued      bio 进入块层（提交者进程上下文）
  │
  ├─ X split     太大，被拆分
  ├─ M / F       与已有请求后合并 / 前合并（到这里就结束了，搭别人的车）
  │
  G  get request 分配一个 request 结构
  │
  P / U          plug / unplug：批量攒请求再一起下发
  │
  I  inserted    插入 I/O 调度器队列（使用 none 调度器时经常没有这一步）
  │
  D  issued      下发给驱动 / 设备         ─┐
  │                                         │ D2C：设备服务时间
  C  complete    设备完成                  ─┘

  Q2C = 块层总时间    Q2D ≈ OS 内的排队与处理时间
```

另外还有 `A`（remap，分区或 DM/MD 设备的地址重映射）、`B`（bounce）、`S`（sleep，拿不到 request）、`T`（定时器触发的 unplug）等。`S` 事件频繁出现说明请求队列被占满了（`nr_requests` 不够），这是一个明确的饱和信号。

### 实时查看：btrace

`btrace` 是 `blktrace -d <dev> -o - | blkparse -i -` 的简写。它依赖 debugfs，Ubuntu 默认已挂载在 `/sys/kernel/debug`。

```console
$ sudo btrace /dev/sda
  8,0    3        1     0.000000000  4410  Q   R 81920376 + 8 [fio]
  8,0    3        2     0.000001205  4410  G   R 81920376 + 8 [fio]
  8,0    3        3     0.000001733  4410  I   R 81920376 + 8 [fio]
  8,0    3        4     0.000009412   224  D   R 81920376 + 8 [kworker/3:1H]
  8,0    3        5     0.000361208     0  C   R 81920376 + 8 [0]
  8,0    1        6     0.000402133  4411  Q  WS 10485760 + 256 [dd]
  8,0    1        7     0.000403011  4411  G  WS 10485760 + 256 [dd]
...
```

各列依次是：设备号、CPU、序号、时间（秒）、PID、action、RWBS、起始扇区 + 扇区数、进程名。

RWBS 字段描述请求类型：`R` 读、`W` 写、`D` 丢弃、`F` 刷新/FUA、`S` 同步、`M` 元数据、`A` 预读、`N` 无数据。所以 `WS` 是同步写，`RA` 是预读，`FWS` 是带刷新的同步写（常见于日志提交）。

从上面这个请求可以读出：Q→D 约 9 µs，D→C 约 352 µs——时间主要在 SATA SSD 上。注意 `D` 和 `C` 的进程名不一定是发起者：下发可能由 kworker 完成，完成发生在中断上下文（PID 0）。**要看是谁发起的 I/O，看 `Q` 事件**。

只关心某类事件可以加过滤，比如只看下发：`sudo btrace -a issue /dev/sda`。

### 统计分析：blktrace + btt

实时滚屏只适合看个大概，真正的分析要采集下来用 `btt` 统计。下面的例子是一块 SATA SSD（mq-deadline 调度器），fio 以 iodepth=128 做 4 KiB 随机读：

```console
$ sudo blktrace -d /dev/sda -o sda -w 10        # 采集 10 秒，每个 CPU 一个文件
$ ls sda.blktrace.*
sda.blktrace.0  sda.blktrace.1  sda.blktrace.2  sda.blktrace.3 ...
$ blkparse -i sda -d sda.bin -O                 # 合并为二进制，-O 不输出文本
$ btt -i sda.bin
==================== All Devices ====================

            ALL           MIN           AVG           MAX           N
--------------- ------------- ------------- ------------- -----------

Q2Q               0.000000402   0.000010638   0.002011940      940122
Q2G               0.000000150   0.000000451   0.000052120      940123
G2I               0.000000101   0.000000305   0.000041830      940123
I2D               0.000000550   0.001009120   0.004120330      940123
D2C               0.000052110   0.000349920   0.003011250      940123
Q2C               0.000053340   0.001359770   0.005520110      940123

==================== Device Overhead ====================

       DEV |       Q2G       G2I       Q2M       I2D       D2C
---------- | --------- --------- --------- --------- ---------
 (  8,  0) |   0.0332%   0.0224%   0.0000%  74.2114%  25.7337%
---------- | --------- --------- --------- --------- ---------
   Overall |   0.0332%   0.0224%   0.0000%  74.2114%  25.7337%
```

读法：

- `Q2C` 平均 1.36 ms：请求在块层的总时间，约等于 `iostat` 的 `r_await`；
- `D2C` 平均 0.35 ms：设备本身的服务时间，只占 26%；
- `I2D` 平均 1.0 ms：在调度器队列里等待下发，占 74%；
- `Q2Q` 平均 10.6 µs：请求到达间隔，对应约 94k IOPS。

结论：盘本身不慢。SATA 的 NCQ 队列深度最多 32，应用却压了 128 个并发，多出来的 96 个只能在 OS 里排队。用 Little 定律验证：32 ÷ 0.35 ms ≈ 91k，128 ÷ 1.36 ms ≈ 94k，对得上。优化方向是降低应用并发或换能并行更多的设备，调 OS 参数解决不了设备的并行上限。

> [!TIP] btt 的其他输出
> `btt -i sda.bin -l d2c` 输出每个请求的 D2C 延迟到文件，可以画散点图找异常；`-q` 输出队列深度随时间的变化；`-B` 输出每个请求的扇区范围，可以看访问模式。blktrace 的数据量很大（每个请求几十到上百字节 × 几个事件），高 IOPS 下只采集几秒就够，并且不要把输出写到被追踪的同一块盘上。

## perf：块层追踪点

`blktrace` 用的追踪点，`perf` 也能直接用，而且能带上调用栈。先看有哪些：

```console
$ sudo perf list 'block:*'
  block:block_bio_backmerge                          [Tracepoint event]
  block:block_bio_bounce                             [Tracepoint event]
  block:block_bio_complete                           [Tracepoint event]
  block:block_bio_frontmerge                         [Tracepoint event]
  block:block_bio_queue                              [Tracepoint event]
  block:block_bio_remap                              [Tracepoint event]
  block:block_dirty_buffer                           [Tracepoint event]
  block:block_getrq                                  [Tracepoint event]
  block:block_io_done                                [Tracepoint event]
  block:block_io_start                               [Tracepoint event]
  block:block_plug                                   [Tracepoint event]
  block:block_rq_complete                            [Tracepoint event]
  block:block_rq_error                               [Tracepoint event]
  block:block_rq_insert                              [Tracepoint event]
  block:block_rq_issue                               [Tracepoint event]
  block:block_rq_merge                               [Tracepoint event]
  block:block_rq_remap                               [Tracepoint event]
  block:block_rq_requeue                             [Tracepoint event]
  block:block_split                                  [Tracepoint event]
  block:block_touch_buffer                           [Tracepoint event]
  block:block_unplug                                 [Tracepoint event]
```

（具体列表随内核版本略有不同。）先用计数确认各阶段事件量：

```console
$ sudo perf stat -e 'block:block_bio_queue,block:block_rq_insert,block:block_rq_issue,block:block_rq_complete' -a sleep 10

 Performance counter stats for 'system wide':

           940,511      block:block_bio_queue
           940,508      block:block_rq_insert
           940,510      block:block_rq_issue
           940,498      block:block_rq_complete

      10.001823418 seconds time elapsed
```

然后记录调用栈，看这些 I/O 是从哪条代码路径来的：

```console
$ sudo perf record -e block:block_rq_insert -a -g -- sleep 10
$ sudo perf report --stdio --no-children | head -40
```

追踪点支持过滤器，可以只抓感兴趣的请求，大幅减少开销和数据量：

```bash
# 只看大于 100 KiB 的请求
sudo perf record -e block:block_rq_issue --filter 'bytes > 102400' -a -g -- sleep 10
# 只看同步写
sudo perf record -e block:block_rq_issue --filter 'rwbs == "WS"' -a -g -- sleep 10
# 只看所有带 W 的请求
sudo perf record -e block:block_rq_issue --filter 'rwbs ~ "*W*"' -a -g -- sleep 10
```

《Systems Performance》第 9 章提到一个细节：想知道是哪个进程发起的 I/O，追踪 `block_rq_insert`（或 `block_bio_queue`）比 `block_rq_issue` 更准，因为下发时常常已经处于 kworker 或其他进程的上下文中。

> [!NOTE] perf 的开销
> `perf record` 会把每个事件写进内核缓冲区再拷到用户态文件，每秒几十万次 I/O 时开销和文件体积都很可观。需要在内核里直接聚合（直方图、按进程计数）的场景，BPF 是更好的选择，这正是[用 BPF 看清 I/O](/learn/bpf-io-tracing)的内容。

## 工具怎么选

| 问题 | 首选工具 |
|---|---|
| 盘现在忙不忙、慢不慢 | `iostat -xz 1` |
| 昨晚 2 点发生了什么 | `sar -d -f /var/log/sysstat/saDD` |
| 是哪个进程 | `pidstat -d 1`、`iotop-c -bo`，要准确用 `biotop` |
| 任务被 I/O 拖住了多少 | `/proc/pressure/io`、`pidstat -d` 的 `iodelay` |
| 时间花在 OS 队列还是设备 | `blktrace` + `btt`，或 `biolatency -Q` 对比 |
| I/O 从哪条代码路径来 | `perf record -e block:block_rq_insert -g` |
| 延迟分布和异常值 | `biolatency`、`biosnoop`（BPF） |

## 动手练习

1. **验证 `%util` 的误导性。** 用 fio 以 `iodepth=1` 和 `iodepth=32` 分别对测试盘 `/dev/vdb` 做只读随机读（`--readonly --direct=1 --rw=randread --bs=4k`），同时运行 `iostat -xz 1`，记录两种情况下的 `r/s`、`r_await`、`aqu-sz`、`%util`，并用 Little 定律验证 `aqu-sz`。
2. **自己实现一个迷你 iostat。** 写个脚本每秒读两次 `/proc/diskstats`，按本课的公式算出 `r/s`、`r_await`、`aqu-sz` 和 `%util`，和 `iostat -x 1` 的结果对比。
3. **找出凶手进程。** 在后台同时运行一个 `dd if=/dev/zero of=/mnt/test/big bs=1M count=4096 oflag=direct` 和一个 fio 随机读，分别用 `pidstat -d 1`、`iotop-c -bod2` 找出各自的读写量，比较两个工具在写入量上的差异（可以把 `oflag=direct` 去掉再做一次）。
4. **拆解请求生命周期。** 把测试盘的调度器设为 `mq-deadline`（`echo mq-deadline | sudo tee /sys/block/vdb/queue/scheduler`），用 fio 以 iodepth 分别为 4 和 256 做随机读，各用 `blktrace -w 5` 采集并用 `btt` 分析，比较两种情况下 I2D 和 D2C 的占比。

## 自测

<details>
<summary>`iostat` 的 `r_await` 包含哪些时间？为什么它通常比 `w_await` 更值得关注？</summary>

`r_await` 是读请求从进入块层到完成的平均时间，包括在 OS 队列（调度器、软件队列）里的等待时间和设备服务时间。读通常是同步的，应用在等待结果；写大多被页缓存吸收、由后台异步回写，`w_await` 高不一定影响应用，除非是 `fsync`、`O_SYNC`、`O_DIRECT` 这类同步写。

</details>

<details>
<summary>`%util` 是怎么计算的？为什么它在 NVMe 上几乎没法用来判断是否饱和？</summary>

`%util` = 采样间隔内 `/proc/diskstats` 第 10 个字段（有 I/O 在途的累计毫秒数）的增量除以间隔时长。它只关心"是否有请求在途"，不关心有几个。NVMe 可以同时处理大量请求，队列深度为 1 的负载就能让 `%util` 接近 100%，而此时设备可能只用了很小一部分能力。判断饱和应看 IOPS 是否随负载继续增长、`await` 是否随 `aqu-sz` 上升。

</details>

<details>
<summary>blktrace 中 Q、G、I、D、C 分别代表什么？如何从 btt 的输出判断时间主要花在 OS 里还是设备上？</summary>

Q：bio 进入块层；G：分配 request；I：插入调度器队列；D：下发给驱动/设备；C：设备完成。btt 输出中，D2C 是设备服务时间，Q2C 是块层总时间，I2D 是在调度器队列中的等待。比较 Device Overhead 中 D2C 与 I2D（以及 Q2G、G2I）的占比：D2C 占大头说明时间在设备上，I2D 占大头说明请求在 OS 里排队。

</details>

<details>
<summary>为什么 `iotop` 显示的进程写入量经常少于实际写入磁盘的量？更可靠的办法是什么？</summary>

大部分写先进入页缓存，之后由内核回写线程（kworker/flush）异步写到磁盘，这部分块层 I/O 不会被记到最初写数据的进程头上。更可靠的办法是在块层追踪点上按进程归因，例如在 `block_rq_insert`/`block_bio_queue` 上统计（`biotop`、`biosnoop`、`perf record -e block:block_rq_insert`），并理解回写 I/O 本身就是异步发生的。

</details>

<details>
<summary>`iostat` 输出中 `wareq-sz` 为 512、`wrqm/s` 很高，`f/s` 几乎为 0，这是什么样的负载？</summary>

大块顺序写，而且块层在做大量合并（相邻的小请求被合并成大请求），刷新请求很少，说明不是 `fsync` 密集型负载。典型场景是大文件拷贝、备份、日志顺序写入或页缓存的批量回写。

</details>

## 参考资料

- [Brendan Gregg：Systems Performance, 2nd Edition](https://www.brendangregg.com/systems-performance-2nd-edition-book.html)（第 9 章 9.6 观测工具）
- [Linux 内核文档：I/O statistics fields](https://docs.kernel.org/admin-guide/iostats.html)
- [Linux 内核文档：PSI - Pressure Stall Information](https://docs.kernel.org/accounting/psi.html)
- [sysstat 项目主页与文档](https://sysstat.github.io/)
- [blktrace 用户指南（btt 部分）](https://git.kernel.org/pub/scm/linux/kernel/git/axboe/blktrace.git/tree/btt/doc)
- [blkparse(1) man page](https://manpages.ubuntu.com/manpages/noble/man1/blkparse.1.html)
- [perf-list(1) / perf-record(1)](https://man7.org/linux/man-pages/man1/perf-record.1.html)
