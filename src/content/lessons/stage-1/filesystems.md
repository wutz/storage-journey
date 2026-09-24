# 文件系统：ext4、XFS 与挂载

块设备只认识"第几号扇区"，应用只认识"`/data/logs/app.log` 这个文件"。把后者翻译成前者的，就是**文件系统（File System）**。它决定了一个文件的数据放在盘上哪里、目录怎么组织、断电后能不能恢复、一块 100 TB 的盘能不能在几秒内挂载起来。

这一课先讲清 inode、dentry、extent、日志这几个核心概念，再对比 Linux 上最常用的两个文件系统 ext4 与 XFS，告诉你该怎么选、怎么 `mkfs`。后半段是运维上天天会碰到的事情：挂载选项、`/etc/fstab` 怎么写才不会让机器开不了机、在线扩容，以及文件系统坏了之后 `fsck` 和 `xfs_repair` 怎么用。

## 文件系统在 I/O 栈里的位置

回顾[一次 write() 的旅程：Linux I/O 栈](/learn/io-stack)：应用调用 `open()`、`read()`、`write()`，先进入 **VFS（Virtual File System）**，VFS 把请求交给具体的文件系统（ext4、XFS、NFS……），文件系统把"文件的第 N 字节"映射成"块设备的第 M 个块"，最后交给块层发 I/O。

```text
应用        open("/data/a.log")   write(fd, buf, 4096)
              │
VFS         路径解析（dentry 缓存）→ 找到 inode → 页缓存
              │
文件系统    ext4 / XFS：inode 里的 extent 告诉你数据在哪些块；元数据改动先写日志
              │
块层        /dev/vdb1 的第 123456 号块
```

## 核心概念

### 超级块与 inode

**超级块（Superblock）** 记录整个文件系统的全局信息：块大小、总块数、inode 总数、特性开关、上次挂载时间、是否干净卸载。它坏了整个文件系统就读不出来，所以 ext4 和 XFS 都会在盘上存多份备份。

**inode（索引节点）** 是一个文件的"档案卡"，记录除了文件名以外的一切：类型和权限、属主、大小、时间戳（atime/mtime/ctime）、链接数，以及**数据块在哪里**。

```console
$ stat /etc/hostname
  File: /etc/hostname
  Size: 7               Blocks: 8          IO Block: 4096   regular file
Device: 252,0   Inode: 1048612     Links: 1
Access: (0644/-rw-r--r--)  Uid: (    0/    root)   Gid: (    0/    root)
Access: 2026-09-24 09:12:03.412345678 +0800
Modify: 2026-08-01 10:20:11.000000000 +0800
Change: 2026-08-01 10:20:11.000000000 +0800
```

注意 inode 里**没有文件名**。文件名存在目录里：目录本身也是一个文件，内容是"名字 → inode 号"的列表。这解释了几个现象：

- **硬链接**就是在另一个目录里再加一条指向同一 inode 的记录，`Links` 计数加一。
- `mv` 同一文件系统内的文件只改目录项，瞬间完成，不管文件多大。
- 删除一个正在被进程打开的文件，目录项没了，但 inode 和数据要等最后一个文件描述符关闭才释放——"`df` 显示满了但 `du` 找不到大文件"通常就是这个原因，用 `lsof +L1` 能找到元凶。

### dentry：路径解析的缓存

**dentry（目录项）** 是内核在内存里对"路径中的一个分量"的缓存。解析 `/data/logs/app.log` 要依次查 `/`、`data`、`logs`、`app.log` 四个目录项，每一步都可能读盘。内核把结果缓存在 **dentry cache（dcache）**，连同 **inode cache**，让重复访问同一路径几乎不碰盘。在 `slabtop` 里看到 `dentry` 和 `ext4_inode_cache` 占了几个 GB 内存很正常，内存紧张时它们会被回收。

### inode 耗尽：磁盘"没满"却写不进去

