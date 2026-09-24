# 页缓存与持久化语义

`write()` 返回了成功，数据就安全了吗？不。它此刻很可能只是被拷贝进了内存里的一页缓存，离真正写到盘上的介质还隔着好几层：文件系统、块层队列、磁盘自己的易失性缓存。这时候断电，数据就没了——而应用对此毫不知情。

这一课讲两件事。一是**页缓存（Page Cache）**：Linux 为什么"吃掉"了你所有的空闲内存，脏页什么时候、以什么节奏写回磁盘，以及那几个 `vm.dirty_*` 参数怎么影响性能。二是**持久化语义**：`fsync`、`fdatasync`、`O_SYNC`、`O_DIRECT` 各自保证了什么、没保证什么，磁盘缓存、写屏障、掉电保护在其中扮演什么角色。学完之后，你看到一个"写入 3 GB/s"的测试结果时，第一反应会是：它测的是内存还是盘？

## 页缓存：内存就是盘的缓存

### 空闲内存去哪了

```console
$ free -h
               total        used        free      shared  buff/cache   available
Mem:            15Gi       2.1Gi       412Mi        12Mi        13Gi        13Gi
Swap:          4.0Gi          0B       4.0Gi
```

`free` 只剩 412 MiB，新手会以为内存快用光了。其实 13 GiB 在 `buff/cache` 里，绝大部分是页缓存：内核把读写过的文件内容留在内存中，下次访问直接命中。这些内存随时可以回收给应用，所以真正该看的是 **`available`**（估算的可用内存）。**空闲内存是浪费的内存**，Linux 的策略是把它们都拿来做缓存。

页缓存以页（通常 4 KiB）为单位，按"文件 + 偏移"索引。它是 VFS 和具体文件系统之间的一层，所有普通的 `read()`/`write()`/`mmap()` 都经过它。

### 读路径：命中与预读

```bash
sudo mkdir -p /var/tmp/pctest && sudo chown $USER: /var/tmp/pctest && cd /var/tmp/pctest
dd if=/dev/urandom of=big bs=1M count=1024 status=none
sync; echo 3 | sudo tee /proc/sys/vm/drop_caches >/dev/null
time cat big > /dev/null          # 第一次：从盘读
time cat big > /dev/null          # 第二次：从页缓存读
fincore big                       # 这个文件有多少页在缓存里（util-linux 自带）
```

```text
real    0m2.187s        ← 第一次，约 490 MB/s，受限于磁盘
real    0m0.121s        ← 第二次，约 8.8 GB/s，内存拷贝速度
  RES PAGES SIZE FILE
   1G 262144   1G big
```

同一个文件，第二次读快了近 20 倍。这就是为什么做基准测试之前要清缓存、或者用直接 I/O，否则你测到的是内存。

内核还会做**预读（Readahead）**：检测到顺序读时，提前把后面的数据读进缓存，让磁盘以大块顺序 I/O 工作。预读窗口可以查看和调整：

```console
$ cat /sys/block/vda/queue/read_ahead_kb
128
```

对顺序读为主的大文件负载（视频、备份、AI 数据集），适当调大预读能提升吞吐；对纯随机读负载，预读反而浪费带宽。这些调优留到[I/O 调优](/learn/io-tuning)。

### 写路径：脏页与回写

默认的写是**回写缓存（Write-Back Caching）**：`write()` 把数据拷进页缓存、把页标记为**脏（Dirty）**，然后立即返回。真正写盘由内核的 flusher 线程（`kworker/u*:*-flush-*`）稍后异步完成。

```text
write() ──▶ 页缓存（标记为脏页）──▶ 返回成功          ← 应用只等了一次内存拷贝
                   │
                   │ 稍后（超时 / 脏页太多 / 显式 sync）
                   ▼
            flusher 线程 ──▶ 文件系统 ──▶ 块层 ──▶ 磁盘
```

好处显而易见：应用写入延迟极低；多次写同一页只落盘一次；延迟分配让文件系统有机会分配连续空间；小写被合并成大 I/O。代价是：**在脏页被写回之前，数据只存在于内存中**。

一边写一边观察脏页：

```bash
# 终端 1
watch -n1 'grep -E "^(Dirty|Writeback):" /proc/meminfo'
# 终端 2
dd if=/dev/zero of=/var/tmp/pctest/w bs=1M count=2048
```

