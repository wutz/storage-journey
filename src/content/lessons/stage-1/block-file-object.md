# 块、文件、对象：三种存储语义

到这里，你已经从物理盘一路走到了本机的文件系统。但一旦存储要**被网络另一端的机器使用**，就会遇到三种截然不同的形态：给你一块"裸盘"的**块存储**，给你一个共享目录的**文件存储**，以及通过 HTTP 存取一个个对象的**对象存储**。云厂商的 EBS、NAS、S3，Ceph 的 RBD、CephFS、RGW，Kubernetes 里的 RWO 与 RWX，本质上都是这三种语义的不同实现。

这一课先把三者的区别讲透——不是背定义，而是搞清楚**文件系统到底跑在哪一边**、谁负责元数据、能不能多个客户端同时写、能不能只改文件中间的几个字节。然后在一台机器上把三种都亲手搭一遍：用 targetcli 建一个 iSCSI 块设备，用 nfs-kernel-server 共享一个目录，用 RustFS 起一个 S3 兼容的对象存储。这为阶段 3 的分布式存储打下直觉基础。

## 核心区别：文件系统在哪一边

```text
        块存储（Block）            文件存储（File）            对象存储（Object）

客户端  应用                        应用                        应用
         │ open/read/write           │ open/read/write           │ HTTP PUT/GET（SDK）
        文件系统（ext4/XFS）         NFS 客户端                   │
         │ 读写第 N 号块              │ NFS 协议：对文件操作        │ S3 API：对对象操作
━━━━━━━━━━━━━━━ 网络（iSCSI / NVMe-oF / FC）━━ 网络（NFS / SMB）━━━━━ 网络（HTTP/HTTPS）━━━
服务端  块设备（LUN）                文件系统 + 元数据服务         对象网关 + 扁平命名空间
         │                           │                            │ 桶 / 键 → 数据 + 元数据
        盘                          盘                           盘
```

- **块存储**：服务端只提供"一串可以按块地址读写的空间"，**文件系统在客户端**。服务端不知道上面存的是文件还是数据库。
- **文件存储**：**文件系统在服务端**，客户端通过网络协议操作文件和目录，多个客户端看到的是同一棵目录树。
- **对象存储**：没有传统意义上的文件系统。数据被组织成**桶（Bucket）**里的**对象（Object）**，用一个**键（Key）**寻址，通过 HTTP API 整体读写，每个对象可以附带自定义元数据。

### 对比表

| | 块存储 | 文件存储 | 对象存储 |
|---|---|---|---|
| 访问单位 | 块（512 B / 4 KiB） | 文件、目录 | 对象（整体） |
| 典型协议 | iSCSI、NVMe-oF、FC、Ceph RBD | NFS、SMB、CephFS、GPFS、Lustre | S3、Swift |
| 文件系统 / 元数据在哪 | 客户端 | 服务端（或分布式元数据服务） | 服务端，扁平键值 |
| 多客户端共享 | 一般只能**单点挂载**读写 | 天然**多客户端**共享 | 多客户端通过 HTTP 并发访问 |
| 修改方式 | 任意位置改写任意块 | 任意位置改写、追加、加锁 | **整体覆盖**，不能改中间几个字节 |
| POSIX 语义 | 由客户端文件系统提供 | 提供（程度因实现而异） | 不提供（没有 rename 原子性、没有目录、没有文件锁） |
| 延迟 | 最低（百微秒级） | 中等（毫秒级，元数据操作多时更高） | 较高（毫秒到几十毫秒，HTTP 开销） |
| 扩展规模 | 单卷 TB 级 | 单命名空间 PB 级（取决于元数据扩展性） | 容易到 EB 级、千亿对象 |
| 典型场景 | 虚拟机磁盘、数据库、K8s RWO 卷 | 家目录、共享数据集、HPC、K8s RWX 卷 | 备份归档、图片视频、数据湖、AI 训练数据、日志 |
| 云上对应 | AWS EBS、云硬盘 | AWS EFS、NAS | AWS S3、OSS、COS |

