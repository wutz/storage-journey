# GPFS ECE 混闪方案设计：合并池、多租户与 ILM

前三课讲了 GPFS 的概念、ECE 的部署和日常运维，这一课把它们串起来做一次完整的方案设计：一个 5 节点的 ECE 集群，每台服务器插满 HDD 和少量 NVMe，要同时服务 4 个租户、承载平均只有 200 KiB 的海量文件，还要给 Kubernetes 自动供给存储。SSD 放元数据和热数据、HDD 放冷数据，靠 ILM 策略自动分层——这就是"混闪"。

方案里的每个数字都有来由：纠删码怎么选、元数据留多少、vdisk set 切几片、QoS 配多少、策略阈值定在哪。本课按"先有约束、再有决策"的顺序一步步推导，每一步只依赖前面已经算出的结果。学完你应该能拿着一份硬件清单，独立算出一套自洽的混闪方案，并知道它的风险点在哪。

示例环境：owning 集群 `storage.example.com`，5 台 ECE 服务器组成一个恢复组 `rg1`（节点类 `ece5`），4 个租户文件系统 `fs1`～`fs4`；租户通过 accessing 集群和 Kubernetes CSI 挂载。数字来自一次真实的方案评审，已做脱敏。

> [!NOTE] 本课需要的环境
> 推导部分只需要纸笔或 Python。ILM 策略可以在单节点 Developer Edition 上用两个存储池练习；`mmvdisk` 相关命令需要 ECE 环境。命令基于截至本文写作时的 Storage Scale 5.2.x，参数名、上限值（尤其是 inode 测试上限）以对应版本的 [IBM Storage Scale 文档](https://www.ibm.com/docs/en/storage-scale)和 FAQ 为准。

## 设计路线图

整套方案是一串环环相扣的决策，后面的每一步都建立在前面的结果之上：

```text
 ① 场景与目标          为什么混闪、服务谁、平均文件多大
        │
 ② 容量积木            pdisk / DA / RG / vdisk set、512 vdisk 上限、存储池
        │
 ③ 硬件基线            以 mmvdisk 实测裸容量为准，推出 11 节点口径
        │
 ④ 冗余与容错          8+2p vs 8+3p、每节点 strip 数、spare 留多少
        │
 ⑤ 元数据              要多少（5%）、用什么码（为什么不用副本）、代价是什么
        │
 ⑥ 池布局与切片        Meta+Cache 合并池、按 11 节点定切片规格
        │
 ⑦ 多租户              多文件系统隔离元数据、QoS 管共享 HDD、mmapi 管权限
        │
 ⑧ 容量口径与 inode    可交付容量 ≠ df、inode 是第二个天花板
        │
 ⑨ ILM                 放置 LIMIT、THRESHOLD 泄洪、定时降级与回迁
        │
 ⑩ 落地与校准          部署命令顺序、上线后监控什么
```

## 场景：为什么要混闪

混闪（Hybrid Flash）指 SSD 和 HDD 部署在同一个存储集群里，用 GPFS 的**存储池**（Storage Pool）分层管理：

- SSD（这里是 NVMe）承载**元数据和热数据**，是缓存层；
- HDD 承载**海量冷数据**，是容量层；
- 数据按大小、类型、访问热度，由 **ILM（信息生命周期管理）** 策略在两层之间自动迁移；
- 对应用来说始终是**一个文件系统、一个命名空间**，分层完全透明。

| 方案 | 优点 | 问题 |
| --- | --- | --- |
| 全闪 | 延迟低、性能好 | 每 TB 成本高，PB 级数据的 TCO 承受不了 |
| 全 HDD | 容量便宜 | 元数据、小文件是随机 I/O，目录遍历、`stat`、小文件读写都慢 |
| 混闪 | 少量 SSD 解决延迟敏感部分，HDD 解决容量 | 设计复杂：池怎么切、元数据放哪、数据怎么流动都要算清楚 |

混闪的本质是用少量成本解决大部分延迟敏感问题。它成立的前提是：**热数据和元数据只占总量的一小部分**。本方案面对的负载是平均 200 KiB 的小文件密集型数据（AI 数据集、预处理样本），元数据占比天然偏高，这一点会反复影响后面的决策。

设计目标可以写成四句话：

1. 可用容量尽量大（得盘率优先）；
2. 元数据和小文件访问要快（元数据全部在 NVMe 上）；
3. 4 个租户之间互不拖累，平台能自助扩缩配额；
4. 集群从 5 节点扩到 11 节点时，方案不推翻重来。

## 先认清积木：ECE 里和容量有关的对象

[GPFS 核心概念](/learn/gpfs-concepts)里介绍过 GNR 的对象，这里只看和容量规划直接相关的部分，并把本集群画出来：

```text
恢复组 rg1（5 台服务器，硬件完全相同，节点类 ece5）
 ├── DA1（HDD）：160 块 16 TB HDD，每台 32 块
 │    └── vdisk set：fs1-hdd / fs2-hdd / …   → data 池（dataOnly）
 ├── DA2（NVMe）：20 块 15.36 TB NVMe，每台 4 块
 │    └── vdisk set：fs1-ssd / fs2-ssd / …   → system 池（dataAndMetadata）
 └── log group：每台服务器 2 个 user log group + 1 个 root log group
```

### vdisk 预算：每个 RG 最多 512 个

每个 RG 最多 512 个 vdisk，这是整个方案里最硬的约束。vdisk 从哪来：

- 每个 vdisk set 在**每个 user log group** 上创建一个 vdisk，默认每台服务器 2 个 user log group，所以**每个 vdisk set 消耗 `节点数 × 2` 个 vdisk**；
- 每个 log group 还有自己的日志 vdisk，合计约 `节点数 × 2 + 1` 个。

| | 5 节点 | 11 节点 |
| --- | --- | --- |
| 每个 vdisk set 消耗 | 10 | 22 |
| 日志 vdisk | ≈ 11 | ≈ 23 |
| 留给 vdisk set 的预算 | 512 − 11 = 501 | 512 − 23 = **489** |
| 最多能建的 vdisk set | 50 | 22 |

注意节点越多，能建的 vdisk set 反而越少。"每个租户一个文件系统、每个文件系统至少一个 SSD 片和一个 HDD 片"的方案，在大 RG 里很快就会顶到这个上限。

### 存储池：system 和 data

一个 GPFS 文件系统可以有多个存储池，每个 NSD（这里就是一个 vdisk）属于一个池：

- **system 池**：必须存在，元数据只能放在 system 池。本方案把 NVMe 的 vdisk 设成 `dataAndMetadata`，同时放元数据和热数据；
- **data 池**：HDD 的 vdisk 设成 `dataOnly`，只放数据。

文件的数据落在哪个池、之后怎么搬，全部由 ILM 策略决定，这部分放到后面讲。

## 硬件基线：以 mmvdisk 实测容量为准

硬件是 5 台同构服务器，共 160 块 16 TB HDD、20 块 15.36 TB NVMe。容量规划的第一步是拿到**真正能给 vdisk set 用的裸容量**，而不是厂标容量：

```bash
mmvdisk recoverygroup list --recovery-group rg1 --declustered-array
```

| DA | 类型 | 实测 total raw | 8+2p 后可用（×80%） |
| --- | --- | --- | --- |
| DA2 | NVMe | 248 TiB | ≈ 198 TiB |
| DA1 | HDD | 2,288 TiB | ≈ 1,830 TiB |

实测值和厂标之间的差额可以逐项解释清楚：

```text
DA1 HDD   160 块 × 16 TB    = 2,328 TiB   （16 TB = 14.55 TiB，厂标用十进制）
          − spare 2 块       =   −29 TiB
          − 格式化开销 0.49% =   −11 TiB
          = 158 块有效       ≈ 2,288 TiB   ✓ 与实测一致

DA2 NVMe  20 块 × 15.36 TB  =   279 TiB
          − spare 2 块       =   −28 TiB
          − 格式化开销 1.37% =    −3 TiB
          = 18 块有效        ≈   248 TiB   ✓ 与实测一致
```

由此得到两个后面反复要用的单位：**每块有效 pdisk 的容量是 HDD 14.48 TiB、NVMe 13.78 TiB**。

> [!WARNING] 不要重复扣减 spare
> `mmvdisk` 报告的 total raw 已经扣掉了 spare 空间。很多估算表先按厂标乘 80%，再扣一次"热备盘 / 重建预留"，等于把 spare 算了两遍，规划出来的容量偏小。以实测值为准，只扣纠删码效率。

### 11 节点口径

集群规划最终扩到 11 节点（这是单个 RG 的目标规模），所以还需要一套 11 节点的数字。按 5 节点实测值线性外推：

| | 每节点裸容量 | 11 节点裸容量 | 8+2p 可用 |
| --- | --- | --- | --- |
| HDD | 2,288 / 5 = 457.6 TiB | 5,034 TiB | ≈ 4,027 TiB |
| NVMe | 248 / 5 = 49.6 TiB | ≈ 546 TiB | ≈ 436 TiB |

**5 节点是实际部署，11 节点是切片规格的设计基准**，后面两套数字会一起出现。

## 冗余策略：8+2p 还是 8+3p

### 得盘率的差距

| | 8+3p（可靠性优先） | 8+2p（得盘率优先，本方案） |
| --- | --- | --- |
| 空间效率 | 8 / 11 ≈ 72.7% | 8 / 10 = 80% |
| 11 节点 HDD 可用 | 5,034 × 0.727 ≈ 3,661 TiB | 5,034 × 0.80 ≈ 4,027 TiB |
| 同时容忍的故障 | 3 个 strip | 2 个 strip |

两者相差 366 TiB，约 9.1% 的可用容量，这就是"可靠性 vs 得盘率"的具体代价。本方案选 8+2p，而且 SSD 和 HDD 统一用 8+2p（原因在元数据一节）。

### 容错的真实边界：每节点几个 strip

纠删码能容忍几个故障，要落到**节点**上看。一个 8+2p 条带有 10 个 strip，GNR 会把它们尽量均匀地分布到各节点：

```text
每节点 strip 数 = 条带宽度 ÷ 节点数

 5 节点：10 / 5 = 2 个 strip/节点
   坏 1 个节点 = 一次丢 2 个 strip = 恰好耗尽 2 个校验
   → 数据仍可用，但余量归零；故障窗口内再坏任意一块盘 = 数据不可用

11 节点：10 个 strip 分在 11 个节点上，每节点最多 1 个
   → 可同时容忍 2 个节点故障
```

在 [GPFS 核心概念](/learn/gpfs-concepts) 的推荐表里，8+2P 的推荐起点是 10 节点。5 节点跑 8+2p 是**有意识地低于推荐配置**：换来了 80% 的得盘率，也接受了"单节点故障后余量为零"的风险。所以 5 节点阶段最关键的可用性控制点不是理论问题，而是：

- 备件响应时间和重建窗口要严格管控；
- 计划内维护（`suspend` 一个节点）等同于一次节点故障，维护期间不能再有盘故障；
- 如果可用性要求更高，改用 8+3p：按实测裸容量，NVMe 可用降到约 180 TiB、HDD 降到约 1,664 TiB，切片规格需要整体重排。

扩到 11 节点后这个约束自然解除，这也是按 11 节点做标准化设计的另一重收益。

### spare：重建局部性决定该留多少

ECE 的 spare 不是独立的热备盘，而是**以整盘容量为单位、打散铺在该 DA 所有 pdisk 上的重建预留**。当前配置是最小默认值：DA1 160 块留 2 块、DA2 20 块留 2 块。它只保证 RAID 码声明的容错度，不留额外的重建余量。

spare 留多少，由**重建局部性**决定：

1. 盘坏之后，ECE 优先在**本节点**的 spare 空间里重建，这样每节点仍然只有 2 个 strip，1 节点容错得以保住；
2. 本节点的 spare 用完，重建数据就会外溢到其他节点，某些条带会出现 3 个 strip 落在同一节点上——**节点级容错直接归零**。

所以 5 节点 + 8+2p 的推荐值是 **spare ≥ 2 × 节点数 = 10**，即每节点留 2 块盘的量。按方案引用的 IBM 经验：spare 盘数达到节点数的两倍时，每个节点各坏 2 块盘仍能保持 1 节点容错。

为什么不用 `--spare-nodes 1`（预留一整个节点的容量）？5 节点下即便预留整节点，一个节点故障后剩 4 个节点要放 10 个 strip，必有节点拿到 3 个，节点容错仍然是 0。**5 节点的正确做法是留 2N 扛盘故障，节点故障靠尽快修复或换机器**，不要指望绕开故障节点重建。

spare 上调的容量代价（按每块有效 pdisk HDD 14.48 TiB、NVMe 13.78 TiB，×80% 计算）：

| spare（DA1 / DA2） | 含义 | DA1 可用 | 4×400 TiB | DA2 可用 | 4×48 TiB | NVMe 最大片 |
| --- | --- | --- | --- | --- | --- | --- |
| 2 / 2 | 当前，最小默认 | 1,830 TiB | 成立 | 198 TiB | 成立 | 49.6 TiB |
| 5 / 5 | 每节点 1 块 | 1,796 TiB | 成立 | 165 TiB | 不成立 | 41.3 TiB |
| 10 / 10 | 每节点 2 块（2N） | 1,738 TiB | 成立 | 110 TiB | 不成立 | 27.6 TiB |
| 32 / 4 | 相当于 spare-nodes 1 | 1,483 TiB | 不成立 | 176 TiB | 不成立 | 44.1 TiB |

能不能在线上调，还要看该 DA 剩多少未分配的裸容量（free raw）：

- **DA1**：free raw 约 269 TiB，spare 从 2 调到 10 需要 8 × 14.48 ≈ 116 TiB，调完还剩 153 TiB——**可以在线调整**，不需要重建文件系统。可用容量从 1,830 降到 1,738 TiB（−92 TiB，−5%），4 × 400 TiB 的切片仍然成立。这是整个方案里投入产出最好的一项改动，建议采纳。
- **DA2**：4 个 48 TiB 的 NVMe 片全部建好后，DA2 已分配约 98%，free raw 只剩约 5 TiB，连多留 1 块盘（13.78 TiB）都不够。20 块盘分到 5 个节点，每节点只有 4 块，2N 规则要 10 块，等于该 DA 的一半。**NVMe 侧无法上调，属于硬件配置约束**，要么接受，要么在建片之前就缩小 NVMe 片规格。

```bash
# 查看当前 spare 与 free raw
mmvdisk recoverygroup list --recovery-group rg1 --declustered-array
# 调整 DA1 的 spare（参数名以所用版本的 mmvdisk recoverygroup change --help 为准）
mmvdisk recoverygroup change --recovery-group rg1 --declustered-array DA1 --spare-pdisks 10
```

后文的容量数字仍按 spare 2 / 2 计算。如果 HDD 侧采纳 spare 10，只有一处会变：HDD 未划分的机动容量从 230 TiB 变为 138 TiB（12.6% → 7.9%）。

## 元数据：要多少，用什么码

### 要多少：按 HDD 可用容量的 5% 规划

GPFS 的元数据量由**文件数量**决定，和数据总量只通过平均文件大小间接挂钩。所以先算单个文件的元数据开销（inode 4 KiB，Storage Scale 5.x 默认）：

| 项目 | 开销 | 说明 |
| --- | --- | --- |
| inode | 4 KiB | `mmcrfs -i`，可选 512 B / 1 K / 2 K / 4 K |
| 目录项摊销 | ≈ 0.3～0.5 KiB | 目录块本身也是元数据 |
| 间接块 | 0 | 200 KiB 的文件块地址全放得进 inode |
| 扩展属性 | ≈ 0 | 常规 ACL / EA 内联在 4 KiB inode 里 |
| inode 分配图、日志等 | 总量的百分之几 | |
| **合计** | **≈ 4.5～5 KiB** | 相对 200 KiB 数据约 **2.3%～2.5%**，这是理论下限 |

规划值取 **5%（约 1:20）**，而不是理论的 2.5%，余量留给：

- 快照：每次快照要复制发生变化的 inode；
- fileset、ILM、AFM、HSM 等功能的额外结构；
- 真实负载中必然存在的小文件长尾：不到 4 KiB 的小文件数据可以直接存进 inode（data-in-inode），吃的是元数据空间。

有一个调节杠杆：inode 降到 1 KiB 能把元数据压到约 0.8%，但会失去 data-in-inode 和内联扩展属性，小文件性能明显变差。200 KiB 均值的负载下不采用，inode 保持 4 KiB。

按 11 节点口径：

```text
元数据目标可用容量 = HDD 可用 × 5% = 4,027 TiB × 0.05 ≈ 201 TiB
```

这个 201 TiB 直接决定了元数据能用什么冗余方式。

### 用什么码：为什么放弃推荐的副本

[GPFS 核心概念](/learn/gpfs-concepts)里提到常见组合是"元数据 4WayReplication、数据 8+3P"。本方案先验证副本在容量上是否可行（11 节点 NVMe 总裸容量约 546 TiB）：

| 冗余方式 | 效率 | 201 TiB 可用需要的裸容量 | 占 NVMe 裸容量 546 TiB | 结论 |
| --- | --- | --- | --- | --- |
| 4WayReplication | 25% | 201 / 0.25 ≈ 805 TiB | 147%，超出 47% | 物理上不可行 |
| 3WayReplication | 33.3% | 201 / 0.333 ≈ 605 TiB | 111%，超出 11% | 同样不可行 |
| 8+2p | 80% | 201 / 0.80 ≈ 252 TiB | 46.1% | 唯一可行解 |

8+2p 下剩余 546 − 252 = 294 TiB 裸容量，折算可用约 235 TiB，缓存层仍有充足空间。

这张表是验证"5% 目标在哪种码下可行"的可行性测算。最终方案里 SSD **不为元数据单独划分容量**，而是由 system 池统一承载元数据和热数据（见下一节的合并池）。

### 代价要认清：元数据用 8+2p 的性能开销

8+2p 对元数据来说是**空间可行性倒逼的选择**，不是性能上的最优解：

| 维度 | 3WayReplication | 8+2p | 影响 |
| --- | --- | --- | --- |
| 空间效率 | 33.3% | 80% | 8+2p 唯一的优势 |
| 4 KiB inode 更新 | 3 次写 | 3 读 + 3 写（读旧数据、P、Q，重算校验后写回） | 后端 IOPS 约 2 倍，写延迟近似翻倍 |
| 网络扇出（ECE） | 3 个节点 | 10 个 strip 分布在所有节点上 | RPC 尾延迟明显抬高 |
| 正常读 | 1 次读 | 1 次读 | 无差异 |
| 降级 / 重建期读 | 1 次读（读另一副本） | 读 8 个 strip 重构 | 读放大 8 倍，元数据性能断崖 |
| 块大小匹配 | 小块友好 | 4 MiB 块下每个 strip 512 KiB | 4 KiB 写是极度偏斜的部分条带写 |

为什么仍然可以接受：GNR 有 **fast-write log**（logTip / logHome，它本身用复制而不是纠删码），小写先写进日志并快速确认，读改写（RMW）被推到后台合并落盘，前台延迟没有裸 RMW 那么难看。

但写放大、日志带宽压力和降级态的读放大都还在。**运维上的含义是：盘或节点故障期间，元数据延迟会明显劣化，重建窗口必须严格监控并尽量缩短**。这和上一节 5 节点"余量为零"的结论指向同一件事：备件和重建是这套方案的生命线。

## 池布局：合并池与 11 节点切片标准

### 为什么把元数据池和 SSD 缓存池合并

直觉上的做法是 NVMe 上切两类 vdisk set：一类放元数据（metadataOnly），一类放热数据（dataOnly 的缓存池）。问题出在 512 vdisk 的预算上：SSD 侧片数翻倍，直接挤占 HDD 侧的配额。按 11 节点、每侧 9 片计算：

| | 分离方案 | 合并方案（本方案） |
| --- | --- | --- |
| SSD 侧 | Meta 9 片 + Cache 9 片 = 18 个 vdisk set | system 池 9 片 = 9 个 vdisk set |
| SSD 侧消耗 | 18 × 22 = 396 | 9 × 22 = 198 |
| 留给 HDD 的预算 | 489 − 396 = 93 | 489 − 198 = 291 |
| HDD 可切片数 | 93 / 22 → 4 片 | 取与 SSD 对称的 9 片 |
| vdisk 总消耗 | (9+9+4) × 22 + 23 = 507 / 512（99.0%） | (9+9) × 22 + 23 = 419 / 512（81.8%） |
| HDD 单片 | 4,027 / 4 ≈ 1,007 TiB | 4,027 / 9 ≈ 447 → 取 400 TiB |
| 灵活度 | 4 片正好 4 个租户各 1 片，没有机动 | 4 个租户可以各拿 2+2 片，还留 1 片机动 |

分离方案 HDD 只能切 4 片、每片约 1 PiB，粒度太粗，vdisk 占用 99% 几乎没有余量；合并方案 HDD 能切 9 片 × 400 TiB，粒度细了 2.5 倍。代价是元数据和热数据共享同一个 system 池，元数据空间是否够用，要靠 ILM 持续把热数据迁走来保证——后面 ILM 一节会专门校核。

### 为什么按 11 节点定切片规格

5 节点下每个 vdisk set 只消耗 10 个 vdisk，预算很宽裕，很容易"趁现在多切几片、粒度细一点"。但切片数一旦定下，扩容时是沿用的：

```text
反例：5 节点阶段切了 18 片 NVMe + 18 片 HDD
  5 节点：36 × 10 + 11 = 371 / 512   （72.5%，看似安全）
  扩到 11 节点，同样 36 片：
         36 × 22 + 23 = 815 / 512   （超限 59.2%）
  → 扩容后必须推翻重做，数据全部重新迁移

本方案：按 11 节点（扩容后最大 RG 规模）反推切片规格
         18 × 22 + 23 = 419 / 512   （81.8%，扩容前后同一套规格）
```

按实际节点数定规格，不同规模的集群切片大小不一样，运维模板也没法复用。**按目标规模定规格，小规模阶段只是片数少一些**。

### 切片规格：48 TiB NVMe + 400 TiB HDD

| | 11 节点（设计基准） | 5 节点（实际部署，复用同一套规格） |
| --- | --- | --- |
| 每个 vdisk set 的 vdisk 数 | 22 | 10 |
| 日志 vdisk | ≈ 23 | ≈ 11 |
| NVMe | 可用 ≈ 436 TiB → 9 × 48 = 432（99.0%） | 可用 198 TiB → 4 × 48 = 192（96.8%） |
| HDD | 可用 ≈ 4,027 TiB → 9 × 400 = 3,600（89.4%） | 可用 1,830 TiB → 4 × 400 = 1,600（87.4%） |
| vdisk 占用 | 18 × 22 + 23 = 419 / 512（81.8%） | 8 × 10 + 11 = 91 / 512（17.8%） |
| 每个租户文件系统 | 2+2 片：96 TiB system + 800 TiB data | 1+1 片：48 TiB system + 400 TiB data |

NVMe 片原本打算取 50 TiB，但 5 节点实测只有 198 TiB：4 × 50 = 200 > 198 装不下，所以下调为 48 TiB，4 × 48 = 192 ≤ 198，剩 6 TiB。这也说明**切片规格必须用实测容量验证**，估算值差 1% 就可能装不下。

## 多租户：隔离什么，共享什么

单集群服务多个团队，避免每个团队独立建集群造成的资源碎片，SSD 和 HDD 的整体利用率更高，采购和运维成本都能省下来。关键是想清楚隔离到哪一层。

### 多文件系统 vs 多 fileset

[GPFS Day-2](/learn/gpfs-day2) 里对比过三种多租户模型，这里在"每租户一个文件系统"和"每租户一个 fileset"之间选：

| | 多 fileset（共享一个文件系统） | 多文件系统（本方案） |
| --- | --- | --- |
| 元数据 | 所有租户共享同一套元数据和 system 池 | 每个租户独立的 system 池和元数据空间 |
| 元数据干扰 | 一个租户的元数据风暴（海量 create / stat）拖慢所有人 | 元数据 I/O 物理隔离，互不干扰 |
| 代价 | 最省 vdisk | 每个文件系统至少一组 vdisk set，消耗 vdisk 配额 |

对 200 KiB 小文件负载来说，元数据是最容易互相干扰的资源，所以选多文件系统。这正是前面要把 vdisk 预算算得那么细的原因。

### 共享 HDD 的带宽竞争：用 QoS 兜底

多文件系统隔离的是元数据。如果各租户的 data 池在同一批 160 块 HDD 上，租户 A 大批量顺序读写时，租户 B 的 HDD 访问延迟会明显上升。缓解手段有三个：按文件系统设 QoS、错峰调度大任务、关键租户用独立的 HDD 切片（独立的盘而不是共享同一批盘）。

GPFS 的 QoS 按 IOPS 计量，内置两类最常用的流量：`other`（业务 I/O）和 `maintenance`（`mmapplypolicy`、`mmrestripefs` 等维护命令，ILM 迁移就属于这一类）。本方案 4 MiB 块，大 I/O 按 `带宽 ≈ IOPS × 4 MiB` 折算：

| 池 | 类别 | 每个文件系统的配额 | 折算带宽 | 用途 |
| --- | --- | --- | --- | --- |
| system（NVMe） | other | unlimited | — | 元数据和热数据，延迟敏感，不限 |
| system（NVMe） | maintenance | 2000 IOPS | ≈ 8 GB/s | 防止策略扫描冲击元数据 I/O |
| data（HDD） | other | 1000 IOPS | ≈ 4 GB/s | 单租户业务的天花板，防止独占共享盘 |
| data（HDD） | maintenance | 1000 IOPS | ≈ 4 GB/s | ILM 泄洪、重建、restripe |

两个依据：

1. **租户隔离**：4 个租户共享 160 块 HDD，按每块约 180 MB/s 估算聚合顺序带宽约 28 GB/s。`other` 封顶 4 GB/s，某个租户打满时 HDD 仍有约 86% 的能力留给其他租户。
2. **后台流量**：ILM 泄洪的排空速度必须大于业务灌入 system 池的速度，否则 system 池只涨不落，最终威胁元数据空间。一轮泄洪搬 9.6 TiB（推导见 ILM 一节），按 4 GB/s 约 42 分钟，能在下一轮 2 小时的定时任务之前完成；如果只给 250 IOPS，需要 168 分钟，泄洪永远追不上写入。

```bash
# 每个租户文件系统各配一次（mmchqos 写法）
mmchqos fs1 --enable \
  pool=system,other=unlimited,maintenance=2000Iops \
  pool=data,other=1000Iops,maintenance=1000Iops
mmlsqos fs1 --seconds 60 --sum-nodes yes    # 查实际消耗、是否被限流
```

> [!NOTE] mmchqos 与 mmqos
> Storage Scale 5.1 起引入了功能更完整的 `mmqos`（支持按 fileset 自定义类，[GPFS Day-2](/learn/gpfs-day2) 用的就是它），`mmchqos` / `mmlsqos` 作为旧接口保留。新集群建议统一用 `mmqos`，同一个文件系统上不要两套命令混用。等价写法大致是 `mmqos filesystem enable fs1` 之后，用 `mmqos throttle create fs1 --pool data --class maintenance --maxiops 1000` 这样逐条创建限流，具体参数以所用版本文档为准。

几个容易想错的地方：

- 配额是**集群级总量**，由挂载该文件系统的所有节点分摊，不是每节点的值；
- QoS 按 I/O 次数计量，小 I/O 也算一次，所以"IOPS × 4 MiB"是带宽上限而不是实际值；初始值要用 `mmlsqos` 实测校准；
- 4 个文件系统各自有 4 GB/s 的 maintenance 配额，同时泄洪时 HDD 上的后台流量合计可达 16 GB/s，大任务要错峰；
- QoS 管的是数据 I/O，管不住元数据风暴——这正是元数据要靠多文件系统物理隔离的原因。

### 权限隔离：用 mmapi 打通自助供给

配额、fileset 这些变更（`mmsetquota`、`mmcrfileset` 等）只能以 owning 集群管理员权限执行，租户和平台侧都拿不到这个权限。于是：

- 每次扩缩配额、新建 fileset，都要走"提单 → 存储管理员登录 owning 集群手动执行"，响应从数小时到数天；
- Kubernetes CSI 驱动运行在租户 / 平台侧，动态创建卷时要实时下发配额，但它天然没有 owning 集群权限，又不能为此下放完整管理员权限（那会彻底破坏多租户隔离）。CSI 动态供给在"权限"这一环直接断掉。

本方案引入开源的 [mmapi](https://github.com/wutz/mmapi)：部署在 owning 集群侧，把配额和 fileset 的生命周期操作封装成**受限 API**，按租户 / 命名空间做细粒度授权和操作审计，调用方只能执行被授权的操作集。CSI 驱动通过 mmapi 完成配额设置和卷（fileset）的生命周期管理，平台自助发起变更，响应从数小时降到分钟甚至秒级。

## 容量口径与 inode：两个"有空间却写不进"

### df 看到的不是可交付容量

以 5 节点下一个租户文件系统（1 片 NVMe + 1 片 HDD）为例：

```text
df 显示总容量   = system 池 + data 池 = 48 TiB + 400 TiB = 448 TiB   ← 偏乐观
可交付容量      = data 池容量                         = 400 TiB   ← quota 按这个值设
差额            = 48 TiB（占 df 显示值的 10.7%）
```

system 池是缓存层而不是容量层：ILM 持续把数据往 HDD 迁，任何写进 NVMe 的数据最终都要在 data 池有落脚的地方，那 48 TiB 是**周转空间**；而且合并池下它还要常驻元数据，元数据不可回收。如果按 448 TiB 设配额或对租户承诺容量，data 池写满时 `df` 仍然显示有余量，但新数据已经无处可去，表现为"莫名其妙的写入失败"。

所以：**对外承诺和配额都按 data 池计（400 TiB / 文件系统，用 `mmsetquota` 设置），容量监控用 `mmdf` 分池查看，不要只看 `df` 的汇总值**。

5 节点下的整体分配：

```text
集群 HDD 可用（实测）   1,830 TiB
 ├ 已切片分配   4 × 400 = 1,600 TiB（87.4%）  → 4 个租户各 400 TiB 可交付
 └ 未划分机动               230 TiB（12.6%）

集群 NVMe 可用（实测）    198 TiB
 ├ 已切片分配   4 × 48  =   192 TiB
 └ 剩余                       6 TiB           → 已无机动空间
```

HDD 剩余的 230 TiB 不足一个标准 400 TiB 片，保持规格统一就切不出新片。它的用途是：扩节点之后与新增容量合并成整片。

### inode：容量之外的第二个天花板

容量没满，inode 用完了，同样建不了文件。先算单个文件系统的文件数：

```text
文件数        = 400 TiB / 200 KiB = 21.47 亿（恰好等于 2³¹，纯属巧合）
inode 空间    = 21.47 亿 × 4 KiB ≈ 8.0 TiB，占 system 池 48 TiB 的 16.7%
容量公式上限  = 文件系统大小 / (inode 大小 + 子块大小)
              = 448 TiB / (4 KiB + 8 KiB) ≈ 401 亿      （4 MiB 块的子块是 8 KiB）
IBM 测试上限  ≈ 90 亿（随版本变化，上线前按 FAQ 核对）
```

先触顶的是元数据空间，而不是文件计数。平均文件越小，文件数和 inode 空间线性上升：

| 平均文件大小 | 文件数 | inode 空间 | 占 system 池 48 TiB |
| --- | --- | --- | --- |
| 200 KiB | 21.5 亿 | 8.0 TiB | 17% |
| 150 KiB | 28.6 亿 | 10.7 TiB | 22% |
| 100 KiB | 42.9 亿 | 16.0 TiB | 33%，仍在测试上限内，但明显挤压缓存 |
| ≈ 48 KiB | 90 亿 | 33.5 TiB | 70%，缓存被严重挤压——真正的天花板 |

平均文件降到 100 KiB 时，42.9 亿文件仍在测试上限内，但 inode 吃掉 system 池三分之一，缓存命中率下降。**真正的天花板在平均约 48 KiB，到那时应该优先扩 NVMe，而不是拆文件系统**。

```bash
mmchfs fs1 --inode-limit 2200000000       # root fileset 所在 inode space 的上限
mmchfileset fs1 fsetN --inode-limit N     # 独立 fileset 要单独设（CSI 动态供给走这条）
mmdf fs1 -F                               # inode 已用 / 已分配 / 上限
```

几条规则：

- `--inode-limit` 可以在线调大，但不能低于已分配的 inode 数；**已分配的 inode 永远不会回收**，预分配要克制；
- 所有 inode space（root fileset 加所有独立 fileset）的最大 inode 数之和不能超过容量公式的上限。CSI 动态创建 fileset 时最容易踩到，报 `EFSSG0740C` 之类的错误；
- 21.47 亿和 2³¹ 重合只是 400 TiB ÷ 200 KiB 的算术结果。2,147,483,648 是 GPFS 3.3 时代的旧测试上限，早已被取代；架构上限 2⁶⁴、`--inode-limit` 的硬上限 2⁴⁸−2 都远不构成约束。

## ILM：让数据自己流动

### 概念：放置 + 迁移，按单个文件求值

GPFS 的 ILM 由两类规则组成：

- **放置规则**（Placement，`SET POOL`）：文件**创建的那一刻**决定落在哪个池；
- **迁移规则**（Migration，`MIGRATE`）：已有文件在池之间搬动。

GPFS 里没有一个可以"开关"的 ILM 功能——只要文件系统有多个数据池，就必须安装策略（policy），否则新文件只会落在 system 池。策略规则**自上而下匹配，第一条命中的生效**，兜底规则必须放在最后。

整个 ILM 设计最重要的一条认知是：**规则的评估粒度永远是单个文件**。大小、时间、热度，所有条件都是对单个文件独立判定的。理解 LIMIT 和 THRESHOLD 的行为都以此为前提。

### 放置：LIMIT 管的是"新文件放哪"

```text
RULE 'hot' SET POOL 'system' LIMIT(80)
```

它的含义是"创建这个文件时，如果 system 池占用低于 80%，就放进 system 池"，否则这条规则不命中，继续往下匹配。LIMIT 是对**创建那一刻**的判断，不是总量阀门：一个文件在 79% 时被放进 system 池，之后如果写得比剩余空间还大，照样会因为池满而写入失败，GPFS 不会把写到一半的文件自动转到 HDD。所以已知的大文件类型（归档包、视频、checkpoint）要用规则直接放到 data 池，从出生就不进 NVMe。

以 5 节点每个文件系统 48 TiB 的 system 池为例：

```text
LIMIT(80)          = 48 × 0.80 = 38.4 TiB   新文件放置到此为止，之后落 HDD
THRESHOLD(75,55)
  高水位（触发）    = 48 × 0.75 = 36.0 TiB
  低水位（停止）    = 48 × 0.55 = 26.4 TiB
  单次泄洪搬运量    = 36.0 − 26.4 = 9.6 TiB
```

LIMIT 定在 80 而不是 85、90，是给泄洪留缓冲：泄洪是分钟级的批处理，两轮之间突发写入可能把水位继续推高，80% 以上留出的 9.6 TiB 用来吸收这种尖峰，也给大文件留出写完的空间。

### 泄洪：THRESHOLD 迁移需要回调来触发

```text
RULE 'flush' MIGRATE FROM POOL 'system'
  THRESHOLD(75,55)
  WEIGHT((CURRENT_TIMESTAMP - ACCESS_TIME) * KB_ALLOCATED)
  TO POOL 'data'
```

system 池占用超过 75% 时，按"冷度 × 大小"从高到低把文件迁到 data 池，直到占用降到 55%。于是池占用是一个被主动压回 55% 的动态值，不会单向堆积到写满。`WEIGHT` 让"又冷又大"的文件优先出去，一次搬运腾出的空间最多、对热数据影响最小。

> [!WARNING] THRESHOLD 规则不会自己跑起来
> 一个常见误解是"带 THRESHOLD 的规则随 `mmchpolicy` 安装后自动生效，GPFS 自己监测水位触发迁移"。实际上 GPFS 只负责在池占用越过高水位时产生 `lowDiskSpace`（池满时是 `noDiskSpace`）事件，**真正执行迁移需要注册回调**，由回调调用 `mmstartpolicy` 运行已安装策略里的迁移规则：
>
> ```bash
> mmaddcallback MIGRATION --command /usr/lpp/mmfs/bin/mmstartpolicy \
>   --event lowDiskSpace,noDiskSpace \
>   --parms "%eventName %fsName --single-instance"
> mmlscallback MIGRATION
> ```
>
> 漏掉这一步，system 池会一路涨到 LIMIT，之后新文件全部落 HDD，热数据层形同虚设。回调在文件系统管理节点上运行，事件在条件持续期间会周期性重复触发，所以一定要带 `--single-instance`。

`ACCESS_TIME` 的准确度取决于文件系统的 atime 更新方式（`mmlsfs fs1 -S`），如果关闭了 atime 更新，冷度只能退化成用修改时间判断。

### 元数据空间校核：合并池下的稳态

合并池最大的疑问是：元数据和热数据挤在同一个 48 TiB 里，元数据会不会被挤爆？关键在于**元数据不是在抢一块固定预留，而是和"被持续迁走的热数据"共享空间**：

```text
单个租户文件系统（5 节点）：data 池 400 TiB，system 池 48 TiB

元数据需求   理论  21.5 亿 × 4.75 KiB ≈ 9.5 TiB
             工程  400 TiB × 5%        = 20 TiB

泄洪把池占用压回 55% = 26.4 TiB，这是"元数据 + 驻留热数据"的稳态上限
  元数据 9.5 TiB（理论） → 热数据可驻留 26.4 − 9.5  = 16.9 TiB
  元数据 20 TiB（5%）    → 热数据可驻留 26.4 − 20.0 =  6.4 TiB，泄洪照常工作

元数据的真实天花板
  元数据本身超过 LIMIT 38.4 TiB → 新数据不再进 NVMe，system 池退化为纯元数据池
  对应文件数 = 38.4 TiB ÷ 4.75 KiB ≈ 86.8 亿，本方案 21.5 亿，差 4 倍
```

结论有三层：

1. 5% 口径的 20 TiB 元数据可以被稳态容纳。LIMIT(80) 约束的是新数据放置，不是元数据的硬上限；元数据增长会自动挤掉热数据的驻留空间。
2. 元数据增长的代价首先是**性能**而不是可用性：元数据占得越多，缓存热数据的空间越少，命中率下降。只有元数据本身逼近 38.4～48 TiB（按 4.75 KiB/文件约 87～108 亿文件）时才谈得上可用性风险，而这已经是 IBM 测试上限（约 90 亿）的量级。
3. 所以**监控重点是"泄洪是否跟得上写入"**，而不是元数据的绝对值。只要泄洪能把池压回 55%，元数据就一直有空间；泄洪失速（回调没注册、QoS maintenance 配额不足、策略扫描超时）才是真正的风险源。

启用快照会额外消耗元数据（每次快照复制变更的 inode），届时按 `mmdf fs1 -m` 的实测增长趋势评估即可，不需要预先下调 LIMIT。

### 定时迁移：大文件降级与热点回迁

泄洪只在水位越线时发生。另外两件事需要定时做：

- **大文件降级**：SSD 缓存偏小，凡是大于 8 MiB 的文件都迁到 HDD。放置规则只能按文件名判断大文件，没有扩展名的大文件会先进 NVMe，要靠这条规则事后纠正；
- **热点回迁**：GPFS **没有读时自动回迁（promote）机制**，HDD 上被频繁读的小文件不会自己回到 SSD，需要显式配置"小于 1 MiB 且 `FILE_HEAT > 10`"的文件回迁。

阈值和平均文件大小（200 KiB）的关系：

```text
降级阈值   8 MiB / 200 KiB ≈ 40 倍均值   远高于典型文件的大小波动
回迁阈值   1 MiB / 200 KiB ≈  5 倍均值
死区宽度   8 MiB − 1 MiB = 7 MiB ≈ 35 倍均值
```

两条规则方向相反、区间不重叠，中间留出很宽的死区，文件大小的正常波动不会让同一批文件被来回搬运。回迁规则再加一个 `LIMIT(55)`，与泄洪的低水位相同：回迁最多把 system 池填到 55%，永远不会把水位推到触发泄洪的 75%，两者工作区间零重叠，不会形成循环。

### 完整策略

放置规则 + 泄洪规则，用 `mmchpolicy` 安装，常驻生效：

```text title="policy.sql"
/* 已知大文件类型：出生即落 HDD，省一次搬运 */
RULE 'bigtype' SET POOL 'data'
  WHERE LOWER(NAME) LIKE '%.tar' OR LOWER(NAME) LIKE '%.tgz'
     OR LOWER(NAME) LIKE '%.mp4' OR LOWER(NAME) LIKE '%.ckpt'
     OR LOWER(NAME) LIKE '%.safetensors'

/* 归档类 fileset 直接落 HDD */
RULE 'archive' SET POOL 'data' FOR FILESET ('archive')

/* 其余新文件进 SSD；池占用 ≥ 80% 后本规则不命中 */
RULE 'hot' SET POOL 'system' LIMIT(80)

/* 泄洪：75% 触发、压回 55%，又冷又大的先走（需要 lowDiskSpace 回调驱动） */
RULE 'flush' MIGRATE FROM POOL 'system'
  THRESHOLD(75,55)
  WEIGHT((CURRENT_TIMESTAMP - ACCESS_TIME) * KB_ALLOCATED)
  TO POOL 'data'

/* 兜底，必须是最后一条；否则 system 池过 80% 后新建文件直接失败 */
RULE 'default' SET POOL 'data'
```

定时迁移规则，由 `mmapplypolicy` 每 2 小时执行一次，不依赖水位：

```text title="migrate-cron.sql"
/* 大于 8 MiB 的文件降级到 HDD；修改后冷却 1 小时，避免边写边搬 */
RULE 'demote-big' MIGRATE FROM POOL 'system' TO POOL 'data'
  WHERE KB_ALLOCATED > 8192
    AND (CURRENT_TIMESTAMP - MODIFICATION_TIME) > INTERVAL '1' HOURS

/* 热点小文件回迁 SSD；LIMIT(55) 与泄洪低水位一致，不会触发泄洪 */
RULE 'promote-hot' MIGRATE FROM POOL 'data' TO POOL 'system' LIMIT(55)
  WHERE KB_ALLOCATED < 1024 AND FILE_HEAT > 10
```

## 落地手册：从恢复组到策略

前面的决策汇总成一张配置表：

| 项目 | 取值 |
| --- | --- |
| 恢复组 | 单个 RG `rg1`，5 节点实际部署，切片规格沿用 11 节点标准 |
| 纠删码 | 全部 8+2p，SSD 与 HDD 一致，空间效率 80% |
| 池结构 | system 池（NVMe，dataAndMetadata）+ data 池（HDD，dataOnly），块大小统一 4 MiB，inode 4 KiB |
| 切片 | NVMe 48 TiB / 片 × 4，HDD 400 TiB / 片 × 4，vdisk 占用 91 / 512（17.8%） |
| 文件系统 | 4 个租户各 1 片 NVMe + 1 片 HDD；df 448 TiB，可交付 400 TiB |
| spare | DA1 建议在线调到 10，DA2 维持 2（硬件约束） |
| QoS | system：other 不限、maintenance 2000 IOPS；data：other 1000 IOPS、maintenance 1000 IOPS |

按顺序执行（节点类创建、服务器配置等前置步骤见 [GPFS ECE 部署](/learn/gpfs-deploy)）：

```bash
# 1) 创建恢复组
mmvdisk recoverygroup create --recovery-group rg1 --node-class ece5

# 2) （建议）HDD 侧 spare 调到 2N
mmvdisk recoverygroup change --recovery-group rg1 --declustered-array DA1 --spare-pdisks 10

# 3) 定义 vdisk set：SSD → system 池，HDD → data 池；fs2～fs4 同理
mmvdisk vdiskset define --vdisk-set fs1-ssd --recovery-group rg1 \
  --code 8+2p --block-size 4m --set-size 48t \
  --nsd-usage dataAndMetadata --storage-pool system
mmvdisk vdiskset define --vdisk-set fs1-hdd --recovery-group rg1 \
  --code 8+2p --block-size 4m --set-size 400t \
  --nsd-usage dataOnly --storage-pool data

# 4) 全部 define 完先核对：8 组 × 10 + 11 日志 = 91 / 512
mmvdisk vdiskset list --vdisk-set all

# 5) 实例化 vdisk：到这一步才真正占用 vdisk 配额和容量
mmvdisk vdiskset create --vdisk-set fs1-ssd,fs1-hdd

# 6) 建文件系统，显式指定 inode 4 KiB
mmvdisk filesystem create --file-system fs1 \
  --vdisk-set fs1-ssd,fs1-hdd --mmcrfs -i 4096
```

> [!DANGER] 建完文件系统立刻装策略
> 块大小 4 MiB 和 inode 4 KiB 在建文件系统时就定死了，之后不能修改。system 池是 dataAndMetadata，没有策略时所有新文件都落在 system 池——漏装策略会让数据写满 NVMe，直接威胁元数据空间。

```bash
# 7) 文件热度统计（集群级，一次性配置，promote-hot 规则依赖它）
mmchconfig fileHeatPeriodMinutes=1440,fileHeatLossPercent=10

# 8) 先测试再安装放置 + 泄洪策略
mmchpolicy fs1 policy.sql -I test
mmchpolicy fs1 policy.sql -I yes
mmlspolicy fs1 -L

# 9) 注册泄洪回调（集群级一次即可，对所有文件系统生效）
mmaddcallback MIGRATION --command /usr/lpp/mmfs/bin/mmstartpolicy \
  --event lowDiskSpace,noDiskSpace \
  --parms "%eventName %fsName --single-instance"

# 10) QoS、配额、inode 上限
mmchqos fs1 --enable \
  pool=system,other=unlimited,maintenance=2000Iops \
  pool=data,other=1000Iops,maintenance=1000Iops
mmsetquota fs1:root --block 400T:400T     # 或由 mmapi 对各 fileset 下发
mmchfs fs1 --inode-limit 2200000000

# 11) 定时迁移（crontab），--single-instance 防止与回调触发的迁移重入
0 */2 * * * mmapplypolicy fs1 -P /var/mmfs/etc/migrate-cron.sql \
  -N helperNodes -g /gpfs/fs1/.policytmp --single-instance -B 500 -m 8
```

`define` 只登记规格，可以反复调整和 `undefine`；`create` 才真正实例化。先把 8 组全部 define，确认总量无误再 create。`mmapplypolicy` 的 `-N` 指定参与扫描的节点类，`-g` 是这些节点共享的临时目录，`-B`、`-m` 控制每批文件数和每节点线程数，扫描对元数据有压力，要结合 QoS 的 maintenance 配额观察。

## 上线后：监控与校准

LIMIT(80)、THRESHOLD(75,55)、8 MiB / 1 MiB、`FILE_HEAT > 10`、QoS 配额，都是基于估算和经验给出的初始值，要用真实负载持续校准：

| 监控什么 | 怎么看 | 说明 |
| --- | --- | --- |
| 各池水位 | `mmdf fs1`、`mmdf fs1 -m` | system 池是否频繁贴近 80%，元数据增长趋势 |
| 泄洪是否跟得上写入 | 回调日志、`mmapplypolicy` 日志（`/var/adm/ras/mmfs.log.latest`） | 触发频率、单次搬运量、耗时；这是最重要的指标 |
| 是否被 QoS 限流 | `mmlsqos fs1 --seconds 60 --sum-nodes yes` | maintenance 长期打满说明配额偏小 |
| 热度分布 | `mmapplypolicy -I test` 配合 `SHOW(FILE_HEAT)` 的 LIST 规则 | 校准 `FILE_HEAT > 10` 的门槛 |
| inode | `mmdf fs1 -F` | 实际平均文件大小是否偏离 200 KiB |
| 重建窗口 | `mmvdisk pdisk list --recovery-group rg1 --not-ok`、`mmhealth` | 5 节点下这是最大的可用性风险 |

如果实际文件大小分布、访问热度和预估偏差较大，相应调整降级 / 回迁阈值、放置 LIMIT 和泄洪高低水位。建议按季度结合监控数据复盘一次，不要把阈值当成一次性设定、长期不变的静态参数。

## 小结

- **元数据**：按 HDD 可用容量的 5% 规划（11 节点 201 TiB）。这个目标下 4 副本需要 805 TiB、3 副本需要 605 TiB 裸容量，都超过 NVMe 的 546 TiB，8+2p 是唯一可行解；代价是写放大和降级态读放大。
- **冗余**：8+2p 比 8+3p 多出 366 TiB（9.1%）可用容量；5 节点下每节点 2 个 strip，单节点故障就耗尽全部校验，备件响应和重建窗口是生命线。
- **spare**：留 2N 让重建留在本节点，HDD 侧可在线调到 10（−5% 容量），NVMe 侧受硬件约束无法上调。
- **池与切片**：Meta+Cache 合并池让 HDD 能切 9 片 × 400 TiB，粒度是分离方案的 2.5 倍；按 11 节点定规格，避免扩容后 vdisk 超限 59.2%。
- **多租户**：多文件系统物理隔离元数据；共享 HDD 靠 QoS 兜底（other 封顶单租户，maintenance 保障泄洪）；mmapi 做权限隔离，打通 CSI 自动供给。
- **容量口径**：以 `mmvdisk` 实测为准；df 显示 448 TiB，可交付 400 TiB，配额按 400 设。
- **inode**：每个文件系统 21.5 亿文件、8 TiB inode；先触顶的是元数据空间而不是文件计数，平均文件降到约 48 KiB 才是真天花板，届时优先扩 NVMe。
- **ILM**：一切按单个文件求值；LIMIT 管放置不管总量；THRESHOLD 泄洪要靠 `lowDiskSpace` 回调驱动；8 MiB / 1 MiB 的宽死区杜绝来回搬运；监控重点是泄洪是否跟得上写入。

## 动手练习

1. 用 Python 写一个小函数，输入节点数和 vdisk set 数，输出 vdisk 占用（`sets × 2N + 2N + 1`），复算本课的 91、371、419、507、815，再算一算 8 节点、16 节点的 RG 在合并池方案下最多能给几个租户各分 1+1 片。
2. 把"硬件基线"一节的推导换成你手头的一份硬件清单（盘数、单盘 TB、节点数），算出实测可用容量的预估值，并判断 5% 元数据目标下能否用 3WayReplication。
3. 在单节点 Developer Edition 上用两块虚拟盘建一个有 system、data 两个池的文件系统，安装本课的 `policy.sql`（把 LIMIT 和 THRESHOLD 调小以便触发），分别创建 `.ckpt` 文件和普通文件，用 `mmlsattr -L` 查看它们落在哪个池。
4. 在同一环境里先不注册回调，把 system 池写到超过高水位，观察数据是否被迁移；再用 `mmaddcallback` 注册 `lowDiskSpace` 回调，重复实验并在 `mmfs.log.latest` 里找到 `mmstartpolicy` 的执行记录。
5. 写一条 `LIST` 规则配合 `mmapplypolicy -I test`，列出 data 池里小于 1 MiB 的文件及其 `FILE_HEAT`，估计 `promote-hot` 规则每轮会回迁多少数据。

## 自测

<details>
<summary>为什么 ECE 的 RG 节点越多，能建的 vdisk set 反而越少？这对多租户方案有什么影响？</summary>

每个 vdisk set 在每个 user log group 上都要建一个 vdisk，默认每台服务器 2 个 user log group，所以一个 vdisk set 消耗 `2 × 节点数` 个 vdisk，而每个 RG 最多 512 个 vdisk。11 节点时每组消耗 22 个，扣掉约 23 个日志 vdisk 后只能建 22 组。"每租户一个文件系统"至少要一组 SSD、一组 HDD，所以大 RG 能支撑的租户数量有限，片数必须按目标规模规划。

</details>

<details>
<summary>5 节点部署 8+2p，单个节点故障后还能再承受什么故障？为什么 --spare-nodes 1 帮不上忙？</summary>

8+2p 一个条带 10 个 strip，5 节点下每节点 2 个。一个节点故障一次丢掉 2 个 strip，正好耗尽 2 个校验，数据仍可用，但此时再坏任意一块盘就会有条带不可用。即使预留一整个节点的 spare，重建后剩下 4 个节点要放 10 个 strip，必有节点承载 3 个，节点级容错依然为 0。5 节点应该留 2N 的 spare 让盘故障的重建留在本节点，节点故障靠尽快修复。

</details>

<details>
<summary>元数据按 HDD 可用容量 5% 规划，为什么最终选了 8+2p 而不是 IBM 常推荐的副本？代价是什么？</summary>

11 节点下 5% 目标是 201 TiB 可用，4 副本需要约 805 TiB 裸容量、3 副本需要约 605 TiB，都超过 NVMe 总裸容量 546 TiB，物理上放不下；8+2p 只需约 252 TiB。代价是 4 KiB 元数据更新变成 3 读 3 写的读改写，后端 IOPS 约翻倍，网络扇出更大，降级期间读放大 8 倍。GNR fast-write log 能缓解前台延迟，但盘或节点故障期间元数据延迟会明显劣化。

</details>

<details>
<summary>一个租户文件系统 df 显示 448 TiB，为什么配额只能设 400 TiB？</summary>

448 TiB 是 system 池 48 TiB 加 data 池 400 TiB。system 池是缓存和元数据层，ILM 会把数据持续迁到 data 池，写进 NVMe 的数据最终都要在 HDD 上有位置，元数据还要常驻其中。按 448 TiB 承诺容量，data 池写满时 df 仍显示有空间但写入失败。可交付容量只能按 data 池计。

</details>

<details>
<summary>安装了带 THRESHOLD(75,55) 的策略，system 池却一路涨到 80% 以上没有迁移，最可能是什么原因？</summary>

没有注册 `lowDiskSpace` / `noDiskSpace` 回调。GPFS 在池占用越过高水位时只产生事件，需要通过 `mmaddcallback` 让事件调用 `mmstartpolicy` 才会真正执行迁移。其他可能的原因包括 QoS maintenance 配额太小导致迁移极慢、`mmapplypolicy` 扫描失败或被 `--single-instance` 挡在一次长时间运行之后，都要看 `mmfs.log.latest` 和 `mmlsqos`。

</details>

<details>
<summary>降级阈值 8 MiB、回迁阈值 1 MiB，回迁规则还带 LIMIT(55)，这些设计分别防止什么？</summary>

两个阈值之间 7 MiB（约 35 倍平均文件大小）的死区让降级和回迁的区间互不重叠，文件大小正常波动不会导致同一批文件来回搬运。回迁的 LIMIT(55) 与泄洪低水位一致，回迁最多把 system 池填到 55%，不会把水位推到触发泄洪的 75%，避免"回迁 → 泄洪 → 再回迁"的循环。

</details>

## 参考资料

- [IBM Storage Scale 官方文档](https://www.ibm.com/docs/en/storage-scale)
- [IBM Storage Scale ECE 文档：mmvdisk 命令](https://www.ibm.com/docs/en/storage-scale-ece/5.2.3?topic=commands-mmvdisk-command)
- [IBM Storage Scale 文档：mmchpolicy 命令](https://www.ibm.com/docs/en/storage-scale/5.2.3?topic=reference-mmchpolicy-command)
- [IBM Storage Scale 文档：mmapplypolicy 命令](https://www.ibm.com/docs/en/storage-scale/5.2.3?topic=reference-mmapplypolicy-command)
- [IBM Storage Scale 文档：mmaddcallback 命令](https://www.ibm.com/docs/en/storage-scale/5.2.3?topic=reference-mmaddcallback-command)
- [IBM Storage Scale 文档：mmchqos 命令](https://www.ibm.com/docs/en/storage-scale/5.2.3?topic=reference-mmchqos-command)
- [IBM Storage Scale 文档：mmqos 命令](https://www.ibm.com/docs/en/storage-scale/5.2.3?topic=reference-mmqos-command)
- [IBM Storage Scale FAQ（文件数等测试上限）](https://www.ibm.com/docs/en/STXKQY/gpfsclustersfaq.html)
- [wutz/mmapi：GPFS 配额与 fileset 的受限 API 服务](https://github.com/wutz/mmapi)
