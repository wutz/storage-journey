# 副本与纠删码

分布式存储靠冗余活着：坏一块盘、一台机器，数据还在。冗余有两种基本做法——**多副本**（Replication）把数据原样存 N 份，**纠删码**（Erasure Coding，EC）把数据切成 k 块再算出 m 块校验。一句话概括两者的矛盾：三副本浪费 67% 的空间，EC 省空间，但小 I/O 慢，重建时还可能把集群拖垮。

学完这一课，你能算出任意副本数和 EC 配置的得盘率、容错能力与最少节点数；理解 EC 为什么在小 I/O 和重建上吃亏；用一个 XOR 例子直观理解 Reed-Solomon 在做什么；知道 LRC 想解决什么问题；并能给出"什么数据用副本、什么数据用 EC"的选型判断。

## 从 RAID 说起

[RAID](/learn/raid) 那一课其实已经讲过这两种思想：RAID 1 是副本，RAID 5/6 是纠删码（RAID 5 是 k+1 的 XOR，RAID 6 是 k+2 的 Reed-Solomon）。分布式存储做的是同一件事，只是把"盘"换成了"跨机器的盘"，并把冗余的粒度从整块盘缩小到对象或 PG：

```text
三副本：对象 A ──▶ [A] host1    [A] host2    [A] host3

EC 4+2：对象 A ──切成 4 块──▶ [A1] [A2] [A3] [A4] ──计算──▶ [P1] [P2]
                              h1   h2   h3   h4           h5   h6
        任意 2 块丢失，都能用剩下的 4 块恢复
```

## 容量效率与容错

| 方案 | 得盘率 | 空间开销 | 容忍故障 | 最少故障域 | 建议故障域数 |
|---|---|---|---|---|---|
| 2 副本 | 50% | 2.0× | 1 | 2 | 3 |
| 3 副本 | 33.3% | 3.0× | 2 | 3 | 4 |
| EC 2+1 | 66.7% | 1.5× | 1 | 3 | 4 |
| EC 4+2 | 66.7% | 1.5× | 2 | 6 | 7 |
| EC 6+3 | 66.7% | 1.5× | 3 | 9 | 10 |
| EC 8+2 | 80% | 1.25× | 2 | 10 | 11 |
| EC 8+3 | 72.7% | 1.375× | 3 | 11 | 12 |
| EC 10+4 | 71.4% | 1.4× | 4 | 14 | 15 |

规律很简单：EC k+m 的得盘率是 k/(k+m)，容忍 m 个故障，至少需要 k+m 个故障域。"建议故障域数"多出的那一个，是为了坏掉一个故障域后还有地方把数据重建出来——否则集群会长期处于降级状态。

想按自己的盘数和规格算实际可用容量，用[容量计算器](/calculator)，它会把副本/EC 开销、预留的恢复空间和"别写满"的水位线一起算进去。

> [!WARNING] 2 副本不是省钱，是赌博
> 2 副本只能容忍 1 个故障。一块盘坏了之后、重建完成之前，同一份数据只剩一个副本；此时再坏一块相关的盘（或者读到一个坏扇区），数据就没了。以 [分布式存储基础](/learn/distributed-basics) 的规模效应算，大集群里这种事一年总会碰上几次。生产数据至少 3 副本或 m ≥ 2 的 EC。

## 写放大与小 I/O

### 大块写：EC 占优

写入一个 4 MiB 对象：

| 方案 | 网络与磁盘写入量 | 放大倍数 |
|---|---|---|
| 3 副本 | 3 × 4 MiB = 12 MiB | 3.0× |
| EC 4+2 | 6 × 1 MiB = 6 MiB | 1.5× |
| EC 8+3 | 11 × 0.5 MiB = 5.5 MiB | 1.375× |

对大文件顺序写，EC 写入的数据量只有三副本的一半左右，吞吐反而可能更高，只是要多花一些 CPU 做编码（现代 CPU 用 ISA-L 这类 SIMD 优化库，编码速度可达每核数 GB/s，通常不是瓶颈）。

### 小块覆盖写：EC 的噩梦

在一个已有对象中间覆盖写 4 KiB：

