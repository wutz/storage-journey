# RAID 与 mdadm

一块盘会坏，这不是"如果"，而是"什么时候"。上一课看到 SMART 里的坏扇区在增长，那就意味着这块盘上的数据正处在危险中。**RAID（Redundant Array of Independent Disks）** 是单机层面最经典的应对：把多块盘组合成一个虚拟盘，用条带换性能，用镜像或校验换可靠性。

这一课讲清楚 RAID 0/1/5/6/10 在容量、性能、可靠性上的取舍，算一算为什么"大容量 HDD 组 RAID 5 等于赌博"，理解写惩罚和写洞（write hole），然后用 mdadm 在 loop 设备上亲手建阵列、拔盘、重建。最后回答一个很多人困惑的问题：为什么 Ceph 这类分布式存储反而要求你**不要**做 RAID。

## 两个基本手法：条带与冗余

```text
条带（Striping）：数据切成固定大小的块（chunk），轮流写到各盘
           ┌──────┐ ┌──────┐ ┌──────┐
 数据 A B C│  A1  │ │  A2  │ │  A3  │  ← 一个条带（stripe）= 各盘同一位置的 chunk
 D E F ... │  B1  │ │  B2  │ │  B3  │
           └──────┘ └──────┘ └──────┘
             盘 0      盘 1      盘 2

镜像（Mirroring）：每份数据完整写到两块（或多块）盘
校验（Parity）：   每个条带额外存一个 P = D1 ⊕ D2 ⊕ ...，丢任意一块都能用剩下的异或算回来
```

- **chunk（条带单元）**：每块盘上连续存放的数据块大小，mdadm 默认 512 KiB。
- **stripe width（条带宽度）**：一个条带里的有效数据量 = chunk × 数据盘数。
- 异或（XOR）的性质：`D2 = P ⊕ D1 ⊕ D3`，这就是 RAID 5 能恢复一块盘的全部秘密。RAID 6 再加一个基于伽罗华域运算的 Q 校验，能同时恢复两块。

## 各级别对比

设阵列有 N 块容量为 C、随机 IOPS 为 R 的盘：

| 级别 | 最少盘数 | 可用容量 | 容忍坏盘 | 随机读 | 随机写 | 写惩罚 | 典型用途 |
|---|---|---|---|---|---|---|---|
| RAID 0 | 2 | N × C | 0 | N × R | N × R | 1 | 临时数据、可重建的缓存 |
| RAID 1 | 2 | C（两盘镜像） | N − 1 | N × R | R | 2 | 系统盘、小容量关键数据 |
| RAID 5 | 3 | (N − 1) × C | 1 | N × R | N × R / 4 | 4 | 读多写少、小容量盘（今天已不推荐） |
| RAID 6 | 4 | (N − 2) × C | 2 | N × R | N × R / 6 | 6 | 大容量 HDD 归档、备份 |
| RAID 10 | 4 | N × C / 2 | 每个镜像对 1 块 | N × R | N × R / 2 | 2 | 数据库、虚拟化、随机写密集 |

几个值得记住的结论：

- **RAID 0 没有冗余**，任何一块盘坏了整个阵列的数据全没，N 块盘的阵列故障率是单盘的 N 倍。
- **RAID 10 的"容忍坏盘"看运气**：最少 1 块，最多 N/2 块——只要不是同一个镜像对里的两块同时坏。
- **顺序大块写**时 RAID 5/6 的表现比表中好得多（见下面的"满条带写"），写惩罚主要针对随机小写。

### 写惩罚是怎么来的

RAID 5 改写一个 chunk 里的一小块数据，不能只写数据本身，还得更新校验。最省的做法是：

```text
1. 读旧数据 D_old         （读 1 次）
2. 读旧校验 P_old         （读 1 次）
3. P_new = P_old ⊕ D_old ⊕ D_new
4. 写新数据 D_new         （写 1 次）
5. 写新校验 P_new         （写 1 次）
───────────────────────────────────
一次逻辑写 = 4 次物理 I/O    ← 这就是"读-改-写"（Read-Modify-Write）
```

RAID 6 要同时更新 P 和 Q，变成 3 读 3 写 = 6 次。RAID 1/10 只需写两份，惩罚为 2。

