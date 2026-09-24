# 元数据与分布式文件系统

对象存储把命名空间砍成了扁平字典，换来近乎无限的扩展性。可大量应用离不开 POSIX：训练脚本用 `open()` 读数据、`os.rename()` 原子地替换 checkpoint，HPC 作业几千个进程同时往一个目录写结果。分布式文件系统要在几百台机器上假装自己是"一块本地盘"，最难的部分从来不是数据，而是**元数据**。

学完这一课，你能说清 POSIX 语义里哪些承诺在分布式环境下代价高昂；比较单 MDS、分区 MDS、分布式 KV 三种元数据扩展方式；理解"数据与元数据分离"这条几乎所有现代分布式文件系统都遵守的原则；对比 CephFS、GPFS、JuiceFS、3FS 的设计取舍；并用 JuiceFS 在单机上亲眼看到元数据和数据被拆开存放。

## 元数据是什么，为什么是瓶颈

[文件系统](/learn/filesystems)那一课讲过：文件系统 = 数据块 + 元数据。元数据包括 inode（大小、权限、属主、时间戳、数据块位置）、目录项（名字 → inode 的映射）、扩展属性、锁。

看一眼一次普通的 `open("/data/train/0001.jpg")` 需要多少元数据操作：

```text
lookup("/")  → lookup("data") → lookup("train") → lookup("0001.jpg")   逐级解析路径
getattr(inode)                                                          权限检查
open(inode)                                                             打开状态、可能的锁
read(...)                                                               ← 这里才开始碰数据
close()                                                                 可能要更新 mtime/atime、刷写属性
```

本地文件系统里这些都在内存中完成，几微秒。分布式文件系统里每一步都可能是一次网络往返。读一个 100 KiB 的小文件，元数据操作的时间可能是数据传输的好几倍。**小文件多、目录深、元数据操作密集**的负载（AI 训练读海量图片、编译、`ls -lR`、`find`）在分布式文件系统上表现最差，原因就在这里。

## POSIX 语义的代价

POSIX 是为单机设计的，它的很多承诺默认了"只有一个内核在管理这个文件系统"。搬到分布式环境里，每一条都要付出代价：

| POSIX 承诺 | 单机实现 | 分布式的代价 |
|---|---|---|
| `write()` 返回后，其他进程的 `read()` 立即可见 | 共享同一份页缓存 | 客户端各有缓存，要么不缓存，要么用锁/租约让缓存失效 |
| `rename()` 原子 | 一把目录锁 + 一次日志事务 | 源目录和目标目录可能在不同元数据服务器上，需要分布式事务 |
| 同一目录并发创建文件 | 目录 inode 上的锁，微秒级 | 所有客户端争同一个目录的锁，"热目录"成为全局瓶颈 |
| `readdir` 看到一致的目录内容 | 遍历本地目录结构 | 目录可能被分片到多台服务器，边列举边被修改 |
| 字节范围锁 `fcntl()` | 内核锁表 | 分布式锁管理器，客户端崩溃后要回收锁 |
| `atime` / `mtime` 精确更新 | 改内存里的 inode | 每次读都要改元数据，放大写入（所以普遍用 `noatime`/`relatime`） |

不同系统在这里做了不同的妥协：

- **严格 POSIX**：GPFS、CephFS 通过分布式锁（token/capability）保证跨节点的即时可见性。代价是锁的协调开销，以及多个客户端同时写同一文件时性能骤降；
- **close-to-open**：NFS、JuiceFS 只保证"A 关闭后 B 再打开能看到"，[网络存储](/learn/network-storage)那一课已经见过。对"一个写、之后多个读"的负载足够，实现简单得多；
- **更弱的语义**：3FS 这类为 AI 负载设计的系统，放弃了一部分传统语义（如不依赖客户端缓存、写入中的文件长度延迟更新）来换取极致吞吐。

