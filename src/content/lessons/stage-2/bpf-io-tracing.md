# 用 BPF 看清 I/O

前两课的工具各有盲区：`iostat` 只有平均值，`blktrace` 数据量巨大得靠事后分析，`iotop` 会把写入算错人。我们真正想要的是：**针对每一个 I/O 事件做计算，但只把汇总结果交给用户态**——每个请求的延迟直方图、按进程和磁盘拆开的统计、只打印超过 10 ms 的异常请求，而且开销低到能在生产环境直接跑。这正是 BPF 擅长的事。

这一课先讲清楚 BPF 是什么、为什么能安全地在生产环境使用；然后逐个过一遍 BCC 的块 I/O 工具：`biolatency`、`biosnoop`、`biotop`、`bitesize`、`biostacks`；接着学 bpftrace 的语法和一批实用的单行命令，并亲手写一个按进程统计延迟、同时抓异常值的脚本；最后用火焰图把"I/O 从哪来"画出来。学完你能：在几分钟内回答"磁盘延迟分布是什么样、慢的是谁、从哪条代码路径来"；遇到现成工具没覆盖的问题时，自己写几行 bpftrace 解决。本课主要取材于《Systems Performance》第 9 章 9.6 节和第 15 章。

## BPF 是什么

BPF（Berkeley Packet Filter）最初是为网络抓包设计的过滤器，扩展后的 eBPF 已经变成 Linux 内核里一个通用的**沙箱虚拟机**：你可以把一小段程序加载进内核，挂到各种事件上（追踪点、函数入口/返回、性能计数器、网络包），事件发生时执行它。现在大家说 BPF，一般就指 eBPF。

```text
  用户态                                 内核
┌──────────────────┐   加载字节码   ┌────────────────────────────────────┐
│ bpftrace / BCC   │ ─────────────▶ │ 验证器（Verifier）                 │
│ 前端：编译脚本   │                │   检查：无越界、无死循环、有限指令 │
│                  │                │        │                           │
│                  │                │        ▼ JIT 编译为机器码          │
│                  │                │ 挂到事件上：                       │
│                  │                │   tracepoint:block:block_rq_issue  │
│                  │                │   kprobe:vfs_read ...              │
│                  │   读取汇总结果 │        │ 每个事件执行一次          │
│ 打印直方图/表格 ◀│ ───────────────│ BPF Map：计数、直方图、哈希表      │
└──────────────────┘                └────────────────────────────────────┘
```

《Systems Performance》第 15 章总结了它适合做性能分析的几个原因：

- **可编程**：不再受限于工具作者预设的输出，可以针对你的问题自定义计算；
- **在内核里聚合**：每秒几十万个 I/O，只需要在内核的 Map 里更新直方图，用户态隔几秒读一次汇总，而不是像 `perf record`、`blktrace` 那样把每个事件都拷出来；
- **安全**：验证器保证程序不会让内核崩溃、不会死循环、不会访问非法内存，加载失败好过把机器搞挂；
- **生产可用**：开销主要取决于事件频率，挂在块 I/O 事件上通常很小。书里提到 Netflix 在生产服务器上默认安装 BCC 和 bpftrace。

### 事件源：稳定与不稳定

| 事件源 | 例子 | 稳定性 |
|---|---|---|
| 追踪点（Tracepoint） | `tracepoint:block:block_rq_issue` | 内核维护的稳定接口，推荐优先使用 |
| kprobe / kretprobe | `kprobe:vfs_read`、`kprobe:ext4_file_read_iter` | 任意内核函数，函数改名、内联后就失效 |
| uprobe | 用户态程序的函数 | 随应用版本变化 |
| 软件/硬件事件 | CPU 周期采样 | 用于 CPU 剖析 |

块层有完整的追踪点，所以 I/O 追踪大多能基于稳定接口实现。文件系统层的工具（如 `ext4slower`）用的是 kprobe，这就是[文件系统观测](/learn/fs-observability)里提到它们在新内核上可能失效的原因。

### BCC 与 bpftrace

| | BCC | bpftrace |
|---|---|---|
| 形式 | Python/C 写成的成品工具 | 类 awk 的高级脚本语言 |
| 适合 | 复杂的、带大量选项的工具 | 临时分析、单行命令、短脚本 |
| 用法 | 直接运行工具 | 写单行命令或 `.bt` 脚本 |

