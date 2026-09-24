# 高性能网络：RDMA、InfiniBand 与 RoCE

一台 8 卡 GPU 服务器读训练数据、写 checkpoint，要的存储带宽动辄几十 GB/s。用 TCP 当然也能跑到这个数，但代价是要把一大把 CPU 核拿去做拷贝、校验和中断处理，延迟还会随负载抖动。GPFS、Weka、VAST、3FS、Lustre 这些面向 AI 的存储系统，几乎无一例外把 RDMA（Remote Direct Memory Access，远程直接内存访问）当作数据面的默认传输方式。存储工程师不一定要会配交换机，但必须能看懂网卡状态、测得出链路带宽，还能判断出"存储慢"其实是网络的问题。

这一课先讲清 RDMA 为什么快、verbs 编程模型里的 QP / CQ / MR 是什么，再对比 InfiniBand 与 RoCEv2，讲无损网络（PFC、ECN、DCQCN、DSCP）和 MTU，然后用 `ibstat`、`ibv_devinfo`、`show_gids` 和 perftest 做一遍体检与带宽 / 延迟测试。最后介绍 GPUDirect Storage、多轨网络与 NUMA 亲和，为后面的 [GPFS 课程](/learn/gpfs-concepts)打基础。

> [!NOTE] 本课需要的环境
> 原理部分和 Soft-RoCE（软件模拟的 RoCE）实验在一台或两台普通 Linux 虚拟机里就能做，不需要 RDMA 网卡。真实带宽测试需要至少 2 台装有 NVIDIA（Mellanox）ConnectX 网卡的服务器，通过 InfiniBand 交换机或已配置无损的以太网交换机互联，并安装 DOCA OFED（原 MLNX OFED）或发行版自带的 rdma-core。

## 为什么存储需要 RDMA

先回顾一下[网络存储](/learn/network-storage)那一课的 TCP 路径。一次 1 MiB 的读请求在接收端要经历这些事：

```text
TCP 接收：网卡 DMA → 内核 skb 缓冲区 → 协议栈（校验、重组、ACK）→ copy_to_user → 应用缓冲区
          每个包一次中断/软中断，每字节至少一次 CPU 拷贝，每次 recv() 一次系统调用

RDMA 接收：网卡 DMA ────────────────────────────────────────────→ 应用预先注册的内存
          传输层在网卡硬件里完成，CPU 不参与数据搬运，完成后只在完成队列里放一条记录
```

RDMA 的优势可以归纳成三个词：

| 特性 | 含义 | 对存储的意义 |
| --- | --- | --- |
| 内核旁路（Kernel Bypass） | 数据路径上的操作由用户态库直接敲网卡门铃（doorbell），不进内核 | 省掉系统调用和上下文切换，小 I/O 延迟从几十微秒降到 1～3 µs |
| 零拷贝（Zero Copy） | 网卡直接 DMA 读写应用内存，不经过内核缓冲区 | 大块顺序读写时内存带宽不再被拷贝吃掉 |
| CPU 卸载（CPU Offload） | 可靠传输、分段、重传、校验全部在网卡硬件实现 | 单个核就能打满 200/400 Gb/s，CPU 留给存储服务本身或 GPU 作业 |

还有一个容易被忽视的点：**单边操作**（One-sided）。`RDMA WRITE` / `RDMA READ` 可以直接读写对端已注册的内存，对端 CPU 完全不知道这件事发生了。GPFS 的 NSD 服务器把数据从页面池（pagepool）直接 `RDMA WRITE` 到客户端的 pagepool，就是这种用法。

> [!TIP] 经验法则
> 单流 TCP 在 100 Gb/s 以上的网卡上很难跑满，而且每 10 Gb/s 大约要吃掉一个 CPU 核。当存储节点同时也是 GPU 计算节点（超融合）时，这些 CPU 本应是训练进程的——这也是 AI 集群里存储走 RDMA 的主要理由，而不只是"更快"。

## verbs：RDMA 的编程模型

应用不通过 socket，而是通过 verbs 接口（libibverbs，属于 rdma-core）使用 RDMA。不写 RDMA 程序也要懂这几个对象，因为排障时的报错和计数器全是这些名词。