几个要点展开说：

**块存储为什么不能多点挂载？** 因为 ext4、XFS 这类本地文件系统假设"整块盘只有我一个人在写"，它们在各自的内存里缓存元数据、各自分配空闲块。两台机器同时挂载同一个 LUN 读写，会各自覆盖对方的元数据，几分钟内文件系统就会损坏。想要多点共享块设备，必须用 GFS2、OCFS2 这类**集群文件系统**，或者像 GPFS 那样由软件协调所有节点（阶段 5 的 [GPFS / Storage Scale 核心概念](/learn/gpfs-concepts)）。

**文件存储的难点在元数据。** 目录遍历、`stat`、`open`、`rename` 都是元数据操作，海量小文件场景下元数据服务往往先于数据带宽成为瓶颈。这是分布式文件系统设计的核心难题，见[元数据与分布式文件系统](/learn/distributed-fs)。

**对象存储为什么能做那么大？** 因为它主动放弃了 POSIX：没有目录层级（`a/b/c.jpg` 只是一个包含斜杠的键）、没有部分改写、没有文件锁。每个对象独立、不可变，可以按键哈希分散到成千上万台机器上，不需要维护一棵全局一致的目录树。代价是应用必须按"整体读写"的方式来设计。

> [!TIP] 怎么选
> 先问应用需要什么接口。数据库和虚拟机需要低延迟、随机改写的块设备；多个进程或多台机器要读写同一批文件、且程序只会用 POSIX 文件接口时用文件存储；新写的应用、海量非结构化数据、需要通过互联网访问的数据，优先对象存储——它最便宜、最容易扩展、运维最简单。

## 动手一：iSCSI 块存储

**iSCSI** 把 SCSI 命令封装进 TCP/IP 传输。提供存储的一方叫 **Target**，使用存储的一方叫 **Initiator**，每一方用一个 **IQN（iSCSI Qualified Name）** 标识，Target 导出的每个块设备叫一个 **LUN（Logical Unit Number）**。Linux 内核自带的 Target 实现叫 LIO，用 `targetcli` 管理。

我们在同一台机器上既当 Target 又当 Initiator，通过 `127.0.0.1` 连接自己。

> [!LAB] 安装与准备
> ```bash
> sudo apt install -y targetcli-fb open-iscsi
> sudo systemctl enable --now iscsid
> sudo mkdir -p /var/lib/lab
> ```
>
> 如果后面报找不到 `target_core_mod` 或 `iscsi_target_mod` 模块，说明你用的是精简内核（部分云镜像如此），需要 `sudo apt install -y linux-modules-extra-$(uname -r)`。

### 配置 Target

```bash
IQN=iqn.2026-09.com.example:lab
# 1) 后端存储：用一个 1G 的文件作为 LUN 的实际存储
sudo targetcli /backstores/fileio create disk01 /var/lib/lab/iscsi-disk01.img 1G
# 2) 创建 Target（会自动创建 tpg1 和监听 0.0.0.0:3260 的 portal）
sudo targetcli /iscsi create $IQN
# 3) 把后端存储作为 LUN 0 挂到 Target 上
sudo targetcli /iscsi/$IQN/tpg1/luns create /backstores/fileio/disk01
# 4) ACL：只允许本机的 Initiator 访问
INIT=$(sudo awk -F= '/^InitiatorName=/{print $2}' /etc/iscsi/initiatorname.iscsi)
sudo targetcli /iscsi/$IQN/tpg1/acls create $INIT
# 5) 持久化配置
sudo targetcli saveconfig
sudo targetcli ls
```