> [!TIP] 先弄清楚应用需要什么语义
> 大多数 AI 训练、数据分析负载是"一次写入，多次读取"，并不需要多客户端对同一文件的强一致并发写。选型时问清楚：有没有多个节点同时写同一个文件？是否依赖 `rename` 的原子性（比如 checkpoint 先写临时文件再改名）？依赖文件锁吗？答案决定了你能不能用更便宜、更快的弱语义系统。

### 一个真实的例子：checkpoint 的写法

训练框架保存 checkpoint 的标准写法，恰好同时踩中 `fsync` 和 `rename` 两条语义：

```python title="save_ckpt.py"
import os

def save_atomic(path: str, data: bytes):
    tmp = path + ".tmp"
    with open(tmp, "wb") as f:
        f.write(data)
        f.flush()
        os.fsync(f.fileno())          # 1. 数据真正持久化
    os.rename(tmp, path)              # 2. 原子替换：读者要么看到旧文件，要么看到新文件
    dfd = os.open(os.path.dirname(path) or ".", os.O_DIRECTORY)
    os.fsync(dfd)                     # 3. 让目录项的修改也持久化
    os.close(dfd)
```

在本地 ext4/XFS 上这是教科书写法。换到分布式文件系统上，要逐条确认：`fsync` 是否真的等到了多副本落盘？`rename` 在同一目录内是否原子（绝大多数系统是）？跨目录呢？对象存储挂载（s3fs 之类）上，第 2 步会退化成"复制整个文件再删除"，既慢又不原子。更隐蔽的问题是**热目录**：1024 个 rank 同时往 `ckpt/step-1000/` 里创建文件，所有创建请求争同一个目录的锁，元数据服务上这一个目录成了全局热点。常见的缓解办法是每个 rank 写自己的子目录，或者只让少数 rank 负责写。

## 元数据服务的扩展方式

### 数据与元数据分离

几乎所有现代分布式文件系统都遵循同一个原则：**元数据走元数据服务，数据由客户端直接读写存储节点**。元数据请求量大但每次很小，数据请求量相对少但每次很大，两者的扩展方式完全不同，分开才能各自优化。

```text
                ┌──────────────┐
    ① 元数据    │  元数据服务   │   路径解析、权限、inode、
  ┌───────────▶ │  (MDS / KV)  │   数据块位置
  │             └──────────────┘
客户端
  │   ② 数据    ┌──────┐ ┌──────┐ ┌──────┐
  └───────────▶ │存储 1│ │存储 2│ │存储 3│ ...   客户端直接并行读写，
                └──────┘ └──────┘ └──────┘         带宽随存储节点线性扩展
```

数据侧的扩展已经在前几课解决了（CRUSH、EC、对象存储）。真正的难点是元数据侧。

### 三种扩展方式

| 方式 | 做法 | 优点 | 瓶颈 | 代表 |
|---|---|---|---|---|
| 单 MDS（+ 热备） | 一台服务器管理整个命名空间，元数据全在内存 | 简单，所有操作都是本地事务 | 单机内存和 CPU，通常几亿文件 | HDFS NameNode、早期 Lustre、JuiceFS + 单机 Redis |
| 分区 MDS | 按目录子树把命名空间切给多台 MDS | 按子树扩展，局部性好 | 负载不均（热子树）、跨 MDS 的 rename 复杂 | CephFS 多活 MDS、Lustre DNE |
| 分布式 KV / 数据库 | 元数据存成 KV（如 `父inode+名字 → inode`），元数据服务无状态 | 容量和吞吐随 KV 集群扩展，事务由数据库保证 | 每次操作都要访问 KV，延迟比内存高；依赖数据库的事务性能 | JuiceFS + TiKV、3FS + FoundationDB |
| 无中心（分布式锁） | 元数据分散存放在所有盘上，用分布式锁协调谁能改 | 没有单独的元数据瓶颈 | 锁的争用和协调开销 | GPFS |

把目录树存进 KV 的常见编码方式：

```text
目录项:  E | 父 inode | 名字   →  子 inode, 类型
inode:   I | inode             →  属性（大小、权限、mtime...）
数据块:  C | inode | 块序号     →  切片列表（在对象存储里的位置）
```

