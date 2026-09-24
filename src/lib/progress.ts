import { useSyncExternalStore } from 'react'

// 学习进度只存在浏览器 localStorage 里，不需要账号
const KEY = 'storage-journey:done'
const listeners = new Set<() => void>()
let snapshot: string[] | null = null

function read(): string[] {
  if (snapshot) return snapshot
  try {
    snapshot = JSON.parse(localStorage.getItem(KEY) ?? '[]')
  } catch {
    snapshot = []
  }
  return snapshot!
}

function write(next: string[]) {
  snapshot = next
  localStorage.setItem(KEY, JSON.stringify(next))
  listeners.forEach((l) => l())
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  const onStorage = (e: StorageEvent) => {
    if (e.key === KEY) {
      snapshot = null
      listener()
    }
  }
  window.addEventListener('storage', onStorage)
  return () => {
    listeners.delete(listener)
    window.removeEventListener('storage', onStorage)
  }
}

const EMPTY: string[] = []

export function useProgress() {
  const done = useSyncExternalStore(subscribe, read, () => EMPTY)
  return {
    done,
    isDone: (slug: string) => done.includes(slug),
    toggle: (slug: string) =>
      write(done.includes(slug) ? done.filter((s) => s !== slug) : [...done, slug]),
    reset: () => write([]),
  }
}
