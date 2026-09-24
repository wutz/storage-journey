# AI 训练存储选型

一台 8 卡 GPU 服务器的价格抵得上一整排存储节点，所以 AI 平台的存储只有一个 KPI：**别让 GPU 等数据**。可是"别让 GPU 等"具体要多少带宽、多少 IOPS、多大容量？很多团队的做法是先拍脑袋买一套"最快的"，上线后才发现瓶颈根本不在读数据集，而在每半小时一次的 checkpoint；或者反过来，买了几百 GB/s 的全闪集群，训练任务却卡在打开几千万个小文件的元数据上。

这一课先把 AI 负载拆成四种 I/O 模式，教你把"N 张卡、多大模型"换算成带宽和容量数字，再讲业界通用的分层架构，最后客观对比 GPFS / Storage Scale、Weka、VAST Data、DeepSeek 3FS、JuiceFS、CephFS 和 Lustre，给出选型建议。学完你应该能为一个 GPU 集群写出一页"存储需求与选型说明"。

> [!NOTE] 本课需要的环境
> 负载分析和指标换算只需要纸笔（或 Python）。动手练习里的 checkpoint 模拟可以在任意一台带 SSD 的 Linux 虚拟机上用 fio / elbencho 完成。真正的方案 PoC 需要至少 2 台 GPU 节点、3~8 台存储节点和 100G 以上的 RDMA 网络，参考 [RDMA 一课](/learn/rdma) 先把网络测通。

## AI 负载长什么样

"AI 负载"不是一种负载，而是四种截然不同的 I/O 模式叠在一起。选型前先搞清楚你的平台以哪种为主。

### 数据集读取：两种极端

训练时 DataLoader 按 batch 反复读数据集，每个 epoch 把全量数据读一遍，顺序通常是随机打乱的（shuffle）。按样本组织方式分两种极端：

| 类型 | 典型数据 | I/O 特征 | 真正的瓶颈 |
| --- | --- | --- | --- |
| 海量小文件 | ImageNet（128 万张 JPEG，平均约 110 KB）、语音切片、小图标注数据 | 随机读，每个样本一次 `open` + `read` + `close` | **元数据**：每秒几十万次 open/stat |
| 大文件顺序读 | LLM 预训练的 tokenized 数据（几十 GB 一个的 `.bin` / `.arrow`）、WebDataset tar 包、Parquet、视频 | 大块顺序或跨步读，mmap 居多 | **带宽**，而且 LLM 往往连带宽都用不了多少 |

有两点经常被忽略：

- **数据集会被反复读**。第二个 epoch 开始，如果数据集能放进节点内存或本地 NVMe，共享存储几乎没有压力。所以"数据集总大小 vs 单节点缓存容量"比"存储峰值带宽"更能决定架构。
- **小文件问题最好在数据侧解决**。把 128 万个 JPEG 打包成 1000 个 tar 分片（WebDataset、TFRecord、MindRecord 都是这个思路），元数据压力直接降三个数量级。存储选型不应该为一个可以靠数据格式解决的问题买单。

### Checkpoint：周期性的大块突发写

大模型训练动辄几周，期间硬件故障是常态。Meta 在 Llama 3 论文里披露：16384 张 H100 训练 405B 模型的 54 天里，一共发生了 466 次作业中断，其中 419 次是意外故障，平均约 3 小时一次。每次中断都要从最近一次 checkpoint 恢复，所以训练框架会周期性地把全部训练状态写到共享存储。

checkpoint 有多大？混合精度 + Adam 优化器下，每个参数大约要存：

```text
bf16 权重        2 字节
fp32 主权重      4 字节
Adam 一阶矩 m    4 字节
Adam 二阶矩 v    4 字节
─────────────────────────
合计           ≈ 14 字节 / 参数（不同框架在 12~16 之间）
```

70B 参数的模型，一次完整 checkpoint ≈ 70×10⁹ × 14 B = **980 GB**。它的 I/O 特征非常鲜明：

- **突发**：几百到几千个 rank 在同一秒开始写，每个 rank 写自己的分片（N-to-N），写完才能继续训练（同步 checkpoint 时）。
- **大块顺序写**：单个文件几 GB 到几十 GB，块大小以 MB 计。
- **写多读少**：正常情况只写不读；故障恢复时所有 rank 同时读回，也是突发。
- **生命周期短**：一般只保留最近几个，老的删掉或下沉到对象存储。