```text
Dirty:           1843204 kB      ← dd 结束瞬间，1.8 GB 还在内存里
Writeback:         65536 kB      ← 正在写往磁盘的部分
```

几十秒后 `Dirty` 回落到接近 0，数据才真正写到了盘上。

## 回写节奏：vm.dirty_* 参数

脏页什么时候开始写回，由几个 sysctl 控制：

```console
$ sysctl vm.dirty_background_ratio vm.dirty_ratio vm.dirty_expire_centisecs vm.dirty_writeback_centisecs
vm.dirty_background_ratio = 10
vm.dirty_ratio = 20
vm.dirty_expire_centisecs = 3000
vm.dirty_writeback_centisecs = 500
```

| 参数 | 默认 | 含义 |
|---|---|---|
| `dirty_background_ratio` | 10 | 脏页占可用内存超过 10%，flusher 线程开始**后台**写回，应用不受影响 |
| `dirty_ratio` | 20 | 脏页超过 20%，**写入进程自己被拖进来**帮忙写回，`write()` 开始被节流、变慢 |
| `dirty_expire_centisecs` | 3000 | 脏页存在超过 30 秒，下一轮就必须写回 |
| `dirty_writeback_centisecs` | 500 | flusher 线程每 5 秒醒来检查一次 |
| `dirty_background_bytes` / `dirty_bytes` | 0 | 用绝对字节数代替比例；设置了 `_bytes`，对应的 `_ratio` 自动变为 0 |

所以在默认设置下，**一次普通写入的数据最长可能在内存里待 30 多秒**才开始落盘。这也是"断电丢了最后半分钟数据"的来源。

```text
脏页比例
  20% ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ dirty_ratio：写进程被节流，write() 延迟飙升
          ╱‾‾‾‾‾‾‾‾╲
  10% ─ ─╱─ ─ ─ ─ ─ ╲─ ─ dirty_background_ratio：后台开始刷
        ╱            ╲
   0% ─╱──────────────╲──▶ 时间
     写入突发开始      写入停止，后台慢慢刷完
```

### 大内存机器上的坑

比例是相对内存算的。一台 512 GB 内存的存储节点，默认允许约 50 GB 后台阈值、100 GB 脏页上限。应用往一块 200 MB/s 的 HDD 上狂写，几十 GB 脏页堆积起来，一旦触发 `dirty_ratio`，所有写进程一起卡住，要等好几分钟才刷得完；期间 `fsync()` 也要排在这一大堆脏页后面。表现为"平时写入飞快，隔一段时间整个系统卡死几十秒"。

解决办法是改用绝对值，把脏页上限控制在磁盘几秒钟能刷完的量级：

```bash
# 示例：后台 256 MiB 开始刷，上限 1 GiB。具体数值按磁盘吞吐调整，并实测验证
sudo sysctl -w vm.dirty_background_bytes=268435456
sudo sysctl -w vm.dirty_bytes=1073741824
```

写进 `/etc/sysctl.d/90-dirty.conf` 可以持久化。数据库服务器、Ceph OSD 节点、GPFS NSD 服务器上经常要做这类调整。

### drop_caches：只在测试时用

```bash
sync                                          # 先把脏页写回，drop_caches 只丢弃干净页
echo 1 | sudo tee /proc/sys/vm/drop_caches    # 丢弃页缓存
echo 2 | sudo tee /proc/sys/vm/drop_caches    # 丢弃 dentry 和 inode 缓存
echo 3 | sudo tee /proc/sys/vm/drop_caches    # 两者都丢
```

> [!WARNING] 不要在生产上定时 drop_caches
> 网上流传着"定时清缓存释放内存"的 cron 脚本，这是有害无益的：缓存被清空后，所有读请求都要重新打到磁盘，延迟飙升，内核很快又会把缓存填满。页缓存本来就会在应用需要内存时自动回收。`drop_caches` 只适合在基准测试前制造"冷缓存"条件。

## 持久化语义：从 write() 到介质

### 数据要经过的每一层