`lookup` 是一次点查，`readdir` 是一次前缀扫描，`rename` 是一个同时删改几条 KV 的事务——只要底层 KV 支持跨节点事务（TiKV、FoundationDB 都支持），POSIX 的原子性就交给数据库保证了。

## 四个系统的设计取舍

### CephFS：RADOS 之上的分区 MDS

CephFS 的数据和元数据都存在 RADOS 里（分别是数据池和元数据池），MDS 守护进程本身不存数据，只是把元数据缓存在内存中并记日志。

- **扩展**：可以运行多个活跃 MDS（`max_mds`），用动态子树分区自动迁移热点目录，也可以用 `ceph.dir.pin` 扩展属性手动把目录固定到某个 MDS；
- **一致性**：MDS 给客户端发放**能力**（capabilities，简称 caps），持有读缓存 cap 的客户端才能缓存数据，有其他客户端要写时 MDS 召回 cap。这样实现了接近严格的 POSIX 语义；
- **痛点**：MDS 缓存吃内存（`mds_cache_memory_limit`），客户端不及时归还 caps 会拖慢整个文件系统，千万级文件的单目录很难受。

细节在阶段 4 的 [RBD 与 CephFS](/learn/ceph-rbd-cephfs) 里展开。

### GPFS：分布式锁代替元数据服务器

IBM Storage Scale（GPFS）起源于共享磁盘架构：所有节点都能直接访问所有盘（通过 SAN 或 NSD 协议），**没有专门的元数据服务器**，元数据和数据一样条带化分布在所有盘上。

- **Token 管理**：谁要读写某个文件或某段字节范围，先向 token manager 申请 token。不同节点可以同时持有同一文件不同字节范围的写 token，所以多节点并行写同一个大文件的性能很好（HPC 的 MPI-IO 场景）；
- **metanode**：每个打开的文件有一个 metanode 节点负责合并更新 inode，其他节点直接读写数据块；
- **仲裁**：quorum 节点用多数派决定集群是否存活，丢失仲裁的一方会卸载文件系统，从机制上杜绝脑裂。

GPFS 是这几个系统里 POSIX 语义最完整、生产历史最长（1998 年起）的一个，代价是商业授权和较高的运维门槛。阶段 5 的 [GPFS 核心概念](/learn/gpfs-concepts) 会详细讲 token、仲裁和多集群。

### JuiceFS：元数据引擎 + 对象存储

JuiceFS 把分布式文件系统拆成两个"外包"出去的部件：

```text
 JuiceFS 客户端（FUSE / CSI / SDK）
    │ 元数据                          │ 数据（切成 chunk → slice → block）
    ▼                                 ▼
 元数据引擎                           对象存储
 Redis / PostgreSQL / MySQL / TiKV    S3 / Ceph RGW / Ceph RADOS / RustFS ...
```

- **数据布局**：文件按 64 MiB 切成 chunk，每次写入产生 slice，slice 再按 4 MiB（默认）切成 block 作为对象上传。对象从不被修改，覆盖写只是产生新的 slice，后台再做合并与回收；
- **元数据引擎选型**：团队的经验是，Redis 适合 1 亿文件以下、对一致性要求不高的场景（开发测试用单机 Redis 即可）；PostgreSQL 适合 10 亿级别；TiKV 适合 100 亿级别、强一致要求高的生产环境；
- **一致性**：close-to-open，另有可调的元数据缓存；
- **性能关键**：客户端本地缓存盘。在机械盘构建的对象存储上，配合计算节点的 NVMe 缓存，能以低成本得到不错的读性能。对象存储后端可以是 Ceph RGW，也可以直接用 Ceph RADOS 接口，省掉 RGW 这一层协议转换和负载均衡。

### 3FS：为 AI 训练设计的 FoundationDB + CRAQ + RDMA

