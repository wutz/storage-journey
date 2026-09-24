# 文件系统观测：缓存与延迟

上一课我们在块设备层把磁盘看得很清楚了，但应用并不直接和磁盘打交道——它调用的是 `read()`、`write()`、`open()`、`fsync()`，面对的是文件系统和页缓存。一个 99% 命中缓存的读负载，磁盘可能闲得发慌，应用却因为那 1% 的未命中而抖动；一次后台回写可以把磁盘 `w_await` 冲到 50 ms，但没有任何应用在等它。**只看磁盘，你会既漏报又误报。**

这一课把观测点上移到文件系统层：先用 `free`、`vmstat`、`sar -B`、`/proc/meminfo` 看清页缓存的状态，再用 BCC 工具 `cachestat`、`cachetop` 看命中率，用 `vfsstat`、`vfscount` 看 VFS 操作的构成，用 `ext4slower`、`xfsslower`、`ext4dist` 直接测量文件系统操作的延迟，最后用 `filetop`、`opensnoop` 找到具体的文件。学完你能：说清楚为什么判断"应用是否被存储拖慢"应该看文件系统延迟；读懂内存和缓存指标；在几分钟内找出慢的是哪个进程、哪个文件、哪种操作。本课主要取材于《Systems Performance》第 8 章。

## 为什么要在文件系统层测延迟

《Systems Performance》第 8 章开宗明义：**文件系统延迟是文件系统性能的首要指标**。理由有三个。

第一，应用等的就是它。应用发起一次 `read()`，它感受到的时间就是这次系统调用在文件系统里花的时间，不管里面有没有磁盘 I/O。

第二，**逻辑 I/O 和物理 I/O 可能毫无对应关系**。书里列举了几种情况：

| 情况 | 例子 |
|---|---|
| 无关（Unrelated） | 磁盘 I/O 来自别的应用、别的租户，或者 scrub、RAID 重建 |
| 间接（Indirect） | 预读、后台回写：发生了磁盘 I/O，但没有应用在等 |
| 隐式（Implicit） | 读文件导致 `atime` 更新，产生额外的元数据写 |
| 缩小（Deflated） | 缓存命中；多次写被合并成一次回写 |
| 放大（Inflated） | 元数据、日志、RAID 校验、副本让一次逻辑写变成多次物理写 |

书中有个例子很能说明问题：应用写 1 个字节，最终可能导致文件系统先读入一个 128 KiB 的记录（因为要做读-改-写），再写出数据块、元数据块和日志——1 字节变成了几百 KiB 的物理 I/O。

第三，**文件系统层的等待，磁盘统计里看不到**。等 inode 锁、等日志提交、等脏页限流（`balance_dirty_pages`）、等内存回收，这些时间都算在应用头上，但 `iostat` 一个字都不会告诉你。

> [!NOTE] 用"占比"说话
> 书里建议把文件系统延迟放到业务上下文里看：一次业务请求耗时 200 ms，其中文件系统操作累计 180 ms，那么文件系统占 90%，优化它才有意义；如果只占 2 ms，文件系统再慢也不是主要矛盾。这就是[性能分析方法论](/learn/methodology)里延迟分析的思路。

### 在哪一层测

| 测量点 | 优点 | 缺点 |
|---|---|---|
| 应用内部（日志、APM） | 有完整业务上下文 | 需要改代码或依赖应用自带指标 |
| 系统调用层（`strace`、`syscount`） | 通用，所有应用都适用 | 文件、套接字、管道的 `read()` 混在一起，需要区分 |
| VFS 层（`vfsstat`、`fileslower`） | 覆盖所有文件系统类型 | 同样混有非存储类文件；函数接口可能随内核变化 |
| 具体文件系统（`ext4slower`、`xfsdist`） | 只看这类文件系统，最精准 | 每种文件系统一套工具，依赖内核内部函数 |

实践中，**先用具体文件系统的工具**（ext4/XFS/Btrfs 等都有对应版本），不适用时退回到 VFS 层。

## 看清页缓存：free、vmstat、sar

[页缓存](/learn/page-cache)一课讲过它的原理，这里只讲怎么观测。

### free

```console
$ free -wm
               total        used        free      shared     buffers       cache   available
Mem:           31828        4120        1022          12         210       26476       27208
Swap:           4095           0        4095
```