- **三副本**：把这 4 KiB 发给 3 个副本，各自写 4 KiB。简单直接；
- **EC 4+2**：校验块是由整个条带（stripe）计算出来的，改了其中一个数据块，两个校验块都得重算。于是要**读-改-写**（read-modify-write）：先读出旧数据块（或整个条带），算出新校验，再写回数据块和 2 个校验块。一次 4 KiB 的写变成了多次跨网络的读和写，延迟翻几倍。

```text
EC 4+2 覆盖写 A2 的 4 KiB：
  1. 读旧 A2（以及旧 P1、P2，或整条带）   ← 额外的网络往返
  2. 计算新 P1、P2
  3. 写新 A2、P1、P2                       ← 3 次写，而且要保证原子性
```

所以 Ceph 的 EC 池默认**不允许覆盖写**，只支持追加（适合 RGW 对象）；要给 RBD 或 CephFS 用，必须显式打开 `allow_ec_overwrites`，并且元数据仍放在副本池里。Ceph 20（Tentacle）起对 EC 的部分读写做了专门优化（FastEC），小 I/O 性能有明显改善，但"EC 小写比副本慢"这个基本结论不会变。

### 小对象：EC 反而更费空间

盘上的空间是按最小分配单元划的（BlueStore 默认 4 KiB）。存一个 4 KiB 的小对象：

| 方案 | 实际占用 | 等效开销 |
|---|---|---|
| 3 副本 | 3 × 4 KiB = 12 KiB | 3× |
| EC 4+2 | 每个分片 1 KiB 也要占 4 KiB，6 × 4 KiB = 24 KiB | 6× |
| EC 8+3 | 11 × 4 KiB = 44 KiB | 11× |

对象越小，EC 的空间优势越荡然无存，还多出 k+m 倍的元数据和 IOPS。小文件密集的场景（海量图片缩略图、代码仓库、日志碎片）用 EC 是得不偿失的。[对象存储](/learn/object-storage)那一课还会从另一个角度讨论小对象问题。

### 读路径：等最慢的那一个

读也有差别。三副本读一个对象，从主副本读一次即可；EC 4+2 读一个完整对象，要从 4 个 OSD 各取一个分片再拼起来（Ceph 里由主 OSD 负责收集），**整次读取的延迟取决于 4 个分片里最慢的那个**。

```text
三副本读：  客户端 ──▶ 主 OSD ──▶ 返回                   延迟 ≈ 1 次盘读
EC 4+2 读： 客户端 ──▶ 主 OSD ──┬─▶ OSD-b  分片 2 ─┐
                                ├─▶ OSD-c  分片 3 ─┼─▶ 拼装后返回   延迟 ≈ max(4 次盘读)
                                └─▶ OSD-d  分片 4 ─┘
```

[性能指标](/learn/perf-metrics)里讲过尾延迟：单块盘 p99 偶尔慢一下，在副本读里只影响 1% 的请求；在需要同时等 4 块盘的 EC 读里，至少一块盘慢的概率接近 4%，尾延迟被放大了。如果某个分片所在的盘已经坏了，还要读校验块现场解码（降级读，degraded read），延迟和 CPU 开销再上一个台阶。

## 重建：EC 真正的代价

一块 16 TB 的盘坏了，要把上面的数据在别处恢复出来：

| 方案 | 恢复 1 份数据需要读取 | 恢复整块盘的网络读取量 |
|---|---|---|
| 3 副本 | 从任一幸存副本读 1 份 | 约 16 TB |
| EC 4+2 | 读任意 4 个幸存分片 | 约 4 × 16 = 64 TB |
| EC 8+3 | 读任意 8 个幸存分片 | 约 8 × 16 = 128 TB |

EC 的重建流量是副本的 k 倍。在 25 GbE 的集群里，128 TB 的重建流量会和业务流量抢带宽，重建期间业务延迟明显上升；重建越慢，降级窗口越长，二次故障风险越高。这就是"EC 重建时能把集群拖垮"的来源。

几个缓解手段：