```text
o- / ......................................................................... [...]
  o- backstores .............................................................. [...]
  | o- fileio ................................................... [Storage Objects: 1]
  | | o- disk01 .............. [/var/lib/lab/iscsi-disk01.img (1.0GiB) write-back activated]
  o- iscsi ............................................................ [Targets: 1]
  | o- iqn.2026-09.com.example:lab ....................................... [TPGs: 1]
  |   o- tpg1 ............................................... [no-gen-acls, no-auth]
  |     o- acls .......................................................... [ACLs: 1]
  |     | o- iqn.2004-10.com.ubuntu:01:3f2a9c1b7d4e ................ [Mapped LUNs: 1]
  |     o- luns .......................................................... [LUNs: 1]
  |     | o- lun0 ......... [fileio/disk01 (/var/lib/lab/iscsi-disk01.img) (default_tg_pt_gp)]
  |     o- portals .................................................... [Portals: 1]
  |       o- 0.0.0.0:3260 ..................................................... [OK]
```

### Initiator 发现并登录

```console
$ sudo iscsiadm -m discovery -t sendtargets -p 127.0.0.1
127.0.0.1:3260,1 iqn.2026-09.com.example:lab
$ sudo iscsiadm -m node -T iqn.2026-09.com.example:lab -p 127.0.0.1 --login
Logging in to [iface: default, target: iqn.2026-09.com.example:lab, portal: 127.0.0.1,3260]
Login to [iface: default, target: iqn.2026-09.com.example:lab, portal: 127.0.0.1,3260] successful.
$ lsblk -S -o NAME,TRAN,VENDOR,MODEL,SIZE
NAME TRAN   VENDOR   MODEL   SIZE
sda  iscsi  LIO-ORG  disk01    1G
```

一块新的 SCSI 盘出现了，`TRAN` 是 `iscsi`，厂商是 `LIO-ORG`。从操作系统的角度看，它和一块本地盘没有区别：可以分区、做 LVM、建文件系统。设备名会随环境变化，用 `by-path` 引用最稳：

```bash
ls -l /dev/disk/by-path/ | grep iscsi
DEV=/dev/disk/by-path/ip-127.0.0.1:3260-iscsi-iqn.2026-09.com.example:lab-lun-0
sudo mkfs.xfs -q $DEV
sudo mkdir -p /mnt/iscsi && sudo mount $DEV /mnt/iscsi
echo "hello from block storage" | sudo tee /mnt/iscsi/hello.txt
```

注意这里的 XFS 是**在客户端（Initiator）上**创建的。Target 端只看到 `/var/lib/lab/iscsi-disk01.img` 这个文件里有一些块被写了，它完全不知道上面有个叫 `hello.txt` 的文件。

> [!DANGER] 同一个 LUN 不要挂到两台机器上
> 块存储没有任何机制阻止第二台 Initiator 登录同一个 LUN 并挂载它。两台机器同时挂载 ext4/XFS 读写，文件系统会被迅速破坏。生产中靠 ACL 限制每个 LUN 只允许一个 Initiator，Kubernetes 用 `ReadWriteOnce` 访问模式来保证这一点。如果写 fstab，iSCSI 盘必须加 `_netdev`，让系统在网络就绪后再挂载。

### 清理

```bash
sudo umount /mnt/iscsi
sudo iscsiadm -m node -T iqn.2026-09.com.example:lab -p 127.0.0.1 --logout
sudo iscsiadm -m node -T iqn.2026-09.com.example:lab -p 127.0.0.1 -o delete
sudo targetcli /iscsi delete iqn.2026-09.com.example:lab
sudo targetcli /backstores/fileio delete disk01
sudo targetcli saveconfig
sudo rm -f /var/lib/lab/iscsi-disk01.img
```

生产中的 iSCSI 还要考虑 CHAP 认证、多路径（`multipathd`，两条网络路径同时连接 Target）、专用存储网络和巨帧。更现代的替代是 **NVMe-oF（NVMe over Fabrics）**，走 RDMA 或 TCP，延迟和 CPU 开销都远低于 iSCSI，见[网络存储：NFS、iSCSI 与 NVMe-oF](/learn/network-storage)。

