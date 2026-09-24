# 搭建实验环境

学存储离不开"盘"：要分区、要组 RAID、要格式化、要拔掉一块看看会怎样。可你手上大概只有一台笔记本，系统盘还装着自己的全部家当。这一课的目标，是造出一台**可以随便折腾坏**的 Linux 实验机：它有很多块"盘"，装齐了后续课程要用的观测和压测工具，坏了几分钟就能重来。

学完这一课，你会有一台 Ubuntu 24.04 虚拟机，挂着 4 块空白虚拟盘；知道在没有虚拟盘时怎样用 loop 设备、null_blk、brd 模拟块设备；并用一份验证清单确认环境可用。最后我们预告一下阶段 3 之后要用的多节点环境。

## 实验环境要满足什么

先说清楚需求，后面的选择就顺理成章了：

1. **真的 Linux 内核**。我们要加载内核模块、用 bpftrace 挂内核探针、看 `/sys/block` 下的队列参数，所以必须是完整的虚拟机，不能是容器。
2. **很多块盘**。RAID 10 至少要 4 块，LVM 扩容要能再加一块，Ceph 每个节点要 2～3 块。
3. **可以随便弄坏**。`mkfs` 错了、`fstab` 写错开不了机，都能一键恢复。
4. **和生产尽量一致**。本课程以 Ubuntu 24.04 LTS（内核 6.8）为准，Ceph、Kubernetes 的生产部署文档大多也支持它。

> [!WARNING] 为什么不用 Docker 容器做实验
> 容器和宿主机共享内核，看不到独立的块设备，不能 `modprobe`，默认也没有权限跑 BPF。在容器里 `mkfs` 一块"盘"，要么权限被拒，要么（加了 `--privileged`）直接动到宿主机的设备。存储实验请一律用虚拟机。

## 选择虚拟化方案

| 宿主系统 | 推荐方案 | 备选 | 多块虚拟盘 | 说明 |
|---|---|---|---|---|
| macOS（Apple Silicon / Intel） | Lima | UTM、Multipass | Lima、UTM 支持 | Lima 命令行驱动，最适合反复重建；Apple Silicon 上跑的是 ARM64 版 Ubuntu，本课程命令同样适用 |
| Windows 10/11 专业版 | Hyper-V | WSL2、VirtualBox | Hyper-V 支持 | WSL2 内核是微软定制的，部分模块和 BPF 功能受限，只适合前两个阶段 |
| Linux 桌面 | KVM + libvirt | Lima、Multipass | 支持 | 性能最好，也最接近生产 |
| 没有合适的电脑 | 云主机 | — | 挂载云硬盘 | 按量付费，用完释放；注意云硬盘的性能是被限速的 |

建议配置：**4 vCPU、8 GB 内存、40 GB 系统盘、4 块 20 GB 数据盘**。数据盘都是精简置备（Thin Provisioning）的，不写数据时几乎不占宿主机空间。

### macOS：Lima（推荐）