`-w` 把 `buffers`（块设备元数据缓存）和 `cache`（页缓存 + 可回收 slab）分开显示。最重要的是 `available`：在不换出的前提下还能给新应用用多少内存，它把可回收的缓存也算了进去。`free` 只有 1 GB 不代表内存紧张——Linux 会用空闲内存做缓存，"空闲内存"本来就应该很少。

### /proc/meminfo

更细的数据在这里：

```console
$ grep -E '^(MemFree|Buffers|Cached|Active\(file\)|Inactive\(file\)|Dirty|Writeback|Shmem):' /proc/meminfo
MemFree:         1046528 kB
Buffers:          215040 kB
Cached:         27093504 kB
Active(file):   12582912 kB
Inactive(file): 14680064 kB
Dirty:            524288 kB
Writeback:         20480 kB
Shmem:             12288 kB
```

| 字段 | 含义 | 看什么 |
|---|---|---|
| `Cached` | 页缓存大小（含 `Shmem`/tmpfs） | 缓存能装下多少热数据 |
| `Active(file)` / `Inactive(file)` | 文件页的活跃/非活跃 LRU 链表 | 回收优先从 `Inactive` 下手 |
| `Dirty` | 等待回写的脏页 | 持续很大说明写入快于回写 |
| `Writeback` | 正在回写的页 | 长期不为零说明回写跟不上 |
| `Shmem` | 共享内存和 tmpfs | 这部分"缓存"不能被丢弃 |

`Dirty` 和 `Writeback` 是写路径最值得盯的两个数。一边 `dd` 写大文件一边 `watch -n1 "grep -E 'Dirty|Writeback:' /proc/meminfo"`，你能看到 `Dirty` 先涨到阈值、然后回写开始、写入速度被限流——这就是 [I/O 调优](/learn/io-tuning)里 `vm.dirty_*` 参数控制的过程。

### vmstat 与 sar -B

```console
$ vmstat -SM 1 3
procs -----------memory---------- ---swap-- -----io---- -system-- ------cpu-----
 r  b   swpd   free   buff  cache   si   so    bi    bo   in   cs us sy id wa st
 1  2      0   1022    210  26476    0    0 403120  1024 18210 30115  3  9 70 18  0
 2  1      0    998    210  26501    0    0 398870   980 17952 29870  3  9 71 17  0
 1  2      0   1005    210  26489    0    0 401220  1102 18105 30002  3  9 70 18  0
```

`bi`/`bo` 是每秒从块设备读入/写出的 KiB，`si`/`so` 是换入换出（不为零要警惕）。

`sar -B` 给出页面换入换出和回收的统计：

```console
$ sar -B 1 3
14:30:01     pgpgin/s pgpgout/s   fault/s  majflt/s  pgfree/s pgscank/s pgscand/s pgsteal/s    %vmeff
14:30:02    402880.00   1024.00   2210.00      0.00 105880.00  98012.00      0.00  97820.00     99.80
14:30:03    399120.00    980.00   2105.00      0.00 104210.00  96850.00      0.00  96700.00     99.85
```

| 列 | 含义 |
|---|---|
| `pgpgin/s` `pgpgout/s` | 每秒从磁盘换入/写出的 KiB |
| `majflt/s` | 需要读磁盘的缺页（mmap 文件未缓存、换出页） |
| `pgscank/s` | kswapd 后台扫描的页数 |
| `pgscand/s` | **直接回收**扫描的页数：分配内存的进程自己被迫去回收 |
| `%vmeff` | 回收效率 = `pgsteal / pgscan` |

`pgscand/s` 持续不为零是一个重要信号：应用在分配内存时被迫同步回收页缓存，它的 `read()`/`write()` 会因此变慢，而这在磁盘统计里完全看不出来。

> [!TIP] 这个文件在缓存里吗
> util-linux 自带的 `fincore` 能查看文件有多少页在页缓存中：`fincore /data/db/*.ibd`。在排查"为什么这次读得比上次慢"时很好用——也许是被别的负载挤出缓存了。

## BCC 工具准备

接下来的工具来自 BCC（BPF Compiler Collection）。BPF 的原理在[下一课](/learn/bpf-io-tracing)讲，这里先当成好用的命令行工具。Ubuntu 24.04 上安装：

```bash
sudo apt install -y bpfcc-tools linux-headers-$(uname -r)
ls /usr/sbin/*-bpfcc | head      # Ubuntu 上所有 BCC 工具都带 -bpfcc 后缀
```

