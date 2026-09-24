# On-call、SOP 与故障复盘

前面几十课讲的都是"怎么把存储建好、调快"。这最后一课讲的是另一半：**半夜三点告警响了，怎么不把小事搞成大事**。存储事故有个残酷的特点，大部分数据丢失不是硬件造成的，而是人在压力下敲错了命令：拔错了盘、对错误的 OSD 执行了 `purge`、在还有降级 PG 的时候又重启了一台机器。

这一课整理团队的 on-call 体系：告警怎么分级、SOP（Standard Operating Procedure，标准操作程序）怎么写、变更怎么管、复盘怎么做、备份和容灾守住哪几条底线。最后一节给出这套教程之后的成长路径。学完你应该能为自己的集群写出第一份 SOP，并主持一次像样的复盘。

> [!NOTE] 本课需要的环境
> 大部分内容是流程和模板，不需要特定环境。"替换 OSD 坏盘"的 SOP 可以在 [cephadm 部署](/learn/cephadm-deploy) 搭建的测试集群上完整演练（用 loop 设备或虚拟盘模拟坏盘）；告警规则需要 [存储监控与告警](/learn/storage-monitoring) 一课里的 Prometheus 环境。

## 存储事故为什么特别

无状态服务出了问题，最坏的办法是全部重启、回滚版本，十分钟后又是一条好汉。存储不行：

| 特点 | 无状态服务 | 存储系统 |
| --- | --- | --- |
| 可逆性 | 回滚版本即可 | **数据删了就是删了**，没有回滚按钮 |
| 恢复速度 | 分钟级 | 重建一个节点几小时，恢复 PB 级数据几天到几周 |
| 爆炸半径 | 一个服务 | 一个集群背后是几千个 PV、几百台虚拟机、所有训练作业 |
| 故障可见性 | 报错立刻暴露 | 静默损坏、配置漂移可能几个月后才暴露 |
| 级联效应 | 通常隔离 | 一个 OSD 写满，整个存储池拒绝写入 |

由此推出存储 on-call 的第一原则：**先止血、保数据，再恢复服务**。不确定的时候，什么都不做往往比做错更好。Ceph 在降级状态下仍然能服务，只要你不去"帮倒忙"。

## 告警分级与响应时限

### P0~P3 分级

分级的依据只有两个：**有没有丢数据的风险**、**业务是否已经受影响**。

| 级别 | 定义 | 存储场景示例 | 响应时限 | 处理方式 |
| --- | --- | --- | --- | --- |
| P0 | 数据丢失风险或服务不可用 | PG `inactive` / `incomplete`；`OSD_FULL` 存储池拒绝写入；MON 失去法定人数；文件系统无法挂载 | 5 分钟内响应 | 电话呼叫主备 on-call，拉起事故群，指定指挥者，每 30 分钟同步进展 |
| P1 | 冗余已降级、再坏一处就会升级为 P0 | 同一故障域内多个 OSD down；仍有 PG 只剩最后一份数据；任一 OSD 预计 3 天内写满 | 15 分钟内响应 | 电话呼叫 on-call，当班处理完 |
| P2 | 有影响但冗余充足 | 单个 OSD down 且恢复正常进行；持续 `SLOW_OPS`；OSD 使用率超过 75% | 工作时间 4 小时内 | IM 通知，当天处理 |
| P3 | 需要关注的趋势 | SMART 预警、时钟偏移、scrub 发现并已修复的不一致、证书 30 天后过期 | 1 周内 | 自动建工单，例会过一遍 |

几条原则：

- **每一条会呼叫人的告警都必须可操作，并链接到 SOP**。收到告警却不知道该干什么，或者看一眼就知道不用管，都说明这条告警该降级或删除。
- **按症状告警，按原因排查**。"存储池 5 分钟内写入延迟 p99 超过 100 ms"比"某个 OSD 的 CPU 高"更值得半夜叫醒人。
- **容量告警用趋势，不用阈值**。"80% 了"不说明紧急程度，"按当前速度 3 天后写满"才说明。
- **控制呼叫量**。Google SRE 的经验是一个 12 小时班次里需要处理的事件不超过 2 个，否则 on-call 的人没时间把事情做对，只能疲于应付。

### 告警规则示例

