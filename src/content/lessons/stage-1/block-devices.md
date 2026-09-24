# 块设备、分区与 LVM

新服务器上架，插了 12 块盘，你要做的第一件事不是 `mkfs`，而是搞清楚：哪个 `/dev/sdX` 是哪块物理盘？重启之后它还叫这个名字吗？扇区是 512 还是 4K，分区对齐了吗？将来容量不够了能不能不停机扩容？这一课回答这些问题。

学完你能用 `lsblk`、`blkid`、`udevadm` 摸清一台机器上的所有块设备，理解为什么生产环境必须用 `/dev/disk/by-id` 引用磁盘，用 `parted` 建出 4K 对齐的 GPT 分区，并用 LVM 完成创建、在线扩容、精简配置和快照。全部实验都在 loop 设备上完成，不会碰到你的真实磁盘。

## 什么是块设备

**块设备（Block Device）** 是一种以固定大小的块为单位、可以按地址随机读写的设备。磁盘、分区、RAID 阵列、LVM 逻辑卷、loop 设备、iSCSI LUN，在内核看来都是块设备。它和字符设备（终端、串口）的区别在于：块设备可以随机寻址，内核会为它提供缓存和 I/O 调度。

`ls -l /dev/vda` 输出的首字母 `b` 表示块设备（字符设备是 `c`），紧跟的 `253, 0` 是主设备号（驱动）和次设备号（实例）。更完整的信息在 `/sys/block/` 下，每个设备一个目录，上一课看到的 `queue/`、`device/` 都在这里。

### 设备名从哪来

| 名字 | 驱动 / 来源 | 说明 |
|---|---|---|
| `sda`、`sdb`… | SCSI 子系统（SATA、SAS、USB、iSCSI 都走这里） | 按**发现顺序**分配字母，分区是 `sda1` |
| `nvme0n1` | NVMe | 控制器 0 的命名空间 1，分区是 `nvme0n1p1` |
| `vda`、`vdb`… | virtio-blk（KVM 虚拟机） | 分区是 `vda1` |
| `loop0`… | loop 驱动，把文件当成盘 | 分区是 `loop0p1`（需要 `-P`） |
| `dm-0`… | device mapper（LVM、dm-crypt、多路径） | 通常通过 `/dev/mapper/<名字>` 访问 |
| `md0`… | Linux 软 RAID | 见[RAID 与 mdadm](/learn/raid) |

### lsblk：一眼看清设备树

```console
$ lsblk
NAME                      MAJ:MIN RM  SIZE RO TYPE MOUNTPOINTS
loop0                       7:0    0 63.9M  1 loop /snap/core20/2318
loop1                       7:1    0   87M  1 loop /snap/lxd/29351
vda                       253:0    0   40G  0 disk
├─vda1                    253:1    0    1M  0 part
├─vda2                    253:2    0    2G  0 part /boot
└─vda3                    253:3    0   38G  0 part
  └─ubuntu--vg-ubuntu--lv 252:0    0   19G  0 lvm  /
vdb                       253:16   0   20G  0 disk
```

这是一台典型的 Ubuntu 24.04 虚拟机：`vda3` 是 LVM 物理卷，上面切出了根分区的逻辑卷；`loop0`、`loop1` 被 snap 占用（后面做实验时要注意别撞上）。常用的列组合：

```bash
lsblk -f                                   # 文件系统类型、标签、UUID、挂载点
lsblk -o NAME,SIZE,TYPE,FSTYPE,MOUNTPOINTS,SERIAL,WWN
lsblk -d -o NAME,SIZE,ROTA,TRAN,LOG-SEC,PHY-SEC,MODEL    # 只看整盘
```

`blkid` 从设备上读出文件系统签名，是查 UUID 最直接的方式：

```console
$ sudo blkid /dev/vda2
/dev/vda2: UUID="2f4c6b3e-8a1d-4f0e-9c7b-1d2e3f4a5b6c" BLOCK_SIZE="4096" TYPE="ext4" PARTUUID="7a9b1c2d-..."
```

## 稳定命名：生产环境必须用 by-id

### sdX 为什么不可靠

