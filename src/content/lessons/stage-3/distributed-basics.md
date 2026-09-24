# 分布式存储基础

上一课的 NFS 和 iSCSI 本质上还是"一台服务器 + 网线"：服务器就是天花板，也是单点。分布式存储要把数据摊到几十、几百台机器上，这时候冒出来三个绕不开的问题：**数据放在哪**、**多份数据怎么保持一致**、**坏了怎么办**。Ceph、GPFS、MinIO、JuiceFS……每个系统的设计文档，本质上都是在回答这三个问题。

学完这一课，你能解释哈希取模、一致性哈希和 CRUSH 式放置各自的优缺点，并用几十行 Python 亲手验证；能用 W+R>N 判断一个法定人数配置是否强一致；知道 Paxos/Raft 在存储系统里负责什么；会按故障域设计放置规则，并用 AFR 和 MTTR 粗算一套集群的可用性。

## 为什么要分布式

单机存储能走多远？一台 2U 服务器塞 24 块 30 TB 的 NVMe，裸容量 720 TB，看起来很多。但它有三道墙：

| 维度 | 单机的墙 | 分布式怎么破 |
|---|---|---|
| 容量 | 盘位有限，一台机器最多几百 TB 到 1～2 PB | 加机器，容量线性增长 |
| 性能 | 网卡（2×100 GbE ≈ 25 GB/s）、PCIe 通道、CPU 都有上限 | 客户端并行访问多台服务器，聚合带宽随节点数增长 |
| 可用性 | 主板、电源、系统盘任何一个坏了，数据全部不可访问 | 数据多份存放在不同机器，坏一台照样服务 |

代价同样明确：网络延迟、一致性协议的开销、复杂得多的运维。

> [!TIP] 能不分布式就不分布式
> 几十 TB、单一应用、能接受分钟级停机的场景，一台带 RAID 的服务器加定期备份往往比一套三节点分布式存储更可靠——因为出问题时你看得懂它。分布式存储的收益要到一定规模才能覆盖它的复杂度。[容量与性能规划](/learn/capacity-planning)里会专门讨论"何时不该选 Ceph"。

## 数据分布：一个对象该放在哪

给定一个对象名 `photos/2026/cat.jpg`，系统必须能回答"它在哪几台机器上"。写的时候要回答，读的时候也要回答，而且答案必须一致。有四种基本思路。

### 集中式元数据表

最直接：建一张表，记录每个对象（或每个数据块）在哪。HDFS 的 NameNode、GFS 的 Master、很多商业 NAS 都是这样。

```text
客户端 ──"cat.jpg 在哪?"──▶ 元数据服务器 ──"node3, node7, node9"──▶ 客户端 ──读写──▶ node3...
```

- 优点：放置完全灵活，可以按容量、负载任意调度，迁移数据只需改表；
- 缺点：元数据服务器是瓶颈和单点，每次访问多一跳；表的规模随对象数增长，几十亿对象时内存装不下。

### 哈希取模

`node = hash(key) % N`。任何客户端都能自己算出位置，不需要查表。问题出在扩容：N 从 10 变成 11，几乎每个 key 的余数都变了，**约 91% 的数据需要搬家**。

### 一致性哈希

Amazon Dynamo、OpenStack Swift、Cassandra 用的是一致性哈希（Consistent Hashing）：把哈希空间想象成一个环，每个节点在环上占若干个点（虚拟节点），key 顺时针找到的第一个节点就是它的归属。

```text
                 0
            ┌────●────┐           ● = 节点的虚拟节点
       nodeC●          ●nodeA     ○ = key
           │   ○ key1   │         key1 顺时针遇到的第一个节点是 nodeA
       nodeB●          ●nodeC     新增 nodeD 只会"切走"它两侧一小段
            └────●────┘
               nodeB
```

新增一个节点，它只接管环上相邻的一小段，其他数据纹丝不动。虚拟节点让每台机器在环上分散成很多段，负载更均匀，也方便按权重分配（大盘多给几个虚拟节点）。

动手验证一下两者的差别：