ext4 在 `mkfs` 时就按比例（默认每 16 KiB 空间一个 inode）预先划好了 inode 表，之后**无法增加**。如果存的是海量小文件（邮件队列、缓存目录、容器镜像层），inode 可能先于空间用完：

> [!LAB] 亲手制造 inode 耗尽
> 在 loop 设备上建一个只有 2048 个 inode 的 ext4：
>
> ```bash
> sudo mkdir -p /var/lib/lab && sudo truncate -s 256M /var/lib/lab/tiny.img
> T=$(sudo losetup -f --show /var/lib/lab/tiny.img)
> sudo mkfs.ext4 -q -b 4096 -N 2048 $T
> sudo mkdir -p /mnt/tiny && sudo mount $T /mnt/tiny
> for i in $(seq 1 3000); do sudo touch /mnt/tiny/f$i || break; done
> ```

```console
touch: cannot touch '/mnt/tiny/f2038': No space left on device
$ df -h /mnt/tiny
Filesystem      Size  Used Avail Use% Mounted on
/dev/loop8      239M   24K  222M   1% /mnt/tiny
$ df -i /mnt/tiny
Filesystem     Inodes IUsed IFree IUse% Mounted on
/dev/loop8       2048  2048     0  100% /mnt/tiny
```

空间只用了 1%，却报 `No space left on device`（ENOSPC）。前 11 个 inode 被保留和 `lost+found` 占用，所以第 2038 个文件失败。**监控磁盘时一定要同时监控 `df -i`**。XFS 的 inode 是按需动态分配的，基本不会遇到这个问题。

### extent：用区间描述文件

早期的 ext2/ext3 用"间接块指针"记录一个文件的每一个数据块，大文件要几十万个指针。**extent（区段）** 改成记录连续区间："从逻辑块 0 开始的 32768 个块，存放在物理块 34816 起"。一个 GB 级文件往往只需要几个 extent，元数据小、顺序读也更快。

```console
$ sudo filefrag -v /mnt/ext4test/big
Filesystem type is: ef53
File size of /mnt/ext4test/big is 314572800 (76800 blocks of 4096 bytes)
 ext:     logical_offset:        physical_offset: length:   expected: flags:
   0:        0..   32767:      34816..     67583:  32768:
   1:    32768..   65535:      67584..    100351:  32768:
   2:    65536..   76799:     100352..    111615:  11264:             last,eof
/mnt/ext4test/big: 1 extent found
```

ext4 单个 extent 最长 32768 个块（4K 块时为 128 MiB），所以 300 MB 的文件被切成 3 条记录；但它们物理上首尾相接，`filefrag` 汇总为"1 extent found"，说明没有碎片。如果一个文件显示几千个 extent，就是碎片化严重了。

配合 extent 的还有两个重要机制：

- **延迟分配（Delayed Allocation）**：`write()` 时只把数据放进页缓存，等真正刷盘时才决定放在哪里。这时文件已经积累了更多数据，更容易分到一整段连续空间。代价是崩溃时丢失的窗口更大，详见[页缓存与持久化语义](/learn/page-cache)。
- **预分配（fallocate）**：应用明确知道文件会多大时（数据库、虚拟机镜像、下载工具），调用 `fallocate()` 一次性预留连续空间，`fallocate -l 10G file` 瞬间完成且不写零。

### 日志：崩溃后不用全盘扫描

创建一个文件要改好几处元数据：分配 inode、更新 inode 位图、更新块位图、在目录里添加条目。如果改到一半断电，文件系统就不一致了。没有日志的年代，只能开机时 `fsck` 扫描整个文件系统，TB 级盘要几个小时。

**日志（Journal）** 借用了数据库的预写日志（WAL）思想：先把"我要改这几处"作为一个事务顺序写进日志区，写完再去改真正的位置。崩溃后只需要**重放日志**里已提交的事务、丢弃没提交的，几秒钟就能挂载。

