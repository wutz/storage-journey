# 用 cephadm 部署 Ceph 集群

[Ceph 架构](/learn/ceph-architecture)讲了 MON、MGR、OSD 各自负责什么，也讲了 CRUSH 怎么把对象放到盘上。这一课动手把集群跑起来。从三台裸机开始，先用 cephadm 引导（bootstrap）出第一个 MON，再加入其他主机、把空盘变成 OSD，最后做一轮验收，确认集群能交给下游使用。

部署本身不难，`cephadm bootstrap` 一条命令几分钟就能得到 `HEALTH_OK`。难在部署之前要做的决定：网络怎么分，哪些盘做数据，DB/WAL 放在哪，镜像从哪拉。这些一旦上了生产就很难改，所以本课有一半篇幅在讲"先想清楚再敲命令"。

> [!NOTE] 本课需要的环境
> - **至少 3 台** Linux 主机，物理机或虚拟机都行，推荐 Ubuntu 24.04 或 Rocky Linux 9。每台 4 vCPU、8 GiB 内存、一块 40 GiB 系统盘。
> - **每台至少 3 块空盘**做 OSD。虚拟机里挂 20 GiB 的空虚拟盘就够（`/dev/vdb`、`/dev/vdc`、`/dev/vdd`）。要练 DB/WAL 分离，可以把其中一块做得小一些，当作"快盘"。
> - **网络**：一个公共网（本文用 `192.168.10.0/24`），有条件再加一个集群网（`192.168.20.0/24`）。三台主机之间要能用 root 或免密 sudo 用户互相 SSH。
> - 能访问 `quay.io`，或者有一个私有镜像仓库（本文用 `registry.example.com` 举例）。
>
> 本文用的主机名是 `ceph1`～`ceph3`，公共网地址 `192.168.10.11`～`13`，集群网地址 `192.168.20.11`～`13`。

## 为什么是 cephadm

Ceph 的部署工具换过好几代。早期的 `ceph-deploy` 已经废弃，`ceph-ansible` 进入了维护状态。从 Octopus（v15）起，官方推荐用 **cephadm**；在 Kubernetes 上则用 [Rook](/learn/rook-ceph)。

cephadm 的思路和 Kubernetes 很像：**所有守护进程都跑在容器里，集群的期望状态由 MGR 里的编排器（Orchestrator）维护**。比如你告诉它"要 3 个 MON，放在带 `mon` 标签的主机上"，剩下的它通过 SSH 到各台主机上完成：拉镜像、写 systemd 单元、启动容器，进程挂了再拉起来。

```text
            ┌────────── ceph-mgr（active）── cephadm 模块 ──────────┐
            │        保存 service spec，计算并收敛"期望状态"          │
            └──────────────────────┬───────────────────────────────┘
                                   │ SSH
          ┌────────────────────────┼────────────────────────┐
          ▼                        ▼                        ▼
       ceph1                    ceph2                    ceph3
   podman/docker            podman/docker            podman/docker
   mon / mgr / osd.0-2      mon / mgr / osd.3-5      mon / osd.6-8
   prometheus / grafana     crash / node-exporter    crash / node-exporter
   systemd 单元：ceph-<fsid>@<daemon>.service
```

好处很实际：

- 主机上几乎不用装 Ceph 包。版本由镜像决定，升级就是换镜像，见 [Day-2 运维](/learn/ceph-day2)。
- 声明式管理：服务规格（service spec）写成 YAML，可以进 Git；新加的主机和盘按规格自动处理。
- 监控栈（Prometheus、Grafana、Alertmanager、node-exporter）随集群一起部署。

代价是多了一层容器，排障时要知道去哪找东西：日志在 `journalctl` 里，命令要在 `cephadm shell` 里跑。

## 规划：先把这几件事定下来