### 模型加载

推理服务扩容、训练作业启动都要加载模型权重。70B 模型的 bf16 权重约 140 GB，一个推理集群同时拉起 50 个副本，就是 7 TB 的突发顺序读，而且所有副本读的是**同一组文件**。这类负载对聚合读带宽和"热点文件被大量客户端并发读"的能力敏感，本地缓存 + P2P 分发往往比堆存储带宽更划算。

### KV Cache 卸载

大模型推理时，每个 token 的注意力 K/V 向量会缓存下来，避免重复计算，这就是 KV cache。以 Llama-3-70B 为例（80 层、8 个 KV 头、head_dim 128、bf16）：

```text
每 token KV = 2(K和V) × 80 层 × 8 头 × 128 维 × 2 字节 = 327,680 B = 320 KiB
128K 上下文 = 131,072 token × 320 KiB = 40 GiB
```

一个长上下文会话就占掉半张 H100 的显存。把暂时不用的 KV cache 卸载到主机内存、本地 NVMe 甚至分布式存储，等用户下一轮对话再加载回来，比重新做 prefill 便宜得多。这是一种很新的负载：**读多、延迟敏感（直接影响首 token 延迟）、单次读几十 MB 到几 GB**。DeepSeek 开源 3FS 时就把 KVCache 作为核心场景之一，Mooncake、LMCache 等推理框架也在做类似的分层缓存。

把四种负载放在一起：

| 负载 | 读写 | 块大小 | 并发模式 | 最敏感的指标 |
| --- | --- | --- | --- | --- |
| 小文件数据集 | 读 | 10~500 KB | 随机、每样本一个文件 | 元数据 ops/s |
| 大文件数据集 | 读 | MB 级 | 顺序 / mmap | 带宽（通常不高） |
| Checkpoint | 突发写，偶尔突发读 | MB 级 | N 个 rank 同时写 | 聚合写带宽 |
| 模型加载 | 突发读 | MB 级 | 多客户端读同一文件 | 聚合读带宽、热点 |
| KV cache | 读为主 | MB~GB | 随机访问对象 | 延迟 + 带宽 |

## 把需求换算成数字

有观点的说法是：**AI 存储的规格要从 checkpoint 和数据集两头分别算，取大者，再乘余量**。不要从"每卡需要多少 GB/s"这种网上传的经验值开始。

### 数据集读带宽：N × 每卡吞吐

公式很朴素：

```text
所需读带宽 = GPU 数 × 每卡每秒处理样本数 × 平均样本大小
所需元数据 ops = GPU 数 × 每卡每秒样本数 × 每样本文件操作数
```

每卡吞吐要**在真实模型上测**，不要查表。两个对比鲜明的例子：

| 场景 | 计算 | 读带宽 | 文件操作 |
| --- | --- | --- | --- |
| 视觉分类，256 卡，每卡 2500 张/秒，每张 110 KB，一图一文件 | 256 × 2500 × 110 KB | **70.4 GB/s** | 64 万次 open/s |
| LLM 预训练，1024 卡，每卡 4000 token/s，每 token 4 字节 | 1024 × 4000 × 4 B | **16.4 MB/s** | 几乎为零 |

第一行吓人，但只要数据集（ImageNet 约 140 GB）能缓存在本地，第二个 epoch 起共享存储就闲下来了；64 万次 open/s 则应该靠打包成 tar 分片来消灭。第二行说明 **LLM 预训练读数据集几乎不需要带宽**，真正要命的是下面的 checkpoint。视频、多模态训练介于两者之间，而且数据集常常是 PB 级、放不进本地缓存，这时读带宽才真正要按公式硬算。

### Checkpoint 写带宽：大小 ÷ 允许停顿

```text
所需写带宽 = checkpoint 大小 ÷ 允许的停顿时间
允许停顿   = checkpoint 间隔 × 可接受的开销比例
```

还是 70B 模型、1024 卡、每 30 分钟存一次，希望 checkpoint 开销不超过训练时间的 3%：