- **大规模打散**：数据以 PG 为单位分布到大量盘上，重建时几十上百块盘并行读写，单盘和单链路压力都小（Ceph 的 PG、GPFS ECE 的分布式阵列 DA 都是这个思路）；
- **重建限速**：Ceph 用 `osd_max_backfills`、`osd_recovery_max_active` 和 mClock 调度器在"快点恢复冗余"和"别影响业务"之间调节；
- **LRC、Clay 等修复友好的编码**：减少单个分片丢失时需要读的数据量，下面会讲；
- **别让单盘太大**：盘越大，重建时间越长。30 TB 的 HDD 按 150 MB/s 满速重写也要两天多，这是大容量 HDD 集群更倾向 m ≥ 3 的原因。

## 最少节点数与 min_size

Ceph 里每个池有两个关键参数：

- `size`：副本数，或 EC 的 k+m；
- `min_size`：至少多少个副本/分片在线时才允许 I/O。

| 方案 | size | 默认 min_size | 含义 |
|---|---|---|---|
| 3 副本 | 3 | 2 | 坏 1 个照常读写；坏 2 个暂停 I/O，但数据还在 |
| EC 4+2 | 6 | 5（k+1） | 坏 1 个照常；坏 2 个暂停 I/O，数据仍可恢复 |
| EC 8+3 | 11 | 9（k+1） | 坏 2 个照常；坏 3 个暂停 I/O |

`min_size` 大于"刚好能恢复数据"的数量，是为了在降级状态下仍保留至少一份额外冗余，避免在只剩最后一份时继续接受写入。

> [!DANGER] 不要把 min_size 调成 1 或 k
> 故障时为了"先恢复业务"把 3 副本池的 `min_size` 改成 1，是 Ceph 社区里最常见的丢数据操作之一：此时唯一在线的副本接受了新写入，一旦它也出问题，这些写入就永远找不回来，其他副本回来后还会产生冲突。宁可业务暂停，也要先恢复冗余。

## Reed-Solomon 的直观理解

### 先看 XOR：能扛 1 个故障

异或（XOR）有个漂亮的性质：`a ^ b ^ b = a`。取 4 个数据块，把它们逐字节异或得到校验块 P：

```text
D1 = 1011 0110
D2 = 0110 1100
D3 = 1100 0011
D4 = 0001 1111
------------------ XOR
P  = 0000 0110

D3 丢了？把剩下的全部异或：D1 ^ D2 ^ D4 ^ P = 1100 0011 = D3
```

这就是 EC k+1（也是 RAID 5）。用 Python 验证一个 4 MiB 对象的切块、编码与重建：

```python title="xor_ec.py"
import os, hashlib

K = 4                                   # 4 个数据块 + 1 个 XOR 校验块
data = os.urandom(4 * 1024 * 1024)      # 4 MiB 的"对象"
size = len(data) // K
chunks = [data[i*size:(i+1)*size] for i in range(K)]

def xor(blocks):
    out = bytearray(len(blocks[0]))
    for b in blocks:
        for i, x in enumerate(b):
            out[i] ^= x
    return bytes(out)

parity = xor(chunks)
print("原始对象 md5:", hashlib.md5(data).hexdigest())

lost = 2                                # 假设存第 3 块的那台机器坏了
survivors = [c for i, c in enumerate(chunks) if i != lost] + [parity]
chunks[lost] = xor(survivors)           # 其余 K 块异或回来
print("重建后   md5:", hashlib.md5(b"".join(chunks)).hexdigest())
print(f"重建 1 块读取了 {len(survivors)} 块 = {len(survivors)*size//1024} KiB")
```

```console
$ python3 xor_ec.py
原始对象 md5: 23fad3ad3b785eb30d0f2170ddd90ce2
重建后   md5: 23fad3ad3b785eb30d0f2170ddd90ce2
重建 1 块读取了 4 块 = 4096 KiB
```

注意最后一行：只丢了 1 MiB，却读了 4 MiB 才恢复出来——这就是上一节"重建流量是 k 倍"的直观体现。

### 从 XOR 到 Reed-Solomon：扛 m 个故障

一个 XOR 校验只能解一个未知数。想扛 2 个故障，就需要 2 个"互相独立"的方程。可以这样类比：

```text
P1 = D1 +   D2 +   D3 +   D4        （就是 XOR）
P2 = D1 + 2·D2 + 3·D3 + 4·D4        （每个数据块乘上不同系数）
```