| 对象 | 英文 | 作用 |
| --- | --- | --- |
| PD | Protection Domain | 保护域，把 QP 和 MR 绑在一起，防止越权访问 |
| MR | Memory Region | 注册过的内存区域。注册时内核把页面**锁定（pin）**并告诉网卡物理地址，返回本地钥匙 `lkey` 和远程钥匙 `rkey` |
| QP | Queue Pair | 一对发送队列（SQ）+ 接收队列（RQ），相当于"连接"。应用往里面投递工作请求（WR） |
| CQ | Completion Queue | 完成队列，网卡在 WR 执行完后放入完成事件（CQE），应用轮询（poll）或等待事件 |

```text
   应用                                   网卡（HCA / RNIC）
    │ ibv_post_send(WR: RDMA_WRITE,          │
    │   本地 addr+lkey, 远端 addr+rkey) ───▶ SQ ──▶ 线路 ──▶ 对端网卡直接写入对端 MR
    │                                        │
    │ ibv_poll_cq() ◀──────────────────── CQ（CQE: 成功 / 错误码）
```

一个 RC 连接从创建到可用，QP 要经过状态机 `RESET → INIT → RTR（Ready to Receive）→ RTS（Ready to Send）`，中间需要交换对端的 QP 号、LID 或 GID 等信息。这一步要么由应用自己通过 TCP 带外交换，要么交给 RDMA CM（Connection Manager，`librdmacm`）用类似 socket 的方式建立。记住这一点，后面讲 GPFS 在 RoCE 上必须开启 `verbsRdmaCm` 时就能理解了。

关键 C 调用顺序如下（省略错误处理）：

```c title="verbs 调用骨架"
ctx = ibv_open_device(dev_list[0]);
pd  = ibv_alloc_pd(ctx);
mr  = ibv_reg_mr(pd, buf, size,
                 IBV_ACCESS_LOCAL_WRITE | IBV_ACCESS_REMOTE_WRITE | IBV_ACCESS_REMOTE_READ);
cq  = ibv_create_cq(ctx, 256, NULL, NULL, 0);
qp  = ibv_create_qp(pd, &qp_init_attr);          /* qp_type = IBV_QPT_RC */
/* ibv_modify_qp: RESET -> INIT -> RTR -> RTS，需要对端的 qpn、lid/gid */
ibv_post_send(qp, &wr, &bad_wr);                 /* wr.opcode = IBV_WR_RDMA_WRITE */
while (ibv_poll_cq(cq, 1, &wc) == 0) ;           /* 忙轮询，这也是低延迟的来源之一 */
```

几个排障时常见的概念：

- **QP 类型**：RC（Reliable Connected，可靠连接，存储和 NCCL 主要用它）、UD（Unreliable Datagram，不可靠数据报）、以及 NVIDIA 的 DC（Dynamically Connected）。
- **双边与单边**：`SEND/RECV` 需要对端预先投递接收缓冲区，属于双边；`RDMA WRITE/READ` 是单边。
- **内存锁定**：MR 注册会锁页，所以容器里跑 RDMA 需要 `IPC_LOCK` 能力，`ulimit -l`（memlock）也要设成 `unlimited`，否则 `ibv_reg_mr` 会失败。

## InfiniBand 与 RoCEv2

能跑 verbs 的网络有三类：InfiniBand（IB）、RoCE（RDMA over Converged Ethernet）和 iWARP（基于 TCP，现在很少见）。RoCE 又分 v1（二层以太网帧，不能跨路由）和 v2（封装在 UDP 目的端口 4791 里，可以三层路由）。今天说 RoCE 基本都指 RoCEv2。

| 维度 | InfiniBand | RoCEv2 |
| --- | --- | --- |
| 物理网络 | 专用 IB 交换机、线缆 | 标准以太网交换机（需支持 PFC/ECN） |
| 寻址 | LID（子网内）+ GUID，由子网管理器（Subnet Manager，SM）分配 | IP 地址，映射为 GID |
| 控制平面 | 集中式：opensm 或 UFM 计算路由表 | 分布式：普通 IP 路由（BGP/OSPF） |
| 流控 | 链路层基于信用（credit-based），天生无损 | 以太网天生有损，需要 PFC + ECN 才能"无损" |
| 拥塞控制 | 硬件内建（FECN/BECN）、自适应路由 | DCQCN（依赖交换机 ECN 标记） |
| 典型速率（截至本文写作时） | HDR 200、NDR 400、XDR 800 Gb/s | 100 / 200 / 400 / 800 GbE |
| 运维门槛 | 开箱即用，但需要会 IB 工具链 | 交换机 QoS 配置复杂，出问题难排 |
| 成本与生态 | 较高，NVIDIA 基本独家 | 较低，可复用以太网运维和多厂商设备 |
| 与存储前端共网 | 需要 IPoIB 承载 TCP 流量 | 天然同一张以太网 |

