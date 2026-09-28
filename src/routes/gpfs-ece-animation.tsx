import { Link, createFileRoute } from '@tanstack/react-router'
import { findLesson } from '~/content/curriculum'

export const Route = createFileRoute('/gpfs-ece-animation')({
  head: () => ({
    meta: [
      { title: 'GPFS ECE 混闪方案设计 · 动画讲解 · Storage Journey' },
      {
        name: 'description',
        content:
          '约 6 分钟、带中文旁白的动画：一个 5 节点 HDD+NVMe 的 GPFS ECE 集群，从 512 vdisk 预算、8+2p 与 spare、元数据 5%、合并池与切片，到多租户 QoS、inode 与 ILM 泄洪策略。',
      },
      { property: 'og:title', content: 'GPFS ECE 混闪方案设计 · 动画讲解' },
    ],
  }),
  component: GpfsEceAnimation,
})

// 与 public/animation/gpfs-ece.html 中各场景的起始时间一致（旁白按实测时长伸缩后的时间）
const chapters: { time: string; stage: string; title: string }[] = [
  { time: '0:00', stage: '片头', title: 'GPFS ECE 混闪方案设计' },
  { time: '0:11', stage: '01 场景', title: '为什么混闪：一个命名空间，NVMe 与 HDD 两层存储池' },
  { time: '0:45', stage: '02 积木', title: '恢复组、DA 与日志组；每个 RG 最多 512 个 vdisk' },
  { time: '1:20', stage: '03 冗余', title: '以实测裸容量为准、8+2p vs 8+3p、每节点 strip 数、spare 2N' },
  { time: '2:09', stage: '04 元数据', title: '按 HDD 可用的 5% 规划，副本放不下，8+2p 的代价' },
  { time: '2:48', stage: '05 池布局', title: '合并 Meta 与 Cache 池（419 vs 507），按 11 节点定 48 + 400 TiB 切片' },
  { time: '3:34', stage: '06 多租户', title: '多文件系统隔离元数据、QoS 管共享 HDD、mmapi 管权限' },
  { time: '4:20', stage: '07 容量', title: 'df 448 TiB vs 可交付 400 TiB，inode 是第二个天花板' },
  { time: '4:57', stage: '08 ILM', title: 'LIMIT 80 放置、THRESHOLD(75,55) 回调泄洪、元数据稳态、降级与回迁' },
  { time: '5:49', stage: '终章', title: '八个决策，环环相扣' },
]

const related = ['gpfs-ece-hybrid', 'gpfs-concepts', 'gpfs-deploy', 'gpfs-day2']

function GpfsEceAnimation() {
  return (
    <main className="mx-auto max-w-[1200px] px-4 py-16 sm:px-6">
      <p className="eyebrow">Animation · Stage 05</p>
      <h1 className="mt-3 text-[40px] font-semibold leading-tight tracking-[-2px]">GPFS ECE 混闪方案设计 · 动画讲解</h1>
      <p className="mt-3 max-w-2xl text-body">
        约 6 分钟，把课程《GPFS ECE 混闪方案设计》的推导按顺序走一遍：每一步只依赖前面算出的结果，每个数字都能在画面里看到来由。含中文旁白、字幕、背景音乐与音效。
      </p>

      <div className="mt-10 overflow-hidden rounded-2xl border border-hairline bg-[#05070c] shadow-[var(--shadow-float)]">
        <iframe
          src="/animation/gpfs-ece.html"
          title="GPFS ECE 混闪方案设计 动画讲解"
          allow="autoplay; fullscreen"
          allowFullScreen
          className="block aspect-video w-full"
        />
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-sm text-mute">
        <span>空格键播放/暂停，← → 快退/快进 5 秒，V 开关旁白；控制栏里还能导出视频文件。</span>
        <a href="/animation/gpfs-ece.html" target="_blank" rel="noreferrer" className="text-accent hover:text-accent-deep">
          在新窗口中观看 ↗
        </a>
      </div>

      <h2 className="mt-20 text-[32px] font-semibold leading-10 tracking-[-1.28px]">章节</h2>
      <p className="mt-3 text-body">每一段对应课文里的一节，完整的表格、命令和策略文件都在课文中。</p>
      <ol className="mt-8 divide-y divide-hairline rounded-xl border border-hairline bg-elevated">
        {chapters.map((c) => (
          <li key={c.time} className="grid gap-3 p-5 sm:grid-cols-[72px_96px_1fr] sm:items-baseline">
            <span className="font-mono text-sm text-accent">{c.time}</span>
            <span className="text-sm font-medium text-ink">{c.stage}</span>
            <p className="min-w-0 text-body">{c.title}</p>
          </li>
        ))}
      </ol>

      <h2 className="mt-20 text-[32px] font-semibold leading-10 tracking-[-1.28px]">相关课文</h2>
      <div className="mt-6 flex flex-wrap gap-2">
        {related.map((slug) => (
          <Link
            key={slug}
            to="/learn/$slug"
            params={{ slug }}
            className="rounded-full border border-hairline px-4 py-1.5 text-sm text-body hover:border-accent hover:text-accent transition-colors"
          >
            {findLesson(slug)?.lesson.title ?? slug}
          </Link>
        ))}
      </div>
    </main>
  )
}