`sda`、`sdb` 的字母是内核按探测顺序分配的。控制器初始化快慢、某块盘上电晚了半秒、换了一块盘、加了一张 HBA 卡、插了个 U 盘，都可能让字母整体错位。**上次重启时的 `sdc`，这次可能变成了 `sdd`**。

> [!DANGER] 用 sdX 写脚本，迟早格错盘
> 真实事故模式：运维脚本里写死了 `mkfs.xfs /dev/sdc`，某次换盘重启后字母顺移，`sdc` 变成了另一块装着数据的盘。凡是会**写入、格式化、加入阵列或存储集群**的操作，一律用 `/dev/disk/by-id/` 下的路径，并在执行前用序列号核对。

### udev 与 /dev/disk/by-*

设备出现时，内核发出 uevent，用户态的 **udev** 根据规则读取设备的型号、序列号、WWN、所在总线路径等属性，在 `/dev/disk/` 下创建一组指向真实设备的符号链接：

| 目录 | 依据 | 稳定性 | 典型用途 |
|---|---|---|---|
| `by-id/` | 型号 + 序列号，或 WWN / EUI | 跟着**物理盘**走，换槽位也不变 | 引用整盘：建 RAID、Ceph OSD、GPFS NSD |
| `by-path/` | PCI 地址 + 端口 / 槽位 | 跟着**槽位**走，换了盘名字不变 | 按槽位定位、自动化换盘 |
| `by-uuid/` | 文件系统 UUID | 跟着**文件系统**走，重新 mkfs 会变 | `/etc/fstab` 挂载 |
| `by-partuuid/` | GPT 分区 UUID | 跟着分区走 | 引导配置、无文件系统的分区 |
| `by-label/` | 文件系统标签 | 标签可能重复 | 人工可读的临时挂载 |

```console
$ ls -l /dev/disk/by-id/ | grep -v part
lrwxrwxrwx 1 root root  9 Sep 24 09:12 ata-ST20000NM007D-3DJ103_ZVT0XXXX -> ../../sda
lrwxrwxrwx 1 root root 13 Sep 24 09:12 nvme-SAMSUNG_MZQL23T8HCLS-00A07_S64HNXXXX -> ../../nvme0n1
lrwxrwxrwx 1 root root 13 Sep 24 09:12 nvme-eui.36344830526021230025384500000001 -> ../../nvme0n1
lrwxrwxrwx 1 root root  9 Sep 24 09:12 wwn-0x5000c500d1234567 -> ../../sda
```

同一块盘常有多个 by-id 链接。`wwn-`/`nvme-eui.` 是全球唯一标识，最稳；`ata-型号_序列号` 可读性最好，序列号和盘上贴纸一致，方便机房人员找盘。

想知道某个设备的全部 udev 属性：

```console
$ udevadm info --query=property --name=/dev/sda | grep -E '^(ID_MODEL|ID_SERIAL_SHORT|ID_WWN|ID_PATH|DEVLINKS)='
ID_MODEL=ST20000NM007D-3DJ103
ID_SERIAL_SHORT=ZVT0XXXX
ID_WWN=0x5000c500d1234567
ID_PATH=pci-0000:3b:00.0-sas-phy4-lun-0
DEVLINKS=/dev/disk/by-id/wwn-0x5000c500d1234567 /dev/disk/by-path/pci-0000:3b:00.0-sas-phy4-lun-0 /dev/disk/by-id/ata-ST20000NM007D-3DJ103_ZVT0XXXX
```

> [!NOTE] 虚拟机和 loop 设备的 by-id
> loop 设备没有序列号，不会出现在 `by-id/` 下。KVM 虚拟机里的 virtio 盘只有在虚拟机配置里设置了 `serial` 时才会出现 `virtio-<序列号>` 链接。练习时可以用 `by-path/` 或 `by-uuid/` 代替，但要记住在物理机上的正确做法。

> [!PROD] 上架时建一张盘位表
> 新节点上线前，把 `槽位 ↔ by-path ↔ by-id（序列号）↔ 用途` 记成一张表放进 CMDB 或 Git。换盘时先用 `by-path` 确认槽位，再用 `ledctl locate=/dev/disk/by-id/...`（ledmon 包）点亮定位灯，最后核对序列号再拔盘。Ceph 的 `ceph device ls` 也会列出每个 OSD 对应的盘序列号。

## 扇区大小与 4K 对齐

