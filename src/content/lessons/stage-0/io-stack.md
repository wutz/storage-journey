# 一次 write() 的旅程：Linux I/O 栈

应用程序里一行 `write(fd, buf, 4096)`，返回时花了 5 微秒；换成 `fsync(fd)`，花了 5 毫秒——整整一千倍。差距从哪来？数据在这中间经过了哪些地方，停在了哪里，又是被谁送到盘上的？

这一课带你从系统调用一路走到设备：VFS、页缓存、文件系统、块层（bio、request、blk-mq、调度器）、驱动，最后到达盘上的介质。我们会画一张完整的 I/O 栈图，并用 `strace`、`/proc`、`/sys` 和 bpftrace 亲眼看到数据在每一层的样子。**这张图是整套课程的地图**：后面讲页缓存、讲 `iostat`、讲 BPF 追踪、讲 Ceph OSD，都会指回这里的某一层。

## 为什么需要一张地图

Gregg 在《Systems Performance》第 8 章专门讲过一个让新手困惑的现象：**应用发起的逻辑 I/O（Logical I/O）和磁盘上的物理 I/O（Physical I/O）往往对不上**。应用写了 1 GB，盘上可能一个字节都还没写（在缓存里）；应用只读了 4 KB，盘上可能读了 128 KB（预读）；应用写了一个字节，盘上可能写了三次（数据块、日志、元数据）。

如果你脑子里没有这张地图，看到"应用说写得很慢、`iostat` 说盘很闲"就会束手无策。有了地图，你就能问出正确的问题：I/O 卡在哪一层？是在页缓存里等回写限流，还是在块层排队，还是设备本身慢？

## 全景图

先看全貌，后面逐层展开。左边是一次**缓冲写（Buffered Write）**，右边是一次**直接 I/O（Direct I/O）**：

```text
 +----------------------------------------------------------------+
 | App: write(fd, buf, 4096)                                      |  用户态
 | libc: fwrite()/printf() may buffer in user space first         |
 +-------------------------------+--------------------------------+
 ================================|================================= 系统调用：用户态 -> 内核态
                                 v
 +----------------------------------------------------------------+
 | VFS: ksys_write() -> vfs_write() -> file->f_op->write_iter()   |  虚拟文件系统
 +-------------------------------+--------------------------------+
                                 v
 +----------------------------------------------------------------+
 | File system (ext4 / XFS): ext4_file_write_iter()               |  文件系统
 |                                                                |
 |  buffered (default)              |  O_DIRECT                   |
 |  copy data into Page Cache,      |  map file offset -> LBA,    |
 |  mark folio dirty, RETURN        |  build bio from user pages  |
 |        :                         |                             |
 |        : later: flusher kworker, |                             |
 |        : fsync(), memory reclaim |                             |
 |        v                         |                             |
 |  ->writepages(): allocate blocks,|                             |
 |  build bio; journal (jbd2 / log) |                             |
 +----------------------------------+--------------+--------------+
                                                   | struct bio
                                                   v
 +----------------------------------------------------------------+
 | Block layer: submit_bio()                                      |  块层
 |   [stacked drivers: device-mapper (LVM), md (RAID)] remap bio  |
 |   blk-mq: plug -> merge -> I/O scheduler -> request + tag      |
 |           per-CPU software queues -> hardware dispatch queues  |
 +-------------------------------+--------------------------------+
                                 | struct request
                                 v
 +----------------------------------------------------------------+
 | Driver: nvme / virtio_blk / sd (SCSI) + libata / HBA           |  设备驱动
 +-------------------------------+--------------------------------+
 ================================|================================= PCIe / SAS / SATA / virtio
                                 v
 +----------------------------------------------------------------+
 | Device: controller -> volatile write cache -> NAND / platter   |  设备
 +----------------------------------------------------------------+

 completion: IRQ (MSI-X) -> blk_mq_complete_request() -> bio_endio()
             -> end page writeback / wake up the waiting task
```

记住一个关键事实：**缓冲写在"RETURN"那一行就返回给应用了**，下面的一切都是之后异步发生的。而直接 I/O 要一路走到设备、等到中断回来，`write()` 才返回。