基于 Ceph MGR prometheus 模块导出的指标：

```yaml title="storage-oncall-rules.yaml"
groups:
  - name: storage-oncall
    rules:
      - alert: CephHealthError
        expr: ceph_health_status == 2
        for: 5m
        labels:
          severity: P0
        annotations:
          summary: "Ceph 集群 HEALTH_ERR"
          runbook_url: "https://wiki.example.com/sop/ceph-health-error"

      - alert: CephOSDWillFillIn3Days
        # 任一 OSD 按最近 6 小时趋势，3 天后超过 nearfull
        expr: |
          predict_linear(ceph_osd_stat_bytes_used[6h], 3 * 24 * 3600)
            / ceph_osd_stat_bytes > 0.85
        for: 30m
        labels:
          severity: P1
        annotations:
          summary: "{{ $labels.ceph_daemon }} 预计 3 天内达到 nearfull"
          runbook_url: "https://wiki.example.com/sop/ceph-capacity"

      - alert: CephOSDDown
        expr: count(ceph_osd_up == 0) > 0
        for: 10m
        labels:
          severity: P2
        annotations:
          summary: "{{ $value }} 个 OSD 处于 down 状态"
          runbook_url: "https://wiki.example.com/sop/ceph-replace-osd"
```

`for: 10m` 和 Ceph 默认的 `mon_osd_down_out_interval`（600 秒，OSD down 10 分钟后被标记为 out 并开始恢复）是对齐的：OSD 短暂闪断不打扰人，真坏了再通知。

### 轮值与交接

- **主备双人**：主 on-call 负责响应，备 on-call 在主 15 分钟未响应时自动升级，也是 P0 时的第一个帮手。
- **升级路径写清楚**：on-call → 存储负责人 → 厂商支持（商业存储要提前确认支持合同的响应级别和报障方式）。
- **交接要留痕**：每班结束写一段交接记录，包括未关闭的告警、正在进行的恢复、临时设置的标志位（比如 `noout`）。**临时标志位忘记取消**是交接中最常见的遗漏。

## SOP：把经验写成可以照着做的步骤

SOP 的价值在于：半夜被叫醒、脑子只有平时一半清醒的时候，照着做也不会出错。它不是教程，不解释原理，只写"在什么情况下、先检查什么、执行哪些命令、怎么判断成功、失败了怎么退回"。

### SOP 模板

```text
标题：    <动词 + 对象>，例如"替换 Ceph OSD 坏盘"
适用场景： 什么情况下用这份 SOP；什么情况下【不能】用、应该升级
影响评估： 对业务的影响、预计耗时、是否需要变更窗口
前置检查： 每一项都是命令 + 期望输出，任何一项不符合就停止
操作步骤： 编号步骤；每步写命令、期望输出、预计耗时
回滚方案： 每个关键步骤失败后如何退回到安全状态
验证：    怎样算完成；需要观察多久
收尾：    工单、资产台账、RMA、通知
修订记录： 日期、修改人、修改原因（每次事故后回来更新）
```

### 示例：替换 OSD 坏盘（cephadm）

下面是团队在用的 SOP 的通用化版本，主机名、设备名都是示例。

**适用场景**：单块数据盘故障（`dmesg` 有 I/O 错误、SMART 报错或 OSD 反复崩溃），集群除这块盘外健康。

**不适用、立即升级为 P0/P1**：同时有多个故障域的 OSD down；存在 `inactive`、`incomplete`、`down` 状态的 PG；故障盘是 HDD 集群里的 DB/WAL NVMe（会连带多个 OSD）。

**影响评估**：冗余充足时业务无感知；恢复期间有额外 I/O，延迟可能略升。预计人工操作 30 分钟，数据恢复时间取决于盘的容量。

#### 前置检查

```bash
# 1. 集群状态：除了这块盘相关的告警之外，不应有其他异常
ceph -s
ceph health detail

# 2. 确认 down 的 OSD 只有这一个，记下 OSD ID（下文以 osd.12 为例）
ceph osd tree down

# 3. 定位主机和物理设备，记录序列号
ceph osd metadata 12 | grep -E '"hostname"|"devices"|"device_ids"'
ceph device ls-by-daemon osd.12

# 4. 没有 PG 处于 inactive / incomplete / down
ceph pg ls inactive incomplete down

# 5. 移除这个 OSD 不会导致数据不可用
ceph osd safe-to-destroy osd.12

# 6. OSD 服务规格是否由 cephadm 管理（决定新盘是否会自动建 OSD）
ceph orch ls osd --export
```