书中的建议是：先用 BCC 的现成工具，现成工具回答不了再用 bpftrace 自己写。

### 在 Ubuntu 24.04 上安装

```bash
sudo apt install -y bpfcc-tools bpftrace linux-headers-$(uname -r)
bpftrace --version                      # 截至本文写作时 Ubuntu 24.04 为 0.20.x
ls /usr/sbin/*-bpfcc | wc -l            # BCC 工具，全部带 -bpfcc 后缀
dpkg -L bpftrace | grep '\.bt$' | head  # bpftrace 自带的 .bt 工具放在哪
```

> [!NOTE] 工具名对照
> 本课中的 BCC 工具在 Ubuntu/Debian 上都叫 `xxx-bpfcc`：`biolatency-bpfcc`、`biosnoop-bpfcc`、`biotop-bpfcc`、`bitesize-bpfcc`。在其他发行版或书中叫 `biolatency`、`biosnoop`。所有 BPF 工具都需要 root 权限。

## BCC 块 I/O 工具

### biolatency：延迟直方图

`biolatency` 以直方图显示块 I/O 延迟，默认测量从下发到设备（issue）到完成的时间，也就是设备服务时间：

```console
$ sudo biolatency-bpfcc 10 1
Tracing block device I/O... Hit Ctrl-C to end.

     usecs               : count     distribution
         0 -> 1          : 0        |                                        |
         2 -> 3          : 0        |                                        |
         4 -> 7          : 0        |                                        |
         8 -> 15         : 0        |                                        |
        16 -> 31         : 812      |                                        |
        32 -> 63         : 48210    |*****                                   |
        64 -> 127        : 352016   |****************************************|
       128 -> 255        : 190332   |*********************                   |
       256 -> 511        : 20115    |**                                      |
       512 -> 1023       : 3012     |                                        |
      1024 -> 2047       : 405      |                                        |
      2048 -> 4095       : 52       |                                        |
      4096 -> 8191       : 7        |                                        |
```

这块 NVMe 的主体在 64～255 µs，但有几十个请求落在 2～8 ms——比主体慢 30 倍以上。只看 `iostat` 的 `r_await`（约 0.13 ms）你根本不会知道它们存在。

常用选项：

| 选项 | 作用 |
|---|---|
| `-D` | 按磁盘分别输出直方图 |
| `-F` | 按 I/O 标志分别输出（读、同步写、刷新、预读……） |
| `-Q` | 包含 OS 队列时间（从插入队列开始计时），即 `iostat` 的 `await` 口径 |
| `-m` | 以毫秒为单位 |
| `-T` | 输出带时间戳 |
| `10 6` | 每 10 秒输出一次，共 6 次 |

`-F` 在排查混合负载时尤其有用。下面是一个数据库节点的片段：

```console
$ sudo biolatency-bpfcc -F 10 1
flags = Read
     usecs               : count     distribution
        64 -> 127        : 20180    |****************************************|
       128 -> 255        : 9512     |******************                      |
       256 -> 511        : 830      |*                                       |

flags = Sync-Write
     usecs               : count     distribution
        16 -> 31         : 5120     |****************************************|
        32 -> 63         : 2210     |*****************                       |

flags = Flush
     usecs               : count     distribution
       512 -> 1023       : 40       |****                                    |
      1024 -> 2047       : 405      |****************************************|
      2048 -> 4095       : 312      |******************************          |
      4096 -> 8191       : 60       |*****                                   |
```

同步写只要几十微秒（被盘内的易失性写缓存吸收了），**刷新（Flush）却要 1～8 ms**。数据库每次 `fsync` 都会带一个刷新，这才是提交延迟的来源。这种盘通常是没有掉电保护的消费级 SSD，刷新时必须把缓存真正写进 NAND——这是[存储硬件](/learn/storage-hardware)选型里"企业级 SSD 带 PLP"的实际意义。

把 `-Q` 与不带 `-Q` 的结果对比，就能分出 OS 队列时间和设备时间，效果类似[磁盘 I/O 观测](/learn/disk-observability)中 `btt` 的 I2D 与 D2C，但开销低得多、可以长时间运行。