> [!LAB] 准备实验盘
> 本课的实验需要一个挂载好的 ext4 文件系统。用[搭建实验环境](/learn/lab-environment)里准备的一块空白数据盘（下面以 `/dev/vdc` 为例，**先 `lsblk -f` 确认，替换成你自己的设备名**）：
>
> ```bash
> lsblk -f /dev/vdc                 # 确认没有文件系统、没有挂载点
> sudo mkfs.ext4 -q /dev/vdc
> sudo mkdir -p /mnt/lab
> sudo mount /dev/vdc /mnt/lab
> sudo chown $USER /mnt/lab
> ```

## 第 1 站：用户态与系统调用

### 应用自己的缓冲

数据的第一站其实还没进内核。C 标准库的 `fwrite()`、`printf()`，Python 的 `f.write()`，Java 的 `BufferedOutputStream`，都会先把数据攒在**进程自己的内存**里，攒够一块（通常 4～8 KB）或遇到 `fflush()`、换行（终端输出时）才真正调用一次 `write()`。

这意味着：进程被 `kill -9` 时，用户态缓冲里的数据连页缓存都没进，直接丢了。`fsync()` 也救不了它，因为 `fsync()` 只管内核里的数据。

### 系统调用

`write()` 是一个系统调用（System Call）：CPU 从用户态切换到内核态，执行内核的 `ksys_write()`，完成后再切回来。一次模式切换本身只要一百纳秒量级，但如果应用每次只写几个字节，系统调用的开销就会占大头——这就是为什么应用要做用户态缓冲。

用 `strace` 看一个进程到底发了哪些与文件相关的系统调用，`-T` 显示每次调用耗时，`-P` 只看访问指定路径的调用：

```console
$ strace -T -P /mnt/lab/s dd if=/dev/zero of=/mnt/lab/s bs=4k count=2 conv=fsync status=none
openat(AT_FDCWD, "/mnt/lab/s", O_WRONLY|O_CREAT|O_TRUNC, 0666) = 3 <0.000052>
dup2(3, 1)                              = 1 <0.000004>
close(3)                                = 0 <0.000003>
write(1, "\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0"..., 4096) = 4096 <0.000024>
write(1, "\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0"..., 4096) = 4096 <0.000011>
fsync(1)                                = 0 <0.004127>
close(1)                                = 0 <0.000005>
```

看耗时：两次 `write()` 各十几到二十几微秒，一次 `fsync()` 4 毫秒。`write()` 只是把数据拷进了内存，`fsync()` 才真正等数据（以及文件系统元数据）落到盘上。这就是开篇那个"一千倍"的来源。

## 第 2 站：VFS——所有文件系统的统一门面

虚拟文件系统（Virtual File System，VFS）是内核里的一层抽象。ext4、XFS、NFS、CephFS、`/proc`、`tmpfs` 实现各不相同，但应用都用同一套 `open`/`read`/`write` 访问它们，靠的就是 VFS。

VFS 定义了几个核心对象：

| 对象 | 代表什么 | 说明 |
|---|---|---|
| `file` | 一次打开 | 保存当前偏移、打开标志（如 `O_DIRECT`），每次 `open()` 产生一个 |
| `dentry` | 路径中的一个名字 | 目录项缓存（dcache）加速路径查找 |
| `inode` | 一个文件本身 | 大小、权限、数据块位置等元数据 |
| `address_space` | 文件在内存中的页缓存 | 挂在 inode 上，管理这个文件被缓存的所有页 |
| `super_block` | 一个已挂载的文件系统 | 每次 `mount` 产生一个 |

`vfs_write()` 做完权限、文件锁等通用检查后，调用 `file->f_op->write_iter()`——这是一个函数指针，指向具体文件系统的实现，ext4 上就是 `ext4_file_write_iter()`。用 bpftrace 可以看到 VFS 层每种操作被调用的频率：

