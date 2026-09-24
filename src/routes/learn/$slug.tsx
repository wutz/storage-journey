import { useEffect, useRef, useState } from 'react'
import { Link, createFileRoute, notFound } from '@tanstack/react-router'
import { allLessons, findLesson } from '~/content/curriculum'
import { getLessonContent } from '~/lib/lessons'
import { useProgress } from '~/lib/progress'
import { CurriculumNav } from '~/components/CurriculumNav'
import { Toc } from '~/components/Toc'

export const Route = createFileRoute('/learn/$slug')({
  loader: async ({ params }) => {
    const found = findLesson(params.slug)
    if (!found) throw notFound()
    const content = await getLessonContent({ data: params.slug })
    return { slug: params.slug, content }
  },
  head: ({ loaderData }) => {
    const found = loaderData && findLesson(loaderData.slug)
    if (!found) return {}
    return {
      meta: [
        { title: `${found.lesson.title} · Storage Journey` },
        { name: 'description', content: found.lesson.summary },
      ],
    }
  },
  component: LessonPage,
})

function LessonPage() {
  const { slug, content } = Route.useLoaderData()
  const { lesson, prev, next } = findLesson(slug)!
  const { isDone, toggle } = useProgress()
  const [drawer, setDrawer] = useState(false)
  const articleRef = useRef<HTMLElement>(null)
  const done = isDone(slug)
  const stagePos = lesson.stage.lessons.findIndex((l) => l.slug === slug) + 1

  // 代码块"复制"按钮：正文是服务端渲染的 HTML，用事件委托处理
  useEffect(() => {
    const el = articleRef.current
    if (!el) return
    const onClick = async (e: MouseEvent) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-copy]')
      if (!btn) return
      const code = btn.closest('.code-block')?.querySelector('code')?.textContent ?? ''
      await navigator.clipboard.writeText(code)
      btn.textContent = '已复制'
      setTimeout(() => (btn.textContent = '复制'), 1500)
    }
    el.addEventListener('click', onClick)
    return () => el.removeEventListener('click', onClick)
  }, [])

  return (
    <div className="mx-auto flex max-w-[1400px] gap-10 px-4 sm:px-6">
      <aside className="sticky top-14 hidden h-[calc(100vh-3.5rem)] w-64 shrink-0 overflow-y-auto border-r border-hairline py-8 pr-4 lg:block">
        <CurriculumNav current={slug} />
      </aside>

      <main className="min-w-0 flex-1 py-10 lg:py-14">
        <button
          type="button"
          onClick={() => setDrawer(true)}
          className="mb-6 inline-flex h-8 items-center gap-2 rounded-md border border-hairline bg-elevated px-3 text-sm text-body lg:hidden"
        >
          ☰ 课程目录
        </button>

        <header className="max-w-[72ch]">
          <p className="eyebrow">
            Stage {String(lesson.stage.index).padStart(2, '0')} · {lesson.stage.name} · 第 {stagePos} /{' '}
            {lesson.stage.lessons.length} 课
          </p>
          <h1 className="mt-3 text-[32px] font-semibold leading-10 tracking-[-1.28px] text-ink sm:text-[40px] sm:leading-[48px] sm:tracking-[-1.8px]">
            {lesson.title}
          </h1>
          <p className="mt-4 text-lg leading-8 text-body">{lesson.summary}</p>
          <div className="mt-5 flex items-center gap-4 font-mono text-xs text-mute">
            <span>约 {lesson.minutes} 分钟</span>
            <span className="text-hairline">|</span>
            <span>
              全程第 {lesson.index + 1} / {allLessons.length} 课
            </span>
          </div>
        </header>

        <article
          ref={articleRef}
          className="prose-lesson mt-10"
          dangerouslySetInnerHTML={{ __html: content.html }}
        />

        <div className="mt-16 max-w-[72ch] space-y-6">
          <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-hairline bg-elevated p-5">
            <div>
              <p className="font-medium text-ink">{done ? '这一课已完成 🎉' : '学完了吗？'}</p>
              <p className="mt-0.5 text-sm text-mute">进度保存在本机浏览器中，可在学习路线页查看。</p>
            </div>
            <button
              type="button"
              onClick={() => toggle(slug)}
              className={
                'h-9 rounded-md px-4 text-sm font-medium transition-colors ' +
                (done
                  ? 'border border-hairline bg-elevated text-body hover:text-ink'
                  : 'bg-accent text-white hover:bg-accent-deep')
              }
            >
              {done ? '标记为未完成' : '标记为已完成'}
            </button>
          </div>

          <nav className="grid gap-3 sm:grid-cols-2">
            {prev ? (
              <Link
                to="/learn/$slug"
                params={{ slug: prev.slug }}
                className="rounded-xl border border-hairline bg-elevated p-4 hover:shadow-[var(--shadow-float)] transition-shadow"
              >
                <span className="eyebrow">← 上一课</span>
                <span className="mt-1 block font-medium text-ink">{prev.title}</span>
              </Link>
            ) : (
              <span />
            )}
            {next && (
              <Link
                to="/learn/$slug"
                params={{ slug: next.slug }}
                className="rounded-xl border border-hairline bg-elevated p-4 text-right hover:shadow-[var(--shadow-float)] transition-shadow"
              >
                <span className="eyebrow">下一课 →</span>
                <span className="mt-1 block font-medium text-ink">{next.title}</span>
              </Link>
            )}
          </nav>
        </div>
      </main>

      <aside className="sticky top-14 hidden h-[calc(100vh-3.5rem)] w-56 shrink-0 overflow-y-auto py-14 xl:block">
        <Toc items={content.toc} />
      </aside>

      {drawer && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <button
            type="button"
            aria-label="关闭目录"
            className="absolute inset-0 bg-black/20"
            onClick={() => setDrawer(false)}
          />
          <div className="absolute inset-y-0 left-0 w-[300px] overflow-y-auto border-r border-hairline bg-canvas p-5 shadow-[var(--shadow-float)]">
            <CurriculumNav current={slug} onNavigate={() => setDrawer(false)} />
          </div>
        </div>
      )}
    </div>
  )
}