怎么选？我的观点：

- **GPU 计算网（东西向、NCCL）**：预算允许就上 IB，省心；RoCE 能做到接近的性能，但前提是网络团队真的懂无损以太网。
- **存储网（南北向、访问存储）**：RoCE 更常见。存储往往要和管理网、对象存储、NFS 客户端互通，以太网更灵活；GPFS 的守护进程本来也需要 TCP/IP。
- 不管选哪个，**一定先跑 perftest 验收再上存储**，不要让存储系统替网络背锅。

> [!NOTE] Subnet Manager 必须有且只有一个主
> IB 网络里没有 SM，端口会一直停在 `Initializing` 状态，永远起不来。小规模可以在某台主机上跑 `opensm`，大规模用交换机内置 SM 或 UFM。多个 SM 会选主，其余作为备用。

## 无损网络：PFC、ECN 与 DCQCN

RoCE 的 RC 传输在网卡里实现了重传，但它的重传机制很"笨"（Go-Back-N：丢一个包，从它开始后面的全部重发）。以太网一旦丢包，RDMA 性能会断崖式下跌。所以 RoCE 部署的核心工作是让以太网**尽量不丢包**，靠两套机制配合：

```text
           发送端网卡（RP）          交换机（CP）                接收端网卡（NP）
 RoCE 数据 ─────────────────▶ 队列超过 ECN 阈值 → 标记 CE ──▶ 收到 CE 标记的包
                                                              │
      ◀──────────────────────── CNP（拥塞通知包）─────────────┘
 DCQCN：收到 CNP 就降速，一段时间没收到再逐步升速          ← 端到端、温和的"刹车"

 队列继续涨到 PFC 阈值 → 交换机向上游端口发 PAUSE（只暂停该优先级）  ← 逐跳的"急刹车"
```

| 机制 | 层次 | 作用 | 副作用 |
| --- | --- | --- | --- |
| PFC（Priority Flow Control，802.1Qbb） | 链路层，逐跳 | 按 8 个优先级之一发暂停帧，缓冲区满之前让上游停发 | 队头阻塞、暂停扩散（PFC storm）、极端情况下死锁 |
| ECN（Explicit Congestion Notification） | IP 头 2 bit | 交换机在队列变长时给包打 CE 标记，而不是丢包 | 需要端侧配合降速 |
| DCQCN | 网卡上的拥塞控制算法 | 接收端收到 CE 后回 CNP，发送端据此调速率 | 参数调优复杂 |
| DSCP / Trust 模式 | IP 头 6 bit | 用 DSCP 值决定包进哪个优先级队列，三层网络可保持分类 | 主机、交换机两端映射必须一致 |

经验法则：**ECN 是主刹车，PFC 是安全气囊**。ECN/DCQCN 调好了，PFC 应该很少触发；如果 PFC 暂停帧计数疯涨，说明拥塞控制没起作用。交换机上一定要开 PFC watchdog，防止某个卡死的网卡把暂停帧扩散到全网。

一个常见的约定（很多厂商参考配置都这样用，但以你们网络团队的规划为准）：

| 流量 | DSCP | 优先级（TC） | PFC |
| --- | --- | --- | --- |
| RoCE 数据 | 26 | 3 | 开启 |
| CNP | 48 | 6 | 关闭（严格优先转发） |
| 其他 TCP | 0 | 0 | 关闭 |

主机侧在 ConnectX 网卡上的配置大致如下（工具来自 DOCA OFED / MLNX OFED，`ens1f0`、`mlx5_0` 换成你的设备名）：