```console
$ sudo bpftrace -e 'kprobe:vfs_read, kprobe:vfs_write, kprobe:vfs_fsync_range { @[probe] = count(); } interval:s:5 { exit(); }'
Attaching 4 probes...

@[kprobe:vfs_fsync_range]: 3
@[kprobe:vfs_write]: 412
@[kprobe:vfs_read]: 1207
```

## 第 3 站：页缓存——大部分写入到此为止

页缓存（Page Cache）是内核用空闲内存缓存文件数据的机制，也是 Linux 文件 I/O 快的根本原因。缓冲写在这一站做三件事：

1. 在文件的 `address_space` 里找到（或分配）对应偏移的内存页（新内核里叫 folio，可以是多个页组成的大页）；
2. 把用户缓冲区的数据**拷贝**进去，把页标记为**脏（Dirty）**；
3. 返回。

就这样，`write()` 结束了，数据此刻只在内存里。Gregg 把这种策略叫作回写缓存（Write-Back Caching）：用可靠性换性能，断电时脏数据会丢。

### 脏页什么时候写回

脏页由内核的回写（Writeback）机制在之后异步写到盘上。触发时机有这么几种：

| 触发条件 | 相关参数（默认值） | 说明 |
|---|---|---|
| 脏页"太老" | `vm.dirty_expire_centisecs`（3000，即 30 秒） | flusher 线程每隔 `vm.dirty_writeback_centisecs`（500，即 5 秒）醒来一次，写回超过 30 秒的脏页 |
| 脏页太多（后台） | `vm.dirty_background_ratio`（10%） | 脏页占可用内存比例超过它，flusher 开始后台回写，应用不受影响 |
| 脏页太多（前台） | `vm.dirty_ratio`（20%） | 超过它，写入进程在 `balance_dirty_pages()` 里被**强制限流**，`write()` 开始变慢 |
| 应用主动要求 | `fsync()`、`fdatasync()`、`sync()`、`O_SYNC` | 立即写回并等待完成 |
| 内存紧张 | — | 内存回收时需要先把脏页写回才能释放 |

回写工作由名为 `kworker/uN:M` 的内核线程完成（`ps` 里会显示成 `kworker/u8:3+flush-253:32`，后面是设备号）。所以**缓冲写的物理 I/O 不是应用进程发出的，而是 kworker 发出的**——这一点在后面用 `iotop` 找"谁在写盘"时经常把人绕晕。

> [!LAB] 亲眼看到脏页
>
> ```console
> $ dd if=/dev/zero of=/mnt/lab/big bs=1M count=1024
> 1073741824 bytes (1.1 GB, 1.0 GiB) copied, 0.61 s, 1.8 GB/s
> $ grep -E '^(Dirty|Writeback):' /proc/meminfo
> Dirty:            803516 kB
> Writeback:         96256 kB
> $ time sync
> real    0m2.87s
> $ grep -E '^(Dirty|Writeback):' /proc/meminfo
> Dirty:                 8 kB
> Writeback:             0 kB
> ```
>
> `dd` 报告 1.8 GB/s，远超这块虚拟盘的能力——它测的是内存拷贝速度。`Dirty` 是还没开始写回的脏数据，`Writeback` 是正在写往设备的数据，`sync` 花的近 3 秒才是真正写盘的时间。换成 `oflag=direct` 或 `conv=fsync` 再跑一次，你会看到"真实"的速度。**这就是为什么不能用不带参数的 `dd` 测盘**。

### 读路径：命中与预读

读的时候，文件系统先查页缓存：命中就直接拷贝给应用，完全不碰盘（微秒级）；未命中才向下发 I/O，等数据读回来放进页缓存，再拷贝给应用。发现是顺序读时，内核还会**预读（Readahead）**后面的数据，默认窗口由 `/sys/block/<dev>/queue/read_ahead_kb`（通常 128）起步并动态增长。页缓存的细节、`fsync` 与持久化语义，是阶段 1 [页缓存与持久化语义](/learn/page-cache)的主题。

## 第 4 站：文件系统——把"文件偏移"翻译成"盘上地址"