### biosnoop：每个 I/O 一行

```console
$ sudo biosnoop-bpfcc -Q
TIME(s)     COMM           PID     DISK      T SECTOR     BYTES  QUE(ms) LAT(ms)
0.000000    fio            3321    nvme0n1   R 81920376   4096      0.00    0.09
0.000004    fio            3321    nvme0n1   R 12004488   4096      0.00    0.11
0.000011    kworker/u16:2  230     nvme0n1   W 50331648   524288    0.00    0.84
0.001220    postgres       1788    nvme0n1   W 20480000   8192      0.01    0.03
0.001285    postgres       1788    nvme0n1   W 0          0         0.00    2.14
...
```

| 列 | 含义 |
|---|---|
| `COMM` `PID` | 发起 I/O 的进程（尽量归因到真正的发起者） |
| `DISK` | 磁盘 |
| `T` | 读 `R` / 写 `W` |
| `SECTOR` `BYTES` | 起始扇区和大小，能看出随机还是顺序 |
| `QUE(ms)` | OS 队列时间（`-Q` 时才有） |
| `LAT(ms)` | 设备服务时间 |

`BYTES` 为 0 的写就是刷新请求，2.14 ms。`kworker` 写的 512 KiB 是页缓存回写，归不到具体进程——因为它本来就是内核线程异步干的。

`biosnoop` 最常见的用法是**找异常值**：把输出存下来，按延迟排序看最慢的那些请求有什么共同点：

```console
$ sudo biosnoop-bpfcc > out.biosnoop &
$ sleep 60; sudo kill %1
$ sort -n -k 8,8 out.biosnoop | tail -5
12.803311   fio            3321    nvme0n1   R 30011136   4096      3.82
12.803315   fio            3321    nvme0n1   R 88110504   4096      3.85
12.803319   fio            3321    nvme0n1   R 1204600    4096      3.87
12.803342   fio            3321    nvme0n1   R 60332104   4096      3.90
12.803355   fio            3321    nvme0n1   R 7702016    4096      4.02
```

（不带 `-Q` 时第 8 列是 `LAT(ms)`。）最慢的请求集中在 12.80 秒前后几十微秒内、分散在不同扇区——不是某个区域坏了，而是设备在那一刻整体停顿了一下，典型原因是 SSD 内部垃圾回收或固件行为。《Systems Performance》第 9 章里也有类似的分析：看慢请求在时间上是否成簇、之前是否有大写入，是区分"设备抖动"和"排队"的关键。

### biotop：按进程的块 I/O

```console
$ sudo biotop-bpfcc -C 1
14:20:01 loadavg: 3.02 2.11 1.60 4/790 4410

PID     COMM             D MAJ MIN DISK       I/O  Kbytes  AVGms
3321    fio              R 259 0   nvme0n1 312050 1248200   0.10
230     kworker/u16:2    W 259 0   nvme0n1     92   47104   0.81
1788    postgres         W 259 0   nvme0n1    640    5120   0.03
```

它和 `iotop` 看起来很像，但统计的是真正到达块层的 I/O，并带上平均延迟。`-C` 不清屏，`-r 20` 显示 20 行，参数中的 `1` 是刷新间隔（秒）。

### bitesize：I/O 大小分布

```console
$ sudo bitesize-bpfcc
Tracing block I/O... Hit Ctrl-C to end.
^C

Process Name = fio
     Kbytes              : count     distribution
         0 -> 1          : 0        |                                        |
         2 -> 3          : 0        |                                        |
         4 -> 7          : 1560250  |****************************************|

Process Name = postgres
     Kbytes              : count     distribution
         0 -> 1          : 512      |******                                  |
         2 -> 3          : 0        |                                        |
         4 -> 7          : 0        |                                        |
         8 -> 15         : 3200     |****************************************|

Process Name = kworker/u16:2
     Kbytes              : count     distribution
       256 -> 511        : 120      |*********                               |
       512 -> 1023       : 460      |****************************************|
```

负载特征刻画中"I/O 大小"这一项，用它回答最直接。postgres 在 0～1 KiB 桶里的是零字节的刷新请求。