```bash
# 按 DSCP 分类（而不是 VLAN 的 PCP），三层 RoCE 网络推荐
mlnx_qos -i ens1f0 --trust dscp
# 只在优先级 3 上开启 PFC（8 个位置对应优先级 0～7）
mlnx_qos -i ens1f0 --pfc 0,0,0,1,0,0,0,0
# 查看当前 QoS 配置：trust 模式、PFC、DSCP→优先级映射、各 TC 带宽
mlnx_qos -i ens1f0

# 让 RDMA CM 建立的连接使用 ToS 106（DSCP 26 << 2 | ECN 位 ECT(0)=2）
cma_roce_tos -d mlx5_0 -t 106
# 在优先级 3 上启用 DCQCN 的接收端（NP）和发送端（RP）
echo 1 > /sys/class/net/ens1f0/ecn/roce_np/enable/3
echo 1 > /sys/class/net/ens1f0/ecn/roce_rp/enable/3

# 观察计数器：PFC 暂停帧、ECN 标记、CNP、乱序与重传
ethtool -S ens1f0 | grep -E 'pause|prio3'
cat /sys/class/infiniband/mlx5_0/ports/1/hw_counters/np_cnp_sent
cat /sys/class/infiniband/mlx5_0/ports/1/hw_counters/rp_cnp_handled
cat /sys/class/infiniband/mlx5_0/ports/1/hw_counters/out_of_sequence
```

这些 sysfs 配置重启后会丢失，生产上要写进 systemd 单元或网卡配置工具里固化。

> [!WARNING] 主机和交换机必须"对暗号"
> 主机把 RoCE 流量标成 DSCP 26，交换机却把 DSCP 26 映射到没开 PFC 的队列——链路能通、perftest 小流量也正常，一到多对多压测就大量丢包重传。排查时同时看两端：主机 `mlnx_qos` 输出、交换机端口的 PFC 收发计数和 ECN 标记计数。

## MTU：两层都要对

RDMA 有自己的 MTU，最大 4096 字节，和以太网 MTU 是两回事：

- **IB**：`ibv_devinfo` 里的 `active_mtu` 通常是 4096，由 SM 和端口能力协商。
- **RoCE**：RoCE MTU 取"不超过以太网 MTU 减去报文头"的最大合法值（256/512/1024/2048/4096）。以太网 MTU 保持默认 1500 时 RoCE MTU 只有 1024，所以存储网卡一般设成 **9000**（得到 RoCE MTU 4096），交换机端口设成 9216 留余量。

```bash
ip link set ens1f0 mtu 9000
ibv_devinfo -d mlx5_0 | grep -E 'max_mtu|active_mtu'
#   max_mtu:     4096 (5)
#   active_mtu:  4096 (5)

# 端到端验证巨帧：8972 = 9000 - 20(IP) - 8(ICMP)，-M do 禁止分片
ping -M do -s 8972 -c 3 192.168.20.12
```

路径上任何一跳 MTU 更小，大包就会被丢掉，表现为"小 I/O 正常，大块读写卡死"。这类问题的现象和存储 bug 非常像，一定先用 `ping -M do` 排除。

## 网卡体检：从 lspci 到 show_gids

拿到一台新机器，按下面的顺序检查。

```bash
# 1. 硬件在不在，是 IB 还是以太网模式
lspci -nn | grep -i mellanox
# 19:00.0 Infiniband controller [0207]: Mellanox Technologies MT2910 Family [ConnectX-7] [15b3:1021]
# a8:00.0 Ethernet controller [0200]: Mellanox Technologies MT28908 Family [ConnectX-6] [15b3:101b]

# 2. RDMA 设备与网络接口的对应关系（ibdev2netdev 随 OFED 提供；rdma 命令属于 iproute2）
ibdev2netdev
# mlx5_0 port 1 ==> ib0 (Up)
# mlx5_4 port 1 ==> ens1f0 (Up)
rdma link show

# 3. 端口状态、速率（infiniband-diags）
ibstat mlx5_0
```

```text
CA 'mlx5_0'
        CA type: MT4129
        Number of ports: 1
        Firmware version: 28.39.1002
        Port 1:
                State: Active
                Physical state: LinkUp
                Rate: 400
                Base lid: 12
                SM lid: 1
                Link layer: InfiniBand
```

`State: Active` + `Physical state: LinkUp` 才算好。`LinkUp` 但 `Initializing` 说明 IB 网络没有 SM；`Polling` 说明物理链路没起来，查线缆和光模块。`Rate` 低于预期（比如 400G 卡只协商到 200）多半是线缆不匹配或端口降速。

```bash
# 4. 设备能力与 MTU
ibv_devinfo -d mlx5_4
#   transport:      InfiniBand (0)       ← RoCE 设备这里也显示 InfiniBand，看 link_layer
#   fw_ver:         22.39.1002
#   port:   1
#       state:          PORT_ACTIVE (4)
#       active_mtu:     4096 (5)
#       link_layer:     Ethernet

# 5. RoCE 专用：GID 表
show_gids mlx5_4
```

