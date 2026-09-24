import { Link } from '@tanstack/react-router'

export function NotFound() {
  return (
    <div className="mx-auto flex max-w-xl flex-col items-center px-6 py-32 text-center">
      <p className="eyebrow">404 · ENOENT</p>
      <h1 className="mt-4 text-3xl font-semibold tracking-[-1.2px]">这个对象不在任何一个 PG 里</h1>
      <p className="mt-3 text-body">open() 返回了 No such file or directory：链接可能写错了，或者课程已经调整。</p>
      <Link
        to="/learn"
        className="mt-8 inline-flex h-10 items-center rounded-full bg-ink px-5 font-medium text-white"
      >
        回到学习路线
      </Link>
    </div>
  )
}