## 动手二：NFS 文件存储

**NFS（Network File System）** 是 Unix 世界最经典的文件共享协议。服务端导出（export）一个目录，客户端把它挂载到本地，然后像操作本地文件一样读写。

```bash
sudo apt install -y nfs-kernel-server nfs-common
sudo mkdir -p /srv/nfs/share
sudo chown nobody:nogroup /srv/nfs/share
echo '/srv/nfs/share 127.0.0.1(rw,sync,no_subtree_check)' | sudo tee -a /etc/exports
sudo exportfs -ra                  # 重新加载导出表
sudo exportfs -v                   # 查看当前导出及其生效选项
```

```text
/srv/nfs/share	127.0.0.1(sync,wdelay,hide,no_subtree_check,sec=sys,rw,secure,root_squash,no_all_squash)
```

导出选项里值得注意的几个：

- `127.0.0.1`：允许访问的客户端，生产中写网段，如 `192.168.10.0/24`。
- `sync`：服务端把数据写到稳定存储后才回复客户端。`async` 更快，但服务端崩溃会丢失已经确认给客户端的写——和上一课的 `write()` 与 `fsync` 是同一个问题，只是发生在网络的另一端。
- `root_squash`（默认）：客户端的 root 被映射为 `nobody`，防止任何一台客户端的 root 在共享目录上为所欲为。这也是我们把目录属主设为 `nobody:nogroup` 的原因。

### 客户端挂载

```console
$ showmount -e 127.0.0.1
Export list for 127.0.0.1:
/srv/nfs/share 127.0.0.1
$ sudo mkdir -p /mnt/nfs
$ sudo mount -t nfs4 127.0.0.1:/srv/nfs/share /mnt/nfs
$ findmnt /mnt/nfs -o SOURCE,FSTYPE,OPTIONS
SOURCE                   FSTYPE OPTIONS
127.0.0.1:/srv/nfs/share nfs4   rw,relatime,vers=4.2,rsize=1048576,wsize=1048576,namlen=255,hard,proto=tcp,timeo=600,retrans=2,sec=sys,clientaddr=127.0.0.1,local_lock=none,addr=127.0.0.1
```

写一个文件，然后从"服务端"一侧直接看：

```console
$ sudo sh -c 'echo "hello from file storage" > /mnt/nfs/hello.txt'
$ ls -l /srv/nfs/share/
-rw-r--r-- 1 nobody nogroup 24 Sep 24 10:31 hello.txt
```

两个观察：

1. 文件真实地存在于服务端的文件系统里，服务端完全知道它叫 `hello.txt`、属于谁、多大——**文件系统在服务端**。
2. 客户端以 root 身份写入，文件属主却是 `nobody`，这就是 `root_squash`。

如果有第二台机器，把它也加入 `/etc/exports`，两边同时挂载，一边写的文件另一边立刻能看到——这就是块存储做不到的多客户端共享。

挂载选项里的 `hard` 很关键：服务端无响应时，客户端的 I/O 会**一直重试、进程挂住**，而不是返回错误。这保护了数据一致性，但也是"NFS 服务端一挂，客户端 `df` 都卡死"的原因。`soft` 会在超时后返回错误，可能让应用写坏数据，一般不推荐用于读写挂载。

### 清理

```bash
sudo umount /mnt/nfs
sudo sed -i '\#^/srv/nfs/share #d' /etc/exports
sudo exportfs -ra
sudo rm -rf /srv/nfs/share
```

## 动手三：S3 对象存储

### 选择一个本地 S3 实现

学习和开发时，最方便的是在单机上用容器起一个 S3 兼容服务。过去的默认选择是 MinIO，但它的社区版从 2025 年起改为只提供源码、不再发布官方二进制和镜像更新，进入维护状态。本课使用 **RustFS**：一个用 Rust 编写、Apache 2.0 许可、兼容 S3 API 的开源对象存储，单容器即可运行。