```text
允许停顿   = 1800 s × 3% = 54 s
所需写带宽 = 980 GB ÷ 54 s ≈ 18.1 GB/s     （聚合写带宽，同步 checkpoint）
平均到节点 = 980 GB ÷ 128 节点 ≈ 7.66 GB/节点，54 s 内写完约 142 MB/s/节点
```

单节点的量很小，难的是 128 个节点**同时**写、存储要接得住 18 GB/s 的聚合突发。

如果框架支持异步 checkpoint（PyTorch DCP 的 `async_save`、Megatron-LM 的异步保存），GPU 只需要几秒把状态拷到主机内存就能继续训练，存储只要在下一次 checkpoint 前写完即可：

```text
异步最低写带宽 = 980 GB ÷ 1800 s ≈ 0.54 GB/s
```

所需带宽直接降了 30 多倍，代价是每个节点要留出几 GB 到几十 GB 的主机内存做暂存。**选存储之前先问训练框架团队能不能开异步 checkpoint**，这可能是整个项目性价比最高的一个问题。

> [!TIP] checkpoint 间隔怎么定
> 间隔越短，故障丢的工作越少（平均丢半个间隔），但写得越频繁。一个粗略的经验：按集群的平均故障间隔来定。1000 卡规模如果平均几小时出一次故障，30 分钟一次比较合理；万卡规模故障更频繁，间隔要缩到 10 分钟级，存储的写带宽要求也随之上升。

### 容量

```text
热层容量 = 活跃数据集 + checkpoint 保留份数 × 单份大小 × 并发大作业数 + home/代码/实验输出
冷层容量 = 原始数据 + 处理后数据集 + 历史 checkpoint / 模型版本
```

checkpoint 容量很容易被低估：4 个 70B 级作业各保留 10 份就是 4 × 10 × 0.98 TB ≈ 39 TB，还没算实验失败后没人删的那些。完整的容量换算放在下一课 [容量与性能规划](/learn/capacity-planning)。

## 分层架构：每一层干自己擅长的事

没有一种介质能同时做到"PB 级、几百 GB/s、便宜"。业界成熟的 AI 平台基本都是三层（加上 GPU 自身的 HBM 和主机内存）：

```text
 GPU 节点 ×128
 ┌────────────────────────────────────┐
 │ HBM            80~192 GB / GPU     │ ← 训练状态、热 KV cache
 │ 主机内存        1~2 TB              │ ← 页缓存、异步 checkpoint 暂存、温 KV cache
 │ 本地 NVMe       4 × 7.68 TB         │ ← 数据集缓存、checkpoint 首落点
 └─────────────────┬──────────────────┘
                   │ 存储网 1~2 × 200G RDMA（IB / RoCE），与计算网分离
 ┌─────────────────▼──────────────────┐
 │ 热层：全闪并行文件系统              │ ← 共享数据集、最近 checkpoint、home
 │ 几百 TB ~ 几 PB，几百 GB/s          │    GPFS / Weka / VAST / 3FS / Lustre
 └─────────────────┬──────────────────┘
                   │ 分层下沉（tiering / AFM / 对象后端）
 ┌─────────────────▼──────────────────┐
 │ 冷层：对象存储数据湖（S3）          │ ← 原始数据、历史 checkpoint、模型仓库
 │ 几 PB ~ EB，HDD + 纠删码            │    Ceph RGW / 商业对象存储 / 公有云
 └────────────────────────────────────┘
```

每一层的设计要点：

- **本地 NVMe 缓存**：最便宜的带宽。4 块 PCIe 4.0 NVMe 就有 20 GB/s 以上的读能力，128 个节点加起来是任何共享存储都给不了的聚合带宽。缺点是容量有限、节点坏了数据就没了，所以只能放"可以重新拉取"的东西。JuiceFS 的缓存盘、Weka/GPFS 的客户端缓存、Fluid/Alluxio 这类数据编排工具都在利用这一层。
- **热层并行文件系统**：提供 POSIX 语义、共享命名空间和高聚合带宽，承接 checkpoint 和放不进本地缓存的数据集。这一层用全闪加 RDMA，贵，所以容量要精打细算。
- **冷层对象存储**：便宜、耐久、容量几乎无限，但延迟高、不支持 POSIX 随机写。数据湖、历史 checkpoint 和模型版本放这里。

