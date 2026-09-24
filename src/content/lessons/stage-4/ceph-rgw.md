# RGW 对象网关

RGW（RADOS Gateway）是 Ceph 的对象存储入口。它是一个无状态的 HTTP 服务，对外说 S3 协议（也兼容 Swift），对内把桶和对象翻译成 RADOS 对象与 omap。因为无状态，扩容很简单，多起几个实例、前面挂负载均衡就行。真正需要花心思的是另外几件事：池怎么规划、用户和配额怎么管、流量入口怎么做高可用、出了 5xx 从哪里查起。

本课在上一课的集群上部署一套生产形态的 RGW：多实例、VIP 入口、按租户配额，并接入监控。S3 协议本身（签名、Multipart、一致性）已经在 [对象存储与 S3 协议](/learn/object-storage) 讲过，这里只讲 Ceph 的部分。

> [!NOTE] 本课需要的环境
> - 按 [用 cephadm 部署 Ceph 集群](/learn/cephadm-deploy) 搭好的 3 节点集群，3 台主机都打上 `rgw` 标签：`ceph orch host label add ceph1 rgw`，另外两台同理。
> - 公共网 `192.168.10.0/24` 里预留**一个空闲 IP** 做 VIP（本文用 `192.168.10.100`），它必须不在 DHCP 范围内，也没被其他机器占用。
> - 客户端 `client1`（`192.168.10.21`）装好 `awscli`（v2）。可选装 `s5cmd`。
> - 可选：在内部 DNS 或客户端的 `/etc/hosts` 里把 `s3.example.com` 解析到 `192.168.10.100`。

## 架构：一个请求走过哪些组件

```text
  S3 客户端（aws cli / SDK / s5cmd）
        │  http://s3.example.com  →  VIP 192.168.10.100:80
        ▼
  keepalived（VRRP 管 VIP 漂移） + haproxy（ingress，每台一份）
        │  轮询 / 健康检查
        ▼
  radosgw（beast 前端）× N，端口 8000
        │  librados
        ▼
  .rgw.root              ← realm / zonegroup / zone 配置
  <zone>.rgw.meta        ← 用户、桶元数据
  <zone>.rgw.log / control
  <zone>.rgw.buckets.index   ← 桶索引（omap，放 SSD）
  <zone>.rgw.buckets.data    ← 对象数据（可以是 EC）
  <zone>.rgw.buckets.non-ec  ← Multipart 等不能放 EC 的数据
```

其中最敏感的是**桶索引池**。每个对象都在索引里有一条 omap 记录，每次 PUT/DELETE/LIST 都要访问它。索引放在机械盘上，对象数一多，LIST 和写入都会变慢。

## realm、zonegroup、zone

RGW 用三层结构描述"数据在哪、怎么同步"：

| 概念 | 类比 | 说明 |
| --- | --- | --- |
| realm（领域） | 一个独立的对象存储命名空间 | 用户和桶名在 realm 内全局唯一 |
| zonegroup（区域组） | 一个"地区" | 包含一个或多个 zone，其中一个是 master zonegroup |
| zone（区域） | 一个 Ceph 集群里的一套 RGW 池 | 同一 zonegroup 里的多个 zone 之间异步复制数据 |
| period（周期） | 配置的版本号 | 改了拓扑都要 `period update --commit` 才生效 |

单集群不建 realm 也能跑，RGW 会使用一个叫 `default` 的 zone。我的建议是**一开始就显式建好 realm 和 zone**。以后想做多站点（multisite）复制时，只需要加一个 zone；如果从 `default` 迁移过来，要改名、改池，麻烦得多。

```bash
radosgw-admin realm create --rgw-realm=example --default
radosgw-admin zonegroup create --rgw-zonegroup=cn --master --default
radosgw-admin zone create --rgw-zonegroup=cn --rgw-zone=cn-east-1 --master --default
radosgw-admin period update --commit
```

### 提前建好数据池和索引池

RGW 第一次启动时会自动创建它需要的池，但用的是默认 CRUSH 规则和很少的 PG。数据量最大的几个池要自己提前建：