### 逻辑扇区与物理扇区

上一课讲过，很多盘是 512e：对外报 512 字节逻辑扇区，内部是 4K 物理扇区。内核通过 sysfs 暴露这几个关键值：

```console
$ grep . /sys/block/sda/queue/{logical_block_size,physical_block_size,minimum_io_size,optimal_io_size}
/sys/block/sda/queue/logical_block_size:512
/sys/block/sda/queue/physical_block_size:4096
/sys/block/sda/queue/minimum_io_size:4096
/sys/block/sda/queue/optimal_io_size:0
```

- `logical_block_size`：可寻址的最小单位，I/O 必须是它的整数倍。
- `physical_block_size`：真正的读写单位，小于它的写要做读-改-写。
- `optimal_io_size`：RAID 阵列、部分 SSD 会报告条带宽度，文件系统据此对齐分配。

### 为什么要对齐

如果分区从第 63 个扇区开始（老式 MBR 工具的默认值），分区里的每个 4K 块都会横跨两个物理扇区：

```text
物理扇区（4K）  |    P0     |    P1     |    P2     |
未对齐分区      |  ↘  4K 块 A ↘  4K 块 B ↘ ...        每次写一个块要改两个物理扇区
                  起点 = 63 × 512 = 32256 字节，不是 4096 的整数倍
对齐分区        |  4K 块 A  |  4K 块 B  |  4K 块 C  |  一一对应
                  起点 = 2048 × 512 = 1 MiB
```

现代工具（`parted`、`fdisk`、`sgdisk`）默认都把第一个分区放在 **1 MiB** 处。1 MiB 是 4K、64K、256K、1M 等常见条带和擦除块的公倍数，能同时满足 HDD、SSD 和 RAID 的对齐需求。经验法则：**分区起点和大小都用 MiB 为单位来写，就不会出错。**

## GPT 分区与 parted

### MBR 还是 GPT

| | MBR | GPT |
|---|---|---|
| 最大磁盘 | 2 TiB（512 字节扇区时） | 实际无上限（8 ZiB） |
| 分区数 | 4 个主分区（或扩展分区套逻辑分区） | 默认 128 个 |
| 冗余 | 无，分区表只在第 0 扇区 | 头部和尾部各一份，带 CRC 校验 |
| 分区标识 | 1 字节类型码 | 类型 GUID + 每个分区唯一的 PARTUUID + 名字 |

没有理由再用 MBR。今天的数据盘动辄 20 TB，MBR 根本放不下。

> [!TIP] 数据盘需要分区吗？
> 交给 LVM、mdadm、Ceph、GPFS 的整盘，通常直接用整盘设备，不必分区——Ceph 的 `ceph-volume` 会自己在整盘上建 LVM。需要分区的场景是：一块盘要切给多个用途、系统盘、或者希望分区表上的名字/类型能告诉后来者"这块盘是干什么的"。

### 准备实验用的 loop 设备

> [!LAB] 造三块"盘"
> 用稀疏文件模拟磁盘，`-P` 让内核扫描分区表，`--show` 打印分配到的设备名。Ubuntu 上 snap 已经占了若干 loop 设备，**一定要用变量记住你拿到的设备名**，不要想当然地写 `/dev/loop0`。
>
> ```bash
> sudo mkdir -p /var/lib/lab
> for i in 1 2 3; do sudo truncate -s 2G /var/lib/lab/disk$i.img; done
> D1=$(sudo losetup -fP --show /var/lib/lab/disk1.img)
> D2=$(sudo losetup -fP --show /var/lib/lab/disk2.img)
> D3=$(sudo losetup -fP --show /var/lib/lab/disk3.img)
> echo $D1 $D2 $D3          # 例如 /dev/loop8 /dev/loop9 /dev/loop10
> losetup -l | grep /var/lib/lab
> ```
>
> 变量只在当前 shell 有效，换了终端需要用 `losetup -l` 重新找回。

### 用 parted 建 GPT 分区

`parted` 的 `-s`（script）模式适合写进脚本；交互模式下每条命令会立即写盘，没有"保存"这一步。

> [!DANGER] 分区命令会覆盖目标设备的分区表
> 下面的命令只对 `$D1` 这个 loop 设备执行。执行前 `echo $D1` 确认它是 `/dev/loopN`。在真实服务器上，把设备换成 `/dev/disk/by-id/...` 并反复核对序列号。