用 8 块 7200 rpm HDD（每块约 150 随机 IOPS）算一下纯随机写能力：

```text
RAID 10： 8 × 150 / 2 = 600 IOPS
RAID 5 ： 8 × 150 / 4 = 300 IOPS
RAID 6 ： 8 × 150 / 6 = 200 IOPS    ← 8 块盘的随机写，只比一块半盘强
```

> [!TIP] 满条带写没有惩罚
> 如果一次写正好覆盖一整个条带（所有数据 chunk），校验可以直接用新数据算出来，不用读任何旧数据。所以 RAID 5/6 做大文件顺序写（备份、视频）表现不错，做数据库随机小写则很惨。**让文件系统知道条带宽度**，尽量凑满条带写，是 RAID 上调优的核心——mkfs.xfs 在 md 设备上会自动探测，后面的实验会看到。

### 条带大小怎么选

chunk 太小，一个中等大小的 I/O 会被拆到多块盘上，每块盘都要寻道一次；chunk 太大，小 I/O 集中在少数盘上，并行度不够，也更难凑满条带。经验法则：

- 随机小 I/O 为主（数据库、虚拟机）：64～256 KiB。
- 大文件顺序读写（备份、媒体、HPC）：512 KiB～1 MiB。
- 拿不准就用 mdadm 默认的 512 KiB，然后用 [fio](/learn/benchmarking) 按真实负载验证。

## 重建：RAID 最脆弱的时刻

### 重建要多久

一块盘坏了，阵列进入**降级（degraded）**状态，仍能读写，但已经没有（RAID 5）或只剩一重（RAID 6）冗余。换上新盘后，RAID 要读出所有幸存盘的全部数据、算出丢失的内容、写到新盘上：

```text
20 TB HDD，理想重建速度 200 MB/s：
  20 × 10^12 B / (200 × 10^6 B/s) = 100,000 s ≈ 28 小时

业务不停、重建被限速到 50 MB/s：
  20 × 10^12 / (50 × 10^6) = 400,000 s ≈ 4.6 天
```

在这几天里，所有幸存盘都被满负荷读一遍——而它们往往和坏掉的那块是同一批次、同样年龄、同样的负载。**重建期间再坏一块的概率远高于平时。**

### URE：重建路上的地雷

硬盘规格书里有一项**不可恢复读错误率（URE，Unrecoverable Read Error）**：消费级盘通常标"每读 10^14 位出现不多于 1 次"，企业级标 10^15。10^14 位只有约 12.5 TB。

以 4 块 20 TB 盘组 RAID 5 为例，坏一块后重建要读完另外 3 块：

```text
需要读取：3 × 20 TB = 60 TB = 4.8 × 10^14 位

URE = 1/10^14 ：期望错误 4.8 次，一次都不出错的概率 ≈ e^-4.8 ≈ 0.8%
URE = 1/10^15 ：期望错误 0.48 次，一次都不出错的概率 ≈ e^-0.48 ≈ 62%
```

规格书给的是上限，实际盘通常好得多，但数量级说明了问题：**在降级的 RAID 5 上遇到一个 URE，那个条带就没有任何冗余可以修复它**，轻则部分数据损坏，重则一些老式控制器直接判定重建失败、整个阵列下线。RAID 6 在降级一块时还剩一重校验，可以纠正 URE。

> [!PROD] 大容量 HDD 不要用 RAID 5
> 单盘超过 2～4 TB 的 HDD，用 RAID 6 或 RAID 10，不用 RAID 5。同时要：配热备盘（hot spare）让重建立即开始；定期做**巡检（scrub）**，提前发现并修复潜在坏扇区，而不是等到重建时才撞上；监控 SMART，在盘彻底坏之前主动换掉。

### 写洞（Write Hole）

RAID 5/6 的一次写要更新数据和校验两处，这两次写不是原子的。如果写完数据、还没写完校验时断电：

```text
断电前：D1=a  D2=b  D3=c  P=a⊕b⊕c        （一致）
写 D2：  D1=a  D2=B  D3=c  P=a⊕b⊕c        ← 校验还没来得及更新，断电！
上电后：校验和数据对不上，但没有人知道
之后盘 1 坏了，用 P ⊕ D2 ⊕ D3 重算 D1 = a⊕b⊕c⊕B⊕c = a⊕b⊕B ≠ a   ← 算出了错误的数据
```