ext4 有三种日志模式（挂载选项 `data=`）：

| 模式 | 日志里记什么 | 特点 |
|---|---|---|
| `data=ordered`（默认） | 只记元数据，但保证数据块先于相关元数据落盘 | 崩溃后不会出现"文件里是别人的旧数据"，性能和安全的平衡点 |
| `data=writeback` | 只记元数据，数据落盘顺序不保证 | 最快，崩溃后文件末尾可能是垃圾 |
| `data=journal` | 数据和元数据都写日志 | 最安全，所有数据写两遍，写吞吐减半 |

XFS 只记元数据日志，语义接近 ordered。要记住的是：**日志保护的是文件系统结构的一致性，不保证你刚 `write()` 的数据还在**。数据要安全落盘，靠的是应用调用 `fsync()`。

## ext4 与 XFS

### XFS 的分配组

XFS 最有特色的设计是**分配组（Allocation Group，AG）**：把整个文件系统切成若干个大小相等、各自独立管理空闲空间和 inode 的区域。不同 CPU 上的线程在不同 AG 里分配空间，互不争锁，这是 XFS 在大文件系统、高并发写入下扩展性好的根本原因。

```console
$ sudo truncate -s 1G /var/lib/lab/xfs.img
$ X=$(sudo losetup -f --show /var/lib/lab/xfs.img)
$ sudo mkfs.xfs -q $X && sudo mkdir -p /mnt/xfstest && sudo mount $X /mnt/xfstest
$ xfs_info /mnt/xfstest
meta-data=/dev/loop9             isize=512    agcount=4, agsize=65536 blks
         =                       sectsz=512   attr=2, projid32bit=1
         =                       crc=1        finobt=1, sparse=1, rmapbt=0
         =                       reflink=1    bigtime=1 inobtcount=1 nrext64=0
data     =                       bsize=4096   blocks=262144, imaxpct=25
         =                       sunit=0      swidth=0 blks
naming   =version 2              bsize=4096   ascii-ci=0, ftype=1
log      =internal log           bsize=4096   blocks=16384, version=2
         =                       sectsz=512   sunit=0 blks, lazy-count=1
realtime =none                   extsz=4096   blocks=0, rtextents=0
```

- `agcount=4, agsize=65536`：4 个 AG，每个 65536 块（256 MiB）。大盘会自动分得更多。
- `crc=1`：元数据带校验和，能发现静默损坏。
- `reflink=1`：支持 `cp --reflink` 秒级拷贝（共享数据块，写时复制）。
- `log ... blocks=16384`：内部日志 64 MiB。高负载场景可以用 `-l logdev=` 把日志放到单独的快速设备上。
- `sunit/swidth`：条带对齐，在[RAID](/learn/raid)一课中 md 设备上会自动填好。

另外，XFS 要求文件系统至少 300 MB，太小的 loop 设备会被 `mkfs.xfs` 拒绝。

### 怎么选

| | ext4 | XFS |
|---|---|---|
| 发行版默认 | Ubuntu、Debian | RHEL、Rocky、CentOS |
| 最大文件系统 | 理论 1 EiB，实践中超过 50 TiB 就少见了 | 8 EiB，PB 级有大量生产案例 |
| 并发写扩展性 | 一般 | 好（分配组） |
| 大文件、流式写 | 好 | 很好 |
| 海量小文件 | 好，但要注意 inode 数 | 好，inode 动态分配 |
| 缩小 | 支持（需卸载） | **不支持** |
| 在线扩容 | 支持 | 支持 |
| 修复工具 | `e2fsck`，成熟，能修的场景多 | `xfs_repair`，快，不支持在线修复 |
| 其他 | 支持 `data=journal`；小盘友好 | reflink、项目配额、外置日志 |

我的建议：