```bash
sudo parted -s $D1 mklabel gpt
sudo parted -s $D1 mkpart data1 1MiB 50%
sudo parted -s $D1 mkpart data2 50% 100%
sudo parted -s $D1 unit s print
sudo parted -s $D1 align-check optimal 1
```

```text
Model: Loopback device (loopback)
Disk /dev/loop8: 4194304s
Sector size (logical/physical): 512B/512B
Partition Table: gpt
Disk Flags:

Number  Start     End       Size      File system  Name   Flags
 1      2048s     2097151s  2095104s               data1
 2      2097152s  4192255s  2095104s               data2

1 aligned
```

GPT 里 `mkpart` 的第一个参数是分区**名字**（写入分区表的 PARTLABEL），不是文件系统类型。起点 2048 扇区正好是 1 MiB。注意磁盘最后留下的一小段：GPT 在尾部存放了备份分区表。

```console
$ lsblk -o NAME,SIZE,PARTLABEL,PARTUUID $D1
NAME      SIZE PARTLABEL PARTUUID
loop8       2G
├─loop8p1 1023M data1     3c5d7e9f-1a2b-4c3d-8e9f-0a1b2c3d4e5f
└─loop8p2 1023M data2     8f7e6d5c-4b3a-4291-a0b1-c2d3e4f5a6b7
```

其他常用操作：

```bash
sudo parted -s $D1 rm 2                  # 删除 2 号分区
sudo partprobe $D1                       # 分区表被其他工具改动后，通知内核重新读取
sudo wipefs $D1                          # 只列出签名；wipefs -a 才会擦除（回收旧盘的标准动作，破坏性）
```

### 模拟 4Kn 盘

loop 设备可以指定逻辑扇区大小，用来观察 4Kn 盘上的行为：

```console
$ sudo truncate -s 1G /var/lib/lab/disk4k.img
$ D4K=$(sudo losetup -fP --show -b 4096 /var/lib/lab/disk4k.img)
$ lsblk -o NAME,LOG-SEC,PHY-SEC $D4K
NAME   LOG-SEC PHY-SEC
loop11    4096    4096
$ sudo losetup -d $D4K
```

## LVM：让容量可以流动

### 为什么需要 LVM

直接在分区上建文件系统，容量在分区那一刻就定死了：想扩容，要么后面恰好有空闲空间，要么停机搬数据。**LVM（Logical Volume Manager）** 在物理盘和文件系统之间加了一层池化：

```text
  文件系统       ext4 (/data)        xfs (/logs)
                     │                   │
  LV 逻辑卷     ┌────┴─────┐       ┌─────┴────┐
               │ labvg/data│       │labvg/logs│     ← 从 VG 中按需切出，可在线扩容
               └────┬─────┘       └─────┬────┘
  VG 卷组      ┌────┴───────────────────┴─────────────┐
               │ labvg：PE 池（默认每个 PE 4 MiB）      │  ← 把多块 PV 的空间汇成一个池
               └────┬───────────────────┬─────────────┘
  PV 物理卷      /dev/loop9          /dev/loop10          ← 整盘、分区、RAID 阵列都可以
```

- **PV（Physical Volume）**：被 LVM 初始化过的块设备，头部写有 LVM 元数据。
- **VG（Volume Group）**：一个或多个 PV 组成的存储池，空间以 **PE（Physical Extent）** 为单位管理。
- **LV（Logical Volume）**：从 VG 中分配的虚拟块设备，由若干 PE 组成，可以跨越多个 PV。

LVM 构建在内核的 device mapper 之上，所以 LV 在 `lsblk` 里显示为 `dm-N`，在 `/dev/mapper/labvg-data` 和 `/dev/labvg/data` 两处都能访问。

### 创建 PV、VG、LV

```bash
sudo apt install -y lvm2
sudo pvcreate $D2 $D3
sudo vgcreate labvg $D2                 # 先只用一块，留 D3 演示扩容
sudo lvcreate -n data -L 1G labvg
sudo mkfs.ext4 -q /dev/labvg/data
sudo mkdir -p /mnt/lvdata && sudo mount /dev/labvg/data /mnt/lvdata
```