3FS（Fire-Flyer File System）是 DeepSeek 开源的分布式文件系统，目标非常明确：用现代 NVMe SSD 和 RDMA 网络，为大规模训练和推理（数据加载、checkpoint、KVCache）提供极高的聚合吞吐。官方公布的数据是 180 个存储节点聚合读吞吐约 6.6 TiB/s。

- **元数据**：元数据服务无状态，元数据全部存在 FoundationDB 里，利用它的可串行化事务实现文件操作的原子性；
- **数据复制**：用 CRAQ（Chain Replication with Apportioned Queries，链式复制 + 分摊读）保证强一致：写入沿着链从头传到尾，读可以由链上任一节点服务；
- **网络与客户端**：存储节点之间、客户端与存储之间全部走 RDMA；除了 FUSE 客户端，还提供 USRBIO 用户态零拷贝 I/O 接口给训练框架直接调用；
- **取舍**：AI 训练的数据读取基本是随机、一次性的，缓存命中率低，所以 3FS 不依赖客户端数据缓存，而是追求原始吞吐。

部署上它对硬件有明确要求：团队的实践是元数据存储至少 3 个节点、各配独立 SSD；数据存储节点配 RDMA 网卡和多块独立 NVMe；元数据与数据的可用容量配比约 4.8 GiB : 1 TiB。

### 对比

| 维度 | CephFS | GPFS | JuiceFS | 3FS |
|---|---|---|---|---|
| 元数据 | 多活 MDS，存于 RADOS | 无专用 MDS，分布式 token | 外部数据库（Redis/PG/TiKV） | 无状态服务 + FoundationDB |
| 数据 | RADOS（副本/EC） | NSD，GNR 纠删码 | 任意对象存储 | 自有存储服务，CRAQ 链式复制 |
| 一致性 | 接近严格 POSIX（caps） | 严格 POSIX（token） | close-to-open | 为 AI 负载放宽部分语义 |
| 网络 | TCP（RDMA 支持有限） | TCP / RDMA | TCP | RDMA 必需 |
| 强项 | 与 RBD/RGW 统一存储，开源 | 成熟、HPC 并行写、多集群 | 部署简单、成本低、云上云下通用 | AI 训练极致吞吐 |
| 弱项 | MDS 调优复杂，海量小文件吃力 | 商业授权，运维门槛高 | 依赖元数据引擎和对象存储的质量 | 硬件要求高，通用性有限 |

## 小文件问题

小文件问题是元数据问题的集中体现。假设训练集是 1 亿张 100 KiB 的图片（约 10 TB）：

- **元数据量**：1 亿个 inode 和目录项，单 MDS 的内存很可能装不下，需要分区或分布式 KV；
- **操作数**：每读一个文件至少 `lookup` + `open` + `read` + `close`，元数据 QPS 是数据 QPS 的好几倍；
- **后端放大**：在对象存储或 EC 池上，每个小文件都要付最小分配单元和每请求开销（见[副本与纠删码](/learn/replication-ec)）；
- **遍历**：`ls`、`du`、`find`、`rsync` 都变成数百万次元数据调用，一次全量扫描可能要几小时。

应对办法按优先级排列：

1. **从源头合并**：打包成 tar 分片、WebDataset、TFRecord、LMDB 或 Parquet，把 1 亿个文件变成几万个大文件。这比任何存储调优都有效；
2. **目录打散**：不要把几百万个文件放进同一个目录，按哈希分两到三级子目录；
3. **选对元数据架构**：文件数到十亿级，选分布式 KV 元数据或多活 MDS 的系统；
4. **利用客户端元数据缓存**：只读数据集可以把元数据缓存时间调长（JuiceFS 的 `--attr-cache`/`--entry-cache`，NFS 的 `actimeo`）。

## 动手：用 JuiceFS 看清元数据与数据分离

沿用[对象存储](/learn/object-storage)那一课启动的 RustFS，元数据用最简单的 SQLite，在单机上跑一个 JuiceFS：

