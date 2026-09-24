# 网络存储：NFS、iSCSI 与 NVMe-oF

到目前为止，我们的盘都插在自己机器上：一次 `write()` 从系统调用走到块层，再到本地 NVMe，路径短、故障也简单——盘坏了就是坏了。可一旦把盘挪到网线另一头，事情就变了：延迟里多了一段网络往返，"盘坏了"变成了"盘可能坏了，也可能只是网络抖了一下"。这一课是从单机走向分布式的第一步。

学完这一课，你能在两台虚拟机上搭起 NFS、iSCSI 和 NVMe/TCP 三种网络存储，看懂 `hard`、`nconnect`、`actimeo` 这些挂载选项到底在权衡什么，用 `nfsiostat` 和 `multipath -ll` 观察它们，并能说清楚网络给存储带来了哪些本地盘没有的故障：D 状态进程、stale file handle、脑裂。

## 三种协议，两种语义

[块、文件、对象](/learn/block-file-object)那一课讲过：协议的差别本质上是**语义**的差别。

| 协议 | 语义 | 客户端看到的 | 文件系统在哪 | 典型用途 |
|---|---|---|---|---|
| NFS | 文件 | 一个目录 | 服务端 | 共享目录、家目录、K8s RWX 卷 |
| iSCSI | 块 | 一块 `/dev/sdX` | 客户端 | 虚拟化、数据库、传统 SAN |
| NVMe-oF | 块 | 一块 `/dev/nvmeXnY` | 客户端 | 全闪存储、低延迟块卷 |

```text
NFS:      应用 ─ VFS ─ NFS 客户端 ──RPC/TCP──▶ nfsd ─ VFS ─ ext4/XFS ─ 盘
iSCSI:    应用 ─ VFS ─ ext4 ─ 块层 ─ SCSI ─ iscsi_tcp ──TCP──▶ LIO target ─ 盘
NVMe/TCP: 应用 ─ VFS ─ ext4 ─ 块层(blk-mq) ─ nvme-tcp ──TCP──▶ nvmet ─ 盘
```

记住一个关键区别：**块协议的文件系统在客户端，所以同一个 LUN 不能被两台机器同时挂载成 ext4/XFS**。NFS 的文件系统在服务端，多个客户端天然可以共享。这条区别决定了后面"脑裂"那一节的全部内容。

## 网络改变了延迟的数量级

《Systems Performance》第 10 章给过一张 ping 延迟表：本机回环约 0.05 ms，同子网 10 GbE 约 0.2 ms，1 GbE 约 0.6 ms，跨城公网是几十毫秒。拿它和[存储硬件](/learn/storage-hardware)里的数字放在一起看：

| 操作 | 典型延迟（数量级） |
|---|---|
| 本地 NVMe 4K 随机读 | 80～100 µs |
| NVMe/RDMA 远端读 | 本地 + 10 µs 左右 |
| NVMe/TCP 远端读 | 本地 + 20～50 µs |
| iSCSI 远端读 | 本地 + 100～200 µs |
| NFS 一次 `stat()` / 小文件读 | 200 µs ～ 1 ms |
| 一次 TCP 重传（RTO 最小值） | 200 ms |

最后一行最要命。Gregg 在书里反复强调要区分几种延迟：连接建立延迟、首字节延迟、往返时间（RTT），以及**重传**——一次丢包带来的重传能给网络 I/O 加上成百上千毫秒。本地盘的 p99 可能是 p50 的 3 倍，网络存储的 p99.9 可能是 p50 的 1000 倍，罪魁往往就是丢包和重传。

> [!TIP] 先排除网络，再怀疑存储
> 网络存储慢了，先看网络：`ping -c 100` 看 RTT 抖动，`nstat -az | grep -i retrans` 看 TCP 重传，`ethtool -S <网卡> | grep -iE 'drop|err'` 看网卡丢包。很多"存储慢"最后查出来是交换机端口 CRC 错误或者 MTU 不一致。

## NFS：最省心的共享文件

### v3 与 v4.x 的差别