```console
$ sudo pvs
  PV         VG    Fmt  Attr PSize  PFree
  /dev/loop10      lvm2 ---   2.00g    2.00g
  /dev/loop9 labvg lvm2 a--  <2.00g 1020.00m
$ sudo vgs
  VG    #PV #LV #SN Attr   VSize  VFree
  labvg   1   1   0 wz--n- <2.00g 1020.00m
$ sudo lvs
  LV   VG    Attr       LSize Pool Origin Data%  Meta%  Move Log Cpy%Sync Convert
  data labvg -wi-ao---- 1.00g
```

`<2.00g` 是因为 PV 头部的元数据占掉了一点空间，剩余不足整 2 GiB。`pvdisplay`、`vgdisplay`、`lvdisplay` 给出更详细的信息，包括 PE 大小和总数。

### 在线扩容

LVM 最常用的功能：业务不停，文件系统在挂载状态下直接变大。

```bash
# 1) VG 空间不够时，先加一块盘进来
sudo vgextend labvg $D3

# 2) 扩 LV，-r 表示同时扩展上面的文件系统（ext4 调 resize2fs，XFS 调 xfs_growfs）
sudo lvextend -r -L +1.5G labvg/data

df -h /mnt/lvdata
```

```text
Filesystem              Size  Used Avail Use% Mounted on
/dev/mapper/labvg-data  2.4G   24K  2.3G   1% /mnt/lvdata
```

`-L +1.5G` 是增加 1.5G，`-L 3G` 是扩到 3G，`-l +100%FREE` 是吃掉 VG 里全部剩余空间。

> [!TIP] Ubuntu 默认安装只给根分区用了一半
> Ubuntu Server 安装程序使用 LVM 时，默认只把 VG 的一部分（上限 100 GB）分配给 `ubuntu-lv`，剩下的空着。这就是上面 `lsblk` 里 38G 的 PV 上只有 19G 根分区的原因。需要时一条命令就能在线用满：`sudo lvextend -r -l +100%FREE /dev/ubuntu-vg/ubuntu-lv`。

> [!WARNING] 缩容要非常小心
> ext4 支持缩小，但必须先卸载、`e2fsck -f`、`resize2fs` 缩文件系统，再 `lvreduce`，顺序错了就会截断数据（`lvreduce -r` 可以自动按正确顺序做）。XFS **不支持缩小**。实践中宁可一开始分得保守，按需扩容，也不要指望缩容。

LVM 还能在线迁移数据：`pvmove /dev/老盘 /dev/新盘` 会在不停业务的情况下把 PE 搬到新盘，然后 `vgreduce` 把老盘移出 VG。这是在不支持热换的老旧存储上换盘的常用手段。

### 精简配置（Thin Provisioning）

普通 LV 创建时就占满了声明的容量（厚置备）。**精简配置**先建一个**精简池（thin pool）**，再从池里创建"虚拟大小"任意的精简卷，真正写入时才分配空间，因此可以**超额分配（overcommit）**。

```bash
sudo lvcreate --type thin-pool -L 1G -n tpool labvg
sudo lvcreate -V 5G --thin -n thin1 labvg/tpool
sudo lvcreate -V 5G --thin -n thin2 labvg/tpool
```

```text
  WARNING: Sum of all thin volume sizes (10.00 GiB) exceeds the size of thin pool labvg/tpool and the size of whole volume group (<3.99 GiB).
  WARNING: You have not turned on protection against thin pools running out of space.
  WARNING: Set activation/thin_pool_autoextend_threshold below 100 to trigger automatic extension of thin pools before they get full.
  Logical volume "thin2" created.
```

1G 的池子声明出了两个 5G 的卷，LVM 已经在警告你了。写一点数据看看池的使用率：

```console
$ sudo mkfs.ext4 -q /dev/labvg/thin1
$ sudo mkdir -p /mnt/thin1 && sudo mount /dev/labvg/thin1 /mnt/thin1
$ sudo dd if=/dev/urandom of=/mnt/thin1/blob bs=1M count=300 status=none && sync
$ sudo lvs -o lv_name,lv_size,pool_lv,data_percent,metadata_percent labvg
  LV    LSize Pool  Data%  Meta%
  data  2.50g
  thin1 5.00g tpool 6.44
  thin2 5.00g tpool 0.00
  tpool 1.00g       32.23  11.23
```