这就是**写洞**：校验悄悄失效，平时毫无症状，直到某块盘坏了、需要依赖校验重建时才返回错误数据，而且是静默的。

各方案的应对：

| 方案 | 做法 |
|---|---|
| 硬件 RAID 卡 | 带 BBU（电池）或超级电容 + 闪存的写缓存，断电后把未完成的写保存下来，上电后补完 |
| mdadm 写日志 | `--write-journal <快速设备>`：先把数据和校验写进 SSD/NVMe 日志再落盘（类似数据库 WAL） |
| mdadm PPL | `--consistency-policy=ppl`：部分校验日志，仅 RAID 5，无需额外设备，有一定写性能代价 |
| ZFS RAID-Z | 写时复制 + 可变条带，从设计上避免覆盖写，不存在写洞 |

mdadm 默认对大于 100 GB 的阵列启用**写意图位图（write-intent bitmap）**。它记录哪些区域可能有未完成的写，异常关机后只需重新同步这些区域，而不是整盘同步——这能缩短恢复时间，但**不能**解决写洞本身。

## 动手：用 mdadm 管理软 RAID

### 准备四块"盘"

> [!LAB] 本实验只使用 loop 设备
> 四个 1 GiB 文件模拟四块盘，三块组 RAID 5，第四块用来替换"坏盘"。
>
> ```bash
> sudo apt install -y mdadm
> sudo mkdir -p /var/lib/lab
> for i in 1 2 3 4; do sudo truncate -s 1G /var/lib/lab/md$i.img; done
> M1=$(sudo losetup -f --show /var/lib/lab/md1.img)
> M2=$(sudo losetup -f --show /var/lib/lab/md2.img)
> M3=$(sudo losetup -f --show /var/lib/lab/md3.img)
> M4=$(sudo losetup -f --show /var/lib/lab/md4.img)
> echo $M1 $M2 $M3 $M4
> ```

### 创建 RAID 5

> [!DANGER] mdadm --create 会覆盖成员盘上的数据
> 下面的命令只对上面创建的 loop 设备执行。在真实机器上，成员盘一律写 `/dev/disk/by-id/...`，并在执行前核对序列号。

```bash
sudo mdadm --create /dev/md0 --level=5 --raid-devices=3 $M1 $M2 $M3
cat /proc/mdstat
```

```text
mdadm: layout defaults to left-symmetric
mdadm: chunk size defaults to 512K
mdadm: size set to 1046528K
mdadm: Defaulting to version 1.2 metadata
mdadm: array /dev/md0 started.

Personalities : [raid0] [raid1] [raid6] [raid5] [raid4] [raid10]
md0 : active raid5 loop10[3] loop9[1] loop8[0]
      2093056 blocks super 1.2 level 5, 512k chunk, algorithm 2 [3/2] [UU_]
      [=======>.............]  recovery = 38.5% (403456/1046528) finish=0.1min speed=100864K/sec

unused devices: <none>
```

`/proc/mdstat` 的读法：

- `loop10[3]`：成员设备及其在阵列中的编号。带 `(F)` 表示故障，`(S)` 表示热备。
- `2093056 blocks`：可用容量（KiB），正好是 2 块成员盘的容量——3 块盘里有 1 块的空间给了校验。
- `[3/2] [UU_]`：应有 3 块、当前正常 2 块；`U` 为正常，`_` 为缺失或正在重建。
- `recovery`：RAID 5 创建时，mdadm 先以降级模式启动，再把最后一块盘当作"新盘"重建出校验，所以新阵列一开始就在 recovery。

等进度走完，看详细状态：

```console
$ sudo mdadm --detail /dev/md0
/dev/md0:
           Version : 1.2
        Raid Level : raid5
        Array Size : 2093056 (2044.00 MiB 2143.29 MB)
     Used Dev Size : 1046528 (1022.00 MiB 1071.64 MB)
      Raid Devices : 3
     Total Devices : 3
             State : clean
    Active Devices : 3
   Working Devices : 3
    Failed Devices : 0
     Spare Devices : 0
            Layout : left-symmetric
        Chunk Size : 512K
Consistency Policy : resync
...
    Number   Major   Minor   RaidDevice State
       0       7        8        0      active sync   /dev/loop8
       1       7        9        1      active sync   /dev/loop9
       3       7       10        2      active sync   /dev/loop10
```