- **系统盘**跟随发行版默认，Ubuntu 用 ext4 就好，别自找麻烦。
- **数据盘、大容量盘、高并发写**（日志、数据库、对象存储后端、AI 数据集）优先 XFS。Kubernetes 的本地 PV、MinIO/RustFS 的数据盘都普遍推荐 XFS。
- **需要缩容的场景**（比如经常调整 LV 大小）只能选 ext4。
- 不要为了追新在生产数据盘上用 Btrfs 的 RAID5/6，那是另一门课。

## mkfs：少即是多

绝大多数情况下，默认参数就是最好的参数。只有这几个值得了解：

```bash
# ext4
sudo mkfs.ext4 -L data01 /dev/vdb1          # -L 设置卷标
sudo mkfs.ext4 -m 1 /dev/vdb1               # 保留块比例，默认 5%，大数据盘可调到 0～1
sudo mkfs.ext4 -i 8192 /dev/vdb1            # 每 8 KiB 一个 inode（海量小文件时用），默认 16384
sudo mkfs.ext4 -T largefile /dev/vdb1       # 大文件场景，每 1 MiB 一个 inode

# XFS
sudo mkfs.xfs -L data01 /dev/vdb1
sudo mkfs.xfs -d su=256k,sw=10 /dev/sdb     # 硬件 RAID 上手工指定条带（chunk 256K，10 块数据盘）
sudo mkfs.xfs -f /dev/vdb1                  # 设备上已有文件系统时需要 -f 强制
```

ext4 默认的 5% 保留块是留给 root 的"救命空间"，防止普通用户写满后系统服务无法写日志。20 TB 的数据盘上 5% 就是 1 TB，对纯数据盘来说浪费了，可以 `tune2fs -m 1` 在线调小。

> [!DANGER] mkfs 不会问你"确定吗"
> `mkfs` 会立即在目标设备上写入新的文件系统，原有数据不可恢复。`mkfs.xfs` 检测到已有文件系统时会拒绝，需要 `-f`；**`mkfs.ext4` 在非交互模式下可能直接覆盖**。执行前先用 `lsblk -f` 和 `blkid` 确认目标设备是空的、是你想要的那块。

## 挂载

### 挂载选项

```console
$ findmnt -no OPTIONS /
rw,relatime,errors=remount-ro
```

常用选项：

| 选项 | 作用 | 建议 |
|---|---|---|
| `relatime` | 只在 atime 早于 mtime 或超过 24 小时时才更新 atime | 内核默认，已经足够好 |
| `noatime` | 完全不更新访问时间 | 读密集的数据盘可以加，避免"读也产生写"；极少数程序（老式邮件客户端）依赖 atime |
| `discard` | 删除文件时实时发 TRIM | 一般**不推荐**，用每周的 `fstrim.timer` 批量做更好，实时 discard 在部分 SSD 上会拖慢删除 |
| `nofail` | 设备不存在时不阻止开机 | 所有非系统必需的数据盘都应该加 |
| `x-systemd.device-timeout=30s` | 等设备出现的最长时间，默认 90 秒 | 配合 `nofail` 使用 |
| `_netdev` | 网络就绪后再挂载 | iSCSI、NFS 等网络存储必加 |
| `errors=remount-ro` | ext4 发现错误时切换为只读 | Ubuntu 根分区默认，防止在损坏的文件系统上继续写 |
| `ro` | 只读挂载 | 取证、恢复时使用 |

Systems Performance 第 8 章也提到：过去人们常加 `noatime` 来省掉读操作引发的元数据写，而 `relatime` 已经把绝大部分这类写消除了。所以除非你确认 atime 更新是瓶颈，否则默认就好。

临时挂载和调整选项：

```bash
sudo mount -o noatime /dev/vdb1 /data
sudo mount -o remount,ro /data              # 在线切换为只读
findmnt /data                               # 看某个挂载点的来源、类型、选项
findmnt -t xfs,ext4                         # 列出所有 ext4 和 XFS 挂载
```

