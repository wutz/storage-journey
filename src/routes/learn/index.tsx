import { Link, createFileRoute } from '@tanstack/react-router'
import { allLessons, stages, totalMinutes } from '~/content/curriculum'
import { useProgress } from '~/lib/progress'

export const Route = createFileRoute('/learn/')({
  head: () => ({ meta: [{ title: '学习路线 · Storage Journey' }] }),
  component: Roadmap,
})

function Roadmap() {
  const { isDone, done, reset } = useProgress()
  const finished = allLessons.filter((l) => done.includes(l.slug)).length
  const pct = Math.round((finished / allLessons.length) * 100)
  const nextLesson = allLessons.find((l) => !isDone(l.slug)) ?? allLessons[0]

  return (
    <main className="mx-auto max-w-[960px] px-4 py-16 sm:px-6">
      <p className="eyebrow">Roadmap</p>
      <h1 className="mt-3 text-[40px] font-semibold leading-tight tracking-[-2px]">学习路线</h1>
      <p className="mt-3 max-w-2xl text-body">
        {stages.length} 个阶段、{allLessons.length} 篇课文，约 {Math.round(totalMinutes / 60)}{' '}
        小时。建议按顺序学习；有基础的同学可以直接跳到对应阶段。
      </p>

      <div className="mt-10 rounded-xl border border-hairline bg-elevated p-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="eyebrow">你的进度</p>
            <p className="mt-2 text-2xl font-semibold tracking-[-0.8px]">
              {finished} / {allLessons.length} <span className="text-base font-normal text-mute">课已完成</span>
            </p>
          </div>
          <div className="flex items-center gap-2">
            {finished > 0 && (
              <button
                type="button"
                onClick={() => confirm('确定清空学习进度吗？') && reset()}
                className="h-8 rounded-md border border-hairline bg-elevated px-3 text-sm text-body hover:text-ink"
              >
                重置
              </button>
            )}
            <Link
              to="/learn/$slug"
              params={{ slug: nextLesson.slug }}
              className="inline-flex h-8 items-center rounded-md bg-ink px-3 text-sm font-medium text-white"
            >
              {finished ? '继续学习' : '开始学习'}：{nextLesson.title}
            </Link>
          </div>
        </div>
        <div className="mt-5 h-1.5 overflow-hidden rounded-full bg-hairline-soft">
          <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${pct}%` }} />
        </div>
      </div>

      <ol className="mt-14 space-y-14">
        {stages.map((s) => (
          <li key={s.id} className="grid gap-6 md:grid-cols-[200px_1fr]">
            <div>
              <p className="eyebrow">
                Stage {String(s.index).padStart(2, '0')} · {s.level}
              </p>
              <h2 className="mt-2 text-2xl font-semibold tracking-[-0.8px]">{s.name}</h2>
              <p className="mt-1 text-sm text-mute">{s.tagline}</p>
            </div>
            <div>
              <p className="text-sm leading-6 text-body">
                <span className="font-medium text-ink">阶段目标：</span>
                {s.goal}
              </p>
              <ul className="mt-4 divide-y divide-hairline overflow-hidden rounded-xl border border-hairline bg-elevated">
                {s.lessons.map((l, i) => (
                  <li key={l.slug}>
                    <Link
                      to="/learn/$slug"
                      params={{ slug: l.slug }}
                      className="flex items-start gap-4 px-5 py-4 transition-colors hover:bg-canvas"
                    >
                      <span
                        className={
                          'mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full border font-mono text-[11px] ' +
                          (isDone(l.slug) ? 'border-accent bg-accent text-white' : 'border-hairline text-mute')
                        }
                      >
                        {isDone(l.slug) ? '✓' : `${s.index}.${i + 1}`}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block font-medium text-ink">{l.title}</span>
                        <span className="mt-0.5 block text-sm leading-6 text-body">{l.summary}</span>
                      </span>
                      <span className="shrink-0 font-mono text-xs text-faint">{l.minutes} min</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          </li>
        ))}
      </ol>
    </main>
  )
}