```bash
# 索引池：副本 + SSD
ceph osd pool create cn-east-1.rgw.buckets.index 32 32 replicated rep_ssd
# 数据池：纠删码 + HDD，标记 bulk 让 autoscaler 一开始就给足 PG
ceph osd pool create cn-east-1.rgw.buckets.data 128 128 erasure ec42_hdd
ceph osd pool set cn-east-1.rgw.buckets.data bulk true
# Multipart 的元数据需要 omap，不能放 EC
ceph osd pool create cn-east-1.rgw.buckets.non-ec 16 16 replicated rep_ssd
for p in index data non-ec; do ceph osd pool application enable cn-east-1.rgw.buckets.$p rgw; done
```

3 节点的实验环境跑不了 `ec42`（故障域为 host 时至少需要 6 台主机），数据池先用 `replicated rep_hdd` 代替。RGW 启动后，再把它自动创建的 `.rgw.root`、`cn-east-1.rgw.log`、`.control`、`.meta` 也切到 `rep_ssd`：

```bash
for p in .rgw.root cn-east-1.rgw.log cn-east-1.rgw.control cn-east-1.rgw.meta; do
  ceph osd pool set $p crush_rule rep_ssd
done
```

## 部署 RGW 服务

```yaml title="rgw.yaml"
service_type: rgw
service_id: s3
placement:
  label: rgw
  count_per_host: 2          # 每台主机 2 个实例，充分利用 CPU
networks:
  - 192.168.10.0/24          # 只监听公共网
spec:
  rgw_realm: example
  rgw_zone: cn-east-1
  rgw_frontend_port: 8000    # 同一台主机上的第二个实例自动用 8001
```

```bash
ceph orch apply -i rgw.yaml
ceph orch ps --daemon_type rgw
```

```text
NAME                     HOST   PORTS   STATUS         REFRESHED  AGE  MEM USE  VERSION
rgw.s3.ceph1.wqkxzs      ceph1  *:8000  running (2m)   30s ago    2m   98.1M    20.2.4
rgw.s3.ceph1.pmdvba      ceph1  *:8001  running (2m)   30s ago    2m   95.4M    20.2.4
rgw.s3.ceph2.ftgnhe      ceph2  *:8000  running (2m)   31s ago    2m   97.7M    20.2.4
...
```

匿名访问一下，返回一个空的桶列表就说明服务正常：

```console
$ curl -s http://192.168.10.11:8000
<?xml version="1.0" encoding="UTF-8"?><ListAllMyBucketsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Owner><ID>anonymous</ID></Owner><Buckets></Buckets></ListAllMyBucketsResult>
```

命令行也有简化写法：`ceph orch apply rgw s3 --realm=example --zone=cn-east-1 --placement="label:rgw count-per-host:2" --port=8000`。不过写成 YAML 才能进 Git。

> [!TIP] 想要虚拟主机风格的 URL
> 默认用路径风格（path-style）访问，即 `http://s3.example.com/bucket/key`。要支持 `http://bucket.s3.example.com/key` 这种虚拟主机风格（virtual-hosted style），设置 `ceph config set client.rgw rgw_dns_name s3.example.com`，再配一条泛域名解析 `*.s3.example.com`，然后 `ceph orch restart rgw.s3`。

## 高可用入口：ingress 服务

多个 RGW 实例需要一个统一入口。cephadm 的 **ingress** 服务在每台主机上部署一对 haproxy 和 keepalived：keepalived 用 VRRP 协议选出一台持有 VIP，haproxy 把请求分发给所有 RGW 实例，并做健康检查。

```yaml title="ingress.yaml"
service_type: ingress
service_id: rgw.s3
placement:
  label: rgw
spec:
  backend_service: rgw.s3
  virtual_ip: 192.168.10.100/24
  frontend_port: 80
  monitor_port: 1967               # haproxy 状态页端口
  first_virtual_router_id: 150     # 同一个二层网络里有别的 keepalived 时避免 VRID 冲突
```

```bash
ceph orch apply -i ingress.yaml
ceph orch ls ingress
ip addr show | grep 192.168.10.100     # 在持有 VIP 的主机上能看到
curl -s http://192.168.10.100 | head -c 80
```