```python title="placement.py"
import hashlib, bisect

def h(s: str) -> int:
    return int.from_bytes(hashlib.md5(s.encode()).digest()[:8], "big")

KEYS = [f"obj-{i}" for i in range(100_000)]

def mod_n(nodes):
    return {k: nodes[h(k) % len(nodes)] for k in KEYS}

def ring(nodes, vnodes=100):
    points = sorted((h(f"{n}#{v}"), n) for n in nodes for v in range(vnodes))
    hashes = [p[0] for p in points]
    def lookup(k):
        i = bisect.bisect(hashes, h(k)) % len(points)
        return points[i][1]
    return {k: lookup(k) for k in KEYS}

def moved(a, b):
    return sum(a[k] != b[k] for k in KEYS) / len(KEYS)

old = [f"node{i}" for i in range(10)]
new = old + ["node10"]
print(f"哈希取模   10→11 节点，迁移比例: {moved(mod_n(old), mod_n(new)):.1%}")
print(f"一致性哈希 10→11 节点，迁移比例: {moved(ring(old), ring(new)):.1%}")
print(f"理论最小迁移比例: {1/11:.1%}")
```

```console
$ python3 placement.py
哈希取模   10→11 节点，迁移比例: 90.9%
一致性哈希 10→11 节点，迁移比例: 9.0%
理论最小迁移比例: 9.1%
```

一致性哈希几乎达到了理论最优：新节点应该分到 1/11 的数据，就只搬 1/11。

### CRUSH 式伪随机确定性放置

一致性哈希解决了扩容问题，但它不认识"机架"：三个副本完全可能落在同一个机柜里，机柜断电就三副本全灭。Ceph 的 **CRUSH**（Controlled Replication Under Scalable Hashing）在"客户端自己算、不查表"的基础上，加入了两样东西：

1. **层级拓扑**：集群被描述成一棵树（root → 机房 → 机架 → 主机 → 盘），每个节点带权重；
2. **放置规则**：比如"从 root 出发，选 3 个不同的主机，每个主机里选 1 块盘"。

CRUSH 在每一层用 **straw2** 算法挑选子节点：每个候选根据 `hash(key, 候选)` 抽一根"签"，签长按权重缩放，最长者胜。因为每个候选的签只和它自己有关，新增一个候选时，只有被新候选"抽赢"的那部分 key 会迁移，而且只迁往新候选。用 Python 模拟一下：

```python title="straw2.py"
import hashlib, math

def u(key: str, item: str) -> float:
    """(key, item) → (0,1] 之间确定的伪随机数"""
    x = int.from_bytes(hashlib.sha256(f"{key}/{item}".encode()).digest()[:8], "big")
    return (x + 1) / 2**64

def straw2(key, items, weights, r=0):
    # 每个候选"抽一根签"，签长 = ln(u) / 权重，最长者胜
    return max(items, key=lambda it: math.log(u(f"{key}#{r}", it)) / weights[it])

def place(key, hosts, weights, replicas=3):
    """选 replicas 个不同主机：重名就换一个 r 重抽（CRUSH 的 retry 思路）"""
    chosen, r = [], 0
    while len(chosen) < replicas:
        h = straw2(key, hosts, weights, r)
        if h not in chosen:
            chosen.append(h)
        r += 1
    return chosen

KEYS = [f"pg-{i}" for i in range(20000)]
hosts = [f"host{i}" for i in range(10)]
w = {h: 1.0 for h in hosts}
before = {k: straw2(k, hosts, w) for k in KEYS}

hosts2 = hosts + ["host10"]; w2 = dict(w, host10=1.0)
after = {k: straw2(k, hosts2, w2) for k in KEYS}
moved = [k for k in KEYS if before[k] != after[k]]
print(f"新增 1 台主机，迁移比例 {len(moved)/len(KEYS):.1%}，"
      f"全部迁往新主机: {all(after[k] == 'host10' for k in moved)}")

w3 = dict(w2, host10=2.0)   # 新主机盘是别人的两倍
share = sum(straw2(k, hosts2, w3) == "host10" for k in KEYS) / len(KEYS)
print(f"host10 权重 2.0 时分到 {share:.1%} 的数据（理论 {2/12:.1%}）")
print("pg-42 的三副本:", place("pg-42", hosts2, w2))
```