```text
  应用缓冲区       fwrite() / printf() / Python 的 f.write()  ← fflush() 才进入内核
       │
  页缓存           write() 返回成功时，数据在这里             ← 断电丢失
       │ fsync() / 回写
  文件系统         日志提交、元数据更新
       │
  块层队列         bio 请求排队、调度
       │
  设备易失缓存     磁盘 / SSD 的 DRAM 缓存，设备已回复"写完了" ← 没有 PLP 时断电丢失
       │ FLUSH / FUA
  持久介质         磁片、NAND                                 ← 这才算真正落盘
```

**"write() 返回成功"只代表数据进入了页缓存**。要穿透到介质，需要应用显式要求，并且下面每一层都诚实地执行。

### fsync 与 fdatasync

| 调用 | 保证 |
|---|---|
| `fsync(fd)` | 该文件所有脏数据和元数据（大小、时间戳等）写入持久存储，并让设备刷新缓存，才返回 |
| `fdatasync(fd)` | 同上，但跳过"读取数据不需要"的元数据（比如 mtime）；文件大小变化仍会同步。通常少一次元数据写，更快 |
| `sync()` / `syncfs(fd)` | 刷写整个系统 / 整个文件系统的脏页 |
| `open(..., O_SYNC)` | 之后的每次 `write()` 都相当于 write + `fsync` |
| `open(..., O_DSYNC)` | 之后的每次 `write()` 都相当于 write + `fdatasync` |

Systems Performance 第 8.3.7 节的观点很实用：与其用 `O_SYNC` 让每次写都同步，不如像数据库那样积累一批写之后在检查点调用一次 `fsync()`，把多次同步合并成一次，延迟和吞吐都好得多。数据库的"组提交（group commit）"就是这个思路。

两个容易漏掉的细节：

- **新建文件还要 fsync 它所在的目录**。`fsync(文件)` 保证文件内容落盘，但"目录里有这个文件名"是目录的数据，不 fsync 目录，崩溃后文件可能整个不见了。`rename()` 同理。
- **fsync 失败了不能简单重试**。2018 年 PostgreSQL 社区发现（俗称 "fsyncgate"）：Linux 在回写出错后会把对应的页标记为干净，再次 `fsync()` 会返回成功，但数据其实已经丢了。PostgreSQL 此后改为遇到 fsync 错误直接 PANIC，从 WAL 重放恢复。结论：**fsync 报错意味着数据可能已丢，应用必须把它当成严重故障**。

### 原子写入文件的正确姿势

配置文件、元数据文件这类"要么全新、要么全旧"的写入，标准做法是写临时文件 → fsync → rename → fsync 目录：

```python title="atomic_write.py"
import os

def atomic_write(path: str, data: bytes) -> None:
    dirpath = os.path.dirname(os.path.abspath(path))
    tmp = path + ".tmp"
    with open(tmp, "wb") as f:
        f.write(data)
        f.flush()                 # Python 缓冲区 → 内核页缓存
        os.fsync(f.fileno())      # 页缓存 → 持久存储
    os.replace(tmp, path)         # 同一文件系统内 rename 是原子的
    dfd = os.open(dirpath, os.O_RDONLY)
    try:
        os.fsync(dfd)             # 让目录项的变化也落盘
    finally:
        os.close(dfd)

atomic_write("/var/tmp/pctest/config.json", b'{"version": 2}\n')
```

崩溃后，`config.json` 要么是旧内容，要么是完整的新内容，不会出现写了一半的文件。etcd、Kubernetes、各种数据库的元数据文件都是这么写的。

### O_DIRECT：绕过缓存，但不等于落盘

`O_DIRECT` 让 I/O 绕过页缓存，直接在用户缓冲区和设备之间传输。数据库（自己管理缓存，不需要内核再缓存一遍）、Ceph BlueStore、以及 fio 的 `direct=1` 都用它。

```console
$ dd if=/dev/zero of=/var/tmp/pctest/d bs=1000 count=1 oflag=direct
dd: error writing '/var/tmp/pctest/d': Invalid argument
$ dd if=/dev/zero of=/var/tmp/pctest/d bs=4096 count=1 oflag=direct
1+0 records in
1+0 records out
4096 bytes (4.1 kB, 4.0 KiB) copied, 0.000512 s, 8.0 MB/s
```

`O_DIRECT` 要求缓冲区地址、文件偏移和长度都按设备逻辑块大小（通常 512 字节或 4 KiB）对齐，否则返回 `EINVAL`。