文件系统在这条路上出现了两次：`write()` 时负责把数据放进页缓存（或直接 I/O 时直接组装请求）；回写时负责决定数据**放在盘上哪里**。它的核心工作是：

- **块映射**：把"文件 `big` 的第 100 MB"翻译成"设备上第 N 个扇区"。ext4 用区段（extent）记录这种映射。
- **延迟分配（Delayed Allocation）**：ext4 和 XFS 在 `write()` 时并不马上分配磁盘块，等到回写时再一次性分配，这样能为一个大文件分出连续的空间，减少碎片。
- **日志（Journal）**：修改元数据（分配了哪些块、文件大小变了）之前先写日志，保证掉电后能恢复一致状态。ext4 的日志由内核线程 `jbd2/<设备>-8` 负责提交。
- **组装 bio**：把一批连续的脏页组织成块层请求，交给下一层。

所以文件系统会**放大**或**改变** I/O：一次应用写入，可能变成数据块写入 + 日志写入 + 元数据写入。第 8 章把这叫作"逻辑 I/O 与物理 I/O 的不对等"，阶段 1 [文件系统：ext4、XFS 与挂载](/learn/filesystems)会细讲。

## 第 5 站：块层——排队、合并与调度

块层（Block Layer）是所有块设备共用的中间层。无论下面是 NVMe、SATA 还是 Ceph RBD，文件系统都只和块层打交道。

### bio：块 I/O 的基本单位

文件系统交给块层的是 `struct bio`，它描述"对哪个设备、从哪个扇区开始、读还是写、数据在哪些内存页里"：

```text
struct bio (简化)
  bi_bdev        -> 目标块设备（如 vdc）
  bi_iter.sector -> 起始扇区（512 字节为单位）
  bi_opf         -> 操作与标志：REQ_OP_WRITE | REQ_SYNC | REQ_META | REQ_PREFLUSH | REQ_FUA ...
  bi_io_vec[]    -> [ (page, offset, len), (page, offset, len), ... ]
  bi_end_io      -> I/O 完成后的回调函数
```

入口函数是 `submit_bio()`。如果设备是 LVM 逻辑卷或 md 软 RAID，bio 会先经过**堆叠驱动**：设备映射器（Device Mapper）把逻辑卷上的扇区重映射到底层物理盘上，md 把一个写拆成写多块盘（RAID 1）或写数据 + 校验（RAID 5/6）。一层层映射下去，最后才到真实设备。

### blk-mq：多队列块层

从 Linux 3.13 开始引入、5.0 起成为唯一实现的多队列块层（blk-mq），是为了让块层能跟上每秒百万次 I/O 的 NVMe 设备。老的块层只有一个请求队列、一把锁，所有 CPU 抢这一把锁，成了瓶颈。blk-mq 的设计是：

```text
   CPU0       CPU1       CPU2       CPU3          应用线程在哪个 CPU 上提交，就进哪个软件队列
    |          |          |          |
 [sw q 0]   [sw q 1]   [sw q 2]   [sw q 3]        软件暂存队列：plug 批量、合并、调度器在这里工作
     \        /             \        /
     [hw q 0]                [hw q 1]             硬件派发队列：数量对应设备的硬件队列
        |                       |
   [NVMe SQ/CQ 0]         [NVMe SQ/CQ 1]          设备的提交 / 完成队列对
```

一个 bio 在 blk-mq 里经历这几步：

1. **Plug（蓄流）**：同一个进程短时间内提交的多个 bio 先攒在进程自己的 plug 列表里，攒完一批再一起下发，给合并创造机会。
2. **Merge（合并）**：和已有请求在扇区上首尾相接的 bio 会被合并成一个更大的请求。`iostat` 里的 `rrqm/s`、`wrqm/s` 就是合并次数。
3. **I/O 调度器**：决定请求的派发顺序。可选 `none`（不调度，NVMe 的默认）、`mq-deadline`（为读写设置截止时间，防止饿死）、`kyber`（按目标延迟调节队列深度）、`bfq`（按进程公平分配带宽，适合桌面和机械盘）。
4. **request 与 tag**：bio 被装进 `struct request`，并分配一个 tag（标签），tag 的数量就是这个队列允许的最大在途请求数。拿不到 tag，就得在这里排队。
5. **派发**：请求进入硬件队列，交给驱动。