几个值得知道的细节：

- **多个 VIP**：用 `virtual_ips_list` 代替 `virtual_ip`，配置多个 VIP，再在 DNS 里轮询这些地址。keepalived 会把 VIP 分散到不同主机上，避免所有流量都挤在一台 haproxy 上。每多一个 VIP，就多占用一个 VRID（从 `first_virtual_router_id` 开始递增）。
- **VRID 冲突**：同一个二层网络里，别人的 keepalived（比如 Kubernetes 的 API VIP）用了相同的 VRID，两边会互相抢 VIP，现象是 VIP 时通时断。所以要主动设置 `first_virtual_router_id`，避开默认值 50。
- **HTTPS**：可以在 ingress 上终结 TLS（`ssl: true` 加上证书），也可以让 RGW 自己终结（rgw spec 里的 `ssl` 和 `rgw_frontend_ssl_certificate`）。证书相关字段在不同版本间变化较大，以你所用版本的 [ingress 文档](https://docs.ceph.com/en/latest/cephadm/services/rgw/#high-availability-service-for-rgw) 为准。换证书后执行 `ceph orch redeploy ingress.rgw.s3`。

> [!PROD] 入口带宽要算清楚
> 所有流量都要穿过持有 VIP 的那台 haproxy，它的网卡就是整个对象存储的带宽上限。大带宽场景要么配多个 VIP 做 DNS 轮询，要么在前面用硬件负载均衡或 BGP ECMP，把 cephadm ingress 只当成内网入口。

## 多站点：一个 zone 不够用的时候

多站点（multisite）是在另一个 Ceph 集群里建第二个 zone，加入同一个 zonegroup。两个 zone 之间**异步**复制桶和对象，用于异地容灾或就近读取。过程大致如下，这里只列出步骤，完整流程见 [Multi-Site 文档](https://docs.ceph.com/en/latest/radosgw/multisite/)：

1. 在主集群创建一个系统用户（`radosgw-admin user create --uid=sync-user --system`），并把 master zone 的 `--endpoints` 设为主集群 RGW 的地址。
2. 在从集群用该用户的密钥拉取 realm：`radosgw-admin realm pull --url=http://s3.example.com --access-key=<AK> --secret=<SK>`。
3. 在从集群创建 secondary zone：`radosgw-admin zone create --rgw-zonegroup=cn --rgw-zone=cn-north-1 --endpoints=... --access-key=<AK> --secret=<SK>`，然后 `period update --commit`，部署 RGW。
4. 用 `radosgw-admin sync status` 看同步进度。

需要记住的限制：用户和桶的元数据变更只能在 master zone 上做（写到 secondary 会被转发）；复制是异步的，主站故障时可能丢失最后一段时间的写入。它不是强一致的双活方案。

## 用户、配额与限流

### 创建用户

```console
# radosgw-admin user create --uid=team-a --display-name="Team A"
{
    "user_id": "team-a",
    "display_name": "Team A",
    "max_buckets": 1000,
    "keys": [
        {
            "user": "team-a",
            "access_key": "<ACCESS_KEY>",
            "secret_key": "<SECRET_KEY>"
        }
    ],
    "suspended": 0,
    "bucket_quota": { "enabled": false, "max_size": -1, "max_objects": -1 },
    "user_quota": { "enabled": false, "max_size": -1, "max_objects": -1 },
    ...
}
```

密钥只显示在这里（之后也能用 `radosgw-admin user info --uid=team-a` 查到）。交给业务方时要走密钥管理系统，别直接贴进聊天工具。常用的用户操作还有：`user suspend`/`enable` 临时停用，`key create --gen-access-key --gen-secret` 轮换密钥，`user rm --purge-data` 连同数据删除（危险）。

### 配额

配额分用户级和桶级，**设置之后还要 enable**，不 enable 不生效：

```bash
radosgw-admin quota set --quota-scope=user --uid=team-a --max-size=10T --max-objects=50000000
radosgw-admin quota enable --quota-scope=user --uid=team-a
radosgw-admin quota set --quota-scope=bucket --uid=team-a --max-objects=10000000
radosgw-admin quota enable --quota-scope=bucket --uid=team-a

radosgw-admin user stats --uid=team-a --sync-stats   # 刷新并查看用户用量
```

用户统计是异步更新的，超出配额的判断有几分钟的延迟，和 CephFS 配额一样属于"尽力而为"。

### 看桶的状态

```console
# radosgw-admin bucket stats --bucket=datasets
{
    "bucket": "datasets",
    "num_shards": 11,
    "id": "4a9f0e3c-...-cn-east-1.24105.1",
    "owner": "team-a",
    "usage": {
        "rgw.main": {
            "size": 2199023255552,
            "size_actual": 2199156891648,
            "num_objects": 1873410
        }
    },
    ...
}
```

`num_shards` 是桶索引的分片数。每个分片是一个 RADOS 对象，承载的 omap 条目太多（默认目标是每分片 10 万个对象，由 `rgw_max_objs_per_shard` 控制），就会出现 `LARGE_OMAP_OBJECTS` 告警，而且写入和 LIST 都会变慢。单站点默认开启动态重分片（dynamic resharding），RGW 会自动增加分片。也可以用 `radosgw-admin bucket limit check` 看所有桶的分片饱和度，或者手工执行 `radosgw-admin bucket reshard --bucket=datasets --num-shards=101`。预计会有上亿对象的桶，建议创建后马上手工分片。

### 限流

一个租户的批量任务打满 RGW，别的租户跟着超时，这是共享对象存储最常见的事故。RGW 支持按用户或桶限流：

```bash
radosgw-admin ratelimit set --ratelimit-scope=user --uid=team-a \
  --max-read-ops=12000 --max-write-ops=6000 \
  --max-read-bytes=$((6 * 1024**3)) --max-write-bytes=$((3 * 1024**3))
radosgw-admin ratelimit enable --ratelimit-scope=user --uid=team-a
```

有两个要点容易算错。第一，**限额按每个 RGW 实例、每分钟**计算。第二，超出限额的请求会直接收到 503，不排队。假设希望 team-a 整体不超过 1000 读 OPS，一共 6 个 RGW 实例，那么每个实例的每分钟读上限就是 1000 / 6 × 60 ≈ 10000。

## S3 客户端访问

```ini title="~/.aws/config"
[profile ceph]
region = cn
endpoint_url = http://s3.example.com
s3 =
    addressing_style = path
```

```ini title="~/.aws/credentials"
[ceph]
aws_access_key_id = <ACCESS_KEY>
aws_secret_access_key = <SECRET_KEY>
```

```bash
export AWS_PROFILE=ceph
aws s3 mb s3://datasets
aws s3 cp ./train.tar s3://datasets/2026/train.tar
aws s3 ls s3://datasets/2026/
aws s3 presign s3://datasets/2026/train.tar --expires-in 3600   # 生成临时下载链接
```

`endpoint_url` 写在 profile 里需要较新的 awscli v2。老版本只能每次加 `--endpoint-url`。海量小文件的批量传输用 `s5cmd`，并发度比 `aws s3 cp` 高很多：`s5cmd --endpoint-url http://s3.example.com cp 'dir/*' s3://datasets/dir/`。

生命周期（lifecycle）规则用来自动清理过期数据和未完成的 Multipart 上传。后者是被忽视最多的容量泄漏：

```json title="lifecycle.json"
{
  "Rules": [
    { "ID": "expire-tmp", "Status": "Enabled", "Filter": { "Prefix": "tmp/" },
      "Expiration": { "Days": 7 } },
    { "ID": "abort-mpu", "Status": "Enabled", "Filter": { "Prefix": "" },
      "AbortIncompleteMultipartUpload": { "DaysAfterInitiation": 3 } }
  ]
}
```

```bash
aws s3api put-bucket-lifecycle-configuration --bucket datasets --lifecycle-configuration file://lifecycle.json
radosgw-admin lc list        # 在集群侧查看生命周期任务的处理状态
```

## 监控指标

RGW 的指标有三个来源：

| 来源 | 端口 | 内容 |
| --- | --- | --- |
| MGR prometheus 模块 | 9283 | 集群级指标，以及汇总后的 RGW 计数器 |
| ceph-exporter（每台主机一个） | 9926 | 每个守护进程的性能计数器，包括每个 RGW 实例的请求数、失败数、队列长度、延迟 |
| haproxy 状态页 | 1967 | 入口层看到的请求数、各后端的健康状态和 HTTP 状态码分布 |

最关键的几个 RGW 指标：请求总数、失败请求数、正在处理的请求数（`qactive`）和排队数（`qlen`），以及 GET/PUT 的延迟。指标的具体名称在各版本间有调整，常见的是 `ceph_rgw_req`、`ceph_rgw_failed_req`、`ceph_rgw_qlen`、`ceph_rgw_qactive` 这一组。先 `curl -s http://ceph1:9926/metrics | grep rgw` 看看你的版本实际输出什么，再写告警规则。告警怎么设计见 [存储监控与告警](/learn/storage-monitoring)。

**按桶、按用户的统计**是运营最常问的："哪个租户用了多少、请求量最大的是哪个桶"。从 Squid（v19）开始，RGW 可以直接输出按用户和桶划分的操作计数器：

```bash
ceph config set client.rgw rgw_user_counters_cache true
ceph config set client.rgw rgw_bucket_counters_cache true
ceph orch restart rgw.s3
```

更老的版本（v18 及以前）没有这个能力，团队当时的做法是部署一个社区的 extended-ceph-exporter。它用一个只读的管理用户调用 Admin Ops API，把桶容量、对象数、用户配额导出为 Prometheus 指标，并以 cephadm 的 `service_type: container` 自定义服务运行，最后在 Prometheus 里加一个抓取任务。v19 以后我不再推荐这条路，自带计数器已经够用，而且少一个组件。容量类的指标（每个桶多大）仍然可以定期用 `radosgw-admin bucket stats` 采集。

## 出现 5xx 时从哪里查起

5xx 最先要回答的问题是：**谁返回的？**haproxy 和 RGW 都会返回 5xx，含义完全不同。

| 状态码 | 常见来源 | 常见原因 | 先看什么 |
| --- | --- | --- | --- |
| 502 / 504 | haproxy | 后端 RGW 挂了、超时、健康检查失败 | haproxy 状态页，`ceph orch ps --daemon_type rgw` |
| 503 | RGW | 触发限流；并发超过 `rgw_max_concurrent_requests`（默认 1024）；后端 RADOS 太慢导致请求堆积 | `qlen`/`qactive` 指标，`radosgw-admin ratelimit get`，`ceph health detail` 里的 `SLOW_OPS` |
| 500 | RGW | 内部错误，常见于索引分片异常、池满、权限配置错误 | RGW 日志，`ceph df` 看池是否 `FULL` |

排查顺序是：先看入口，再看 RGW，最后看 RADOS。

```bash
ceph orch ps --daemon_type rgw                       # 所有实例都 running 吗
ceph health detail                                   # 有没有 SLOW_OPS、OSD_NEARFULL、LARGE_OMAP_OBJECTS
cephadm logs --name rgw.s3.ceph1.wqkxzs | tail -50   # 在 RGW 所在主机上看日志
ceph config set client.rgw debug_rgw 20              # 临时提高日志级别，查完一定改回去
ceph config rm client.rgw debug_rgw
```

完整的排查闯关见 [Ceph 故障排查闯关](/learn/ceph-troubleshooting)。

## 动手练习

1. 创建 realm `example`、zonegroup `cn`、zone `cn-east-1`，提前建好索引池（副本）和数据池，用 YAML 部署每台主机 2 个实例的 RGW，然后用 curl 验证每个实例都能响应。
2. 部署 ingress 服务，VIP 用 `192.168.10.100`。在持有 VIP 的主机上 `systemctl stop` 对应的 keepalived 容器单元，观察 VIP 是否漂移到别的主机，客户端的 `aws s3 ls` 中断了多久。
3. 创建用户 `team-a`，设置 1 GiB 的用户配额并启用。用 awscli 上传文件直到被拒绝，记下返回的错误码和超出配额的量。
4. 给 `team-a` 设置每实例每分钟 600 次读操作的限流，用 `s5cmd` 高并发 LIST 或 GET，观察 503 出现的时机，并对照 haproxy 状态页上的状态码统计。
5. 上传 5 万个小对象到一个桶，用 `radosgw-admin bucket stats` 和 `bucket limit check` 观察分片数，然后手工重分片到 17 个分片。

## 自测

<details>
<summary>RGW 为什么适合水平扩展？扩展的瓶颈通常在哪里？</summary>

RGW 本身不保存状态，用户、桶、对象和索引都在 RADOS 里，所以多起几个实例、前面挂负载均衡就能扩展。瓶颈通常在三个地方：入口（持有 VIP 的 haproxy 的网卡带宽），桶索引池（omap 操作集中在少量分片上，尤其是没有提前分片的大桶），以及后端 OSD（数据池的 IOPS 和延迟）。

</details>

<details>
<summary>为什么建议一开始就显式创建 realm 和 zone，而不是用默认的 `default` zone？</summary>

显式的 realm/zonegroup/zone 让池名、拓扑一开始就规范。以后想加多站点复制，只需要在另一个集群加入一个 secondary zone。从 `default` zone 迁移到多站点，要重命名 zone、调整池名和 period，线上操作风险大得多。

</details>

<details>
<summary>给一个用户设了配额，但数据还是一直写进来，可能的原因是什么？</summary>

最常见的原因是只执行了 `radosgw-admin quota set`，没有执行 `quota enable`。另外，用户统计是异步更新的，超出配额的判断有几分钟延迟，所以会超写一部分。可以用 `radosgw-admin user info` 看 `user_quota.enabled` 是否为 true，用 `user stats --sync-stats` 刷新统计。

</details>

<details>
<summary>希望租户整体读 OPS 不超过 2000，集群有 8 个 RGW 实例，`--max-read-ops` 应该设多少？</summary>

RGW 限流按每个实例、每分钟计算。每个实例分到 2000 / 8 = 250 OPS，每分钟就是 250 × 60 = 15000，所以设 `--max-read-ops=15000`。前提是负载均衡把请求均匀分到了所有实例上。超出限额的请求会直接返回 503，不会排队。

</details>

<details>
<summary>客户端报大量 504，但 RGW 日志里看不到对应的错误，下一步查什么？</summary>

504 通常是 haproxy 等后端超时后返回的，RGW 可能根本没处理完这些请求，或者请求一直在排队。下一步看 haproxy 状态页的后端健康和响应时间，看 RGW 的 `qlen`/`qactive` 指标是否堆积，再看 `ceph health detail` 有没有 `SLOW_OPS`。如果 RADOS 层慢（比如某块 OSD 盘慢，或者索引池 omap 太大），RGW 的请求会一直挂着，最终表现为入口的 504。

</details>

## 参考资料

- [Ceph 文档：RGW Service（cephadm 部署 RGW 与 ingress）](https://docs.ceph.com/en/latest/cephadm/services/rgw/)
- [Ceph 文档：Multi-Site](https://docs.ceph.com/en/latest/radosgw/multisite/)
- [Ceph 文档：Admin Guide（用户、配额、限流）](https://docs.ceph.com/en/latest/radosgw/admin/)
- [Ceph 文档：Resharding（桶索引重分片）](https://docs.ceph.com/en/latest/radosgw/dynamicresharding/)
- [Ceph 文档：RGW Metrics（用户与桶计数器）](https://docs.ceph.com/en/latest/radosgw/metrics/)
- [Ceph 文档：Ceph Object Gateway Config Reference](https://docs.ceph.com/en/latest/radosgw/config-ref/)
- [AWS CLI：s3api put-bucket-lifecycle-configuration](https://docs.aws.amazon.com/cli/latest/reference/s3api/put-bucket-lifecycle-configuration.html)
- [s5cmd](https://github.com/peak/s5cmd)