NFS（Network File System）是 Sun 在 1984 年设计的，今天生产上主要是 v3 和 v4.1/v4.2。

| 维度 | NFSv3 | NFSv4.1 / 4.2 |
|---|---|---|
| 状态 | 服务端基本无状态 | 有状态：打开文件、锁、租约（lease） |
| 端口 | 2049 + rpcbind(111) + mountd + nlockmgr + statd，端口不固定 | 只有 TCP 2049，防火墙友好 |
| 锁 | 旁路协议 NLM，服务端重启要靠 statd 通知恢复 | 内建在协议里，基于租约，默认 90 秒 |
| 请求 | 一个 RPC 一个操作 | COMPOUND：多个操作打包一次往返 |
| 缓存 | 靠属性超时猜测 | 支持委托（delegation），服务端授权客户端放心缓存 |
| 重试语义 | 非幂等操作重放可能出错 | 4.1 引入会话（session），实现 exactly-once |
| 扩展 | 无 | 4.1：pNFS、会话 trunking；4.2：服务端拷贝、稀疏文件 |
| 安全 | 基于 UID/GID 信任客户端 | 同上，另可选 Kerberos（sec=krb5p） |

经验法则：**新部署一律用 v4.1 或 v4.2**，除非客户端太老或某些 NAS 设备只把 v3 做稳了。v3 的好处是服务端无状态，重启恢复简单；v4 的租约意味着服务端重启后有一个宽限期（grace period），期间新的打开和加锁会被拒绝，看起来像"卡了 90 秒"。

### 搭建 nfs-kernel-server

实验环境：两台 Ubuntu 24.04 虚拟机，服务端 `192.168.56.10`，客户端 `192.168.56.11`。只有一台机器也可以，把客户端地址换成 `127.0.0.1` 就行。

```bash
# 服务端
sudo apt install -y nfs-kernel-server
sudo mkdir -p /srv/nfs/share
sudo chown nobody:nogroup /srv/nfs/share
echo '/srv/nfs/share 192.168.56.0/24(rw,sync,no_subtree_check,root_squash)' | sudo tee -a /etc/exports
sudo exportfs -ra
sudo exportfs -v
cat /proc/fs/nfsd/versions        # -2 +3 +4 +4.1 +4.2
```

`/etc/exports` 每个选项都值得知道：

| 选项 | 含义 | 建议 |
|---|---|---|
| `rw` / `ro` | 读写 / 只读 | 按需 |
| `sync` | 数据落盘后才回复客户端（默认） | **永远用 sync** |
| `async` | 写进服务端页缓存就回复 | 快，但服务端掉电会丢已确认的数据 |
| `root_squash` | 客户端 root 映射为 nobody（默认） | 保持默认 |
| `no_root_squash` | 客户端 root 就是服务端 root | 只给信任的管理节点 |
| `all_squash` + `anonuid/anongid` | 所有用户映射成指定 UID | 共享目录"谁都能写"时用 |
| `no_subtree_check` | 不检查文件是否在导出子树内（默认） | 保持默认 |

> [!DANGER] async 是在拿数据换跑分
> `async` 导出时，客户端的 `fsync()` 返回成功，数据其实还在服务端内存里。服务端掉电，应用认为已经持久化的数据就没了——这正是[页缓存与持久化语义](/learn/page-cache)里讲的"写成功到底意味着什么"，只不过这次撒谎的是服务端。

### 客户端挂载

```bash
# 客户端
sudo apt install -y nfs-common
sudo mkdir -p /mnt/nfs
sudo mount -t nfs -o vers=4.2,hard,nconnect=4 192.168.56.10:/srv/nfs/share /mnt/nfs
nfsstat -m
```

```console
$ nfsstat -m
/mnt/nfs from 192.168.56.10:/srv/nfs/share
 Flags: rw,relatime,vers=4.2,rsize=1048576,wsize=1048576,namlen=255,hard,proto=tcp,nconnect=4,timeo=600,retrans=2,sec=sys,clientaddr=192.168.56.11,local_lock=none,addr=192.168.56.10
```