### /etc/fstab：写错一行，机器开不了机

`/etc/fstab` 每行六个字段：

```text title="/etc/fstab"
# <设备>                                   <挂载点> <类型> <选项>                                   <dump> <pass>
UUID=2f4c6b3e-8a1d-4f0e-9c7b-1d2e3f4a5b6c  /        ext4   errors=remount-ro                        0      1
UUID=5d1e2f3a-4b5c-4d6e-8f9a-0b1c2d3e4f5a  /data    xfs    defaults,noatime,nofail,x-systemd.device-timeout=30s  0  0
/dev/ubuntu-vg/ubuntu-lv                   /var/lib ext4   defaults,nofail                          0      2
```

- **设备字段用 `UUID=`**，不用 `/dev/sdb1`。原因和上一课的 `by-id` 一样：设备名会漂移。LVM 的 `/dev/<vg>/<lv>` 路径是稳定的，也可以直接用。
- **`pass` 字段**：开机时 `fsck` 的顺序。根分区写 1，其他 ext4 写 2；**XFS 写 0**，因为 `fsck.xfs` 什么也不做，XFS 在挂载时自己重放日志。
- **非必需的盘加 `nofail`**。否则某块数据盘坏了或者没识别出来，系统会卡在 emergency mode，需要有人去机房接显示器。

> [!WARNING] 改完 fstab 先验证，再重启
> 在 systemd 系统上，fstab 会被转换成 `.mount` 单元。改完之后按顺序执行：
>
> ```bash
> sudo findmnt --verify              # 检查语法、设备是否存在、类型是否匹配
> sudo systemctl daemon-reload       # 让 systemd 重新生成挂载单元
> sudo mount -a                      # 挂载所有尚未挂载的条目，报错就说明写错了
> ```
>
> `mount -a` 没报错再重启。远程机器上改 fstab 却不验证，是经典的"一行配置换一趟机房"。

### 完整走一遍

沿用前面建好的 XFS loop 设备 `$X`：

```bash
UUID=$(sudo blkid -s UUID -o value $X)
echo "UUID=$UUID /mnt/xfstest xfs defaults,noatime,nofail 0 0" | sudo tee -a /etc/fstab
sudo umount /mnt/xfstest
sudo findmnt --verify && sudo systemctl daemon-reload && sudo mount -a
findmnt /mnt/xfstest
```

实验结束后记得把这一行从 fstab 中删掉，否则 loop 设备在重启后不存在，虽然有 `nofail` 不影响开机，但会留下一条报错日志。

## 在线扩容

底下的块设备（分区、LV、云盘、RAID）变大之后，文件系统不会自动跟着变大，需要显式扩展。两者都支持挂载状态下在线扩容：

```bash
# ext4：参数是设备
sudo resize2fs /dev/labvg/data

# XFS：参数是挂载点
sudo xfs_growfs /data
```

如果底层是 LVM，上一课的 `lvextend -r` 会自动调用这两个命令。云主机上扩容云盘的完整流程通常是：控制台扩盘 → `growpart /dev/vda 3`（cloud-guest-utils 包，扩分区）→ `pvresize`（如果有 LVM）→ `lvextend` → `resize2fs` / `xfs_growfs`。

用 XFS loop 设备体验一下：

```bash
sudo truncate -s 2G /var/lib/lab/xfs.img        # 文件变大，相当于"扩盘"
sudo losetup -c $X                              # 通知内核 loop 设备容量变了
sudo xfs_growfs /mnt/xfstest
df -h /mnt/xfstest                              # 从约 1G 变成约 2G
```

XFS 扩容时会增加新的 AG。一个从 1 GB 一路扩到 10 TB 的 XFS，AG 大小还停留在当初的 256 MiB，AG 数量会多到上万，影响性能。**所以不要在小盘上建 XFS 然后反复扩成巨盘**，一开始就按预期规模创建更好。