```bash
sudo apt install -y fuse3 sqlite3
curl -sSL https://d.juicefs.com/install | sh -
juicefs version

juicefs format --storage minio --bucket http://127.0.0.1:9000/jfs \
  --access-key rustfsadmin --secret-key rustfsadmin \
  sqlite3://$HOME/jfs.db myjfs
mkdir -p ~/jfs
juicefs mount -d sqlite3://$HOME/jfs.db ~/jfs
df -h ~/jfs
```

`--storage minio` 表示使用路径风格访问的 S3 兼容服务，对 RustFS 同样适用；`format` 会自动创建桶。写点数据，然后分别看两边存了什么：

```bash
dd if=/dev/urandom of=~/jfs/big.bin bs=1M count=10
mkdir -p ~/jfs/dir && echo hello > ~/jfs/dir/a.txt

# 数据：对象存储里只有一堆编号的 block，看不出文件名和目录结构
aws s3 ls s3://jfs/myjfs/chunks/ --recursive | head -5

# 元数据：目录树、inode、切片信息都在数据库里
sqlite3 ~/jfs.db '.tables'
sqlite3 ~/jfs.db 'select parent, name, inode, type from jfs_edge;'
```

```console
$ aws s3 ls s3://jfs/myjfs/chunks/ --recursive | head -5
2026-09-24 10:21:03    4194304 myjfs/chunks/0/0/1_0_4194304
2026-09-24 10:21:03    4194304 myjfs/chunks/0/0/1_1_4194304
2026-09-24 10:21:03    2097152 myjfs/chunks/0/0/1_2_2097152
2026-09-24 10:21:05          6 myjfs/chunks/0/0/2_0_6
$ sqlite3 ~/jfs.db 'select parent, name, inode, type from jfs_edge;'
1|big.bin|2|1
1|dir|3|2
3|a.txt|4|1
```

10 MiB 的文件被切成了 4 + 4 + 2 MiB 三个 block；目录 `dir` 在对象存储里根本不存在，只是数据库里的一行。现在体会一下元数据操作的差别：

```bash
time mv ~/jfs/big.bin ~/jfs/dir/renamed.bin        # 只改一行元数据，瞬间完成
time aws s3 mv s3://demo/big.bin s3://demo/moved/big.bin   # 对象存储：复制 + 删除

# 元数据密集负载：创建 1 万个空文件，对比本地盘、NFS 与 JuiceFS
for d in /tmp/meta-test /mnt/nfs/meta-test ~/jfs/meta-test; do
  mkdir -p $d; echo "== $d"; ( time (cd $d && seq 1 10000 | xargs touch) ) 2>&1 | grep real
done
juicefs stats ~/jfs          # 另开终端，实时查看元数据与对象存储请求
```

你会看到本地盘在几十毫秒内完成，NFS 和 JuiceFS 则要慢一到两个数量级——每次创建都是一次网络往返加一次元数据事务。实验结束后 `juicefs umount ~/jfs`。

> [!PROD] 生产部署别用 SQLite
> SQLite 只能单机访问，这里只是为了看清结构。多节点共享必须用网络可达的元数据引擎，并且元数据引擎的可用性和备份决定了整个文件系统的生死：对象存储里的 block 没有元数据就只是一堆无法还原的碎片。务必定期执行 `juicefs dump` 备份元数据。

## 动手练习

1. 按本课步骤部署 JuiceFS，写入一个 30 MiB 的文件后，再用 `dd conv=notrunc seek=5 bs=1M count=1` 覆盖其中 1 MiB，对比覆盖前后对象存储中的 block 列表，理解"对象不可修改、覆盖产生新 slice"。
2. 在 JuiceFS 挂载点上分别运行 `juicefs bench ~/jfs`，记录大文件读写吞吐和小文件每秒操作数，指出哪一项最先成为瓶颈。
3. 把第 1 课的 NFS 挂载改成 `actimeo=0` 与 `actimeo=600` 两种，重复"创建 1 万个空文件"和"`ls -l` 一个含 1 万个文件的目录"的测试，解释差别。
4. 用两个终端模拟两个客户端（JuiceFS 可在同一台机器上挂载两个挂载点），在一边追加写文件不关闭，另一边读取，验证 close-to-open 语义。
5. 阅读 3FS 的设计文档，用三五句话总结 CRAQ 的写入和读取流程，以及它相比普通主备复制的优势。