`safe-to-destroy` 如果返回"不安全"，说明还有 PG 依赖这个 OSD 上的数据，**等恢复完成再继续**，不要加 `--force`。

> [!WARNING] 坏盘不要设 noout
> `noout` 会阻止 down 的 OSD 被标记为 out，也就阻止了数据恢复。它适用于"计划内、几分钟就能回来"的维护，比如重启一台机器。对一块已经坏掉、短期不会回来的盘设 `noout`，等于让集群在降级状态下多待几个小时。

#### 操作步骤

```bash
# 步骤 1：标记 OSD 待替换。--replace 会保留 OSD ID 和 CRUSH 位置，
# 新盘上线后复用同一个 ID，避免数据二次迁移
ceph orch osd rm 12 --replace
ceph orch osd rm status          # 等待该 OSD 从列表中消失
ceph osd tree | grep osd.12      # 状态应为 destroyed

# 步骤 2：点亮故障盘定位灯（需要硬件支持；不支持时用序列号核对）
ceph device light on <device_id> ident

# 步骤 3：机房人员更换硬盘。更换前后都由第二个人核对序列号：
# 拔下的盘序列号 == 前置检查第 3 步记录的序列号

# 步骤 4：关闭定位灯，刷新设备清单，确认新盘可用
ceph device light off <device_id> ident
ceph orch device ls sn-01 --refresh
# 新盘 AVAILABLE 列应为 Yes；如果有残留分区，先清理：
# ceph orch device zap sn-01 /dev/nvme3n1 --force

# 步骤 5：OSD 规格为托管状态时，cephadm 会自动在新盘上创建 osd.12。
# 如果规格是 unmanaged，手动添加：
ceph orch daemon add osd sn-01:/dev/nvme3n1
```

#### 回滚方案

| 失败点 | 处理 |
| --- | --- |
| 步骤 1 后发现 OSD ID 选错 | 立即停止。如果 `ceph orch osd rm status` 里它还在排队或排空，用 `ceph orch osd rm stop <id>` 取消；如果已经是 `destroyed`，**不要 zap、不要 purge、不要拔盘**，盘上数据仍在、其他副本也在，保持原样并升级给存储负责人 |
| 步骤 3 拔错盘 | 马上插回原位。被误拔的 OSD 通常会自动重新上线；确认 `ceph -s` 中 down 的 OSD 恢复为 up 后再继续 |
| 步骤 5 新 OSD 创建失败 | 保持 `destroyed` 状态即可，集群只是少一块盘、冗余已经恢复。查看 `cephadm logs --name osd.12` 排查，不要执行 `ceph osd purge` |

#### 验证

```bash
ceph osd tree | grep osd.12      # up，权重与同机其他 OSD 一致
ceph -s                          # 等待回填完成，所有 PG active+clean
ceph osd df tree                 # osd.12 使用率逐步接近同类 OSD
ceph device ls | grep sn-01      # 新盘序列号已登记
```

完成标准：`HEALTH_OK` 且所有 PG `active+clean`，观察 30 分钟无新的 `SLOW_OPS`。

**收尾**：关闭工单；更新资产台账中的盘序列号；故障盘走 RMA，含敏感数据的盘按安全规范销毁而不是寄回厂商。更多 Day-2 操作见 [Ceph Day-2 运维](/learn/ceph-day2)。

## 变更管理

事故统计里，一大半是变更引起的。变更管理的目标不是"让变更变难"，而是"让变更出错时影响小、能退回"。

### 变更窗口

- 选在业务低峰，比如工作日晚上。**不在周五下午、节假日前一天做变更**，出了问题没人支援。
- 窗口要留足回滚时间：计划 1 小时的操作，申请 2 小时窗口。
- 紧急变更（修复 P0/P1）可以不走窗口，但事后要补记录。

### 灰度

存储变更一律由小到大推进，每一步都要观察到稳定再继续：