> [!WARNING] 名字和兼容性
> 在 Ubuntu/Debian 上，BCC 工具的名字都加了 `-bpfcc` 后缀：`cachestat-bpfcc`、`ext4slower-bpfcc`，其他发行版（或从源码安装）则没有后缀。截至本文写作时 Ubuntu 24.04 的 BCC 是 0.29 版。像 `cachestat`、`cachetop` 这类基于 kprobe、依赖内核内部函数名的工具，在内核升级后可能因函数改名（比如页缓存相关代码的 folio 化）而报错或数据不准——书中第 8 章也提到 `cachestat` 比较脆弱。遇到这种情况，可以改用 libbpf-tools 版本或自己写 bpftrace 脚本。

## 缓存命中率：cachestat 与 cachetop

### cachestat

```console
$ sudo cachestat-bpfcc 1
    HITS   MISSES  DIRTIES HITRATIO   BUFFERS_MB  CACHED_MB
   98120    24610       12   79.95%          210      25880
   97905    24588        8   79.93%          210      25884
  121033      210       15   99.83%          210      25890
  120880      198       10   99.84%          210      25890
```

| 列 | 含义 |
|---|---|
| `HITS` | 每个间隔内页缓存命中次数 |
| `MISSES` | 未命中次数（需要从存储读入） |
| `DIRTIES` | 被标记为脏的页数（写入） |
| `HITRATIO` | 命中率 |
| `BUFFERS_MB` / `CACHED_MB` | 同 `/proc/meminfo` |

上面的输出里，命中率从 80% 跳到 99.8%，说明工作集刚刚被完整加载进缓存。命中率 80% 和 99.8% 的差别，意味着未命中从每秒 2.4 万次降到 200 次，打到磁盘的读减少了 100 多倍。

### cachetop

`cachetop` 是按进程拆开的 `cachestat`，交互式，类似 `top`：

```console
$ sudo cachetop-bpfcc 5
14:32:10 Buffers MB: 210 / Cached MB: 25880 / Sort: HITS / Order: descending
PID      UID      CMD              HITS     MISSES   DIRTIES  READ_HIT%  WRITE_HIT%
    3321 root     fio                490602   123050        0      80.0%       0.0%
    1788 postgres postgres            20511       12      412      97.9%       2.0%
     884 root     rsync                8210     8190        0      50.1%       0.0%
```

`rsync` 一半未命中——它在读冷数据，并且会把热数据挤出缓存。备份任务最好用 `nocache`、`O_DIRECT` 或放在低峰期，这类"缓存污染"是生产上经典的抖动来源。

## VFS 操作构成：vfsstat 与 vfscount

`vfsstat` 统计每秒 VFS 层各类操作的次数：

```console
$ sudo vfsstat-bpfcc 1
TIME         READ/s  WRITE/s  FSYNC/s   OPEN/s CREATE/s
14:40:01:    102310     2210        0      155        0
14:40:02:    101985     2245        0      160        0
14:40:03:    102440     5120      512     3021        0
```

（列随 BCC 版本略有不同，较新的版本还有 `UNLINK/s` 等。）第三秒 `OPEN/s` 从 150 跳到 3000、`FSYNC/s` 出现 512——有个进程在大量打开文件并同步写，下一步用 `opensnoop` 找出来。

`vfscount` 统计所有被调用的 `vfs_*` 函数，按 Ctrl-C 后输出：

```console
$ sudo vfscount-bpfcc
Tracing... Ctrl-C to end.
^C
ADDR             FUNC                          COUNT
ffffffff8f5a3b10 vfs_fsync_range                 512
ffffffff8f55e2a0 vfs_statx                      3104
ffffffff8f5489f0 vfs_open                       3322
ffffffff8f548fa0 vfs_write                     23015
ffffffff8f548c20 vfs_read                     512840
```

它们是负载特征刻画在文件系统层的版本：告诉你负载由哪些操作组成。一个"存储很慢"的应用，可能 90% 的 VFS 调用是 `vfs_statx`（在反复 stat 文件）——那就是元数据问题，而不是数据读写问题。

## 找慢操作：ext4slower、xfsslower、fileslower

这是本课最实用的一组工具：直接列出超过阈值的文件系统操作。