> [!LAB] 启动 RustFS
> ```bash
> sudo apt install -y docker.io
> sudo docker run -d --name rustfs \
>   -p 9000:9000 -p 9001:9001 \
>   -v rustfs-data:/data \
>   -e RUSTFS_ACCESS_KEY=labadmin \
>   -e RUSTFS_SECRET_KEY=labsecret123 \
>   -e RUSTFS_CONSOLE_ENABLE=true \
>   rustfs/rustfs:latest /data
> sudo docker logs rustfs | tail -5
> ```
>
> 9000 是 S3 API 端口，9001 是 Web 控制台（浏览器打开 `http://<实验机 IP>:9001`）。这里用命名卷 `rustfs-data` 存数据；如果改用宿主机目录做 bind mount，要先 `chown -R 10001:10001` 该目录，因为容器内进程以 UID 10001 运行。

### 用 aws cli 操作

S3 API 已经是对象存储的事实标准，AWS 官方的 `aws` 命令行对所有兼容实现都适用，只要指定 `--endpoint-url`：

```bash
sudo snap install aws-cli --classic       # Ubuntu 24.04 的 apt 源里没有 awscli
export AWS_ACCESS_KEY_ID=labadmin
export AWS_SECRET_ACCESS_KEY=labsecret123
export AWS_DEFAULT_REGION=us-east-1
# 新版 aws cli 默认给每个请求附加额外校验和，部分 S3 兼容实现不支持，改为按需计算
export AWS_REQUEST_CHECKSUM_CALCULATION=when_required
export AWS_RESPONSE_CHECKSUM_VALIDATION=when_required
EP="--endpoint-url http://127.0.0.1:9000"
```

创建桶、上传对象、附带自定义元数据：

```console
$ aws $EP s3 mb s3://lab
make_bucket: lab
$ aws $EP s3 cp /etc/os-release s3://lab/docs/2026/os-release --metadata owner=alice,purpose=demo
upload: ../../etc/os-release to s3://lab/docs/2026/os-release
$ aws $EP s3 cp /etc/hostname s3://lab/hostname
upload: ../../etc/hostname to s3://lab/hostname
$ aws $EP s3 ls s3://lab/
                           PRE docs/
2026-09-24 10:45:12         12 hostname
$ aws $EP s3 ls s3://lab/ --recursive
2026-09-24 10:45:08        386 docs/2026/os-release
2026-09-24 10:45:12         12 hostname
```

`PRE docs/` 看起来像目录，其实不是。桶里只有两个对象，键分别是 `docs/2026/os-release` 和 `hostname`。所谓"目录"只是客户端按 `/` 分隔前缀（prefix）显示出来的效果：**对象存储的命名空间是扁平的**。这也意味着"重命名一个目录"在 S3 上要把前缀下的每个对象逐个复制再删除，没有原子性，前缀下有一百万个对象就要一百万次操作。

查看对象的元数据：

```console
$ aws $EP s3api head-object --bucket lab --key docs/2026/os-release
{
    "AcceptRanges": "bytes",
    "LastModified": "2026-09-24T02:45:08+00:00",
    "ContentLength": 386,
    "ETag": "\"4f7c2a0e9b1d3c5e7f9a1b3c5d7e9f01\"",
    "ContentType": "binary/octet-stream",
    "Metadata": {
        "owner": "alice",
        "purpose": "demo"
    }
}
```

每个对象 = 数据 + 系统元数据（大小、ETag、类型、修改时间）+ 用户自定义元数据。ETag 对普通上传通常是内容的 MD5，可以用来校验完整性。

### 对象是整体读写的

对象存储没有"打开文件、seek 到中间、改几个字节"这回事。改动一个对象的唯一办法是**上传一个完整的新版本覆盖它**：