## 自测

<details>
<summary>为什么分布式文件系统在海量小文件场景下表现差？瓶颈主要在数据还是元数据？</summary>

主要在元数据。每个小文件的读取都需要路径解析、getattr、open、close 等多次元数据操作，每次都可能是网络往返，而数据本身很小，传输时间占比低。此外海量文件带来巨大的 inode 和目录项数量，对元数据服务的内存、事务吞吐都是压力。

</details>

<details>
<summary>在元数据分区到多台 MDS 的系统中，为什么跨目录 rename 是难题？</summary>

POSIX 要求 rename 原子完成。源目录和目标目录可能由不同的 MDS 管理，rename 需要同时修改两台服务器上的目录项，必须通过分布式事务或两阶段提交保证要么都成功要么都失败，并处理中途某台 MDS 故障的情况，实现复杂且代价高。

</details>

<details>
<summary>GPFS 没有专门的元数据服务器，它如何保证多个节点并发修改时的一致性？</summary>

GPFS 使用分布式锁管理：节点在读写文件或字节范围之前向 token manager 申请相应的 token，拿到写 token 才能修改，其他节点的冲突 token 会被召回。每个打开的文件还有一个 metanode 负责合并 inode 更新。此外仲裁机制保证只有持有多数派的一方能继续访问文件系统，避免脑裂。

</details>

<details>
<summary>JuiceFS 的对象存储中能看到原始文件名和目录结构吗？元数据引擎丢失会怎样？</summary>

看不到。对象存储中只有按切片编号命名的 block，文件名、目录结构、文件与 block 的对应关系全部在元数据引擎里。元数据引擎丢失而没有备份时，对象存储中的数据无法还原成文件，等同于整个文件系统丢失，所以元数据引擎的高可用和定期备份（`juicefs dump`）至关重要。

</details>

<details>
<summary>3FS 为什么不依赖客户端数据缓存？它适合什么负载、不适合什么负载？</summary>

AI 训练的数据读取通常是对大数据集的随机、单次遍历，缓存命中率很低，缓存反而带来一致性开销和内存占用；3FS 选择依靠 RDMA 和大量 NVMe 提供的原始吞吐。它适合大规模训练数据加载、checkpoint、推理 KVCache 等高吞吐负载；不适合需要严格 POSIX 语义、依赖客户端缓存加速的通用负载，也不适合没有 RDMA 网络的环境。

</details>

## 参考资料

- [Ceph 文档：CephFS](https://docs.ceph.com/en/latest/cephfs/)
- [Ceph 文档：Configuring multiple active MDS daemons](https://docs.ceph.com/en/latest/cephfs/multimds/)
- [Ceph 文档：Capabilities in CephFS](https://docs.ceph.com/en/latest/cephfs/capabilities/)
- [IBM Storage Scale 文档](https://www.ibm.com/docs/en/storage-scale)
- [JuiceFS 文档：架构](https://juicefs.com/docs/zh/community/architecture)
- [JuiceFS 文档：如何选择元数据引擎](https://juicefs.com/docs/zh/community/databases_for_metadata)
- [3FS 项目主页](https://github.com/deepseek-ai/3FS)
- [3FS 设计笔记](https://github.com/deepseek-ai/3FS/blob/main/docs/design_notes.md)
- [Jeff Terrace、Michael J. Freedman：Object Storage on CRAQ（USENIX ATC'09）](https://www.usenix.org/legacy/event/usenix09/tech/full_papers/terrace/terrace.pdf)
- [Frank Schmuck、Roger Haskin：GPFS: A Shared-Disk File System for Large Computing Clusters（FAST'02）](https://www.usenix.org/legacy/events/fast02/full_papers/schmuck/schmuck.pdf)