```text
测试集群 ──▶ 1 个 OSD ──▶ 1 台主机 ──▶ 1 个故障域 ──▶ 全集群
   │           │            │             │
   └── 每一步：观察 HEALTH、延迟、错误日志至少 30 分钟 ──┘
```

升级、内核参数调整、固件更新都按这个节奏走。`ceph orch upgrade` 本身就是滚动的，可以用 `ceph orch upgrade pause` 随时暂停。

### 保护标志位

Ceph 提供了一组集群标志位，在维护时临时关闭某些自动行为：

| 标志位 | 作用 | 典型用途 |
| --- | --- | --- |
| `noout` | down 的 OSD 不会被标记为 out | 重启主机、短时维护 |
| `norebalance` | 不因 CRUSH 变化而重新均衡 | 批量加盘前先设，全部加完再取消，只迁移一次 |
| `nobackfill` / `norecover` | 暂停回填 / 恢复 | 恢复流量压垮业务时临时止血 |
| `noscrub` / `nodeep-scrub` | 暂停 scrub | 业务高峰或恢复期间减少额外 I/O |
| `pause` | **暂停所有客户端读写** | 几乎不用，用之前请三思 |

```bash
# 只对一台主机设置 noout，比全局设置更安全
ceph osd set-group noout sn-01
# ……维护……
ceph osd unset-group noout sn-01

# 也可以用维护模式，它会自动设置 noout 并停止该主机上的守护进程
ceph orch host ok-to-stop sn-01
ceph orch host maintenance enter sn-01
ceph orch host maintenance exit sn-01
```

标志位设置后集群会显示 `OSDMAP_FLAGS` 警告。建议再加一条告警：**任何标志位持续超过 4 小时就通知**，防止维护完忘记取消。

### 双人复核

- **变更单先评审**：写变更单的人和评审的人不能是同一个。变更单里要有完整命令、预期输出和回滚步骤，执行时从变更单复制，不临场手敲。
- **高危命令四眼原则**：执行时第二个人看着屏幕确认。高危命令清单至少包括：`ceph osd purge`、`ceph osd pool delete`、`rbd rm`、`ceph fs rm`、`ceph-volume lvm zap`、`wipefs`、`dd`、`mkfs`，以及 GPFS 的 `mmdelfs`、`mmdelnsd` 等。
- **不在错误的终端里执行**：生产和测试集群的 shell 提示符用不同颜色区分，`PS1` 里带上集群名。

## 故障复盘

复盘（Postmortem）的目的是找到**系统性**的改进点，不是找人背锅。如果复盘的结论是"某某操作失误，已批评教育"，那下次换一个人还会犯同样的错。团队遵循 blameless（不追责）原则：假设每个人在当时的信息下都做出了合理的判断，问题在于系统没有阻止错误发生。

### 复盘模板

```text
标题：    <日期> <一句话描述>
级别：    P0 / P1
摘要：    3~5 句话：发生了什么、影响多大、怎么恢复的、根因是什么
影响：    受影响的业务、用户数、持续时间、是否丢数据
时间线：  从"问题开始"而不是"发现问题"算起，精确到分钟
根因分析：5 Whys，一直问到"流程或系统"层面
做得好的：哪些措施缩短了恢复时间
运气成分：哪些因素差一点就让事情更糟
改进项：  每一项都有负责人、截止日期、优先级，并跟踪到关闭
```

### 示例：一次 OSD 写满导致的写入中断

**摘要**：凌晨一台存储节点宕机，数据恢复过程中 osd.37 达到 `full_ratio`，存储池拒绝写入 23 分钟，数百个虚拟机 I/O 挂起。无数据丢失。

**时间线**（UTC+8）：

| 时间 | 事件 |
| --- | --- |
| 01:32 | sn-07 电源故障宕机，12 个 OSD down |
| 01:42 | OSD 被标记为 out，开始恢复；`CephOSDDown` P2 告警发到 IM，无人响应（夜间 P2 不呼叫） |
| 02:10 | osd.37 使用率达到 95%，`OSD_FULL`，存储池停止写入 |
| 02:12 | `CephHealthError` P0 呼叫 on-call |
| 02:25 | on-call 定位到 osd.37 写满，决定临时调整比例 |
| 02:31 | 执行 `ceph osd set-full-ratio 0.96` 临时抬高水位，同时 `ceph osd reweight 37 0.9` 降低其权重 |
| 02:33 | 存储池恢复写入，业务 I/O 逐步恢复 |
| 02:50 | osd.37 使用率回落到 90% 以下 |
| 09:30 | sn-07 修复上线，恢复完成后将 full ratio 改回 0.95 |