这些都能在 `/sys` 里看到：

```console
$ cat /sys/block/vdc/queue/scheduler
[none] mq-deadline
$ cat /sys/block/vdc/queue/nr_requests /sys/block/vdc/queue/max_sectors_kb
256
1280
$ cat /sys/block/vdc/queue/rotational /sys/block/vdc/queue/write_cache
1
write back
$ ls /sys/block/vdc/mq/
0  1  2  3
```

`[none]` 表示当前调度器；多队列设备默认 `none`，单队列设备默认 `mq-deadline`，你看到的可能不同。`nr_requests` 是每个队列可分配的请求数，`max_sectors_kb` 是单个请求的最大尺寸（超过就会被拆分），`mq/` 下的目录数就是硬件队列数。调度器与队列参数怎么调，是阶段 2 [I/O 调优](/learn/io-tuning)的内容。

## 第 6 站：驱动与设备

### 驱动：翻译成设备能懂的命令

驱动把 `request` 翻译成设备协议的命令：

- **NVMe**（`nvme` 驱动）：填一个 64 字节的命令放进提交队列（Submission Queue），写一下门铃（Doorbell）寄存器通知设备。NVMe 支持最多 65535 个队列、每队列 65535 深度，这就是它能配合 blk-mq 跑出百万 IOPS 的原因。
- **virtio-blk**（`virtio_blk` 驱动）：虚拟机里最常见，请求放进和宿主机共享的 virtqueue 环形队列。
- **SATA / SAS**：先经过 SCSI 层（`sd` 驱动）变成 SCSI 命令，SATA 盘再由 libata 翻译成 ATA 命令，交给 HBA 或 RAID 卡。

### 设备：数据终于落地了吗？

命令到了设备，数据先进入设备控制器，**然后很可能又进了一个缓存**：大多数 SSD 和 HDD 都有板载 DRAM 写缓存，设备收到数据放进缓存就报告"完成"。上面 `write_cache` 显示 `write back` 就表示内核认为这块设备有易失的写缓存。

所以 `fsync()` 要做的不只是把脏页写下去，还要在最后发一个**缓存刷新（FLUSH）**命令，或者给关键写入加上 **FUA（Force Unit Access）**标志，要求设备把数据真正写进介质再回复。企业级 SSD 通常带掉电保护电容，可以安全地把缓存当作持久化的；消费级盘没有，这是生产环境选盘时的一个关键点，阶段 1 [存储硬件](/learn/storage-hardware)会讲。

### 完成：原路返回

设备完成后发出中断（NVMe 用 MSI-X，每个队列一个中断向量，可以在 `/proc/interrupts` 里看到 `nvme0q1`、`nvme0q2`……），驱动在中断处理中调用 `blk_mq_complete_request()`，块层再调用 bio 的 `bi_end_io` 回调：缓冲写的话，清除页的"正在回写"标记；直接 I/O 或 `fsync` 的话，唤醒一直在等待的应用进程。旅程结束。

## 用 bpftrace 看清是谁提交了 I/O

地图画完了，来验证一下"缓冲写由 kworker 提交、直接 I/O 由应用自己提交"。块层的 `block_rq_issue` 跟踪点在请求派发给驱动时触发，`args->rwbs` 是操作类型（`W` 写、`S` 同步、`M` 元数据、`F` 刷新 / FUA）：

> [!LAB] 对比缓冲写和直接 I/O 的提交者
> 终端 1 运行追踪，按 Ctrl-C 结束并打印结果：
>
> ```bash
> sudo bpftrace -e 'tracepoint:block:block_rq_issue { @[comm, args->rwbs] = count(); }'
> ```
>
> 终端 2 先做一次缓冲写并 `sync`：
>
> ```bash
> dd if=/dev/zero of=/mnt/lab/buffered bs=1M count=256 && sync
> ```
>
> 终端 1 按 Ctrl-C，结果大致是：
>
> ```text
> @[jbd2/vdc-8, WS]: 3
> @[jbd2/vdc-8, FWFS]: 1
> @[kworker/u8:1, W]: 205
> ```
>
> 再运行追踪，终端 2 换成直接 I/O：
>
> ```bash
> dd if=/dev/zero of=/mnt/lab/direct bs=1M count=256 oflag=direct
> ```
>
> ```text
> @[dd, WS]: 256
> ```

