import { Link } from '@tanstack/react-router'
import { Logo } from './Logo'

const navLink =
  'rounded-full px-3 py-1.5 text-sm text-body hover:text-ink hover:bg-hairline-soft transition-colors'

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-40 border-b border-hairline bg-canvas/85 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-[1400px] items-center justify-between px-4 sm:px-6">
        <div className="flex items-center gap-6">
          <Logo />
          <nav className="hidden items-center gap-1 sm:flex">
            <Link to="/learn" className={navLink} activeProps={{ className: 'text-ink' }}>
              学习路线
            </Link>
            <Link to="/calculator" className={navLink} activeProps={{ className: 'text-ink' }}>
              容量计算器
            </Link>
            <a href="https://docs.ceph.com/en/latest/" target="_blank" rel="noreferrer" className={navLink}>
              Ceph 文档
            </a>
          </nav>
        </div>
        <Link
          to="/learn/$slug"
          params={{ slug: 'welcome' }}
          className="inline-flex h-8 items-center rounded-md bg-ink px-3 text-sm font-medium text-white hover:bg-[#383838] transition-colors"
        >
          开始学习
        </Link>
      </div>
    </header>
  )
}