层与层之间的数据流动决定了运维工作量。好的方案能自动完成冷热数据下沉：Weka 的分层存储会把小于 1 MB 的文件合并成约 1 MB 的对象、大文件拆成 8~64 MB 的对象上传到 S3，文件最后一次修改后默认 15 分钟开始上传，在 SSD 上默认保留 1 天（截至本文写作时的默认值）；GPFS 有 AFM 和 ILM 策略；JuiceFS 天生就把数据放在对象存储上。没有这类能力的方案，就得自己写脚本搬数据。

> [!PROD] checkpoint 不要全堆在全闪上
> 团队的做法是热层只保留每个作业最近 3~5 份 checkpoint，更老的由定时任务下沉到对象存储，里程碑版本单独打标签长期保存。热层容量报警时，第一个要查的就是有没有人把 checkpoint 间隔设成了 5 分钟又从不清理。

## 方案逐个看

下面按"架构、协议、性能、运维、成本、K8s"几个维度逐个过一遍。商业产品的特性和版本以**截至本文写作时**的公开资料为准，选型前务必向厂商确认最新情况。

### GPFS / IBM Storage Scale

老牌并行文件系统，HPC 和金融行业用了二十多年。核心概念（NSD、仲裁、Token 管理、owning / accessing 多集群）已经在 [GPFS 核心概念](/learn/gpfs-concepts) 讲过，这里只说和 AI 相关的部分：

- **架构**：对称的共享磁盘架构，数据和元数据都条带化到所有 NSD。传统部署接 SAN 存储阵列；ECE（Erasure Code Edition）版本用服务器本地盘做软件纠删码，支持 4+2P、8+3P、16+3P 等，一个恢复组 3~32 个节点。
- **协议**：原生内核客户端（`mmmount`），支持 RDMA（verbs）和 GPUDirect Storage；CES 节点可以额外导出 NFS / SMB / S3。
- **性能**：大文件带宽顶尖，元数据性能好，对小文件也比多数并行文件系统友好。
- **运维**：概念多、参数多、升级要按兼容矩阵走，内核客户端和内核版本绑定。需要专门的人。
- **K8s**：官方 CSI 驱动，支持动态供给和 fileset 级隔离，详见 [GPFS Day-2](/learn/gpfs-day2)。
- **适合**：已有 GPFS 经验的团队、需要多集群共享一个命名空间、对稳定性要求极高的场景。

### Weka

为 NVMe 和高速网络从零设计的分布式文件系统，团队在 AI 集群上有部署经验。

- **架构**：全用户态，绕过内核网络栈用 DPDK 收发包。每台服务器上跑三类进程：drive（管 SSD）、compute（文件系统逻辑与元数据）、frontend（服务 POSIX 客户端），**每个进程独占一个 CPU 核**。团队规划时用的经验是 drive : compute 核数约 1:2，12 块盘的节点就要 12 × (1+2) = 36 个专用核。数据保护是分布式纠删码 N+2 / N+3 / N+4，条带宽度 5~20，并预留一个故障域的热备容量。
- **协议**：专有 POSIX 客户端（`mount -t wekafs`），支持 RDMA 和 GDS；另外可以开 NFS、SMB、S3 协议网关。
- **性能**：小文件、元数据和大文件带宽都很强，延迟低。注意客户端也要独占核：用 `num_cores` 参数给客户端分配 DPDK 专用核，退化到 `net=udp` 共享内核网络的模式性能会差好几倍。
- **运维**：部署高度自动化（官方安装包 + 配置生成工具），但对硬件和网络很挑剔：BIOS 要关省电和超线程、网卡固件要改参数、多网卡要配策略路由。**冗余级别一旦创建就不能改**，规划时要一次定好。
- **K8s**：官方 CSI（`csi-wekafs`），前提是每个 K8s 节点先装好 Weka 客户端。
- **容量换算**：团队规划文档里的公式很典型，值得记住它的每一项：

```text
可用 = 裸容量(TB) × 0.909 × (故障域数 - 热备)/故障域数 × D/(D+P) × (1 - 10% 预留)
例：6 台 × 12 块 × 7.68 TB，3+2 保护
   = 552.96 × 0.909 × 5/6 × 3/5 × 0.9 ≈ 226 TiB
```