**5 Whys**：

1. 为什么存储池拒绝写入？osd.37 使用率达到了 95% 的 `full_ratio`。
2. 为什么 osd.37 会写满？sn-07 宕机后数据在剩余节点上重建，而宕机前集群平均使用率已经是 80%，超过了 10 节点集群 N-1 余量允许的 76.5%。
3. 为什么使用率超标没人处理？容量告警按集群平均值设在 85%，而 OSD 之间使用率相差近 10%，最满的 osd.37 宕机前已经 88%。
4. 为什么 OSD 使用率偏差这么大？三个月前升级后 balancer 被关闭用于排查问题，之后没有重新开启。
5. 为什么没有发现 balancer 被关闭？升级 SOP 的验证步骤里没有检查 balancer 状态，也没有配置漂移检测。

**改进项**：

| 改进项 | 负责人 | 截止 | 优先级 |
| --- | --- | --- | --- |
| 容量告警改为单 OSD 维度 + 趋势预测（`predict_linear`） | 张三 | 1 周 | 高 |
| 升级 SOP 增加 balancer、标志位、关键参数的检查项 | 李四 | 1 周 | 高 |
| 巡检脚本每日比对 `ceph config dump` 与基线，发现漂移时建工单 | 王五 | 1 个月 | 中 |
| 按 [容量与性能规划](/learn/capacity-planning) 重新计算水位上限，启动扩容采购 | 张三 | 2 周 | 高 |

这个复盘的价值在于第 4、5 问：如果停在第 2 问，结论就是"扩容"，下次还会因为同样的原因写满。

## 备份与容灾原则

副本和纠删码防的是硬件故障，**防不了人为误删、软件 bug、勒索软件和整个机房出事**。这些要靠备份和容灾。

### 3-2-1 原则

- **3** 份数据：生产数据 + 至少 2 份备份。
- **2** 种不同的介质或系统：不能都在同一个 Ceph 集群里。
- **1** 份在异地：另一个机房或云上。

业界在此基础上还有 3-2-1-1-0 的说法：再加 **1** 份离线或不可变（immutable）的副本防勒索，**0** 个恢复验证错误。

### 快照不是备份

| | 快照 | 备份 |
| --- | --- | --- |
| 存放位置 | 同一个集群、同一个存储池 | 另一套系统，最好在异地 |
| 防硬件故障 | 否，集群坏了快照一起没 | 是 |
| 防误删卷 / 删存储池 | 否，删池时快照一起删 | 是 |
| 防软件 bug / 勒索 | 否 | 是（需要离线或不可变副本） |
| 恢复速度 | 秒级 | 分钟到小时 |
| 适合 | 变更前的保护点、快速回退 | 真正的数据保护 |

快照是非常好的"后悔药"，升级数据库、改配置前打一个，出问题秒级回退。但它和原数据共享命运，不能算作备份。

### 常用手段

| 存储 | 异地复制 / 备份手段 |
| --- | --- |
| Ceph RBD | RBD mirroring（基于快照或 journal 异步复制到另一个集群）、`rbd export-diff` 增量导出 |
| CephFS | cephfs-mirror 快照镜像 |
| Ceph RGW | multisite 多站点复制、对象版本控制 + 对象锁 |
| GPFS | AFM-DR 异步复制、`mmbackup` 对接备份软件 |
| Kubernetes | Velero 等工具备份资源对象和 PV 数据 |

一个最朴素但可靠的 RBD 增量备份方式：

```bash
# 第一次：全量
rbd snap create rbd/vm-001@2026-09-23
rbd export rbd/vm-001@2026-09-23 - | ssh backup.example.com "rbd import - backup/vm-001"
ssh backup.example.com "rbd snap create backup/vm-001@2026-09-23"

# 之后每天：只传两个快照之间的差异
rbd snap create rbd/vm-001@2026-09-24
rbd export-diff --from-snap 2026-09-23 rbd/vm-001@2026-09-24 - \
  | ssh backup.example.com "rbd import-diff - backup/vm-001"
```