```console
$ sudo ext4slower-bpfcc
Tracing ext4 operations slower than 10 ms
TIME     COMM           PID    T BYTES   OFF_KB   LAT(ms) FILENAME
14:51:02 postgres       1788   S 0       0          18.32 000000010000000A00000031
14:51:02 postgres       1788   S 0       0          21.07 000000010000000A00000031
14:51:05 java           2210   R 131072  803520     12.05 app-2026-09-24.log
14:51:07 python3        4410   O 0       0          15.88 dataset-0042.tar
```

| 列 | 含义 |
|---|---|
| `T` | 操作类型：`R` 读、`W` 写、`O` 打开、`S` fsync |
| `BYTES` | 读写字节数 |
| `OFF_KB` | 文件内偏移（KiB） |
| `LAT(ms)` | 从 VFS 调入 ext4 到返回的耗时 |
| `FILENAME` | 文件名（不含路径） |

从这几行就能读出：PostgreSQL 的 WAL `fsync` 要 18～21 ms，这几乎一定会反映在事务延迟上；Java 读一个日志文件偏移 800 MB 处用了 12 ms，是冷数据；Python 打开一个文件用了 16 ms，打开操作本身慢，可能是目录很大或元数据不在缓存中。

常用选项：

```bash
sudo ext4slower-bpfcc 1          # 阈值改为 1 ms
sudo ext4slower-bpfcc 0          # 阈值 0：输出所有操作（量会很大，慎用）
sudo ext4slower-bpfcc -p 1788    # 只看某个进程
sudo ext4slower-bpfcc -j 5       # 输出 CSV 格式，便于后处理
```

XFS 用 `xfsslower-bpfcc`，用法相同；Btrfs、NFS、ZFS 也有对应的 `btrfsslower`、`nfsslower`、`zfsslower`。

`fileslower-bpfcc` 在 VFS 层工作，适用于任意文件系统，但只跟踪同步的读写：

```console
$ sudo fileslower-bpfcc 10
Tracing sync read/writes slower than 10 ms
TIME(s)  COMM           TID    D BYTES   LAT(ms) FILENAME
0.805    java           2210   R 131072    12.10 app-2026-09-24.log
2.117    backup.sh      884    W 1048576   35.62 db-snapshot.tar
```

> [!PROD] 把慢操作和磁盘延迟对上
> 慢操作出现时，同时看 `biolatency` 或 `iostat`：磁盘延迟同步升高，说明文件系统层的慢是磁盘造成的；磁盘很平稳，说明慢在文件系统内部（锁、日志、脏页限流、内存回收）。这正是[方法论](/learn/methodology)里"比较各层延迟"的判断方法，也是 on-call 时最快分清"找存储组还是找内核组"的手段。

## 看分布：ext4dist 与 xfsdist

`*slower` 看异常值，`*dist` 看整体分布：

```console
$ sudo ext4dist-bpfcc 10 1
Tracing ext4 operation latency... Hit Ctrl-C to end.

14:55:10:

operation = read
     usecs               : count     distribution
         0 -> 1          : 1520     |***                                     |
         2 -> 3          : 18230    |****************************************|
         4 -> 7          : 9012     |*******************                     |
         8 -> 15         : 1203     |**                                      |
        16 -> 31         : 88       |                                        |
        32 -> 63         : 12       |                                        |
        64 -> 127        : 310      |                                        |
       128 -> 255        : 2810     |******                                  |
       256 -> 511        : 1920     |****                                    |
       512 -> 1023       : 205      |                                        |
      1024 -> 2047       : 18       |                                        |

operation = write
     usecs               : count     distribution
         0 -> 1          : 0        |                                        |
         2 -> 3          : 412      |**********                              |
         4 -> 7          : 1605     |****************************************|
         8 -> 15         : 820      |********************                    |
        16 -> 31         : 65       |*                                       |

operation = fsync
     usecs               : count     distribution
       512 -> 1023       : 12       |****                                    |
      1024 -> 2047       : 108      |****************************************|
      2048 -> 4095       : 51       |******************                      |
```

读的分布是典型的双峰：0～15 µs 是页缓存命中，128～1023 µs 是落到磁盘的读。《Systems Performance》第 8 章的 ext4dist 例子就是这种形状。如果只看平均值（这里约 50 µs），你会得到一个两个峰都不代表的数字。写全部在 30 µs 以内——被页缓存吸收了；`fsync` 在 1～4 ms，才是真正付出磁盘代价的操作。