写进 `/etc/fstab` 时别忘了 `_netdev`（等网络起来再挂）和 `nofail`（服务端不在时别卡住开机）：

```text title="/etc/fstab"
192.168.56.10:/srv/nfs/share  /mnt/nfs  nfs  vers=4.2,hard,nconnect=4,_netdev,nofail  0  0
```

### 挂载选项：每个都是一次权衡

**hard 与 soft**。这是最重要的一个选项。服务端没响应时：

- `hard`（默认）：无限重试。进程卡在 D 状态（不可中断睡眠），`kill -9` 也杀不掉，直到服务端恢复。**数据不会悄悄损坏**。
- `soft`：重试 `retrans` 次、每次等 `timeo`（单位是 0.1 秒，TCP 默认 600 即 60 秒）后，给应用返回 `EIO`。应用不会永远卡住，但如果应用不认真检查 `write()` 和 `close()` 的返回值，就会出现"以为写进去了其实没有"。

> [!WARNING] 别为了"不卡"改成 soft
> 读写数据的挂载一律 `hard`。卡住是可见的故障，会触发告警、有人处理；`soft` 带来的静默数据损坏可能几个月后才被发现。只有只读、可以随时重试的场景（比如挂一个软件仓库镜像）才考虑 `soft`。较新的内核还有 `softerr`，超时返回 `ETIMEDOUT` 而不是 `EIO`，便于应用区分。

**nconnect**。NFS 默认一个挂载点只用一条 TCP 连接，高带宽网络上单连接会被单个 CPU 核处理软中断、单个 TCP 窗口限住。`nconnect=N`（内核 5.3+，最大 16）让同一个挂载点开 N 条连接轮询发送。25/100 GbE 上从 1 调到 8 或 16，大文件吞吐常常翻好几倍。

**rsize / wsize**。单次 READ/WRITE RPC 的最大字节数，现代内核和服务端协商出的上限是 1 MiB。**不要手动调小**，老教程里 `rsize=8192` 是 UDP 时代的产物。

**actimeo 与属性缓存**。客户端会缓存文件属性（大小、mtime），避免每次 `stat()` 都走网络。默认文件属性缓存 3～60 秒（`acregmin`/`acregmax`），目录 30～60 秒（`acdirmin`/`acdirmax`）。`actimeo=N` 一次把四个都设成 N。

| 场景 | 选项 | 代价 |
|---|---|---|
| 多客户端频繁互看对方写的文件 | `actimeo=1` 或 `noac` | 大量 GETATTR，元数据延迟暴涨 |
| 只读数据集（模型、镜像仓库） | `actimeo=600,nocto` | 别的客户端的修改很久才看得到 |
| 一般共享目录 | 默认 | —— |

NFS 的一致性模型叫 **close-to-open**：客户端 A `close()` 时把脏数据刷回服务端；客户端 B 之后 `open()` 时向服务端校验属性。所以"A 写完关闭、B 再打开"一定看得到；"A 还开着在写、B 同时读"则不保证。这个模型会在[元数据与分布式文件系统](/learn/distributed-fs)里再次出现。

### 观测：nfsstat 与 nfsiostat

```bash
nfsstat -c              # 客户端各类 RPC 计数：getattr 占比高说明元数据密集
nfsstat -s              # 服务端（在服务端上执行）
nfsiostat 2 /mnt/nfs    # 类似 iostat，按挂载点给出每类操作的 RTT
```

```console
$ nfsiostat 2 /mnt/nfs
192.168.56.10:/srv/nfs/share mounted on /mnt/nfs:

           ops/s       rpc bklog
        1520.400           0.000

read:              ops/s            kB/s           kB/op         retrans    avg RTT (ms)    avg exe (ms)  avg queue (ms)          errors
                 760.200       97305.600         128.000        0 (0.0%)           0.812           0.905           0.021        0 (0.0%)
write:             ops/s            kB/s           kB/op         retrans    avg RTT (ms)    avg exe (ms)  avg queue (ms)          errors
                 760.200       97305.600         128.000        0 (0.0%)           1.934           2.310           0.035        0 (0.0%)
```