读一下结果：

- 缓冲写时，写数据的是 `kworker`（flusher 线程），`dd` 一个请求都没发；`jbd2` 负责提交 ext4 日志，`FWFS` 表示带有刷新和 FUA 的同步写——这就是日志提交时让设备缓存落盘的动作。
- 直接 I/O 时，所有请求都由 `dd` 自己发出，并且带着 `S`（同步）标记。
- 请求个数取决于 `max_sectors_kb` 和合并情况，你的数字会不同，关注的是**谁在提交**。如果调度器不是 `none`，偶尔会看到 kworker 代为派发少量请求。

更进一步，看直接 I/O 时 `submit_bio()` 是从哪条内核调用链上来的（x86_64 上的输出，ARM64 的系统调用入口函数名不同）：

```console
$ sudo bpftrace -e 'kprobe:submit_bio /comm == "dd"/ { @[kstack(8)] = count(); }'
Attaching 1 probe...
^C

@[
    submit_bio+1
    iomap_dio_bio_iter+758
    __iomap_dio_rw+1143
    iomap_dio_rw+18
    ext4_file_write_iter+1180
    vfs_write+599
    ksys_write+115
    __x64_sys_write+25
]: 256
```

从下往上读，就是本课那张图的一条路径：系统调用 → VFS（`vfs_write`）→ 文件系统（`ext4_file_write_iter`）→ ext4 用通用的 iomap 框架做直接 I/O → `submit_bio` 进入块层。把过滤条件换成 `/comm == "kworker/u8:1"/`（换成你看到的线程名），就能看到回写路径：`wb_workfn` → `writeback_sb_inodes` → `do_writepages` → `ext4_writepages` → `submit_bio`。

## 三个维度：缓冲 / 直接、同步 / 异步、是否持久

"同步 I/O""异步 I/O""直接 I/O"经常被混着说，其实是三个独立的维度：

| 维度 | 问题 | 选项 |
|---|---|---|
| 缓冲 vs 直接 | 数据经不经过页缓存？ | 默认缓冲；`O_DIRECT` 绕过页缓存 |
| 同步 vs 异步 | 系统调用等不等 I/O 完成？ | `read`/`write` 是同步接口；`io_uring`、`libaio` 是异步接口，提交后立即返回，稍后收取完成事件 |
| 是否持久 | 返回时数据是否已在非易失介质上？ | 默认不保证；`fsync`/`fdatasync`、`O_SYNC`/`O_DSYNC` 保证 |

把常见的写法放到地图上：

| 写法 | `write()` 何时返回 | 返回时数据在哪 | 谁提交 bio | 典型用户 |
|---|---|---|---|---|
| 默认缓冲写 | 拷进页缓存后 | 内存（脏页） | flusher kworker | 绝大多数应用 |
| 缓冲写 + `fsync()` | `fsync` 等回写和 FLUSH 完成 | 介质 | 调用 `fsync` 的进程 / kworker | 数据库事务日志、配置文件保存 |
| `O_SYNC` / `O_DSYNC` | 每次写都等落盘 | 介质 | 应用进程 | 需要逐条持久化的日志 |
| `O_DIRECT` | 设备报告完成后 | 设备（**可能还在设备缓存里**） | 应用进程 | 数据库、fio 测试、Ceph BlueStore |
| `O_DIRECT` + `io_uring` / `libaio` | 提交后立即返回 | 提交时还在路上 | 应用进程 | 高性能数据库、存储引擎 |
| `mmap` 写内存 | 不调用 `write()`，直接写内存 | 内存（脏页） | flusher kworker / `msync` | 部分数据库、索引文件 |

