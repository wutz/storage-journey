// 课程大纲：唯一的元数据来源。正文放在 src/content/lessons/<stage.id>/<slug>.md
export type Lesson = {
  slug: string
  title: string
  summary: string
  minutes: number
}

export type Stage = {
  id: string
  index: number
  name: string
  level: string
  tagline: string
  goal: string
  lessons: Lesson[]
}

export const stages: Stage[] = [
  {
    id: 'stage-0',
    index: 0,
    name: '启程',
    level: 'Prerequisites',
    tagline: '看清数据住在哪里',
    goal: '建立存储的整体图景，搭好能随意"折腾坏"的实验环境，知道一次读写在 Linux 里会经过哪些层。',
    lessons: [
      { slug: 'welcome', title: '学习路线与使用指南', summary: '这套教程怎么学、每个阶段学到什么程度、需要准备什么。', minutes: 10 },
      { slug: 'storage-landscape', title: '存储全景：从寄存器到集群', summary: '存储层次与延迟数量级，DAS / NAS / SAN / 对象存储，以及存储工程师的日常。', minutes: 25 },
      { slug: 'lab-environment', title: '搭建实验环境', summary: '用虚拟机和 loop 设备造出"很多块盘"，准备好 fio、sysstat、bpftrace 等工具。', minutes: 30 },
      { slug: 'io-stack', title: '一次 write() 的旅程：Linux I/O 栈', summary: '系统调用、VFS、页缓存、块层、驱动到设备，建立贯穿全课程的 I/O 路径模型。', minutes: 35 },
    ],
  },
  {
    id: 'stage-1',
    index: 1,
    name: '入门',
    level: 'Beginner',
    tagline: '玩转一台机器上的存储',
    goal: '能独立完成单机存储的上盘、分区、组 RAID、建文件系统和挂载，理解数据什么时候才算真正落盘。',
    lessons: [
      { slug: 'storage-hardware', title: '存储硬件：HDD、SSD 与 NVMe', summary: '机械盘的寻道与转速，NAND、FTL、写放大与寿命，SATA / SAS / NVMe 接口差异。', minutes: 40 },
      { slug: 'block-devices', title: '块设备、分区与 LVM', summary: 'lsblk / udev 设备命名、GPT 分区、LVM 的 PV / VG / LV、在线扩容与快照。', minutes: 40 },
      { slug: 'raid', title: 'RAID 与 mdadm', summary: 'RAID 0/1/5/6/10 的容量、性能与可靠性取舍，重建过程与写洞问题。', minutes: 35 },
      { slug: 'filesystems', title: '文件系统：ext4、XFS 与挂载', summary: 'inode、目录、日志与区段分配，mkfs 与挂载选项，fstab 与常见坑。', minutes: 40 },
      { slug: 'page-cache', title: '页缓存与持久化语义', summary: '页缓存、脏页回写、fsync / O_DIRECT / O_SYNC，以及"写成功"到底意味着什么。', minutes: 40 },
      { slug: 'block-file-object', title: '块、文件、对象：三种存储语义', summary: '三种接口的抽象与适用场景，iSCSI、NFS、S3 初体验。', minutes: 35 },
    ],
  },
  {
    id: 'stage-2',
    index: 2,
    name: '进阶',
    level: 'Intermediate',
    tagline: '会测、会看、会调',
    goal: '能用科学的方法测出存储的真实性能，用观测工具定位 I/O 瓶颈，并有依据地调优。',
    lessons: [
      { slug: 'perf-metrics', title: '性能指标：IOPS、吞吐与延迟', summary: '三大指标的关系、队列深度与 Little 定律、延迟分布与尾延迟。', minutes: 35 },
      { slug: 'methodology', title: '性能分析方法论', summary: 'USE 方法、负载特征刻画、延迟分析与"没有基线的调优都是玄学"。', minutes: 40 },
      { slug: 'disk-observability', title: '磁盘 I/O 观测：iostat 到 blktrace', summary: 'iostat 每一列的含义、pidstat / iotop 找进程、blktrace 看请求生命周期。', minutes: 45 },
      { slug: 'fs-observability', title: '文件系统观测：缓存与延迟', summary: 'free / vmstat / cachestat 看缓存，ext4slower、fileslower 找慢操作。', minutes: 40 },
      { slug: 'bpf-io-tracing', title: '用 BPF 看清 I/O', summary: 'BCC 工具 biolatency / biosnoop / biotop，用 bpftrace 写自己的 I/O 追踪脚本。', minutes: 50 },
      { slug: 'benchmarking', title: '基准测试：fio 与 elbencho', summary: 'fio 参数与任务文件、结果解读、分布式压测 elbencho，以及常见的测试陷阱。', minutes: 50 },
      { slug: 'io-tuning', title: 'I/O 调优：调度器、队列与内核参数', summary: 'I/O 调度器、队列深度、预读、脏页参数与文件系统挂载选项的调优。', minutes: 40 },
    ],
  },
  {
    id: 'stage-3',
    index: 3,
    name: '原理',
    level: 'Advanced',
    tagline: '从单机走向分布式',
    goal: '理解网络存储与分布式存储的核心原理，能解释数据如何分布、如何冗余、故障时如何恢复。',
    lessons: [
      { slug: 'network-storage', title: '网络存储：NFS、iSCSI 与 NVMe-oF', summary: '搭建 NFS 与 iSCSI 服务，理解 NVMe-oF，网络如何改变存储的延迟与故障模型。', minutes: 45 },
      { slug: 'distributed-basics', title: '分布式存储基础', summary: '数据分布（哈希、一致性哈希、CRUSH）、一致性与法定人数、故障域。', minutes: 45 },
      { slug: 'replication-ec', title: '副本与纠删码', summary: '多副本与 EC 的容量效率、写放大、重建代价，以及何时该用哪一种。', minutes: 40 },
      { slug: 'object-storage', title: '对象存储与 S3 协议', summary: 'Bucket / Object / Multipart、签名与一致性，用 MinIO / RustFS 动手。', minutes: 40 },
      { slug: 'distributed-fs', title: '元数据与分布式文件系统', summary: '命名空间与元数据服务、POSIX 语义的代价，JuiceFS、3FS 等不同设计。', minutes: 40 },
      { slug: 'ceph-architecture', title: 'Ceph 架构：RADOS、CRUSH 与 PG', summary: 'MON / MGR / OSD / MDS / RGW 的分工，CRUSH 规则、PG 与数据的一生。', minutes: 50 },
    ],
  },
  {
    id: 'stage-4',
    index: 4,
    name: '生产',
    level: 'Production',
    tagline: '部署并运维 Ceph 与 K8s 存储',
    goal: '能规划、部署并长期运维一套生产 Ceph 集群，为 Kubernetes 提供块、文件与对象存储。',
    lessons: [
      { slug: 'cephadm-deploy', title: '用 cephadm 部署 Ceph 集群', summary: '节点准备、bootstrap、添加主机与 OSD、服务规格文件与离线部署。', minutes: 60 },
      { slug: 'ceph-rbd-cephfs', title: 'RBD 块存储与 CephFS 文件系统', summary: '存储池与 RBD 镜像、快照与克隆，CephFS 的 MDS、子卷与客户端挂载。', minutes: 50 },
      { slug: 'ceph-rgw', title: 'RGW 对象网关', summary: '部署 RGW、用户与配额、多站点概念、S3 客户端访问与监控指标。', minutes: 45 },
      { slug: 'ceph-day2', title: 'Ceph Day-2 运维', summary: '扩容与替换坏盘、升级、维护模式、参数管理与日常巡检清单。', minutes: 55 },
      { slug: 'ceph-troubleshooting', title: 'Ceph 故障排查闯关', summary: 'HEALTH_WARN 解读、PG 异常、慢请求、MON / MDS 故障的排查路径。', minutes: 55 },
      { slug: 'k8s-csi', title: 'Kubernetes 存储与 CSI', summary: 'PV / PVC / StorageClass、CSI 架构，local、NFS、Ceph CSI 与快照。', minutes: 45 },
      { slug: 'rook-ceph', title: 'Rook：在 Kubernetes 上运行 Ceph', summary: 'Rook Operator、CephCluster 规格、块 / 文件 / 对象存储类与 Day-2。', minutes: 50 },
      { slug: 'storage-monitoring', title: '存储监控与告警', summary: 'Ceph 与节点指标、Prometheus / Grafana、关键告警规则与容量趋势。', minutes: 40 },
    ],
  },
  {
    id: 'stage-5',
    index: 5,
    name: '专家',
    level: 'Expert',
    tagline: '高性能存储与 AI 平台',
    goal: '能为 GPU / AI 集群设计高性能存储方案，完成容量与性能规划，并建立可靠的 on-call 体系。',
    lessons: [
      { slug: 'rdma', title: '高性能网络：RDMA、InfiniBand 与 RoCE', summary: 'RDMA 原理、IB 与 RoCE 的差异、无损网络配置与带宽 / 延迟测试。', minutes: 45 },
      { slug: 'gpfs-concepts', title: 'GPFS / Storage Scale 核心概念', summary: 'NSD、文件系统、仲裁、Token 管理、多集群 owning / accessing 模型与 ECE。', minutes: 50 },
      { slug: 'gpfs-deploy', title: 'GPFS ECE 部署与多集群挂载', summary: '网络规划、安装工具包部署 ECE、创建文件系统与远程集群挂载。', minutes: 60 },
      { slug: 'gpfs-day2', title: 'GPFS Day-2：快照、租户与调优', summary: 'Fileset 与配额、快照、扩缩容、关键调优参数与 CSI 对接 Kubernetes。', minutes: 50 },
      { slug: 'ai-storage', title: 'AI 训练存储选型', summary: '训练负载特征与 checkpoint，Weka、VAST、3FS、JuiceFS 等方案对比。', minutes: 50 },
      { slug: 'capacity-planning', title: '容量与性能规划', summary: '从业务需求拆出容量、IOPS、带宽指标，估算节点与盘数，以及何时不该选 Ceph。', minutes: 50 },
      { slug: 'oncall-sre', title: 'On-call、SOP 与故障复盘', summary: '告警分级、SOP 写法、变更管理、复盘模板，以及持续成长路径。', minutes: 35 },
    ],
  },
]

export type LessonRef = Lesson & { stage: Stage; index: number }

export const allLessons: LessonRef[] = stages.flatMap((stage) =>
  stage.lessons.map((lesson) => ({ ...lesson, stage, index: 0 })),
).map((l, index) => ({ ...l, index }))

export function findLesson(slug: string) {
  const i = allLessons.findIndex((l) => l.slug === slug)
  if (i === -1) return undefined
  return { lesson: allLessons[i], prev: allLessons[i - 1], next: allLessons[i + 1] }
}

export const totalMinutes = allLessons.reduce((sum, l) => sum + l.minutes, 0)