```console
$ python3 straw2.py
新增 1 台主机，迁移比例 9.1%，全部迁往新主机: True
host10 权重 2.0 时分到 16.7% 的数据（理论 16.7%）
pg-42 的三副本: ['host0', 'host7', 'host5']
```

三条性质全部成立：迁移量最小、迁移只流向新节点、按权重分配。真实的 CRUSH 还有两层间接：对象先哈希到**放置组（PG）**，再由 CRUSH 把 PG 映射到盘，这样集群只需要跟踪几千个 PG 而不是几十亿个对象。细节留到 [Ceph 架构](/learn/ceph-architecture)。

### 四种方式对比

| 方式 | 定位需要 | 扩容迁移量 | 拓扑感知 | 代表 |
|---|---|---|---|---|
| 集中式元数据表 | 查元数据服务 | 可控（只改表） | 任意 | HDFS、GFS、GPFS 的分配图 |
| 哈希取模 | 本地计算 | 约 (N)/(N+1)，灾难 | 无 | 简单的分库分表 |
| 一致性哈希 | 本地计算 + 环 | 约 1/(N+1) | 弱，需要额外处理 | Dynamo、Swift、Cassandra |
| CRUSH 式 | 本地计算 + 集群拓扑图 | 约新增权重占比 | 强，规则可描述 | Ceph |

实际系统常常混用：MinIO 用哈希把对象分到固定的纠删集（erasure set），JuiceFS 用数据库存元数据、用对象存储存数据，3FS 用 FoundationDB 存元数据、用链表配置决定数据放置。

## 一致性：多份数据说的是不是同一件事

数据存了三份，客户端写入时，要等几份写完才返回？读的时候读哪一份？这就是一致性模型要回答的问题。

### 强一致与最终一致

| 模型 | 承诺 | 代价 | 代表 |
|---|---|---|---|
| 强一致（线性一致，Linearizable） | 写入返回后，任何客户端都能读到新值，就像只有一份数据 | 写要等多数或全部副本确认，跨地域延迟高；分区时部分不可用 | Ceph RADOS、etcd、S3（2020 年后） |
| 最终一致（Eventual） | 停止写入后，所有副本"终将"一致；期间可能读到旧值 | 应用要处理读到旧数据、冲突合并 | 早期 S3、Dynamo、跨地域异步复制 |
| 会话级（读己之写等） | 同一客户端能读到自己的写入 | 介于两者之间 | 很多缓存系统、NFS 的 close-to-open |

CAP 定理说：网络分区发生时，一致性（C）和可用性（A）只能二选一。存储系统几乎都选 C——宁可暂停服务，也不能把数据写坏。对象存储的跨地域复制是少数选 A 的场景。

### 法定人数：W + R > N

在无主（leaderless）复制里，常用法定人数（quorum）调节一致性：N 份副本，写入要 W 份确认才算成功，读取要读 R 份取最新版本。

**只要 W + R > N，读集合和写集合必然有交集**，读一定能看到最新写入。

```text
N=3, W=2, R=2:    写入确认: [A] [B]  C          读取: A  [B] [C]
                            └─── B 同时在两个集合里 ───┘  → 一定读到新值

N=3, W=1, R=1:    写入确认: [A]  B   C          读取: A   B  [C]
                            没有交集 → 可能读到旧值
```

| 配置（N=3） | W+R>N? | 特点 |
|---|---|---|
| W=3, R=1 | 是 | 读极快，任何一个副本挂了就不能写 |
| W=2, R=2 | 是 | 读写均衡，容忍 1 个副本故障 |
| W=1, R=3 | 是 | 写极快，读要全部副本 |
| W=1, R=1 | 否 | 最快，但只是最终一致 |

