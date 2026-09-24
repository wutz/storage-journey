import { Link, createFileRoute } from '@tanstack/react-router'
import { findLesson } from '~/content/curriculum'

export const Route = createFileRoute('/animation')({
  head: () => ({
    meta: [
      { title: '4 分钟动画速览 · Storage Journey' },
      {
        name: 'description',
        content: '用一段约 4 分钟、带中文旁白的动画，走完从第一块磁盘到生产级存储集群的整条学习路线。',
      },
      { property: 'og:title', content: 'Storage Journey · 4 分钟动画速览' },
      { property: 'og:image', content: '/animation/poster.jpg' },
    ],
  }),
  component: Animation,
})

// 与 public/animation/player.html 中各场景的起始时间一致
const chapters: { time: string; stage: string; title: string; lessons: string[] }[] = [
  { time: '0:00', stage: '片头', title: '从第一块磁盘，到生产级存储集群', lessons: [] },
  { time: '0:10', stage: '00 启程', title: '延迟金字塔、实验环境与 I/O 栈地图', lessons: ['storage-landscape', 'lab-environment', 'io-stack'] },
  { time: '0:40', stage: '01 入门', title: '磁盘、LVM、RAID、页缓存与三种接口', lessons: ['storage-hardware', 'block-devices', 'raid', 'page-cache', 'block-file-object'] },
  { time: '1:17', stage: '02 进阶', title: '指标与尾延迟、USE 方法、BPF 与 fio 基线', lessons: ['perf-metrics', 'methodology', 'bpf-io-tracing', 'benchmarking'] },
  { time: '1:48', stage: '03 原理', title: '网络存储、CRUSH、副本与纠删码、Ceph 架构', lessons: ['network-storage', 'distributed-basics', 'replication-ec', 'ceph-architecture'] },
  { time: '2:21', stage: '04 生产', title: 'cephadm 部署、RBD/CephFS/RGW、CSI 与故障自愈', lessons: ['cephadm-deploy', 'ceph-rbd-cephfs', 'rook-ceph', 'ceph-troubleshooting', 'storage-monitoring'] },
  { time: '3:01', stage: '05 专家', title: 'RDMA、GPFS 多集群、AI 训练存储与容量规划', lessons: ['rdma', 'gpfs-concepts', 'ai-storage', 'capacity-planning', 'oncall-sre'] },
  { time: '3:33', stage: '终章', title: '六个阶段，现在就启程', lessons: ['welcome'] },
]

function Animation() {
  return (
    <main className="mx-auto max-w-[1200px] px-4 py-16 sm:px-6">
      <p className="eyebrow">Animation</p>
      <h1 className="mt-3 text-[40px] font-semibold leading-tight tracking-[-2px]">4 分钟动画速览</h1>
      <p className="mt-3 max-w-2xl text-body">
        跟着中文旁白，把整门课的主线快速走一遍：从一次 write() 穿过 I/O 栈，到 Ceph 集群凌晨三点的自愈，再到 AI 训练的
        checkpoint 洪峰。含背景音乐与音效，建议佩戴耳机。
      </p>

      <div className="mt-10 overflow-hidden rounded-2xl border border-hairline bg-[#05070c] shadow-[var(--shadow-float)]">
        <iframe
          src="/animation/player.html"
          title="Storage Journey 动画速览"
          allow="autoplay; fullscreen"
          allowFullScreen
          className="block aspect-video w-full"
        />
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-sm text-mute">
        <span>空格键播放/暂停，← → 快退/快进 5 秒；控制栏里还能导出视频文件。</span>
        <a href="/animation/player.html" target="_blank" rel="noreferrer" className="text-accent hover:text-accent-deep">
          在新窗口中观看 ↗
        </a>
      </div>

      <h2 className="mt-20 text-[32px] font-semibold leading-10 tracking-[-1.28px]">章节</h2>
      <p className="mt-3 text-body">每一段都对应课程里的具体课文，看完动画可以直接跳进去深入学习。</p>
      <ol className="mt-8 divide-y divide-hairline rounded-xl border border-hairline bg-elevated">
        {chapters.map((c) => (
          <li key={c.time} className="grid gap-3 p-5 sm:grid-cols-[72px_96px_1fr] sm:items-baseline">
            <span className="font-mono text-sm text-accent">{c.time}</span>
            <span className="text-sm font-medium text-ink">{c.stage}</span>
            <div className="min-w-0">
              <p className="text-body">{c.title}</p>
              {c.lessons.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-2">
                  {c.lessons.map((slug) => (
                    <Link
                      key={slug}
                      to="/learn/$slug"
                      params={{ slug }}
                      className="rounded-full border border-hairline px-3 py-1 text-xs text-body hover:border-accent hover:text-accent transition-colors"
                    >
                      {findLesson(slug)?.lesson.title ?? slug}
                    </Link>
                  ))}
                </div>
              )}
            </div>
          </li>
        ))}
      </ol>
    </main>
  )
}