## 文件系统坏了怎么办

### 什么时候会坏

有日志的文件系统在正常断电后几乎不会坏。真正导致损坏的通常是：磁盘坏扇区、RAID 卡或 SSD 缓存在断电时丢了已确认的写、在两台机器上同时挂载同一个块设备、有人对着已挂载的设备跑了 `dd`。内核日志里会出现类似 `EXT4-fs error` 或 `XFS (vdb1): Metadata corruption detected` 的报错，ext4 可能自动变成只读。

### ext4：e2fsck

```bash
sudo umount /dev/vdb1                     # 必须先卸载
sudo e2fsck -f /dev/vdb1                  # -f 即使标记为干净也强制检查
sudo e2fsck -f -n /dev/vdb1               # -n 只检查不修改，先看看问题有多严重
sudo e2fsck -f -y /dev/vdb1               # -y 所有问题自动回答 yes
```

超级块损坏时可以用备份超级块：`sudo mke2fs -n /dev/vdb1` 会**模拟**创建并打印备份超级块的位置（`-n` 绝不能漏），然后 `e2fsck -b 32768 /dev/vdb1`。

### XFS：xfs_repair

```bash
sudo umount /data
sudo xfs_repair -n /dev/vdb1              # 只检查，不修改
sudo xfs_repair /dev/vdb1                 # 实际修复
```

如果 `xfs_repair` 提示日志里有未重放的内容，**先尝试 mount 一次**让内核重放日志，再卸载后修复。

> [!DANGER] xfs_repair -L 会丢数据
> `-L` 会直接清空日志，日志里尚未写回的元数据修改全部丢失，可能导致大量文件进入 `lost+found` 或消失。只有在挂载失败、无法重放日志的情况下，作为最后手段使用。条件允许时，先用 `dd` 或 `xfs_metadump` 给整个设备做一份镜像，在镜像上试。

> [!PROD] 修复之前先做三件事
> 1. **停止写入**，卸载或切只读，避免把损坏扩大。
> 2. **查根因**：`dmesg`、`smartctl`、RAID 状态。磁盘本身在坏的时候跑修复，可能越修越糟，应先把数据 `ddrescue` 到好盘上。
> 3. **确认备份**。`fsck` 修复的目标是让文件系统结构一致，不是找回数据，修完少了文件是常事。

### 清理实验环境

```bash
sudo umount /mnt/tiny /mnt/xfstest /mnt/ext4test 2>/dev/null
sudo losetup -d $T $X
sudo rm -f /var/lib/lab/tiny.img /var/lib/lab/xfs.img /var/lib/lab/ext4.img
```

文件系统层面的性能观测（`ext4slower`、`xfsdist`、缓存命中率等）在阶段 2 的[文件系统观测：缓存与延迟](/learn/fs-observability)里继续。

## 动手练习

1. 建一个 1 GiB 的 loop 设备，格式化为 ext4 挂载到 `/mnt/ext4test`，用 `dd if=/dev/zero of=/mnt/ext4test/big bs=1M count=300` 写一个文件，用 `filefrag -v` 查看 extent；再用 `fallocate -l 300M /mnt/ext4test/pre` 预分配一个文件，比较两者的耗时和 extent 布局。
2. 复现本课的 inode 耗尽实验，然后换成 XFS（注意 XFS 至少 300 MB）做同样的 `touch` 循环，对比 `df -i` 的变化，解释差异。
3. 在一个文件上执行 `ln` 建硬链接，用 `stat` 观察 inode 号和 `Links` 计数；然后用 `sleep 1000 > /mnt/ext4test/held &` 打开一个文件后删除它，用 `df`、`du`、`lsof +L1` 找出"被删除但仍占空间"的文件。
4. 给 XFS loop 设备写一条带 `nofail` 的 fstab 记录，故意把 UUID 改错一位，运行 `findmnt --verify` 看它报什么；再改回正确值并 `mount -a`。
5. 用 `tune2fs -l /dev/<设备>` 查看一个 ext4 的块大小、inode 数量、保留块数、特性列表，并用 `tune2fs -m 1` 调整保留块比例，再次 `df -h` 观察 `Avail` 的变化。