### 建文件系统，观察条带对齐

```console
$ sudo mkfs.xfs -q /dev/md0
$ sudo mkdir -p /mnt/raid && sudo mount /dev/md0 /mnt/raid
$ xfs_info /mnt/raid | grep -E 'sunit|swidth'
         =                       sunit=128    swidth=256 blks
```

XFS 自动从 md 读到了几何信息：`sunit=128` 个 4K 块 = 512 KiB（chunk），`swidth=256` 块 = 1 MiB（2 块数据盘 × 512 KiB）。在硬件 RAID 上，内核通常拿不到这些信息，需要手工用 `mkfs.xfs -d su=512k,sw=2` 指定。

放一些数据并记下校验和，稍后用来验证重建后数据完好：

```bash
sudo dd if=/dev/urandom of=/mnt/raid/blob bs=1M count=500 status=none
sudo sha256sum /mnt/raid/blob | tee /tmp/blob.sha256
```

### 模拟坏盘

```bash
sudo mdadm /dev/md0 --fail $M2
cat /proc/mdstat
```

```text
md0 : active raid5 loop10[3] loop9[1](F) loop8[0]
      2093056 blocks super 1.2 level 5, 512k chunk, algorithm 2 [3/2] [U_U]
```

阵列降级了，但文件系统照常可读写——冗余正在发挥作用，同时也已经没有余量了：

```bash
sudo sha256sum -c /tmp/blob.sha256        # blob: OK
sudo mdadm --detail /dev/md0 | grep -E 'State :|Failed'
```

### 换盘与重建

先把重建速度限低一点，方便观察过程（单位 KiB/s，默认上限 200000）：

```bash
echo 10000 | sudo tee /proc/sys/dev/raid/speed_limit_max
sudo mdadm /dev/md0 --remove $M2          # 从阵列移除坏盘
sudo mdadm /dev/md0 --add $M4             # 加入新盘，自动开始重建
watch -n1 cat /proc/mdstat
```

```text
md0 : active raid5 loop11[4] loop10[3] loop8[0]
      2093056 blocks super 1.2 level 5, 512k chunk, algorithm 2 [3/2] [U_U]
      [====>................]  recovery = 22.7% (238080/1046528) finish=1.3min speed=10000K/sec
```

重建完成后恢复默认速度，并再次校验数据：

```bash
echo 200000 | sudo tee /proc/sys/dev/raid/speed_limit_max
sudo sha256sum -c /tmp/blob.sha256
```

> [!TIP] 重建速度的两个旋钮
> `/proc/sys/dev/raid/speed_limit_min` 是"即使业务繁忙也要保证的最低重建速度"，`speed_limit_max` 是上限。业务高峰期把 min 调低以保护前台延迟，低峰期把 min 调高以尽快脱离降级状态——重建越久，风险窗口越长。

### 巡检、配置持久化与监控

```bash
# 巡检：读出全部数据并核对校验，发现不一致会计数
echo check | sudo tee /sys/block/md0/md/sync_action
cat /sys/block/md0/md/mismatch_cnt       # 完成后应为 0

# 把阵列写进配置文件，开机时自动组装（真实盘才需要，loop 设备重启后不存在）
sudo mdadm --detail --scan | sudo tee -a /etc/mdadm/mdadm.conf
sudo update-initramfs -u
```

Ubuntu 的 mdadm 软件包自带定期巡检任务和 `mdmonitor` 服务。生产中务必在 `/etc/mdadm/mdadm.conf` 里配置 `MAILADDR` 或接入监控系统（node_exporter 会暴露 `node_md_disks{state="failed"}` 等指标），否则阵列降级了几个月都没人知道——这是软 RAID 事故里最常见的一种。

### 清理

```bash
sudo umount /mnt/raid
sudo mdadm --stop /dev/md0
sudo mdadm --zero-superblock $M1 $M2 $M3 $M4    # 擦除成员盘上的 md 元数据
sudo losetup -d $M1 $M2 $M3 $M4
sudo rm -f /var/lib/lab/md*.img
```

如果你刚才把 loop 阵列写进了 `/etc/mdadm/mdadm.conf`，记得把那一行删掉。