每一类数据都要定下 RPO（Recovery Point Objective，最多丢多少数据）和 RTO（Recovery Time Objective，多久恢复），再据此选择手段。

> [!PROD] 没演练过的备份等于没有备份
> 团队每个季度随机抽取几个卷做恢复演练：从备份恢复到隔离环境，校验数据完整性，记录实际耗时，和 RTO 对比。第一次演练时几乎总会发现问题：备份脚本早就静默失败、恢复文档缺步骤、恢复速度比预期慢十倍。

## 持续成长

走到这里，你已经从"一次 write() 的旅程"学到了为 AI 集群设计存储、建立 on-call 体系。存储是一门需要长期积累的手艺，下面是继续往前走的路。

### 推荐读物

- **《Systems Performance》（第 2 版），Brendan Gregg**：本教程性能部分的主要参考。方法论、观测工具、文件系统和磁盘几章值得反复读。
- **《Designing Data-Intensive Applications》，Martin Kleppmann**：从应用视角理解复制、分区、一致性和事务，读完再看 Ceph 和 GPFS 的设计会通透很多。
- **《Site Reliability Engineering》，Google**：在线免费阅读，on-call、事故管理、复盘文化几章是本课的思想来源。
- **Ceph 官方文档**：尤其是 RADOS 运维、故障排查和各版本的发布说明。每次升级前完整读一遍发布说明是好习惯。
- **USENIX FAST 会议论文**：存储领域的顶级会议，每年都有来自工业界的大规模实践。入门推荐几篇经典：《Disk failures in the real world》（FAST '07，硬盘真实故障率）、《Flash Reliability in Production》（FAST '16，SSD 大规模可靠性）、《Redundancy Does Not Imply Fault Tolerance》（FAST '17，分布式存储如何被单个故障击垮）。Ceph 团队关于 BlueStore 由来的论文《File Systems Unfit as Distributed Storage Backends》发表在 SOSP '19，同样值得一读。

### 社区

- Ceph：邮件列表 ceph-users、官方 Slack、Ceph Days 和 Cephalocon 大会，遇到怪问题时先搜 tracker.ceph.com。
- GPFS / Storage Scale：Spectrum Scale User Group 定期举办用户会议，分享大量实践。
- 3FS、JuiceFS 等开源项目：GitHub Issues 和讨论区，读 issue 本身就是很好的学习方式。
- 最好的学习方式是**参与**：给文档提一个修正、复现并报告一个 bug、把你的调优经验写成博客。

### 认证与下一步

