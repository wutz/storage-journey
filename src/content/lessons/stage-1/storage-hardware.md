# 存储硬件：HDD、SSD 与 NVMe

所有存储系统最后都要落到一块块物理盘上。Ceph 集群慢、RAID 重建要三天、数据库 fsync 延迟忽高忽低、SSD 用了一年性能掉一半——这些问题的根因，很多时候不在软件，而在你没搞清楚底下那块盘是什么、它擅长什么、它在"撒什么谎"。

这一课从机械盘讲到 NAND 闪存和 NVMe：学完你能用物理原理估算一块 HDD 的随机 IOPS，解释 SSD 为什么会"越用越慢"和"写坏"，看懂 SATA / SAS / NVMe 的队列差异，并用 `smartctl`、`nvme-cli` 读出一块盘的健康状况，判断它该不该换。

## 先建立数量级

先记住这张表，后面所有的取舍都建立在它上面（数值为典型量级，具体型号差异很大）：

| 设备 | 4K 随机读延迟 | 4K 随机读 IOPS | 顺序吞吐 | 每 TB 价格（相对） |
|---|---|---|---|---|
| 7200 rpm HDD | 5～15 ms | 75～200 | 200～280 MB/s | 1× |
| SATA SSD | 80～150 µs | 5 万～10 万 | ~550 MB/s | 3～5× |
| NVMe SSD（PCIe 4.0） | 50～100 µs | 50 万～100 万+ | 5～7 GB/s | 3～6× |
| NVMe SSD（PCIe 5.0） | 50～80 µs | 100 万～250 万 | 10～14 GB/s | 5～8× |

HDD 与 NVMe 的随机 IOPS 差了**四个数量级**，而顺序吞吐只差一个多数量级。这就是为什么"大文件顺序读写的冷数据放 HDD、随机小 I/O 和元数据放闪存"是一条经久不衰的经验法则。

## 机械硬盘（HDD）

### 结构：一台精密的唱片机

```text
             主轴（Spindle，7200 rpm 恒速旋转）
                  │
    ┌─────────────┼─────────────┐   ← 盘片（Platter），双面涂磁性材料
    │   ┌─────────┼─────────┐   │
    │   │   ┌─────┼─────┐   │   │   ← 同心圆磁道（Track），每圈再切成扇区（Sector）
    │   │   │     ●     │   │   │
    │   │   └───────────┘   │   │
    │   └───────────────────┘   │
    └───────────────────────────┘
        ▲
        └── 磁头（Head）装在音圈电机驱动的磁臂（Arm）上，所有磁头同进同退
```

读写一个扇区要经历三步：

1. **寻道（Seek）**：磁臂把磁头移到目标磁道。平均 4～9 ms，短距离寻道更快。
2. **旋转延迟（Rotational Latency）**：等目标扇区转到磁头下面。平均等半圈。
3. **传输（Transfer）**：扇区经过磁头，数据读出。4K 数据只要几十微秒，可以忽略。

旋转延迟可以直接算出来：7200 rpm 每转一圈 60 / 7200 = 8.33 ms，平均等半圈约 4.17 ms；15K rpm 平均约 2 ms。

### 估算一块 HDD 的随机 IOPS

把三项加起来就是一次随机 I/O 的服务时间：

```text
7200 rpm 盘，4K 随机读：
  平均寻道  ≈ 8.5 ms
  平均旋转  ≈ 4.2 ms
  传输      ≈ 0.02 ms
  ─────────────────────
  服务时间  ≈ 12.7 ms   →  1 / 0.0127 s ≈ 79 IOPS
```

实测往往比这高一些（100～200），因为盘内有命令队列：SATA 的 NCQ（Native Command Queuing）、SCSI/SAS 的 TCQ（Tagged Command Queuing）允许盘一次拿到多个请求，按磁头位置重新排序——这就是 Gregg 书里说的**电梯算法（Elevator Seeking）**。代价是：某个远处的请求可能被"饿"很久，表现为少量 I/O 的延迟特别高。

