import { Link } from '@tanstack/react-router'

export function Logo() {
  return (
    <Link to="/" className="flex items-center gap-2 text-ink font-semibold tracking-[-0.3px]">
      <img src="/favicon.svg" alt="" width={24} height={24} />
      <span>Storage Journey</span>
    </Link>
  )
}
