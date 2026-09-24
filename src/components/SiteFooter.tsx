import { Link } from '@tanstack/react-router'
import { stages } from '~/content/curriculum'
import { Logo } from './Logo'

export function SiteFooter() {
  return (
    <footer className="border-t border-hairline bg-canvas">
      <div className="mx-auto grid max-w-[1400px] gap-10 px-4 py-14 sm:px-6 md:grid-cols-[1.4fr_2fr]">
        <div className="space-y-3">
          <Logo />
          <p className="max-w-sm text-sm leading-6 text-mute">
            从认识一块硬盘到扛起一整套存储集群，一条循序渐进的存储学习路线。内容参考《Systems
            Performance》与一线生产实践。
          </p>
        </div>
        <div className="grid grid-cols-2 gap-6 sm:grid-cols-3">
          {stages.map((s) => (
            <div key={s.id} className="space-y-2">
              <p className="eyebrow">Stage {String(s.index).padStart(2, '0')}</p>
              <Link
                to="/learn/$slug"
                params={{ slug: s.lessons[0].slug }}
                className="block text-sm text-body hover:text-ink"
              >
                {s.name} · {s.tagline}
              </Link>
            </div>
          ))}
        </div>
      </div>
      <div className="border-t border-hairline">
        <p className="mx-auto max-w-[1400px] px-4 py-5 text-xs text-faint sm:px-6">
          Ceph® 是 Linux Foundation 的注册商标，IBM Storage Scale 是 IBM 的商标，文中提及的其他产品名称归各自所有者。本站为独立学习资料。
        </p>
      </div>
    </footer>
  )
}
