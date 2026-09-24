# Rook：在 Kubernetes 上运行 Ceph

上一课我们把一套"集群外"的 Ceph 通过 ceph-csi 接进了 K8s。Rook 走的是另一条路：干脆把 Ceph 本身也变成 K8s 里的工作负载。MON、MGR、OSD、MDS、RGW 全是 Pod，集群的样子写在一个叫 CephCluster 的 YAML 里，由 Rook Operator 负责把现实调谐（reconcile）成 YAML 描述的样子。

这听上去很美，实际上也确实好用，但它把两个复杂系统叠在了一起：Ceph 出问题时，你要先分清是 Ceph 自己的问题，还是 Operator、调度、网络、节点污点造成的。这一课先讲清楚 Rook 和 cephadm 各自适合什么场景，再用 Helm 部署 Operator、写 CephCluster，依次创建块、文件、对象三种存储并接上 StorageClass，最后讲加盘、换盘、升级和"删了重装"这些 Day-2 操作里最容易踩的坑。

> [!NOTE] 本课需要的环境
> - **K8s 集群**：至少 3 个 worker 节点（MON 需要 3 个才能容忍一个节点故障），每个节点 4 vCPU / 8 GiB 内存以上。用 kubeadm 或 k3s 起几台虚拟机即可，kind 不适合，因为它的节点是容器，没有真正的空盘。
> - **空盘与内核**：每个存储节点至少挂一块**没有分区、没有文件系统签名**的裸盘（虚拟机加一块 20 GiB 虚拟盘就行）；内核要有 `rbd` 和 `ceph` 模块（`modinfo rbd`）。
> - 只有一台机器时，可以用 Rook 仓库里的 `deploy/examples/cluster-test.yaml` 起单节点测试集群，只适合熟悉流程。
>
> K8s 的 Operator、CRD、Helm 概念如果还不熟，先看 [K8s Journey](https://k8s-journey.wutz.workers.dev)。PV、PVC、CSI 的基础见上一课 [Kubernetes 存储与 CSI](/learn/k8s-csi)。

## Rook 和 cephadm：两种运维 Ceph 的方式

两者都能部署和管理 Ceph，而且都用同一个上游的 `quay.io/ceph/ceph` 镜像，区别在"谁来当编排器"：

| 维度 | cephadm | Rook |
| --- | --- | --- |
| 编排器 | Ceph MGR 里的 cephadm 模块，SSH 到各主机起 podman/docker 容器 | K8s Operator，Ceph 守护进程都是 Pod |
| 集群定义 | `ceph orch apply` 命令、service spec YAML | CephCluster 等 CRD，可以放进 Git 走 GitOps |
| 依赖 | 主机上装好容器运行时、Python、时间同步 | 一套能正常工作的 K8s |
| CSI | 另外装 ceph-csi 对接 | 自带 ceph-csi，StorageClass 开箱即用 |
| 故障域 | Ceph 故障只影响 Ceph | K8s 控制面、kubelet、CNI 的故障都会波及存储 |
| 典型场景 | 独立存储集群，同时服务 K8s、虚拟机、裸金属 | 超融合：K8s 节点自带盘，存储只给本集群用 |

团队的选择原则很朴素：

- **存储要服务多个 K8s 集群或者非 K8s 的客户端**，用 cephadm 独立部署，K8s 侧用 ceph-csi 对接。存储集群的生命周期比任何一个 K8s 集群都长，没必要让它跟着 K8s 升级、重建。
- **一个 K8s 集群自带盘、存储只给自己用**（比如 GPU 训练集群里每台机器都有几块 NVMe），用 Rook 做超融合，省一套机器和一套运维体系。
- 用 Rook 的前提是团队**既懂 Ceph 又懂 K8s**。Rook 让部署变简单了，但没有让 Ceph 变简单：Operator 只处理它认识的状态，PG 卡在 `incomplete`、BlueStore 损坏、MDS 反复崩溃，都要进 toolbox 用 `ceph` 命令手工处理，[Ceph Day-2 运维](/learn/ceph-day2)那一课的知识一点都不能少。

## 部署 Operator

Rook 提供两个 Helm chart：`rook-ceph` 部署 Operator 和 CRD，`rook-ceph-cluster` 用来声明集群本身（CephCluster、存储池、StorageClass、toolbox）。本文用 Helm 装 Operator，集群部分直接写 CR，这样每个字段都看得清楚；熟悉之后可以把同样的内容搬进 `rook-ceph-cluster` chart 的 `cephClusterSpec`、`cephBlockPools` 等 values 里。

截至本文写作时 Rook 为 v1.19.x，对应的 Ceph 为 v20（Tentacle）。版本组合以 [Rook 官方文档](https://rook.io/docs/rook/latest-release/) 的兼容性说明为准。

```yaml title="operator-values.yaml"
nodeSelector: { node-role.kubernetes.io/control-plane: "" }   # Operator 放在控制平面
tolerations: [{ operator: Exists, effect: NoSchedule }]

csi:
  provisionerNodeAffinity: "node-role.kubernetes.io/control-plane"   # CSI Controller 插件同上
  provisionerTolerations: [{ operator: Exists, effect: NoSchedule }]
  pluginTolerations: [{ operator: Exists, effect: NoSchedule }]      # Node 插件要能上所有节点

monitoring:
  enabled: true    # 需要集群里已装 prometheus-operator 的 CRD，见下一课
```

```bash
helm repo add rook-release https://charts.rook.io/release && helm repo update
helm install rook-ceph rook-release/rook-ceph \
  --namespace rook-ceph --create-namespace \
  --version v1.19.4 -f operator-values.yaml

kubectl -n rook-ceph get pods   # 只有 rook-ceph-operator：它在等你提交 CephCluster
```

> [!TIP] 装上 kubectl 插件
> `kubectl krew install rook-ceph` 之后就可以用 `kubectl rook-ceph ceph -s`、`kubectl rook-ceph rbd ls replicapool` 直接执行 Ceph 命令，不用每次 exec 进 toolbox。它还封装了 `operator restart`、`rook purge-osd`、`destroy-cluster` 这些常用运维动作，本课后面会反复用到。

团队仓库里 Operator 用的是 Kustomize 加官方 `deploy/examples` 下的 `crds.yaml`、`common.yaml`、`csi-operator.yaml`、`operator.yaml`，再用 patch 改调度。两种方式等价，选一种坚持下去，**不要一会儿 Helm、一会儿 kubectl apply**，否则升级时 CRD 的归属会打架。

## CephCluster：一个 YAML 描述整个集群

先给存储节点打标签，后面用它控制 OSD 落在哪些机器上：`kubectl label node node-a node-b node-c node-role.kubernetes.io/storage=true`。

```yaml title="cluster.yaml"
apiVersion: ceph.rook.io/v1
kind: CephCluster
metadata:
  name: rook-ceph
  namespace: rook-ceph
spec:
  cephVersion:
    image: quay.io/ceph/ceph:v20.2.1
    allowUnsupported: false        # Rook 尚未正式支持该 Ceph 版本时才需要改成 true
  dataDirHostPath: /var/lib/rook   # MON 数据和配置落在宿主机这个目录
  mon: { count: 3, allowMultiplePerNode: false }
  mgr: { count: 2 }
  dashboard: { enabled: true, ssl: true }
  monitoring: { enabled: true }    # 创建 ServiceMonitor，下一课用
  network:
    provider: host                 # 用宿主机网络，性能好、排错直观
    addressRanges:
      public: ["192.168.10.0/24"]
      cluster: ["192.168.20.0/24"] # 只有一张网时删掉这一行
  placement:
    all:                           # 所有 Ceph 组件默认只跑在存储节点上
      nodeAffinity:
        requiredDuringSchedulingIgnoredDuringExecution:
          nodeSelectorTerms:
            - matchExpressions:
                - key: node-role.kubernetes.io/storage
                  operator: Exists
      tolerations: [{ operator: Exists, effect: NoSchedule }]
    mon:                           # MON 单独放到控制平面节点
      nodeAffinity:
        requiredDuringSchedulingIgnoredDuringExecution:
          nodeSelectorTerms:
            - matchExpressions:
                - key: node-role.kubernetes.io/control-plane
                  operator: Exists
  resources:
    osd:
      requests: { cpu: "4", memory: 8Gi }
      limits: { memory: 16Gi }
  storage:
    useAllNodes: true              # 受上面 placement 约束，实际只用存储节点
    useAllDevices: false
    deviceFilter: "^nvme[0-9]+n1$" # 只要 NVMe 盘，系统盘和其他盘不碰
  disruptionManagement:
    managePodBudgets: true
    osdMaintenanceTimeout: 30      # 分钟，节点维护期间保持 noout 的时长
```

```bash
kubectl apply -f cluster.yaml
kubectl -n rook-ceph get cephcluster -w     # PHASE 从 Progressing 到 Ready，HEALTH 为 HEALTH_OK
kubectl -n rook-ceph get pods -o wide       # mon-a/b/c、mgr-a/b、每块盘一个 osd-N
```

几个关键字段展开说：

**mon.count**：生产必须是奇数，一般是 3，大集群 5。`allowMultiplePerNode: false` 保证 MON 分散在不同节点，否则一台机器宕机就可能丢掉多数派。MON 用 `dataDirHostPath` 下的宿主机目录存数据，这个目录在重装时是个大坑，后面细说。

**storage**：决定哪些盘会变成 OSD，是最需要小心的字段。

| 写法 | 效果 | 适合 |
| --- | --- | --- |
| `useAllDevices: true` | 节点上所有空盘都变成 OSD | 实验环境 |
| `deviceFilter: "^nvme[0-9]+n1$"` | 正则匹配设备名 | 机型统一的集群 |
| `nodes: [{name: node-a, devices: [{name: nvme0n1}]}]` | 逐节点逐盘列出 | 机型混杂、需要精确控制 |

Rook 只会使用**空盘**：有分区表、文件系统签名、LVM 标记的盘一律跳过，这是防止误格式化的保护。反过来说，盘上残留一点旧数据，OSD 就不会出现，这是新手最常遇到的"OSD 怎么少了几个"。`nodes` 里的 `name` 必须和节点的 `kubernetes.io/hostname` 标签一致，设备名建议用 `/dev/disk/by-id/...`，重启后 `nvme0n1` 和 `nvme1n1` 可能对调。

**placement**：每个组件的调度规则由 `all` 与组件自己的配置合并而来，组件里写了的属性覆盖 `all`。上面的写法让 OSD、MGR 只跑在存储节点，MON 放在控制平面。超融合集群里这很重要：MON 和 OSD 挤在负载很高的 GPU 节点上，节点一抖 MON 就掉出仲裁。

**resources**：不写 limits 的 OSD 在恢复期间内存能涨到十几 GiB，把同节点的业务 Pod 挤到 OOM；写得太小又会让 OSD 被 OOMKilled，反复重启引发更多恢复。Rook 会根据内存 limit 自动设置 `osd_memory_target`，所以给一个合理的 limit（NVMe OSD 8～16 GiB）比不写好得多。

**network.provider: host**：OSD 直接用宿主机网卡，性能和 cephadm 部署一样，客户端也能从 K8s 集群外访问。默认的 Pod 网络模式多了一层 CNI 封装，性能差一截，而且集群外的客户端访问不了。

> [!PROD] 超融合集群一定要留资源
> 一台 8 块 NVMe 的节点就是 8 个 OSD，按每个 4 核 / 16 GiB 上限算，Ceph 要吃掉 32 核和 128 GiB。给 kubelet 配好 `system-reserved` / `kube-reserved`，业务 Pod 的 requests 算账时把这部分扣掉，否则节点压力一大，kubelet 驱逐 Pod 时第一个倒下的可能是 OSD。

## 三种存储与各自的 StorageClass

Rook 用 CRD 声明存储池，然后自带的 ceph-csi 负责供给卷。和上一课手工对接相比，最大的区别是驱动名带了 `rook-ceph.` 前缀，Secret 由 Rook 自动生成，`clusterID` 就是 CephCluster 所在的命名空间。

### 块存储：CephBlockPool

```yaml title="block.yaml"
apiVersion: ceph.rook.io/v1
kind: CephBlockPool
metadata: { name: replicapool, namespace: rook-ceph }
spec:
  failureDomain: host      # 副本分布在不同主机
  replicated: { size: 3 }
  deviceClass: ssd
---
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata: { name: rook-ceph-block }
provisioner: rook-ceph.rbd.csi.ceph.com
parameters:
  clusterID: rook-ceph
  pool: replicapool
  imageFormat: "2"
  imageFeatures: layering
  csi.storage.k8s.io/fstype: ext4
  csi.storage.k8s.io/provisioner-secret-name: rook-csi-rbd-provisioner
  csi.storage.k8s.io/provisioner-secret-namespace: rook-ceph
  csi.storage.k8s.io/controller-expand-secret-name: rook-csi-rbd-provisioner
  csi.storage.k8s.io/controller-expand-secret-namespace: rook-ceph
  csi.storage.k8s.io/node-stage-secret-name: rook-csi-rbd-node
  csi.storage.k8s.io/node-stage-secret-namespace: rook-ceph
reclaimPolicy: Delete
allowVolumeExpansion: true
```

想用纠删码（Erasure Code）省空间时，RBD 需要两个池：一个副本池存镜像元数据，一个 EC 池存数据，StorageClass 里 `pool` 写副本池，再加 `dataPool: <EC 池>`。EC 池的 CR 把 `replicated` 换成 `erasureCoded: { dataChunks: 4, codingChunks: 2 }`。注意 `failureDomain: host` 时 k+m 个分片必须落在不同主机上，4+2 至少要 6 台存储节点，8+3 至少 11 台。EC 的原理和取舍见[副本与纠删码](/learn/replication-ec)。

> [!TIP] Ceph 20 的 EC 优化
> 从 Ceph 20.2 开始 EC 池有一组新的优化（部分写、小对象读性能大幅改善），团队在新集群上默认打开：`ceph config set global osd_pool_default_flag_ec_optimizations true`，并把 `osd_pool_erasure_code_stripe_unit` 设为 `16384`。这两项只影响之后新建的池，建池前设置。

### 文件存储：CephFilesystem

```yaml title="filesystem.yaml"
apiVersion: ceph.rook.io/v1
kind: CephFilesystem
metadata: { name: shared-ceph, namespace: rook-ceph }
spec:
  metadataPool:
    replicated: { size: 3 }
    deviceClass: ssd              # 元数据池一定放 SSD
  dataPools:
    - name: replicated            # 实际池名为 shared-ceph-replicated
      failureDomain: host
      replicated: { size: 3 }
  preserveFilesystemOnDelete: true
  metadataServer:
    activeCount: 1
    activeStandby: true
    resources:
      requests: { memory: 32Gi }
      limits: { memory: 32Gi }
---
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata: { name: rook-cephfs }
provisioner: rook-ceph.cephfs.csi.ceph.com
parameters:
  clusterID: rook-ceph
  fsName: shared-ceph
  pool: shared-ceph-replicated
  csi.storage.k8s.io/provisioner-secret-name: rook-csi-cephfs-provisioner
  csi.storage.k8s.io/provisioner-secret-namespace: rook-ceph
  csi.storage.k8s.io/controller-expand-secret-name: rook-csi-cephfs-provisioner
  csi.storage.k8s.io/controller-expand-secret-namespace: rook-ceph
  csi.storage.k8s.io/node-stage-secret-name: rook-csi-cephfs-node
  csi.storage.k8s.io/node-stage-secret-namespace: rook-ceph
reclaimPolicy: Delete
allowVolumeExpansion: true
```

MDS 的内存是 CephFS 能否撑住大量文件的关键。Rook 会根据 MDS 的内存 limit 自动推算 `mds_cache_memory_limit`，所以直接把 limit 设大即可。团队的估算是每个缓存的元数据条目约 3 KB，千万级文件的工作集至少给 32 GiB。`dataPools` 里的池在 Ceph 里的真实名字是 `<文件系统名>-<池名>`，StorageClass 的 `pool` 要写全名，写错了 PVC 会一直 Pending。

### 对象存储：CephObjectStore

```yaml title="object.yaml"
apiVersion: ceph.rook.io/v1
kind: CephObjectStore
metadata: { name: s3-rgw, namespace: rook-ceph }
spec:
  metadataPool:
    failureDomain: host
    replicated: { size: 3 }
    deviceClass: ssd
  dataPool:
    failureDomain: host
    erasureCoded: { dataChunks: 4, codingChunks: 2 }
  preservePoolsOnDelete: true      # 删 CR 时保留池，防手滑
  gateway:
    port: 8080
    instances: 2
    resources: { requests: { memory: 1Gi }, limits: { memory: 2Gi } }
---
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata: { name: rook-ceph-bucket }
provisioner: rook-ceph.ceph.rook.io/bucket
reclaimPolicy: Delete
parameters:
  objectStoreName: s3-rgw
  objectStoreNamespace: rook-ceph
```

对象存储没有"挂载"，所以这里的 StorageClass 不走 CSI，而是给 ObjectBucketClaim（OBC）用的。应用申请一个桶：

```yaml title="obc.yaml"
apiVersion: objectbucket.io/v1alpha1
kind: ObjectBucketClaim
metadata: { name: demo-bucket, namespace: default }
spec:
  generateBucketName: demo
  storageClassName: rook-ceph-bucket
```

Rook 会建桶和一个专属用户，并在同一命名空间生成**同名的 ConfigMap 和 Secret**：ConfigMap 里有 `BUCKET_HOST`、`BUCKET_NAME`、`BUCKET_PORT`，Secret 里有 `AWS_ACCESS_KEY_ID`、`AWS_SECRET_ACCESS_KEY`，应用用 `envFrom` 直接引用即可。

需要一个长期使用、带配额的用户时，用 CephObjectStoreUser：

```yaml title="user.yaml"
apiVersion: ceph.rook.io/v1
kind: CephObjectStoreUser
metadata: { name: rgw-default-user, namespace: rook-ceph }
spec:
  store: s3-rgw
  displayName: default user
  quotas: { maxBuckets: 100, maxSize: 100G }
  capabilities: { user: "*", bucket: "*" }
```

```bash
kubectl apply -f object.yaml -f user.yaml
S=rook-ceph-object-user-s3-rgw-rgw-default-user    # rook-ceph-object-user-<store>-<user>
kubectl -n rook-ceph get secret $S -o jsonpath='{.data.AccessKey}' | base64 -d; echo
kubectl -n rook-ceph get secret $S -o jsonpath='{.data.SecretKey}' | base64 -d; echo
kubectl -n rook-ceph get svc rook-ceph-rgw-s3-rgw  # 集群内访问地址，端口 8080
```

集群外访问要给 `rook-ceph-rgw-s3-rgw` 配 Ingress 或 LoadBalancer，域名写成 `s3.example.com` 这样的形式。RGW 的桶策略、多站点等内容见 [RGW 对象网关](/learn/ceph-rgw)。

## toolbox 与 Dashboard

toolbox 是一个装好了 `ceph`、`rbd`、`rados` 命令、自动配置好密钥的 Pod：

```bash
kubectl apply -f https://raw.githubusercontent.com/rook/rook/v1.19.4/deploy/examples/toolbox.yaml
kubectl -n rook-ceph exec -it deploy/rook-ceph-tools -- bash
# 进去之后就是熟悉的 Ceph 世界：ceph -s、ceph osd tree、ceph df、ceph osd pool ls detail
```

用 `rook-ceph-cluster` chart 部署时把 `toolbox.enabled` 设为 `true` 即可。装了 krew 插件的话，`kubectl rook-ceph ceph -s` 效果一样。

Dashboard 的用户名是 `admin`，密码在 Secret 里，port-forward 之后浏览器打开 `https://localhost:8443`：

```bash
kubectl -n rook-ceph get secret rook-ceph-dashboard-password -o jsonpath='{.data.password}' | base64 -d; echo
kubectl -n rook-ceph port-forward svc/rook-ceph-mgr-dashboard 8443:8443
```

> [!WARNING] 在 toolbox 里改配置要想清楚归属
> `ceph config set`、`ceph osd pool set` 这类命令在 toolbox 里都能执行，而且立即生效。但凡是 CR 里有对应字段的配置（池的副本数、MON 数量、MGR 模块），都应该改 CR，否则下一次 reconcile 时 Operator 会把你的手工修改改回去。CR 管不到的调优参数（比如 mClock 恢复参数）才用 `ceph config set`，并且记到文档或 CephCluster 的 `cephConfig` 字段里。

## Day-2：加盘、换盘、升级

### 加盘和加节点

**加节点**时给新节点打上 `node-role.kubernetes.io/storage=true` 标签，Operator 会自动在上面跑 `rook-ceph-osd-prepare-<node>` Job，符合条件的盘变成 OSD。**给现有节点加盘**时，Operator 不一定马上察觉，执行 `kubectl rook-ceph operator restart`（或删掉 Operator Pod）触发一次完整 reconcile。用 `nodes` 精确列盘的集群，要先编辑 CephCluster 把新盘加进去。

OSD 没按预期出现时，看 prepare Job 的日志，它会写明每块盘为什么被跳过：

```bash
kubectl -n rook-ceph get pods -l app=rook-ceph-osd-prepare
kubectl -n rook-ceph logs rook-ceph-osd-prepare-node-a-xxxxx -c provision | grep -i -E 'skipping|excluded|available'
```

常见原因：盘上有旧分区或文件系统签名（清盘方法见下文）、`deviceFilter` 没匹配上、盘上有别的 Ceph 集群的 OSD 数据（日志里出现 `belonging to a different ceph cluster`）。最后一种情况确认是废弃数据后，可以在 CephCluster 设 `cleanupPolicy.wipeDevicesFromOtherClusters: true`，让 Rook 自动清掉。这个开关很危险，用完关掉。

新 OSD 加入后会触发数据重平衡。想让恢复快一点，可以临时调高 mClock 的限制：`ceph config set osd osd_mclock_override_recovery_settings true`，再 `ceph config set osd osd_max_backfills 16`，恢复完改回来。

### 替换故障 OSD

一块盘坏了，OSD Pod 进入 `CrashLoopBackOff`，Ceph 在 OSD 被标记 `down` 一段时间后把它标记为 `out` 并开始恢复数据。等 `ceph -s` 显示数据恢复完成（没有 `degraded`），再动手：

```bash
# 1. 停 Operator，防止它在你操作时把 OSD 拉起来
kubectl -n rook-ceph scale deploy rook-ceph-operator --replicas=0
# 2. 停掉故障 OSD 的 Deployment
kubectl -n rook-ceph scale deploy rook-ceph-osd-3 --replicas=0
kubectl rook-ceph ceph osd down osd.3
# 3. 从 Ceph 里彻底移除（可以一次传多个，逗号分隔）
kubectl rook-ceph rook purge-osd 3 --force
# 4. 用 nodes 精确列盘的集群，把坏盘从 CephCluster 里删掉
kubectl -n rook-ceph edit cephcluster rook-ceph
# 5. 物理换盘后恢复 Operator，它会在新盘上建新 OSD
kubectl -n rook-ceph scale deploy rook-ceph-operator --replicas=1
```

`rook-ceph-osd-3` 的 Deployment 如果还在，purge 之后手工删掉；Operator 的副本数改回你部署时的值。下线整台节点也是同一套流程：先 `kubectl drain <node> --ignore-daemonsets --delete-emptydir-data`，对该节点上的每个 OSD 做一遍上面的第 2～3 步，最后去掉节点的 storage 标签。

> [!NOTE] 节点维护不需要 purge
> 只是重启或者短时间维护节点，直接 `kubectl drain` 即可。Rook 的 PodDisruptionBudget 会保证一次只动一个故障域，并在该故障域上设置 `noout`，`osdMaintenanceTimeout`（默认 30 分钟）之内 Ceph 不会开始搬数据。节点超过这个时间还没回来，恢复才会启动。

### 升级 Rook 与 Ceph

Rook 和 Ceph 是**两次独立的升级**，不要同时做：

```bash
kubectl rook-ceph ceph -s        # 升级前：集群健康，所有 PG active+clean
# 1. 升级 Rook（一次只跨一个小版本，例如 1.18 → 1.19，先读官方升级说明）
helm repo update
helm upgrade rook-ceph rook-release/rook-ceph -n rook-ceph \
  --version v1.19.4 -f operator-values.yaml
# 2. 观察各组件是否滚动到新版本
kubectl -n rook-ceph get deploy -l rook_cluster=rook-ceph \
  -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.metadata.labels.rook-version}{"\t"}{.metadata.labels.ceph-version}{"\n"}{end}'
# 3. Rook 升级稳定后，再升级 Ceph：改镜像版本
kubectl -n rook-ceph patch cephcluster rook-ceph --type merge \
  -p '{"spec":{"cephVersion":{"image":"quay.io/ceph/ceph:v20.2.x"}}}'
```

Ceph 升级时 Operator 会按 MON → MGR → OSD → MDS → RGW 的顺序逐个重启，每重启一个 OSD 前会用 `ok-to-stop` 确认不会让数据不可用。大集群的 OSD 升级可能持续几个小时，期间 `ceph -s` 出现短暂的 `degraded` 是正常的，出现 `inactive` 或者长时间卡在同一个 OSD 就要停下来看 Operator 日志。

> [!PROD] 镜像和 chart 都放进内部仓库
> 生产集群不要直接从公网拉镜像。把 `quay.io/ceph/ceph`、Rook 和 ceph-csi 的镜像同步到 `registry.example.com` 这样的内部仓库，在 values 和 CephCluster 里改镜像地址。否则升级到一半，某个节点因为公网限速拉不到镜像，整个滚动就卡住了。

### 删了重装：最容易翻车的操作

实验环境经常要推倒重来，而 Rook 的数据分散在三个地方：K8s 里的 CR 和 Secret、每台节点的 `dataDirHostPath`、每块 OSD 盘。清任何一处不彻底，新集群都会出问题：

- `/var/lib/rook` 里留着旧 MON 的数据：新集群的 MON 读到旧的 fsid 和密钥，组不成仲裁，`mon-a` 一直 CrashLoop。
- OSD 盘上留着旧数据：新集群的 prepare Job 跳过这些盘，OSD 一个都不出来。
- CR 的 finalizer 卡住：命名空间一直 `Terminating`。

正确的拆除顺序：

```bash
# 1. 先删用存储的东西：业务 PVC、StorageClass、OBC
# 2. 用插件一键拆除（会提示输入确认字符串 yes-really-destroy-cluster）
kubectl rook-ceph destroy-cluster
# 3. 卸载 Operator
helm uninstall rook-ceph -n rook-ceph
```

然后在**每一个**存储节点上清理宿主机目录和盘：

```bash
rm -rf /var/lib/rook

DISK=/dev/nvme1n1                 # 再三确认，不要写成系统盘
sgdisk --zap-all $DISK
dd if=/dev/zero of=$DISK bs=1M count=100 oflag=direct,dsync
blkdiscard $DISK                  # SSD / NVMe 执行，机械盘跳过
partprobe $DISK

# 清掉残留的 ceph LVM 映射
ls /dev/mapper/ceph-* 2>/dev/null | xargs -I% -- dmsetup remove %
rm -rf /dev/ceph-*
```

> [!DANGER] 生产集群不存在"重装"
> 上面每一条命令都是不可逆的。生产环境里 Rook 出问题，要做的是排查 Operator 和 Ceph，而不是删掉重来。为了防止误删，保持 CephCluster 的 `cleanupPolicy.confirmation` 为空、存储池 CR 设置 `preservePoolsOnDelete` / `preserveFilesystemOnDelete`，并用 RBAC 限制谁能删 `rook-ceph` 命名空间里的 CR。

## 几个常见问题

**PG 自动伸缩不工作**：`ceph osd pool autoscale-status` 没有输出，通常是因为 `.mgr` 池用的 CRUSH 规则和其他池不一致（比如其他池都指定了 deviceClass，`.mgr` 用的是默认规则），autoscaler 发现规则重叠就放弃了。把 `.mgr` 池也改到同一类规则上：`ceph osd pool set .mgr crush_rule <规则名>`。

**MON 频繁掉出仲裁**：先看 MON 所在节点的负载和时钟同步。超融合节点上 MON 和训练任务抢资源时，最有效的办法就是像前面那样把 MON 挪到控制平面节点。另外，Operator 日志量很大，只关注 `ERROR` 和 `failed`，CR 的 `status` 比日志更直观：`kubectl -n rook-ceph get cephcluster rook-ceph -o jsonpath='{.status.message}'`。

更系统的 Ceph 排障方法见 [Ceph 故障排查闯关](/learn/ceph-troubleshooting)。

## 动手练习

1. 在 3 台虚拟机的 K8s 集群上，每台加一块 20 GiB 空盘，按本文用 Helm 装 Operator、提交 CephCluster，直到 `ceph -s` 显示 `HEALTH_OK`。记录从提交 CR 到集群 Ready 花了多久，各阶段分别起了哪些 Pod。
2. 故意在其中一块盘上 `mkfs.ext4`，然后重启 Operator，在 osd-prepare 日志里找到它被跳过的原因；按本文方法清盘后再重启 Operator，确认 OSD 出现。
3. 创建 `rook-ceph-block` 和 `rook-cephfs` 两个 StorageClass，分别用 PVC 挂进 Pod；在 toolbox 里用 `rbd ls replicapool` 和 `ceph fs subvolume ls shared-ceph csi` 找到对应的镜像和子卷。
4. 创建一个 OBC，用它生成的 Secret 和 ConfigMap 配置 `aws` CLI 或 `s3cmd`，上传一个文件。
5. 对一个存储节点执行 `kubectl drain`，在 toolbox 里用 `ceph health detail` 观察该主机上的 `noout` 标志和 `ceph -s` 的变化；`uncordon` 后确认集群恢复。

## 自测

<details>
<summary>一个团队有两套 K8s 集群和一批虚拟机都要用块存储，应该用 Rook 还是 cephadm？为什么？</summary>

用 cephadm 部署独立的 Ceph 集群，两套 K8s 用 ceph-csi 对接，虚拟机直接用 librbd。存储要服务多个客户端时，它的生命周期应该独立于任何一个 K8s 集群；用 Rook 会让所有客户端都依赖其中一套 K8s 的控制面和节点健康。

</details>

<details>
<summary>新加了一台存储节点，打了标签，但上面一个 OSD 都没有出现，按什么顺序排查？</summary>

先看该节点的 `rook-ceph-osd-prepare-<node>` Pod 有没有运行（没有的话检查 placement 和污点）；再看它的 `provision` 容器日志，确认每块盘被跳过的原因，常见的是盘上有旧分区或文件系统签名、`deviceFilter` 不匹配、盘上有其他 Ceph 集群的数据。处理后重启 Operator 触发 reconcile。

</details>

<details>
<summary>在 toolbox 里执行 `ceph osd pool set replicapool size 2` 之后，过了一会儿副本数又变回了 3，为什么？</summary>

`replicapool` 由 CephBlockPool CR 管理，CR 里写的是 `replicated.size: 3`。Operator 在下一次 reconcile 时会把实际状态调谐回 CR 声明的状态。CR 里有对应字段的配置应该改 CR。

</details>

<details>
<summary>实验集群删掉重装后，新集群的 mon-a 一直 CrashLoopBackOff，最可能的原因是什么？</summary>

各节点 `dataDirHostPath`（默认 `/var/lib/rook`）下留着旧集群的 MON 数据和密钥，新 MON 用旧数据启动，和新集群的配置对不上。需要在每个节点上删除该目录，同时清理所有 OSD 盘后再重新部署。

</details>

## 参考资料

- [Rook 官方文档](https://rook.io/docs/rook/latest-release/)
- [Rook：Helm Charts 概览](https://rook.io/docs/rook/latest-release/Helm-Charts/helm-charts/)
- [Rook：CephCluster CRD](https://rook.io/docs/rook/latest-release/CRDs/Cluster/ceph-cluster-crd/)
- [Rook：Ceph Block Pool CRD](https://rook.io/docs/rook/latest-release/CRDs/Block-Storage/ceph-block-pool-crd/)
- [Rook：Ceph Filesystem CRD](https://rook.io/docs/rook/latest-release/CRDs/Shared-Filesystem/ceph-filesystem-crd/)
- [Rook：Ceph Object Store CRD](https://rook.io/docs/rook/latest-release/CRDs/Object-Storage/ceph-object-store-crd/)
- [Rook：OSD 管理（加盘、移除 OSD）](https://rook.io/docs/rook/latest-release/Storage-Configuration/Advanced/ceph-osd-mgmt/)
- [Rook：升级指南](https://rook.io/docs/rook/latest-release/Upgrade/rook-upgrade/)
- [Rook：清理集群](https://rook.io/docs/rook/latest-release/Getting-Started/ceph-teardown/)
- [kubectl-rook-ceph 插件](https://github.com/rook/kubectl-rook-ceph)
- [Ceph 文档：cephadm](https://docs.ceph.com/en/latest/cephadm/)