[Lima](https://lima-vm.io/) 用一条命令就能拉起一台 Ubuntu 虚拟机，并支持附加额外的磁盘。

```bash
brew install lima

# 创建 4 块 20 GB 的空白数据盘
for i in 1 2 3 4; do limactl disk create sj-d$i --size 20G; done

# 创建并启动虚拟机：4 核 / 8 GB / 40 GB 系统盘，挂上 4 块数据盘且不自动格式化
limactl start --name=sj --cpus=4 --memory=8 --disk=40 --tty=false \
  --set '.additionalDisks = [
    {"name":"sj-d1","format":false},
    {"name":"sj-d2","format":false},
    {"name":"sj-d3","format":false},
    {"name":"sj-d4","format":false}]' \
  template://ubuntu-24.04

# 进入虚拟机
limactl shell sj
```

`"format": false` 很关键：Lima 默认会把附加盘格式化成 ext4 并挂到 `/mnt/lima-<盘名>`，那就不是"空白盘"了。进去之后先 `lsblk` 确认数据盘没有文件系统、没有挂载点。

> [!TIP] Lima 的几个常用命令
> `limactl list` 看实例；`limactl stop sj` / `limactl start sj` 关机开机；`limactl delete sj` 删除虚拟机（数据盘保留，可以 `limactl disk delete sj-d1` 删掉）。截至本文写作时 Lima 已发布 2.x 版本，新版本中模板写法推荐 `template:ubuntu-24.04`，旧写法 `template://` 仍兼容，具体以官方文档为准。

### macOS：UTM 或 Multipass

- **UTM**：图形界面，下载 [Ubuntu Server 24.04](https://ubuntu.com/download/server)（Apple Silicon 选 ARM 版）ISO 安装。装好后关机，在虚拟机设置里点"新建驱动器"，接口选 VirtIO，添加 4 块 20 GB 盘。
- **Multipass**：`multipass launch 24.04 --name sj --cpus 4 --memory 8G --disk 40G` 就能起一台，但它**不支持附加额外磁盘**，需要用下文的 loop 设备代替。

### Windows：Hyper-V（推荐）或 WSL2

Windows 专业版 / 企业版自带 Hyper-V。先在"启用或关闭 Windows 功能"里勾选 Hyper-V 并重启，下载 Ubuntu Server 24.04 ISO，然后在**管理员 PowerShell** 中执行：

```text title="PowerShell（管理员）"
New-Item -ItemType Directory -Path C:\VMs\sj
New-VM -Name sj -Generation 2 -MemoryStartupBytes 8GB `
  -NewVHDPath C:\VMs\sj\os.vhdx -NewVHDSizeBytes 40GB -SwitchName "Default Switch"
Set-VMProcessor -VMName sj -Count 4
Set-VMFirmware -VMName sj -SecureBootTemplate MicrosoftUEFICertificateAuthority
Add-VMDvdDrive -VMName sj -Path C:\ISO\ubuntu-24.04-live-server-amd64.iso
Set-VMFirmware -VMName sj -FirstBootDevice (Get-VMDvdDrive -VMName sj)

# 4 块动态扩展的数据盘
1..4 | ForEach-Object {
  New-VHD -Path "C:\VMs\sj\d$_.vhdx" -SizeBytes 20GB -Dynamic
  Add-VMHardDiskDrive -VMName sj -Path "C:\VMs\sj\d$_.vhdx"
}
Start-VM -Name sj
```

在 Hyper-V 管理器里连接到虚拟机完成安装，安装时只选系统盘，数据盘保持空白。Hyper-V 的盘在 Ubuntu 里显示为 `sda`、`sdb`……

**WSL2** 也能用（`wsl --install -d Ubuntu-24.04`），并且可以用 loop 设备做阶段 0、1 的大部分实验。但它的内核是微软编译的，缺少 null_blk 等模块，部分 BPF 工具也不完整。只想先跑起来可以用它，到阶段 2 请换 Hyper-V。

### Linux：KVM + libvirt

宿主机本身就是 Linux 的话，最省事的是也装 Lima 或 Multipass；习惯 libvirt 的，用 `virt-manager` 装好 Ubuntu 后，这样加盘：

```bash
sudo qemu-img create -f qcow2 /var/lib/libvirt/images/sj-d1.qcow2 20G
sudo virsh attach-disk sj /var/lib/libvirt/images/sj-d1.qcow2 vdb \
  --driver qemu --subdriver qcow2 --targetbus virtio --persistent
```

> [!NOTE] 想要一块"NVMe"盘
> 阶段 1 会用 `nvme-cli` 看 NVMe 的 SMART 和命名空间。virtio 盘不是 NVMe，看不到这些信息。如果直接用 QEMU，可以模拟一块 NVMe 盘：`-drive file=nvme.img,if=none,id=nvm -device nvme,serial=sj0001,drive=nvm`，虚拟机里就会出现 `/dev/nvme0n1`。没有条件也没关系，那一课会给出真实设备的输出示例。

## 虚拟机里的第一件事

进入虚拟机后，先更新系统、确认内核版本：

```console
$ sudo apt update && sudo apt -y full-upgrade
$ uname -r
6.8.0-79-generic
$ grep VERSION= /etc/os-release
VERSION="24.04.3 LTS (Noble Numbat)"
$ lsblk
NAME    MAJ:MIN RM  SIZE RO TYPE MOUNTPOINTS
vda     253:0    0   40G  0 disk
├─vda1  253:1    0 39.9G  0 part /
├─vda15 253:15   0   99M  0 part /boot/efi
└─vda16 259:0    0  923M  0 part /boot
vdb     253:16   0  366M  1 disk
vdc     253:32   0   20G  0 disk
vdd     253:48   0   20G  0 disk
vde     253:64   0   20G  0 disk
vdf     253:80   0   20G  0 disk
```

- 内核小版本号（`-79`）会随更新变化，只要是 6.8 或更高即可。Ubuntu 24.04 的 HWE 内核（6.11 以上）也完全可以。
- 上面是 Lima（macOS 默认的 VZ 后端）的输出：`vdb` 是 Lima 用来传递 cloud-init 配置的只读小盘（`RO` 为 1），**不要动它**；不同后端下它可能是光驱 `sr0`，也可能没有。4 块 20 GB 的才是我们的数据盘。
- 设备名因平台而异（`vdX`、`sdX`、`nvmeXnY`），本课程后续命令里的设备名请**一律替换成你自己 `lsblk` 看到的名字**。

> [!DANGER] 永远先 lsblk，再动盘
> 所有 `mkfs`、`wipefs`、`dd of=`、`mdadm --create` 之前，先执行 `lsblk -f` 确认目标设备的大小、有没有文件系统、有没有挂载点。系统盘上有 `/` 挂载点，看到它就停手。这个习惯在生产环境能救命。

## 安装工具

后续课程要用的工具一次装齐：

```bash
sudo apt update
sudo apt install -y \
  fio sysstat iotop-c blktrace ioping strace \
  bpfcc-tools bpftrace linux-headers-$(uname -r) \
  nvme-cli smartmontools hdparm sg3-utils \
  lvm2 xfsprogs e2fsprogs btrfs-progs gdisk parted jq
# mdadm 默认会推荐安装邮件服务（用于告警邮件），实验机不需要
sudo apt install -y --no-install-recommends mdadm
```

| 工具 | 所属包 | 用途 | 首次登场 |
|---|---|---|---|
| `fio` | fio | 块存储与文件系统压测的事实标准 | 阶段 2 |
| `iostat`、`pidstat`、`sar` | sysstat | 设备级、进程级 I/O 统计 | 阶段 2 |
| `iotop-c` | iotop-c | 按进程看实时 I/O | 阶段 2 |
| `blktrace`、`blkparse` | blktrace | 跟踪块层请求的每个阶段 | 阶段 2 |
| `biolatency-bpfcc` 等 | bpfcc-tools | BCC 工具集，Ubuntu 上命令名带 `-bpfcc` 后缀 | 阶段 0、2 |
| `bpftrace` | bpftrace | 写自己的内核追踪脚本 | 阶段 0、2 |
| `nvme`、`smartctl`、`hdparm` | nvme-cli 等 | 查看盘的型号、SMART、健康状态 | 阶段 1 |
| `pvcreate`、`lvcreate` | lvm2 | 逻辑卷管理 | 阶段 1 |
| `mdadm` | mdadm | Linux 软件 RAID | 阶段 1 |
| `mkfs.xfs`、`mkfs.ext4` | xfsprogs、e2fsprogs | 创建文件系统 | 阶段 1 |
| `sgdisk`、`parted` | gdisk、parted | GPT 分区 | 阶段 1 |
| `ioping`、`strace` | ioping、strace | 测单次 I/O 延迟，跟踪系统调用 | 阶段 0 |

`bpfcc-tools` 需要和当前内核版本一致的头文件，所以装了 `linux-headers-$(uname -r)`。以后升级内核并重启后，记得再装一次对应版本的头文件。

sysstat 默认不在后台采集历史数据，打开它，以后可以用 `sar -d` 回看过去的磁盘数据：

```bash
sudo sed -i 's/^ENABLED="false"/ENABLED="true"/' /etc/default/sysstat
sudo systemctl enable --now sysstat
```

验证 BPF 工具能用：

```console
$ sudo bpftrace -e 'kprobe:vfs_read { @[comm] = count(); } interval:s:3 { exit(); }'
Attaching 2 probes...

@[systemd-journal]: 12
@[bash]: 21
@[sshd]: 38
$ sudo biolatency-bpfcc 3 1
Tracing block device I/O... Hit Ctrl-C to end.

     usecs               : count     distribution
        64 -> 127        : 3        |*************                           |
       128 -> 255        : 9        |****************************************|
       256 -> 511        : 2        |********                                |
```

> [!WARNING] bpftrace 报错排查
> 如果看到 `ERROR: Could not resolve symbol: /proc/self/exe:BEGIN_trigger`，这是 Ubuntu 24.04 早期 bpftrace 包的已知问题，只影响 `BEGIN` / `END` 探针，先 `sudo apt install --only-upgrade bpftrace` 升级到最新包。如果提示找不到内核头文件或 BTF，检查 `ls /sys/kernel/btf/vmlinux` 是否存在，以及 `linux-headers-$(uname -r)` 是否已安装。

## 没有虚拟盘？自己造块设备

用 Multipass、WSL2，或者只是想临时多几块盘，Linux 自己就能"造"块设备。这里介绍三种，各有用途。

### loop 设备：用文件当盘

loop 设备把一个普通文件映射成块设备。配合 `truncate` 创建的稀疏文件（Sparse File），10 GB 的"盘"一开始几乎不占空间：

```console
$ sudo mkdir -p /var/lib/sj-disks && sudo truncate -s 10G /var/lib/sj-disks/disk1.img
$ du -h --apparent-size /var/lib/sj-disks/disk1.img; du -h /var/lib/sj-disks/disk1.img
10G     /var/lib/sj-disks/disk1.img
0       /var/lib/sj-disks/disk1.img
$ sudo losetup -f -P --show --direct-io=on /var/lib/sj-disks/disk1.img
/dev/loop8
$ losetup -l /dev/loop8
NAME       SIZELIMIT OFFSET AUTOCLEAR RO BACK-FILE                    DIO LOG-SEC
/dev/loop8         0      0         0  0 /var/lib/sj-disks/disk1.img   1     512
```

参数含义：`-f` 找第一个空闲的 loop 设备，`-P` 让内核扫描分区表（以后分区会出现 `loop8p1`），`--show` 打印分配到的设备名，`--direct-io=on` 让 loop 对底层文件使用直接 I/O，避免数据在页缓存里存两份。

为什么是 `loop8` 而不是 `loop0`？Ubuntu 的 snap 软件包本身就是用 loop 设备挂载的，`lsblk` 里那一串 `loop0`～`loop7` 多半是 snap，别碰它们。

一次造 4 块、并且重启后自动恢复，可以写成脚本加 systemd 服务：

```bash title="/usr/local/sbin/sj-loop.sh"
#!/usr/bin/env bash
# 创建并挂接 storage-journey 实验用的 loop 盘：sj-loop.sh [数量] [大小]
set -euo pipefail
DIR=/var/lib/sj-disks
N=${1:-4}
SIZE=${2:-10G}
mkdir -p "$DIR"
for i in $(seq 1 "$N"); do
  img="$DIR/disk$i.img"
  [ -f "$img" ] || truncate -s "$SIZE" "$img"
  # 已经挂接过就跳过
  if [ -z "$(losetup -j "$img")" ]; then
    losetup -f -P --direct-io=on "$img"
  fi
done
losetup -l | awk 'NR==1 || /sj-disks/'
```

```ini title="/etc/systemd/system/sj-loop.service"
[Unit]
Description=Attach storage-journey loop disks
After=local-fs.target

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/sj-loop.sh 4 10G
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
```

```bash
sudo chmod +x /usr/local/sbin/sj-loop.sh
sudo systemctl daemon-reload
sudo systemctl enable --now sj-loop.service
# 不用了就拆掉：sudo losetup -d /dev/loop8，再删除镜像文件
```

> [!NOTE] loop 盘的局限
> loop 设备的 I/O 最终会落到宿主文件系统里的一个文件上，要多走一遍文件系统和块层（下一课[一次 write() 的旅程](/learn/io-stack)讲完你就明白多走了哪些）。所以它**适合练功能，不适合测性能**：分区、LVM、RAID、文件系统、Ceph OSD 都能在 loop 上跑通，但测出来的 IOPS 和延迟没有参考价值，也没有 SMART 信息可看。

### null_blk：一块"无限快"的盘

null_blk 是内核自带的测试驱动，它实现了完整的块设备接口，但默认不存数据、立刻完成请求。它的用途是**测量块层本身的开销**，或者模拟一块指定延迟的盘：

```console
$ sudo modprobe null_blk nr_devices=1 gb=4 bs=4096 queue_mode=2 irqmode=2 completion_nsec=100000
$ lsblk -dno NAME,SIZE /dev/nullb0
nullb0   4G
$ cat /sys/block/nullb0/queue/scheduler
none [mq-deadline]
```

这里 `queue_mode=2` 表示使用多队列块层（blk-mq），`irqmode=2` + `completion_nsec=100000` 表示每个请求用定时器延迟 100 μs 再完成——一块"延迟稳定 100 μs 的 SSD"就造好了。想让它真的存数据，加上 `memory_backed=1`（会占用内存）。卸载用 `sudo rmmod null_blk`。

### brd：内存盘

brd（RAM Block Device）用内存模拟块设备，数据存在内存里，重启即失：

```console
$ sudo modprobe brd rd_nr=2 rd_size=2097152     # 2 块，每块 2 GiB（单位 KiB）
$ lsblk /dev/ram0 /dev/ram1
NAME MAJ:MIN RM SIZE RO TYPE MOUNTPOINTS
ram0   1:0    0   2G  0 disk
ram1   1:1    0   2G  0 disk
```

它适合做"极快但真实存数据"的盘，比如对比同一个文件系统在内存盘和虚拟盘上的差异。注意它占用的是虚拟机内存，别开太大。卸载用 `sudo rmmod brd`。

> [!TIP] modprobe 报 Module not found
> 部分精简内核（如某些云镜像使用的 `linux-virtual`）把 null_blk、brd 这类模块放在 extra 包里：`sudo apt install -y linux-modules-extra-$(uname -r)` 后再试。WSL2 的内核则没有这些模块。

### 四种"盘"怎么选

| 类型 | 数据持久 | 性能是否可信 | 典型用途 |
|---|---|---|---|
| 虚拟盘（virtio / SCSI / NVMe） | 是 | 部分可信（受宿主机影响） | 所有实验的首选 |
| loop 设备 | 是（存在文件里） | 不可信 | 练习分区、LVM、RAID、文件系统、Ceph 部署 |
| null_blk | 默认否 | 可精确控制延迟 | 测块层开销、模拟慢盘或快盘 |
| brd | 否（重启即失） | 反映内存速度 | 对比实验、临时高速盘 |

后面的课程还会用到设备映射（Device Mapper）的 `dm-delay`、`dm-flakey` 来注入延迟和 I/O 错误，模拟"盘在慢慢坏掉"，届时再讲。

## 验证清单

把下面的脚本保存下来执行，全部 `[OK]` 就可以进入下一课：

```bash title="sj-check.sh"
#!/usr/bin/env bash
# storage-journey 实验环境自检
pass=0; fail=0
check() {
  if eval "$2" >/dev/null 2>&1; then printf '  [OK]   %s\n' "$1"; pass=$((pass+1))
  else printf '  [FAIL] %s\n' "$1"; fail=$((fail+1)); fi
}

echo "== 系统 =="
check "Ubuntu 24.04"      'grep -q "VERSION_ID=\"24.04\"" /etc/os-release'
check "内核 >= 6.8"        'dpkg --compare-versions "$(uname -r | cut -d- -f1)" ge 6.8'
check "内核 BTF 可用"      'test -e /sys/kernel/btf/vmlinux'
check "内存 >= 4 GiB"      '[ "$(awk "/MemTotal/{print \$2}" /proc/meminfo)" -ge 3800000 ]'

echo "== 工具 =="
for c in fio iostat pidstat sar blktrace ioping strace bpftrace biolatency-bpfcc \
         nvme smartctl pvcreate mdadm mkfs.xfs mkfs.ext4 sgdisk; do
  check "$c" "command -v $c"
done
check "bpftrace 能挂内核探针" 'sudo timeout 10 bpftrace -e "kprobe:vfs_read { exit(); }"'

echo "== 数据盘 =="
blank=0
for d in $(lsblk -dnpo NAME,TYPE,RO | awk '($2=="disk" || $2=="loop") && $3=="0" {print $1}'); do
  [ -n "$(lsblk -no FSTYPE,MOUNTPOINTS "$d" | tr -d '[:space:]')" ] && continue
  [ "$(lsblk -dnbo SIZE "$d")" -ge $((5*1024*1024*1024)) ] || continue
  echo "  空白盘: $d $(lsblk -dno SIZE "$d")"; blank=$((blank+1))
done
check "至少 4 块 >= 5 GiB 的空白盘（当前 $blank 块）" "[ $blank -ge 4 ]"

echo "== 结果: $pass 通过, $fail 失败 =="
```

```console
$ bash sj-check.sh
== 系统 ==
  [OK]   Ubuntu 24.04
  [OK]   内核 >= 6.8
  [OK]   内核 BTF 可用
  [OK]   内存 >= 4 GiB
== 工具 ==
  [OK]   fio
  [OK]   iostat
  ...
  [OK]   bpftrace 能挂内核探针
== 数据盘 ==
  空白盘: /dev/vdc 20G
  空白盘: /dev/vdd 20G
  空白盘: /dev/vde 20G
  空白盘: /dev/vdf 20G
  [OK]   至少 4 块 >= 5 GiB 的空白盘（当前 4 块）
== 结果: 22 通过, 0 失败 ==
```

脚本判断"空白盘"的规则是：可写、没有文件系统签名、没有挂载点、不小于 5 GiB。snap 的 loop 设备带有 squashfs 签名，会被自动排除。

### 拍一个干净的快照

环境验证通过后，**立刻拍一个快照**。以后把系统搞坏了，回到这个点只要几秒钟：

| 平台 | 操作 |
|---|---|
| Lima | QEMU 后端可用 `limactl snapshot create sj --tag clean`；macOS 默认的 VZ 后端暂不支持快照，可以关机后用 `limactl clone sj sj-clean` 复制一份（需要较新版本的 Lima） |
| UTM | 关机后在虚拟机列表里右键"克隆" |
| Hyper-V | `Checkpoint-VM -Name sj -SnapshotName clean` |
| libvirt | `virsh snapshot-create-as sj clean` |
| Multipass | `multipass stop sj && multipass snapshot sj --name clean` |

## 预告：多节点实验环境

阶段 0～2 一台虚拟机就够。从阶段 3 开始，我们要搭 NFS 服务端和客户端、部署三节点的 Ceph 集群和 Kubernetes，环境需要升级：

| 阶段 | 节点数 | 每节点配置 | 用途 |
|---|---|---|---|
| 3 | 2～3 台 | 2 vCPU、4 GB 内存、2 块数据盘 | NFS / iSCSI 服务端与客户端、MinIO |
| 4 | 3～4 台 | 4 vCPU、8 GB 内存、3 块 20 GB 以上数据盘 | cephadm 部署 Ceph、Kubernetes + Rook |
| 5 | 3～6 台 | 视内容而定，RDMA 需要支持 RDMA 的网卡 | GPFS 多集群、高性能网络 |

多节点环境有几条硬性要求，现在了解一下，到时候不会手忙脚乱：

- **节点之间网络互通**，最好在同一个二层网段并使用固定 IP。Lima 默认每台虚拟机的网络是隔离的，需要在配置里加上 `networks: [{lima: user-v2}]` 让它们互通；Multipass、Hyper-V 的 Default Switch、libvirt 的默认网络则天然互通。
- **主机名能互相解析**（写 `/etc/hosts` 即可），**时间同步**（`chrony`），管理节点到其他节点**免密 SSH**。分布式存储对时钟偏差非常敏感，Ceph 的 MON 时钟差超过 0.05 秒就会告警。
- **宿主机资源**：4 台 8 GB 的虚拟机就是 32 GB 内存，笔记本通常扛不住。可以用一台闲置的台式机装 Linux + KVM，或者直接租几台按量付费的云主机，做完实验就释放。

> [!PROD] 生产级实验环境
> 阶段 5 的 GPFS ECE（Erasure Code Edition）会检查硬件（网卡、盘的类型和数量、内存），普通虚拟机往往通不过安装前检查；RDMA 更是离不开真实的 InfiniBand 或 RoCE 网卡。这些课程会以真实生产环境的输出为主，并标明哪些步骤可以在虚拟机里练习。如果你的团队有测试用的物理机，那是最好的实验场。

## 动手练习

1. 按你的平台创建实验虚拟机，附加 4 块 20 GB 数据盘，用 `lsblk -f` 确认它们没有文件系统、没有挂载点，并记下设备名。
2. 安装全部工具，运行 `sj-check.sh`，把 `[FAIL]` 项逐个修到 `[OK]`。
3. 用 `sj-loop.sh` 额外造 2 块 5 GB 的 loop 盘，重启虚拟机，确认它们自动恢复；再用 `losetup -d` 拆掉其中一块。
4. 加载 null_blk 并设置 `completion_nsec=1000000`（1 ms），执行 `sudo ioping -c 5 -D /dev/nullb0`，看测出的延迟是否接近 1 ms；再改成 `completion_nsec=10000` 对比。
5. 给通过验证的虚拟机拍一个名为 `clean` 的快照，然后故意在 `/etc/fstab` 里写一行错误的挂载项、重启，体验开不了机的感觉，再用快照恢复。

## 自测

<details>
<summary>为什么存储实验不能在 Docker 容器里做？</summary>

容器与宿主机共享内核，没有独立的块设备，默认不能加载内核模块、不能运行 BPF 程序；即使开了特权模式，操作的也是宿主机的真实设备，极易误伤。存储实验需要完整的内核和独立的虚拟盘，必须使用虚拟机。

</details>

<details>
<summary>`truncate -s 10G disk.img` 创建的文件为什么 `du` 显示为 0？这对实验有什么好处？</summary>

`truncate` 只设置了文件的逻辑大小，并没有分配数据块，这是一个稀疏文件；只有真正写入的区域才会占用磁盘空间。这样可以在宿主机空间有限的情况下造出多块"大盘"，只要实际写入的数据不超过剩余空间即可。

</details>

<details>
<summary>loop 设备适合用来测性能吗？为什么？</summary>

不适合。loop 设备的每个 I/O 最终都要落到底层文件系统中的一个文件上，要额外经过一遍文件系统和块层，还受宿主机缓存影响，测出的 IOPS 和延迟不能代表任何真实设备。它适合练习分区、LVM、RAID、文件系统、Ceph 部署等功能性操作。

</details>

<details>
<summary>null_blk 的 `irqmode=2 completion_nsec=100000` 有什么用？</summary>

`irqmode=2` 让 null_blk 用定时器模拟中断完成请求，`completion_nsec=100000` 设置每个请求延迟 100 μs 完成。这样可以造出一块延迟稳定、可控的"盘"，用来观察块层和上层软件在不同设备延迟下的行为，或单纯测量块层自身的开销。

</details>

<details>
<summary>搭建多节点存储实验环境时，除了网络互通，还有哪些必须提前准备的？</summary>

主机名互相解析（`/etc/hosts` 或 DNS）、时间同步（如 chrony，分布式存储对时钟偏差敏感）、管理节点到其他节点的免密 SSH，以及足够的宿主机内存和磁盘。每个节点还需要若干块空白数据盘。

</details>

## 参考资料

- [Lima 官方文档](https://lima-vm.io/docs/)
- [Lima 文档：磁盘（additionalDisks）](https://lima-vm.io/docs/config/disk/)
- [Multipass 文档](https://canonical.com/multipass/docs)
- [UTM 官方文档](https://docs.getutm.app/)
- [Microsoft 文档：在 Windows 上安装 Hyper-V](https://learn.microsoft.com/zh-cn/windows-server/virtualization/hyper-v/get-started/install-hyper-v)
- [Linux 内核文档：Null block device driver](https://docs.kernel.org/block/null_blk.html)
- [losetup(8) 手册](https://man7.org/linux/man-pages/man8/losetup.8.html)
- [bpftrace 项目主页](https://github.com/bpftrace/bpftrace)
- [BCC 项目主页](https://github.com/iovisor/bcc)
- [Ubuntu Server 24.04 下载](https://ubuntu.com/download/server)
