import { useEffect, useState } from 'react'
import type { TocItem } from '~/lib/markdown.server'

export function Toc({ items }: { items: TocItem[] }) {
  const [active, setActive] = useState<string>()

  useEffect(() => {
    const els = items.map((i) => document.getElementById(i.id)).filter((e): e is HTMLElement => !!e)
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((e) => e.isIntersecting)
        if (visible.length) setActive(visible[0].target.id)
      },
      { rootMargin: '-80px 0px -70% 0px' },
    )
    els.forEach((e) => observer.observe(e))
    return () => observer.disconnect()
  }, [items])

  if (!items.length) return null
  return (
    <div className="text-sm">
      <p className="eyebrow mb-3">本课大纲</p>
      <ul className="space-y-1.5 border-l border-hairline">
        {items.map((i) => (
          <li key={i.id}>
            <a
              href={`#${i.id}`}
              className={
                '-ml-px block border-l py-0.5 leading-5 transition-colors ' +
                (i.depth === 3 ? 'pl-6 ' : 'pl-3 ') +
                (active === i.id ? 'border-accent text-ink' : 'border-transparent text-mute hover:text-ink')
              }
            >
              {i.text}
            </a>
          </li>
        ))}
      </ul>
    </div>
  )
}
