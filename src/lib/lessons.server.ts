import { renderMarkdown } from './markdown.server'

const files = import.meta.glob<string>('../content/lessons/**/*.md', {
  query: '?raw',
  import: 'default',
  eager: true,
})

const bySlug = new Map<string, string>()
for (const [path, raw] of Object.entries(files)) {
  const slug = path.split('/').pop()!.replace(/\.md$/, '')
  bySlug.set(slug, raw)
}

const cache = new Map<string, ReturnType<typeof renderMarkdown>>()

export function loadLessonContent(slug: string) {
  const raw = bySlug.get(slug)
  if (!raw) return null
  let rendered = cache.get(slug)
  if (!rendered) {
    // 正文第一行的一级标题由页面头部渲染，这里去掉避免重复
    rendered = renderMarkdown(raw.replace(/^#\s+.*\n+/, ''))
    cache.set(slug, rendered)
  }
  return rendered
}