> [!PROD] 精简池写满 = 所有精简卷一起出事
> 池的数据空间或元数据空间用尽后，所有精简卷的写入都会报错或挂起，上面的文件系统可能损坏。生产使用必须：监控 `data_percent` 与 `metadata_percent` 并告警；在 `/etc/lvm/lvm.conf` 里设置 `thin_pool_autoextend_threshold = 80`、`thin_pool_autoextend_percent = 20`，并确保 VG 里留有可供自动扩展的空间。超额分配是一张"信用卡"，要有人按时还款。

精简配置的另一个好处是配合 `discard`：文件系统删除文件后执行 `fstrim /mnt/thin1`，池里的空间会被真正归还。

### LVM 快照

快照让你得到某个 LV 在某一时刻的只读（或可写）视图，常用于"升级前留个后悔药"或"在一致的时间点上做备份"。

#### 传统快照（COW）

```bash
echo "important v1" | sudo tee /mnt/lvdata/config.txt
sudo lvcreate -s -n data-snap -L 256M labvg/data   # 给快照分配 256M 的 COW 空间
sudo rm /mnt/lvdata/config.txt                     # 手滑删掉了
sudo mkdir -p /mnt/snap
sudo mount -o ro /dev/labvg/data-snap /mnt/snap
cat /mnt/snap/config.txt                           # important v1，找回来了
```

传统快照的原理是写时复制（Copy-on-Write）：快照刚建好时不占空间，之后源卷每修改一个块，LVM 先把旧内容复制到快照的 COW 区，再写新数据。这带来两个后果：

- 源卷上的每次首次写都变成"读旧块 + 写 COW + 写新块"，**性能明显下降**，快照越多越慢。
- COW 区写满后快照**直接失效**（`lvs` 里 `Data%` 到 100% 后 Attr 显示 `I`），只能删除。

`lvs` 的 `Data%` 列就是 COW 区的使用率。确认要回滚时，可以把快照合并回源卷：

```bash
sudo umount /mnt/snap /mnt/lvdata
sudo lvconvert --merge labvg/data-snap             # 源卷回到快照时刻，快照随之消失
sudo mount /dev/labvg/data /mnt/lvdata && cat /mnt/lvdata/config.txt
```

如果源卷正在使用中无法卸载（比如根分区），合并会推迟到下次激活该 LV 时（通常是重启）。

#### 精简快照

精简卷的快照不需要预先指定大小，直接共享池里的数据块，性能损耗远小于传统快照，也可以对快照再做快照：

```bash
sudo lvcreate -s -n thin1-snap labvg/thin1
sudo lvchange -ay -K labvg/thin1-snap              # 精简快照默认带"跳过激活"标志，-K 忽略它
```

> [!WARNING] 快照不是备份
> 快照和源卷在同一个 VG、同一批物理盘上，盘坏了两者一起没。快照的正确用法是"提供一个一致的时间点"，然后把快照里的数据拷到别的存储上。另外，挂载 XFS 快照时需要 `-o nouuid`，因为快照和源卷的文件系统 UUID 相同，XFS 拒绝同时挂载两个同 UUID 的文件系统；ext4 没有这个限制。

### 清理实验环境

```bash
sudo umount /mnt/snap /mnt/lvdata /mnt/thin1 2>/dev/null
sudo vgremove -y labvg                  # 删除 VG 以及其中所有 LV
sudo pvremove $D2 $D3
sudo losetup -d $D1 $D2 $D3
sudo rm -f /var/lib/lab/disk*.img
```

> [!PROD] Ceph、容器平台都在用 LVM
> Ceph 的 `ceph-volume` 会在每块 OSD 盘上建一个 `ceph-<uuid>` 的 VG 和一个 LV，BlueStore 直接使用这个 LV。回收旧盘重新部署时，残留的 LVM 元数据和分区签名会让 OSD 创建失败，这就是为什么需要 `ceph orch device zap` 或 `ceph-volume lvm zap --destroy` 先清盘。阶段 4 的 [cephadm 部署](/learn/cephadm-deploy)会遇到它。

## 动手练习

