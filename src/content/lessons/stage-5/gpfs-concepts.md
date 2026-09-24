# GPFS / Storage Scale 核心概念

前面学 Ceph 时，我们看到的是"对象存储打底、上面再长出块和文件"的设计。GPFS 走的是另一条路：它从第一天起就是一个**并行文件系统**——成百上千个客户端同时读写同一个文件、同一个目录，每个客户端都直接和所有存储节点并行传数据，还要保持完整的 POSIX 语义。这种设计让它在 HPC 界统治了二十多年，也让它成为今天很多 GPU 集群的训练存储。

这一课不装软件，专门把概念讲透：GPFS 的历史与定位、集群里各种节点角色、NSD、文件系统与存储池、块大小与子块、分布式锁与 token、仲裁、多集群的 owning / accessing 模型，以及 ECE（Erasure Code Edition）与传统共享存储部署的区别。下一课 [GPFS ECE 部署](/learn/gpfs-deploy)会把这些概念一个个落到命令上。

> [!NOTE] 关于许可与版本
> IBM Storage Scale 是商业软件。学习可以用免费的 **Developer Edition**（不能用于生产，有容量上限，截至本文写作时为 12 TB），它包含 Data Management Edition 的大部分功能，但不含 ECE。本文命令基于截至本文写作时的 5.2.x 版本，产品名称、默认值和限制经常变化，一切以 [IBM Storage Scale 官方文档](https://www.ibm.com/docs/en/storage-scale)为准。

## 历史与定位

| 年份 | 事件 |
| --- | --- |
| 1990 年代初 | IBM Almaden 研究院的 Tiger Shark 多媒体文件系统，GPFS 的前身 |
| 1998 | GPFS（General Parallel File System）作为产品发布，最早运行在 AIX 和 SP 超算上 |
| 2000 年代 | 进入 Linux，长期占据 TOP500 超算存储的重要份额 |
| 2015 | 更名 IBM Spectrum Scale |
| 2023 | 更名 IBM Storage Scale；硬件一体机 ESS 更名为 Storage Scale System |

名字换了三次，但命令一直是 `mm` 开头（来自最早的 multimedia），文件路径一直是 `/usr/lpp/mmfs`，社区和日常交流里大家仍然叫它 GPFS。

它适合什么？

- **大规模并行 I/O**：HPC 的 MPI-IO、AI 训练的多节点数据读取与 checkpoint 写入。
- **强一致 POSIX 共享**：多个节点同时写同一个文件的不同区域，彼此立即可见。这是 NFS 做不到、对象存储根本不提供的。
- **分层与数据管理**：多存储池 + 策略引擎（ILM），把冷数据自动迁到便宜的盘或对象存储。
- **多协议**：同一份数据同时以 POSIX、NFS、SMB、S3、Kubernetes CSI 暴露。

它不适合什么？预算紧张、团队没有商业软件运维经验、只需要 S3 或块存储的场景。和 Ceph 相比，GPFS 的数据路径更短、元数据性能更强，但它是闭源商业软件，出了深层问题只能找 IBM 支持。

## 部署模型：共享磁盘到无共享

GPFS 最初是**共享磁盘**（Shared Disk）文件系统：所有节点通过 SAN 看到同一批 LUN，直接读写。后来演化出多种部署方式：

```text
① SAN 直连：         所有节点 ──FC/iSCSI──▶ 共享 LUN（每个节点直接块访问）
② NSD 服务器：       客户端 ──网络──▶ NSD 服务器 ──SAN──▶ 外置 RAID 阵列（主备服务器共享 LUN）
③ ESS 一体机：       客户端 ──网络──▶ 成对 IO 服务器 + JBOD，GNR 软件 RAID（Storage Scale System）
④ ECE 无共享：       客户端 ──网络──▶ N 台普通服务器，每台只用自己的本地 NVMe/HDD，GNR 跨节点纠删码
```

今天新建的 AI 集群基本是 ③ 或 ④。④ 就是 ECE，也叫 SNC（Shared Nothing Cluster，无共享集群）模式：每块盘只连一台服务器，数据保护靠软件跨服务器做纠删码或多副本，和 [Ceph](/learn/ceph-architecture)、Weka、VAST 属于同一类思路。

## 集群与节点角色

一个 GPFS 集群由一组安装了 GPFS 守护进程 `mmfsd` 的节点组成。节点可以同时承担多个角色：

| 角色 | 数量 | 职责 | 查看命令 |
| --- | --- | --- | --- |
| Quorum 节点 | 奇数个，通常 3、5 或 7 | 参与仲裁投票，保存 CCR 配置副本 | `mmlscluster` |
| Manager 节点 | 若干 | 可以被选为 File System Manager、Token Manager | `mmlscluster` |
| Cluster Manager | 每个集群 1 个 | 由 quorum 节点选出，管理租约（lease）、检测节点故障、驱逐（expel）失联节点、指派 File System Manager | `mmlsmgr -c` |
| File System Manager | 每个文件系统 1 个 | 文件系统配置变更、空间分配、配额管理、故障恢复 | `mmlsmgr` |
| Token Manager | 每个文件系统可分布在多个 manager 节点 | 分发和回收 token（分布式锁） | `mmdiag --tokenmgr` |
| NSD 服务器 | 若干 | 把本地或 SAN 上的盘以 NSD 形式通过网络提供给其他节点 | `mmlsnsd` |
| Metanode | 每个打开的文件 1 个 | 负责该文件 inode 与间接块的元数据更新 | `mmfsadm dump files` |
| CES 协议节点 | 若干 | 对外提供 NFS、SMB、S3 服务 | `mmces node list` |
| Client 节点 | 任意 | 只挂载文件系统读写数据 | — |

配置信息存在 **CCR**（Clustered Configuration Repository）里，每个 quorum 节点有一份副本，通过多数派保证一致，所以 quorum 节点数量既影响可用性也影响配置能否修改。

**Metanode** 值得单独说一下：所有访问某个文件的节点都可以直接并行读写数据块，但这个文件的元数据（文件大小、修改时间、块地址）只能由一个节点更新，这个节点就是 metanode，通常是最早打开该文件的节点。多个节点并发追加写同一个文件时，它们都要把元数据更新发给 metanode，这就是"多节点写同一个文件"的性能上限所在。

许可也和角色挂钩：承担 quorum、manager、NSD 服务器等"服务端"职责的节点需要 server 许可，只挂载文件系统的节点可以用 client 许可（`mmchlicense server|client`）。

## NSD、文件系统与存储池

```text
文件系统 fs1（挂载点 /gpfs/fs1）
 ├── 存储池 system  （必须存在，通常只放元数据）── NSD: meta01 meta02 meta03 ...（NVMe）
 ├── 存储池 data    （可选，放数据）            ── NSD: data01 data02 ...（NVMe）
 ├── 存储池 capacity（可选，冷数据）            ── NSD: hdd01 hdd02 ...（HDD）
 └── 外部池 cos     （可选）                    ── 对象存储 / 磁带，通过策略迁移
```

- **NSD（Network Shared Disk）**：GPFS 眼里的"一块盘"。它可以是一个 LUN、一块本地 NVMe，也可以是 ECE 里的一个 vdisk。NSD 在全集群有唯一名字，没有直接连接这块盘的节点通过网络向 NSD 服务器读写，这就是"网络共享磁盘"的意思。
- **失效组（Failure Group）**：给 NSD 打上的编号，表示"共享同一故障风险"。GPFS 的副本（`-m/-r` 元数据/数据副本数）会放在不同失效组上。
- **存储池（Storage Pool）**：把性能、成本、可靠性相近的 NSD 分组。`system` 池必须存在；数据池可以有多个；外部池接对象存储或磁带。
- **策略（Policy）**：用类 SQL 规则决定文件放在哪个池（放置策略）、何时迁移或删除（管理策略），由 `mmapplypolicy` 并行执行，扫描上亿文件也很快。
- **Fileset（文件集）**：文件系统内的一棵子目录树，是配额、快照、多租户的管理单元，分独立（有自己的 inode 空间）和依赖两种，[GPFS Day-2](/learn/gpfs-day2) 会详细讲。

GPFS 会把一个文件的数据块**条带化**（striping）到池内所有 NSD 上，大文件的读写天然并行到所有盘和所有服务器。这是它顺序带宽能随节点数线性扩展的原因。

## 块大小与子块

创建文件系统时要选块大小（`-B`），之后**不能修改**，所以值得认真想。

GPFS 5.0 之前，一个块固定切成 32 个子块（subblock），子块是最小分配单位：选 1 MiB 块大小，小文件至少占 32 KiB；选 16 MiB，最少占 512 KiB，小文件浪费严重。5.0 之后改成子块大小随块大小变化、数量可以更多：

| 块大小 | 子块大小（5.0+ 新建文件系统） | 每块子块数 |
| --- | --- | --- |
| 256 KiB | 8 KiB | 32 |
| 1 MiB | 8 KiB | 128 |
| 4 MiB（默认） | 8 KiB | 512 |
| 16 MiB | 16 KiB | 1024 |

这一改让"大块大小 + 小文件"不再是矛盾：4 MiB 块大小下，一个 5 KiB 的文件只占一个 8 KiB 子块。更小的文件（几 KiB 以内）甚至直接存进 inode 里（data-in-inode，inode 默认 4 KiB），读取时只需一次元数据 I/O。

经验法则：

- **数据块大小跟着负载走**：AI 训练、HPC 大文件顺序 I/O 用 4 MiB 或 8 MiB；海量小文件为主可以考虑 1 MiB。拿不准就用默认的 4 MiB。
- **元数据块大小单独设**：元数据单独放 system 池时，可以用 `--metadata-block-size` 设成较小的值（ECE 里常见 512 KiB～1 MiB），让目录和间接块更紧凑。
- ECE 里块大小还受纠删码约束：vdisk 的块大小和 RAID 码一起在定义 vdisk set 时指定，文件系统块大小必须与之匹配。

## 分布式锁与 token 管理

几百个节点并行读写，还要保证 POSIX 一致性，靠的是分布式锁。GPFS 的锁叫 **token**：

```text
节点 A 要写 file1 的 0～4 MiB：
  A ──请求 byte-range 写 token [0, 4M)──▶ Token Manager
                                           │ 没有冲突，发给 A
  A 在本地缓存里自由读写这一段，无需每次问服务器

节点 B 也要写 file1 的 2～6 MiB：
  B ──请求 [2M, 6M)──▶ Token Manager ──冲突──▶ 通知 A 交出 [2M, 4M)
  A 把这段脏数据刷回盘，交出 token ──▶ B 获得 token 开始写
```

关键点：

- token 一旦拿到就**缓存在本地**，只要没人和你冲突，你就可以一直用，不需要每次 I/O 都走网络。这是 GPFS 在"各干各的"负载下极快的原因。
- 锁粒度可以细到**字节范围**（byte-range），不同节点写同一个文件的不同区域不会互相阻塞（MPI-IO 大量使用这种模式）。
- 冲突时要回收（revoke）token，被回收的一方要先把脏数据刷回——多个节点抢同一段数据或同一个目录时，性能会急剧下降。典型反例：几百个进程往同一个目录里同时创建文件，所有节点都在抢这个目录的 token。
- Token Manager 在内存里维护 token 状态，节点数、打开文件数越多，占用内存越多，这也是 `maxFilesToCache` 等参数会影响 manager 节点内存的原因。

> [!TIP] 负载设计建议
> 给 AI 平台用户的建议很简单：每个训练进程写自己的文件、每个作业写自己的目录，避免成千上万进程往同一个目录里写小文件。GPFS 能处理共享写，但"无冲突"永远比"能处理冲突"快一个数量级。

### 租约与驱逐

每个节点要定期向 Cluster Manager 续租约（disk lease）。一个节点失联超过 `failureDetectionTime`（默认 35 秒左右），Cluster Manager 会把它**驱逐（expel）**出集群，回收它持有的 token，由其他节点重放它的日志（每个节点在文件系统上有自己的 recovery log）完成恢复。被驱逐的节点上，挂载点会变得不可用直到重新加入。日志里看到 `Expelling` 或 `lease` 相关错误，第一反应是查网络。

## 仲裁

仲裁（Quorum）解决的是[分布式存储基础](/learn/distributed-basics)里讲过的脑裂问题：网络分区后，只有能证明自己是"多数派"的那一边可以继续工作。

GPFS 有两种仲裁方式：

| 方式 | 规则 | 适用 |
| --- | --- | --- |
| 节点仲裁（Node Quorum） | 默认方式。存活的 quorum 节点必须超过半数（N/2+1） | 绝大多数集群，特别是 ECE / 无共享 |
| 带仲裁盘的节点仲裁（Tiebreaker Disk） | 指定 1～3 块仲裁盘，**所有 quorum 节点都能直接访问**；只要有一个 quorum 节点能访问多数仲裁盘即可保持在线 | 小规模共享存储集群，希望只剩一个节点也能活 |

失去仲裁时，剩余节点上的 GPFS 会卸载所有文件系统，直到重新形成仲裁。所以：

- quorum 节点数用奇数，**3、5、7**，一般不超过 7，太多反而让选举和 CCR 更新变慢。
- quorum 节点要分散在不同机柜、不同电源、不同交换机上，否则一次机柜掉电就能让集群失去仲裁。
- 仲裁盘依赖共享存储，所以 ECE 这类无共享集群用不了，只能靠节点仲裁。

ECE 的安装工具包会按规则自动选择 quorum 节点：单个恢复组中 4 个节点选 3 个，5～6 个节点选 5 个，7 个及以上选 7 个；有多个恢复组时，7 个 quorum 节点轮流分布到不同恢复组上。

## 多集群：owning 与 accessing

这是 GPFS 最有特色、也是生产里最常用的架构之一。一个 GPFS 集群可以把自己的文件系统授权给另一个集群远程挂载：

```text
┌──────────────── accessing cluster：client.example.com ────────────────┐
│ mn01 mn02 mn03（K8s 管理节点）… 只有客户端，不拥有任何盘                 │
│ mmremotecluster add storage.example.com   mmremotefs add rfs1 …        │
└───────────────────────────────┬────────────────────────────────────────┘
                                │ 守护进程网络（TCP） + 数据网络（RDMA）
                                │ 客户端直接与 owning 集群的每个 NSD 服务器通信
┌───────────────────────────────▼──────── owning cluster：storage.example.com ┐
│ sn01 sn02 sn03 … ECE 存储节点，拥有盘、NSD、文件系统 fs1                    │
│ mmauth add client.example.com   mmauth grant client.example.com -f fs1 -a rw │
└──────────────────────────────────────────────────────────────────────────────┘
```

- **Owning cluster（拥有集群）**：拥有盘和文件系统，负责文件系统管理、配额、快照。
- **Accessing cluster（访问集群）**：没有盘（或者有自己的其他文件系统），通过远程挂载访问 owning 集群的文件系统。
- 两个集群**各自独立管理**：各有自己的 quorum、配置、管理员、升级节奏。客户端集群的节点宕机、重装、扩缩容，不会影响存储集群的仲裁。
- 双方通过 `mmauth` 交换公钥互相认证；owning 端可以细到"允许某个远程集群以只读或读写方式访问某个文件系统"，新版本还能细到**某些 fileset**（Remote Fileset Access Control）。注意 root fileset 的内容对所有被授权的远程集群始终可见。
- 远程挂载后，数据路径和本地挂载完全一样：客户端直接与 owning 集群的**所有** NSD 服务器通信，token 由 owning 集群的 token manager 管理。所以网络上客户端必须能访问 owning 集群的每一个存储节点，名字解析也要通。

为什么要拆成两个集群？

1. **隔离故障与变更**：GPU 节点经常重启、重装、扩缩，把它们放进存储集群，会让存储集群的成员频繁变化。
2. **权限分离**：存储团队管 owning 集群，平台或租户管 accessing 集群，谁都不需要对方的 root。
3. **多租户**：每个租户一个 accessing 集群，只授权自己的文件系统或 fileset。
4. **一个客户端挂多个存储**：一个 accessing 集群可以同时挂载多个 owning 集群的文件系统。

> [!NOTE] 远程访问的一个细节
> 多个集群的客户端同时访问同一个文件时，这个文件的 metanode 会放到 owning 集群上。`mmchconfig preferDesignatedMnode=yes` 可以让 metanode 倾向于落在 manager 节点上。这类行为在不同版本间有变化，调整前先读对应版本文档。

## ECE：软件定义的 GPFS 原生 RAID

### 从传统部署到 ECE

传统 GPFS 部署（上面的 ①②）自己不管数据保护：盘的冗余交给外置 RAID 阵列，节点冗余靠两台 NSD 服务器共享同一批 LUN、互为主备。ESS 一体机引入了 **GNR（GPFS Native RAID，也叫 Storage Scale RAID）**，在服务器上用软件做 RAID，不再需要 RAID 卡。ECE 则把 GNR 做成纯软件，装在普通 x86 服务器上，每块盘只连一台服务器，数据跨服务器做纠删码。

| 维度 | 传统共享存储 GPFS | ECE（Erasure Code Edition） |
| --- | --- | --- |
| 盘的连接 | SAN / 共享 JBOD，多台服务器能看到同一块盘 | 本地盘，每块盘只属于一台服务器 |
| 数据保护 | 外置 RAID 控制器；或 GPFS 副本（`-m/-r`） | GNR 跨节点纠删码 / 多副本 |
| 服务器故障 | 备用 NSD 服务器接管同一批 LUN | 其他节点用纠删码重构数据，同时承担读写 |
| 重建 | RAID 组内少数盘参与，慢 | 分散式阵列内所有盘参与，快 |
| 硬件 | 存储阵列 + 服务器 | 同构的普通服务器，NVMe / SSD / HDD |
| 管理工具 | `mmcrnsd`、`mmcrfs` | `mmvdisk`（声明式） |
| 磁盘健康 | 靠阵列管理 | GNR 自己做盘诊断、慢盘隔离、端到端校验和 |

### GNR 的几个对象

```text
恢复组 RG1（sn01～sn06，硬件配置必须完全一致）
 └── 分散式阵列 DA1（所有节点上同类型的盘：pdisk n001p001 … n006p024）
      ├── log vdisk（每个节点的日志组各一个，放在 NVMe 上）
      ├── vdisk: RG1LG001VS001  4WayReplication  512K  → NSD（元数据）
      ├── vdisk: RG1LG001VS002  8+3P             4M    → NSD（数据）
      └── … 预留备用空间（spare space），不是专门的热备盘
```

| 对象 | 含义 |
| --- | --- |
| pdisk | 一块物理盘在 GNR 里的抽象 |
| RG（Recovery Group，恢复组） | 一组服务器及其所有 pdisk，是故障域和容错边界。ECE 中每个 RG 3～32 台服务器（截至本文写作时），**RG 内服务器配置必须完全相同**，RG 之间完全独立 |
| DA（Declustered Array，分散式阵列） | RG 内同类型（速度、容量相同）的 pdisk 组成一个 DA。数据条带分散到 DA 内所有盘，重建时所有盘一起参与 |
| vdisk | 从 DA 中切出的虚拟盘，每个 vdisk 有自己的 RAID 码、块大小，对应一个 NSD |
| vdisk set | 用 `mmvdisk` 声明式定义的一组 vdisk（跨 RG 内所有节点），用来批量创建、扩容文件系统 |
| log group | 每个 RG 内的若干日志组，承载 vdisk 的服务，节点故障时日志组在节点间漂移 |

"分散式阵列"是 GNR 最核心的设计，和[副本与纠删码](/learn/replication-ec)里讲的 Ceph PG 分布是同一个思想：传统 RAID 6 的 8+2 组里坏一块盘，只有剩下 9 块盘参与重建，重建一块 20 TB 的盘可能要几天；DA 把条带随机分散到几十上百块盘上，坏一块盘时所有盘各出一点力，重建时间缩短一个数量级。GNR 还会区分"只丢了一份冗余"和"已经没有冗余"的条带，优先重建后者（critical rebuild）。

"声明式"则体现在 `mmvdisk` 上：你只需要说"在 RG1 的 DA1 上定义一个 8+3P、4 MiB、占 90% 空间的 vdisk set"，mmvdisk 会自己算出每个节点要建几个 vdisk、每个多大，并检查容错能力是否满足。

### RAID 码的选择

ECE 支持的码（截至本文写作时）：`3WayReplication`、`4WayReplication`、`4+2P`、`4+3P`、`8+2P`、`8+3P`、`16+2P`、`16+3P`。选择的约束来自节点数——每个条带的分片要尽量落在不同节点上，节点太少时宽条带的节点级容错就不成立：

| RG 内节点数 | IBM 推荐的码 |
| --- | --- |
| 3 | 3WayReplication |
| 4～5 | 4+3P、3WayReplication |
| 6～9 | 8+3P、4+2P、4+3P |
| 10 及以上 | 8+2P、8+3P、4+2P、4+3P |

一个常见组合是：**元数据用 4WayReplication，数据用 8+3P**。元数据小而随机，副本读写放大小、延迟低；数据大而顺序，8+3P 的空间效率约 73%，能容忍 3 个故障。

还有一个硬限制需要提前知道：**每个 RG 最多 512 个 vdisk**。一个 vdisk set 在每个节点上创建 2 个 vdisk，于是 RG 里节点越多，能创建的 vdisk set 越少，大约是 `(512 - 1) / (2 × 节点数) - 1`（向下取整），10 节点的 RG 只能建 24 个左右。这直接限制了"每个租户一个文件系统"这种多租户方案能切多少份（见 [GPFS Day-2](/learn/gpfs-day2)）。

## CES：协议节点

不是所有客户端都能装 GPFS 客户端：Windows、Mac、不受你控制的虚拟机、只会说 S3 的应用。CES（Cluster Export Services）让一组 GPFS 节点充当**协议网关**：

| 协议 | 实现 | 典型用途 |
| --- | --- | --- |
| NFS | NFS-Ganesha（用户态 NFS 服务器） | Linux 客户端、虚拟机、不能装 GPFS 的机器 |
| SMB | Samba + CTDB | Windows / Mac 用户共享 |
| S3 | 新版本基于 NooBaa 实现（截至本文写作时） | 对象访问同一份数据 |
| HDFS | Transparent HDFS | 大数据生态 |

CES 节点持有一组浮动的 **CES IP**，节点故障时 IP 自动漂移到其他 CES 节点，客户端几乎无感。协议配置保存在 `cesSharedRoot` 指向的共享目录里。

生产建议：高性能场景下 CES 节点单独部署，只跑协议服务；协议客户端访问 CES 的网络和 GPFS 内部数据网络分开，用不同的物理网卡。不要指望 NFS 网关提供和原生 GPFS 客户端一样的性能——GPFS 客户端直连所有 NSD 服务器并行读写，而 NFS 客户端的所有流量都要经过一个 CES 节点。

## 版本与访问方式小结

| 版本（Edition） | 主要内容 | 典型用途 |
| --- | --- | --- |
| Data Access Edition（DAE） | 核心文件系统、多集群、CES | 基本的客户端、存储集群 |
| Data Management Edition（DME） | DAE + 加密、审计日志、AFM 异步复制、压缩、对象分层等 | 需要数据管理功能的集群 |
| Erasure Code Edition（ECE） | DME + GNR 软件 RAID | 无共享存储集群 |
| Developer Edition | 类似 DME，免费、限容量、不可用于生产 | 学习与测试 |

截至本文写作时，常见的组合是：**存储集群用 ECE，客户端集群用 DAE 或 DME**（需要文件审计日志时用 DME）。具体的功能与版本对应关系以 IBM 官方文档为准。

## 动手练习

1. 画一张你理想中的 AI 集群 GPFS 架构图：标出 owning / accessing 集群、各节点角色（quorum、manager、NSD、CES）、三张网络（管理、存储、计算）分别连到哪些节点。
2. 假设 ECE 存储集群有 8 台节点、单个 RG，按本文规则回答：应选几个 quorum 节点？数据用哪种 RAID 码？这个 RG 最多能建多少个 vdisk set？
3. 用 IBM 官方的 [StorageScaleVagrant](https://github.com/IBM/StorageScaleVagrant) 或 3 台虚拟机 + Developer Edition 搭一个学习集群，执行 `mmlscluster`、`mmlsmgr -c`、`mmlsmgr`、`mmlsnsd`，把输出和本文的角色表一一对应起来。
4. 在学习集群上用 `mmcrfs` 分别创建块大小为 256K 和 4M 的两个文件系统，写入 10000 个 4 KiB 的文件，用 `mmdf` 和 `mmlsfs -f` 比较空间占用和子块大小。
5. 设计一个实验证明 token 冲突的代价：两台节点分别写同一个文件的不相交区域，与两台节点反复交替写同一个 4 KiB 区域，对比吞吐。

## 自测

<details>
<summary>Cluster Manager、File System Manager、Token Manager 分别负责什么？各有几个？</summary>

Cluster Manager 每个集群一个，由 quorum 节点选出，负责租约管理、节点故障检测与驱逐、指派 File System Manager。File System Manager 每个文件系统一个，负责配置变更、空间分配、配额和故障恢复。Token Manager 可以分布在多个 manager 节点上，负责分发和回收 token，协调多节点对文件数据和元数据的访问。

</details>

<details>
<summary>GPFS 5.0 之后块大小与子块的关系发生了什么变化？为什么这让 4 MiB 块大小也能较好地容纳小文件？</summary>

5.0 之前一个块固定分成 32 个子块，4 MiB 块大小的最小分配单位是 128 KiB。5.0 之后新建的文件系统子块大小随块大小变化，4 MiB 块对应 8 KiB 子块、每块 512 个子块，小文件最少只占 8 KiB；非常小的文件还能直接存进 inode。所以大块大小不再以浪费大量小文件空间为代价。

</details>

<details>
<summary>一个 5 个 quorum 节点的集群最多能同时坏几个 quorum 节点？为什么 ECE 集群不能使用仲裁盘？</summary>

节点仲裁要求存活的 quorum 节点超过半数，5 个中至少要 3 个存活，所以最多容忍 2 个。仲裁盘要求所有 quorum 节点都能直接访问同一块共享盘，而 ECE 是无共享架构，每块盘只连接一台服务器，不存在这样的共享盘，所以只能用节点仲裁。

</details>

<details>
<summary>为什么生产上常把 GPU 客户端放在独立的 accessing 集群，而不是直接加入存储集群？</summary>

两个集群各自独立管理：GPU 节点频繁重启、重装、扩缩容不会影响存储集群的仲裁和配置；存储团队和平台团队权限分离；可以按集群、文件系统甚至 fileset 粒度授权，实现多租户；一个客户端集群还能同时挂载多个存储集群。需要注意的是远程挂载的客户端仍然直接与 owning 集群的所有 NSD 服务器通信，网络和名字解析必须全部打通。

</details>

<details>
<summary>ECE 的分散式阵列（DA）为什么比传统 RAID 重建更快？</summary>

传统 RAID 的一个组只有少量盘，坏一块盘时只有同组剩余的几块盘参与重建，写入集中在一块热备盘上，瓶颈明显。DA 把每个条带的分片随机分散到阵列内所有盘上，备用空间也分散在所有盘上，坏一块盘时所有盘并行读取和写入重建数据，重建时间大幅缩短；GNR 还会优先重建冗余已经耗尽的条带。

</details>

## 参考资料

- [IBM Storage Scale 官方文档](https://www.ibm.com/docs/en/storage-scale)
- [IBM Storage Scale Erasure Code Edition 官方文档](https://www.ibm.com/docs/en/storage-scale-ece)
- [IBM Storage Scale FAQ（支持的操作系统、限制与版本）](https://www.ibm.com/docs/en/storage-scale?topic=STXKQY/gpfsclustersfaq.html)
- [ECE 文档：vdisks](https://www.ibm.com/docs/en/storage-scale-ece/5.2.3?topic=raid-vdisks)
- [ECE 文档：RAID 码选择建议](https://www.ibm.com/docs/en/storage-scale-ece/5.2.3?topic=selection-recommendations)
- [Spectrum Scale 用户组：Storage Scale Concepts](https://www.spectrumscaleug.org/wp-content/uploads/2024/03/SSUG24DE-NU03-Storage-Scale-Concepts.pdf)
- [Spectrum Scale 用户组：Spectrum Scale Erasure Code Edition](https://www.spectrumscaleug.org/wp-content/uploads/2020/04/Spectrum-Scale-Erasure-Code-Edition-ECE.pdf)
- [Schmuck & Haskin. GPFS: A Shared-Disk File System for Large Computing Clusters（FAST 2002）](https://www.usenix.org/conference/fast-02/gpfs-shared-disk-file-system-large-computing-clusters)
- [IBM StorageScaleVagrant：用 Vagrant 搭建学习环境](https://github.com/IBM/StorageScaleVagrant)
- [IBM Storage Scale 产品页（含 Developer Edition 下载入口）](https://www.ibm.com/products/storage-scale)