- 认证不是必须的，但能帮你系统地过一遍知识点。截至本文写作时，可以关注 Red Hat 的 Ceph 相关认证、SNIA 的存储网络认证，以及和存储强相关的 Kubernetes 认证（CKA）。具体考试名称和内容以官网为准。
- 存储最终要服务于平台。如果你还没有系统学过 Kubernetes，推荐姊妹教程 [K8s Journey](https://k8s-journey.wutz.workers.dev)，从容器基础一路讲到生产集群、GPU 调度和分布式训练，和本教程的 CSI、Rook、AI 存储几课可以互相印证。
- 回到你自己的集群：挑一课的内容，在生产环境里落地一项改进。建立基线、写一份 SOP、做一次恢复演练，都比再读十篇文章更有价值。

## 动手练习

1. 在测试集群上完整演练本课的"替换 OSD 坏盘" SOP：用 `ceph orch daemon stop osd.<id>` 加卸载设备模拟坏盘，照着 SOP 一步步执行，记录每一步的实际输出和耗时，找出 SOP 中至少一处需要修改的地方。
2. 为你负责的系统列出 10 条现有告警，按本课的 P0~P3 定义重新分级，标出哪些"不可操作"应该删除或降级，哪些缺少 SOP 链接。
3. 设置一个 `noout` 标志，观察 `ceph health detail` 中的 `OSDMAP_FLAGS`；然后写一条 Prometheus 告警规则，在任何标志位持续超过 4 小时时通知（提示：可以基于 `ceph_health_detail` 指标中的 `OSDMAP_FLAGS` 检查项）。
4. 回忆一次你经历过的故障（不限于存储），按本课的复盘模板写出时间线和 5 Whys，确保最后一个 "Why" 落在流程或系统层面，而不是某个人。
5. 用 `rbd export-diff` / `import-diff` 在同一集群的两个存储池之间实现一次全量 + 两次增量备份，然后从备份池恢复一个卷并校验数据一致。

## 自测

<details>
<summary>为什么一块已经确认坏掉的 OSD 盘不应该设置 noout？</summary>

`noout` 阻止 down 的 OSD 被标记为 out，而只有标记为 out 后集群才会把它的数据恢复到其他 OSD 上。对短时间不会回来的坏盘设 `noout`，会让集群长时间停留在降级状态，期间再有故障就可能丢数据。`noout` 只适合计划内、很快就能恢复的维护，比如重启主机。

</details>

<details>
<summary>一份合格的 SOP 至少应该包含哪些部分？</summary>

适用场景（以及不适用、需要升级的情况）、影响评估、前置检查（命令 + 期望输出）、编号的操作步骤、每个关键步骤的回滚方案、完成的验证标准，以及收尾和修订记录。它面向的是半夜被叫醒的人，只写"做什么、怎么判断"，不讲原理。

</details>

<details>
<summary>P1 和 P2 的分界线是什么？请用 Ceph 场景举例。</summary>

关键是"再坏一处会不会丢数据或中断服务"。单个 OSD down、其余冗余充足、恢复正常进行，是 P2；同一故障域多个 OSD down、有 PG 只剩最后一份数据，或者某个 OSD 预计几天内写满，再出一个问题就会变成 P0，是 P1。

</details>

<details>
<summary>为什么说快照不是备份？</summary>

快照和原数据存放在同一个集群、同一个存储池里，共享所有的故障：集群损坏、存储池被误删、软件 bug 或勒索软件都会让快照和原数据一起丢失。备份必须存放在另一套独立的系统中，最好异地，并且有离线或不可变的副本。快照适合作为变更前的快速回退点。

</details>

<details>
<summary>复盘的 5 Whys 为什么要一直问到流程或系统层面？</summary>

停在"某人操作失误"或"磁盘坏了"这样的表层原因，改进项只能是"下次小心"或"换盘"，同样的问题会以别的形式再次发生。追问到流程或系统层面（缺少检查项、告警维度不对、没有配置漂移检测），才能得到可以落地、能阻止同类问题的改进项。

</details>

## 参考资料

- [Google SRE Book：Being On-Call](https://sre.google/sre-book/being-on-call/)
- [Google SRE Book：Postmortem Culture](https://sre.google/sre-book/postmortem-culture/)
- [Google SRE Book：Managing Incidents](https://sre.google/sre-book/managing-incidents/)
- [Ceph 文档：cephadm OSD 服务（替换 OSD）](https://docs.ceph.com/en/latest/cephadm/services/osd/)
- [Ceph 文档：添加与移除 OSD](https://docs.ceph.com/en/latest/rados/operations/add-or-rm-osds/)
- [Ceph 文档：健康检查](https://docs.ceph.com/en/latest/rados/operations/health-checks/)
- [Ceph 文档：主机管理与维护模式](https://docs.ceph.com/en/latest/cephadm/host-management/)
- [Ceph 文档：RBD Mirroring](https://docs.ceph.com/en/latest/rbd/rbd-mirroring/)
- [Ceph 文档：Prometheus 模块](https://docs.ceph.com/en/latest/mgr/prometheus/)
- [Brendan Gregg：Systems Performance, 2nd Edition](https://www.brendangregg.com/systems-performance-2nd-edition-book.html)
- [Designing Data-Intensive Applications](https://dataintensive.net/)
- [FAST '16：Flash Reliability in Production: The Expected and the Unexpected](https://www.usenix.org/conference/fast16/technical-sessions/presentation/schroeder)
- [FAST '17：Redundancy Does Not Imply Fault Tolerance](https://www.usenix.org/conference/fast17/technical-sessions/presentation/ganesan)
- [SOSP '19：File Systems Unfit as Distributed Storage Backends](https://dl.acm.org/doi/10.1145/3341301.3359656)
- [K8s Journey：Kubernetes 学习教程](https://k8s-journey.wutz.workers.dev)