```text
DEV     PORT  INDEX  GID                                      IPv4            VER  DEV
---     ----  -----  ---                                      ------------    ---  ---
mlx5_4  1     0      fe80:0000:0000:0000:0a88:c2ff:fe11:2233                  v1   ens1f0
mlx5_4  1     1      fe80:0000:0000:0000:0a88:c2ff:fe11:2233                  v2   ens1f0
mlx5_4  1     2      0000:0000:0000:0000:0000:ffff:c0a8:140b  192.168.20.11   v1   ens1f0
mlx5_4  1     3      0000:0000:0000:0000:0000:ffff:c0a8:140b  192.168.20.11   v2   ens1f0
```

RoCE 的每个 IP 地址会在 GID 表里生成 v1、v2 各一条。**测试和应用要选"RoCE v2 + 正确 IP"的那一条**（这里是 index 3），选错了要么不通，要么走了不可路由的 v1。GID index 会随 IP、VLAN、macvlan 子接口增减而变化，不要在脚本里想当然地写死。

其他常用工具：`mst status -v`（查看网卡 PCIe 地址与 NUMA 节点，来自 MFT）、`mlxlink -d <pci> -m`（链路与光模块诊断）、`ibdiagnet`（IB 全网体检）、`iblinkinfo`（IB 拓扑）。

## perftest：带宽与延迟测试

perftest 是 RDMA 的"iperf"，一端当服务端（不带地址），另一端当客户端（带服务端 IP）。

```bash
# 服务端（192.168.20.11）
ib_write_bw -d mlx5_4 -x 3 --report_gbits -q 4
# 客户端
ib_write_bw -d mlx5_4 -x 3 --report_gbits -q 4 192.168.20.11
```

```text
 #bytes     #iterations    BW peak[Gb/sec]    BW average[Gb/sec]   MsgRate[Mpps]
 65536      20000            392.35             391.87              0.747
```

| 参数 | 含义 |
| --- | --- |
| `-d` | RDMA 设备名，用 `ibv_devices` 或 `ibdev2netdev` 查 |
| `-x` | GID index，RoCE 必填；IB 可省略 |
| `-q` | QP 数量，多 QP 更容易打满大带宽网卡 |
| `-s` / `-a` | 指定消息大小 / 从 2 字节扫到 8 MiB 全部测一遍 |
| `-R` | 使用 RDMA CM 建连（验证 RDMA CM 路径是否通） |
| `-F` | 忽略 CPU 频率调节警告 |
| `--report_gbits` | 以 Gb/s 输出，方便和网卡标称速率对比 |
| `--use_cuda=0` | 使用 0 号 GPU 显存做缓冲区，测试 GPUDirect RDMA（需编译时带 CUDA 支持） |

延迟测试用 `_lat` 系列：

```bash
ib_read_lat -d mlx5_4 -x 3                  # 服务端
ib_read_lat -d mlx5_4 -x 3 192.168.20.11    # 客户端
#  #bytes #iterations  t_min[usec]  t_max[usec]  t_typical[usec]  t_avg[usec]  99% percentile[usec]
#  2       1000         2.05         4.87         2.12             2.14         2.40
```

判定参考（同一交换机下，截至本文写作时的主流网卡）：

| 测试 | 正常范围 | 异常时先查 |
| --- | --- | --- |
| `ib_write_bw`，400G 网卡 | 360～395 Gb/s | 线缆降速、PCIe 宽度 / 代数（`lspci -vv` 看 `LnkSta`）、NUMA |
| `ib_write_bw`，200G 网卡 | 180～197 Gb/s | 同上 |
| `ib_read_lat` / `ib_write_lat` 小消息 | 1～3 µs（RoCE 略高于 IB） | 电源管理（C-state）、跨交换机跳数 |
| 带宽只有几 Gb/s | — | GID 选错走了别的网口、MTU 不一致、PFC 未生效 |

`ib_read_bw` 通常比 `ib_write_bw` 略低，因为 READ 需要请求—响应往返，并且受网卡 outstanding read 数量限制。GPFS 这类系统两种操作都会用，都要测。