读法：`avg RTT` 是请求在网络加服务端的时间；`avg exe` 是从客户端发起到完成的总时间，`exe - RTT` 大说明客户端自己在排队（连接不够，试试 `nconnect`）；`retrans` 非零说明网络在丢包或服务端太忙；`rpc bklog` 持续大于 0 说明 RPC 槽位不够用。

## iSCSI：把 SCSI 命令装进 TCP

iSCSI 把 SCSI 命令封装进 TCP（默认端口 3260）。两个角色：

- **Target**（服务端）：导出 LUN。Linux 内核里的实现叫 LIO，用户态管理工具是 `targetcli`。
- **Initiator**（客户端）：发起连接，把 LUN 变成本地 `/dev/sdX`。工具是 `open-iscsi` 的 `iscsiadm`。

双方都用 IQN（iSCSI Qualified Name）标识，格式是 `iqn.年-月.反写域名:自定义`，例如 `iqn.2026-09.com.example:target1`。

### 搭建 target

```bash
# 服务端：用 loop 设备模拟一块盘
sudo apt install -y targetcli-fb
truncate -s 10G /var/tmp/iscsi-disk1.img
sudo losetup -f --show /var/tmp/iscsi-disk1.img     # 假设输出 /dev/loop10

sudo targetcli /backstores/block create name=disk1 dev=/dev/loop10
sudo targetcli /iscsi create iqn.2026-09.com.example:target1
sudo targetcli /iscsi/iqn.2026-09.com.example:target1/tpg1/luns create /backstores/block/disk1
sudo targetcli /iscsi/iqn.2026-09.com.example:target1/tpg1/acls create iqn.2026-09.com.example:client1
sudo targetcli saveconfig          # 保存到 /etc/rtslib-fb-target/saveconfig.json
sudo targetcli ls
```

```console
$ sudo targetcli ls
o- / ............................................................ [...]
  o- backstores ................................................. [...]
  | o- block ..................................... [Storage Objects: 1]
  | | o- disk1 ................ [/dev/loop10 (10.0GiB) write-thru activated]
  ...
  o- iscsi ............................................... [Targets: 1]
  | o- iqn.2026-09.com.example:target1 ...................... [TPGs: 1]
  |   o- tpg1 .................................. [no-gen-acls, no-auth]
  |     o- acls ............................................. [ACLs: 1]
  |     | o- iqn.2026-09.com.example:client1 ......... [Mapped LUNs: 1]
  |     o- luns ............................................. [LUNs: 1]
  |     | o- lun0 .......... [block/disk1 (/dev/loop10) (default_tg_pt_gp)]
  |     o- portals ....................................... [Portals: 1]
  |       o- 0.0.0.0:3260 ........................................ [OK]
```

`portals` 默认监听 `0.0.0.0:3260`，ACL 决定哪个 initiator 能看到哪些 LUN。生产里还应开启 CHAP 认证，并把 iSCSI 流量放在独立 VLAN。

### 连接 initiator

```bash
# 客户端
sudo apt install -y open-iscsi
echo 'InitiatorName=iqn.2026-09.com.example:client1' | sudo tee /etc/iscsi/initiatorname.iscsi
sudo systemctl restart iscsid

sudo iscsiadm -m discovery -t sendtargets -p 192.168.56.10
sudo iscsiadm -m node -T iqn.2026-09.com.example:target1 -p 192.168.56.10 --login
sudo iscsiadm -m session -P 1
lsblk -S                    # TRAN 列显示 iscsi，VENDOR 是 LIO-ORG
```

```console
$ lsblk -S
NAME HCTL       TYPE VENDOR   MODEL  REV SERIAL                               TRAN
sda  2:0:0:0    disk LIO-ORG  disk1 4.0  4a1c7b2e-9d53-4f0e-8a61-2b7c9e0d3f15 iscsi
```