### biostacks：I/O 从哪条代码路径来

`biostacks.bt` 是 bpftrace 自带的工具，它把 I/O 延迟和发起时的内核调用栈关联起来，回答"这些 I/O 是因为什么产生的"。书中的例子发现一个 `access()` 系统调用触发了 `ext4_lookup` 读目录块——一个看起来与读写数据无关的调用产生了磁盘 I/O。

```console
$ sudo bpftrace $(dpkg -L bpftrace | grep 'biostacks.bt$')
```

> [!WARNING] kprobe 工具在新内核上可能失效
> `biostacks.bt` 挂在内核函数（kprobe）上，这些函数在不同内核版本中可能被改名或内联，在 Ubuntu 24.04 的 6.8 内核上可能挂载失败。失败时，可以用追踪点代替：下面单行命令中的 `@[kstack] = count()` 能得到类似的"I/O 来源栈"信息。

## bpftrace：自己动手

### 语法速览

bpftrace 程序由一个或多个"探针 + 过滤 + 动作"组成：

```text
探针 /过滤条件/ { 动作 }

tracepoint:block:block_rq_issue /args->bytes > 65536/ { @[comm] = count(); }
└───────── 探针 ─────────────┘ └──── 过滤 ────────┘  └────── 动作 ───────┘
```

| 元素 | 例子 | 说明 |
|---|---|---|
| 探针 | `tracepoint:block:block_rq_issue`，可简写 `t:block:block_rq_issue` | 还有 `kprobe:`、`uprobe:`、`interval:s:1`、`BEGIN`、`END` |
| 追踪点参数 | `args->bytes`、`args->sector` | bpftrace 0.20 也支持 `args.bytes` 写法 |
| 内置变量 | `comm` `pid` `tid` `nsecs` `cpu` `kstack` `ustack` | 当前进程名、PID、纳秒时间戳、栈 |
| Map | `@name[key] = ...` | 以 `@` 开头，全局，程序退出时自动打印 |
| 临时变量 | `$x = ...` | 以 `$` 开头，仅在当前动作内有效 |
| 聚合函数 | `count()` `sum(x)` `avg(x)` `hist(x)` `lhist(x, min, max, step)` | `hist` 为 2 的幂分桶 |

查看有哪些块层追踪点、各有哪些参数：

```console
$ sudo bpftrace -l 'tracepoint:block:*'
tracepoint:block:block_bio_backmerge
tracepoint:block:block_bio_complete
tracepoint:block:block_bio_queue
tracepoint:block:block_rq_complete
tracepoint:block:block_rq_insert
tracepoint:block:block_rq_issue
...
$ sudo bpftrace -lv tracepoint:block:block_rq_issue
tracepoint:block:block_rq_issue
    dev_t dev
    sector_t sector
    unsigned int nr_sector
    unsigned int bytes
    char rwbs[8]
    char comm[16]
    __data_loc char[] cmd
```

（参数列表随内核版本略有差异，较新的内核还有 `ioprio` 等字段，以 `-lv` 的实际输出为准。）

### 实用单行命令

以下命令大多来自《Systems Performance》第 9 章的 bpftrace 单行命令清单，按 Ctrl-C 结束并打印结果：

```bash
# 统计各块层追踪点的事件数
sudo bpftrace -e 'tracepoint:block:* { @[probe] = count(); }'

# 按进程统计块 I/O 次数
sudo bpftrace -e 't:block:block_rq_issue { @[comm] = count(); }'

# I/O 大小直方图
sudo bpftrace -e 't:block:block_rq_issue { @bytes = hist(args->bytes); }'

# 按进程的 I/O 大小直方图
sudo bpftrace -e 't:block:block_rq_issue /args->bytes/ { @[comm] = hist(args->bytes); }'

# 按 RWBS 类型统计（R、W、WS、FWS、RA……）
sudo bpftrace -e 't:block:block_rq_issue { @[args->rwbs] = count(); }'

# 按进程和类型统计 I/O 大小
sudo bpftrace -e 't:block:block_rq_issue /args->bytes/ { @[comm, args->rwbs] = hist(args->bytes); }'

# 抓块 I/O 错误：设备号和错误码
sudo bpftrace -e 't:block:block_rq_complete /args->error/ {
  @[args->dev >> 20, args->dev & ((1 << 20) - 1), args->error] = count(); }'

# 块 I/O 插入队列时的内核栈（I/O 从哪条代码路径来）
sudo bpftrace -e 't:block:block_rq_insert { @[kstack] = count(); }'

# 块 I/O 延迟直方图（下发到完成，微秒）
sudo bpftrace -e 't:block:block_rq_issue { @s[args->dev, args->sector] = nsecs; }
  t:block:block_rq_complete /@s[args->dev, args->sector]/ {
    @us = hist((nsecs - @s[args->dev, args->sector]) / 1000);
    delete(@s[args->dev, args->sector]); }'
```