> [!PROD] 验收要测"多对多"，不只是"一对一"
> 一对一 perftest 只证明两块网卡和中间那段链路没问题。无损配置是否正确，只有在**多对一**（incast，多个客户端同时写一个存储节点）的场景下才会暴露。上线前让所有客户端同时对存储节点跑 `ib_write_bw`，观察带宽是否均匀、PFC 暂停帧和 `out_of_sequence` 计数是否失控。

## 存储系统怎么用 RDMA：以 GPFS 为例

GPFS 的 RDMA 支持集中在几个 `mmchconfig` 参数上（细节见 [GPFS ECE 部署](/learn/gpfs-deploy)）：

| 参数 | 作用 |
| --- | --- |
| `verbsRdma=enable` | 数据 I/O（pagepool 之间的数据块）走 RDMA，默认关闭 |
| `verbsPorts="mlx5_4/1 mlx5_5/1"` | 使用哪些 RDMA 端口，多个端口空格分隔，可带 fabric 编号 |
| `verbsRdmaSend=yes` | 守护进程之间的 RPC 也走 RDMA；超大规模（数百节点以上）集群出于稳定性常保持关闭 |
| `verbsRdmaCm=enable` | 用 RDMA CM 建连，**RoCE 必须开启** |

即便开了 RDMA，GPFS 的守护进程网络（心跳、租约、token、建连）**永远需要 TCP/IP**，在 IB 上就是 IPoIB。RDMA 出问题时 GPFS 会回退到 TCP 继续工作——这是健壮性设计，但也意味着"RDMA 悄悄没生效、性能掉了一大截"是很常见的故障。用下面的命令确认：

```bash
mmfsadm test verbs status      # VERBS RDMA status: started
mmdiag --network               # 每条连接后面显示 RDMA 还是 TCP
```

## GPUDirect RDMA 与 GPUDirect Storage

普通的"存储 → GPU"路径是这样的：存储数据先进 CPU 内存（bounce buffer），再 `cudaMemcpy` 进显存。GPUDirect 系列让网卡或 NVMe 直接和显存打交道：

```text
普通路径：  存储 ──RDMA──▶ 主机内存（bounce buffer）──PCIe──▶ GPU 显存
GDS：       存储 ──RDMA─────────────────────────────PCIe──▶ GPU 显存
            （网卡经 PCIe 交换芯片直接 DMA 到显存，不经过 CPU 内存）
```

- **GPUDirect RDMA**：网卡直接读写显存，主要用于 NCCL 集合通信。需要 `nvidia-peermem` 内核模块。
- **GPUDirect Storage（GDS）**：面向文件 I/O，应用调用 cuFile API（`cuFileRead` / `cuFileWrite`），由 `nvidia-fs` 驱动和支持 GDS 的文件系统配合完成 DMA。GPFS、Weka、VAST、Lustre（EXAScaler）、BeeGFS 以及本地 NVMe / NVMe-oF 都有支持（截至本文写作时，以各厂商兼容列表为准）。GPFS 需要先启用 `verbsRdma`，再开启 GDS 相关参数，参数名与版本要求以 IBM 文档的 GDS 章节为准。

```bash
# CUDA 安装目录下的 GDS 工具
/usr/local/cuda/gds/tools/gdscheck -p        # 检查驱动、文件系统、IOMMU 等是否满足 GDS 条件
/usr/local/cuda/gds/tools/gdsio -f /gpfs/fs1/test -d 0 -w 8 -s 10G -i 1M -x 0 -I 1   # 以 GDS 方式写
```

GDS 的收益主要在"CPU 内存带宽或 CPU 核是瓶颈"的场景，比如数据预处理在 GPU 上做（DALI）、大模型 checkpoint 直接从显存落盘。PyTorch 默认的 DataLoader 仍然走 CPU 内存，开了 GDS 也不会自动变快。别为了 GDS 而 GDS，先测。

> [!WARNING] IOMMU 与 ACS 会让 P2P 失效
> GPUDirect 依赖 PCIe 设备之间的点对点（P2P）传输。BIOS 里开启 IOMMU 或 PCIe 交换芯片开启 ACS（Access Control Services）时，P2P 流量会被强制绕到 CPU 根复合体，带宽大幅下降甚至失败。`gdscheck -p` 和 `nvidia-smi topo -m` 是第一步检查工具。

## 多轨网络与 NUMA 亲和

一台典型的 8 卡 AI 服务器有三套网络：