之后 `/dev/sda` 和本地盘一样用：分区、`mkfs.xfs`、挂载。开机自动登录用 `iscsiadm -m node -T <iqn> -o update -n node.startup -v automatic`，fstab 里同样要加 `_netdev`。

### 多路径 multipath

单条网络路径就是单点故障。生产 SAN 通常是两块网卡、两台交换机、两个 target 端口，客户端会看到**同一个 LUN 的两块 `/dev/sdX`**。直接用其中一块，另一条路径就白搭了；两块都挂，更是数据灾难。`dm-multipath` 把它们合成一个设备：

```bash
sudo apt install -y multipath-tools
cat <<'EOF' | sudo tee /etc/multipath.conf
defaults {
    user_friendly_names yes
    find_multipaths     yes
}
EOF
sudo systemctl restart multipathd
# target 上再加一个 portal 地址，客户端从两个地址分别 login
sudo iscsiadm -m discovery -t sendtargets -p 192.168.57.10
sudo iscsiadm -m node -T iqn.2026-09.com.example:target1 -p 192.168.57.10 --login
sudo multipath -ll
```

```console
$ sudo multipath -ll
mpatha (36001405a1c7b2e9d534f0e8a612b7c9e) dm-0 LIO-ORG,disk1
size=10G features='0' hwhandler='1 alua' wp=rw
`-+- policy='service-time 0' prio=50 status=active
  |- 2:0:0:0 sda 8:0  active ready running
  `- 3:0:0:0 sdb 8:16 active ready running
```

以后只用 `/dev/mapper/mpatha`。拔掉一条路径（`ip link set <网卡> down`），`multipath -ll` 里对应行变成 `failed faulty`，I/O 继续走另一条。

> [!PROD] 多路径下的两个超时
> open-iscsi 的 `node.session.timeo.replacement_timeout` 默认 120 秒：路径断了之后，iSCSI 层要等 120 秒才把错误交给上层。配合 multipath 时应该调到 5～15 秒，让 multipath 尽快切换路径；而"所有路径都断了"时的行为由 multipath 的 `no_path_retry` 控制（`queue` 表示一直排队等待，类似 NFS 的 hard）。存储厂商通常会给出推荐的 `multipath.conf` 设备段，照抄厂商的，别自己拍脑袋。

## NVMe-oF：为闪存重新设计的网络协议

iSCSI 背着 SCSI 的历史包袱：单队列模型、命令集为机械盘设计。NVMe over Fabrics（NVMe-oF）把 NVMe 的多队列模型直接延伸到网络上，每个 CPU 核一对提交/完成队列，没有中间翻译层。传输层有三种：

| 传输 | 需要的硬件 | 额外延迟 | 说明 |
|---|---|---|---|
| NVMe/TCP | 普通以太网卡 | 20～50 µs | 部署最简单，内核 5.0 起支持 |
| NVMe/RDMA | RoCE 或 InfiniBand 网卡 | 约 10 µs | 绕过内核协议栈，见 [RDMA](/learn/rdma) |
| NVMe/FC | FC HBA 和光纤交换机 | 很低 | 传统 SAN 升级路线 |

NVMe-oF 用 NQN（NVMe Qualified Name）标识子系统，格式和 IQN 很像：`nqn.2026-09.com.example:nvme-target1`。

### 用内核 nvmet 搭 target

Linux 内核自带 NVMe-oF target（`nvmet`），直接通过 configfs 配置，不需要额外软件。一步步做一遍，比用封装工具更能看清结构：