顺序 I/O 则完全不同：不用寻道，不用等旋转，磁头下的数据源源不断，吞吐只受线密度和转速限制。还有一个细节：盘片外圈磁道更长、扇区更多（**分区记录 Zoned Recording**），而转速恒定，所以**外圈吞吐比内圈高 30%～50%**。一块新盘前段测出 280 MB/s、写满到尾部只剩 130 MB/s 是正常的。

> [!TIP] 经验法则
> 给 HDD 做容量规划时，按"每块盘 100～150 随机 IOPS、150 MB/s 持续吞吐"来算，别用厂商标称的峰值。一块 20 TB 盘的 IOPS 和十年前 2 TB 盘几乎一样——**容量涨了 10 倍，每 TB 的 IOPS 降到了 1/10**，这是大容量 HDD 最容易被忽视的问题。

### CMR 与 SMR：同样容量，写性能天差地别

传统的 **CMR（Conventional Magnetic Recording）** 磁道之间互不重叠，可以随意原地改写。**SMR（Shingled Magnetic Recording，叠瓦式记录）** 利用"读头比写头窄"的特点，让磁道像屋顶瓦片一样部分重叠，提高约 25% 的密度。代价是：改写一条磁道会破坏下一条，所以盘只能按"区（Zone）"顺序写，随机写要先读出整个区、改完再整体写回。

SMR 又分三种：

| 类型 | 谁管理顺序写 | 对主机可见 | 适用 |
|---|---|---|---|
| DM-SMR（Drive-Managed） | 盘内固件，外加 CMR 缓存区 | 看起来和普通盘一样 | 桌面、偶尔写入的备份盘 |
| HA-SMR（Host-Aware） | 盘和主机都可以 | 暴露 Zone 信息 | 少见 |
| HM-SMR（Host-Managed） | 主机软件必须顺序写 | 暴露为 Zoned 设备 | 超大规模冷存储（需要软件配合） |

DM-SMR 最阴险：平时看着正常，一旦持续随机写把盘内 CMR 缓存区写满，写延迟会从毫秒级跳到秒级。2020 年就发生过厂商把 DM-SMR 盘悄悄混进 NAS 产品线、导致 RAID/ZFS 重建大面积超时失败的事件。

```bash
# Host-Aware / Host-Managed 会显示 host-aware / host-managed；DM-SMR 这里也显示 none
cat /sys/block/sda/queue/zoned
lsblk -o NAME,ZONED,SIZE,MODEL
```

> [!WARNING] DM-SMR 查不出来，只能查规格书
> 操作系统无法识别 DM-SMR 盘。采购用于 RAID、Ceph、GPFS 的 HDD 时，务必对照厂商数据手册确认是 CMR。企业级近线盘（Nearline SAS/SATA）基本都是 CMR，"NAS 盘""桌面盘"要特别小心。

### 扇区大小：512n、512e、4Kn

现代 HDD 物理扇区都是 4 KB（**Advanced Format**），但为了兼容老系统，大多数盘对外仍报告 512 字节逻辑扇区，称为 **512e**（emulation）。如果主机发来一个没对齐 4K 的写，盘必须先读出整个物理扇区、改几百字节、再写回（读-改-写），性能直接腰斩。

```console
$ lsblk -d -o NAME,LOG-SEC,PHY-SEC,ROTA,MODEL
NAME    LOG-SEC PHY-SEC ROTA MODEL
sda         512    4096    1 ST20000NM007D-3DJ103
nvme0n1     512     512    0 SAMSUNG MZQL23T8HCLS-00A07
```

`sda` 就是典型的 512e。分区对齐和扇区的细节在[块设备、分区与 LVM](/learn/block-devices)里展开。

## 固态硬盘（SSD）与 NAND 闪存

### NAND 的三条物理规矩

SSD 没有机械部件，随机读写都很快，但 NAND 闪存有三条"反直觉"的规矩，理解了它们，SSD 的所有怪癖都能解释：