其中 0.909 是 TB 到 TiB 的换算（厂商按十进制卖盘，系统按二进制显示），这一项新手最容易漏。

### VAST Data

走的是和传统并行文件系统完全不同的路线。

- **架构**：DASE（Disaggregated Shared-Everything，分离式共享一切）。无状态的 CNode（计算节点，跑协议和文件系统逻辑）通过 NVMe-oF 访问所有 DBox（盘框）里的 SCM 和 QLC 闪存，任意 CNode 都能看到所有盘。写入先落 SCM，再以超宽条带纠删码写入廉价的 QLC，配合基于相似性的数据缩减来压低每 TB 成本。
- **协议**：**用标准协议，不装私有客户端**：NFSv3 / NFSv4.1、NFS over RDMA、多路径 NFS、SMB、S3，块存储走 NVMe/TCP。团队的 K8s 接入里，NFS 挂载选项用 `vers=3,nconnect=16`，靠多条 TCP 连接提升单客户端吞吐。
- **性能**：聚合带宽和容量扩展性好；单客户端性能受限于 NFS 协议栈，用 RDMA 和 nconnect 可以显著改善。
- **运维**：通常以一体化设备交付，厂商远程支持，客户侧运维负担最轻。多租户、配额、QoS 做得完善。
- **K8s**：官方 CSI 同时支持 NFS 和块存储，StorageClass 里可以直接引用租户预建的 viewPolicy（哪些客户端能挂载）和 qosPolicy（带宽 / IOPS 上限），块存储支持快照和克隆。
- **适合**：希望一套存储同时服务训练、推理、数据湖和企业文件共享，且运维人力有限的团队。

### DeepSeek 3FS

DeepSeek 在 2025 年初开源的 Fire-Flyer File System，专门为 AI 训练和推理设计。

- **架构**：四个组件。cluster manager 管成员和配置；metadata service 无状态，元数据存在事务型 KV 数据库 FoundationDB 里；storage service 管本地 SSD，用 CRAQ（Chain Replication with Apportioned Queries）链式复制保证强一致；client 提供两种接入方式。
- **协议**：FUSE 客户端（方便，但有内核往返开销）和 USRBIO 原生用户态接口（零拷贝、环形队列提交，性能最好但应用要改代码）。强依赖 RDMA。
- **性能**：官方 README 报告，180 个存储节点（每节点 2 × 200G IB、16 块 14 TiB NVMe）的集群，在有训练作业背景流量的情况下聚合读吞吐约 6.6 TiB/s；KVCache 场景单客户端读峰值可达 40 GiB/s。设计上偏向大块读，并不以通用 NAS 为目标。
- **运维**：开源、免费，但要自己运维 FoundationDB、RDMA 网络和 3FS 本身，社区和工具链都还年轻，出问题基本要读代码。团队在 K8s 上用阿里云开源的 `kvc-3fs-operator` 管理生命周期，规划要点：元数据与数据可用容量按 4.8 GiB : 1 TiB 配比，元数据至少 3 个节点（可以复用管理节点的独立 SSD），数据节点至少 2 个且要有 RDMA 网卡（可以复用 GPU 节点的本地 NVMe）。
- **适合**：有较强研发能力、愿意贴着代码运维、追求极致性价比的大规模训练 / 推理平台。

### JuiceFS

一个"把对象存储变成 POSIX 文件系统"的开源方案。

- **架构**：元数据和数据分离。元数据放在独立的数据库里（Redis / PostgreSQL / TiKV 等），数据切成块（默认 4 MiB）写入对象存储（S3、Ceph RADOS / RGW、MinIO 等）。客户端本地可以配缓存盘；企业版额外提供跨节点的分布式缓存。
- **协议**：FUSE 客户端、S3 网关、Hadoop SDK。
- **性能**：取决于对象存储和缓存命中率。缓存命中时接近本地 NVMe，冷读受限于对象存储的延迟和带宽；小文件随机写不是强项。`juicefs warmup` 可以在训练开始前把数据集预热到缓存。
- **运维**：组件都是通用软件，门槛低。元数据引擎的选择很关键，团队的经验：Redis 适合 1 亿文件以下、对一致性要求不高的场景；PostgreSQL 撑到 10 亿级；TiKV 适合 100 亿级、强一致的生产环境。对象存储用 Ceph 时，直接走 RADOS 接口比走 RGW 少一层协议转换和负载均衡。
- **K8s**：CSI 成熟，默认的 mount pod 模式把 FUSE 客户端放在独立 Pod 里运行，升级 CSI 驱动不会中断已有挂载，客户端异常退出后也能自动恢复挂载点。
- **适合**：云上训练、已有大容量 HDD 对象存储想"榨出"文件系统能力、预算有限的中小规模集群。