| 网络 | 典型配置 | 用途 |
| --- | --- | --- |
| 计算网（后端） | 8 × 400G IB 或 RoCE，每张 GPU 配一张，称为 8 轨（rail） | NCCL 集合通信 |
| 存储网（前端） | 2 × 200G RoCE / IB | 访问 GPFS 等并行存储 |
| 管理网 | 1～2 × 25G | SSH、K8s 控制面、监控 |

"多轨"的意思是：所有服务器的 1 号网卡接同一组 leaf 交换机（rail 1），2 号网卡接 rail 2……同号 GPU 之间的通信在一个 rail 内完成，跳数最少。存储网独立出来，避免 checkpoint 写入和 AllReduce 抢带宽。

NUMA 亲和是多网卡服务器最容易踩的坑。双路服务器每个 CPU 插槽下挂着一半的 PCIe 设备，进程如果跑在 CPU0、网卡挂在 CPU1，数据就要走 UPI/Infinity Fabric 跨插槽，带宽下降、延迟上升。

```bash
# 网卡在哪个 NUMA 节点
cat /sys/class/infiniband/mlx5_4/device/numa_node      # 1
cat /sys/class/net/ens1f0/device/local_cpulist         # 32-63,96-127
# GPU、网卡、CPU 的拓扑矩阵，PIX/PXB 表示同一 PCIe 交换芯片下，SYS 表示跨插槽
nvidia-smi topo -m

# 测试时把 perftest 绑到网卡所在的 NUMA 节点
numactl --cpunodebind=1 --membind=1 ib_write_bw -d mlx5_4 -x 3 --report_gbits 192.168.20.11
```

跨 NUMA 与同 NUMA 各测一次，差异一目了然。对存储客户端来说：GPFS 的 pagepool 是一大块常驻内存，建议开启 `numaMemoryInterleave=yes` 让它均匀分布在各 NUMA 节点上；如果有两张存储网卡，最好分属两个插槽，并都写进 `verbsPorts`，让两边的进程都能就近访问网卡。

> [!PROD] 超融合节点的网络规划
> 当 GPU 计算节点同时是存储节点（比如 GPFS ECE），存储副本 / 纠删码重建的流量也走存储网。规划时按"客户端读写 + 节点间纠删码流量"两份来算带宽，并且**不要让存储流量和 NCCL 共用计算网卡**——训练作业的 AllReduce 对抖动极其敏感，存储重建一来，整个训练的步时都会变长。

## 动手练习

1. 在一台 Ubuntu 虚拟机上用 Soft-RoCE 体验 verbs：`sudo apt install -y rdma-core ibverbs-utils perftest infiniband-diags`，`sudo modprobe rdma_rxe && sudo rdma link add rxe0 type rxe netdev eth0`（网卡名换成你的），然后执行 `ibv_devices`、`ibv_devinfo -d rxe0`，并用 `rdma link show` 确认设备状态。
2. 在两台装了 Soft-RoCE 的虚拟机之间跑 `ibv_rc_pingpong -d rxe0 -g 1`（服务端）和 `ibv_rc_pingpong -d rxe0 -g 1 <服务端IP>`（客户端），再跑一次 `ib_write_bw -d rxe0 -x 1`。对比同一对虚拟机上 `iperf3` 的结果，想想为什么 Soft-RoCE 并不比 TCP 快（提示：它没有硬件卸载）。
3. 把一台虚拟机的 MTU 改成 1500、另一台改成 9000，用 `ping -M do -s 8972` 复现"大包不通"的现象，再观察 `ibv_devinfo` 中 `active_mtu` 的变化。
4. 如果你有真实 RDMA 环境：分别用 `-q 1` 和 `-q 8` 跑 `ib_write_bw`，再分别在网卡所在 NUMA 节点和另一个 NUMA 节点上跑，记录四组带宽，写一份一页纸的验收记录。
5. 在 RoCE 环境里执行 `show_gids`，给某个接口临时加一个 IP（`ip addr add`），观察 GID 表的变化，说明为什么脚本里不应写死 GID index。

## 自测

<details>
<summary>RDMA 的"内核旁路、零拷贝、CPU 卸载"分别省掉了 TCP 路径里的什么开销？</summary>