1. **按页读写**：最小读写单位是页（Page），现代 3D NAND 一页 16 KB 左右。
2. **不能原地覆盖**：已写过的页必须先擦除才能再写。
3. **按块擦除**：擦除单位是块（Block），一个块包含几百个页，大小可达数 MB。

```text
NAND 块（Block，擦除单位，几 MB）
┌──────┬──────┬──────┬──────┬──────┬──────┐
│ 页 0 │ 页 1 │ 页 2 │ 页 3 │ ...  │ 页 N │   页（Page，读写单位，~16 KB）
│ 有效 │ 失效 │ 有效 │ 空闲 │      │ 空闲 │
└──────┴──────┴──────┴──────┴──────┴──────┘
想改写页 0？不行。只能把新数据写到别处的空闲页，再把页 0 标记为"失效"。
```

### SLC、MLC、TLC、QLC

每个 NAND 单元（Cell）靠存储的电荷量表示数据。一个单元存的位数越多，要区分的电压档位越多，就越慢、越容易出错、越不耐擦写，但也越便宜：

| 类型 | 每单元位数 | 电压状态数 | 典型 P/E 寿命 | 定位 |
|---|---|---|---|---|
| SLC | 1 | 2 | 5 万～10 万次 | 早期企业级、SSD 内部写缓存 |
| MLC | 2 | 4 | 5000～1 万次 | 已少见 |
| TLC | 3 | 8 | ~3000 次 | 当前企业级和消费级的主流 |
| QLC | 4 | 16 | ~1000 次 | 大容量、读多写少（数据湖、AI 数据集） |

P/E（Program/Erase）寿命数据取自 Systems Performance 第 9.4.1 节，不同厂商、不同代工艺差异很大，仅看数量级。消费级 TLC/QLC 盘普遍用一部分空间模拟 SLC 做写缓存，"刚开始写 3 GB/s，写了几十 GB 后掉到 500 MB/s"就是 SLC 缓存用完了。

### FTL：SSD 里藏着一个文件系统

为了让 NAND 看起来像一块"可以随意覆盖任何扇区"的普通盘，SSD 控制器里运行着 **FTL（Flash Translation Layer，闪存转换层）**。它本质上是一个日志结构的小文件系统，负责：

- **地址映射**：维护逻辑块地址（LBA）到物理页的映射表。企业盘一般按每 TB 容量配约 1 GB DRAM 存这张表；无 DRAM 的廉价盘要借主机内存（HMB）或频繁读 NAND，性能差一截。
- **异地更新**：每次改写都写到新的空闲页，旧页标记失效。
- **垃圾回收（GC，Garbage Collection）**：挑出失效页多的块，把里面仍有效的页搬走，然后擦除整块，回收为空闲块。
- **磨损均衡（Wear Leveling）**：把擦写均匀分摊到所有块，避免热点块先坏。
- **坏块管理与 ECC**：屏蔽坏块，纠正读错误。

### 写放大：SSD 为什么会"越用越慢"

GC 搬运有效页也要写 NAND。于是主机写 1 GB，NAND 实际可能写了 3 GB。这个比例叫**写放大系数（WAF，Write Amplification Factor）**：

```text
WAF = NAND 实际写入量 / 主机写入量
```

新盘所有块都是空的，没有 GC，性能最好（FOB，Fresh-Out-of-Box）；盘被写满、随机覆盖写持续一段时间后，每次写都可能触发 GC，性能跌到**稳态（Steady State）**，随机写 IOPS 可能只有新盘的 1/3。

> [!WARNING] 测 SSD 前先"预处理"
> 对一块新 SSD 直接跑 fio，测到的是 FOB 性能，远高于它上线一个月后的真实表现。正确做法是先把整盘顺序写满两遍，再持续随机写直到 IOPS 曲线走平，然后才开始正式测试。详见[基准测试：fio 与 elbencho](/learn/benchmarking)。

降低写放大有两个手段：

