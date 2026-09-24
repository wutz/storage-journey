# GPFS Day-2：快照、租户与调优

集群装好、文件系统挂上只是开始。GPFS 的日常运维是另一门手艺：每天看健康状态和容量，给团队切 fileset、配配额、限 QoS，定期打快照，坏盘及时换，节点按需扩缩，偶尔还要开 NFS 出口、打开审计日志，最后把它接进 Kubernetes。这一课按"每天要做的 → 每周要做的 → 偶尔要做的"组织，结尾是调优参数、常见问题与卸载。

示例沿用[上一课](/learn/gpfs-deploy)的环境：owning 集群 `storage.example.com`（sn01～sn03，ECE 恢复组 rg1，文件系统 fs1 挂载在 `/gpfs/fs1`），accessing 集群 `client.example.com`（mn01～mn03）。

> [!NOTE] 本课需要的环境与许可
> 快照、fileset、配额、QoS 在 Developer Edition 的学习集群里都能练。`mmvdisk` 相关的换盘和扩容需要 ECE 环境；文件审计日志需要 Data Management Edition（或 Developer Edition）。Storage Scale 是商业软件，命令基于截至本文写作时的 5.2.x 版本，行为与限制以 [IBM Storage Scale 文档](https://www.ibm.com/docs/en/storage-scale)为准。

## 每天看一眼：状态巡检

| 命令 | 看什么 |
| --- | --- |
| `mmgetstate -a` | 所有节点的 GPFS 守护进程是否 `active` |
| `mmlscluster` | 集群成员、quorum / manager 角色 |
| `mmlsmgr` / `mmlsmgr -c` | 每个文件系统的 File System Manager、Cluster Manager 在哪 |
| `mmhealth cluster show` | 全集群各组件（NODE、GPFS、NETWORK、FILESYSTEM、NATIVE_RAID…）的健康汇总 |
| `mmhealth node show -N all` | 按节点展开，定位是哪个节点、哪个组件出问题 |
| `mmhealth node eventlog` | 本节点的健康事件历史，排障时先看它 |
| `mmlsmount all -L` | 每个文件系统被哪些节点挂载（包括远程集群的节点） |
| `mmdf fs1` | 各存储池、各 NSD 的容量与使用率 |
| `mmdf fs1 -F` | inode 用量 |
| `mmlsfs fs1` | 文件系统属性：块大小、副本数、配额开关、inode 限制等 |
| `mmvdisk recoverygroup list` | ECE 恢复组、服务器、日志组是否正常 |
| `mmvdisk pdisk list --recovery-group all --not-ok` | 有没有不在正常服务状态的盘 |

```bash
mmhealth cluster show
# Component           Total   Failed   Degraded   Healthy   Other
# ----------------------------------------------------------------
# NODE                    3        0          0         3       0
# GPFS                    3        0          0         3       0
# NETWORK                 3        0          0         3       0
# FILESYSTEM              1        0          0         1       0
# NATIVE_RAID             3        0          0         3       0
# PERFMON                 3        0          0         3       0
```

我的习惯是把 `mmhealth cluster show`、`mmdf` 和 `mmvdisk pdisk list --not-ok` 的结果接进监控系统（GPFS 自带的性能监控组件可以对接 Grafana，也可以自己写 exporter 解析 `-Y` 机器可读输出，参考 [存储监控](/learn/storage-monitoring)），而不是每天手敲。所有 `mm` 命令基本都支持 `-Y`，输出冒号分隔的字段，适合脚本处理。

## Fileset：多租户的基本单元

### 独立与依赖

| 类型 | inode 空间 | 能做什么 | 典型用途 |
| --- | --- | --- | --- |
| 独立 fileset（independent） | 有自己的 inode 空间和 inode 上限 | fileset 级快照、配额、QoS、远程授权、`mmrestorefs -j` | 每个团队、每个租户、每个项目 |
| 依赖 fileset（dependent） | 共享父独立 fileset 的 inode 空间 | 配额；快照跟随父 fileset | 团队内部再细分目录 |

截至本文写作时，每个文件系统最多约 3000 个独立 fileset、10000 个 fileset（以 FAQ 为准）。`mmcrfileset` 默认创建依赖 fileset，要独立 fileset 必须加 `--inode-space new`：

```bash
# 创建独立 fileset，并链接（link）到目录树中的某个路径
mmcrfileset fs1 team-a --inode-space new --inode-limit 10M:1M
mmlinkfileset fs1 team-a -J /gpfs/fs1/team-a

# 在它下面建一个依赖 fileset
mmcrfileset fs1 team-a-scratch --inode-space team-a
mmlinkfileset fs1 team-a-scratch -J /gpfs/fs1/team-a/scratch

mmlsfileset fs1 -L          # 列出 fileset、inode 空间、链接路径
mmlsfileset fs1 -i          # inode 用量（大文件系统上较慢）
```

`--inode-limit 10M:1M` 表示最大 1000 万 inode、预分配 100 万。文件系统开启了 `--auto-inode-limit`（上一课做过）后，inode 不够时会自动扩展，省掉一类半夜告警。

删除 fileset 要先 unlink，而且 `mmdelfileset` 会删掉里面的所有数据：

```bash
mmunlinkfileset fs1 team-a-scratch
mmdelfileset fs1 team-a-scratch -f       # -f 强制删除非空 fileset，数据不可恢复
```

### 配额

```bash
mmchfs fs1 -Q yes                        # 开启配额（上一课已开）
mmsetquota fs1:team-a --block 9T:10T --files 9M:10M     # 软限制:硬限制
mmlsquota -j team-a fs1
mmrepquota -j fs1                        # 所有 fileset 的配额报告
mmrepquota -a                            # 所有文件系统的用户、组、fileset 配额
```

超过软限制后有宽限期（grace period，默认 7 天），宽限期过后或者触及硬限制时写入失败（`EDQUOT`）。几个值得记住的细节：

- **配额只能在 owning 集群上设置和查看完整报告**，accessing 集群只能看到自己授权范围内的信息。
- root 默认不受 fileset 配额限制。多租户场景下，容器里往往就是 root，所以要打开 `mmchconfig enforceFilesetQuotaOnRoot=yes -i`（在写入发生的集群上，包括 accessing 集群都要设置）。
- 先写入数据、后开启配额时，需要执行一次 `mmcheckquota fs1` 重新统计用量。
- 用户、组级配额默认按整个文件系统统计；`mmchfs fs1 --perfileset-quota` 可以改成按 fileset 统计，但 Kubernetes CSI 驱动要求它保持关闭（见后文）。

### QoS

配额限制的是"用多少"，QoS（`mmqos`）限制的是"用多快"。一个跑大规模数据预处理的租户，完全可以把整个集群的 IOPS 吃光：

```bash
mmqos filesystem enable fs1
mmqos class create fs1 --class team-a --fileset team-a
mmqos throttle create fs1 --pool data --class team-a --maxiops 20000 --maxmbs 5000
mmqos class list fs1
mmqos throttle list fs1
mmqos filesystem list fs1
```

`mmqos` 对 IOPS 下限有保护（截至本文写作时低于 100 IOPS 需要加 `--force`）。一个常见技巧是**把 root fileset 限到极低**，防止有人绕过 fileset 直接往文件系统根目录写数据：

```bash
mmqos class create fs1 --class fs1-root --fileset root
mmqos throttle create fs1 --pool all --class fs1-root --maxiops 1 --maxmbs 1 --force
```

> [!WARNING] QoS 管不住元数据
> `mmqos` 的 fileset 类限制的是该 fileset 数据所在存储池上的 I/O。海量 `stat`、`create`、`unlink` 这类元数据风暴主要压在 metanode 和 token 上，QoS 无能为力。一个 `find /gpfs/fs1 -type f` 就能拖慢所有人——治理靠规范和监控，不是靠参数。

## 多租户模型

把 fileset、配额、QoS 和多集群授权组合起来，就得到三种多租户模型：

| 模型 | 隔离粒度 | 起步规模 | 交付时间 | 优点 | 缺点 |
| --- | --- | --- | --- | --- | --- |
| 每租户一个存储集群 | 物理隔离 | 500 TB 以上 | 数天 | 完全隔离，性能可预期，可用官方 CSI | 成本高，交付慢 |
| 每租户一个文件系统 | 独立文件系统，共享 ECE 盘 | 几十 TB 一档 | 1 天以内 | 文件系统级故障隔离，可按文件系统授权 | 受每个 RG 最多 512 个 vdisk 的限制，份数有限；底层盘仍然共享 |
| 每租户一个 fileset | 独立 fileset，共享文件系统 | 任意 | 数小时 | 最灵活，最省空间 | 元数据与 token 共享，互相干扰最明显 |

我的观点：大客户用独立集群，中小团队用独立 fileset，"每租户一个文件系统"在 ECE 上很快会碰到 vdisk 数量上限，适合作为少数重要租户的中间档。

每租户一个 fileset 的完整流程（owning 集群上执行）：

```bash
# 1. 租户 fileset + 配额 + QoS
mmcrfileset fs1 tenant1 --inode-space new
mmlinkfileset fs1 tenant1 -J /gpfs/fs1/tenant1
mmsetquota fs1:tenant1 --block 95T:100T --files 95M:100M
mmqos class create fs1 --class tenant1 --fileset tenant1
mmqos throttle create fs1 --pool data --class tenant1 --maxiops 50000 --maxmbs 10000

# 2. 只把这个 fileset 授权给租户的 accessing 集群
#    第一次建立允许列表时必须包含 root fileset（5.1.4+，文件系统格式要求见文档）
mmauth add tenant1.example.com -k /root/tenant1.pub
mmauth grant tenant1.example.com -f fs1 --fileset root,tenant1 -a rw
mmauth show tenant1.example.com
```

授权了 fileset 允许列表之后，租户集群看不到（也访问不了）列表以外的 fileset，`mmlsfileset` 和 `mmlssnapshot` 里也不会出现。root fileset 本身始终可见，所以**不要在 root fileset 里放任何数据**，配合上面对 root 的 QoS 限制。撤销授权用 `mmauth deny tenant1.example.com -f fs1 --fileset tenant1`；grant / deny 在租户下一次挂载时生效。

## 快照

GPFS 快照是写时复制（copy-on-write）的只读视图，创建几乎瞬间完成，只有被修改的块才占用额外空间。

```bash
# 全局快照（整个文件系统）
mmcrsnapshot fs1 daily-20260924
# fileset 快照（只针对独立 fileset）
mmcrsnapshot fs1 tenant1:daily-20260924
# 带过期时间，过期前不允许删除
mmcrsnapshot fs1 tenant1:weekly-20260924 --expiration-time 2026-10-24-00:00

mmlssnapshot fs1
mmlssnapshot fs1 -d            # 显示每个快照占用的空间（较慢）
```

快照内容通过隐藏目录 `.snapshots` 访问：全局快照在文件系统根目录下，fileset 快照在 fileset 的链接目录下。`mmsnapdir fs1 -a` 可以让每个子目录都能看到 `.snapshots`，方便用户自助找回文件。

恢复分两种：

```bash
# 找回个别文件：直接从快照目录复制，最常用也最安全
cp -a /gpfs/fs1/tenant1/.snapshots/daily-20260924/project/config.yaml /gpfs/fs1/tenant1/project/

# 整个 fileset 回滚到快照：会覆盖快照之后的所有修改
mmrestorefs fs1 daily-20260924 -j tenant1

# 删除快照
mmdelsnapshot fs1 tenant1:daily-20260924
```

`mmrestorefs` 执行期间不要 unlink fileset、卸载文件系统或删除快照，最好先停掉该 fileset 上的业务。定期快照可以在 GUI 里配置快照规则，也可以用 cron 调用 `mmcrsnapshot` / `mmdelsnapshot` 做轮转。

> [!DANGER] 快照不是备份
> 快照和原数据在同一组盘上。恢复组损毁、文件系统损坏、误删文件系统，快照会一起消失。真正的备份要把数据复制到另一套存储（AFM 异步复制、对象存储分层、或 `mmbackup` 对接 IBM Storage Protect 等备份软件）。

## 换盘与扩缩容

### 换盘（ECE）

GNR 发现坏盘后会自动重建数据、把盘标记为需要更换，`mmhealth` 会报 `NATIVE_RAID` 降级。换盘是三步：

```bash
# 1. 找出需要更换的盘
mmvdisk pdisk list --recovery-group all --replace
# 2. 准备：GNR 把这块盘上的数据迁走，并点亮定位灯
mmvdisk pdisk replace --prepare --recovery-group rg1 --pdisk n002p005
# 3. 物理更换同类型的新盘后，完成替换
mmvdisk pdisk replace --recovery-group rg1 --pdisk n002p005

mmvdisk pdisk list --recovery-group rg1 --pdisk n002p005
```

pdisk 名字以 `mmvdisk pdisk list` 的实际输出为准。新盘会沿用旧 pdisk 的名字；旧盘数据没排空时会带一个 `#nnnn` 后缀的临时名字，排空后自动删除。

### 扩容：往恢复组里加服务器

新服务器必须和 RG 内现有服务器配置完全相同。先用安装工具包把它加入集群，再交给 `mmvdisk`：

```bash
# 在安装节点上
./spectrumscale node add sn04 -so
./spectrumscale install

# 配置服务器参数，然后加入恢复组
mmvdisk server configure -N sn04 --recycle one
mmvdisk recoverygroup add --recovery-group rg1 -N sn04
```

`mmvdisk recoverygroup add` 分两步完成：第一步把新服务器的盘加入 RG，开始在所有盘之间重新平衡 RAID 条带，并注册一个回调；重新平衡完成后，回调会自动执行 `mmvdisk recoverygroup add --recovery-group rg1 --complete-node-add`，为新服务器创建日志组、扩展使用该 RG 的 vdisk set 和文件系统。重新平衡可能持续数小时，期间可以用 `mmvdisk recoverygroup list` 观察。完成后执行一次数据重新均衡，让已有数据也分布到新盘上：

```bash
mmrestripefs fs1 -b          # 大文件系统上耗时很长，会占用 I/O，选业务低峰
```

另一种扩容方式是新建一个恢复组（新的节点类 → `server configure` → `recoverygroup create` → `vdiskset define/create`），再用 `mmvdisk filesystem add --file-system fs1 --vdisk-set <新 vdisk set>` 把新容量加进文件系统。硬件代次不同的服务器只能走这条路。

### 缩容：移除服务器

```bash
# 1. 先把文件系统在该服务器上的 vdisk 迁走（数据迁移，耗时长）
mmvdisk filesystem delete --file-system fs1 --recovery-group rg1 -N sn04
# 2. 从恢复组中删除服务器
mmvdisk recoverygroup delete --recovery-group rg1 -N sn04
# 3. 从集群中删除节点
mmshutdown -N sn04
mmdelnode -N sn04
mmrestripefs fs1 -b
```

缩容前确认剩余节点数仍然满足当前 RAID 码的要求（比如 8+3P 至少需要一定数量的节点才能保持节点级容错），否则 `mmvdisk` 会拒绝执行。

## CES：对外提供 NFS

不能安装 GPFS 客户端的机器可以通过 CES 访问。下面在 owning 集群上开启 NFS（生产上建议使用独立的协议节点，这里为了演示用 sn01、sn02）。

```bash
# 协议服务的共享配置目录，放在一个独立 fileset 里
mmcrfileset fs1 ces-root --inode-space new
mmlinkfileset fs1 ces-root -J /gpfs/fs1/ces-root
mmchconfig cesSharedRoot=/gpfs/fs1/ces-root

# 安装协议包（gpfs.smb、gpfs.nfs-ganesha 等，安装工具包可以自动完成），然后启用 CES 节点
mmchnode --ces-enable -N sn01,sn02
mmces address add --ces-ip 192.168.10.100,192.168.10.101    # 浮动 IP，NFS 客户端连这些地址
mmces service enable NFS
mmces service start NFS -a

# 认证方式：userdefined 表示使用客户端提供的 UID/GID，不对接 AD/LDAP
mmuserauth service create --data-access-method file --type userdefined

# 创建导出
mkdir -p /gpfs/fs1/tenant1/nfs
mmnfs export add /gpfs/fs1/tenant1/nfs \
    --client "192.168.10.0/24(Access_Type=RW,Squash=root_squash)"
mmnfs export list
mmces service list -a
mmces address list
```

客户端挂载：

```bash
mount -t nfs4 192.168.10.100:/gpfs/fs1/tenant1/nfs /mnt/nfs
```

CES IP 会在 CES 节点之间自动漂移。关闭时按相反顺序：`mmnfs export remove` → `mmces service stop/disable NFS` → `mmuserauth service remove --data-access-method file` → `mmchnode --ces-disable`。

## 文件审计日志

审计日志记录谁在什么时候对哪个文件做了什么，满足合规要求，也是追查"谁删了我的数据"的利器。它需要 Data Management Edition；远程挂载的客户端产生的事件，也需要 accessing 集群使用 DME。

```bash
mmaudit fs1 enable --retention 30        # 保留 30 天，默认 365 天
mmaudit all list
# 只记录部分事件，降低开销
mmaudit fs1 update --events CREATE,RENAME,RMDIR,UNLINK
mmaudit fs1 disable
```

开启后会创建一个专门存放审计日志的 fileset（默认 `.audit_log`），日志以 JSON 格式按时间轮转写入，达到一定条数或大小后切换新文件。审计日志本身会占用空间和 I/O，高频小文件负载下要评估开销。

## 调优参数

| 参数 | 作用 | 生效方式 | 调整思路 |
| --- | --- | --- | --- |
| `pagepool` | 数据与元数据缓存，锁定内存 | 重启 GPFS（启用动态 pagepool 的版本可在线调整） | 客户端 16～64 GB；读多写少、重复读的负载收益最大 |
| `maxFilesToCache` | 缓存的 inode 与元数据条目数 | 重启 GPFS | 同时打开的文件多（小文件训练集）时调大；注意 token manager 内存 |
| `maxStatCache` | 只缓存 stat 属性的条目数 | 重启 GPFS | `ls -l`、`find` 频繁时调大 |
| `workerThreads` | 守护进程工作线程数，GPFS 会据此推导多个线程参数 | 重启 GPFS | 存储节点约 3072，客户端约 1024 起步 |
| `nsdMaxWorkerThreads` | NSD 服务器处理 I/O 请求的最大线程数 | 重启 GPFS | 传统 NSD 服务器需要按盘数调整；ECE 服务器由 `mmvdisk` 设置 |
| `maxMBpS` | 预读与写回的吞吐估计值 | 重启 GPFS | 约为节点网络带宽的 2 倍，上限 100000 |
| `verbsRdma` / `verbsPorts` | RDMA 开关与端口 | 重启 GPFS | 见 [RDMA 一课](/learn/rdma) |
| `numaMemoryInterleave` | pagepool 在 NUMA 节点间交错分配 | 重启 GPFS | 多路服务器建议 `yes` |

几个操作要点：

```bash
# -N 指定节点或节点类，不指定则对全集群生效
mmcrnodeclass nc_gpu -N gpu01,gpu02
mmchconfig maxFilesToCache=2M,maxStatCache=2M -N nc_gpu

# -i：立即生效并永久保存；-I：立即生效但不保存（重启后失效，适合临时试验）
# 只有部分参数支持 -i / -I，不支持的参数会提示需要重启
mmchconfig pagepool=32G -N gpu01 -I

mmlsconfig pagepool                        # 配置值
mmdiag --config | grep -i pagepool         # 守护进程中的实际生效值
```

> [!TIP] 调优前先看 waiters
> GPFS 慢的时候，第一件事是看它在等什么：`mmdiag --waiters` 显示本节点上正在等待的线程和原因，`mmlsnode -N waiters -L` 汇总全集群。等待 `RDMA`、`NSD I/O` 说明是网络或盘；等待 `token`、`revoke` 说明是并发冲突；大量等待 `mmfsd` 内部锁则可能是线程数或缓存不够。先定位瓶颈再动参数，参考 [性能分析方法论](/learn/methodology)。

动态 pagepool（截至本文写作时较新的版本支持）允许 pagepool 在上下限之间按需伸缩，对 GPU 与存储混部的节点很有吸引力，参数与限制见 IBM 文档和 SSUG 的相关分享。

## 接入 Kubernetes：GPFS CSI

IBM Storage Scale CSI 驱动由 Operator 部署，通过 GUI 的 REST API 创建 fileset 作为 PV，数据面仍然是节点上已挂载的 GPFS。和 [K8s CSI](/learn/k8s-csi) 一课的通用模型一致：控制器组件调用 REST API 创建卷，节点插件把 fileset 目录 bind mount 进 Pod。

准备工作：

```bash
# 在 GUI 节点上创建 CSI 专用的用户组和用户（上一课已做过）
/usr/lpp/mmfs/gui/cli/mkusergrp CsiAdmin --role csiadmin
/usr/lpp/mmfs/gui/cli/mkuser csiadmin -g CsiAdmin -p '<CSI_PASSWORD>'

# 文件系统要求：开启配额、filesetdf，关闭 perfileset-quota
mmchfs fs1 -Q yes
mmchfs fs1 --filesetdf
mmlsfs fs1 -Q --filesetdf --perfileset-quota

# 验证 REST API 可用，节点状态 HEALTHY
curl -k -u 'csiadmin:<CSI_PASSWORD>' https://gui01.example.com/scalemgmt/v2/cluster
curl -k -u 'csiadmin:<CSI_PASSWORD>' https://gui01.example.com/scalemgmt/v2/nodes

# 给运行 CSI 插件的 K8s 节点打标签
kubectl label node sn01 sn02 sn03 scale=true
```

Secret 和 CSIScaleOperator CR 的骨架如下（集群 ID 来自 `mmlscluster` 输出的 `GPFS cluster id`）：

```yaml title="csi-secret.yaml"
apiVersion: v1
kind: Secret
metadata:
  name: scale-gui-secret
  namespace: ibm-spectrum-scale-csi-driver
  labels:
    product: ibm-spectrum-scale-csi
type: Opaque
stringData:
  username: csiadmin
  password: "<CSI_PASSWORD>"
```

```yaml title="csiscaleoperator.yaml"
apiVersion: csi.ibm.com/v1
kind: CSIScaleOperator
metadata:
  name: ibm-spectrum-scale-csi
  namespace: ibm-spectrum-scale-csi-driver
spec:
  localScaleCluster: "<本地集群 ID>"        # K8s 节点所在的 GPFS 集群
  clusters:
    - id: "<本地集群 ID>"
      secrets: scale-gui-secret
      secureSslMode: false
      restApi:
        - guiHost: gui01.example.com
    # 文件系统来自远程集群时，再添加 owning 集群的条目（它也需要自己的 GUI）
  pluginNodeSelector:
    - key: scale
      value: "true"
  provisionerNodeSelector:
    - key: scale
      value: "true"
  attacherNodeSelector:
    - key: scale
      value: "true"
  tolerations:
    - key: nvidia.com/gpu            # GPU 节点常带的污点，按你的集群实际情况调整
      operator: Exists
      effect: NoSchedule
```

```yaml title="storageclass.yaml"
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: gpfs-fs1
provisioner: spectrumscale.csi.ibm.com
parameters:
  volBackendFs: fs1
reclaimPolicy: Delete
allowVolumeExpansion: true
```

PVC 使用 `ReadWriteMany`，每个 PVC 默认对应一个独立 fileset，容量就是 fileset 配额。驱动还支持依赖 fileset（`filesetType: dependent`）、轻量卷（目录）以及 `version: "2"` 的"一致性组"卷模式等多种形态。CR 字段在不同 CSI 版本间有变化（例如较新版本用 `localScaleCluster` 取代了旧的 `primary` 配置），部署前以对应版本的 [CSI 文档](https://www.ibm.com/docs/en/spectrum-scale-csi)为准。

> [!WARNING] 先想清楚 K8s 节点属于哪个 GPFS 集群
> CSI 驱动围绕 `localScaleCluster` 设计：运行插件的 K8s 节点应该属于同一个 GPFS 集群，远程文件系统通过 `clusters` 里的其他条目访问。本系列的示例拓扑中，GPU 节点属于 owning 集群、管理节点属于 accessing 集群，这种跨集群的混合部署要在测试环境验证，并确认 IBM 支持。另外，CSI 用户的 REST 权限无法限定到单个文件系统，多租户隔离要在 GPFS 层（fileset 授权、配额）完成，一些团队因此只让 CSI 服务平台自己的卷，租户数据通过预先创建的 fileset 以静态 PV 方式挂载。

## 常见问题

| 现象 | 排查方向 |
| --- | --- |
| 节点被 expel，日志有 `lease` / `Expelling` | 守护进程网络丢包或延迟；节点内存不足导致 mmfsd 卡顿；检查 `mmdiag --network` |
| 文件系统挂载不上，`mmlsdisk fs1 -e` 有 `down` 的盘 | NSD 服务器宕机或 RG 降级；恢复后 `mmchdisk fs1 start -a` |
| `df` 显示空间充足但写入 `No space left` | inode 耗尽（`mmdf fs1 -F`、`mmlsfileset fs1 -i`）或达到 fileset 配额 |
| 某些目录 `ls` 极慢 | 单目录文件数过多、多节点同时修改同一目录，token 争用 |
| 远程挂载性能差 | RDMA 未生效（`mmfsadm test verbs status`），或 accessing 节点的 `pagepool` 太小 |
| 升级内核后 GPFS 起不来 | 需要重新 `mmbuildgpl` 构建可移植层 |

主日志在 `/var/adm/ras/mmfs.log.latest`，需要找 IBM 支持时用 `gpfs.snap` 收集诊断包（包含配置和日志，发送前注意脱敏）。

## 卸载

卸载是破坏性操作，所有数据都会丢失。按"从上到下"的顺序拆：

```bash
mmlsmount all -L                         # 确认所有节点（包括远程集群）都已卸载
mmumount all -a
mmvdisk filesystem delete --file-system fs1
mmvdisk vdiskset delete --vdisk-set vs_meta,vs_data
mmvdisk vdiskset undefine --vdisk-set vs_meta,vs_data
mmvdisk recoverygroup delete --recovery-group rg1
mmvdisk server unconfigure --node-class nc_rg1
mmvdisk nodeclass delete --node-class nc_rg1
mmshutdown -a

# 在每个节点上删除软件包与残留目录
rpm -qa | grep ^gpfs | xargs rpm -e       # Ubuntu 用 dpkg -P
rm -rf /var/mmfs /usr/lpp/mmfs /var/adm/ras /tmp/mmfs
```

accessing 集群要先 `mmremotefs delete`、`mmremotecluster delete`，owning 集群再 `mmauth delete` 对应的远程集群。

## 动手练习

1. 在学习集群上创建两个独立 fileset `team-a`、`team-b`，分别设置 1 GB 硬配额，用 `dd` 写满 `team-a`，确认报 `Disk quota exceeded`，再用 root 写一次，观察开启 `enforceFilesetQuotaOnRoot` 前后的区别。
2. 给 `team-a` 设置 `--maxmbs 100` 的 QoS 限速，用 fio 顺序写对比限速前后的带宽，再同时在 `team-b` 上跑 fio，观察两者是否互相影响。
3. 对 `team-a` 创建 fileset 快照，删除里面的一个文件，分别用 `cp` 从 `.snapshots` 找回和用 `mmrestorefs -j` 回滚，比较两种方式的影响范围。
4. 如果有两个学习集群：只把 `team-a` 授权给远程集群（`--fileset root,team-a`），在远程集群上执行 `mmlsfileset` 和 `ls`，验证 `team-b` 不可见。
5. 在 GPFS 变慢时（可以用多个进程往同一个目录里并发创建小文件来制造），运行 `mmdiag --waiters`，记录最常见的等待原因并解释。

## 自测

<details>
<summary>独立 fileset 和依赖 fileset 的区别是什么？多租户场景为什么用独立 fileset？</summary>

独立 fileset 有自己的 inode 空间和 inode 上限，可以做 fileset 级快照、`mmrestorefs -j` 回滚、QoS 和远程 fileset 授权；依赖 fileset 共享父独立 fileset 的 inode 空间，快照随父 fileset。租户需要独立的快照、配额、inode 上限和访问控制，所以用独立 fileset。

</details>

<details>
<summary>多租户场景中，为什么要设置 enforceFilesetQuotaOnRoot=yes，并且限制 root fileset 的 QoS？</summary>

默认情况下 root 用户不受 fileset 配额约束，而容器里的进程常常以 root 运行，不打开这个参数租户就能突破配额。root fileset 对所有被授权的远程集群始终可见，如果有人直接往文件系统根目录写数据，就绕过了租户 fileset 的配额和 QoS；把 root fileset 的 QoS 限到极低，并且不在其中放数据，可以堵住这个口子。

</details>

<details>
<summary>往 ECE 恢复组加入一台新服务器后，文件系统容量是什么时候增加的？之后还需要做什么？</summary>

`mmvdisk recoverygroup add -N` 先把新服务器的盘加入恢复组，并在所有盘之间重新平衡 RAID 条带；重新平衡完成后，回调自动执行 `--complete-node-add`，为新服务器创建日志组、扩展 vdisk set 和文件系统，这时容量才真正增加。之后建议在业务低峰执行 `mmrestripefs fs1 -b`，让已有数据也均衡到新盘上。

</details>

<details>
<summary>mmchconfig 的 -i 和 -I 有什么区别？哪些情况下必须重启 GPFS？</summary>

`-i` 让修改立即生效并永久保存到配置中；`-I` 只立即生效、不保存，重启后恢复原值，适合临时试验。只有部分参数支持在线修改，`pagepool`（未启用动态 pagepool 时）、`verbsRdma`、`verbsPorts`、`workerThreads`、`maxFilesToCache` 等参数需要重启对应节点的 GPFS 才能生效。

</details>

<details>
<summary>快照能代替备份吗？为什么？</summary>

不能。GPFS 快照是写时复制的只读视图，和原数据存在同一组盘、同一个文件系统上。恢复组损毁、文件系统损坏或被删除时，快照会一起丢失。快照适合快速找回误删、误改的文件，备份必须把数据复制到另一套独立的存储上。

</details>

## 参考资料

- [IBM Storage Scale 官方文档](https://www.ibm.com/docs/en/storage-scale)
- [IBM Storage Scale 文档：用快照保护文件数据](https://www.ibm.com/docs/en/storage-scale/5.2.2?topic=scale-protecting-file-data-using-snapshots)
- [IBM Storage Scale 文档：mmcrsnapshot 命令](https://www.ibm.com/docs/en/storage-scale/5.2.3?topic=reference-mmcrsnapshot-command)
- [IBM Storage Scale 文档：mmrestorefs 命令](https://www.ibm.com/docs/en/storage-scale/5.2.3?topic=reference-mmrestorefs-command)
- [IBM Storage Scale 文档：mmqos 命令](https://www.ibm.com/docs/en/storage-scale/5.2.3?topic=reference-mmqos-command)
- [IBM Storage Scale 文档：mmauth 命令（fileset 级远程授权）](https://www.ibm.com/docs/en/storage-scale/5.2.3?topic=reference-mmauth-command)
- [IBM Storage Scale 文档：mmaudit 命令](https://www.ibm.com/docs/en/storage-scale/5.2.2?topic=reference-mmaudit-command)
- [IBM Storage Scale ECE 文档：mmvdisk 命令](https://www.ibm.com/docs/en/storage-scale-ece/5.2.3?topic=commands-mmvdisk-command)
- [IBM Storage Scale CSI 驱动文档](https://www.ibm.com/docs/en/spectrum-scale-csi)
- [IBM/ibm-spectrum-scale-csi：CSI 驱动与 Operator 源码及示例](https://github.com/IBM/ibm-spectrum-scale-csi)
- [Spectrum Scale 用户组：Storage Scale Dynamic Pagepool](https://www.spectrumscaleug.org/wp-content/uploads/2023/08/SSUG23UK-Storage-Scale-Dynamic-Pagepool.pdf)