> [!WARNING] O_DIRECT 不等于持久化
> `O_DIRECT` 只保证绕过页缓存，不保证数据穿过设备的易失写缓存，也不保证文件大小、块分配这类元数据已经提交到日志。Gregg 在第 8 章也强调了这一点：直接 I/O 类似同步写，但**没有 `O_SYNC` 的保证**。需要持久化，仍然要 `fsync`/`fdatasync` 或加 `O_DSYNC`。另外 `O_DIRECT` 要求缓冲区地址、偏移和长度按逻辑块大小对齐，否则返回 `EINVAL`。

> [!NOTE] libaio 的一个坑
> Linux 原生的 `libaio` 只有配合 `O_DIRECT` 才是真正异步的；对缓冲 I/O，它会在提交时同步阻塞。这也是为什么 fio 用 `ioengine=libaio` 时总要加 `direct=1`。`io_uring`（Linux 5.1 引入）对缓冲 I/O 也能做到异步，是新一代应用的首选。

## 每一层去哪里看

最后，把地图和观测工具对应起来。后面阶段 2 的课程会逐个展开：

| 层 | 在哪里看 | 工具 | 详见 |
|---|---|---|---|
| 系统调用 | 调用次数、耗时 | `strace -T`、`strace -c`、`perf trace` | 本课 |
| VFS | `vfs_read`/`vfs_write` 频率与延迟 | bpftrace、`opensnoop-bpfcc`、`filetop-bpfcc` | [文件系统观测](/learn/fs-observability) |
| 页缓存 | `/proc/meminfo` 的 `Cached`、`Dirty`、`Writeback` | `free`、`vmstat`、`cachestat-bpfcc` | [页缓存与持久化语义](/learn/page-cache) |
| 文件系统 | 慢操作、日志提交 | `ext4slower-bpfcc`、`ext4dist-bpfcc`、跟踪点 `ext4:*` | [文件系统观测](/learn/fs-observability) |
| 块层 | `/proc/diskstats`、`/sys/block/<dev>/stat`、队列参数 | `iostat`、`blktrace`、`biolatency-bpfcc`、`biosnoop-bpfcc` | [磁盘 I/O 观测](/learn/disk-observability)、[用 BPF 看清 I/O](/learn/bpf-io-tracing) |
| 驱动 / 设备 | `/proc/interrupts`、`/sys/block/<dev>/queue/` | `nvme smart-log`、`smartctl` | [存储硬件](/learn/storage-hardware) |

> [!TIP] 从上往下还是从下往上？
> 应用说慢时，先从上往下：应用看到的延迟是多少？在 VFS 层有多少？到块层还剩多少？哪一层"吃掉"了时间，问题就在哪一层。只盯着 `iostat` 看是从下往上，容易漏掉页缓存限流、文件系统锁这类块层以上的问题。

这张地图对分布式存储同样适用：Ceph 客户端挂载 RBD 时，块层下面的"驱动"变成了 `rbd` 内核模块，"设备"变成了网络另一端的 OSD；而每个 OSD 进程自己又在服务器上用 `O_DIRECT` + 异步 I/O 走一遍这张图，直达本地的 NVMe。到阶段 3 学 [Ceph 架构](/learn/ceph-architecture)时，你会看到这张图被"复制"了好几份。

## 动手练习

1. 用 `strace -T -P <文件>` 分别跟踪 `dd ... bs=4k count=100`、加 `conv=fsync`、加 `oflag=direct`、加 `oflag=dsync` 四种写法，比较单次 `write()` 和 `fsync()` 的耗时，把结果对应到"三个维度"表格中。
2. 执行 `watch -n1 "grep -E '^(Dirty|Writeback):' /proc/meminfo"`，另一个终端写入 2 GB 文件，观察 `Dirty` 何时开始下降，把它和你的内存大小、`vm.dirty_background_ratio` 对应起来。
3. 运行本课的 `block_rq_issue` 追踪，分别用缓冲写、`oflag=direct` 写，确认请求的提交者；再把 `/sys/block/<dev>/queue/scheduler` 改成 `mq-deadline` 重复一次，看结果有没有变化。
4. 执行 `sudo bpftrace -e 'kprobe:submit_bio /comm == "dd"/ { @[kstack(8)] = count(); }'` 并用 `dd ... oflag=direct` 触发，把输出的调用栈逐行对应到本课的全景图上。
5. 不看本课，在纸上画出从 `write()` 到设备的 I/O 栈，标出缓冲写"返回"的位置和 `fsync()` 需要等待的位置。