- **TRIM / Discard**：文件系统删除文件时通知 SSD"这些 LBA 不再使用"（SATA 叫 TRIM，SCSI 叫 UNMAP，NVMe 叫 Deallocate）。FTL 就知道对应页已失效，GC 时不必搬运。Ubuntu 默认启用了每周执行一次的 `fstrim.timer`。
- **预留空间（OP，Over-Provisioning）**：留出一部分 NAND 不给用户用，专供 GC 周转。空闲块越多，GC 越从容，WAF 越低。

```console
$ lsblk --discard -d
NAME    DISC-ALN DISC-GRAN DISC-MAX DISC-ZERO
sda            0        0B       0B         0
nvme0n1        0      512B       2T         0
$ systemctl status fstrim.timer --no-pager | head -3
● fstrim.timer - Discard unused filesystem blocks once a week
     Loaded: loaded (/usr/lib/systemd/system/fstrim.timer; enabled; preset: enabled)
     Active: active (waiting) since ...
```

`DISC-GRAN` 和 `DISC-MAX` 为 0 表示不支持 discard（这里的 `sda` 是 HDD）。

OP 在企业盘的型号上体现得最明显：同一系列，**读密集型**标 3.84 TB，**混合读写型**标 3.2 TB，里面的 NAND 其实一样多，后者多留了近 20% 做 OP，换来更高的随机写性能和寿命。

### 寿命：DWPD 与 TBW

NAND 擦写次数有限，SSD 寿命用两个等价指标描述：

- **TBW（Terabytes Written）**：质保期内允许写入的总量。
- **DWPD（Drive Writes Per Day）**：质保期内每天可以把整盘写满几次。

```text
TBW = DWPD × 容量(TB) × 365 × 质保年数

3.84 TB、1 DWPD、5 年质保：1 × 3.84 × 365 × 5 ≈ 7008 TB ≈ 7 PBW
3.2 TB、3 DWPD、5 年质保： 3 × 3.2  × 365 × 5 ≈ 17520 TB ≈ 17.5 PBW
```

| 类别 | DWPD | 典型负载 |
|---|---|---|
| 读密集（Read Intensive） | ≤1 | 对象存储数据盘、AI 数据集、CDN 缓存 |
| 混合读写（Mixed Use） | ~3 | 数据库、虚拟化、Ceph OSD 通用场景 |
| 写密集（Write Intensive） | ≥10 | 日志、写缓存、Ceph 的 WAL/DB 盘 |

> [!PROD] 选盘看负载，不看"越贵越好"
> 先用 `iostat` 或 SMART 数据统计现网每天实际写入量，再乘以写放大（副本、EC、文件系统日志都会放大），得出需要的 DWPD。大多数对象存储和 AI 读负载用 1 DWPD 的 QLC/TLC 读密集盘完全够用，省下的钱可以多买节点。

还有一个经常被忽略的指标：**掉电保护（PLP，Power Loss Protection）**。企业级 SSD 板上有一排电容，断电时能把 DRAM 缓存里的数据刷进 NAND；消费级盘通常没有。PLP 直接决定 `fsync` 的延迟和数据安全，在[页缓存与持久化语义](/learn/page-cache)里会专门讲。

## 接口：SATA、SAS 与 NVMe

### 三种接口对比

| | SATA | SAS | NVMe |
|---|---|---|---|
| 协议栈 | ATA 命令，经 AHCI 控制器 | SCSI 命令，经 SAS HBA/RAID 卡 | NVMe 命令，直连 PCIe |
| 带宽 | 6 Gb/s（实际 ~550 MB/s） | SAS-3 12 Gb/s，SAS-4 22.5 Gb/s | 取决于 PCIe 代数与通道数 |
| 队列 | 1 个队列，深度 32（NCQ） | 1 个队列，深度通常 256 起 | 最多 64K 个队列，每队列最多 64K 命令 |
| 双端口 / 多路径 | 否 | 是（双控存储阵列必备） | 部分企业盘支持 |
| 热插拔 | 支持 | 支持 | U.2/U.3/E3.S 支持 |
| 常见介质 | 消费级 HDD/SSD、近线 HDD | 企业 HDD、部分企业 SSD | 几乎全是 SSD |
| 典型形态 | 2.5"/3.5" | 2.5"/3.5" | M.2、U.2、U.3、E1.S、E3.S、AIC |