```bash
# 服务端
sudo modprobe nvmet
sudo modprobe nvmet-tcp       # 找不到模块时安装 linux-modules-extra-$(uname -r)
truncate -s 10G /var/tmp/nvme-disk1.img
sudo losetup -f --show /var/tmp/nvme-disk1.img      # 假设输出 /dev/loop11

NQN=nqn.2026-09.com.example:nvme-target1
cd /sys/kernel/config/nvmet
sudo mkdir subsystems/$NQN
echo 1 | sudo tee subsystems/$NQN/attr_allow_any_host     # 实验用；生产应配置 hosts/
sudo mkdir subsystems/$NQN/namespaces/1
echo -n /dev/loop11 | sudo tee subsystems/$NQN/namespaces/1/device_path
echo 1 | sudo tee subsystems/$NQN/namespaces/1/enable

sudo mkdir ports/1
echo ipv4          | sudo tee ports/1/addr_adrfam
echo tcp           | sudo tee ports/1/addr_trtype
echo 192.168.56.10 | sudo tee ports/1/addr_traddr
echo 4420          | sudo tee ports/1/addr_trsvcid
sudo ln -s /sys/kernel/config/nvmet/subsystems/$NQN ports/1/subsystems/$NQN
sudo dmesg | tail -2          # nvmet_tcp: enabling port 1 (192.168.56.10:4420)
```

结构一目了然：**subsystem** 包含若干 **namespace**（每个对应一块后端设备），**port** 定义监听的传输和地址，把 subsystem 链接到 port 上就对外可见了。换成 RDMA 只需要 `modprobe nvmet-rdma` 并把 `addr_trtype` 写成 `rdma`。configfs 配置重启即失，持久化可以用 `nvmetcli save` / `nvmetcli restore`。

### 用 nvme-cli 连接

```bash
# 客户端
sudo apt install -y nvme-cli
sudo modprobe nvme-tcp
sudo nvme discover -t tcp -a 192.168.56.10 -s 4420
sudo nvme connect  -t tcp -a 192.168.56.10 -s 4420 -n nqn.2026-09.com.example:nvme-target1
sudo nvme list
```

```console
$ sudo nvme list
Node          Generic     SN                   Model   Namespace  Usage                   Format       FW Rev
------------- ----------- -------------------- ------- ---------- ----------------------- ------------ --------
/dev/nvme1n1  /dev/ng1n1  8f3a2c1d9e7b6a54     Linux   0x1         10.74  GB /  10.74  GB    512   B +  0 B   6.8.0-45
```

`nvme list-subsys` 能看到每个子系统的路径；NVMe 有自己的原生多路径（`cat /sys/module/nvme_core/parameters/multipath` 为 `Y`），不需要 dm-multipath。断开用 `nvme disconnect -n <nqn>`。

现在可以用[基准测试](/learn/benchmarking)里的 fio 对比一下三种协议：

```bash
sudo fio --name=randread --filename=/dev/nvme1n1 --direct=1 --rw=randread \
  --bs=4k --iodepth=1 --numjobs=1 --runtime=30 --time_based --group_reporting
```

在同一台后端设备上分别对 iSCSI 的 `/dev/sda` 和 NVMe/TCP 的 `/dev/nvme1n1` 跑，`iodepth=1` 时平均延迟的差距就是协议栈开销；再把 `iodepth` 加到 32，看谁的 IOPS 能涨上去——多队列的优势在高并发下才显现。

## 网络如何改变故障模型

本地盘的故障基本是"好"或"坏"两种状态。网络存储多出了第三种：**不知道**。请求发出去没回来，可能是服务端挂了、可能是网络断了、也可能只是慢——客户端无法区分。这是分布式系统最根本的难题，下一课[分布式存储基础](/learn/distributed-basics)会系统展开，这里先看它在网络存储上的三种表现。

### 抖动与 D 状态

网络抖一下，NFS `hard` 挂载上的进程就会卡在 D 状态；`uptime` 看到负载飙到几百，但 CPU 是闲的——Linux 的 load average 把 D 状态进程也算进去了。

```bash
ps -eo pid,stat,wchan:32,cmd | awk '$2 ~ /D/'
cat /proc/<pid>/stack          # 常见栈顶：rpc_wait_bit_killable、nfs_wait_on_request
```

用 `tc netem` 在实验环境里主动制造网络问题，是理解这类故障最快的办法：