## 硬 RAID、软 RAID 与 JBOD

| | 硬件 RAID 卡 | Linux 软 RAID（mdadm） | JBOD / HBA 直通 |
|---|---|---|---|
| 校验计算 | 卡上专用芯片 | 主机 CPU（现代 CPU 的 SIMD 指令很快） | 不做，交给上层软件 |
| 写缓存 | 有，通常配 BBU/超级电容，可安全开启回写 | 无（可用 write-journal 补足写洞） | 无 |
| 对 OS 可见性 | 只看到虚拟盘，SMART、单盘延迟需要厂商工具 | 每块盘都可见，`iostat` 直接看 | 每块盘都可见 |
| 故障恢复 | 卡坏了需要同型号或兼容卡导入配置 | 任何 Linux 机器都能组装 | 由上层软件处理 |
| 运维工具 | storcli / perccli 等，各家不同 | mdadm，统一 | 上层软件自带 |
| 适合 | 传统单机数据库、Windows、要求开箱即用 | 系统盘镜像、单机存储服务器 | Ceph、GPFS ECE、MinIO 等分布式存储 |

Systems Performance 第 9.4.3 节也提到这个趋势：CPU 算力早已过剩，越来越多的存储方案回到了软件 RAID（例如 ZFS），换来更低的成本、更好的可观测性，以及"卡坏了也能修"的可恢复性。

### 为什么分布式存储偏好 JBOD

Ceph、GPFS ECE、MinIO 这类系统的文档都建议把盘以**直通（JBOD / HBA 模式）**交给它们，而不是先组 RAID：

1. **冗余重复**：分布式存储已经在**节点之间**做多副本或纠删码（见[副本与纠删码](/learn/replication-ec)），再在节点内做 RAID，容量效率被乘了两次。3 副本 + RAID 6 的可用率只有约 25%。
2. **故障域错位**：RAID 只保护一台机器里的盘，保护不了整机宕机、网卡、电源故障；分布式存储的冗余跨越节点、机柜，覆盖面更大。
3. **重建粒度**：一个 RAID 组坏一块盘，要在一台机器里对着几块盘慢慢重建；分布式存储可以让全集群几百块盘并行参与恢复，只恢复真正丢失的数据，重建时间从天缩短到小时甚至分钟。
4. **可观测与控制**：软件需要看到每块真实的盘，才能按盘做数据分布、感知单盘慢盘、读 SMART 预测故障。RAID 卡把这些都藏起来了。
5. **缓存语义**：RAID 卡的回写缓存可能让软件以为数据已经落盘，一旦缓存保护失效，分布式存储的一致性假设就被打破。

> [!PROD] 服务器只有 RAID 卡怎么办
> 优先把卡切到 HBA / JBOD 直通模式（大多数现代 RAID 卡都支持）。实在不支持时，退而求其次每块盘建一个单盘 RAID 0，并关闭卡上的回写缓存或确认电容健康，同时用厂商工具把 SMART 采集进监控。系统盘仍然推荐两块盘做 RAID 1（硬件或 mdadm 均可）——系统盘坏了导致整个节点下线，比浪费一块盘代价大得多。

记住一句话：**RAID 不是备份**。它防的是"盘坏了"，防不了误删、勒索软件、文件系统损坏、机房失火。

## 动手练习

1. 用四个 loop 设备建一个 RAID 10（`--level=10 --raid-devices=4`），先 `--fail` RaidDevice 0，再分别尝试 `--fail` RaidDevice 1 和 RaidDevice 2（中间记得重建恢复）。你会发现其中一种组合被 md 拒绝（报 `Device or resource busy`，md 不允许一个会让阵列失效的 `--fail`），用 `mdadm --detail` 中的 `Layout : near=2` 解释哪两块盘互为镜像。
2. 建一个 3 盘 RAID 5 并加一块热备（`--spare-devices=1`，共 4 个设备），`--fail` 其中一块，观察热备是否自动顶上，不需要手工 `--add`。
3. 在 RAID 5 上分别用 `fio --rw=randwrite --bs=4k` 与 `--rw=write --bs=1m` 测试，对比单块 loop 盘的结果，体会写惩罚与满条带写的差异（loop 设备的绝对数值没有意义，关注相对比例）。
4. 计算：12 块 18 TB 的 HDD，分别组 RAID 6 和 RAID 10，可用容量、容忍坏盘数、以 150 IOPS/盘估算的随机写 IOPS 各是多少？如果重建速度为 100 MB/s，单盘重建需要多久？
5. 查看你的服务器上是否有硬件 RAID 卡（`lspci | grep -i -E 'raid|sas'`），确认它当前工作在 RAID 模式还是 HBA/JBOD 模式，以及是否能用 `smartctl` 读到物理盘的 SMART。