> [!WARNING] O_DIRECT 不提供持久性保证
> 绕过页缓存不代表数据到达了介质：它可能还在设备的易失缓存里；如果写入扩展了文件大小或触发了新的块分配，对应的元数据也还没提交。需要持久性时，要么配合 `fdatasync()`，要么用 `O_DIRECT | O_DSYNC`。Gregg 的书里也特别强调了这一点：直接 I/O 跳过了缓存，但没有 `O_SYNC` 的保证。

## 设备缓存、写屏障与掉电保护

### 设备也会"撒谎"

绝大多数磁盘和 SSD 都有 DRAM 写缓存。数据进入这块缓存，设备就回复"完成"，此时断电同样会丢。为此存储协议提供了两个命令：

- **FLUSH**（SATA 的 FLUSH CACHE、SCSI 的 SYNCHRONIZE CACHE、NVMe 的 Flush）：把设备缓存里的所有数据写入介质。
- **FUA（Force Unit Access）**：这一个写请求绕过缓存，直接写到介质才返回。

Linux 块层用 `REQ_PREFLUSH` 和 `REQ_FUA` 两个标志来表达它们。文件系统在提交日志、执行 `fsync()` 时会发出这些请求，这就是过去所说的**写屏障（Write Barrier）**：保证日志提交记录不会先于日志内容落盘。

内核通过 sysfs 告诉你它认为设备是否有易失缓存：

```console
$ cat /sys/block/sda/queue/write_cache
write back
$ cat /sys/block/nvme0n1/queue/fua
1
$ sudo nvme id-ctrl /dev/nvme0 | grep -w vwc
vwc       : 0x1
$ sudo hdparm -W /dev/sda
/dev/sda:
 write-caching =  1 (on)
```

- `write back` 表示内核认为设备有易失写缓存，会在需要时发送 FLUSH；`write through` 则不发送。
- NVMe 的 `vwc: 0x1` 表示存在易失写缓存（Volatile Write Cache），可以用 `nvme get-feature /dev/nvme0 -f 6` 查看它当前是否开启。

> [!DANGER] 不要为了跑分关掉 flush
> 往 `/sys/block/*/queue/write_cache` 写入 `write through` **不会改变设备的行为**，只是让内核不再发送 FLUSH。如果设备实际有易失缓存，你就把所有 `fsync()` 变成了空话。同理，老教程里的 `nobarrier` 挂载选项在新内核里已经被 XFS 移除、ext4 也不建议使用。这些"优化"让基准测试好看，让断电后的文件系统和数据库损坏。

### 掉电保护：让 fsync 又快又安全

企业级 SSD 的**掉电保护（PLP，Power Loss Protection）**用板载电容在断电瞬间把 DRAM 缓存刷进 NAND。有了 PLP，设备缓存实际上是非易失的，FLUSH 可以立即完成，`fsync` 延迟从毫秒级降到几十微秒。

```text
                        fdatasync 延迟（4 KiB 顺序写，典型值）
消费级 NVMe（无 PLP）    1～5 ms，偶尔几十 ms      ← 每次都要真正刷 NAND
企业级 NVMe（有 PLP）    20～60 µs                 ← 缓存有电容兜底
7200 rpm HDD            5～15 ms                  ← 至少等半圈旋转
```

这就是为什么 etcd、数据库、Ceph 的 WAL/DB 设备都强烈要求使用带 PLP 的企业级 SSD：它们的每次提交都要 `fsync`，fsync 延迟直接就是业务延迟。消费级 SSD 顺序读写跑分也许比企业盘还高，但在 fsync 密集的负载下能慢上百倍。

> [!NOTE] 虚拟机与云盘
> 虚拟机里的"盘"背后还有一层 Hypervisor 缓存。QEMU/KVM 的 `cache=unsafe` 模式会直接忽略客户机的 flush，速度很快，但宿主机断电时客户机数据不保。云盘一般会正确处理 flush，但延迟由网络和后端存储决定。在[实验环境](/learn/lab-environment)的虚拟机里测出来的 fsync 延迟，只能用来对比趋势，不代表物理盘。

## 动手：看清你测的是什么

### 用 dd 对比四种写法