## 自测

<details>
<summary>df -h 显示还有大量空间，写文件却报 No space left on device，可能是什么原因？</summary>

最常见的是 inode 耗尽：ext4 在创建时固定了 inode 数量，海量小文件会先把 inode 用完，用 `df -i` 可以确认。其他可能：普通用户写满了除保留块以外的空间（root 仍可写）；或者是配额（quota）限制。另一种相反的情况——`df` 满了但 `du` 找不到大文件——通常是被删除但仍被进程打开的文件，用 `lsof +L1` 查找。

</details>

<details>
<summary>ext4 默认的 data=ordered 日志模式能保证 write() 写入的数据在断电后不丢吗？</summary>

不能。日志保护的是文件系统元数据结构的一致性，崩溃后能快速恢复到一致状态。`data=ordered` 额外保证数据块先于引用它的元数据落盘，避免文件中出现旧的垃圾数据。但尚在页缓存中、还没刷盘的数据在断电时依然会丢。要保证数据持久，应用必须调用 `fsync()` / `fdatasync()`。

</details>

<details>
<summary>什么场景下你会选 XFS 而不是 ext4？什么场景只能选 ext4？</summary>

大容量数据盘、高并发写入、大文件流式读写（日志、数据库、对象存储后端、AI 数据集）优先 XFS，它的分配组设计扩展性更好，inode 动态分配，还支持 reflink 和外置日志。如果需要缩小文件系统，只能选 ext4，XFS 不支持缩容；小容量盘（低于 300 MB）也只能用 ext4。系统盘一般跟随发行版默认。

</details>

<details>
<summary>写 /etc/fstab 时，为什么设备要用 UUID，数据盘要加 nofail？XFS 的 pass 字段应填什么？</summary>

`/dev/sdX` 这类名字按探测顺序分配，重启后可能变化，导致挂错盘或挂载失败；UUID 属于文件系统本身，稳定不变。`nofail` 让设备缺失时系统仍能正常开机，否则一块数据盘故障就会让机器卡在 emergency mode。XFS 的 pass 字段填 0，因为 XFS 不依赖开机 fsck，挂载时自己重放日志，`fsck.xfs` 实际上什么都不做。

</details>

<details>
<summary>底层 LV 扩大后，ext4 和 XFS 分别用什么命令扩展文件系统？参数有什么区别？</summary>

ext4 用 `resize2fs`，参数是块设备，如 `resize2fs /dev/labvg/data`；XFS 用 `xfs_growfs`，参数是挂载点，如 `xfs_growfs /data`。两者都支持在挂载状态下在线扩容，`lvextend -r` 会自动调用对应命令。

</details>

## 参考资料

- Brendan Gregg，《Systems Performance: Enterprise and the Cloud, 2nd Edition》第 8 章 File Systems（8.3 概念、8.4.5 文件系统类型）
- [Linux 内核文档：ext4 Data Structures and Algorithms](https://docs.kernel.org/filesystems/ext4/index.html)
- [Linux 内核文档：XFS](https://docs.kernel.org/admin-guide/xfs.html)
- [Linux 内核文档：Overview of the Linux Virtual File System](https://docs.kernel.org/filesystems/vfs.html)
- [Arch Wiki：File systems](https://wiki.archlinux.org/title/File_systems)
- [Arch Wiki：fstab](https://wiki.archlinux.org/title/Fstab)
- [xfs_repair(8) 手册页](https://man7.org/linux/man-pages/man8/xfs_repair.8.html)
- [e2fsck(8) 手册页](https://man7.org/linux/man-pages/man8/e2fsck.8.html)