```bash
echo "v1" > /tmp/obj.txt && aws $EP s3 cp /tmp/obj.txt s3://lab/obj.txt
echo "v2" >> /tmp/obj.txt && aws $EP s3 cp /tmp/obj.txt s3://lab/obj.txt   # 整体覆盖
aws $EP s3 cp s3://lab/obj.txt -                                            # 输出 v1 v2
```

读取倒是支持按范围（`Range: bytes=0-1023`），这对视频拖动播放、大文件并行下载很有用。大文件上传则用**分段上传（Multipart Upload）**：切成若干段并行上传，最后合并成一个对象，`aws s3 cp` 对大于 8 MiB 的文件会自动这么做。

### 预签名 URL：不给密钥也能访问

对象存储天生基于 HTTP，可以生成一个带签名和有效期的 URL，交给没有密钥的人或浏览器直接下载：

```console
$ URL=$(aws $EP s3 presign s3://lab/docs/2026/os-release --expires-in 300)
$ echo $URL
http://127.0.0.1:9000/lab/docs/2026/os-release?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=labadmin%2F20260924%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20260924T024612Z&X-Amz-Expires=300&X-Amz-SignedHeaders=host&X-Amz-Signature=9c1f...
$ curl -s "$URL" | head -2
PRETTY_NAME="Ubuntu 24.04.1 LTS"
NAME="Ubuntu"
```

这是网站让用户直传图片、下载报表的标准做法：应用服务器只负责签名，流量直接走对象存储，不经过应用。

> [!TIP] 其他客户端
> `aws` 之外，常见的还有 MinIO 的 `mc`（功能丰富，但同样受 MinIO 发布策略变化影响）、`rclone`（支持几十种存储后端，做迁移同步非常好用）、`s5cmd`（高并发，适合海量小对象批量操作）。应用里则直接用各语言的 AWS SDK（Python 的 boto3、Go 的 aws-sdk-go-v2），只需配置 endpoint 即可指向任何 S3 兼容存储。

### 清理

```bash
aws $EP s3 rb s3://lab --force            # 删除桶及其中所有对象
sudo docker rm -f rustfs
sudo docker volume rm rustfs-data
```

## 三种语义在后面的课程里

同一套分布式存储往往同时提供三种接口。以阶段 4 的 Ceph 为例：底层是统一的对象存储 RADOS，上面分别长出了块存储 RBD、文件存储 CephFS、对象网关 RGW，分别见 [RBD 块存储与 CephFS 文件系统](/learn/ceph-rbd-cephfs) 和 [RGW 对象网关](/learn/ceph-rgw)。

到了 Kubernetes 里，三种语义体现为 PVC 的访问模式：块存储对应 `ReadWriteOnce`（单节点读写），文件存储对应 `ReadWriteMany`（多节点共享），对象存储一般不走 PV，而是应用直接用 S3 SDK 访问。这些在 [Kubernetes 存储与 CSI](/learn/k8s-csi) 中展开。

阶段 3 会从原理上回答一个更根本的问题：这些数据是怎么被切分、复制、分散到几十上百台机器上的。先从[分布式存储基础](/learn/distributed-basics)开始，对象存储的内部设计则在[对象存储与 S3 协议](/learn/object-storage)。

## 动手练习

1. 按本课步骤建好 iSCSI LUN 并在客户端格式化挂载，写入一个文件后，在 Target 端用 `sudo strings /var/lib/lab/iscsi-disk01.img | grep "hello from block"` 查找你写入的内容，体会"服务端只看到块、看不到文件"。
2. 在 iSCSI 盘上用 `fio --direct=1 --rw=randread --bs=4k` 测一次延迟，再在同一台机器的本地盘上测一次，对比网络协议栈（即使是回环）带来的额外开销。
3. 把 NFS 导出选项分别改为 `sync` 和 `async`，用 `dd if=/dev/zero of=/mnt/nfs/t bs=1M count=500 conv=fdatasync` 各测一次写吞吐，解释差异以及 `async` 的风险。
4. 用 `aws s3 cp` 上传一个 100 MiB 的文件，然后用 `aws s3api head-object` 查看它的 ETag，观察分段上传的 ETag 格式与普通上传有什么不同（提示：末尾的 `-N`）。
5. 如果你有两台实验机，把 NFS 服务端和客户端分开，在两个客户端上同时向同一个目录写不同的文件，确认互相可见；再为第二台机器的 IQN 添加 ACL，把同一个 iSCSI LUN 登录到两台机器上（第二台**只读挂载**，`mount -o ro,norecovery`），在一边写入新文件后观察另一边是否能看到，并解释原因。