SATA 和 SAS 都是为机械盘时代设计的：一个队列、深度有限，所有 CPU 核都要抢同一把锁往里塞命令。当设备本身只需要几十微秒时，这套软件路径反而成了瓶颈。NVMe 从零设计，让每个 CPU 核拥有自己的提交队列（SQ）和完成队列（CQ）：

```text
SATA / AHCI                              NVMe
 CPU0  CPU1  CPU2  CPU3                   CPU0     CPU1     CPU2     CPU3
   \     |     |    /                      │        │        │        │
    ▼    ▼     ▼   ▼                     SQ0/CQ0  SQ1/CQ1  SQ2/CQ2  SQ3/CQ3
  ┌─────────────────┐  共享锁              │        │        │        │
  │ 单队列 (深度 32) │                      ▼        ▼        ▼        ▼
  └────────┬────────┘                   ┌────────────────────────────────┐
           ▼                            │   NVMe 控制器（并行处理，PCIe） │
         磁盘                           └────────────────────────────────┘
```

Linux 的块层也配合做了多队列改造（blk-mq），每个硬件队列在 sysfs 里都能看到：

```console
$ ls /sys/block/nvme0n1/mq/
0  1  10  11  12  13  14  15  2  3  4  5  6  7  8  9
$ cat /sys/block/sda/device/queue_depth
32
```

### PCIe 带宽算一算

NVMe 的上限就是它插的 PCIe 链路。每一代单通道（lane）带宽翻倍，企业 NVMe 盘一般是 x4：

| PCIe 代数 | 单通道有效带宽（单向） | x4 | x16 |
|---|---|---|---|
| 3.0 | ~0.985 GB/s | ~3.9 GB/s | ~15.8 GB/s |
| 4.0 | ~1.97 GB/s | ~7.9 GB/s | ~31.5 GB/s |
| 5.0 | ~3.94 GB/s | ~15.8 GB/s | ~63 GB/s |

规划存储服务器时要把整条链路算通：一台 24 盘位 NVMe 服务器，每盘 7 GB/s，理论上 168 GB/s，但网卡如果是 2 × 200 Gb/s（约 50 GB/s），盘再快也出不去；CPU 的 PCIe 通道数、是否经过 PCIe Switch 也会成为瓶颈。这类计算在[容量与性能规划](/learn/capacity-planning)里会系统展开。

```bash
# 查看 NVMe 盘协商到的 PCIe 速率与宽度（LnkCap 是能力，LnkSta 是实际）
sudo lspci -vv -s $(basename $(readlink -f /sys/block/nvme0n1/device/device)) | grep -E 'LnkCap:|LnkSta:'
```

```text
		LnkCap:	Port #0, Speed 16GT/s, Width x4, ASPM not supported
		LnkSta:	Speed 16GT/s, Width x4
```

`16GT/s` 是 PCIe 4.0。如果 `LnkSta` 显示的速度或宽度低于 `LnkCap`（比如插错了槽、x4 盘只跑在 x2），性能会直接打折。

## 认识你机器上的盘

```console
$ lsblk -d -o NAME,SIZE,ROTA,TRAN,MODEL,SERIAL
NAME      SIZE ROTA TRAN   MODEL                       SERIAL
sda      18.2T    1 sata   ST20000NM007D-3DJ103        ZVT0XXXX
sdb     894.3G    0 sata   INTEL SSDSC2KB960G8         PHYF0XXXX
nvme0n1   3.5T    0 nvme   SAMSUNG MZQL23T8HCLS-00A07  S64HNXXXX
```

- `ROTA=1` 表示旋转介质（HDD），0 表示闪存。
- `TRAN` 是传输方式：`sata`、`sas`、`nvme`、`usb`、`iscsi`。
- 虚拟机里的 virtio 盘 `TRAN` 为空，`ROTA` 通常是 1——这是虚拟化层报告的，不代表真实介质。