### CephFS

[Ceph RBD 与 CephFS](/learn/ceph-rbd-cephfs) 已经讲过部署。放在 AI 场景下评价：

- **优点**：开源、和 RBD / RGW 共用一套集群、内核客户端成熟、K8s 集成（Ceph CSI、Rook）最完善、团队大多已经会运维。
- **短板**：生产环境基本只能走 TCP（社区有实验性的 RDMA messenger，但几乎没人在生产用），单客户端带宽通常只有几 GB/s；MDS 在海量小文件和高并发元数据下容易成为瓶颈，需要多活 MDS 加目录 pinning 精细调；数据写入要经过副本或 EC，延迟比专用 AI 存储高。
- **适合**：几十卡以内的中小集群、开发实验环境、home 目录和代码存储、作为 JuiceFS 的底层对象存储。

### Lustre（简述）

HPC 领域的开源并行文件系统，大量 Top500 超算在用。架构是 MDS/MDT（元数据）+ OSS/OST（对象存储服务器 / 目标）+ LNet 网络层（原生支持 IB）。大文件带宽极强；小文件历史上是弱项，新版本的 DoM（Data-on-MDT）有所改善。内核客户端和服务端都与内核版本强绑定，运维门槛高，国内多以 DDN 等厂商的商业发行版交付，公有云上有托管版本（如 AWS FSx for Lustre）。

## 方案对比表

| 方案 | 架构 | 客户端 / 协议 | 性能特点 | 运维复杂度 | 成本模型 | K8s 集成 |
| --- | --- | --- | --- | --- | --- | --- |
| GPFS / Storage Scale | 共享磁盘 / ECE 软件纠删码 | 内核客户端，RDMA、GDS；CES 导出 NFS/SMB/S3 | 大文件与元数据都强，稳定 | 高，概念多、内核绑定 | 商业许可（按容量或插槽） | 官方 CSI |
| Weka | 全用户态、DPDK、分布式 EC | 专有客户端，RDMA、GDS；NFS/SMB/S3 网关 | 小文件、元数据、带宽全面强，低延迟 | 中，部署自动化但硬件网络挑剔 | 商业许可，按容量订阅 | 官方 CSI，节点需装客户端 |
| VAST Data | DASE，无状态 CNode + QLC/SCM 盘框 | 标准 NFS（含 RDMA）、SMB、S3、NVMe/TCP | 聚合带宽与容量扩展好，单客户端受限于 NFS | 低，一体机 + 厂商支持 | 商业一体机，数据缩减摊薄成本 | 官方 CSI（NFS + 块），租户 QoS |
| DeepSeek 3FS | FoundationDB 元数据 + CRAQ 链式复制 | FUSE、USRBIO 原生接口，依赖 RDMA | 大块读吞吐极高，面向训练与 KVCache | 高，项目年轻需读代码 | 开源免费，硬件 + 人力 | 社区 operator |
| JuiceFS | 元数据库 + 对象存储 + 客户端缓存 | FUSE、S3 网关、Hadoop SDK | 取决于缓存命中和对象存储 | 低~中，组件通用 | 开源 / 企业版，底层对象存储便宜 | 成熟 CSI |
| CephFS | RADOS + MDS | 内核 / FUSE 客户端，TCP | 通用，单客户端带宽与元数据有上限 | 中~高（已有 Ceph 团队则低） | 开源，硬件 + 人力 | Ceph CSI、Rook |
| Lustre | MDS/MDT + OSS/OST + LNet | 内核客户端，原生 IB | 大文件带宽极强，小文件较弱 | 高，内核绑定 | 开源 / 商业发行版 | 社区与厂商 CSI |