> [!NOTE] 缓存命中率高时的平均值
> 书里特别提醒：命中率超过 99% 时，平均延迟几乎完全由命中决定，会显得非常好看，而真正影响体验的是那不到 1% 的未命中。看文件系统延迟一定要看分布或百分位。

常用选项：`-m` 以毫秒为单位，`-p PID` 只看某个进程，`10 6` 表示每 10 秒输出一次、共 6 次。XFS 用 `xfsdist-bpfcc`。

## 找文件：filetop 与 opensnoop

### filetop

按文件排序的读写量，就像文件版的 `top`：

```console
$ sudo filetop-bpfcc -C 5
14:58:01 loadavg: 3.12 2.40 1.88 5/812 4410

TID     COMM             READS  WRITES R_Kb    W_Kb    T FILE
3321    fio              490120 0      1960480 0       R testfile
884     rsync            8190   0      1048320 0       R db-snapshot-0923.tar
1788    postgres         0      2560   0       20480   R 000000010000000A00000031
```

`T` 列表示文件类型：`R` 普通文件、`S` 套接字、`O` 其他。默认只显示普通文件，`-a` 显示全部。其他选项：`-C` 不清屏（适合记录）、`-r 20` 显示 20 行、`-s` 按 `reads`/`writes`/`rbytes`/`wbytes`/`all` 排序、`-p PID` 只看某个进程。

注意 `filetop` 统计的是 VFS 层的读写，包含缓存命中，所以 fio 读的 1.9 GB 里大部分可能根本没碰磁盘——这正是逻辑 I/O 与物理 I/O 的区别。

### opensnoop

追踪每一次 `open()` 系列调用：

```console
$ sudo opensnoop-bpfcc -T
TIME(s)       PID    COMM               FD ERR PATH
0.000000000   1788   postgres           23   0 base/16384/2619
0.001203000   2410   nginx              -1   2 /var/www/html/favicon.ico
0.001350000   2410   nginx              -1   2 /var/www/html/favicon.ico
0.105220000   4410   python3            12   0 /data/train/dataset-0042.tar
```

`ERR` 为 2 即 `ENOENT`（文件不存在）。常用选项：`-x` 只显示失败的打开、`-p PID`、`-n name` 按进程名过滤、`-d 10` 运行 10 秒。

`opensnoop` 在排查元数据问题时价值极高：一个应用每秒几千次打开不存在的文件（比如在一长串路径里查找配置或库），在 NFS、CephFS 这类分布式文件系统上，每次失败的查找都可能是一次网络往返，积少成多就是"文件系统慢"（参见[元数据与分布式文件系统](/learn/distributed-fs)）。

## 一个完整的排查流程

把本课的工具串起来，排查"应用读文件慢"：

```text
1. ext4dist / xfsdist      看读延迟分布：是否双峰？慢峰占多少？
        │
2. cachestat / cachetop    命中率多少？是谁在造成未命中？
        │
3. ext4slower 1            哪些文件、哪些操作慢？R/W/O/S 哪一类？
        │
4. biolatency / iostat     同时刻磁盘延迟是否也高？
        │
   ┌────┴────────────────────────┐
   磁盘也慢                      磁盘正常
   → 磁盘/负载问题               → 文件系统内部：锁、日志、回收
   （回到 disk-observability）   （sar -B 看 pgscand，offcputime 看阻塞栈）
```

## 动手练习

1. **观察缓存的冷热。** 在测试文件系统上用 `dd if=/dev/urandom of=/mnt/test/f1 bs=1M count=2048` 生成文件，执行 `sync; echo 3 | sudo tee /proc/sys/vm/drop_caches` 清缓存，然后一边运行 `sudo cachestat-bpfcc 1` 一边 `cat /mnt/test/f1 > /dev/null` 两次，记录两次的命中率和耗时，并用 `fincore /mnt/test/f1` 确认缓存状态。
2. **观察脏页与回写。** 一个终端运行 `watch -n1 "grep -E '^(Dirty|Writeback):' /proc/meminfo"`，另一个终端用 `dd if=/dev/zero of=/mnt/test/f2 bs=1M count=4096`（不加 `oflag=direct`）写文件，观察 `Dirty` 的涨落，再用 `iostat -xz 1` 对比磁盘写入发生的时间。
3. **抓住慢的 fsync。** 用 `fio --name=sync --directory=/mnt/test --rw=randwrite --bs=4k --size=256m --fsync=1 --runtime=30 --time_based` 制造同步写负载，同时运行 `sudo ext4slower-bpfcc 1`（XFS 用 `xfsslower-bpfcc 1`）和 `sudo ext4dist-bpfcc 10 1`，找出 `S` 类操作的延迟分布。
4. **找出失败的打开。** 运行 `sudo opensnoop-bpfcc -x`，然后在另一个终端执行 `python3 -c "import numpy"`（或随便一个命令），观察它尝试打开了多少个不存在的路径。

