# Kubernetes 存储与 CSI

前面几课你已经能用 cephadm 搭起一套 Ceph，手工 `rbd map`、`mount -t ceph` 都很熟了。可是在 Kubernetes 里，没有人会登录节点去 map 一块盘：用户只写一张 PVC，几秒后 Pod 里就出现了一个挂好的目录。这几秒里，谁在 Ceph 上建了镜像？谁在节点上 map 了设备、格式化、挂载？出问题时该看哪个容器的日志？

这一课站在存储工程师的角度把这条链路拆开：先用最少的篇幅讲清 PV / PVC / StorageClass 这套"申请单"模型，然后重点讲 CSI（Container Storage Interface，容器存储接口）的架构和挂载路径，给出常见方案的选型表，最后用 Helm 把 ceph-csi-rbd 对接到一套外部 Ceph 集群，完成动态供给、扩容和快照，并整理存储相关的排错套路。学完后你能独立把一套已有存储接进 K8s，并且在 PVC 卡住时知道从哪里下手。

> [!NOTE] 本课需要的环境
> - **概念与 local-path 部分**：任意一个 K8s 集群，[kind](https://kind.sigs.k8s.io/) 单机即可。
> - **ceph-csi 部分**：一套 K8s 集群（1 个控制平面 + 至少 1 个 worker）和一套外部 Ceph 集群。Ceph 用[用 cephadm 部署 Ceph 集群](/learn/cephadm-deploy)里搭的 3 节点集群最好；只有一台虚拟机时可以 `cephadm bootstrap --single-host-defaults` 起一个单机版凑合练。
> - **网络**：K8s 所有节点必须能访问 Ceph 的 public 网络：MON 的 3300/6789 端口和 OSD 的 6800–7300 端口。kind 节点是容器，一般走宿主机 NAT 也能通。
>
> 如果你对 Pod、Deployment、Helm 还不熟，先去姊妹教程 [K8s Journey](https://k8s-journey.wutz.workers.dev) 补一下，尤其是其中的"存储：Volume、PV、PVC 与 StorageClass"一课。

## 为什么要有 PV / PVC / StorageClass

如果 Pod 的 YAML 里直接写 Ceph 的 monitor 地址和密钥，应用就和某一套存储绑死了，换一个集群就得改一遍应用。Kubernetes 把"谁提供存储"和"谁使用存储"拆成三个对象：

| 对象 | 谁创建 | 存储工程师的理解 |
| --- | --- | --- |
| PersistentVolume（PV） | 管理员手工建，或 CSI 自动建 | 一块已经存在的卷：一个 RBD 镜像、一个 CephFS 子卷、一个 NFS 目录 |
| PersistentVolumeClaim（PVC） | 应用开发者 | 申请单："我要 10Gi、单节点读写" |
| StorageClass（SC） | 管理员 | 一类存储的模板：用哪个驱动、哪个池、什么参数 |

```text
开发者:  Pod ──▶ PVC（10Gi, RWO, storageClassName: block-ceph）
                    │ 1:1 绑定
管理员:              ▼
         StorageClass ──external-provisioner 调 CreateVolume──▶ PV ──▶ Ceph 上的 RBD 镜像
```

PVC 和 PV 是一对一绑定的。动态供给时 PV 由驱动自动生成，名字形如 `pvc-<uuid>`；静态供给时管理员先建好 PV，PVC 按容量和访问模式去"认领"。

### 访问模式

访问模式（Access Mode）描述的是**能被多少个节点同时挂载**，不是多少个 Pod：

| 模式 | 缩写 | 含义 | 典型后端 |
| --- | --- | --- | --- |
| ReadWriteOnce | RWO | 同一时刻只能被一个**节点**读写挂载（同节点多个 Pod 可以共享） | RBD、local、Longhorn |
| ReadOnlyMany | ROX | 多个节点只读挂载 | CephFS、NFS、从快照克隆的只读卷 |
| ReadWriteMany | RWX | 多个节点同时读写 | CephFS、NFS、JuiceFS、GPFS |
| ReadWriteOncePod | RWOP | 整个集群只允许一个 **Pod** 挂载（1.29 起 GA） | 需要驱动支持，ceph-csi 支持 |

另一个字段 `volumeMode` 决定交给 Pod 的是文件系统（默认 `Filesystem`，驱动负责 mkfs 和挂载）还是裸块设备（`Block`）。

> [!WARNING] 块存储上的 RWX 不是你以为的那样
> ceph-csi-rbd 允许 `volumeMode: Block` + RWX，这是给 KubeVirt 虚拟机热迁移这类场景用的。在上面建 ext4 再让两个节点同时挂载，文件系统会被写坏。需要共享文件就用 CephFS / NFS，别拿块设备硬凑。

### 回收策略

PVC 删除后，PV 和后端数据怎么处理由回收策略（Reclaim Policy）决定：

- **Delete**（动态供给默认）：PV 连同后端的 RBD 镜像、CephFS 子卷一起删掉。
- **Retain**：PV 变成 `Released` 状态，后端数据保留，需要管理员手工处理。想重新绑定，要编辑 PV 删掉 `spec.claimRef`。（Recycle 已废弃，不要用。）

> [!PROD] 重要数据用 Retain，并且改 PV 而不是只改 SC
> StorageClass 的 `reclaimPolicy` 只影响**之后**新建的 PV。已有 PV 可以直接改：
> `kubectl patch pv <pv-name> -p '{"spec":{"persistentVolumeReclaimPolicy":"Retain"}}'`
> 团队的经验是：业务方"清理一下命名空间"是删数据的头号原因，核心业务的 PV 一律改成 Retain，删 PVC 之后至少还有一次反悔的机会。

### 绑定时机：Immediate 与 WaitForFirstConsumer

`volumeBindingMode` 决定 PVC 什么时候被满足：

- **Immediate**：PVC 一创建就立刻建卷、绑定。适合任何节点都能访问的网络存储（Ceph、NFS）。
- **WaitForFirstConsumer**：等到使用它的 Pod 被调度到某个节点后，再结合该节点的拓扑建卷。本地盘必须用这个模式，否则卷建在 A 节点、Pod 却被调度到 B 节点，永远起不来。多可用区的网络存储也应该用它，让卷和 Pod 落在同一个区。

用 WaitForFirstConsumer 时，PVC 在 Pod 出现前一直是 `Pending`，事件里写着 `waiting for first consumer to be created before binding`，这是正常现象，不是故障。

## CSI 架构

早年各家存储的驱动代码直接写在 Kubernetes 源码里（in-tree），加一个功能要等 K8s 发版。CSI 把接口标准化成一组 gRPC 调用，驱动做成普通容器单独发布。现在 in-tree 的 RBD、CephFS 插件都已移除，**所有新接入都走 CSI**。

### 三组 gRPC 服务

| 服务 | 主要调用 | 在哪里运行 | 对应的 Ceph 操作（以 RBD 为例） |
| --- | --- | --- | --- |
| Identity | `GetPluginInfo`、`Probe` | Controller 和 Node 都有 | — |
| Controller | `CreateVolume` / `DeleteVolume`、`ControllerPublishVolume`、`CreateSnapshot`、`ControllerExpandVolume` | 集群里跑几个副本的 Deployment | `rbd create`、`rbd rm`、`rbd snap create`、`rbd resize` |
| Node | `NodeStageVolume` / `NodeUnstageVolume`、`NodePublishVolume` / `NodeUnpublishVolume`、`NodeExpandVolume` | 每个节点一个 DaemonSet Pod | `rbd map` + `mkfs` + `mount`、bind mount、`resize2fs` |

规律很简单：**Controller 只和存储的管理面打交道，不碰节点；Node 插件在节点上做 map 和 mount**。Controller 插件挂了，已经在跑的 Pod 不受影响，只是新建、删除、扩容卷会卡住；Node 插件挂了，该节点上新 Pod 挂不上卷。

### sidecar：K8s 与 CSI 之间的翻译官

CSI 驱动本身不认识 Kubernetes 的 API 对象。社区提供了一组通用的 sidecar 容器，负责 watch K8s 对象，再把事件翻译成 gRPC 调用，通过 Unix socket 发给同一个 Pod 里的驱动容器：

```text
             ┌──────────── Controller 插件（Deployment，2~3 副本，选主）──────────────┐
  PVC ─────▶ │ external-provisioner ──CreateVolume/DeleteVolume──┐                   │
  VolumeAttachment ─▶ external-attacher ──ControllerPublish───────┤                   │
  PVC 扩容 ─▶ │ external-resizer ──ControllerExpandVolume─────────┼─▶ csi.sock ─▶ 驱动容器 ──▶ Ceph MON/OSD
  VolumeSnapshotContent ─▶ external-snapshotter(csi-snapshotter) ─┘                   │
             └───────────────────────────────────────────────────────────────────────┘

             ┌──────────── Node 插件（DaemonSet，每个节点一个）──────────────────────┐
  kubelet ─▶ │ node-driver-registrar：把驱动 socket 注册给 kubelet                   │
  (直接调)  ─▶ csi.sock ─▶ 驱动容器：NodeStage / NodePublish（rbd map、mkfs、mount）  │
             │ livenessprobe：健康检查                                              │
             └───────────────────────────────────────────────────────────────────────┘
```

- **external-provisioner** watch PVC，发现 SC 指向自己的驱动时调 `CreateVolume`，成功后创建 PV。
- **external-attacher** watch `VolumeAttachment`。这个对象由 kube-controller-manager 在 Pod 调度后创建，表示"卷 X 要 attach 到节点 Y"。NFS、CephFS 这类驱动在 `CSIDriver` 里声明 `attachRequired: false`，这一环直接跳过。
- **external-resizer** 处理扩容，`csi-snapshotter` 处理快照（还需要一个集群级的 `snapshot-controller`，后面讲）。
- Node 侧没有 watch：**kubelet 直接调用**驱动。`node-driver-registrar` 只负责告诉 kubelet 驱动的 socket 在 `/var/lib/kubelet/plugins/<driver>/csi.sock`。

```bash
kubectl get csidriver              # 集群里注册了哪些驱动，是否需要 attach
kubectl get csinode <node> -o yaml # 某个节点上已注册的驱动
kubectl get volumeattachment       # 哪个 PV attach 到了哪个节点
```

### 两段式挂载：NodeStage 与 NodePublish

这是存储工程师最该搞清楚的部分，排查"挂载超时"基本都在这里。一块 RBD 卷交给 Pod，节点上要经历两次挂载：

```text
1. NodeStageVolume（每个节点每个卷只做一次）
   rbd map pool/csi-vol-xxx          →  /dev/rbd0
   首次使用时 mkfs.ext4 /dev/rbd0
   mount /dev/rbd0  /var/lib/kubelet/plugins/kubernetes.io/csi/rbd.csi.ceph.com/<volumeHandle 的哈希>/globalmount

2. NodePublishVolume（每个 Pod 做一次）
   mount --bind  .../globalmount  →  /var/lib/kubelet/pods/<pod-uid>/volumes/kubernetes.io~csi/<pv-name>/mount

3. 容器运行时再把 .../mount 绑定挂载到容器里的 mountPath
```

为什么要分两段？因为块设备在一个节点上只应该 map 和挂载一次。同节点上多个 Pod 共用一个 RWO 卷时，Stage 只做一次，每个 Pod 各做一次轻量的 bind mount。卸载顺序反过来：最后一个 Pod 走了才执行 `NodeUnstageVolume`（umount + `rbd unmap`）。

在节点上用 `findmnt | grep -E 'globalmount|kubernetes.io~csi'` 和 `lsblk | grep rbd` 就能看到这两层挂载。

> [!NOTE] 路径不要硬编码
> 较老的 K8s 版本 staging 路径是 `.../kubernetes.io/csi/pv/<pv-name>/globalmount`，写排查脚本时用 `findmnt` 按设备名找。kubelet 数据目录不是 `/var/lib/kubelet` 的发行版，CSI chart 的 `kubeletDir` 参数要同步修改，否则挂载会莫名失败。

## 选型：先问三个问题

1. **访问模式**：单 Pod 读写（块存储即可），还是多 Pod 共享（必须文件存储）？
2. **冗余由谁负责**：存储层多副本，还是应用自己复制（etcd、PostgreSQL 主从、Kafka、MinIO）？
3. **存储在集群内还是集群外**：已经有独立的 Ceph / NAS / 并行文件系统，还是要在 K8s 节点上自建？

| 方案 | 类型 / 访问模式 | 冗余 | 适用场景 | 主要坑 |
| --- | --- | --- | --- | --- |
| local-path / local PV | 本地目录或盘，RWO | 无 | 自带复制的数据库、缓存、构建目录 | 节点坏了数据就没了；local-path 不限容量 |
| NFS CSI | NFS，RWX | 取决于 NAS | 已有高可用 NAS、开发环境 | 自建单点 NFS 重启时客户端卡 D 状态 |
| Ceph CSI RBD | 块，RWO / RWOP | Ceph 副本或 EC | 集群外已有 Ceph，通用块存储 | 节点宕机后 Multi-Attach、watcher 残留 |
| Ceph CSI CephFS | 文件，RWX | Ceph 副本或 EC | 共享数据集、模型文件、多副本 Web 静态资源 | MDS 内存与小文件性能 |
| Longhorn | 块，RWO（RWX 走内置 NFS） | 卷级多副本 | 中小规模、没有专职存储团队、想要 UI | 性能明显低于 Ceph，大集群副本重建慢 |
| JuiceFS CSI | 文件，RWX | 依赖底层对象存储 | 云上、已有对象存储、读多写少的 AI 数据集 | Mount Pod 重启导致挂载点失效 |
| GPFS CSI | 并行文件系统，RWX | GPFS 自身 | AI 训练、HPC 高吞吐 | 商业授权，接入前准备工作多 |

团队的经验法则：

- 数据库、消息队列这类**自带复制**的应用，优先用本地 NVMe（local-path 或 local PV），高可用交给应用自己的 Operator。底下再叠一层三副本 Ceph，一次写入变成 6 份，延迟也翻倍。
- 集群外已有 Ceph，就用 **ceph-csi** 直连；要在 K8s 节点上自建 Ceph，用 [Rook](/learn/rook-ceph)。两者用的是同一套 ceph-csi 驱动，只是驱动名和 Secret 的来源不同。
- RWX 需求先想清楚是不是真的需要"多个节点同时写同一批文件"。很多所谓共享需求其实是"多个 Pod 读同一份模型"，用对象存储加本地缓存往往更便宜。

local PV 和 local-path 都用本地盘，但机制不同：**local PV**（`provisioner: kubernetes.io/no-provisioner`）由管理员为每块盘手工建 PV、写死 `nodeAffinity`，一盘一卷，容量真实，适合"整块 NVMe 给一个数据库实例"；**local-path** 在节点目录下为每个 PVC 动态建子目录，方便但**不限容量**，一个 Pod 能写满整块盘。两者的 SC 都必须用 `WaitForFirstConsumer`。

## 实战：用 Helm 对接外部 Ceph（ceph-csi-rbd）

下面把一套 cephadm 部署的外部 Ceph 接入 K8s，提供名为 `block-ceph` 的 StorageClass。截至本文写作时 ceph-csi chart 为 3.14.x，请以 [ceph-csi 发布页](https://github.com/ceph/ceph-csi/releases) 为准，并确认它支持你的 Ceph 和 K8s 版本。

### 第一步：在 Ceph 侧建池和用户

在 Ceph 的管理节点上执行：

```bash
# 建一个 RBD 池并初始化
ceph osd pool create kubernetes
rbd pool init kubernetes

# 为 K8s 建一个最小权限的用户，只能访问 kubernetes 池
ceph auth get-or-create client.kubernetes \
  mon 'profile rbd' \
  osd 'profile rbd pool=kubernetes' \
  mgr 'profile rbd pool=kubernetes'

# 记下三样东西：fsid（即 clusterID）、MON 地址、用户密钥
ceph mon dump
ceph auth get-key client.kubernetes; echo
```

`ceph mon dump` 第一行是 fsid，下面每行是一个 MON 的 v2（3300）和 v1（6789）地址。下文假设 fsid 为 `3f1e8c2a-6e4e-11ef-82d6-0131360f7c6f`，三个 MON 在 `192.168.10.11-13`。

> [!TIP] 不要用 client.admin
> 很多教程图省事直接把 admin 密钥放进 K8s Secret。任何能读这个命名空间 Secret 的人都拿到了整个 Ceph 集群的 root 权限，可以删掉所有池。每个 K8s 集群、每个租户建一个只能访问自己池的用户，泄露了也只影响一个池。

### 第二步：安装驱动

```yaml title="values.yaml"
csiConfig:
  - clusterID: 3f1e8c2a-6e4e-11ef-82d6-0131360f7c6f   # ceph fsid
    monitors:
      - 192.168.10.11:6789
      - 192.168.10.12:6789
      - 192.168.10.13:6789
  # 对接多套 Ceph 时在这里继续追加，StorageClass 里用 clusterID 区分

provisioner:
  replicaCount: 2
  nodeSelector: { node-role.kubernetes.io/control-plane: "" }   # Controller 插件放控制平面，和业务隔离
  tolerations: [{ operator: Exists, effect: NoSchedule }]

nodeplugin:
  # Node 插件必须能跑到所有要挂卷的节点上，包括带污点的 GPU 节点
  tolerations: [{ operator: Exists, effect: NoSchedule }]
```

```bash
helm repo add ceph-csi https://ceph.github.io/csi-charts && helm repo update
helm install ceph-csi-rbd ceph-csi/ceph-csi-rbd \
  --namespace ceph-csi-rbd --create-namespace \
  --version 3.14.0 -f values.yaml

kubectl -n ceph-csi-rbd get pods -o wide   # provisioner 里是驱动 + 各 sidecar；nodeplugin 每节点一个
```

Node 插件用宿主机网络，并且需要节点内核有 `rbd` 模块（驱动会自动 `modprobe`）。精简版系统或者自编内核记得确认 `modinfo rbd` 有输出。

### 第三步：Secret 与 StorageClass

```yaml title="block-ceph.yaml"
apiVersion: v1
kind: Secret
metadata:
  name: csi-rbd-secret
  namespace: ceph-csi-rbd
stringData:
  userID: kubernetes              # 不带 client. 前缀
  userKey: <ceph auth get-key client.kubernetes 的输出>
---
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: block-ceph
provisioner: rbd.csi.ceph.com
parameters:
  clusterID: 3f1e8c2a-6e4e-11ef-82d6-0131360f7c6f
  pool: kubernetes
  # 用 EC 池存数据时：pool 写副本池（存镜像元数据），另加 dataPool: <EC 池>
  imageFeatures: layering
  csi.storage.k8s.io/fstype: ext4
  csi.storage.k8s.io/provisioner-secret-name: csi-rbd-secret
  csi.storage.k8s.io/provisioner-secret-namespace: ceph-csi-rbd
  csi.storage.k8s.io/controller-expand-secret-name: csi-rbd-secret
  csi.storage.k8s.io/controller-expand-secret-namespace: ceph-csi-rbd
  csi.storage.k8s.io/node-stage-secret-name: csi-rbd-secret
  csi.storage.k8s.io/node-stage-secret-namespace: ceph-csi-rbd
reclaimPolicy: Delete
allowVolumeExpansion: true
volumeBindingMode: Immediate
```

三组 Secret 参数分别给三个角色用：provisioner 建删镜像、controller-expand 扩容、node-stage 在节点上 map。用同一个最小权限用户就够了。

`imageFeatures: layering` 是最保守的选择，老内核也能 map。内核 5.x 以上可以加 `exclusive-lock,object-map,fast-diff,deep-flatten`，快照和 `rbd du` 会快很多，但要先确认所有节点内核都支持，否则会在 map 时报 `feature set mismatch`。

### 第四步：验证

```yaml title="rbd-test.yaml"
apiVersion: v1
kind: PersistentVolumeClaim
metadata: { name: rbd-pvc }
spec:
  accessModes: [ReadWriteOnce]
  storageClassName: block-ceph
  resources: { requests: { storage: 1Gi } }
---
apiVersion: v1
kind: Pod
metadata: { name: rbd-demo }
spec:
  containers:
    - name: app
      image: busybox:1.36
      command: ["sh", "-c", "sleep infinity"]
      volumeMounts: [{ name: data, mountPath: /data }]
  volumes:
    - name: data
      persistentVolumeClaim: { claimName: rbd-pvc }
```

```bash
kubectl apply -f block-ceph.yaml -f rbd-test.yaml
kubectl get pvc rbd-pvc                       # STATUS 应为 Bound
kubectl exec rbd-demo -- df -h /data

# 回到 Ceph 侧，能看到驱动建的镜像，以及挂载它的客户端
rbd ls kubernetes                             # csi-vol-<uuid>
rbd status kubernetes/csi-vol-<uuid>          # Watchers: 那台 K8s 节点的 IP

# 在线扩容：改 PVC 容量，文件系统会自动扩展
kubectl patch pvc rbd-pvc -p '{"spec":{"resources":{"requests":{"storage":"2Gi"}}}}'
kubectl exec rbd-demo -- df -h /data

# 把 PV 名和 RBD 镜像名对上，是日后排障最常用的一步
kubectl get pv $(kubectl get pvc rbd-pvc -o jsonpath='{.spec.volumeName}') \
  -o jsonpath='{.spec.csi.volumeAttributes.imageName}{"\n"}'
```

> [!NOTE] CephFS 几乎一样
> 换成 `ceph-csi/ceph-csi-cephfs` chart，StorageClass 的 provisioner 为 `cephfs.csi.ceph.com`，参数里把 `pool` 换成 `fsName`（`ceph fs ls` 查看）。每个 PVC 在 CephFS 里对应一个子卷（subvolume），在 Ceph 侧用 `ceph fs subvolume ls <fs> csi` 查看。团队在 Node 插件上加了 `kernelmountoptions: "recover_session=clean"`，客户端被 MDS 驱逐后能自动重连，而不是一直报 `Permission denied` 直到重启 Pod。CephFS 的原理见 [RBD 块存储与 CephFS 文件系统](/learn/ceph-rbd-cephfs)。

## 快照：VolumeSnapshot

CSI 快照是标准 API，但 CRD 和 `snapshot-controller` **不随 K8s 默认安装**，要单独部署 [external-snapshotter](https://github.com/kubernetes-csi/external-snapshotter)（截至本文写作时为 v8.x）：

```bash
kubectl apply -k "https://github.com/kubernetes-csi/external-snapshotter/client/config/crd?ref=v8.2.0"
kubectl apply -k "https://github.com/kubernetes-csi/external-snapshotter/deploy/kubernetes/snapshot-controller?ref=v8.2.0"
kubectl get crd | grep snapshot.storage.k8s.io
```

三个对象和 SC / PVC / PV 一一对应：**VolumeSnapshotClass** 像 StorageClass，决定用哪个驱动、什么参数打快照；**VolumeSnapshot** 像 PVC，是用户的申请"给 rbd-pvc 打一个快照"；**VolumeSnapshotContent** 像 PV，是实际存在的快照，指向 Ceph 里的快照或克隆。

```yaml title="snapshot.yaml"
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshotClass
metadata: { name: block-ceph-snap }
driver: rbd.csi.ceph.com
parameters:
  clusterID: 3f1e8c2a-6e4e-11ef-82d6-0131360f7c6f
  csi.storage.k8s.io/snapshotter-secret-name: csi-rbd-secret
  csi.storage.k8s.io/snapshotter-secret-namespace: ceph-csi-rbd
deletionPolicy: Delete
---
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshot
metadata: { name: rbd-pvc-snap1 }
spec:
  volumeSnapshotClassName: block-ceph-snap
  source: { persistentVolumeClaimName: rbd-pvc }
---
# 从快照恢复成一个新 PVC（容量不能小于源 PVC）
apiVersion: v1
kind: PersistentVolumeClaim
metadata: { name: rbd-pvc-restore }
spec:
  storageClassName: block-ceph
  dataSource: { name: rbd-pvc-snap1, kind: VolumeSnapshot, apiGroup: snapshot.storage.k8s.io }
  accessModes: [ReadWriteOnce]
  resources: { requests: { storage: 2Gi } }
```

`kubectl apply -f snapshot.yaml` 之后用 `kubectl get volumesnapshot` 观察，`READYTOUSE` 变成 `true` 才算完成。

几点生产经验：

- **快照不是备份**。它和源数据在同一个 Ceph 集群里，池被误删、集群故障时一起消失。要备份得把数据复制到另一套存储（例如 Velero + 对象存储）。
- **快照是崩溃一致的**，相当于在那一刻拔了电源。数据库打快照前应先让它刷盘或者冻结写入（`fsfreeze`，或者用数据库自己的备份工具）。
- ceph-csi 的 RBD 快照在 Ceph 内部是"快照 + 克隆"实现的，克隆链过深时驱动会在后台做 flatten，会占用集群 I/O。不要对一个卷高频打几百个快照，按保留策略定期清理。

## 排错：三类最常见的问题

先记住一个通用顺序：**`kubectl describe` 看事件 → 对应 sidecar / 驱动容器的日志 → 节点上的 kubelet 日志与 dmesg → 存储侧状态**。

### PVC 一直 Pending

先 `kubectl describe pvc <pvc>` 看事件：

| 事件关键字 | 原因 | 处理 |
| --- | --- | --- |
| `waiting for first consumer` | SC 是 WaitForFirstConsumer，还没有 Pod 使用 | 正常；创建 Pod 后再看 |
| `no persistent volumes available ... and no storage class is set` | 没写 `storageClassName`，集群也没有默认 SC | 指定 SC，或给某个 SC 加 `storageclass.kubernetes.io/is-default-class: "true"` |
| `waiting for a volume to be created by the external provisioner` 持续很久 | provisioner 没工作或者调用 Ceph 失败 | 看 provisioner 日志 |
| `failed to provision volume ... rados: ret=-1, Operation not permitted` | Ceph 用户权限不对或密钥错 | 核对 Secret 与 `ceph auth get client.kubernetes` |
| `... context deadline exceeded` | Controller 插件连不上 MON | 从 provisioner 所在节点 `nc -zv <mon> 3300`；检查 clusterID 和 monitors 配置 |

```bash
# provisioner Pod 里有多个容器，要用 -c 指定
kubectl -n ceph-csi-rbd logs deploy/ceph-csi-rbd-provisioner -c csi-provisioner --tail=50
kubectl -n ceph-csi-rbd logs deploy/ceph-csi-rbd-provisioner -c csi-rbdplugin --tail=50
```

> [!TIP] 先看 sidecar，再看驱动
> `csi-provisioner` 的日志告诉你"调没调、调的结果是什么"，`csi-rbdplugin` 的日志告诉你"驱动跟 Ceph 说了什么"。sidecar 日志里完全没有这个 PVC，说明问题在 K8s 这边（SC 名字写错、provisioner 名字不匹配、选主卡住）；有调用但报错，再去驱动日志里找具体的 Ceph 错误码。

### Multi-Attach error

事件为 `FailedAttachVolume  Multi-Attach error for volume "pvc-..." Volume is already exclusively attached to one node`：RWO 卷还挂在旧节点上，新 Pod 却被调度到了另一个节点。最常见的两个场景：

1. **Deployment 滚动更新**：默认 `RollingUpdate` 先起新 Pod 再停旧 Pod，新旧 Pod 在不同节点时必然冲突。使用 RWO 卷的单副本 Deployment 应该用 `strategy.type: Recreate`，或者干脆改成 StatefulSet。
2. **节点宕机**：旧节点失联，kubelet 没法执行卸载，`VolumeAttachment` 一直留着。K8s 不敢贸然 detach，因为那个节点可能只是网络断了，实际还在写盘，强行在另一个节点 map 会导致两边同时写，文件系统损坏。

节点宕机的正确处理：

```bash
kubectl get volumeattachment | grep <pv-name>     # 确认 attach 在哪个节点
# 先用 IPMI / 云控制台确认旧节点真的已经关机，再打 out-of-service 污点（1.28 起 GA），
# K8s 会强制删除上面的 Pod 并 detach 卷
kubectl taint nodes <node> node.kubernetes.io/out-of-service=nodeshutdown:NoExecute
# 节点修好重新上线后去掉污点
kubectl taint nodes <node> node.kubernetes.io/out-of-service=nodeshutdown:NoExecute-
```

> [!DANGER] 不要直接删 VolumeAttachment 或者 finalizer
> 在旧节点还活着的情况下手工删 `VolumeAttachment`、强删 Pod，新节点会 map 同一个 RBD 镜像并挂载，两个节点同时写一个 ext4，结果就是文件系统损坏。先确认旧节点已经下电，再用 out-of-service 污点这条官方路径。必要时在 Ceph 侧把旧客户端加入黑名单：`ceph osd blocklist add <旧节点IP>`。

### 挂载超时

事件 `FailedMount  Unable to attach or mount volumes: ... timed out waiting for the condition` 只说明"没挂上"，真正的原因在 Node 插件和节点上：

```bash
kubectl -n ceph-csi-rbd logs <该节点的 nodeplugin Pod> -c csi-rbdplugin --tail=100
# 登录该节点
journalctl -u kubelet --since "10 min ago" | grep -i -E 'mount|csi'
dmesg -T | grep -i -E 'rbd|libceph|ceph'
rbd showmapped 2>/dev/null || ls /sys/bus/rbd/devices/
```

常见原因：

- **节点到 OSD 网络不通**：MON 通了不代表 OSD 通，`dmesg` 里会有 `libceph: osdN ... connect error`。检查防火墙是否放行 6800–7300。
- **镜像被别的客户端占用**：`rbd status` 看到的 watcher 不是当前节点。多半是上一个节点宕机残留，处理方式同上。
- **首次挂载在 mkfs**：几 TiB 的卷第一次挂载要格式化，时间可能超过 kubelet 的等待时间，下一轮重试就好了，不要急着删 Pod。
- **fsGroup 递归改权限**：Pod 设置了 `securityContext.fsGroup`，kubelet 每次挂载都会递归 `chown` 整个卷。卷里有几百万个文件时这一步能跑十几分钟。在 Pod 上加 `fsGroupChangePolicy: OnRootMismatch`，只有根目录权限不对时才递归。
- **CephFS 客户端被驱逐**：日志里有 `evicted` 或挂载点报 `Permission denied`，用前文的 `recover_session=clean` 挂载选项，或参考 [Ceph 故障排查闯关](/learn/ceph-troubleshooting)。

另外，PVC 一直 `Terminating` 通常是还有 Pod 在用（`pvc-protection` finalizer 在保护它）；PV 删不掉且日志里有 `rbd image ... is still being used`，说明某个节点还 map 着镜像，用 `rbd status` 找到 watcher 所在节点清掉残留挂载。

## 动手练习

1. 在 kind 里执行 `kubectl get sc standard -o yaml` 和 `kubectl get csidriver`，回答：kind 默认的 local-path 是不是 CSI 驱动？它的 `volumeBindingMode` 是什么？创建一个 PVC 但不创建 Pod，观察 PVC 的状态和事件。
2. 按本文把 ceph-csi-rbd 接到你的 Ceph 集群，创建 PVC 和 Pod 后，到 Pod 所在节点上用 `findmnt` 找出 globalmount 和 Pod 目录两个挂载点，确认它们指向同一个 `/dev/rbdX`；再到 Ceph 侧用 `rbd status` 确认 watcher 的 IP。
3. 往卷里写一个文件，打 VolumeSnapshot，再删掉这个文件；从快照恢复出新 PVC，挂到另一个 Pod 里确认文件还在。在 Ceph 侧用 `rbd ls -l kubernetes` 观察快照和克隆出的镜像。
4. 用一个副本数为 1、使用 RWO 卷、策略为 `RollingUpdate` 的 Deployment，通过 `nodeSelector` 迫使新 Pod 调度到另一个节点，复现 Multi-Attach error；然后改成 `Recreate` 再试一次。
5. 把一个 PV 的回收策略改成 Retain，删掉 PVC，观察 PV 状态和 Ceph 里的镜像。

## 自测

<details>
<summary>ReadWriteOnce 的"Once"指的是一个 Pod 还是一个节点？如何做到真正只允许一个 Pod？</summary>

指一个**节点**。同一节点上的多个 Pod 可以同时挂载同一个 RWO 卷。要限制为单个 Pod，使用 `ReadWriteOncePod`（1.29 起 GA），前提是驱动支持。

</details>

<details>
<summary>一块 RBD 卷挂进 Pod，节点上会发生哪两次挂载？为什么要分两段？</summary>

`NodeStageVolume` 把镜像 `rbd map` 成 `/dev/rbdX`、必要时 mkfs，并挂载到节点级的 `.../globalmount` 目录，每个节点每个卷只做一次；`NodePublishVolume` 再把 globalmount bind mount 到 `/var/lib/kubelet/pods/<uid>/volumes/kubernetes.io~csi/<pv>/mount`，每个 Pod 做一次。分两段是因为块设备在一个节点上只应该 map 和挂载一次，同节点多个 Pod 共享时只需要轻量的 bind mount。

</details>

<details>
<summary>节点宕机后 Pod 迁移时报 Multi-Attach error，为什么 K8s 不自动把卷挂到新节点？正确的处理步骤是什么？</summary>

因为 K8s 无法区分"节点真的挂了"和"节点只是网络断了但还在写盘"。如果贸然在新节点挂载，可能出现两个节点同时写同一个块设备，导致文件系统损坏。正确做法是先通过带外管理确认旧节点已经下电，然后给节点打 `node.kubernetes.io/out-of-service=nodeshutdown:NoExecute` 污点，让 K8s 强制删除 Pod 并 detach 卷；必要时在 Ceph 侧把旧节点加入 blocklist。

</details>

<details>
<summary>一个挂载了大容量卷的 Pod 每次重启都要十几分钟才 Running，kubelet 日志显示卡在挂载阶段，最可能的原因是什么？</summary>

Pod 设置了 `fsGroup`，kubelet 每次挂载时都会递归修改卷内所有文件的属组，文件数量很多时非常慢。在 Pod 的 `securityContext` 里加 `fsGroupChangePolicy: OnRootMismatch`，只在根目录权限不匹配时才递归修改。

</details>

## 参考资料

- [Kubernetes 文档：持久卷](https://kubernetes.io/zh-cn/docs/concepts/storage/persistent-volumes/)
- [Kubernetes 文档：存储类](https://kubernetes.io/zh-cn/docs/concepts/storage/storage-classes/)
- [Kubernetes 文档：卷快照](https://kubernetes.io/zh-cn/docs/concepts/storage/volume-snapshots/)
- [Kubernetes 文档：节点非体面关闭](https://kubernetes.io/zh-cn/docs/concepts/cluster-administration/node-shutdown/)
- [CSI 规范（container-storage-interface/spec）](https://github.com/container-storage-interface/spec/blob/master/spec.md)
- [Kubernetes CSI 开发者文档：Sidecar 容器](https://kubernetes-csi.github.io/docs/sidecar-containers.html)
- [Ceph 文档：Block Devices and Kubernetes](https://docs.ceph.com/en/latest/rbd/rbd-kubernetes/)
- [ceph-csi 项目](https://github.com/ceph/ceph-csi)
- [external-snapshotter](https://github.com/kubernetes-csi/external-snapshotter)
- [csi-driver-nfs](https://github.com/kubernetes-csi/csi-driver-nfs)
- [Longhorn 文档](https://longhorn.io/docs/)
- [JuiceFS CSI 驱动文档](https://juicefs.com/docs/zh/csi/introduction/)
- [IBM Storage Scale CSI 文档](https://www.ibm.com/docs/en/scalecsi)