内核旁路省掉了数据路径上的系统调用和上下文切换，应用在用户态直接向网卡投递请求；零拷贝省掉了内核缓冲区和用户缓冲区之间的内存拷贝，网卡直接 DMA 到已注册内存；CPU 卸载把可靠传输、分段、重传和校验放进网卡硬件，省掉了协议栈处理和大量中断。结果是更低、更稳定的延迟，以及用极少的 CPU 就能打满高速网卡。

</details>

<details>
<summary>为什么 RDMA 程序注册内存（MR）需要锁页？这在容器里意味着什么？</summary>

网卡通过物理地址直接 DMA 读写内存，如果页面被换出或迁移，网卡会写到错误的位置。所以注册 MR 时内核会锁定（pin）这些页面并把地址翻译表交给网卡。在容器里，这要求容器有 `IPC_LOCK` 能力，并且 memlock 限制（`ulimit -l`）足够大，通常设为 unlimited，否则 `ibv_reg_mr` 会失败。

</details>

<details>
<summary>RoCE 网络里 PFC 和 ECN 各起什么作用？为什么说 ECN 是主刹车、PFC 是安全气囊？</summary>

ECN 由交换机在队列变长时给报文打标记，接收端回 CNP，发送端按 DCQCN 算法降速，是端到端、渐进的拥塞控制。PFC 是逐跳的暂停机制，在缓冲区即将溢出时让上游暂停某个优先级的发送，保证不丢包。PFC 会带来队头阻塞、暂停扩散甚至死锁，所以理想状态是 ECN/DCQCN 把拥塞控制住，PFC 只在突发时兜底；PFC 计数频繁增长说明拥塞控制没调好。

</details>

<details>
<summary>一对服务器之间 ib_write_bw 只跑出 5 Gb/s，列出你会依次检查的几项。</summary>

先看 `ibstat` / `ibv_devinfo` 端口是否 Active、速率是否正确；确认 `-d` 设备和 `-x` GID index 选的是 RoCE v2 + 正确 IP 的条目；用 `ping -M do -s 8972` 检查路径 MTU；看 `lspci -vv` 的 `LnkSta` 确认 PCIe 没有降速；检查进程是否跨 NUMA；最后查看 `ethtool -S` 的 pause 计数和 `hw_counters` 里的 `out_of_sequence`、CNP 计数，判断是否存在丢包和无损配置问题。

</details>

<details>
<summary>GPFS 已经配置了 verbsRdma=enable，怎样确认数据真的走了 RDMA？为什么会出现"悄悄没走"的情况？</summary>

执行 `mmfsadm test verbs status` 看 RDMA 是否 started，再用 `mmdiag --network` 查看各连接使用的是 RDMA 还是 TCP。GPFS 的守护进程网络始终基于 TCP/IP，RDMA 建连失败（比如 RoCE 没开 `verbsRdmaCm`、`verbsPorts` 写错设备名、端口未 Active）时会自动回退到 TCP 继续提供服务，业务不会报错，只是性能明显下降，所以必须主动检查。

</details>

## 参考资料

- [linux-rdma/rdma-core：用户态 RDMA 库与工具](https://github.com/linux-rdma/rdma-core)
- [linux-rdma/perftest：RDMA 性能测试工具](https://github.com/linux-rdma/perftest)
- [Linux 内核文档：InfiniBand](https://docs.kernel.org/infiniband/index.html)
- [NVIDIA RDMA Aware Networks Programming User Manual](https://docs.nvidia.com/networking/display/rdmaawareprogrammingv17)
- [NVIDIA 网络文档（DOCA OFED、mlnx_qos、ConnectX 手册）](https://docs.nvidia.com/networking/)
- [NVIDIA GPUDirect Storage 文档](https://docs.nvidia.com/gpudirect-storage/)
- [Zhu et al. Congestion Control for Large-Scale RDMA Deployments（DCQCN，SIGCOMM 2015）](https://conferences.sigcomm.org/sigcomm/2015/pdf/papers/p523.pdf)
- [InfiniBand Trade Association](https://www.infinibandta.org/)
- [IBM Storage Scale：RDMA tuning](https://www.ibm.com/docs/en/storage-scale/5.2.3?topic=administering-rdma-tuning)
- [Spectrum Scale 用户组：Improving Spectrum Scale performance using RDMA](https://www.spectrumscaleug.org/wp-content/uploads/2021/05/SSSD21DE-06-Improving-Spectrum-Scale-performance-using-RDMA.pdf)