Ceph RADOS 不用这种 quorum，而是**主副本（primary-copy）复制**：每个 PG 有一个主 OSD，客户端只和主 OSD 通信，主 OSD 把写入转发给其他副本，所有副本都持久化后才确认客户端。读默认也只从主 OSD 读。它相当于 W=N、R=1，再加上"只要可写副本数不低于 `min_size` 就继续服务"的降级规则。

### Paxos 与 Raft：谁说了算

数据可以靠复制保证可靠，但"集群里有哪些节点、谁是主、当前拓扑是什么"这类**元数据**必须所有人看法一致，否则就会像[网络存储](/learn/network-storage)那一课的脑裂一样，两个节点都以为自己是主。

Paxos 和 Raft 就是解决这个问题的共识算法。核心思想一句话：**2f+1 个成员组成一个组，任何决定必须获得多数（f+1）同意**。任何两个多数派必然有交集，所以不可能同时产生两个互相矛盾的决定。

| 成员数 | 多数派 | 能容忍故障 | 说明 |
|---|---|---|---|
| 1 | 1 | 0 | 实验用 |
| 2 | 2 | 0 | 比 1 个还糟：坏一个就停，还多一倍故障概率 |
| 3 | 2 | 1 | 最常见 |
| 4 | 3 | 1 | 不比 3 个强，别用偶数 |
| 5 | 3 | 2 | 大集群、跨机架 |

存储系统里的共识组：

- **Ceph MON**：基于 Paxos 维护 cluster map（MON、OSD、CRUSH、MDS 等各种 map），通常 3 或 5 个；
- **etcd**（Kubernetes 的大脑）、**TiKV**（JuiceFS 的元数据引擎之一）：Raft；
- **GPFS**：仲裁节点（quorum node）选出集群管理者；
- **FoundationDB**（3FS 的元数据）：自己的协调者（coordinators）+ 事务系统。

> [!WARNING] 共识组不是用来存大数据的
> Paxos/Raft 的每次写入都要多数派落盘确认，吞吐有限。它们管理的是"少量但极其重要"的状态：成员关系、拓扑、锁、元数据索引。真正的数据流不走共识组——Ceph 的对象数据不经过 MON，客户端拿到 map 后直接和 OSD 通信。

## 故障域与放置规则

### 故障是相关的

副本数不等于可靠性。三个副本放在同一台机器的三块盘上，这台机器电源一坏，三份一起没。**故障域**（failure domain）是"会一起坏的一组东西"：

| 故障域 | 典型故障原因 | 影响范围 |
|---|---|---|
| 盘（osd） | 介质损坏、固件 bug | 1 块盘 |
| 主机（host） | 主板、电源、内核崩溃、网卡、误重启 | 一台机器所有盘 |
| 机架（rack） | 机柜 PDU、ToR 交换机 | 一个机柜所有机器 |
| 排 / 房间（row / room） | 配电回路、空调 | 一片机柜 |
| 机房 / 可用区（datacenter / zone） | 市电、光缆、火灾 | 整个站点 |

放置规则的原则：**同一份数据的多个副本（或 EC 分片）必须分布在不同的故障域**。Ceph 默认的副本规则是 `chooseleaf firstn 0 type host`，即每个副本在不同主机上。

### 故障域选多大

故障域越大越安全，但约束也越多：

- 选 `rack` 作为故障域、三副本，至少要 3 个机架；EC 8+3 就要至少 11 个机架；
- 各故障域容量要大致均衡：3 个机架里有一个特别小，它会最先写满，整个存储池跟着写满；
- 一个故障域坏掉后，它的数据要在剩余故障域里重建，剩余空间必须装得下。

> [!PROD] 经验法则
> 中小规模（< 10 个机柜）用 `host` 作为故障域，并保证主机数至少是"副本数 + 1"或"k+m+1"，这样坏一台还有地方恢复。大规模、机柜数足够且均衡时再升级到 `rack`。跨机房的强一致同步复制对网络延迟要求苛刻（RTT 最好 < 1～2 ms），不满足时用异步复制。

## 可用性计算

### AFR、MTTF 与 MTTR