> [!NOTE] 虚拟机里看不到 SMART
> 下面的 `smartctl`、`nvme` 命令需要物理机或直通（passthrough）的盘。在 [实验环境](/learn/lab-environment) 的虚拟机里跑会提示设备不支持，属正常现象，这部分可以找一台物理机或读懂示例输出即可。

## 用 smartctl 看 HDD / SATA SSD 健康

S.M.A.R.T.（Self-Monitoring, Analysis and Reporting Technology）是盘自己记录的健康数据。

```bash
sudo apt install -y smartmontools nvme-cli
sudo smartctl -i /dev/sda          # 型号、序列号、固件、是否支持 SMART
sudo smartctl -H /dev/sda          # 整体健康判定（PASSED / FAILED）
sudo smartctl -A /dev/sda          # 属性表
sudo smartctl -t short /dev/sda    # 发起约 2 分钟的短自检（不影响数据）
sudo smartctl -l selftest /dev/sda # 查看自检结果
```

```text
ID# ATTRIBUTE_NAME          FLAG     VALUE WORST THRESH TYPE      UPDATED  WHEN_FAILED RAW_VALUE
  5 Reallocated_Sector_Ct   0x0033   100   100   010    Pre-fail  Always       -       8
  9 Power_On_Hours          0x0032   095   095   000    Old_age   Always       -       21873
187 Reported_Uncorrect      0x0032   100   100   000    Old_age   Always       -       0
188 Command_Timeout         0x0032   100   100   000    Old_age   Always       -       0
194 Temperature_Celsius     0x0022   034   045   000    Old_age   Always       -       34
197 Current_Pending_Sector  0x0012   100   100   000    Old_age   Always       -       0
198 Offline_Uncorrectable   0x0010   100   100   000    Old_age   Offline      -       0
199 UDMA_CRC_Error_Count    0x003e   200   200   000    Old_age   Always       -       0
```

`VALUE/WORST/THRESH` 是厂商归一化的分数，**`-H` 报 PASSED 不代表盘健康**——很多盘直到彻底挂掉前都显示 PASSED。真正要盯的是这几项的 `RAW_VALUE`：

| 属性 | 含义 | 怎么判断 |
|---|---|---|
| 5 Reallocated_Sector_Ct | 已被重映射到备用区的坏扇区数 | 非零就要关注，持续增长就换盘 |
| 197 Current_Pending_Sector | 读不出、等待重映射的扇区 | 非零意味着有数据可能读不出来 |
| 198 Offline_Uncorrectable | 离线扫描发现的不可纠正扇区 | 非零且增长 → 换盘 |
| 187 Reported_Uncorrect | 上报给主机的不可纠正错误 | 非零 → 高风险 |
| 199 UDMA_CRC_Error_Count | 链路传输校验错误 | 通常是线缆、背板问题，不是盘本身 |

Backblaze 公开的大规模统计显示，5、187、188、197、198 这几项任一非零，故障概率都会显著上升。

> [!PROD] 坏盘判定要自动化
> 在生产里，用 `smartd`（smartmontools 自带守护进程）或 Prometheus 的 smartctl exporter 定期采集，把上述 RAW 值的**增长**设为告警，而不是等 `HEALTH FAILED`。硬盘经过 RAID 卡时，需要 `smartctl -d megaraid,N` 或 `-d cciss,N` 之类的参数才能穿透读到物理盘数据，这也是后面[RAID](/learn/raid)一课主张 HBA 直通的原因之一。

## 用 nvme-cli 看 NVMe 健康

NVMe 盘的健康信息结构更规范，用 `nvme-cli` 读取最直接：