在真实文件系统上（不要用 tmpfs，也不要在 loop 设备上做延迟判断）创建测试目录：

```bash
cd /var/tmp/pctest
# 1) 缓冲写：只测到了页缓存
dd if=/dev/zero of=t1 bs=1M count=1024
# 2) 结束前 fdatasync：计入刷盘时间，接近磁盘真实顺序写吞吐
dd if=/dev/zero of=t2 bs=1M count=1024 conv=fdatasync
# 3) 直接 I/O：绕过页缓存
dd if=/dev/zero of=t3 bs=1M count=1024 oflag=direct
# 4) 每次写都同步：测的是同步写延迟
dd if=/dev/zero of=t4 bs=4k count=1000 oflag=dsync
```

```text
1) 1073741824 bytes (1.1 GB, 1.0 GiB) copied, 0.412 s, 2.6 GB/s
2) 1073741824 bytes (1.1 GB, 1.0 GiB) copied, 2.31 s, 465 MB/s
3) 1073741824 bytes (1.1 GB, 1.0 GiB) copied, 2.05 s, 524 MB/s
4) 4096000 bytes (4.1 MB, 3.9 MiB) copied, 1.87 s, 2.2 MB/s
```

第 1 种的 2.6 GB/s 是内存拷贝速度；第 4 种平均每次同步写约 1.9 ms，这台机器的盘显然没有 PLP。**任何没有 `conv=fdatasync`、`oflag=direct` 或 `oflag=dsync` 的 dd 测速结果，都不能说明磁盘性能**。另外，`/dev/zero` 的全零数据在某些带压缩或去重的存储上会严重失真，正式测试请用 fio。

### 用 fio 测 fsync 延迟

etcd 的硬件建议文档引用了下面这个 fio 测试，用来评估一块盘能否承载 etcd 的 WAL：

```bash
sudo apt install -y fio
mkdir -p /var/tmp/pctest/etcd-test
fio --name=etcd-wal --directory=/var/tmp/pctest/etcd-test \
    --rw=write --ioengine=sync --fdatasync=1 --size=22m --bs=2300
```

```text
  fsync/fdatasync/sync_file_range:
    sync (usec): min=412, max=21873, avg=1654.32, stdev=1203.55
    sync percentiles (usec):
     |  1.00th=[  453],  5.00th=[  502], 10.00th=[  537], 20.00th=[  627],
     | 50.00th=[ 1336], 90.00th=[ 2769], 95.00th=[ 3818], 99.00th=[ 6194],
     | 99.50th=[ 7898], 99.90th=[14091], 99.95th=[17695], 99.99th=[21890]
```

关注 `sync percentiles` 的 99th：etcd 的要求是低于 10 ms，这块盘 6.2 ms 勉强及格。换成带 PLP 的企业 NVMe，这里通常只有几十微秒。`--bs=2300` 模拟的是 etcd 典型的 WAL 写入大小。

对比缓冲 I/O 和直接 I/O 的随机读：

```bash
fio --name=buffered --filename=/var/tmp/pctest/fio.dat --size=1G --rw=randread --bs=4k \
    --ioengine=libaio --iodepth=16 --direct=0 --runtime=20 --time_based
fio --name=direct   --filename=/var/tmp/pctest/fio.dat --size=1G --rw=randread --bs=4k \
    --ioengine=libaio --iodepth=16 --direct=1 --runtime=20 --time_based
```

1 GiB 的测试文件完全装得进页缓存，`direct=0` 跑出的 IOPS 会高得离谱，那是内存的成绩。测磁盘就用 `direct=1`，或者让测试文件远大于内存。fio 的完整用法在[基准测试](/learn/benchmarking)中展开。

清理：

```bash
rm -rf /var/tmp/pctest
```

## 动手练习