```bash
# 客户端：给出网卡加 5ms±2ms 延迟和 1% 丢包
sudo tc qdisc add dev enp0s8 root netem delay 5ms 2ms loss 1%
nfsiostat 2 /mnt/nfs            # 观察 avg RTT 和 retrans
sudo tc qdisc del dev enp0s8 root
```

### Stale file handle

NFS 客户端用**文件句柄**（file handle）指代服务端的文件，里面编码了文件系统标识和 inode 号。以下情况句柄会失效，客户端收到 `ESTALE`，`ls` 报 `Stale file handle`：

- 客户端 A 打开着文件，客户端 B 把它删了或 rename 覆盖了；
- 服务端把导出目录下的文件系统重建、换盘，或者导出路径背后的设备号变了；
- 高可用 NFS 切换后，新服务端的 `fsid` 与旧的不一致。

处理方法：应用侧重新打开文件；挂载点整体失效时 `umount -f` / `umount -l` 后重新挂载。预防方法：HA 场景在 exports 里显式设置 `fsid=`，保证切换前后一致。

### 脑裂：两个主人抢一块盘

块协议最危险的故障是**脑裂**（split brain）。经典场景：两台数据库服务器做主备，共享一个 iSCSI LUN，上面是 XFS。主机和备机之间心跳断了，但两边到存储都是通的——备机以为主机死了，挂载 XFS 开始写，主机其实还活着也在写。两个内核各自缓存着 XFS 的元数据，互相覆盖，几分钟后文件系统就彻底损坏了。

```text
     心跳断开 ✗
主机 A ─────────── 主机 B
  │ 我还活着         │ A 死了，我接管！
  │ 写 XFS          │ 挂载 XFS 并写
  └──────┬──────────┘
         ▼
      同一个 LUN  ──▶ 元数据互相覆盖，文件系统损坏
```

防脑裂有三种手段，生产里通常组合使用：

1. **隔离（fencing）**：接管前先确保对方真的停了——通过 IPMI 断电（STONITH），或用 SCSI-3 持久预留（Persistent Reservation）让存储拒绝旧主机的写入；
2. **仲裁（quorum）**：必须拿到多数票才能成为主，两节点集群要加第三个仲裁点；
3. **集群文件系统**：确实需要多机同时读写同一块盘，就用 GFS2、OCFS2 或 GPFS 这类带分布式锁的文件系统，而不是 ext4/XFS。

> [!DANGER] 块设备 ≠ 共享存储
> 在 Kubernetes 里也一样：RBD、iSCSI 这类块卷只能 ReadWriteOnce。强行让两个节点同时挂载同一个块卷上的 ext4，不需要等脑裂，正常运行就会坏。要多节点共享，用 NFS、CephFS 这类文件协议。

## 动手练习

1. 搭好 NFS 后，分别用 `hard` 和 `soft,timeo=50,retrans=1` 挂载两次。在服务端 `systemctl stop nfs-server`，客户端各执行一次 `ls` 和 `dd if=/dev/zero of=/mnt/nfs/x bs=1M count=10`，记录两种挂载的行为差异，观察 `ps` 中的进程状态。
2. 用两个客户端（或同一台机器挂两个挂载点）验证 close-to-open：A 持续 `echo` 追加写同一个文件不关闭，B 循环 `cat`；再改成 A 每次写完关闭，比较 B 看到更新的时机。然后给 B 加 `actimeo=0` 重试。
3. 在一台 8 核以上、至少 10 GbE 的环境里，用 `fio --rw=read --bs=1M --numjobs=8` 分别测 `nconnect=1` 和 `nconnect=8` 的顺序读吞吐，用 `nfsiostat` 对比 `avg exe - avg RTT`。
4. 按本课步骤搭 iSCSI 和 NVMe/TCP 各一个 LUN（后端用同类 loop 设备），用 `iodepth=1` 和 `iodepth=32` 的 4K 随机读各跑一次，列表比较延迟和 IOPS。
5. 在 NFS 客户端打开一个文件（`tail -f /mnt/nfs/log`），在服务端删除该文件再新建同名文件，观察客户端报错；再在服务端 `exportfs -ua && exportfs -ra` 看看会不会出现 stale file handle。