```console
$ sudo nvme list
Node                  Generic               SN                   Model                                    Namespace  Usage                      Format           FW Rev
--------------------- --------------------- -------------------- ---------------------------------------- ---------- -------------------------- ---------------- --------
/dev/nvme0n1          /dev/ng0n1            S64HNXXXXXXXXX       SAMSUNG MZQL23T8HCLS-00A07               0x1          3.84  TB /   3.84  TB    512   B +  0 B   GDC5902Q

$ sudo nvme smart-log /dev/nvme0
Smart Log for NVME device:nvme0 namespace-id:ffffffff
critical_warning                        : 0
temperature                             : 38 °C (311 K)
available_spare                         : 100%
available_spare_threshold               : 10%
percentage_used                         : 3%
endurance group critical warning summary: 0
Data Units Read                         : 123,456,789 (63.21 TB)
Data Units Written                      : 98,765,432 (50.57 TB)
host_read_commands                      : 2,345,678,901
host_write_commands                     : 1,234,567,890
controller_busy_time                    : 4,321
power_cycles                            : 45
power_on_hours                          : 12,345
unsafe_shutdowns                        : 12
media_errors                            : 0
num_err_log_entries                     : 0
Warning Temperature Time                : 0
Critical Composite Temperature Time     : 0
```

读法：

- **critical_warning**：非零就要立即处理，它是一个位图（备用块不足、温度超限、可靠性下降、只读模式等）。
- **percentage_used**：厂商估算的寿命消耗百分比，到 100% 表示达到额定 TBW（不代表立刻坏，但已超出质保承诺）。可以超过 100。
- **available_spare** 低于 `available_spare_threshold` 时盘会报警。
- **Data Units Written**：单位是 1000 个 512 字节，即 512,000 字节。98,765,432 × 512,000 ≈ 50.57 TB。用它除以通电天数，就是这块盘的实际日写入量，可以和 DWPD 对照。
- **media_errors**：不可恢复的数据完整性错误，非零要高度警惕。
- **unsafe_shutdowns**：非正常断电次数，没有 PLP 的盘每一次都可能丢数据。

再看两个常用的：

```bash
sudo nvme id-ctrl /dev/nvme0 | grep -E '^(mn|fr|vwc|oncs) '   # 型号、固件、是否有易失写缓存、支持的可选命令
sudo nvme id-ns -H /dev/nvme0n1 | grep 'LBA Format'             # 支持的扇区格式
sudo smartctl -a /dev/nvme0                                      # smartctl 也能读 NVMe，输出更易读
```

```text
LBA Format  0 : Metadata Size: 0   bytes - Data Size: 512 bytes - Relative Performance: 0x2 Good (in use)
LBA Format  1 : Metadata Size: 0   bytes - Data Size: 4096 bytes - Relative Performance: 0 Best
```

这块盘出厂是 512 字节扇区，但厂商标注 4096 字节格式"性能最佳"。上线前可以把它格式化成 4K：

> [!DANGER] nvme format 会清空整块盘
> `nvme format` 会瞬间擦除该命名空间上的全部数据，而且无法恢复。只对确认为空、尚未加入任何系统的新盘执行，执行前用 `nvme list` 和序列号反复核对设备。
>
> ```bash
> sudo nvme format /dev/nvme0n1 --lbaf=1   # 切换到 LBA Format 1（4096 字节）
> ```

## 动手练习

1. 在你的实验机（和任意一台能接触到的物理机）上执行 `lsblk -d -o NAME,SIZE,ROTA,TRAN,LOG-SEC,PHY-SEC,MODEL`，记录每块盘的介质类型、接口和扇区大小；在虚拟机里观察 virtio 盘报告的 `ROTA` 是什么。
2. 按本课公式估算一块 10K rpm、平均寻道 4 ms 的 SAS 盘的 4K 随机读 IOPS，再估算 12 块这种盘最多能提供多少随机读 IOPS。
3. 找一块物理 NVMe 盘，用 `nvme smart-log` 读出 `Data Units Written` 和 `power_on_hours`，算出它的平均日写入量，再对照厂商规格的 DWPD，估算按当前负载还能用多少年。
4. 执行 `lsblk --discard` 和 `systemctl list-timers fstrim.timer`，确认你的 SSD 支持 discard、fstrim 定时任务处于启用状态，并用 `sudo fstrim -av` 手动执行一次。
5. 在一台有 NVMe 盘的机器上用 `lspci -vv` 核对 `LnkCap` 与 `LnkSta`，确认盘跑在了应有的 PCIe 速率和宽度上。