> [!WARNING] 厂商性能数字只能当上限看
> 白皮书里的"每节点 xx GB/s"通常是理想网络、理想块大小、理想客户端数量下测出来的。PoC 时一定要用**自己的**客户端节点、**自己的**网络、**自己的**负载（至少包括 checkpoint 突发写和数据集读）去测，方法见 [基准测试：fio 与 elbencho](/learn/benchmarking)。

## 选型建议

先按下面的决策路径粗筛：

```text
                        你的 GPU 规模？
          ┌─────────────────┼──────────────────┐
       < 64 卡          64 ~ 1000 卡         > 1000 卡
          │                 │                  │
  本地 NVMe +          运维人力充足吗？      有自研存储的能力吗？
  CephFS / JuiceFS     ┌────┴────┐          ┌────┴────┐
  / 全闪 NAS           否        是          否        是
                       │         │          │         │
                    VAST 类   GPFS ECE /   Weka / GPFS  3FS（配合
                    一体机     Weka        / VAST 大规模  商业方案兜底）
```

再加上几条经验法则：

1. **先算 checkpoint，再算数据集**。LLM 平台的存储规格基本由 checkpoint 决定，而异步 checkpoint 能把需求降一个数量级，这件事要在选型之前和算法团队对齐。
2. **本地 NVMe 是最便宜的带宽，一定要用**。GPU 服务器采购时配 4 块以上 NVMe 做缓存，比给共享存储多买几个节点划算得多。
3. **小文件在数据侧解决**。别为了一个能靠打包解决的问题去买元数据性能最强的方案。
4. **公有云上优先托管服务或 JuiceFS**。云上自建并行文件系统要自己处理实例规格、网络、故障替换，性价比通常不如云厂商的托管 Lustre / 并行文件服务，或 JuiceFS + 对象存储。
5. **运维能力是成本的一部分**。开源方案省下的许可费，会以"两个高级工程师 × 若干年"的形式付出去。团队没有能读存储代码的人，就不要把生产训练压在 3FS 上。
6. **K8s 集成要实测**。CSI 驱动能不能动态供给、能不能按租户隔离配额、节点客户端升级是否要排空节点，这些在 PoC 清单里都要有。接入方式回顾 [Kubernetes 存储与 CSI](/learn/k8s-csi)。

> [!PROD] 一份合格的 PoC 清单
> - 单客户端和全部客户端并发下的大文件顺序读写带宽（4 MB 块，`--direct`）
> - checkpoint 模拟：所有节点同时写 N 个大文件，测完成时间
> - 小文件：百万级 4 KB~128 KB 文件的创建 / stat / 读，测 ops/s
> - 故障注入：拔一块盘、关一台存储节点，测性能下降多少、重建多久
> - K8s：CSI 动态供给、扩容、快照、节点客户端升级流程
> - 运维：监控指标是否能接入 Prometheus、告警和日志是否足够定位问题

## 动手练习

1. 用本课的公式为你的（或假想的）平台算一遍：一个 13B 模型在 256 卡上训练，每 20 分钟一次 checkpoint、允许 5% 开销，所需同步写带宽是多少？如果改成异步 checkpoint 呢？
2. 在一台带 SSD 的 Linux 机器上模拟 checkpoint 突发写：用 elbencho 以 8 个线程、每线程写一个 4 GB 文件、4 MB 块、`--direct` 的方式写入，记录总耗时和带宽，再和 `iostat -xm 1` 看到的设备带宽对照。示例命令：`elbencho -w -d -t 8 -n 1 -N 1 -s 4g -b 4m --direct /data/ckpt`。
3. 生成 10 万个 100 KB 的小文件，分别测"逐个读文件"和"打成 tar 包后顺序读"的耗时（记得每次测之前 `echo 3 > /proc/sys/vm/drop_caches`），体会小文件的元数据代价。
4. 按 Llama-3-8B 的配置（32 层、8 个 KV 头、head_dim 128、bf16）算出每 token 的 KV cache 大小，以及 32K 上下文的会话占多少显存。
5. 列出你所在团队的 GPU 集群（或一个公开案例）的存储现状，按本课对比表的六个维度填一行，并写出你认为最大的瓶颈是什么。

## 自测

<details>
<summary>为什么说 LLM 预训练的存储规格主要由 checkpoint 决定，而不是数据集读取？</summary>

