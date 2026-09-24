# Storage Journey

面向新手、从零到专业的存储中文学习路线。6 个阶段、38 课，从认识一块硬盘讲起，经过文件系统、I/O 性能分析与 BPF 观测，一路走到 Ceph 生产运维、GPFS 与 AI 训练存储。

| 阶段 | 主题 | 目标 |
|---|---|---|
| 00 启程 | 存储全景、实验环境、Linux I/O 栈 | 看清一次 write() 会经过哪些层 |
| 01 入门 | 硬件、块设备与 LVM、RAID、文件系统、页缓存、块/文件/对象 | 独立完成单机存储的上盘到挂载 |
| 02 进阶 | 性能指标、方法论、磁盘与文件系统观测、BPF、fio、调优 | 会测、会看、会调 |
| 03 原理 | 网络存储、分布式基础、副本与 EC、对象存储、分布式文件系统、Ceph 架构 | 解释数据如何分布、冗余与恢复 |
| 04 生产 | cephadm、RBD/CephFS、RGW、Day-2、故障排查、CSI、Rook、监控 | 部署并长期运维生产 Ceph 与 K8s 存储 |
| 05 专家 | RDMA、GPFS / Storage Scale、AI 训练存储、容量规划、On-call | 为 GPU / AI 集群设计高性能存储 |

站点还提供一个[容量与性能计算器](/calculator)：输入副本或纠删码、节点与盘的配置，估算可用容量、N-1 故障冗余、重建数据量和理论性能上限。

## 参考资料

- Brendan Gregg，《Systems Performance: Enterprise and the Cloud, 2nd Edition》
- 一线 GPU / AI 集群的存储部署实践（cephadm、Rook-Ceph、GPFS ECE、Weka、VAST、JuiceFS、3FS 等）
- 课程结构借鉴了 [StorPath](https://storpath.wutz.dev/)

## 技术栈

- [TanStack Start](https://tanstack.com/start)（React 19 + TanStack Router），全部页面构建时预渲染
- Tailwind CSS v4，设计规范见 [DESIGN.md](./DESIGN.md)（Geist 体系 + Storage Teal `#0f766e`）
- 课文为 Markdown，服务端用 `marked` + `highlight.js` 渲染
- 部署到 Cloudflare Workers（`@cloudflare/vite-plugin`）

## 本地开发

```bash
pnpm install
pnpm dev          # http://localhost:3000
pnpm typecheck
pnpm build        # 产物在 dist/
pnpm preview      # 用 workerd 本地预览构建产物
```

## 部署

```bash
pnpm wrangler login
pnpm run deploy
```

`wrangler.jsonc` 已开启 `workers_dev` 与 `preview_urls`，部署后可通过 `*.workers.dev` 访问，每个版本也有独立预览地址。

## 写课文

- 大纲与元数据：`src/content/curriculum.ts`
- 正文：`src/content/lessons/<stage-id>/<slug>.md`
- 写作规范、提示框语法与内容来源要求见 [CONTENT_GUIDE.md](./CONTENT_GUIDE.md)

## 说明

Ceph® 是 Linux Foundation 的注册商标，IBM Storage Scale 是 IBM 的商标。本项目为社区学习资料，与上述组织无隶属关系。