## 自测

<details>
<summary>为什么一块 20 TB 的 HDD 并不比 2 TB 的 HDD 更适合随机读写负载？</summary>

HDD 的随机 IOPS 由寻道时间和旋转延迟决定，这两项十几年来几乎没有变化，所以无论容量大小，7200 rpm 盘都只有 100～200 随机 IOPS。容量涨了 10 倍，每 TB 分摊到的 IOPS 反而降到 1/10。承载同样的数据量，用大盘意味着更少的盘、更少的总 IOPS，重建时间也更长。

</details>

<details>
<summary>SSD 用久了性能下降，写放大是怎么产生的？TRIM 和 OP 各自如何缓解它？</summary>

NAND 不能原地覆盖、只能整块擦除，FTL 把改写写到新页并标记旧页失效。空闲块不够时要做垃圾回收：把块中仍有效的页搬到别处再擦除，这些搬运就是额外的 NAND 写入，即写放大。TRIM 让文件系统告诉 SSD 哪些 LBA 已被删除，GC 就不用搬运这些"其实已无用"的数据；OP 预留出不给用户使用的空闲空间，让 GC 更容易找到失效页多的块，从而降低搬运量。

</details>

<details>
<summary>一块 7.68 TB、1 DWPD、5 年质保的 SSD，它的 TBW 大约是多少？如果你的业务每天写入 3 TB，它能用满 5 年吗？</summary>

TBW = 1 × 7.68 × 365 × 5 ≈ 14016 TB ≈ 14 PBW。每天写 3 TB 约等于 0.39 DWPD，在不考虑额外放大时是够用的；但如果上层有 3 副本或文件系统日志等放大，或者负载以小块随机写为主（盘内 WAF 更高），就要重新核算，并通过 `percentage_used` 持续跟踪。

</details>

<details>
<summary>NVMe 相比 SATA/SAS 的性能优势只是因为 PCIe 带宽更大吗？</summary>

不只是带宽。更关键的是队列模型：SATA 只有 1 个深度 32 的队列，SAS 也只有 1 个队列，所有 CPU 核要争用同一个队列和锁；NVMe 支持最多 64K 个队列、每队列 64K 条命令，每个 CPU 核可以有独立的提交/完成队列，配合 Linux blk-mq 消除了锁竞争，协议栈也更短，所以能在几十微秒的延迟下支撑百万级 IOPS。

</details>

<details>
<summary>smartctl -H 显示 PASSED，是否可以认为盘是健康的？应该看哪些指标？</summary>

不能。`-H` 基于厂商归一化分数和阈值，很多盘在故障前一直显示 PASSED。应重点关注原始值：5 Reallocated_Sector_Ct、187 Reported_Uncorrect、197 Current_Pending_Sector、198 Offline_Uncorrectable 是否非零以及是否持续增长；199 UDMA_CRC_Error_Count 增长通常指向线缆或背板。NVMe 则看 `critical_warning`、`media_errors`、`percentage_used` 和 `available_spare`。

</details>

## 参考资料

- Brendan Gregg，《Systems Performance: Enterprise and the Cloud, 2nd Edition》第 9 章 Disks（9.4.1 磁盘类型、9.4.2 接口）
- [smartmontools 官方文档与 Wiki](https://www.smartmontools.org/)
- [nvme-cli 项目主页](https://github.com/linux-nvme/nvme-cli)
- [NVM Express 规范](https://nvmexpress.org/specifications/)
- [Linux 内核文档：Multi-Queue Block IO Queueing Mechanism (blk-mq)](https://docs.kernel.org/block/blk-mq.html)
- [Zoned Storage 项目：SMR 与 Zoned 设备介绍](https://zonedstorage.io/)
- [Backblaze：Hard Drive SMART Stats](https://www.backblaze.com/blog/what-smart-stats-indicate-hard-drive-failures/)
- [Arch Wiki：Solid state drive](https://wiki.archlinux.org/title/Solid_state_drive)