`dev` 是内核内部的设备号编码，高 12 位是主设备号、低 20 位是次设备号，所以用 `>> 20` 和 `& ((1 << 20) - 1)` 解码，得到 `259, 0` 这样的形式，可以和 `lsblk` 的 `MAJ:MIN` 列对照。错误码是负的 errno，`-5` 就是 `EIO`。

最后一条就是 `biolatency` 的核心逻辑：在下发时以"设备 + 扇区"为键记下时间戳，完成时查出来相减、放进直方图，再删掉这个键。记住这个"起点存时间戳、终点求差"的模式，大部分延迟类工具都是这么写的。

### 写一个自己的脚本

现成的 `biolatency` 能按磁盘或标志分组，但不能按进程分组，也不会同时打印异常请求。下面这个脚本做两件事：按"进程 + 请求类型"输出延迟直方图，并实时打印超过 10 ms 的请求。

```c title="biolat-comm.bt"
#!/usr/bin/env bpftrace
/*
 * biolat-comm.bt：按进程和请求类型统计块 I/O 延迟，
 * 同时打印超过 10 ms 的请求。
 * 延迟口径：下发到设备（issue）→ 完成（complete）。
 */

BEGIN
{
	printf("Tracing block I/O latency by comm, slow > 10 ms... Ctrl-C to end.\n");
}

tracepoint:block:block_rq_issue
{
	@start[args->dev, args->sector] = nsecs;
	@issuer[args->dev, args->sector] = comm;
}

tracepoint:block:block_rq_complete
/@start[args->dev, args->sector]/
{
	$us = (nsecs - @start[args->dev, args->sector]) / 1000;
	$who = @issuer[args->dev, args->sector];

	@usecs[$who, args->rwbs] = hist($us);

	if ($us > 10000) {
		time("%H:%M:%S ");
		printf("SLOW %-16s %d:%d %-4s sector=%d bytes=%d lat=%d ms\n",
		    $who, args->dev >> 20, args->dev & ((1 << 20) - 1),
		    args->rwbs, args->sector, args->nr_sector * 512, $us / 1000);
	}

	delete(@start[args->dev, args->sector]);
	delete(@issuer[args->dev, args->sector]);
}

END
{
	clear(@start);
	clear(@issuer);
}
```

运行：

```console
$ chmod +x biolat-comm.bt
$ sudo ./biolat-comm.bt
Tracing block I/O latency by comm, slow > 10 ms... Ctrl-C to end.
14:31:07 SLOW kworker/u16:2    8:0 W    sector=52428800 bytes=524288 lat=38 ms
14:31:07 SLOW postgres         8:0 FWS  sector=20480120 bytes=8192 lat=41 ms
^C

@usecs[postgres, FWS]:
[8K, 16K)            12 |@@                                                  |
[16K, 32K)          210 |@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@|
[32K, 64K)           31 |@@@@@@@                                             |

@usecs[mysqld, R]:
[128, 256)         4020 |@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@|
[256, 512)         1830 |@@@@@@@@@@@@@@@@@@@@@@@                             |
```

在这台机器（`8:0` 是一块 SATA 盘）上，后台回写的大块写和 PostgreSQL 的 `FWS`（带刷新的同步写）同一秒都超过了 30 ms：回写把盘占住，数据库的提交只能排队。这就是[I/O 调优](/learn/io-tuning)里调整脏页参数、让回写更平滑的依据。