## 自测

<details>
<summary>块存储、文件存储、对象存储，文件系统分别运行在客户端还是服务端？</summary>

块存储的文件系统运行在客户端，服务端只提供按块寻址的裸设备，不知道上面存的是什么文件；文件存储的文件系统运行在服务端，客户端通过 NFS、SMB 等协议对文件和目录进行操作；对象存储没有传统文件系统，服务端维护的是桶与键组成的扁平命名空间，客户端通过 HTTP API 整体读写对象。

</details>

<details>
<summary>为什么不能把同一个 iSCSI LUN 同时挂载到两台机器上读写 ext4？</summary>

ext4 这类本地文件系统假设独占整个块设备，每台机器会在自己的内存中缓存元数据、独立分配块和 inode，彼此看不到对方的修改。两台机器同时写会互相覆盖元数据，很快导致文件系统损坏和数据丢失。多节点共享块设备需要 GFS2、OCFS2、GPFS 等带分布式锁的集群文件系统。

</details>

<details>
<summary>S3 里看到的"目录" docs/ 真的存在吗？这对应用有什么影响？</summary>

不存在。对象存储的命名空间是扁平的，`docs/2026/os-release` 只是一个包含斜杠的键，客户端按分隔符把相同前缀显示成"目录"。影响是：没有真正的目录操作，"重命名目录"需要对前缀下的每个对象逐一复制再删除，既不原子也很慢；列举大前缀需要分页遍历大量键。应用应避免依赖目录语义。

</details>

<details>
<summary>一个视频编辑软件需要频繁修改大文件中间的若干字节，适合直接跑在对象存储上吗？为什么？</summary>

不适合。对象存储不支持部分改写，任何修改都要重新上传整个对象，对大文件的小改动代价极高；它也不提供文件锁、原子 rename 等 POSIX 语义。这类负载应该使用块存储或文件存储。对象存储更适合一次写入、多次读取的数据，例如成品视频的归档与分发。

</details>

<details>
<summary>NFS 导出选项中的 sync、async 和 root_squash 分别意味着什么？</summary>

`sync` 要求服务端将数据写入稳定存储后才回复客户端，安全但较慢；`async` 允许服务端在数据仍在内存中时就回复，速度快，但服务端崩溃会丢失客户端认为已写入的数据。`root_squash`（默认开启）把客户端的 root 用户映射为 `nobody`，防止客户端的 root 在共享目录上拥有完全权限。

</details>

## 参考资料

- [targetcli-fb 项目](https://github.com/open-iscsi/targetcli-fb)
- [Open-iSCSI 项目](https://github.com/open-iscsi/open-iscsi)
- [Ubuntu Server 文档：iSCSI initiator](https://ubuntu.com/server/docs/how-to/storage/iscsi-initiator-or-client/)
- [Ubuntu Server 文档：Install NFS](https://ubuntu.com/server/docs/how-to/networking/install-nfs/)
- [exports(5) 手册页](https://man7.org/linux/man-pages/man5/exports.5.html)
- [RustFS 文档：Docker 安装](https://docs.rustfs.com/en/installation/container/docker)
- [RustFS 项目](https://github.com/rustfs/rustfs)
- [AWS CLI 参考：s3 命令](https://docs.aws.amazon.com/cli/latest/reference/s3/)
- [Amazon S3 用户指南：使用前缀组织对象](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-prefixes.html)
