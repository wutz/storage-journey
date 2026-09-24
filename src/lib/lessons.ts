import { createServerFn } from '@tanstack/react-start'
import { notFound } from '@tanstack/react-router'

export const getLessonContent = createServerFn({ method: 'GET' })
  .validator((slug: string) => slug)
  .handler(async ({ data: slug }) => {
    const { loadLessonContent } = await import('./lessons.server')
    const content = loadLessonContent(slug)
    if (!content) throw notFound()
    return content
  })