丢了 D2 和 D3，就剩两个方程、两个未知数，解方程组就能恢复。Reed-Solomon 就是把这个思路推广到 m 个校验：构造一个 m×k 的系数矩阵（Vandermonde 或 Cauchy 矩阵），保证**任意 k 个方程都线性无关**，所以 k+m 块里任意丢 m 块都能解出来。

为了让"乘法"和"除法"在字节上封闭、不溢出，运算在伽罗华域 GF(2⁸) 上进行——加法就是 XOR，乘法查表完成。数学细节不影响使用，记住结论即可：**RS(k, m) 的任意 k 块足以恢复全部数据，这是容量效率的理论最优（MDS 码）**。

常见实现：jerasure、Intel ISA-L（Ceph 新版本默认插件，旧版本默认 jerasure，以 `ceph osd erasure-code-profile get default` 的输出为准）。Linux 的 RAID 6 也是 RS 的一个特例（k+2）。

### LRC：用一点空间换重建速度

RS 的问题在于：哪怕只丢 1 块，也要读 k 块。而现实中 99% 以上的故障都是**单块**故障。局部重建码（Locally Repairable Code，LRC）的思路是：把数据块分组，每组额外加一个**局部校验**，单块丢失时只在组内修复。

```text
Azure LRC (12, 2, 2)：12 个数据块，分两组，每组 1 个局部校验，外加 2 个全局校验

  组 A: D1..D6  + LA      组 B: D7..D12 + LB      全局: G1 G2
  丢 D3 → 只读 D1,D2,D4,D5,D6,LA = 6 块（RS 12+4 需要读 12 块）
  开销 16/12 = 1.33×，同样能扛任意 3 个故障
```

Ceph 提供 `lrc` 插件，例如 `k=4 m=2 l=3` 表示每 3 个分片一组加一个局部校验，总共需要 8 个 OSD。另一个 `clay` 插件（Coupled-Layer 码）在不增加存储开销的前提下降低单块修复的网络流量。它们都是用 CPU 和复杂度换重建带宽，只有在重建流量真正成为瓶颈的大规模 EC 集群里才值得考虑。

## 选型经验

| 场景 | 推荐 | 理由 |
|---|---|---|
| 块存储（RBD、虚拟机、数据库） | 3 副本 | 小随机写多、延迟敏感 |
| 文件系统元数据（CephFS 元数据池、GPFS system pool） | 3 副本甚至 4 副本 | 小 I/O 密集，丢了整个文件系统都完 |
| 海量小文件、小对象（< 64 KiB 为主） | 3 副本 | EC 空间优势消失，IOPS 放大 |
| 热数据、高 IOPS 的对象桶 | 3 副本 | 延迟优先 |
| 大对象、备份、归档、日志冷存 | EC 4+2 / 8+3 | 大块顺序写，容量优先 |
| AI 数据集、视频、镜像等大文件为主 | EC（配合副本池存元数据） | 吞吐优先，读多写少 |
| 节点少于 6 台 | 3 副本 | EC 4+2 连最少故障域都凑不齐 |

> [!PROD] 混合使用是常态
> 生产 Ceph 集群里，同一套硬件上通常同时有副本池和 EC 池：RBD 用 SSD 副本池；RGW 的索引池、元数据池用 SSD 副本池，数据池用 HDD EC 池；CephFS 的元数据池用副本、数据池按目录布局（file layout）指向不同的池。团队的做法是在 CRUSH 里按设备类型建 `rep_ssd` 和 `ec42_ssd` 两类规则，按性能需求选池。

在 Ceph 里创建 EC 池只需要两步（阶段 4 会实际部署）：

```bash
ceph osd erasure-code-profile set ec42 k=4 m=2 crush-failure-domain=host
ceph osd erasure-code-profile get ec42
ceph osd pool create ecpool 32 32 erasure ec42 --bulk
ceph osd pool set ecpool allow_ec_overwrites true     # 只有 RBD / CephFS 需要
```

## 动手练习