## 自测

<details>
<summary>NFSv4.1 相比 v3 最主要的几个变化是什么？为什么说 v4 更适合防火墙环境？</summary>

v4 是有状态协议，锁和打开状态内建在协议中并基于租约管理；引入 COMPOUND 把多个操作合并成一次往返；支持委托让客户端安全缓存；4.1 增加会话实现 exactly-once 语义，以及 pNFS。v3 需要 rpcbind、mountd、nlockmgr、statd 等多个辅助服务且端口不固定，v4 只用 TCP 2049 一个端口，所以防火墙只需开一个端口。

</details>

<details>
<summary>为什么说读写数据的 NFS 挂载应该用 hard 而不是 soft？</summary>

`soft` 在超时后给应用返回 `EIO`，如果应用没有检查 `write()`、`fsync()`、`close()` 的返回值，就会误以为写入成功，造成静默的数据丢失或损坏。`hard` 会让进程卡住直到服务端恢复，故障是可见的，数据不会悄悄出错。卡住可以告警处理，静默损坏往往很久才被发现。

</details>

<details>
<summary>nfsiostat 中 avg exe 明显大于 avg RTT，说明什么？可以怎么改善？</summary>

`avg RTT` 是请求发出到收到回复的时间（网络加服务端处理），`avg exe` 是请求从客户端 RPC 层发起到完成的总时间。两者差值是客户端内部排队时间，说明客户端发送能力是瓶颈，例如单条 TCP 连接或 RPC 槽位不够。可以增加 `nconnect` 让一个挂载点使用多条连接，或检查客户端 CPU 软中断是否集中在单核。

</details>

<details>
<summary>同一个 iSCSI LUN 在客户端出现为 /dev/sda 和 /dev/sdb 两个设备，应该怎么处理？直接用 /dev/sda 有什么问题？</summary>

这是同一个 LUN 的两条路径，应该用 `multipath-tools` 把它们合成一个 `/dev/mapper/mpathX` 设备使用。直接用 `/dev/sda` 会失去路径冗余，这条路径断了 I/O 就失败；如果不小心同时对 `/dev/sda` 和 `/dev/sdb` 做操作（比如分别挂载），两个独立的页缓存和文件系统实例会互相覆盖，造成数据损坏。

</details>

<details>
<summary>NVMe/TCP 相比 iSCSI 为什么延迟更低、高并发下扩展更好？</summary>

iSCSI 要把请求翻译成 SCSI 命令，SCSI 层和 iSCSI 会话的队列模型较重；NVMe/TCP 直接在网络上承载 NVMe 命令，沿用 NVMe 的多队列设计，每个 CPU 核可以有独立的 I/O 队列和 TCP 连接，没有协议翻译，锁竞争少。所以单个请求的软件开销更小，在高队列深度、多核并发时 IOPS 能继续扩展。

</details>

## 参考资料

- Brendan Gregg,《Systems Performance: Enterprise and the Cloud》2nd Edition，第 10 章 Network（10.3.5 Latency、10.5.4 Latency Analysis）
- [Linux man page：nfs(5)](https://man7.org/linux/man-pages/man5/nfs.5.html)
- [Linux man page：exports(5)](https://man7.org/linux/man-pages/man5/exports.5.html)
- [Ubuntu Server 文档：Network File System (NFS)](https://documentation.ubuntu.com/server/how-to/networking/install-nfs/)
- [RFC 8881：NFS Version 4 Minor Version 1 Protocol](https://www.rfc-editor.org/rfc/rfc8881)
- [targetcli-fb 项目主页](https://github.com/open-iscsi/targetcli-fb)
- [open-iscsi 项目主页](https://github.com/open-iscsi/open-iscsi)
- [multipath-tools 项目主页](https://github.com/opensvc/multipath-tools)
- [nvme-cli 项目主页](https://github.com/linux-nvme/nvme-cli)
- [NVM Express：NVMe over Fabrics 规范](https://nvmexpress.org/specifications/)