- **AFR**（Annualized Failure Rate，年故障率）：一年内坏掉的盘占比。企业级 HDD 和 SSD 的实测 AFR 通常在 0.5%～2%，Backblaze 每季度公开的硬盘统计是很好的参考；
- **MTTF**（Mean Time To Failure）：平均无故障时间，大致是 AFR 的倒数（AFR 1% ≈ MTTF 87.6 万小时）；
- **MTTR**（Mean Time To Repair）：从故障到恢复冗余的时间。对分布式存储，它主要是**数据重建时间**，而不是换盘时间。

先感受一下规模效应：1000 块盘、AFR 2%，一年坏 20 块，**平均每 18 天坏一块**。在分布式存储里，坏盘不是事故，是日常。

单个组件的稳态可用性：

```text
A = MTTF / (MTTF + MTTR)
```

MTTR 出现在分母里，所以**缩短重建时间和提高硬件质量一样有效**。这也是 Ceph 把数据打散成大量 PG 的原因之一：一块盘坏了，几十上百块盘同时参与重建，而不是像传统 RAID 那样只有同组几块盘在干活。

### 串联与冗余

多个组件串联（任一坏了都不可用）时可用性相乘；冗余（至少 k 个可用即可）时用二项分布计算：

```python title="avail.py"
from math import comb

def at_least(k, n, a):
    """n 个独立副本/节点中至少 k 个可用的概率"""
    return sum(comb(n, i) * a**i * (1 - a)**(n - i) for i in range(k, n + 1))

a = 0.99   # 单节点可用性：一年约 3.65 天不可用
print(f"单节点            : {a:.6f}")
print(f"3 副本，至少 1 个 : {at_least(1, 3, a):.6f}")
print(f"3 副本，至少 2 个 : {at_least(2, 3, a):.6f}   # min_size=2 时可写")
print(f"EC 4+2，至少 4 个 : {at_least(4, 6, a):.6f}")
print(f"EC 4+2，至少 5 个 : {at_least(5, 6, a):.6f}   # min_size=k+1 时可写")
```

```console
$ python3 avail.py
单节点            : 0.990000
3 副本，至少 1 个 : 0.999999
3 副本，至少 2 个 : 0.999702   # min_size=2 时可写
EC 4+2，至少 4 个 : 0.999980
EC 4+2，至少 5 个 : 0.998540   # min_size=k+1 时可写
```

几个值得注意的结论：

1. "数据不丢"（至少 1 份）和"可以写入"（至少 `min_size` 份）是两个不同的可用性，后者低得多；
2. EC 4+2 和三副本都能容忍 2 个故障，但为了安全，Ceph 默认要求 k+1 个分片在线才允许写，"可写"的可用性比三副本低；
3. 这里假设故障相互独立。现实里同批次的盘会一起老化，一个机架断电会带走一片——这正是要按故障域放置的原因，也是这类计算只能当数量级参考的原因。

把"几个 9"换算成停机时间，方便和业务方沟通：

| 可用性 | 每年停机 | 每月停机 |
|---|---|---|
| 99%（两个 9） | 3.65 天 | 7.3 小时 |
| 99.9% | 8.8 小时 | 43.8 分钟 |
| 99.99% | 52.6 分钟 | 4.4 分钟 |
| 99.999% | 5.3 分钟 | 26 秒 |

> [!NOTE] 可用性 ≠ 持久性
> 可用性（availability）是"现在能不能访问"，持久性（durability）是"数据还在不在"。S3 宣称的 11 个 9 是持久性。集群停服一小时降低的是可用性；三块盘在重建窗口内接连坏掉导致 PG 丢失，降低的是持久性。后者不可逆，所以设计时优先保证持久性。

## 动手练习