LLM 预训练读的是 tokenized 数据，每 token 只有几个字节，即使上千张卡每秒几千 token，总读带宽也只有几十 MB/s。而 checkpoint 要在很短的停顿时间内写完每参数约 14 字节的完整训练状态，70B 模型接近 1 TB，同步写入需要十几到几十 GB/s 的聚合带宽。

</details>

<details>
<summary>70B 模型、每 30 分钟 checkpoint、允许 3% 开销，同步和异步 checkpoint 分别需要多少写带宽？</summary>

checkpoint 大小约 70×10⁹ × 14 B = 980 GB。同步：允许停顿 1800 s × 3% = 54 s，需要 980 / 54 ≈ 18.1 GB/s。异步：只要在下一次 checkpoint 前写完，需要 980 / 1800 ≈ 0.54 GB/s，代价是节点要预留主机内存做暂存。

</details>

<details>
<summary>AI 平台为什么普遍采用"本地 NVMe + 并行文件系统 + 对象存储"三层架构？</summary>

没有一种介质能同时满足容量、带宽和成本。本地 NVMe 提供最便宜的聚合带宽，适合缓存可重新拉取的数据集；全闪并行文件系统提供共享 POSIX 命名空间和高带宽，承接 checkpoint 和放不进本地缓存的数据；对象存储提供低成本、高耐久的海量容量，存原始数据和历史 checkpoint。三层之间靠分层策略自动流动。

</details>

<details>
<summary>海量小文件数据集导致训练读得慢，首先应该怎么处理？</summary>

先在数据侧解决：把小文件打包成大的分片文件（WebDataset tar、TFRecord 等），把每秒几十万次 open/stat 变成少量大文件的顺序读，元数据压力降低几个数量级；同时利用本地 NVMe 或页缓存缓存数据集。只有在这些做完之后仍然不够，才考虑换元数据性能更强的存储。

</details>

<details>
<summary>VAST 和 Weka 在客户端接入方式上最大的区别是什么？这对 K8s 运维有什么影响？</summary>

Weka 使用专有 POSIX 客户端（DPDK、独占 CPU 核），性能高，但每个 K8s 节点都要安装并随版本升级客户端，还要为它预留 CPU 核。VAST 使用标准 NFS（可加 RDMA、nconnect）和 NVMe/TCP，节点只需要系统自带的 NFS 客户端或 nvme-cli，运维简单，但单客户端性能受限于 NFS 协议栈。

</details>

## 参考资料

- [DeepSeek 3FS（GitHub）](https://github.com/deepseek-ai/3FS)
- [3FS 设计说明](https://github.com/deepseek-ai/3FS/blob/main/docs/design_notes.md)
- [kvc-3fs-operator：在 Kubernetes 上运行 3FS](https://github.com/aliyun/kvc-3fs-operator)
- [Fire-Flyer AI-HPC: A Cost-Effective Software-Hardware Co-Design for Deep Learning](https://arxiv.org/abs/2408.14158)
- [The Llama 3 Herd of Models（含训练中断统计）](https://arxiv.org/abs/2407.21783)
- [WEKA 官方文档](https://docs.weka.io/)
- [WEKA CSI 驱动（GitHub）](https://github.com/weka/csi-wekafs)
- [VAST CSI 驱动（GitHub）](https://github.com/vast-data/vast-csi)
- [IBM Storage Scale 文档](https://www.ibm.com/docs/en/storage-scale)
- [JuiceFS 社区版文档](https://juicefs.com/docs/zh/community/introduction/)
- [JuiceFS CSI 驱动文档](https://juicefs.com/docs/zh/csi/introduction/)
- [Ceph 文档：CephFS](https://docs.ceph.com/en/latest/cephfs/)
- [Lustre Wiki](https://wiki.lustre.org/)
- [PyTorch Distributed Checkpoint（DCP）](https://pytorch.org/docs/stable/distributed.checkpoint.html)
- [NVIDIA GPUDirect Storage 文档](https://docs.nvidia.com/gpudirect-storage/)
- [MLPerf Storage 基准](https://mlcommons.org/benchmarks/storage/)
- [elbencho（GitHub）](https://github.com/breuner/elbencho)