1. 运行 `xor_ec.py`，改成随机丢一块，验证重建结果；再尝试同时丢两块，想一想为什么恢复不了。
2. 用 `mdadm` 和 6 个 loop 设备建一个 RAID 6（相当于 4+2），写入数据并记下 md5，然后用 `mdadm --fail` 让两块盘失效，确认数据依旧可读，再添加新盘观察重建过程（`cat /proc/mdstat`）。
3. 计算：一个 12 节点、每节点 12 块 20 TB HDD 的集群，分别用 3 副本和 EC 8+3，考虑坏一个节点后需要有空间重建、且整体使用率不超过 80%，可用容量各是多少？用[容量计算器](/calculator)核对。
4. 估算：25 GbE 网络、每节点重建带宽限制在 1 GB/s、共 12 个节点并行参与，一块 20 TB 的盘坏了，3 副本和 EC 8+3 分别需要多久才能恢复冗余？
5. 如果你已按 [Ceph 架构](/learn/ceph-architecture)里的实验装好了 MicroCeph，创建一个 `k=2 m=1 crush-failure-domain=osd` 的 EC 池，用 `rados -p <pool> put` 写入对象后执行 `ceph osd map <pool> <obj>`，观察它被映射到几个 OSD。

## 自测

<details>
<summary>EC 8+3 的得盘率是多少？能容忍几个故障？在 Ceph 中以 host 为故障域至少需要几台主机？</summary>

得盘率 8/11 ≈ 72.7%，容忍 3 个故障，至少需要 11 台主机；为了坏一台后还能完成重建，建议至少 12 台。

</details>

<details>
<summary>为什么 EC 池的小块覆盖写比三副本慢得多？</summary>

校验块由整个条带计算得出，修改其中一部分数据就必须更新所有校验块，因此要先读出旧数据（或旧校验、整条带），重新计算校验，再写回数据块和 m 个校验块。一次小写变成多次跨网络的读写，并且要保证这些写入的原子性。三副本只需把新数据直接写到每个副本。

</details>

<details>
<summary>一个 16 TB 的盘坏了，三副本和 EC 4+2 的重建网络读取量分别大约是多少？为什么有差别？</summary>

三副本只需从幸存副本读一份，约 16 TB；EC 4+2 每恢复一个分片都要读取 4 个幸存分片，约 64 TB。EC 用计算代替了冗余存储，代价是重建时需要读取 k 倍的数据。

</details>

<details>
<summary>存储大量 4 KiB 小对象时，EC 4+2 为什么可能比三副本更费空间？</summary>

盘上按最小分配单元（如 BlueStore 的 4 KiB）分配空间。EC 4+2 把 4 KiB 切成 4 个 1 KiB 分片加 2 个校验分片，每个分片仍占 4 KiB，一共 24 KiB；三副本只占 3 × 4 KiB = 12 KiB。此外 EC 还多出 6 倍的元数据和 I/O 次数。

</details>

<details>
<summary>LRC 相比 Reed-Solomon 解决了什么问题，付出了什么代价？</summary>

RS 即使只丢一块，也需要读取 k 块来修复；LRC 把数据块分组并为每组增加局部校验，单块故障只需读取组内的少量块，大幅降低最常见的单块修复流量和时间。代价是多了局部校验块，存储开销比同等容错能力的 RS 略高，实现也更复杂。

</details>

## 参考资料

- [Ceph 文档：Erasure Code](https://docs.ceph.com/en/latest/rados/operations/erasure-code/)
- [Ceph 文档：Erasure Code Profiles](https://docs.ceph.com/en/latest/rados/operations/erasure-code-profile/)
- [Ceph 文档：Locally Repairable Erasure Code Plugin](https://docs.ceph.com/en/latest/rados/operations/erasure-code-lrc/)
- [Ceph 文档：CLAY Code Plugin](https://docs.ceph.com/en/latest/rados/operations/erasure-code-clay/)
- [Cheng Huang 等：Erasure Coding in Windows Azure Storage（USENIX ATC'12）](https://www.usenix.org/conference/atc12/technical-sessions/presentation/huang)
- [James S. Plank：Erasure Codes for Storage Systems: A Brief Primer（;login: 2013）](https://www.usenix.org/publications/login/december-2013-volume-38-number-6/erasure-codes-storage-systems-brief-primer)
- [Intel ISA-L 项目主页](https://github.com/intel/isa-l)
- [Backblaze：Reed-Solomon 纠删码的开源 Java 实现与讲解](https://www.backblaze.com/blog/reed-solomon/)