1. 执行 `free -h` 并读取 `/proc/meminfo` 中的 `Cached`、`Dirty`、`Writeback`，然后用 `dd` 写入一个大于 2 GiB 的文件，每秒观察 `Dirty` 的变化，估算脏页从产生到写回完成用了多久。
2. 把 `vm.dirty_expire_centisecs` 临时调成 `500`（5 秒）、再调回 `3000`，重复练习 1，观察回写开始的时间有什么不同。
3. 用本课的四种 `dd` 写法在你的实验机上各跑一次，把结果填进一张表，并解释每一行测到的到底是什么。
4. 运行 etcd 的 fio 命令，记录 fdatasync 的 99th 百分位延迟；如果有条件，在一块企业级 NVMe 和一块消费级 SSD（或虚拟机磁盘）上分别测试，对比差距。
5. 修改 `atomic_write.py`，去掉两处 `os.fsync()` 调用，用 `strace -f -e trace=fsync,fdatasync,rename python3 atomic_write.py` 对比修改前后的系统调用，说明缺少的调用各自带来了什么风险。

## 自测

<details>
<summary>free 显示 free 内存很少，但 available 很多，需要担心吗？</summary>

不需要。Linux 会把空闲内存用作页缓存，所以 `free` 列通常很小。`buff/cache` 中的干净页可以随时回收给应用，`available` 才是对可用内存的正确估算。只有 `available` 持续很低、并伴随换页或 OOM 时，才是真正的内存不足。

</details>

<details>
<summary>默认设置下，一次 write() 写入的数据最长大约多久后开始落盘？哪些情况会让它更早写回？</summary>

`dirty_expire_centisecs` 默认 3000，即脏页存在超过 30 秒后会在下一轮（`dirty_writeback_centisecs`，每 5 秒一次）被写回，所以最长约 30 多秒。更早写回的情况：脏页总量超过 `dirty_background_ratio`/`_bytes`，触发后台回写；超过 `dirty_ratio`/`_bytes`，写进程被迫参与回写；应用调用 `fsync`、`fdatasync`、`sync`；或者内存压力下需要回收页面。

</details>

<details>
<summary>用 O_DIRECT 写入的数据，write() 返回后就持久化了吗？</summary>

不一定。`O_DIRECT` 只是绕过页缓存，数据可能还在设备的易失写缓存中；如果写入扩展了文件大小或需要分配新块，相关的文件系统元数据也还没有提交。要保证持久化，需要配合 `fdatasync()`，或以 `O_DIRECT | O_DSYNC` 方式打开文件。

</details>

<details>
<summary>新建一个文件并写入数据后调用了 fsync(fd)，崩溃后文件还可能消失吗？应该怎么做？</summary>

可能。`fsync(fd)` 保证了文件内容和 inode 落盘，但"目录中存在这个文件名"属于目录的数据，没有同步的话，崩溃后目录项可能丢失，文件就找不到了。正确做法是在创建或 `rename` 后，打开父目录并对它调用 `fsync`。

</details>

<details>
<summary>为什么 etcd、数据库的 WAL 盘要求使用带掉电保护（PLP）的企业级 SSD？</summary>

这类系统每次提交都要调用 `fsync`/`fdatasync`，其延迟直接决定业务延迟。没有 PLP 的 SSD 必须把数据真正写入 NAND 才能完成 FLUSH，延迟为毫秒级且抖动大；有 PLP 的 SSD 可以用电容保证缓存中的数据在断电时不丢，FLUSH 立即完成，延迟降到几十微秒。同时 PLP 也保证了断电后已确认的写入确实不会丢失。

</details>

## 参考资料

- Brendan Gregg，《Systems Performance: Enterprise and the Cloud, 2nd Edition》第 7 章 Memory（7.6.1 可调参数）、第 8 章 File Systems（8.3.6 回写缓存、8.3.7 同步写、8.3.8 原始与直接 I/O）
- [Linux 内核文档：/proc/sys/vm/ 参数说明](https://docs.kernel.org/admin-guide/sysctl/vm.html)
- [Linux 内核文档：Explicit volatile write back cache control](https://docs.kernel.org/block/writeback_cache_control.html)
- [fsync(2) 手册页](https://man7.org/linux/man-pages/man2/fsync.2.html)
- [open(2) 手册页（O_DIRECT、O_SYNC、O_DSYNC）](https://man7.org/linux/man-pages/man2/open.2.html)
- [PostgreSQL Wiki：Fsync Errors](https://wiki.postgresql.org/wiki/Fsync_Errors)
- [etcd 文档：Hardware recommendations（磁盘与 fio 测试）](https://etcd.io/docs/v3.5/op-guide/hardware/)
- [LWN：PostgreSQL's fsync() surprise](https://lwn.net/Articles/752063/)
