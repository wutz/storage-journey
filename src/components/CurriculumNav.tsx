import { Link } from '@tanstack/react-router'
import { stages } from '~/content/curriculum'
import { useProgress } from '~/lib/progress'

export function CurriculumNav({ current, onNavigate }: { current?: string; onNavigate?: () => void }) {
  const { isDone } = useProgress()
  return (
    <nav className="space-y-6 text-sm">
      {stages.map((stage) => (
        <div key={stage.id}>
          <p className="eyebrow mb-2 px-2">
            {String(stage.index).padStart(2, '0')} · {stage.name}
          </p>
          <ul className="space-y-0.5">
            {stage.lessons.map((l) => {
              const active = l.slug === current
              return (
                <li key={l.slug}>
                  <Link
                    to="/learn/$slug"
                    params={{ slug: l.slug }}
                    onClick={onNavigate}
                    className={
                      'flex items-center gap-2 rounded-md px-2 py-1.5 leading-5 transition-colors ' +
                      (active
                        ? 'bg-accent-soft text-accent-deep font-medium'
                        : 'text-body hover:bg-hairline-soft hover:text-ink')
                    }
                  >
                    <span
                      aria-hidden
                      className={
                        'flex size-3.5 shrink-0 items-center justify-center rounded-full border text-[9px] ' +
                        (isDone(l.slug) ? 'border-accent bg-accent text-white' : 'border-[#d4d4d4]')
                      }
                    >
                      {isDone(l.slug) ? '✓' : ''}
                    </span>
                    <span>{l.title}</span>
                  </Link>
                </li>
              )
            })}
          </ul>
        </div>
      ))}
    </nav>
  )
}
