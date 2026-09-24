# 存储监控与告警

存储出事往往不是一瞬间的：一块盘的延迟从 2 ms 慢慢爬到 200 ms，一个池的使用率每周涨 3%，某台交换机的端口偶尔丢包让几个 PG 时不时 peering。等 `ceph -s` 变成 `HEALTH_ERR`、业务开始报 I/O 超时，你面对的已经是一场事故。监控的价值在于**提前看见趋势**，告警的价值在于**只在需要人介入时叫醒人**。

这一课按"监控什么 → 从哪里采 → 怎么存和看 → 怎么告警"的顺序，把 Ceph 存储的监控体系搭一遍：Ceph MGR 的 prometheus 模块和关键指标、node_exporter 与 smartctl_exporter 的磁盘指标、Prometheus / VictoriaMetrics 加 Grafana 的组合，然后写一套能直接用的 PromQL 告警规则，用 `predict_linear` 做容量预测，最后讲告警分级和降噪。

> [!NOTE] 本课需要的环境
> - **一套 Ceph 集群**：[用 cephadm 部署 Ceph 集群](/learn/cephadm-deploy)或 [Rook](/learn/rook-ceph) 部署的都可以，单节点也行。cephadm 默认会顺带部署 Prometheus、Alertmanager、Grafana 和 node-exporter，是最省事的起点。
> - **一套 Prometheus 兼容的时序库**：cephadm 自带的即可；想在 K8s 上练，用 Helm 装 victoria-metrics-k8s-stack 或 kube-prometheus-stack。
> - 能 `curl` 到 MGR 所在节点的 9283 端口。
>
> PromQL 的基本语法（`rate`、`sum by`、向量匹配）本课不展开，不熟的话先过一遍 [Prometheus 查询基础](https://prometheus.io/docs/prometheus/latest/querying/basics/)。性能指标本身的含义见[性能指标：IOPS、吞吐与延迟](/learn/perf-metrics)。

## 监控什么：五类信号

先把问题问对。存储监控不是"把能采的指标都采上"，而是回答五个问题：

| 类别 | 要回答的问题 | 关键信号 | 主要来源 |
| --- | --- | --- | --- |
| 健康 | 集群现在有没有坏？ | `HEALTH_*` 状态、OSD up/in、MON 仲裁、PG 状态、slow ops | Ceph MGR |
| 容量 | 还能撑多久？ | 集群 raw 使用率、每个池的剩余空间、最满的 OSD | Ceph MGR |
| 性能 | 服务端快不快？ | OSD 读写延迟、IOPS、吞吐 | ceph-exporter |
| 恢复 | 坏了之后多久能自愈？ | degraded / misplaced 对象数、恢复速率 | Ceph MGR |
| 客户端延迟 | 用户感受到的快不快？ | RBD 镜像延迟、节点上 `/dev/rbdX` 的 await、应用 P99 | MGR（RBD 统计）、node_exporter |

最后一类最容易被忽略，也最重要。Ceph 服务端延迟正常，不代表客户端就正常：网络丢包、客户端节点 CPU 打满、内核 RBD 队列拥塞，都只能从客户端视角看到。**能告诉你用户受没受影响的，是客户端延迟**，其他四类用来定位原因。

再往下一层，是承载 Ceph 的硬件：磁盘的 SMART 状态、温度、磨损，节点的磁盘利用率和文件系统。这些由 node_exporter 和 smartctl_exporter 提供。

```text
 ┌── Ceph 集群 ─────────────────────────────────────────────┐
 │ ceph-mgr (prometheus 模块)  :9283  健康/容量/PG/池        │
 │ ceph-exporter (每节点)      :9926  各守护进程 perf counter │
 │ node_exporter (每节点)      :9100  磁盘/网络/文件系统       │
 │ smartctl_exporter (每节点)  :9633  SMART、温度、磨损        │
 └───────────────┬──────────────────────────────────────────┘
                 │ scrape（或 telegraf 抓取后 remote write）
                 ▼
     Prometheus / VictoriaMetrics ──▶ Grafana（看板）
                 │
                 └──▶ 告警规则 ──▶ Alertmanager ──▶ IM / 电话 / 工单
```

## Ceph 的指标：MGR prometheus 模块

Ceph 的集群级指标由 MGR 的 prometheus 模块暴露。cephadm 部署的集群默认已经启用：

```bash
ceph mgr module enable prometheus        # 已启用时无副作用
ceph mgr services                        # 看到 "prometheus": "http://192.168.10.11:9283/"
curl -s http://192.168.10.11:9283/metrics | grep -E '^ceph_health_status|^ceph_osd_up'
```

几个容易踩的点：

- **只有 active MGR 返回数据**。standby MGR 默认把请求重定向到 active，但抓取端最好把所有 MGR 节点都配上，主备切换时不会断数据。
- **每个守护进程的性能计数器（perf counter）从 Reef 起改由 ceph-exporter 提供**，它在每个节点上跑一个，端口 9926。cephadm 用 `ceph orch apply ceph-exporter` 部署。如果发现 `ceph_osd_op_*`、`ceph_mds_*` 这类指标缺失，先确认 ceph-exporter 在跑；老部署方式下可以让 MGR 继续导出：`ceph config set mgr mgr/prometheus/exclude_perf_counters false`。
- **RBD 镜像级统计默认关闭**，要为指定池打开：`ceph config set mgr mgr/prometheus/rbd_stats_pools "kubernetes"`。之后会出现带 `image` 标签的 `ceph_rbd_*` 指标。镜像很多时标签基数会暴涨，只对关键池打开。

### 关键指标

| 指标 | 含义 | 用法 |
| --- | --- | --- |
| `ceph_health_status` | 0=OK、1=WARN、2=ERR | 最粗的健康信号 |
| `ceph_health_detail` | 每个健康检查项一条，`name` 标签如 `OSD_DOWN` | 知道 WARN 具体是什么 |
| `ceph_osd_up` / `ceph_osd_in` | 每个 OSD 是否 up、是否 in（0/1） | OSD 故障 |
| `ceph_mon_quorum_status` | 每个 MON 是否在仲裁中 | MON 故障 |
| `ceph_pg_total` / `ceph_pg_active` / `ceph_pg_clean` | 每个池的 PG 总数及各状态数量 | 数据是否可用 |
| `ceph_pg_degraded` / `ceph_pg_undersized` / `ceph_pg_inconsistent` | 副本不足、scrub 发现不一致 | 冗余与数据正确性 |
| `ceph_num_objects_degraded` / `_misplaced` / `_unfound` | 对象级的恢复进度 | 恢复还要多久 |
| `ceph_cluster_total_bytes` / `_total_used_raw_bytes` | 集群 raw 容量与已用 | 总体容量 |
| `ceph_pool_stored` / `ceph_pool_max_avail` / `ceph_pool_percent_used` | 池的用户数据量、还能写多少、使用率 | 按池看容量 |
| `ceph_osd_stat_bytes` / `ceph_osd_stat_bytes_used` | 每个 OSD 的容量与已用 | 找最满的 OSD |
| `ceph_osd_op_r_latency_sum` / `_count` | OSD 读延迟累计（秒）与次数 | 服务端读延迟 |
| `ceph_osd_op_w_latency_sum` / `_count` | 同上，写 | 服务端写延迟 |
| `ceph_osd_apply_latency_ms` / `ceph_osd_commit_latency_ms` | OSD 自己统计的落盘延迟 | 找慢盘 |
| `ceph_healthcheck_slow_ops` | 当前 slow ops 数量 | 请求卡住 |
| `ceph_osd_flag_noout` 等 | 集群级标志位 | 发现"维护完忘了取消 noout" |

池指标只带 `pool_id` 标签，要显示池名得和 `ceph_pool_metadata` 做一次关联；OSD 延迟指标带 `ceph_daemon="osd.3"` 标签。几条常用的 PromQL：

```text
# 每个池的使用率（带池名）
ceph_pool_percent_used * on(pool_id) group_left(name) ceph_pool_metadata

# 最满的 5 个 OSD
topk(5, ceph_osd_stat_bytes_used / ceph_osd_stat_bytes)

# 每个 OSD 最近 5 分钟的平均读延迟（秒）
rate(ceph_osd_op_r_latency_sum[5m]) / rate(ceph_osd_op_r_latency_count[5m])

# 集群读 IOPS（写换成 ceph_osd_op_w）
sum(rate(ceph_osd_op_r[5m]))

# 不是 active 的 PG 数（> 0 意味着有数据不可访问）
sum(ceph_pg_total) - sum(ceph_pg_active)
```

> [!WARNING] max_avail 看的是最满的那块盘
> `ceph_pool_max_avail` 不是"总剩余 / 副本数"那么简单，它按 CRUSH 规则里**最先写满的 OSD** 推算。数据分布不均时，集群整体才用了 60%，某个池的 max_avail 可能已经所剩无几。容量告警要同时看池的 max_avail 和最满 OSD 的使用率，发现不均就用 `ceph osd df` 和 balancer 处理。Ceph 默认的阈值是 nearfull 0.85、backfillfull 0.90、full 0.95，OSD 一旦到 full，整个池拒绝写入。

### 对象存储的桶级指标

RGW 的桶级容量和请求统计在老版本里拿不到。团队在 Ceph 18 集群上用 [extended-ceph-exporter](https://github.com/galexrt/extended-ceph-exporter) 补齐（端口 9138），它用一个只读的 RGW 用户查询桶和用户信息：

```bash
radosgw-admin user create --uid extended-ceph-exporter --display-name "monitoring" \
  --caps "buckets=read;users=read;usage=read;metadata=read;zone=read"
```

部署后能看到 `ceph_rgw_bucket_size` 这类指标。Ceph 19 起 RGW 自己提供了更细的带标签计数器，新集群优先用原生指标，少维护一个组件。

## 磁盘与节点：node_exporter 和 smartctl_exporter

Ceph 的 OSD 延迟高，下一步就是看底下那块盘。node_exporter 的磁盘指标来自 `/proc/diskstats`，含义和 `iostat` 一一对应（详见[磁盘 I/O 观测：iostat 到 blktrace](/learn/disk-observability)）：

```text
# 利用率（等价 iostat 的 %util；对 NVMe 这类并行设备，100% 不代表饱和）
rate(node_disk_io_time_seconds_total{device=~"nvme.*|sd.*"}[5m])

# 读平均延迟 r_await（秒）
rate(node_disk_read_time_seconds_total[5m]) / rate(node_disk_reads_completed_total[5m])

# 平均队列深度（等价 aqu-sz）
rate(node_disk_io_time_weighted_seconds_total[5m])

# 文件系统剩余空间与 inode（MON 的数据盘、日志盘满了同样会出事）
node_filesystem_avail_bytes{mountpoint="/var/lib/ceph"} / node_filesystem_size_bytes{mountpoint="/var/lib/ceph"}
node_filesystem_files_free
```

客户端节点上同样有 node_exporter，`device=~"rbd.*"` 就是 K8s Pod 挂的 RBD 卷，它的 await 就是"用户感受到的延迟"。

磁盘健康靠 [smartctl_exporter](https://github.com/prometheus-community/smartctl_exporter)。它调用 `smartctl` 读取 SMART 数据，需要 root 权限访问设备，默认端口 9633：

| 指标 | 含义 |
| --- | --- |
| `smartctl_device_smart_status` | SMART 整体自检结果，1 为通过，0 意味着盘自己都认为要坏了 |
| `smartctl_device_temperature` | 温度，带 `temperature_type` 标签 |
| `smartctl_device_percentage_used` | NVMe 标称寿命已消耗的百分比 |
| `smartctl_device_media_errors` | NVMe 介质错误计数，增长就该准备换盘 |
| `smartctl_device_critical_warning` | NVMe 关键告警位，非 0 必须处理 |
| `smartctl_device_attribute` | SATA/SAS 的 SMART 属性，如 `Reallocated_Sector_Ct` |

Ceph 自己也会收集 SMART：`ceph device ls` 列出每块盘和它承载的 OSD，`ceph device get-health-metrics <devid>` 看历史数据，MGR 的 devicehealth 模块还能在预测到故障时主动把 OSD 标记为 out。两者可以并存，smartctl_exporter 的优势是能进统一的告警体系，还能覆盖系统盘。

## 存储与展示：Prometheus / VictoriaMetrics + Grafana

**抓取配置**。独立的 Prometheus 抓 Ceph 时，一个最小的配置如下。`honor_labels: true` 让 Ceph 导出的 `instance` 等标签不被抓取端覆盖，Ceph 官方文档也这样建议：

```yaml title="prometheus.yml（节选）"
scrape_configs:
  - job_name: ceph
    honor_labels: true
    static_configs:
      - targets: ["192.168.10.11:9283", "192.168.10.12:9283", "192.168.10.13:9283"]
  - job_name: ceph-exporter
    honor_labels: true
    static_configs:
      - targets: ["192.168.10.11:9926", "192.168.10.12:9926", "192.168.10.13:9926"]
  - job_name: node
    static_configs:
      - targets: ["192.168.10.11:9100", "192.168.10.12:9100", "192.168.10.13:9100"]
  - job_name: smartctl
    scrape_interval: 60s          # SMART 数据变化慢，没必要频繁读盘
    static_configs:
      - targets: ["192.168.10.11:9633", "192.168.10.12:9633", "192.168.10.13:9633"]
```

cephadm 自带的 Prometheus（默认端口 9095）会自动生成这些目标，适合单集群。团队有多套 Ceph，统一汇总到中心的时序库，做法是在每套集群旁边跑一个 telegraf 抓 MGR，再用 remote write 推出去：

```toml title="telegraf.conf（节选）"
[agent]
  interval = "15s"
  flush_interval = "30s"

[[inputs.prometheus]]
  urls = ["http://192.168.10.11:9283/metrics", "http://192.168.10.12:9283/metrics"]

[[outputs.http]]
  url = "https://metrics.example.com/api/v1/write"
  data_format = "prometheusremotewrite"
  [outputs.http.headers]
    Content-Type = "application/x-protobuf"
    Content-Encoding = "snappy"
    X-Prometheus-Remote-Write-Version = "0.1.0"
```

**K8s 里的方案**。Rook 在 CephCluster 设了 `monitoring.enabled: true` 后会创建 ServiceMonitor。团队在 K8s 上用的是 victoria-metrics-k8s-stack（截至本文写作时 chart 为 0.70.x），它自带的 operator 能把 ServiceMonitor、PrometheusRule 自动转换成 VictoriaMetrics 的对象，所以社区现成的规则和 Rook 生成的对象都能直接用：

```yaml title="vm-values.yaml（节选）"
vmsingle:
  spec:
    retentionPeriod: "30d"
    storage:
      resources: { requests: { storage: 1Ti } }
victoria-metrics-operator:
  operator:
    disable_prometheus_converter: false   # 转换 ServiceMonitor / PrometheusRule
```

选 Prometheus 还是 VictoriaMetrics？单集群、保留期几周，Prometheus 足够；要把多套集群汇总、保留几个月做容量规划，VictoriaMetrics 的压缩率和查询长时间范围的性能更好，而且兼容 PromQL 和 remote write，换过去成本很低。

**Grafana 看板**。别从零画，先导入现成的，再按需要改：

- Ceph 官方的 [ceph-mixin](https://github.com/ceph/ceph/tree/main/monitoring/ceph-mixin) 提供集群、OSD、池、RBD、RGW、CephFS 全套看板和告警规则，cephadm 自带的 Grafana 装的就是它。
- Grafana.com 上的 Ceph Cluster（ID 2842）、Ceph OSD（5336）、Ceph Pools（5342）也是 Rook 文档推荐的，导入即用。
- 节点和磁盘用 Node Exporter Full（ID 1860）。

看板要分层：第一屏只放值班时要看的东西，健康状态、容量与剩余天数、集群 IOPS / 吞吐 / 延迟、OSD up 数、非 active+clean 的 PG 数；从这里点进去才是单个 OSD、单个池、单块盘的详情。一屏塞 60 个面板的看板，出事时没人看得懂。

## 告警规则

下面是一套可以直接落地的起步规则，用 PrometheusRule 格式写（Prometheus Operator 和 VictoriaMetrics operator 都认）。阈值是团队用 NVMe 集群得出的经验值，机械盘集群的延迟阈值要放宽。

```yaml title="ceph-alerts.yaml"
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: ceph-alerts
  namespace: monitoring
spec:
  groups:
    - name: ceph-health
      rules:
        - alert: CephHealthError
          expr: ceph_health_status == 2
          for: 5m
          labels: { severity: critical }
          annotations:
            summary: "Ceph 集群 HEALTH_ERR"
            description: "执行 ceph health detail 查看原因"
            runbook_url: "https://wiki.example.com/runbooks/ceph-health-error"
        - alert: CephHealthWarning
          expr: ceph_health_status == 1
          for: 15m
          labels: { severity: warning }
          annotations:
            summary: "Ceph 集群 HEALTH_WARN 超过 15 分钟"
        - alert: CephPGsInactive
          expr: sum(ceph_pg_total) - sum(ceph_pg_active) > 0
          for: 5m
          labels: { severity: critical }
          annotations:
            summary: "{{ $value }} 个 PG 不是 active，部分数据无法读写"
        - alert: CephPGInconsistent
          expr: sum(ceph_pg_inconsistent) > 0
          for: 5m
          labels: { severity: warning }
          annotations:
            summary: "scrub 发现 {{ $value }} 个不一致的 PG"
        - alert: CephMonOutOfQuorum
          expr: count(ceph_mon_quorum_status == 1) < count(ceph_mon_quorum_status)
          for: 5m
          labels: { severity: warning }
          annotations:
            summary: "有 MON 不在仲裁中，再坏一个可能失去多数派"
        - alert: CephOSDDown
          expr: count(ceph_osd_up == 0) > 0
          for: 5m
          labels: { severity: warning }
          annotations:
            summary: "{{ $value }} 个 OSD down"
        - alert: CephSlowOps
          expr: ceph_healthcheck_slow_ops > 0
          for: 2m
          labels: { severity: warning }
          annotations:
            summary: "存在 {{ $value }} 个 slow ops，客户端 I/O 可能卡住"
        - alert: CephNooutLeftOn
          expr: ceph_osd_flag_noout == 1
          for: 2h
          labels: { severity: warning }
          annotations:
            summary: "noout 已设置超过 2 小时，维护结束后是否忘了取消？"

    - name: ceph-capacity
      rules:
        - alert: CephOSDNearFull
          # 早于 Ceph 的 nearfull(0.85) 告警，留出处理时间
          expr: ceph_osd_stat_bytes_used / ceph_osd_stat_bytes > 0.80
          for: 10m
          labels: { severity: warning }
          annotations:
            summary: "{{ $labels.ceph_daemon }} 使用率超过 80%"
        - alert: CephPoolWillFillIn30d
          expr: |
            predict_linear(ceph_pool_stored[7d], 30 * 86400)
              > ceph_pool_stored + ceph_pool_max_avail
          for: 1h
          labels: { severity: warning }
          annotations:
            summary: "池 {{ $labels.pool_id }} 按近 7 天的增速，30 天内写满"

    - name: ceph-performance
      rules:
        - alert: CephOSDHighReadLatency
          expr: |
            rate(ceph_osd_op_r_latency_sum[5m]) / rate(ceph_osd_op_r_latency_count[5m]) > 0.05
          for: 10m
          labels: { severity: warning }
          annotations:
            summary: "{{ $labels.ceph_daemon }} 平均读延迟超过 50ms，检查对应磁盘"

    - name: disk-hardware
      rules:
        - alert: DiskSmartFailed
          expr: smartctl_device_smart_status == 0
          labels: { severity: critical }
          annotations:
            summary: "{{ $labels.instance }} {{ $labels.device }} SMART 自检失败，准备换盘"
        - alert: NVMeMediaErrorsIncreasing
          expr: increase(smartctl_device_media_errors[1h]) > 0
          labels: { severity: warning }
          annotations:
            summary: "{{ $labels.device }} 最近 1 小时出现新的介质错误"
        - alert: NVMeWearHigh
          expr: smartctl_device_percentage_used > 90
          labels: { severity: warning }
          annotations:
            summary: "{{ $labels.device }} 寿命已消耗 {{ $value }}%"
```

写规则时有几条原则：

- **`for` 是最便宜的降噪手段**。OSD 重启一次需要几十秒，没有 `for: 5m` 的话每次滚动升级都会刷一屏告警。
- **单个 OSD down 只是 warning**。Ceph 设计上就能容忍它，恢复会自动进行；真正要叫醒人的是"数据不可访问"（PG inactive）和"即将不可写"（full）。
- 每条 critical 告警都带 `runbook_url`，写清楚第一步做什么。值班的人半夜被叫醒时，不该从零开始想。
- 需要区分池名时，把池规则的 `expr` 乘上 `on(pool_id) group_left(name) ceph_pool_metadata`，告警里就能用 `{{ $labels.name }}`。

## 容量预测：predict_linear

`predict_linear(v[range], t)` 对区间内的样本做线性回归，返回 t 秒之后的预测值。它最适合回答"按现在的速度，还有多少天写满"：

```text
# 集群 raw 使用量 30 天后是否超过 85%（nearfull 线）
predict_linear(ceph_cluster_total_used_raw_bytes[7d], 30 * 86400)
  > ceph_cluster_total_bytes * 0.85

# 每个池还有多少天写满（结果单位：天），适合放进看板
ceph_pool_max_avail / clamp_min(deriv(ceph_pool_stored[7d]), 1) / 86400
```

用它的几个经验：

- **区间要够长**。`[1h]` 的预测会被一次大批量导入带偏，今天告警"3 天写满"，明天数据删了又恢复。容量类的趋势至少用 `[7d]`，并加上 `for: 1h`。
- **长区间查询很贵**。7 天的原始样本每次评估都要读一遍，集群多了会拖慢时序库。可以先用记录规则（recording rule）把 `ceph_pool_stored` 降采样成每 5 分钟一个点，再对记录结果做预测。
- **线性模型只是线性**。业务有季节性（每月底集中写入）或者刚上了新业务，预测会偏。它的作用是提醒你"该看一眼了"，真正的扩容决策要结合业务计划，见[容量与性能规划](/learn/capacity-planning)。
- 预测的是**池级或集群级**，别忘了单个 OSD 会先满。分布不均时，最满 OSD 的告警往往比池级预测更早响。

## 告警分级与降噪

告警系统最常见的死法不是漏报，而是太吵：一天几百条，值班的人开始习惯性忽略，真正的事故混在里面没人看见。团队的分级：

| 级别 | 含义 | 通知方式 | 例子 |
| --- | --- | --- | --- |
| P1 / critical | 用户已经或马上受影响，需要立即处理 | 电话 + IM，7×24 | PG inactive、HEALTH_ERR、池或 OSD full、MON 失去仲裁、SMART 失败 |
| P2 / warning | 冗余下降或趋势恶化，工作时间内处理 | IM 群 + 工单 | 单个 OSD down、nearfull、30 天内写满、慢盘、noout 忘关 |
| P3 / info | 值得知道，不需要动作 | 只进看板或日报 | scrub 延迟、个别客户端重连 |

判断一条告警该是哪一级，就问一句：**收到之后，值班的人需要现在做什么？** 答不上来的，要么降级，要么删掉。

降噪靠 Alertmanager 的三个机制：

```yaml title="alertmanager.yml（节选）"
route:
  receiver: im-storage
  group_by: [alertname, cluster]   # 同一类告警合并成一条通知
  group_wait: 30s
  group_interval: 5m
  repeat_interval: 4h              # 没恢复的告警 4 小时提醒一次，而不是每 5 分钟
  routes:
    - matchers: [severity="critical"]
      receiver: phone-oncall
      repeat_interval: 1h

inhibit_rules:
  # 整台节点挂了，就不要再为上面的每个 OSD 单独告警
  - source_matchers: [alertname="NodeDown"]
    target_matchers: [alertname=~"CephOSDDown|DiskSmartFailed"]
    equal: [instance]
  # 已经 HEALTH_ERR 了，WARN 就不用再发
  - source_matchers: [alertname="CephHealthError"]
    target_matchers: [alertname="CephHealthWarning"]
    equal: [cluster]
```

- **分组（group_by）**：一台存储节点宕机，12 个 OSD down、上百个 PG degraded，合并成一条通知。
- **抑制（inhibit_rules）**：有了根因告警，就抑制它引起的症状告警。`equal` 列出的标签必须两边相同才生效，所以抓取时要保证 `instance`、`cluster` 这类标签在各数据源之间一致。
- **静默（silence）**：计划内维护前用 `amtool silence add` 或 Alertmanager 页面加静默，写上维护人和结束时间。Ceph 侧也可以临时静音某个健康检查：`ceph health mute OSD_DOWN 2h`，到期自动解除。

> [!PROD] 定期给告警做体检
> 每个月拉一次告警统计：触发最多的前 10 条是什么？有没有触发了但没人处理、也没造成影响的？这些要么调阈值，要么降级，要么删掉。反过来，每次事故复盘都问一句"监控有没有提前看到"，没看到就补一条规则。值班与复盘的方法见 [On-call、SOP 与故障复盘](/learn/oncall-sre)。

## 动手练习

1. 在你的 Ceph 集群上 `curl` MGR 的 9283 端口，找出 `ceph_health_status`、`ceph_osd_up` 和 `ceph_pool_max_avail`，对照 `ceph -s`、`ceph df` 的输出确认数值一致。再 `curl` 一次 standby MGR，看它返回什么。
2. 在 Grafana 里导入 Node Exporter Full（1860）和一个 Ceph 集群看板，用 fio 对一个 RBD 卷做随机读压测，同时观察 OSD 读延迟和 OSD 所在磁盘的 r_await，比较两者的差距。
3. 把本课的告警规则加载到你的 Prometheus 或 VictoriaMetrics，然后 `ceph orch daemon stop osd.0`（Rook 下把对应 Deployment 缩到 0），记录从停掉到收到 `CephOSDDown` 通知一共多久，解释时间花在了哪里。
4. 在一个测试池里持续写入数据一小时，用 `predict_linear` 分别以 `[10m]` 和 `[1h]` 作为区间预测写满时间，停止写入后观察两条曲线的变化。
5. 为"节点宕机抑制 OSD down"写一条 inhibit_rule，模拟停掉一整台节点，确认只收到一条节点告警。

## 自测

<details>
<summary>Ceph 集群 HEALTH_OK，OSD 延迟也正常，但业务反馈数据库很慢，还应该看哪些指标？</summary>

看客户端视角的指标：业务所在节点上 `/dev/rbdX` 的 await 和队列深度（node_exporter）、打开了 `rbd_stats_pools` 后的 RBD 镜像级延迟、客户端节点的 CPU 和网卡丢包重传。服务端正常而客户端慢，问题通常在网络或客户端节点本身。

</details>

<details>
<summary>集群整体使用率只有 60%，为什么某个池的 max_avail 已经很小，甚至触发了 nearfull？</summary>

`max_avail` 按 CRUSH 规则里最先写满的 OSD 推算，nearfull 也是针对单个 OSD 的。数据分布不均时，个别 OSD 已接近 85%，即使整体只用了 60%。应该用 `ceph osd df` 查看分布，启用或调整 balancer。

</details>

<details>
<summary>为什么单个 OSD down 通常设为 warning 而不是 critical？什么情况下 OSD down 要升级成 critical？</summary>

Ceph 的副本或 EC 设计本身就能容忍单个 OSD 故障，数据仍然可读写并会自动恢复，不需要半夜叫醒人。当 down 的 OSD 多到导致 PG inactive（数据不可访问），或者恢复期间冗余已经降到再坏一块就丢数据时，才需要立即处理，这时应由 `CephPGsInactive` 这类告警以 critical 发出。

</details>

<details>
<summary>用 `predict_linear(ceph_pool_stored[1h], 30*86400)` 做容量告警有什么问题？</summary>

区间太短，一次批量导入或删除就会让预测大幅波动，产生大量误报或漏报。容量趋势应至少用 7 天区间并配合 `for`，长区间查询开销大时先用记录规则降采样。线性预测也无法反映业务的季节性，只能作为"该看一眼"的提醒。

</details>

## 参考资料

- [Ceph 文档：Prometheus 模块](https://docs.ceph.com/en/latest/mgr/prometheus/)
- [Ceph 文档：cephadm 监控栈](https://docs.ceph.com/en/latest/cephadm/services/monitoring/)
- [ceph-mixin：官方看板与告警规则](https://github.com/ceph/ceph/tree/main/monitoring/ceph-mixin)
- [Rook 文档：Prometheus 监控](https://rook.io/docs/rook/latest-release/Storage-Configuration/Monitoring/ceph-monitoring/)
- [node_exporter](https://github.com/prometheus/node_exporter)
- [smartctl_exporter](https://github.com/prometheus-community/smartctl_exporter)
- [extended-ceph-exporter](https://github.com/galexrt/extended-ceph-exporter)
- [Prometheus 文档：查询函数（predict_linear、deriv）](https://prometheus.io/docs/prometheus/latest/querying/functions/)
- [Alertmanager 配置文档](https://prometheus.io/docs/alerting/latest/configuration/)
- [VictoriaMetrics：victoria-metrics-k8s-stack](https://docs.victoriametrics.com/helm/victoria-metrics-k8s-stack/)
- [Grafana 看板：Node Exporter Full](https://grafana.com/grafana/dashboards/1860)
- [Google SRE Book：Monitoring Distributed Systems](https://sre.google/sre-book/monitoring-distributed-systems/)