## 自测

<details>
<summary>为什么 RAID 5 的随机写性能差？"写惩罚为 4"是怎么来的？</summary>

RAID 5 更新一个小块数据时，必须同时更新该条带的校验。常用的读-改-写方式需要读旧数据、读旧校验、计算新校验、写新数据、写新校验，一次逻辑写产生 2 次读和 2 次写，共 4 次物理 I/O。满条带写可以直接由新数据计算校验，不需要读旧数据，所以没有这个惩罚。

</details>

<details>
<summary>为什么说大容量 HDD 不适合 RAID 5？</summary>

一是重建时间长：20 TB 盘在业务负载下重建可能需要数天，其间阵列没有任何冗余，再坏一块盘就丢数据；二是 URE：重建需要读完所有幸存盘，数据量达数十 TB，按规格书的 URE 率很可能遇到至少一次不可恢复读错误，而降级的 RAID 5 已无冗余修复它。RAID 6 在降级一块盘时仍有一重校验，能容忍重建期间的 URE 或再坏一块盘。

</details>

<details>
<summary>什么是写洞？write-intent bitmap 能解决它吗？</summary>

RAID 5/6 更新数据和校验不是原子操作，如果在两者之间断电，校验与数据会不一致且无人知晓；之后某块盘损坏、用校验重建时就会算出错误的数据。写意图位图只记录哪些区域可能有未完成的写，用于缩短异常关机后的重新同步时间，并不能保证数据与校验的原子性，不能解决写洞。解决方式是带掉电保护的 RAID 卡缓存、mdadm 的 write-journal 或 PPL，或者 ZFS 这类写时复制的设计。

</details>

<details>
<summary>/proc/mdstat 中的 [3/2] [U_U] 表示什么？</summary>

阵列配置了 3 块成员盘，当前只有 2 块正常工作；`U_U` 表示第 0 和第 2 个位置正常，第 1 个位置缺失或正在重建。阵列处于降级状态。

</details>

<details>
<summary>为什么 Ceph 等分布式存储建议盘以 JBOD 方式直通，而不是组 RAID？</summary>

分布式存储已经在节点之间做副本或纠删码，再叠加 RAID 会重复消耗容量；RAID 只保护单机内的盘，而分布式冗余覆盖节点、机柜等更大的故障域；分布式存储可以让全集群并行恢复且只恢复丢失的数据，比单个 RAID 组重建快得多；此外软件需要直接看到每块盘，才能做数据分布、慢盘检测和 SMART 预警，RAID 卡的虚拟盘和回写缓存会隐藏这些信息并干扰落盘语义。

</details>

## 参考资料

- Brendan Gregg，《Systems Performance: Enterprise and the Cloud, 2nd Edition》第 9 章 Disks（9.4.3 Storage Types：RAID、读-改-写）
- [Linux 内核文档：RAID arrays（md）](https://docs.kernel.org/admin-guide/md.html)
- [Linux 内核文档：RAID 4/5/6 cache 与 journal](https://docs.kernel.org/driver-api/md/raid5-cache.html)
- [Linux 内核文档：Partial Parity Log](https://docs.kernel.org/driver-api/md/raid5-ppl.html)
- [Linux Raid Wiki（归档）](https://archive.kernel.org/oldwiki/raid.wiki.kernel.org/)
- [Arch Wiki：RAID](https://wiki.archlinux.org/title/RAID)
- [mdadm(8) 手册页](https://man7.org/linux/man-pages/man8/mdadm.8.html)
- [Ceph 文档：Hardware Recommendations](https://docs.ceph.com/en/latest/start/hardware-recommendations/)
- Patterson, Gibson, Katz, "A Case for Redundant Arrays of Inexpensive Disks (RAID)", SIGMOD 1988