> [!NOTE] 进程归因的局限
> 脚本在下发时记录 `comm`。同步 I/O 下发时通常就在发起进程的上下文中，归因是准确的；但异步回写、经过 plug 批量下发、或者被调度器延后下发的请求，`comm` 可能是 `kworker` 或其他进程。`biosnoop` 为此额外追踪了插入队列的事件，归因更准确。写自己的工具时，要清楚每个内置变量是在**哪个事件发生时**取的值。

> [!QUEST] 闯关：加上队列时间
> 改造 `biolat-comm.bt`：再挂一个 `tracepoint:block:block_rq_insert`，记录插入时间；在完成时分别输出"插入 → 下发"（OS 队列）和"下发 → 完成"（设备）两个直方图。提示：使用 none 调度器时很多请求不经过 insert 直接下发，要处理"没有插入时间戳"的情况。用 mq-deadline 和 none 各跑一次，对比结果。

## 火焰图：把栈画出来

当你想知道"大量 I/O 是从哪些代码路径来的"，一堆 `kstack` 文本很难读，**火焰图（Flame Graph）**能把成千上万个调用栈合并成一张图：横轴宽度代表出现次数，纵轴是调用深度。

```bash
git clone https://github.com/brendangregg/FlameGraph
cd FlameGraph

# 方法一：perf 采集块 I/O 插入时的栈
sudo perf record -e block:block_rq_insert -a -g -- sleep 10
sudo perf script | ./stackcollapse-perf.pl | ./flamegraph.pl --title "Block I/O" > bio.svg

# 方法二：bpftrace 在内核中聚合，只输出汇总结果
sudo bpftrace -e 't:block:block_rq_insert { @[kstack, ustack, comm] = count(); }
  interval:s:10 { exit(); }' > out.bt
./stackcollapse-bpftrace.pl out.bt | ./flamegraph.pl > bio-bpf.svg
```

还有一种对 I/O 分析非常有用的火焰图：**Off-CPU 火焰图**。它显示线程**不在 CPU 上运行时**阻塞在哪里——等磁盘、等锁、等网络，都会体现为 off-CPU 时间：

```bash
# 采集 PID 1788 在 30 秒内的阻塞栈（-d 区分内核/用户栈，-f 输出折叠格式）
sudo offcputime-bpfcc -df -p 1788 30 > out.offcpu
./flamegraph.pl --color=io --title="Off-CPU" --countname=us < out.offcpu > offcpu.svg
```

用浏览器打开 SVG，可以点击放大某一段。如果看到一大片栈顶是 `io_schedule`、下面是 `ext4_sync_file` → `jbd2_log_wait_commit`，意思就是：这个进程大量时间阻塞在 ext4 日志提交上。这类信息 `iostat` 永远给不了你。

> [!PROD] 生产环境使用 BPF 的注意事项
> BPF 的开销与事件频率成正比：挂在块 I/O 上（每秒几万到几十万次）通常可以接受，但挂在每次 `vfs_read` 或调度事件上，高负载下开销会明显增加。生产上先用短时间（10～30 秒）、带过滤条件的方式运行，观察 CPU 开销后再决定是否延长；`biosnoop` 这类逐事件输出的工具，要重定向到文件并限定时长，避免终端输出本身成为瓶颈。

## 动手练习

1. **对比 `-Q`。** 把测试盘调度器设为 `mq-deadline`，用 fio 以 iodepth=256 做 4 KiB 随机读，分别运行 `sudo biolatency-bpfcc 10 1` 和 `sudo biolatency-bpfcc -Q 10 1`，说明两个直方图的差别代表什么。
2. **抓刷新请求。** 用 `fio --name=sync --directory=/mnt/test --rw=write --bs=4k --size=128m --fsync=1` 制造 `fsync` 负载，运行 `sudo biolatency-bpfcc -F 10 1`，找出 Flush 请求的延迟分布；再用 `biosnoop-bpfcc` 找出 `BYTES` 为 0 的请求。
3. **单行命令练习。** 在实验机上分别运行本课的 bpftrace 单行命令：按进程统计 I/O 次数、按 RWBS 统计、按进程的 I/O 大小直方图，并用 `lsblk` 核对错误追踪命令中的设备号解码是否正确。
4. **运行并改造脚本。** 运行 `biolat-comm.bt`，同时用 `dd if=/dev/zero of=/mnt/test/big bs=1M count=4096` 制造回写，观察 `kworker` 的延迟直方图；然后完成上面的闯关任务。
5. **画一张火焰图。** 在运行 fio 或 `tar` 打包大目录时，用 perf 方法采集 `block:block_rq_insert` 的栈并生成火焰图，找出最宽的那条路径对应的系统调用。