| 决策 | 建议 | 为什么 |
| --- | --- | --- |
| 版本 | 当前稳定版的最新小版本 | 截至本文写作时是 Tentacle v20.2.x（本文用 v20.2.4），Squid v19.2.x 仍在维护。以 [官方发布页](https://docs.ceph.com/en/latest/releases/) 为准 |
| 网络 | 公共网和集群网分开，至少 25 GbE | 恢复和副本复制走集群网，不和客户端抢带宽 |
| MON 数量 | 3 个；5 台以上主机用 5 个 | MON 靠多数派（quorum）工作，数量为偶数没有好处 |
| 系统盘 | 至少用 SATA SSD | MON 的 RocksDB 在系统盘上，系统盘用机械盘是 MON 选举抖动的常见原因 |
| 数据盘 | 同一个池的盘尽量同型号、同容量 | CRUSH 按权重分数据，容量混杂会让小盘先满 |
| DB/WAL | HDD 集群必须把 DB/WAL 放到 NVMe；全闪集群不用分 | HDD 扛不住元数据和日志这类小 I/O |

> [!PROD] 系统盘先测再装
> 部署前先用 fio 测系统盘的 fsync 延迟，标准和 etcd 一样：`fdatasync` 的 p99 最好在 10 ms 以内。MON 每次提交 Paxos 都要落盘，系统盘慢，整个集群的 map 更新都会慢。测法见 [基准测试](/learn/benchmarking)。

## 节点准备

以下操作**每台**主机都要做。主机多就用 `pdsh` 或 `ansible` 批量执行，别手敲。

### 主机名、时间与容器运行时

cephadm 用**短主机名**识别主机。`hostname` 的输出必须和之后 `ceph orch host add` 里写的名字一致。

```bash
hostnamectl set-hostname ceph1        # 每台分别设置
cat >> /etc/hosts <<EOF
192.168.10.11  ceph1
192.168.10.12  ceph2
192.168.10.13  ceph3
EOF

# 依赖：Python 3、systemd、Podman 或 Docker、LVM2、时间同步
apt install -y podman lvm2 python3 chrony        # Rocky：dnf install -y podman lvm2 python3 chrony
systemctl enable --now chrony                    # Rocky 上服务名是 chronyd
chronyc tracking | grep -E 'Reference|System time'
```

MON 之间的时钟偏差超过 `mon_clock_drift_allowed`（默认 0.05 秒）会报 `MON_CLOCK_SKEW`。所以所有 MON 主机都要指向同一组 NTP 源。

用 Docker 也可以。团队的集群就用 Docker，为的是和 Kubernetes 节点的运维习惯保持一致。这时建议在 `/etc/docker/daemon.json` 里打开 `"live-restore": true`，重启 dockerd 时就不会把所有 OSD 容器一起带走。另外配好日志轮转（`log-opts` 里的 `max-size`/`max-file`）。

> [!WARNING] 不要提前创建 ceph 用户
> 容器里的 ceph 进程以 UID/GID 167 运行。如果你手工建过一个叫 `ceph`、UID 又不是 167 的用户，之后装 `ceph-common` 包会出错，文件属主也会乱掉。

### 安装 cephadm

只需要在 bootstrap 节点和打算当管理节点的主机上安装。用官方的 curl 方式可以精确控制版本，发行版仓库里的 cephadm 往往落后一个大版本：

```bash
CEPH_RELEASE=20.2.4      # 截至本文写作时 Tentacle 的最新版，以官方发布页为准
curl --silent --remote-name --location \
  https://download.ceph.com/rpm-${CEPH_RELEASE}/el9/noarch/cephadm
install -m 0755 cephadm /usr/sbin/cephadm
cephadm version
cephadm check-host       # 最后一行应输出 Host looks OK
```

这个 `cephadm` 是一个 Python zipapp，在 Ubuntu 上也能直接用。

### 清理数据盘

cephadm 只用"干净"的盘，条件是：没有分区，没有文件系统，没有 LVM，没被挂载，容量大于 5 GiB。装过别的系统或别的集群用过的盘，要先擦干净：

```bash
lsblk -o NAME,SIZE,MODEL,SERIAL,FSTYPE,MOUNTPOINTS
wipefs -a /dev/vdb
sgdisk --zap-all /dev/vdb
dd if=/dev/zero of=/dev/vdb bs=1M count=100 oflag=direct
```

> [!DANGER] 擦盘前三次确认设备名
> `/dev/sdX` 的顺序重启后可能变化。动手前务必核对型号和序列号。擦错了系统盘或者别人的数据盘，没有后悔药。

NVMe 盘如果支持 4K 扇区，建议上线前格式化成 4K。先用 `nvme id-ns /dev/nvme0n1 | grep lbaf` 找到 `lbads:12` 那一项的编号，再执行 `nvme format --lbaf=<编号>`。这会清空整块盘。

防火墙要放行这些端口：MON 用 3300 和 6789，OSD、MGR、MDS 用 6800–7568，Dashboard 用 8443，MGR 的 prometheus 模块用 9283，监控栈用 9095、3000、9093、9100。检测到 firewalld 时，cephadm 会自动开放这些端口。

## 引导集群：cephadm bootstrap

在 `ceph1` 上执行：

```bash
cephadm --image quay.io/ceph/ceph:v20.2.4 bootstrap \
  --mon-ip 192.168.10.11 \
  --cluster-network 192.168.20.0/24
```

建议显式写上 `--image`，这样装的就是你测试过的那个版本。输出的最后几行：

```text
Ceph Dashboard is now available at:
	     URL: https://ceph1:8443/
	    User: admin
	Password: <随机生成的初始密码>
...
	sudo /usr/sbin/cephadm shell --fsid 3f1c6a2e-8b7d-11f0-9c21-525400a1b2c3 -c /etc/ceph/ceph.conf -k /etc/ceph/ceph.client.admin.keyring

Bootstrap complete.
```

这一条命令做了这些事：

- 在本机启动第一个 MON 和 MGR；
- 生成集群的 SSH 密钥，公钥写到 `/etc/ceph/ceph.pub`；
- 生成最小配置 `/etc/ceph/ceph.conf` 和管理员密钥 `/etc/ceph/ceph.client.admin.keyring`；
- 给本机打上 `_admin` 标签（带这个标签的主机会自动同步 conf 和 admin keyring）；
- 部署 crash 收集器和监控栈。

常用参数：

| 参数 | 作用 |
| --- | --- |
| `--config initial-ceph.conf` | 引导时注入配置，比如私有镜像地址 |
| `--registry-json login.json` | 私有仓库需要登录时用 |
| `--apply-spec cluster.yaml` | 引导完成后直接应用整套主机和服务规格 |
| `--ssh-user deploy` | 不用 root，改用一个有免密 sudo 的用户 |
| `--skip-monitoring-stack` | 已有统一监控时，不部署自带监控栈 |
| `--single-host-defaults` | 单机实验用，把副本故障域降到 OSD 级别 |

要用上 `ceph` 命令，有两种方式。一是 `cephadm shell` 进入带全套工具的容器，或者用 `cephadm shell -- ceph -s` 只跑一条命令。二是在 `_admin` 主机上装客户端包：`cephadm add-repo --release tentacle && cephadm install ceph-common`。团队习惯用后者，这样 `rbd`、`mount.ceph` 也一起装好了。

## 添加主机与标签

MGR 通过 SSH 管理所有主机，所以先分发集群公钥，再加主机：

```bash
ssh-copy-id -f -i /etc/ceph/ceph.pub root@ceph2
ssh-copy-id -f -i /etc/ceph/ceph.pub root@ceph3

ceph orch host add ceph2 192.168.10.12 --labels _admin,mon,osd
ceph orch host add ceph3 192.168.10.13 --labels mon,osd
ceph orch host label add ceph1 mon
ceph orch host label add ceph1 osd
ceph orch host ls
```

```text
HOST   ADDR           LABELS          STATUS
ceph1  192.168.10.11  _admin,mon,osd
ceph2  192.168.10.12  _admin,mon,osd
ceph3  192.168.10.13  mon,osd
3 hosts in cluster
```

**标签（label）是 cephadm 调度的主要手段。**它本身没有含义，被服务规格的 `placement` 引用时才起作用。有两个内置标签例外：`_admin` 会同步 `/etc/ceph` 下的配置和密钥，建议至少给 2 台主机打上，这样 bootstrap 节点坏了还能管集群；`_no_schedule` 表示不在这台主机上调度任何守护进程，`host drain` 时会自动加上。其余标签（`mon`、`osd`、`mds`、`rgw`）都是团队自己的约定。

bootstrap 之后，MON 的默认规格是"最多 5 个、放在任意主机上"。主机一加进来，就可能在不该放的地方起 MON。所以要马上用标签把位置钉住：

```bash
ceph orch apply mon --placement="label:mon"
ceph orch apply mgr --placement="2 label:mon"
# 主机分布在多个网段时，要告诉 MON 所有公共网段
ceph config set mon public_network "192.168.10.0/24,192.168.11.0/24"
```

## 添加 OSD

### 看看有哪些盘

```console
# ceph orch device ls --refresh
HOST   PATH      TYPE  DEVICE ID  SIZE   AVAILABLE  REFRESHED  REJECT REASONS
ceph1  /dev/vdb  hdd   vd-0001    20.0G  Yes        12s ago
ceph1  /dev/vdc  hdd   vd-0002    20.0G  Yes        12s ago
ceph1  /dev/vdd  hdd   vd-0003    10.0G  Yes        12s ago
ceph2  /dev/vdb  hdd   vd-0101    20.0G  No         12s ago    Has a FileSystem, LVM detected
```

`AVAILABLE` 为 `No` 时，看 `REJECT REASONS` 列找原因。确认数据不要了，可以让 cephadm 远程擦盘：`ceph orch device zap ceph2 /dev/vdb --force`。要看某块盘的详细属性（是否旋转、容量、型号），用 `cephadm shell -- ceph-volume inventory /dev/vdb`。写过滤条件就靠这些属性。

### 最省事的方式：所有可用盘

```bash
ceph orch apply osd --all-available-devices
```

这条命令会生成一个托管服务，**以后任何主机上出现的空盘都会被自动做成 OSD**。实验环境很方便，生产环境我不推荐：有人临时插一块盘拷数据，转眼就被 Ceph 占用了。生产环境请用 OSD 规格文件精确描述要用哪些盘、每块盘做什么。

### OSD service spec：按属性挑盘

| 过滤器 | 写法 | 说明 |
| --- | --- | --- |
| `rotational` | `1` / `0` | 内核认为是机械盘 / 非机械盘 |
| `size` | `'10T'`、`'10T:40T'`、`':2T'`、`'2T:'` | 精确值、区间、不大于、不小于 |
| `model` / `vendor` | 字符串 | 换盘后型号可能变，能用属性就别用型号 |
| `limit` | 整数 | 每台主机最多选几块 |

最常见的容量型集群是 HDD 做数据、NVMe 放 DB/WAL：

```yaml title="osd-hdd-nvme.yaml"
service_type: osd
service_id: hdd_nvme_db
placement:
  label: osd
spec:
  data_devices:
    rotational: 1
    size: '10T:'          # 只选 10 TB 以上的 HDD
  db_devices:
    rotational: 0
  db_slots: 6             # 每块 NVMe 切 6 份，对应 6 块 HDD
```

只写 `db_devices`、不写 `wal_devices` 时，WAL 和 DB 放在一起，这正是大多数场景想要的。全闪集群只需要 `data_devices: {rotational: 0}`。超高速 NVMe 上可以加 `osds_per_device: 2`，一块盘跑两个 OSD，把 CPU 用满。

> [!TIP] DB 分多大
> BlueStore 的官方建议：RGW 负载的 `block.db` 不小于数据盘的 4%，RBD 负载一般 1%～2% 就够。DB 放不下时，RocksDB 会溢出（spillover）到慢盘上，`ceph health detail` 会报 `BLUEFS_SPILLOVER`。宁可 DB 分大一点，也别为了多挂几块 HDD 把 NVMe 切得太碎。

**先 dry-run，再真正应用：**

```console
# ceph orch apply -i osd-hdd-nvme.yaml --dry-run
################
OSDSPEC PREVIEWS
################
+---------+-------------+-------+----------+--------------+-----+
|SERVICE  |NAME         |HOST   |DATA      |DB            |WAL  |
+---------+-------------+-------+----------+--------------+-----+
|osd      |hdd_nvme_db  |ceph1  |/dev/sdb  |/dev/nvme0n1  |-    |
|osd      |hdd_nvme_db  |ceph1  |/dev/sdc  |/dev/nvme0n1  |-    |
...
```

预览要等编排器刷新一次设备列表，第一次执行可能提示你稍后再试。预览符合预期后，去掉 `--dry-run` 正式应用，然后用 `ceph -W cephadm` 实时看编排器日志。出错后用 `ceph log last cephadm` 看最近的记录。`service_id` 是规格的主键：再次 apply 同名规格会覆盖旧规格，但只影响之后新建的 OSD。

### 按设备类型建 CRUSH 规则

OSD 创建时会自动得到一个设备类型（device class）：`hdd`、`ssd` 或 `nvme`。默认的 `replicated_rule` 不区分类型，HDD 和 SSD 混在一个池里，性能取决于最慢的那块盘。所以建业务池之前先建规则：

```bash
ceph osd crush rule create-replicated rep_hdd default host hdd
ceph osd crush rule create-replicated rep_ssd default host ssd
ceph osd erasure-code-profile set ec42_hdd k=4 m=2 \
  crush-root=default crush-failure-domain=host crush-device-class=hdd

# 团队踩过的坑：.mgr 池也要切到带类型的规则上
ceph osd pool set .mgr crush_rule rep_hdd
ceph osd pool autoscale-status
```

如果 `.mgr` 池用默认规则、其他池用带类型的规则，两套规则覆盖的 OSD 会重叠，PG 自动伸缩器（autoscaler）就会停止工作，`autoscale-status` 输出为空。纠删码的 `k+m` 怎么选、至少要几台主机，回顾 [副本与纠删码](/learn/replication-ec)。

## 用一份 YAML 描述整个集群

命令可以一条条敲，但更好的做法是把集群写成一份规格文件放进 Git：

```yaml title="cluster.yaml"
service_type: host
hostname: ceph2
addr: 192.168.10.12
labels: [_admin, mon, osd]
---
service_type: host
hostname: ceph3
addr: 192.168.10.13
labels: [mon, osd]
---
service_type: mon
placement:
  label: mon
---
service_type: mgr
placement:
  count: 2
  label: mon
---
service_type: osd
service_id: default_hdd
placement:
  label: osd
spec:
  data_devices:
    rotational: 1
```

集群已经存在时，随时可以 `ceph orch apply -i cluster.yaml`。也可以在引导时通过 `--apply-spec cluster.yaml` 一次性应用。这种情况下新主机必须提前信任集群的 SSH 公钥：要么用 `--ssh-private-key`/`--ssh-public-key` 指定一对预先分发好的密钥，要么分两步做。反过来，线上正在生效的规格可以用 `ceph orch ls --export > cluster-live.yaml` 导出备份。

> [!TIP] unmanaged：让编排器先别动
> 在任何规格里加一行 `unmanaged: true`，编排器会保留规格，但停止自动创建或删除守护进程。换盘、排障期间想"冻住"OSD 服务时很有用，例如 `ceph orch apply osd --all-available-devices --unmanaged=true`。

## 离线与私有镜像仓库部署

生产机房往往不能直连 `quay.io`，或者合规要求所有镜像都来自内部仓库。cephadm 用到的镜像不止 `ceph/ceph` 一个，监控栈和 ingress 都有各自的镜像。

第一步，在能联网的机器上用 `skopeo` 把镜像同步到私有仓库：

```bash title="sync-images.sh"
#!/usr/bin/env bash
set -euo pipefail
DST=registry.example.com
IMAGES=(
  quay.io/ceph/ceph:v20.2.4
  quay.io/prometheus/prometheus:v3.6.0
  quay.io/prometheus/node-exporter:v1.9.1
  quay.io/prometheus/alertmanager:v0.28.1
  quay.io/ceph/grafana:12.3.1
  quay.io/ceph/haproxy:2.3          # 用 RGW ingress 时需要
  quay.io/ceph/keepalived:2.2.4     # 同上
)
for img in "${IMAGES[@]}"; do
  skopeo copy --all "docker://${img}" "docker://${DST}/${img}"
done
```

这些版本号是截至本文写作时 Tentacle 的默认值，每个小版本都可能调整。准确值以 [监控文档的 Default Images 一节](https://docs.ceph.com/en/latest/cephadm/services/monitoring/#default-images) 为准，也可以在同版本的集群上用 `ceph config get mgr mgr/cephadm/container_image_prometheus` 读出来。完全隔离的机房可以先用 `skopeo copy ... dir:/media/usb/<name>` 导出到介质，带进机房后再导入。

第二步，引导时指向私有仓库：

```ini title="initial-ceph.conf"
[mgr]
mgr/cephadm/container_image_prometheus = registry.example.com/quay.io/prometheus/prometheus:v3.6.0
mgr/cephadm/container_image_node_exporter = registry.example.com/quay.io/prometheus/node-exporter:v1.9.1
mgr/cephadm/container_image_alertmanager = registry.example.com/quay.io/prometheus/alertmanager:v0.28.1
mgr/cephadm/container_image_grafana = registry.example.com/quay.io/ceph/grafana:12.3.1
mgr/cephadm/container_image_haproxy = registry.example.com/quay.io/ceph/haproxy:2.3
mgr/cephadm/container_image_keepalived = registry.example.com/quay.io/ceph/keepalived:2.2.4
```

```bash
# login.json：{"url": "registry.example.com", "username": "ceph-puller", "password": "<从密钥系统读取>"}
cephadm --image registry.example.com/quay.io/ceph/ceph:v20.2.4 bootstrap \
  --mon-ip 192.168.10.11 --cluster-network 192.168.20.0/24 \
  --config initial-ceph.conf --registry-json login.json
```

登录信息会存进集群的配置库，之后加入的主机自动使用。集群跑起来之后也能再切到私有仓库：用 `ceph cephadm registry-login registry.example.com <用户> <密码>` 登录，用 `ceph config set global container_image <镜像>` 和 `ceph config set mgr mgr/cephadm/container_image_* <镜像>` 改地址，最后 `ceph orch redeploy <服务名>`。

> [!NOTE] cephadm 会把 tag 解析成 digest
> `mgr/cephadm/use_repo_digest` 默认为 true。此时编排器会先把 `v20.2.4` 这样的 tag 解析成镜像 digest，再下发给各主机，保证所有主机跑的镜像字节级一致。所以私有仓库要用 `skopeo copy --all` 原样同步，不要自己重新打包。

离线环境还有几样东西别忘了：chrony 要能访问内部 NTP 源；`ceph-common` 等客户端包要有内部的 apt/yum 镜像；`cephadm` 二进制本身也要提前带进去。

## 部署后验收

`HEALTH_OK` 只说明"没发现问题"，不说明"扛得住生产"。交付前按这张清单过一遍：

| 检查项 | 命令 | 期望 |
| --- | --- | --- |
| 整体健康 | `ceph -s`、`ceph health detail` | `HEALTH_OK`，没有被 mute 的告警 |
| MON / MGR | `ceph mon stat`、`ceph mgr stat` | MON 全部在 quorum 里；MGR 1 个 active，至少 1 个 standby |
| 服务与进程 | `ceph orch ls`、`ceph orch ps` | 每个服务的 `RUNNING` 等于 `SIZE`，没有 error 状态的进程 |
| OSD 拓扑 | `ceph osd tree`、`ceph osd df tree` | 每台主机的 OSD 数、设备类型、权重符合设计 |
| 版本与崩溃 | `ceph versions`、`ceph crash ls` | 版本一致，没有崩溃记录 |
| 性能基线 | `rados bench` | 记录下来，以后作为对比基线 |

```console
# ceph -s
  cluster:
    id:     3f1c6a2e-8b7d-11f0-9c21-525400a1b2c3
    health: HEALTH_OK
  services:
    mon: 3 daemons, quorum ceph1,ceph2,ceph3 (age 2h)
    mgr: ceph1.xkqzpd(active, since 2h), standbys: ceph2.mbtnaw
    osd: 9 osds: 9 up (since 25m), 9 in (since 25m)
  data:
    pools:   1 pools, 1 pgs
    usage:   2.6 GiB used, 177 GiB / 180 GiB avail
    pgs:     1 active+clean
```

用 `rados bench` 打一个最原始的基线。它直接走 RADOS，不经过 RBD 或 CephFS：

```bash
ceph osd pool create testbench 32 32 replicated rep_hdd
rados bench -p testbench 30 write --no-cleanup   # 关注 Bandwidth、Average IOPS、Average Latency
rados bench -p testbench 30 seq
rados bench -p testbench 30 rand

# 测完删掉测试池；删池默认是禁止的，先临时放开，删完再关上
rados -p testbench cleanup
ceph config set mon mon_allow_pool_delete true
ceph osd pool rm testbench testbench --yes-i-really-really-mean-it
ceph config set mon mon_allow_pool_delete false
```

### 内存：别让 OSD 吃光主机

bootstrap 默认开启 `osd_memory_target_autotune`，把主机内存的 70% 分给本机所有 OSD。存储节点独占时这没问题；如果和 MDS、RGW 或其他业务混部，就要调低比例，或者自己算一个固定值：

```bash
ceph config set mgr mgr/cephadm/autotune_memory_target_ratio 0.2   # 混部：只给 OSD 20%

# 或者关掉自动调优，直接给定值。例：256 GiB 内存、32 块盘，每个 OSD 6 GiB
ceph config set osd osd_memory_target_autotune false
ceph config set osd osd_memory_target 6442450944
```

## 常见的坑

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `host add` 报 SSH 失败 | 公钥没发过去，或者 `hostname` 和添加时写的名字不一致 | 重新 `ssh-copy-id`，核对 `hostname` 输出 |
| OSD 数比盘少 | 盘上有残留的分区、LVM 或旧集群标签 | 看 `REJECT REASONS`，确认后 zap |
| 擦了盘还是不可用 | 残留的 device-mapper 映射还在 | `dmsetup ls` 找 `ceph--` 开头的映射，`dmsetup remove` 后刷新 |
| 多路径盘重启后 OSD 起不来 | LVM 先扫到了 `/dev/sd*` 路径 | 在 `lvm.conf` 里配 `filter`，只接受 `/dev/mapper/mpath*` |
| MON 数量不对 | 默认 MON 规格是"最多 5 个、任意主机" | 立刻 `ceph orch apply mon --placement="label:mon"` |

## 动手练习

1. 准备 3 台虚拟机，每台挂 3 块空盘。按本文做完节点准备，用 `cephadm check-host` 自检。
2. 在 `ceph1` 上 bootstrap，加入另外两台主机，用标签把 MON 固定在 3 台上。然后登录 Dashboard 改掉初始密码。
3. 写一份 OSD 规格，用 `size` 过滤器把小盘 `/dev/vdd` 选作 DB 盘、另外两块做数据盘。先 `--dry-run` 看预览再应用，最后用 `ceph osd metadata 0 | grep -E 'bluefs_dedicated_db|devices'` 确认 DB 确实在 `vdd` 上。
4. 创建 `rep_hdd` 规则，把 `.mgr` 池切过去，确认 `ceph osd pool autoscale-status` 有输出。
5. 用 `ceph orch ls --export` 导出线上规格，和你手写的 YAML 对比。再跑一遍 `rados bench` 的写、顺序读、随机读，把三组数字记为这套集群的基线。

## 自测

<details>
<summary>cephadm 部署的守护进程跑在哪里？出问题去哪看日志？</summary>

每个守护进程都是一个容器（Podman 或 Docker），由名为 `ceph-<fsid>@<daemon>.service` 的 systemd 单元管理。日志默认进 journald。在对应主机上用 `cephadm logs --name osd.3` 或 `journalctl -u ceph-<fsid>@osd.3` 查看。编排器本身的日志用 `ceph -W cephadm` 和 `ceph log last cephadm` 查看。

</details>

<details>
<summary>为什么生产环境不推荐 `ceph orch apply osd --all-available-devices`？</summary>

它会创建一个托管的 OSD 服务，之后任何主机上出现的空盘都会被自动做成 OSD，包括临时插上拷数据的盘和计划另作他用的盘。生产环境应该写 OSD service spec，用 `rotational`、`size` 等过滤器精确描述哪些盘做数据、哪些做 DB/WAL，并且先用 `--dry-run` 预览。

</details>

<details>
<summary>一台主机有 12 块 16 TB HDD 和 2 块 3.84 TB NVMe，用来跑 RGW，DB 怎么规划？</summary>

RGW 负载建议 `block.db` 不小于数据盘的 4%，16 TB × 4% ≈ 640 GB。2 块 NVMe 共 7.68 TB，分给 12 块 HDD，每块约 640 GB，刚好满足。规格里 `data_devices` 写 `rotational: 1`，`db_devices` 写 `rotational: 0`，`db_slots: 6`。如果切得更碎，DB 会溢出到 HDD 上（`BLUEFS_SPILLOVER`），小 I/O 性能明显下降。

</details>

<details>
<summary>离线部署时，只同步 `quay.io/ceph/ceph` 一个镜像够不够？</summary>

不够。cephadm 默认还会部署 Prometheus、Grafana、Alertmanager 和 node-exporter，用 RGW ingress 还需要 haproxy 和 keepalived。这些镜像都要同步过去，并通过 `mgr/cephadm/container_image_*` 指向私有仓库。仓库需要登录时，还要配置 `--registry-json` 或 `ceph cephadm registry-login`。

</details>

<details>
<summary>为什么要在建业务池之前先建带设备类型的 CRUSH 规则？</summary>

默认规则不区分设备类型，HDD 和 SSD 混进同一个池，性能会被最慢的盘拖住。另外，`.mgr` 池和业务池的规则覆盖的 OSD 如果重叠，PG autoscaler 会停止工作。所以要先建 `rep_ssd`、`rep_hdd` 这类规则，并把 `.mgr` 池也切过去。

</details>

## 参考资料

- [Ceph 文档：Deploying a New Ceph Cluster](https://docs.ceph.com/en/latest/cephadm/install/)
- [Ceph 文档：Host Management](https://docs.ceph.com/en/latest/cephadm/host-management/)
- [Ceph 文档：OSD Service（OSD 规格与过滤器）](https://docs.ceph.com/en/latest/cephadm/services/osd/)
- [Ceph 文档：Service Management（服务规格与 placement）](https://docs.ceph.com/en/latest/cephadm/services/)
- [Ceph 文档：Monitoring Services（默认镜像）](https://docs.ceph.com/en/latest/cephadm/services/monitoring/)
- [Ceph 文档：BlueStore Configuration Reference（DB 容量建议）](https://docs.ceph.com/en/latest/rados/configuration/bluestore-config-ref/)
- [Ceph Releases：活跃版本与生命周期](https://docs.ceph.com/en/latest/releases/)
- [skopeo](https://github.com/containers/skopeo)