1. 运行 `placement.py`，把虚拟节点数 `vnodes` 分别改成 1、10、100、1000，统计每个节点分到的 key 数量的最大值与最小值之比，观察虚拟节点对均衡度的影响。
2. 修改 `straw2.py`，把 host3 的权重改为 0（模拟下线），验证只有原本在 host3 上的数据发生迁移，并且均匀分散到了其他主机。
3. 给 `straw2.py` 加一层拓扑：4 个机架、每个机架 3 台主机，实现"先选 3 个不同机架、再在每个机架里选 1 台主机"的规则，并验证任意一个 key 的三副本都不在同一机架。
4. 用 `avail.py` 计算：单节点可用性分别为 99%、99.9% 时，三副本（min_size=2）和 EC 8+3（min_size=9）的可写可用性。
5. 估算：一个集群 600 块 16 TB HDD、AFR 1.5%，单盘重建需要 8 小时。一年大约要处理多少次坏盘？任意时刻处于重建中的概率大约是多少？

## 自测

<details>
<summary>哈希取模和一致性哈希在扩容时的迁移量差别有多大？为什么？</summary>

哈希取模从 N 个节点扩到 N+1 时，`hash % N` 和 `hash % (N+1)` 对绝大多数 key 结果不同，迁移比例约为 N/(N+1)，10 扩 11 时约 91%。一致性哈希中新节点只接管环上与它相邻的区间，迁移比例约为 1/(N+1)，接近理论最优。

</details>

<details>
<summary>CRUSH 相比一致性哈希多解决了什么问题？</summary>

CRUSH 引入了集群的层级拓扑（机房、机架、主机、盘）和放置规则，可以保证副本或 EC 分片分布在不同的故障域，比如"三个副本必须在三台不同主机上"。同时它仍然是客户端本地可计算的确定性算法，不需要查中心化的位置表，并按权重分配数据、在拓扑变化时只迁移必要的数据。

</details>

<details>
<summary>N=5 时，W=3、R=2 是否能保证读到最新写入？W=2、R=3 呢？W=2、R=2 呢？</summary>

W+R>N 才能保证读写集合有交集。W=3、R=2：5 > 5 不成立，不保证。W=2、R=3：同样是 5，不保证。W=2、R=2：4 < 5，不保证。需要 W+R ≥ 6，例如 W=3、R=3 或 W=4、R=2。

</details>

<details>
<summary>为什么 Ceph MON 通常部署 3 或 5 个，而不是 2 个或 4 个？</summary>

MON 用 Paxos 做共识，需要多数派存活才能工作。2 个成员的多数派是 2，坏一个就停，容错能力为 0；4 个的多数派是 3，只能容忍 1 个故障，和 3 个一样却多了一个可能故障的成员。3 个容忍 1 个故障，5 个容忍 2 个故障，所以用奇数个。

</details>

<details>
<summary>为什么说分布式存储里缩短 MTTR 与降低 AFR 同样重要？</summary>

组件可用性 A = MTTF/(MTTF+MTTR)，数据丢失的风险主要来自"重建窗口内又坏了其他副本所在的盘"。MTTR 越短，处于降级状态的时间越短，窗口内出现二次、三次故障的概率越低。分布式存储通过把数据打散，让大量盘并行参与重建来缩短 MTTR。

</details>

## 参考资料

- [Sage A. Weil 等：CRUSH: Controlled, Scalable, Decentralized Placement of Replicated Data（SC'06）](https://ceph.io/assets/pdfs/weil-crush-sc06.pdf)
- [Giuseppe DeCandia 等：Dynamo: Amazon's Highly Available Key-value Store（SOSP'07）](https://www.allthingsdistributed.com/files/amazon-dynamo-sosp2007.pdf)
- [Diego Ongaro、John Ousterhout：In Search of an Understandable Consensus Algorithm（Raft 论文）](https://raft.github.io/raft.pdf)
- [Raft 共识算法可视化](https://raft.github.io/)
- [Ceph 文档：CRUSH Maps](https://docs.ceph.com/en/latest/rados/operations/crush-map/)
- [Ceph 文档：Monitor Config Reference](https://docs.ceph.com/en/latest/rados/configuration/mon-config-ref/)
- [Backblaze 硬盘故障率统计](https://www.backblaze.com/cloud-storage/resources/hard-drive-test-data)
- Martin Kleppmann,《Designing Data-Intensive Applications》第 5 章 Replication、第 9 章 Consistency and Consensus