## 自测

<details>
<summary>缓冲写的 `write()` 返回成功时，数据在哪里？掉电会怎样？</summary>

数据在内核页缓存的脏页里（如果应用自己还有用户态缓冲，可能连页缓存都没进）。此时数据还没有写到设备，掉电或内核崩溃会丢失这部分数据。要确保持久化，需要调用 `fsync()`/`fdatasync()` 或使用 `O_SYNC`/`O_DSYNC`。

</details>

<details>
<summary>为什么 `iotop` 或 BPF 工具经常显示是 kworker 在写盘，而不是真正写数据的应用？</summary>

缓冲写只是把数据拷进页缓存并标记为脏，真正把脏页写到设备的是内核的 flusher 回写线程（`kworker/uN:M`），由它构造 bio 并提交给块层。所以在块层观测到的写 I/O 提交者是 kworker。直接 I/O 则由应用进程自己提交。

</details>

<details>
<summary>bio 和 request 有什么区别？</summary>

bio 是文件系统（或上层驱动）提交给块层的 I/O 描述：目标设备、起始扇区、操作类型和数据所在的内存页。request 是块层在 blk-mq 中调度和派发给驱动的单位，一个 request 可以由多个相邻的 bio 合并而成，并占用一个 tag。LVM、md 这类堆叠驱动在 bio 层工作，只有到了真实设备的队列才会变成 request。

</details>

<details>
<summary>使用了 `O_DIRECT`，是否就保证数据已经持久化了？</summary>

不保证。`O_DIRECT` 只是绕过页缓存，设备可能把数据放在易失的板载写缓存里就报告完成，文件的元数据（如大小、块分配）也可能还没提交到日志。需要持久化仍要 `fsync`/`fdatasync` 或 `O_DSYNC`，它们会触发设备缓存刷新（FLUSH）或 FUA 写。

</details>

<details>
<summary>blk-mq 相比老的单队列块层解决了什么问题？</summary>

老块层所有 CPU 共享一个请求队列和一把锁，在高 IOPS 下锁竞争成为瓶颈。blk-mq 为每个 CPU 设置软件暂存队列，并映射到设备的多个硬件队列，请求可以在提交它的 CPU 上并行处理，从而支撑 NVMe 等设备每秒数百万次 I/O。

</details>

## 参考资料

- Brendan Gregg，《Systems Performance, 2nd Edition》第 3 章 3.2.3 System Calls、第 8 章 8.3.6～8.3.12 与 8.4 Architecture、第 9 章 9.4.4 Operating System Disk I/O Stack
- [Linux 内核文档：Overview of the Linux Virtual File System](https://docs.kernel.org/filesystems/vfs.html)
- [Linux 内核文档：Multi-Queue Block IO Queueing Mechanism (blk-mq)](https://docs.kernel.org/block/blk-mq.html)
- [Linux 内核文档：Documentation for /proc/sys/vm/](https://docs.kernel.org/admin-guide/sysctl/vm.html)
- [Linux 内核文档：Explicit volatile write back cache control](https://docs.kernel.org/block/writeback_cache_control.html)
- [Thomas-Krenn Wiki：Linux Storage Stack Diagram](https://www.thomas-krenn.com/en/wiki/Linux_Storage_Stack_Diagram)
- [LWN.net：The multiqueue block layer](https://lwn.net/Articles/552904/)
- [open(2) 手册：O_DIRECT 与 O_SYNC 说明](https://man7.org/linux/man-pages/man2/open.2.html)
- [bpftrace 参考手册](https://github.com/bpftrace/bpftrace/blob/master/man/adoc/bpftrace.adoc)