## 自测

<details>
<summary>为什么判断"应用是否被存储拖慢"时，文件系统层延迟比磁盘延迟更可靠？</summary>

因为应用直接等待的是文件系统操作，而逻辑 I/O 与物理 I/O 常常不对应：缓存命中的读没有磁盘 I/O；预读和后台回写产生了磁盘 I/O，却没有应用在等；元数据、日志会放大 I/O；锁等待、脏页限流、内存回收等文件系统内部的等待在磁盘统计中完全不可见。所以磁盘延迟既可能误报也可能漏报。

</details>

<details>
<summary>`free` 显示 `free` 只有 1 GB，`available` 有 27 GB，内存紧张吗？</summary>

不紧张。Linux 会把空闲内存用作页缓存，`free` 小是正常的。`available` 估算的是不需要换出就能提供给新应用的内存，包括可回收的缓存，27 GB 说明内存很充裕。真正的内存压力信号是 `available` 很小、`sar -B` 中 `pgscand/s` 持续不为零、出现换入换出等。

</details>

<details>
<summary>`ext4dist` 显示读延迟分布有两个峰，一个在 2～7 µs，一个在 128～511 µs，分别代表什么？此时为什么不能只看平均值？</summary>

2～7 µs 的峰是页缓存命中，128～511 µs 的峰是需要从磁盘（SSD）读取的未命中。平均值会落在两峰之间，两边都不代表；而且命中率越高，平均值越被命中主导而显得好看，真正影响体验的未命中被掩盖。应分别关注慢峰的位置和占比。

</details>

<details>
<summary>`ext4slower` 显示某个进程的 `S` 类操作频繁超过 20 ms，但 `iostat` 显示磁盘 `w_await` 只有 1 ms 左右，可能是什么原因？如何继续排查？</summary>

`S` 表示 fsync。磁盘本身不慢而 fsync 慢，说明时间花在文件系统内部：比如等待日志（jbd2 / XFS log）提交、与其他进程的 fsync 串行、大量脏页需要先回写、`f/s` 刷新请求慢（可对照 `iostat` 的 `f_await`）等。可以继续用 `offcputime-bpfcc` 查看该进程阻塞时的内核栈，或用 `biolatency -F` 按请求标志查看 flush 请求的延迟。

</details>

<details>
<summary>在 Ubuntu 24.04 上运行 `cachestat` 提示命令不存在，应该怎么办？如果它能运行但报 kprobe 挂载失败呢？</summary>

Ubuntu 上 BCC 工具带 `-bpfcc` 后缀，应安装 `bpfcc-tools` 和当前内核的 `linux-headers-$(uname -r)`，然后运行 `cachestat-bpfcc`。如果报 kprobe 挂载失败，通常是它依赖的内核内部函数在新内核中改名或被内联了（kprobe 类工具的固有脆弱性），可以改用 libbpf-tools 版本、升级 BCC，或用 bpftrace 基于稳定的追踪点自己写脚本。

</details>

## 参考资料

- [Brendan Gregg：Systems Performance, 2nd Edition](https://www.brendangregg.com/systems-performance-2nd-edition-book.html)（第 8 章 文件系统）
- [BCC 项目与工具文档](https://github.com/iovisor/bcc)
- [BCC：ext4slower 示例](https://github.com/iovisor/bcc/blob/master/tools/ext4slower_example.txt)
- [BCC：cachestat 示例](https://github.com/iovisor/bcc/blob/master/tools/cachestat_example.txt)
- [Linux 内核文档：/proc/meminfo](https://docs.kernel.org/filesystems/proc.html#meminfo)
- [Brendan Gregg：Linux Page Cache Hit Ratio](https://www.brendangregg.com/blog/2014-12-31/linux-page-cache-hit-ratio.html)
- [Ubuntu 软件包：bpfcc-tools](https://packages.ubuntu.com/noble/bpfcc-tools)
