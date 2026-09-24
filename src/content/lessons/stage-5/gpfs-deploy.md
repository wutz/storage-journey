# GPFS ECE 部署与多集群挂载

[上一课](/learn/gpfs-concepts)讲了 NSD、恢复组、分散式阵列和 owning / accessing 模型。这一课动手：从零部署一个 3 节点的 ECE 存储集群，创建恢复组、vdisk set 和文件系统，打开 RDMA，再部署一个只有客户端的访问集群，把文件系统远程挂载过去，最后做一轮初始调优。

示例拓扑是 AI 平台里很常见的"超融合"布局：3 台 GPU 服务器同时是 Kubernetes 计算节点和 ECE 存储节点，组成 owning cluster；3 台 Kubernetes 管理节点组成 accessing cluster，远程挂载文件系统，给 CSI 控制器和管理员使用。GPFS 部署的步骤很多，但真正决定成败的是规划和网络——命令本身反而是最简单的部分。

> [!NOTE] 本课需要的环境与许可
> - 生产 ECE 需要 **Storage Scale Erasure Code Edition** 许可和满足 IBM 硬件要求的服务器；访问集群需要 Data Access Edition 或 Data Management Edition 许可。Storage Scale 是商业软件，安装包从 IBM 获取。
> - 纯学习可以用免费的 **Developer Edition**：它不含 ECE，但可以用 3 台虚拟机 + 虚拟盘练习 `mmcrcluster`、`mmcrnsd`、`mmcrfs` 和本课后半部分的多集群挂载。
> - 本文命令基于截至本文写作时的 5.2.x 版本。安装包文件名、工具包参数、硬件要求都会变化，动手前务必对照 [IBM Storage Scale ECE 文档](https://www.ibm.com/docs/en/storage-scale-ece)和对应版本的 README。

## 规划

### 示例拓扑

```text
                      管理 / 守护进程网络 192.168.10.0/24（TCP，mmfsd 通信、ssh、K8s）
   ──────┬──────────┬──────────┬───────────────┬──────────┬──────────┬──────
         │          │          │               │          │          │
       mn01       mn02       mn03            sn01       sn02       sn03
     .10.11     .10.12     .10.13          .10.21     .10.22     .10.23
     .20.11     .20.12     .20.13          .20.21     .20.22     .20.23
         │          │          │               │          │          │
   ──────┴──────────┴──────────┴───────────────┴──────────┴──────────┴──────
                      存储数据网络 192.168.20.0/24（RoCEv2 / IB，verbsRdma）

   accessing cluster: client.example.com       owning cluster: storage.example.com
   K8s 控制面 + GPFS 客户端（远程挂载）         K8s GPU 节点 + ECE 存储服务器（RG1）
```

| 集群 | 节点 | 角色 | 许可 |
| --- | --- | --- | --- |
| storage.example.com | sn01～sn03 | quorum + manager + ECE 存储服务器，本地挂载 fs1 | ECE |
| client.example.com | mn01～mn03 | quorum + manager + 客户端，远程挂载 fs1 | DAE 或 DME |

GPU 服务器的 8 张计算网卡只给 NCCL 用，**不要**写进 GPFS 的 `verbsPorts`，存储走独立的存储网卡（参考 [RDMA 一课](/learn/rdma)的多轨网络规划）。

### 硬件与容量规划要点

截至本文写作时，ECE 对存储服务器的主要要求（以 IBM 最新文档为准）：

| 项目 | 要求 |
| --- | --- |
| 恢复组大小 | 每个 RG 3～32 台服务器，**同一 RG 内硬件配置必须相同**（CPU、内存、网卡、盘的型号与数量） |
| CPU / 内存 | x86_64，16 核以上；64 GB 以上内存（单节点 64 块盘以内），盘越多内存要求越高 |
| 系统盘 | RAID1，100 GB 以上 |
| 日志盘 | 每台服务器至少 1 块 SSD / NVMe 用于 GNR 日志 |
| 数据盘 | 每台最多 64 块；每块盘只连接一台服务器；**必须关闭盘的易失性写缓存** |
| 网络 | 节点间 25 Gb/s 以上，推荐 100 Gb/s 以上 RDMA |
| 操作系统 | RHEL / Rocky 等 EL8、EL9，具体小版本与内核见 FAQ |
| 部署 | 建议每个机柜一台服务器，让机柜成为故障域 |

RAID 码按节点数选（见上一课）：3 节点的 RG 只能用副本类的码（3WayReplication / 4WayReplication），空间效率只有 1/3～1/4；6 节点以上才能用 8+3P 这类宽条带码，效率提升到 70% 以上。**3 节点 ECE 适合入门和小规模，生产如果预算允许，一个 RG 至少 6 台**。

容量估算的思路：`可用容量 ≈ 裸容量 × 码效率 × (1 − 备用空间比例)`，备用空间由 GNR 按盘数自动预留（大约相当于 1～2 块盘）。可以用 [存储容量计算器](/calculator) 做初步测算，最终以 `mmvdisk vdiskset define` 输出的实际大小为准。

> [!PROD] 超融合节点的资源预留
> sn01～sn03 同时跑 GPU 训练和 ECE 服务。GPFS 的 pagepool 是锁定的常驻内存，`mmfsd` 在重建时也会吃掉大量 CPU。三条原则：pagepool 用**固定值**而不是百分比；在 kubelet 的 `systemReserved` 里扣掉 pagepool + 若干 GB 与若干 CPU 核；滚动维护（重启、升级）一次只动一台存储节点，等 RG 恢复健康再动下一台。

## 准备节点

以下操作在全部 6 台节点上执行（两个集群分别在各自的安装节点上操作）。

```bash title="/etc/hosts（两个集群的所有节点都写全）"
192.168.10.11  mn01.example.com  mn01
192.168.10.12  mn02.example.com  mn02
192.168.10.13  mn03.example.com  mn03
192.168.10.21  sn01.example.com  sn01
192.168.10.22  sn02.example.com  sn02
192.168.10.23  sn03.example.com  sn03
```

accessing 集群的节点必须能解析并访问 owning 集群的**所有**节点，反过来也一样——远程挂载时客户端要直接和每一台 NSD 服务器通信。

```bash
# 时间同步、关闭 SELinux 与防火墙（或者按 IBM 文档放行 1191/tcp、22/tcp 等端口）
dnf install -y chrony && systemctl enable --now chronyd
setenforce 0 && sed -i 's/^SELINUX=.*/SELINUX=disabled/' /etc/selinux/config
systemctl disable --now firewalld

# 构建内核可移植层（portability layer）需要的依赖，kernel-devel 必须与运行内核一致
dnf install -y kernel-devel-$(uname -r) kernel-headers gcc gcc-c++ cpp make \
    elfutils elfutils-devel rpm-build numactl python3 ansible-core

# 同一集群内 root 免密 ssh（包括到自己），安装工具包和 mm 命令都依赖它
ssh-keygen -t ed25519 -N '' -f /root/.ssh/id_ed25519
for h in sn01 sn02 sn03; do ssh-copy-id root@$h; done   # 在 accessing 集群换成 mn01～mn03

# 把 GPFS 命令加进 PATH
echo 'export PATH=/usr/lpp/mmfs/bin:$PATH' > /etc/profile.d/gpfs.sh
```

RDMA 网卡驱动（DOCA OFED 或发行版 rdma-core）要提前装好，并用 perftest 验收过带宽（见 [RDMA 一课](/learn/rdma)）。存储网卡 MTU 设为 9000。

### 就绪检查

IBM 在 GitHub 上提供了两个开源的预检工具，强烈建议上线前跑一遍：

```bash
# 操作系统与硬件是否满足 ECE 要求（CPU、内存、盘、网卡、写缓存等）
git clone https://github.com/IBM/SpectrumScale_ECE_OS_READINESS.git
cd SpectrumScale_ECE_OS_READINESS && ./ece_os_readiness.py

# 节点间网络的延迟与带宽是否满足要求（KOET）
git clone https://github.com/IBM/SpectrumScale_NETWORK_READINESS.git
cd SpectrumScale_NETWORK_READINESS && ./koet.py
```

工具的参数与输出格式随版本变化，按仓库 README 操作。任何一台节点报 FAIL，都先解决再往下走——ECE 对同构的要求是真的会被检查的。

## 部署 ECE 存储集群

### 用安装工具包装软件

在 sn01 上解压安装包并初始化安装工具包（Install Toolkit，底层是 Ansible）：

```bash
# 自解压安装包，--text-only 在终端里阅读并接受许可协议
chmod +x Storage_Scale_Erasure_Code-5.2.x.y-x86_64-Linux-install
./Storage_Scale_Erasure_Code-5.2.x.y-x86_64-Linux-install --text-only

cd /usr/lpp/mmfs/5.2.x.y/ansible-toolkit
./spectrumscale setup -s 192.168.10.21 -st ece        # 安装节点 IP，集群类型 ece
./spectrumscale config gpfs -c storage.example.com    # 集群名
./spectrumscale callhome disable                      # 不需要自动上报 IBM 时关闭

# -so：scale-out（ECE 存储）节点；-q：quorum；-m：manager
./spectrumscale node add sn01 -so -q -m
./spectrumscale node add sn02 -so -q -m
./spectrumscale node add sn03 -so -q -m
./spectrumscale node list

./spectrumscale install --precheck      # 只做检查
./spectrumscale install                 # 安装软件、构建可移植层、创建集群、启动 GPFS
```

安装完成后确认集群状态：

```bash
mmlscluster
mmgetstate -a
#  Node number  Node name  GPFS state
# -------------------------------------
#        1      sn01       active
#        2      sn02       active
#        3      sn03       active
```

> [!WARNING] 不要用 `--skip no-ece-check` 骗过检查
> 工具包在安装前会检查 ECE 硬件要求，网上流传的 `./spectrumscale install --skip no-ece-check` 可以跳过这一步。用虚拟机做实验时可以这么干；生产环境里跳过检查，等于放弃了 IBM 的支持承诺，出了问题也很难归因。

### 盘位映射

GNR 需要知道每块盘在机箱里的物理位置，才能在换盘时点亮正确的定位灯、在报告里给出准确位置。NVMe 服务器通常用 `ecedrivemapping` 生成映射文件（`.edf`）：

```bash
mmshutdown -a
ecedrivemapping --mode nvme               # HDD / SAS 盘使用 --mode lmr
ecedrivemapping --mode nvme --report      # 检查映射结果
mmstartup -a
```

映射文件保存在 `/usr/lpp/mmfs/data/gems/`。硬件完全相同的节点可以复制同一份映射文件。是否需要手动映射、支持哪些背板，与版本和机型有关，以对应版本的 ECE 文档为准。

### 配置服务器并创建恢复组

后面的操作都通过 `mmvdisk`，它是 ECE 的声明式管理工具。

```bash
# 1. 把 RG 内的服务器放进一个节点类（node class）
mmvdisk nodeclass create --node-class nc_rg1 -N sn01,sn02,sn03

# 2. 按 ECE 要求自动设置这组服务器的参数，--recycle one 表示逐台重启 GPFS 让配置生效
#    超融合节点用固定 pagepool，按你为 GPU 作业留出的内存计算
mmvdisk server configure --node-class nc_rg1 --recycle one --pagepool 64G

# 3. 确认每台服务器看到的盘拓扑一致（盘数、类型、容量）
mmvdisk server list --node-class nc_rg1 --disk-topology

# 4. 创建恢复组：GNR 会接管盘、创建 pdisk、分散式阵列和日志组
mmvdisk recoverygroup create --recovery-group rg1 --node-class nc_rg1

mmvdisk recoverygroup list --recovery-group rg1 --declustered-array
mmvdisk pdisk list --recovery-group rg1
```

盘上如果残留旧的分区表、LVM 或文件系统签名，创建 RG 会失败。先确认盘符再清理，**这一步不可逆**：

```bash
lsblk -o NAME,SIZE,MODEL,SERIAL,MOUNTPOINT      # 反复确认不是系统盘
wipefs -a /dev/nvme2n1
```

### 定义 vdisk set，创建文件系统

vdisk set 先 define（只计算、不落盘，可以反复调整），满意后再 create：

```bash
# 元数据：4 副本，1 MiB 块，占 DA 空间的 5%，放在 system 池
mmvdisk vdiskset define --vdisk-set vs_meta --recovery-group rg1 \
    --code 4WayReplication --block-size 1m --set-size 5% \
    --nsd-usage metadataOnly --storage-pool system

# 数据：3 副本（3 节点 RG 的推荐码），2 MiB 块，占 85%，放在 data 池
mmvdisk vdiskset define --vdisk-set vs_data --recovery-group rg1 \
    --code 3WayReplication --block-size 2m --set-size 85% \
    --nsd-usage dataOnly --storage-pool data

# 查看计算结果：每个 vdisk 的大小、剩余空间、服务器内存需求
mmvdisk vdiskset list --vdisk-set all

mmvdisk vdiskset create --vdisk-set vs_meta,vs_data
```

几个容易踩的点：

- 副本类的码支持的块大小为 256K～2M，Reed-Solomon 纠删码支持 512K～16M（截至本文写作时），并且所有节点的 `maxblocksize` 必须不小于最大的 vdisk 块大小。6 节点以上的 RG 数据通常用 `--code 8+3P --block-size 4m` 或 `8m`。
- `--set-size` 不要一次用满，留出余量给以后新建 vdisk set（例如多租户时每个租户一个文件系统）。
- 如果不想分元数据和数据，也可以只定义一个 `--nsd-usage dataAndMetadata --storage-pool system` 的 vdisk set，简单但少了一层灵活性。

创建文件系统，`--mmcrfs` 之后的参数原样传给 `mmcrfs`：

```bash
mmvdisk filesystem create --file-system fs1 --vdisk-set vs_meta,vs_data \
    --mmcrfs -T /gpfs/fs1 -A yes -Q yes

# 常用的文件系统属性
mmchfs fs1 --auto-inode-limit     # inode 不够时自动扩展（5.1.4+）
mmchfs fs1 --filesetdf            # df 在 fileset 挂载点上显示 fileset 配额而不是整个文件系统
mmlsfs fs1 -B -Q --filesetdf
```

数据放在独立的 data 池时，必须有放置策略（placement policy）告诉 GPFS 新文件写到哪个池，否则写入会因为 system 池只允许元数据而失败。检查一下，没有就补上：

```bash
mmlspolicy fs1 -L

cat > /tmp/placement.pol <<'EOF'
RULE 'default' SET POOL 'data'
EOF
mmchpolicy fs1 /tmp/placement.pol -I yes
```

挂载并验证：

```bash
mmmount fs1 -a
mmlsmount fs1 -L
mmdf fs1                        # 各池、各 NSD 的容量与使用率
df -h /gpfs/fs1
mmhealth cluster show
```

### 打开 RDMA

```bash
# 只对 ECE 服务器节点类生效；设备名以 ibdev2netdev 的输出为准
mmchconfig verbsRdma=enable,verbsRdmaCm=enable,verbsPorts="mlx5_4/1 mlx5_5/1" -N nc_rg1

# verbs 参数需要重启 GPFS 才生效；生产上逐台重启，避免 RG 同时失去多台服务器
mmshutdown -N sn01 && mmstartup -N sn01
mmgetstate -N sn01      # active 之后，mmvdisk rg list 确认 RG 健康，再处理下一台

mmfsadm test verbs status
mmdiag --network
```

InfiniBand 网络不需要 `verbsRdmaCm`；RoCE 网络必须开启。`verbsRdmaSend`（守护进程 RPC 也走 RDMA）在小规模集群可以开，数百节点以上的大集群一般保持关闭。

## GUI 与版本（简）

**GUI** 提供 Web 管理界面、健康事件、性能图表，最重要的是提供 **REST API**——Kubernetes 的 GPFS CSI 驱动就是通过它管理 fileset 和配额的（见 [GPFS Day-2](/learn/gpfs-day2)）。GUI 节点需要能免密 ssh 到集群所有节点，只需管理网络。多集群场景下，如果要用 CSI，两个集群都要各有一个 GUI。

安装工具包里 `-so`（ECE 存储节点）与 `-g`（GUI 节点）不能用在同一个节点上，owning 集群通常额外加一台小规格的虚拟机或物理机 `gui01` 作为 GUI 节点：

```bash
./spectrumscale node add gui01 -a -g      # -a 管理节点，-g GUI 节点
./spectrumscale install

# GUI 起来后，在 gui01 上创建管理员和 CSI 专用用户（密码用你自己的强密码）
/usr/lpp/mmfs/gui/cli/mkuser admin -g SecurityAdmin -p '<ADMIN_PASSWORD>'
/usr/lpp/mmfs/gui/cli/mkusergrp CsiAdmin --role csiadmin
/usr/lpp/mmfs/gui/cli/mkuser csiadmin -g CsiAdmin -p '<CSI_PASSWORD>'
```

然后浏览器访问 `https://gui01.example.com`。GUI 的性能图表依赖性能监控组件（`pmcollector` / `pmsensors`），工具包安装时一并部署。

**版本选择**：访问集群用 DAE 还是 DME？主要看要不要 DME 独有的功能，例如文件审计日志（需要在客户端记录访问事件）、加密、AFM 等。截至本文写作时，5.2.3 以后的版本还提供了新的原生 REST API 与 `scalectl` 命令行（不依赖 GUI 的管理守护进程），它会逐渐改变集群管理和远程授权的方式，但目前仍在演进中，本文继续使用经典的 `mm` 命令。

## 部署访问集群

accessing 集群只有客户端，可以用安装工具包，也可以手动装 RPM。手动装一遍能帮你看清楚 GPFS 到底由哪些包组成：

```bash
# 在 mn01～mn03 上：解压 DME 安装包后，RPM 位于 /usr/lpp/mmfs/5.2.x.y/gpfs_rpms/
cd /usr/lpp/mmfs/5.2.x.y/gpfs_rpms
dnf install -y gpfs.base-*.rpm gpfs.gpl-*.rpm gpfs.gskit-*.rpm gpfs.msg.en_US-*.rpm \
    gpfs.docs-*.rpm gpfs.license.dm-*.rpm gpfs.adv-*.rpm gpfs.crypto-*.rpm
# DAE 用 gpfs.license.da，且不需要 gpfs.adv / gpfs.crypto

# 为当前内核构建可移植层（每次升级内核后都要重做）
mmbuildgpl
```

在 mn01 上创建集群：

```bash title="/root/nodes.list"
mn01:quorum-manager
mn02:quorum-manager
mn03:quorum-manager
```

```bash
mmcrcluster -N /root/nodes.list -C client.example.com -A     # -A：开机自动启动 GPFS
mmchlicense server --accept -N mn01,mn02,mn03                # quorum / manager 节点需要 server 许可
mmstartup -a
mmgetstate -a
mmlscluster
```

以后加入的纯 GPU 客户端节点用 `mmaddnode -N gpu01` 加入，并执行 `mmchlicense client --accept -N gpu01`。

客户端的 RDMA 同样要打开：

```bash
mmchconfig verbsRdma=enable,verbsRdmaCm=enable,verbsPorts="mlx5_4/1" -N all
mmshutdown -a && mmstartup -a      # 客户端集群可以整体重启，不影响存储集群
```

## 多集群远程挂载

整个过程就是"交换公钥 → owning 授权 → accessing 登记远程集群和文件系统 → 挂载"。

```text
 storage.example.com（owning）                      client.example.com（accessing）
 ① mmauth show .  确认有密钥                          ① mmauth show .  确认有密钥
 ② /var/mmfs/ssl/id_rsa.pub ──────复制为 storage.pub──▶
 ◀──────复制为 client.pub────── /var/mmfs/ssl/id_rsa.pub ②
 ③ mmauth add client.example.com -k client.pub
 ④ mmauth grant client.example.com -f fs1 -a rw
                                                       ③ mmremotecluster add storage.example.com …
                                                       ④ mmremotefs add rfs1 -f fs1 …
                                                       ⑤ mmmount rfs1 -a
```

### 1. 检查两端的认证密钥

两个集群上各执行：

```bash
mmauth show .
# Cluster name:        storage.example.com (this cluster)
# Cipher list:         AUTHONLY
# SHA digest:          ...
# File system access:  (all rw)
```

如果显示还没有生成密钥，执行 `mmauth genkey new`，再用 `mmauth update . -l AUTHONLY` 设为只认证不加密（需要链路加密时选择具体的密码套件）。较老的版本修改 cipherList 需要先停止整个集群的 GPFS，以你所用版本的 `mmauth` 文档为准。

### 2. 交换公钥

```bash
# 在 mn01 上执行
scp sn01:/var/mmfs/ssl/id_rsa.pub /root/storage.pub
scp /var/mmfs/ssl/id_rsa.pub sn01:/root/client.pub
# 只复制 .pub 公钥；同目录下的私钥文件不要复制到任何地方
```

### 3. owning 集群授权

```bash
# 在 sn01 上
mmauth add client.example.com -k /root/client.pub
mmauth grant client.example.com -f fs1 -a rw
mmauth show all
```

`-a ro` 授予只读；`-r uid:gid` 可以把远程集群的 root 映射成指定的普通用户（root squash）。注意 grant / deny 的变更**只在下一次挂载时生效**，已经挂载的节点不受影响。新版本还支持只授权部分 fileset，这是多租户的基础，放在 [GPFS Day-2](/learn/gpfs-day2) 里讲。

### 4. accessing 集群登记并挂载

```bash
# 在 mn01 上
# -n：联系节点（contact nodes），用于获取 owning 集群信息，写多个以防单点
mmremotecluster add storage.example.com -n sn01,sn02,sn03 -k /root/storage.pub
mmremotecluster show all

# rfs1 是本地的设备名，-f 是 owning 集群中的文件系统名，-A yes 随 GPFS 启动自动挂载
mmremotefs add rfs1 -f fs1 -C storage.example.com -T /gpfs/fs1 -A yes
mmremotefs show all

mmmount rfs1 -a
mmlsmount rfs1 -L       # 会同时列出两个集群中挂载了 fs1 的节点
df -h /gpfs/fs1
```

这里特意把本地设备名写成 `rfs1`，是为了让你看清"本地名"和"远程名"是两回事。生产上我更推荐本地设备名和挂载点都与 owning 集群**保持一致**（`mmremotefs add fs1 -f fs1 ... -T /gpfs/fs1`），这样作业脚本、监控和 CSI 在两个集群的节点上看到的是同一个名字、同一个路径，少一层映射就少一类事故。

挂载失败时，先看 `/var/adm/ras/mmfs.log.latest`，最常见的原因：

| 报错现象 | 原因 |
| --- | --- |
| `Permission denied` / authentication failed | 公钥交换错了，或 owning 端没有 `mmauth grant` |
| 挂载卡住、超时 | accessing 节点访问不到某台 owning 节点的 1191 端口，或名字解析不通 |
| 挂载成功但很慢 | RDMA 没有建立，`mmdiag --network` 里全是 TCP |
| 提示块大小超过 `maxblocksize` | 访问集群的 `maxblocksize` 小于远程文件系统的块大小；`mmchconfig maxblocksize=16M` 后重启 GPFS |
| `Stale file handle` | owning 端文件系统被重建过，accessing 端需要 `mmremotefs delete` 后重新添加 |

> [!TIP] 多张网卡与 subnets
> 如果守护进程网络和存储网络是两张网，并且希望集群间的 TCP 通信优先走存储网，可以用 `mmchconfig subnets=...` 为远程集群指定子网，语法与限制见 IBM 文档的 "Using remote access with multiple network definitions"。本例中守护进程走 192.168.10.x、数据走 RDMA，一般不需要配置。

## 初始调优

`mmvdisk server configure` 已经为 ECE 服务器设置了一组经过验证的参数，**不要**在不了解的情况下覆盖它们。需要手动调的主要是客户端和少数几个与规模相关的参数：

| 参数 | 含义 | ECE 服务器 | 客户端 |
| --- | --- | --- | --- |
| `pagepool` | GPFS 数据与元数据缓存，锁定内存 | 由 `mmvdisk` 设置（本例 64G） | 16G～64G，按内存与负载 |
| `maxMBpS` | 单节点预读 / 写回的 I/O 吞吐估计值 | 约为网络带宽的 2 倍，上限 100000 | 同左 |
| `workerThreads` | 守护进程工作线程数 | 3072 左右 | 1024 左右 |
| `maxFilesToCache` | 缓存的 inode 数（每个约 3～10 KB 内存） | 3M 左右 | 1M 左右 |
| `maxStatCache` | stat 缓存条目（每个约 400～500 B） | 4M 左右 | 1M 左右 |

以上是本文作者环境的起点值，不是标准答案，结合负载和内存逐步调整。用节点类让配置管理更清晰：

```bash
mmcrnodeclass nc_client -N mn01,mn02,mn03
mmchconfig pagepool=32G,workerThreads=1024,maxFilesToCache=1M,maxStatCache=1M,maxMBpS=50000 -N nc_client
mmshutdown -N nc_client && mmstartup -N nc_client

mmlsconfig                          # 查看配置
mmdiag --config | grep -i maxMBpS   # 查看守护进程实际生效的值
```

性能验收用 IBM 自带的测试工具：

- `nsdperf`（源码在 `/usr/lpp/mmfs/samples/net/`）：绕开文件系统，只测 GPFS 节点间网络，能暴露 RDMA 配置问题。
- `gpfsperf`（源码在 `/usr/lpp/mmfs/samples/perf/`）：测文件系统的顺序与随机读写。
- 也可以用 [基准测试](/learn/benchmarking)一课的 fio，在多个客户端上同时运行 `--direct=1 --bs=4m` 的顺序读写。

## 动手练习

1. 用 3 台虚拟机（每台额外挂 2 块虚拟盘）和 Developer Edition，手动安装 RPM，用 `mmcrcluster`、`mmcrnsd`、`mmcrfs` 创建一个传统（非 ECE）集群和文件系统。
2. 再用 2 台虚拟机创建第二个集群，完成本课的"交换公钥 → mmauth grant → mmremotecluster add → mmremotefs add → mmmount"全过程，并用 `mmlsmount -L` 看两个集群的挂载情况。
3. 在 owning 集群上执行 `mmauth deny client.example.com -f fs1`，先观察已挂载的客户端是否受影响，再在客户端上 `mmumount rfs1` 后重新 `mmmount`，看看报什么错（提示：授权变更只在下一次挂载时生效），最后用 `mmauth grant` 恢复授权。
4. 如果有 ECE 环境：对同一个 RG 分别 `define` 一个 3WayReplication 和一个 4+2P 的 vdisk set（节点数足够时），用 `mmvdisk vdiskset list` 对比可用容量，然后 `mmvdisk vdiskset undefine` 撤销。
5. 在客户端上把 `pagepool` 从 4G 调到 32G，用 fio 或 `gpfsperf` 对比顺序读带宽与重复读同一文件的表现，解释差异。

## 自测

<details>
<summary>为什么 ECE 的恢复组要求组内服务器配置完全相同？</summary>

GNR 把每个条带的分片均匀分散到 RG 内所有服务器和盘上，并按统一的规则计算容错能力、备用空间和日志组分布。如果服务器的盘数量、容量或性能不同，数据分布会失衡，慢盘或小容量节点成为瓶颈，容错计算也不再成立。所以同一 RG 内服务器必须同构，不同配置的服务器应该放进不同的 RG。

</details>

<details>
<summary>数据放在独立的 data 池时，为什么需要放置策略？</summary>

GPFS 默认把新文件的数据写到 system 池。当 system 池只包含 metadataOnly 的 NSD 时，没有地方存放数据，写入会失败。放置策略（如 `RULE 'default' SET POOL 'data'`）告诉 GPFS 把新文件的数据放到 data 池。用 `mmlspolicy fs1 -L` 检查，用 `mmchpolicy` 安装。

</details>

<details>
<summary>远程挂载的基本步骤是什么？分别在哪个集群上执行？</summary>

两个集群各自确认有认证密钥（`mmauth show .`，必要时 `mmauth genkey new`），互相交换 `/var/mmfs/ssl/id_rsa.pub`。在 owning 集群上执行 `mmauth add` 登记访问集群的公钥，再用 `mmauth grant` 授权文件系统。在 accessing 集群上执行 `mmremotecluster add` 登记 owning 集群和联系节点，`mmremotefs add` 定义远程文件系统和挂载点，最后 `mmmount` 挂载。

</details>

<details>
<summary>给 ECE 服务器开启 verbsRdma 后，为什么建议逐台重启而不是 mmshutdown -a？</summary>

verbs 参数需要重启 GPFS 守护进程才能生效。同时停止所有服务器会让整个 RG 和文件系统下线，所有客户端中断。逐台重启时 RG 在容错范围内继续服务，只是暂时降级；每重启一台都要确认它重新 active、RG 恢复健康后再处理下一台，否则第二台重启时可能超出容错能力。

</details>

<details>
<summary>超融合节点上，为什么 pagepool 要用固定值而不是百分比？</summary>

pagepool 是 GPFS 锁定的常驻内存，不能被换出或回收。超融合节点上 GPU 训练作业同样需要大量主机内存，用百分比（例如 70%）会挤压作业内存，还可能触发 OOM。用固定值可以精确计算留给作业的内存，并在 kubelet 的 systemReserved 中扣除，让 Kubernetes 调度时知道真实可用的内存。

</details>

## 参考资料

- [IBM Storage Scale Erasure Code Edition 文档](https://www.ibm.com/docs/en/storage-scale-ece)
- [ECE 文档：RAID 码选择建议](https://www.ibm.com/docs/en/storage-scale-ece/5.2.3?topic=selection-recommendations)
- [IBM Storage Scale 文档：mmvdisk 命令](https://www.ibm.com/docs/en/storage-scale-ece/5.2.3?topic=commands-mmvdisk-command)
- [IBM Storage Scale 文档：mmauth 命令](https://www.ibm.com/docs/en/storage-scale/5.2.3?topic=reference-mmauth-command)
- [IBM Storage Scale 文档：mmremotefs 命令](https://www.ibm.com/docs/en/storage-scale/5.2.3?topic=reference-mmremotefs-command)
- [IBM Storage Scale 文档：Using remote access with multiple network definitions](https://www.ibm.com/docs/en/storage-scale/5.2.3?topic=system-using-remote-access-multiple-network-definitions)
- [IBM Storage Scale FAQ（支持的操作系统、内核与 OFED 版本）](https://www.ibm.com/docs/en/storage-scale?topic=STXKQY/gpfsclustersfaq.html)
- [IBM Storage Scale 文档：管理 GUI 用户](https://www.ibm.com/docs/en/storage-scale/5.2.2?topic=administering-managing-gui-users)
- [IBM/SpectrumScale_ECE_OS_READINESS](https://github.com/IBM/SpectrumScale_ECE_OS_READINESS)
- [IBM/SpectrumScale_NETWORK_READINESS](https://github.com/IBM/SpectrumScale_NETWORK_READINESS)
- [Spectrum Scale 用户组：Spectrum Scale Erasure Code Edition](https://www.spectrumscaleug.org/wp-content/uploads/2020/04/Spectrum-Scale-Erasure-Code-Edition-ECE.pdf)