1. 在你的机器上执行 `ls -l /dev/disk/by-id/ /dev/disk/by-path/ /dev/disk/by-uuid/`，为每块整盘找出它的所有稳定名字，并用 `udevadm info --query=property` 核对序列号。
2. 用 `sudo parted -s -a none $D1 mklabel msdos mkpart primary 63s 100%` 故意建一个从第 63 扇区开始的 MBR 分区（`-a none` 关闭自动对齐），然后执行 `align-check optimal 1`，观察结果并解释原因；再改回 GPT、1MiB 起点的正确分区。
3. 按本课流程建 `labvg/data`，在里面持续写入（`while true; do date >> /mnt/lvdata/log; sleep 1; done`）的同时执行 `vgextend` 与 `lvextend -r`，确认写入没有中断。
4. 创建一个 200M 的传统快照，然后往源卷写入 300M 数据，观察 `lvs` 中快照 `Data%` 的变化以及快照最终的状态。
5. 把精简池设置为自动扩展（修改 `lvm.conf` 中的两个参数），往 `thin1` 持续写数据直到超过池的初始大小，观察池是否自动长大。

## 自测

<details>
<summary>为什么脚本里格式化或组阵列时不能写 /dev/sdb，而要写 /dev/disk/by-id/...？</summary>

`sdX` 按内核探测顺序分配，重启、换盘、加卡、插 U 盘都可能改变顺序，同一个名字可能指向另一块装有数据的盘。`by-id` 基于盘的序列号或 WWN，跟着物理盘走，不会因为探测顺序变化而改变，破坏性操作用它才安全。

</details>

<details>
<summary>一块 512e 硬盘上，分区从第 63 个扇区开始，会有什么问题？</summary>

起点 63 × 512 = 32256 字节不是 4096 的整数倍，分区内每个 4K 文件系统块都会横跨两个物理扇区。每次写一个 4K 块，盘都要对两个物理扇区做读-改-写，写性能大幅下降。现代工具默认从 1 MiB（第 2048 个扇区）开始即可避免。

</details>

<details>
<summary>PV、VG、LV、PE 分别是什么？一个 LV 能否跨越多块物理盘？</summary>

PV 是被 LVM 初始化的块设备；VG 是由一个或多个 PV 组成的存储池；PE 是 VG 中分配空间的最小单位（默认 4 MiB）；LV 是从 VG 中分配若干 PE 组成的虚拟块设备。LV 可以由来自多个 PV 的 PE 组成，所以能跨越多块物理盘（默认线性拼接，这时任何一块盘坏都会影响该 LV）。

</details>

<details>
<summary>精简配置有什么风险？生产中如何防范？</summary>

精简配置允许卷的虚拟容量总和超过池的实际容量。一旦池的数据或元数据空间写满，池中所有精简卷的写入都会失败或挂起，文件系统可能损坏。防范措施：监控 `data_percent` 和 `metadata_percent` 并告警；配置 `thin_pool_autoextend_threshold` 和 `thin_pool_autoextend_percent` 自动扩展，并保证 VG 中有余量；定期 `fstrim` 回收已删除的空间。

</details>

<details>
<summary>传统 LVM 快照为什么会拖慢源卷？它的 COW 空间写满会怎样？</summary>

快照建立后，源卷上每个块第一次被修改前，LVM 都要先读出旧数据复制到快照的 COW 区，再写入新数据，一次写变成了多次 I/O，快照越多越慢。COW 区写满后快照立即失效，无法再使用，只能删除。

</details>

## 参考资料

- [Arch Wiki：Persistent block device naming](https://wiki.archlinux.org/title/Persistent_block_device_naming)
- [Arch Wiki：Advanced Format](https://wiki.archlinux.org/title/Advanced_Format)
- [GNU Parted 用户手册](https://www.gnu.org/software/parted/manual/parted.html)
- [lvm(8) 手册页](https://man7.org/linux/man-pages/man8/lvm.8.html)
- [lvmthin(7) 手册页](https://man7.org/linux/man-pages/man7/lvmthin.7.html)
- [Linux 内核文档：Device Mapper](https://docs.kernel.org/admin-guide/device-mapper/index.html)
- [udev(7) 手册页](https://man7.org/linux/man-pages/man7/udev.7.html)