## 自测

<details>
<summary>BPF 工具为什么能在生产环境中比 `perf record`、`blktrace` 开销更低？</summary>

BPF 程序可以在内核中直接做聚合（计数、直方图、按键汇总），只把汇总结果周期性地交给用户态；而 `perf record`、`blktrace` 需要把每一个事件都写入缓冲区、拷贝到用户态再落盘，事件频率高时拷贝和存储开销很大。另外 BPF 程序经过验证器检查并 JIT 编译成机器码执行，本身效率很高。

</details>

<details>
<summary>`biolatency` 带与不带 `-Q` 时测量的分别是什么？两者差距大说明什么？</summary>

不带 `-Q` 测量的是从下发到设备（issue）到完成的时间，即设备服务时间；带 `-Q` 从请求插入 OS 队列开始计时，包含 OS 队列等待。两者差距大说明请求在 OS 里排队的时间长，比如应用并发超过了设备队列深度、调度器在节流，或者 `nr_requests` 限制；这时换更快的设备未必有效，应先查排队的原因。

</details>

<details>
<summary>`biolatency -F` 显示同步写只要几十微秒，而 Flush 要几毫秒，说明什么？对数据库有什么影响？</summary>

说明写入被设备的易失性写缓存吸收了，真正落盘发生在刷新时；刷新需要把缓存写入 NAND，所以慢。数据库每次 `fsync` 提交通常都伴随刷新请求，提交延迟主要由刷新延迟决定。带掉电保护（PLP）的企业级 SSD 可以安全地直接确认刷新，刷新延迟会低得多。

</details>

<details>
<summary>写 bpftrace 延迟工具时，为什么用"设备 + 扇区"作为 Map 的键？完成后为什么要 `delete`？</summary>

因为在下发和完成两个事件之间需要找到同一个请求，而追踪点参数里可以同时拿到的标识就是设备号和起始扇区，组合起来在同一时刻基本唯一。完成后删除键，一是避免 Map 无限增长占用内核内存，二是防止之后同一位置的新请求误用旧的时间戳。

</details>

<details>
<summary>Off-CPU 火焰图和普通的 CPU 火焰图有什么区别？它为什么适合分析 I/O 问题？</summary>

CPU 火焰图显示线程在 CPU 上运行时的栈，回答"CPU 时间花在哪里"；Off-CPU 火焰图显示线程被阻塞、不在 CPU 上时的栈，并以阻塞时长加权，回答"线程在等什么"。I/O 等待本质上就是 off-CPU 时间，所以它能直接显示进程阻塞在哪条 I/O 路径上（比如日志提交、页面读取、锁等待），这是 CPU 剖析看不到的。

</details>

## 参考资料

- [Brendan Gregg：Systems Performance, 2nd Edition](https://www.brendangregg.com/systems-performance-2nd-edition-book.html)（第 9 章 9.6、第 15 章 BPF）
- [Brendan Gregg：BPF Performance Tools](https://www.brendangregg.com/bpf-performance-tools-book.html)
- [BCC 项目](https://github.com/iovisor/bcc)（工具文档与 `*_example.txt` 示例）
- [bpftrace 项目与参考手册](https://github.com/bpftrace/bpftrace)
- [bpftrace 单行命令教程](https://github.com/bpftrace/bpftrace/blob/master/docs/tutorial_one_liners.md)
- [Brendan Gregg：Flame Graphs](https://www.brendangregg.com/flamegraphs.html) / [Off-CPU Analysis](https://www.brendangregg.com/offcpuanalysis.html)
- [FlameGraph 工具](https://github.com/brendangregg/FlameGraph)
- [Linux 内核文档：BPF](https://docs.kernel.org/bpf/index.html)
