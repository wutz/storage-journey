import { Link, createFileRoute } from '@tanstack/react-router'
import { useState, type ReactNode } from 'react'

export const Route = createFileRoute('/calculator')({
  head: () => ({
    meta: [
      { title: '容量与性能计算器 · Storage Journey' },
      {
        name: 'description',
        content: '估算 Ceph 等分布式存储集群在多副本或纠删码下的可用容量、故障冗余与理论性能上限。',
      },
    ],
  }),
  component: Calculator,
})

type Scheme = 'replica' | 'ec'
type Media = 'hdd' | 'sata' | 'nvme'

type Config = {
  scheme: Scheme
  size: number
  k: number
  m: number
  nodes: number
  disks: number
  diskTB: number
  media: Media
  diskIops: number
  diskMBps: number
  nicGbps: number
  fill: number
  nMinus1: boolean
}

// 单 OSD 的经验值，而不是裸盘规格：Ceph 的软件栈会吃掉很大一部分 NVMe 的原始性能
const mediaPresets: Record<Media, { label: string; iops: number; mbps: number }> = {
  hdd: { label: 'HDD 7.2K', iops: 150, mbps: 180 },
  sata: { label: 'SATA SSD', iops: 20000, mbps: 450 },
  nvme: { label: 'NVMe SSD', iops: 50000, mbps: 2000 },
}

const presets: { name: string; desc: string; config: Config }[] = [
  {
    name: '入门三节点',
    desc: '3 节点 · NVMe · 3 副本',
    config: {
      scheme: 'replica', size: 3, k: 4, m: 2, nodes: 3, disks: 4, diskTB: 3.84, media: 'nvme',
      diskIops: 50000, diskMBps: 2000, nicGbps: 25, fill: 0.8, nMinus1: false,
    },
  },
  {
    name: '大容量归档',
    desc: '12 节点 · HDD · EC 8+3',
    config: {
      scheme: 'ec', size: 3, k: 8, m: 3, nodes: 12, disks: 24, diskTB: 20, media: 'hdd',
      diskIops: 150, diskMBps: 180, nicGbps: 50, fill: 0.8, nMinus1: true,
    },
  },
  {
    name: 'AI 训练热层',
    desc: '8 节点 · NVMe · EC 4+2',
    config: {
      scheme: 'ec', size: 3, k: 4, m: 2, nodes: 8, disks: 10, diskTB: 15.36, media: 'nvme',
      diskIops: 50000, diskMBps: 2000, nicGbps: 200, fill: 0.8, nMinus1: true,
    },
  },
]

const TIB_PER_TB = 1e12 / 2 ** 40

function nextPow2(n: number) {
  return 2 ** Math.max(0, Math.round(Math.log2(Math.max(1, n))))
}

function fmtCap(tb: number) {
  if (tb >= 1000) return { v: (tb / 1000).toFixed(2), u: 'PB' }
  return { v: tb >= 100 ? tb.toFixed(0) : tb.toFixed(1), u: 'TB' }
}

function fmtNum(n: number) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e5 ? 0 : 1)}k`
  return n.toFixed(0)
}

function fmtBw(mbps: number) {
  return mbps >= 1000 ? `${(mbps / 1000).toFixed(1)} GB/s` : `${mbps.toFixed(0)} MB/s`
}

function compute(c: Config) {
  const width = c.scheme === 'replica' ? c.size : c.k + c.m
  const efficiency = c.scheme === 'replica' ? 1 / c.size : c.k / (c.k + c.m)
  const tolerate = c.scheme === 'replica' ? c.size - 1 : c.m
  const osds = c.nodes * c.disks

  const raw = osds * c.diskTB
  const protectedCap = raw * efficiency
  const headroom = c.nMinus1 && c.nodes > 1 ? (c.nodes - 1) / c.nodes : 1
  const afterHeadroom = protectedCap * headroom
  const usable = afterHeadroom * c.fill

  // 写放大：落到盘上的字节 / 客户端写入的字节
  const byteAmp = c.scheme === 'replica' ? c.size : (c.k + c.m) / c.k
  // 小块随机写每次要更新所有分片（EC 还有读改写，实际更差）
  const opAmp = width

  const diskReadBw = osds * c.diskMBps
  const netBw = (c.nodes * c.nicGbps * 1000) / 8
  const readBw = Math.min(diskReadBw, netBw)
  const writeBw = Math.min(diskReadBw / byteAmp, netBw / byteAmp)
  const readIops = osds * c.diskIops
  const writeIops = readIops / opAmp

  const warnings: string[] = []
  if (c.nodes < width) {
    warnings.push(`以主机为故障域时，${c.scheme === 'replica' ? `${c.size} 副本` : `EC ${c.k}+${c.m}`} 至少需要 ${width} 个节点，当前只有 ${c.nodes} 个。`)
  } else if (c.scheme === 'ec' && c.nodes === width) {
    warnings.push('节点数恰好等于 k+m：坏一台主机后没有地方重建分片，集群会长期处于降级状态。建议至少 k+m+1 个节点。')
  }
  if (c.scheme === 'replica' && c.size < 3) warnings.push('2 副本在一块盘故障、另一块盘出现坏块时就会丢数据，生产环境不建议。')
  if (c.scheme === 'ec' && c.m < 2) warnings.push('m=1 在重建期间没有任何冗余，生产环境建议 m ≥ 2。')
  if (c.fill > 0.85) warnings.push('规划水位超过 Ceph 默认 nearfull（85%），扩容窗口会非常紧张。')
  if (readBw === netBw && netBw < diskReadBw) warnings.push('网络先于磁盘成为带宽瓶颈，考虑升级网卡或分离集群网络。')

  return {
    width, efficiency, tolerate, osds, raw, protectedCap, afterHeadroom, usable, byteAmp, opAmp,
    readBw, writeBw, readIops, writeIops, netLimited: netBw < diskReadBw,
    diskData: c.diskTB * c.fill,
    nodeData: c.disks * c.diskTB * c.fill,
    pgs: nextPow2((osds * 100) / width),
    warnings,
  }
}

function Calculator() {
  const [c, setC] = useState<Config>(presets[0].config)
  const set = <K extends keyof Config>(key: K, value: Config[K]) => setC((prev) => ({ ...prev, [key]: value }))
  const r = compute(c)
  const usable = fmtCap(r.usable)

  const waterfall = [
    { label: '裸容量', value: r.raw, note: `${r.osds} 块盘 × ${c.diskTB} TB` },
    {
      label: c.scheme === 'replica' ? `${c.size} 副本后` : `EC ${c.k}+${c.m} 后`,
      value: r.protectedCap,
      note: `效率 ${(r.efficiency * 100).toFixed(0)}%`,
    },
    ...(c.nMinus1 ? [{ label: '预留 N-1 后', value: r.afterHeadroom, note: '坏一台节点仍能自愈' }] : []),
    { label: '可用容量', value: r.usable, note: `水位 ${(c.fill * 100).toFixed(0)}%` },
  ]

  return (
    <main className="mx-auto max-w-[1200px] px-4 py-16 sm:px-6">
      <p className="eyebrow">Calculator</p>
      <h1 className="mt-3 text-[40px] font-semibold leading-tight tracking-[-2px]">容量与性能计算器</h1>
      <p className="mt-3 max-w-2xl text-body">
        调整冗余方式、节点与盘的配置，看看一套集群最后真正能用多少、理论上能跑多快。原理见{' '}
        <Link to="/learn/$slug" params={{ slug: 'replication-ec' }} className="text-accent hover:text-accent-deep">
          副本与纠删码
        </Link>{' '}
        和{' '}
        <Link to="/learn/$slug" params={{ slug: 'capacity-planning' }} className="text-accent hover:text-accent-deep">
          容量与性能规划
        </Link>
        。
      </p>

      <div className="mt-8 flex flex-wrap gap-2">
        {presets.map((p) => (
          <button
            key={p.name}
            type="button"
            onClick={() => setC(p.config)}
            className="rounded-full border border-hairline bg-elevated px-4 py-2 text-left text-sm transition-colors hover:border-accent"
          >
            <span className="font-medium text-ink">{p.name}</span>
            <span className="ml-2 text-mute">{p.desc}</span>
          </button>
        ))}
      </div>

      <div className="mt-6 grid items-start gap-6 lg:grid-cols-[5fr_7fr]">
        {/* Inputs */}
        <div className="space-y-6 rounded-xl border border-hairline bg-elevated p-6">
          <Field label="冗余方式">
            <Segmented
              value={c.scheme}
              options={[
                ['replica', '多副本'],
                ['ec', '纠删码 EC'],
              ]}
              onChange={(v) => set('scheme', v)}
            />
          </Field>

          {c.scheme === 'replica' ? (
            <Field label="副本数 size">
              <Segmented
                value={String(c.size)}
                options={[
                  ['2', '2'],
                  ['3', '3'],
                  ['4', '4'],
                ]}
                onChange={(v) => set('size', Number(v))}
              />
            </Field>
          ) : (
            <div className="grid grid-cols-2 gap-4">
              <NumberField label="数据块 k" value={c.k} min={2} max={16} onChange={(v) => set('k', v)} />
              <NumberField label="校验块 m" value={c.m} min={1} max={6} onChange={(v) => set('m', v)} />
            </div>
          )}

          <div className="grid grid-cols-2 gap-4">
            <NumberField label="节点数" value={c.nodes} min={1} max={500} onChange={(v) => set('nodes', v)} />
            <NumberField label="每节点盘数" value={c.disks} min={1} max={60} onChange={(v) => set('disks', v)} />
            <NumberField label="单盘容量 (TB)" value={c.diskTB} min={0.1} max={100} step={0.01} onChange={(v) => set('diskTB', v)} />
            <NumberField label="每节点网络 (Gbps)" value={c.nicGbps} min={1} max={1600} onChange={(v) => set('nicGbps', v)} />
          </div>

          <Field label="介质">
            <Segmented
              value={c.media}
              options={(Object.keys(mediaPresets) as Media[]).map((k) => [k, mediaPresets[k].label])}
              onChange={(v) =>
                setC((prev) => ({ ...prev, media: v, diskIops: mediaPresets[v].iops, diskMBps: mediaPresets[v].mbps }))
              }
            />
          </Field>

          <div className="grid grid-cols-2 gap-4">
            <NumberField label="单 OSD IOPS" value={c.diskIops} min={50} max={1000000} onChange={(v) => set('diskIops', v)} />
            <NumberField label="单 OSD 带宽 (MB/s)" value={c.diskMBps} min={50} max={20000} onChange={(v) => set('diskMBps', v)} />
          </div>

          <Field label={`规划水位：${(c.fill * 100).toFixed(0)}%`}>
            <input
              type="range"
              min={0.5}
              max={0.95}
              step={0.01}
              value={c.fill}
              onChange={(e) => set('fill', Number(e.target.value))}
              className="w-full accent-[var(--color-accent)]"
            />
            <p className="mt-1 text-xs text-mute">Ceph 默认 nearfull 85%、full 95%，建议按 75%～80% 规划。</p>
          </Field>

          <label className="flex cursor-pointer items-start gap-3">
            <input
              type="checkbox"
              checked={c.nMinus1}
              onChange={(e) => set('nMinus1', e.target.checked)}
              className="mt-1 size-4 accent-[var(--color-accent)]"
            />
            <span>
              <span className="text-sm font-medium text-ink">预留一台节点故障的空间（N-1）</span>
              <span className="block text-xs text-mute">坏掉一台节点后，剩下的节点要能装下重建出来的数据。</span>
            </span>
          </label>
        </div>

        {/* Results */}
        <div className="space-y-6">
          <div className="rounded-xl border border-hairline bg-elevated p-6">
            <p className="eyebrow">可用容量</p>
            <p className="mt-2 text-[56px] font-semibold leading-none tracking-[-2.8px] text-ink">
              {usable.v}
              <span className="ml-2 text-2xl font-normal tracking-normal text-mute">{usable.u}</span>
            </p>
            <p className="mt-2 text-sm text-mute">
              ≈ {(r.usable * TIB_PER_TB).toFixed(1)} TiB · 裸容量的 {((r.usable / r.raw) * 100).toFixed(1)}% · 可容忍{' '}
              {r.tolerate} 个故障域同时失效
            </p>
            <div className="mt-6 space-y-3">
              {waterfall.map((w, i) => {
                const f = fmtCap(w.value)
                return (
                  <div key={w.label}>
                    <div className="flex items-baseline justify-between text-sm">
                      <span className="text-ink">{w.label}</span>
                      <span className="font-mono text-body">
                        {f.v} {f.u} <span className="text-faint">· {w.note}</span>
                      </span>
                    </div>
                    <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-hairline-soft">
                      <div
                        className={`h-full rounded-full ${i === waterfall.length - 1 ? 'bg-accent' : 'bg-[#99d5cc]'}`}
                        style={{ width: `${(w.value / r.raw) * 100}%` }}
                      />
                    </div>
                  </div>
                )
              })}
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Stat label="随机读 IOPS 上限" value={fmtNum(r.readIops)} note={`${r.osds} 个 OSD × ${fmtNum(c.diskIops)}`} />
            <Stat label="随机写 IOPS 上限" value={fmtNum(r.writeIops)} note={`每次写落到 ${r.opAmp} 个 OSD${c.scheme === 'ec' ? '，小写还要读改写' : ''}`} />
            <Stat label="顺序读带宽上限" value={fmtBw(r.readBw)} note={r.netLimited ? '受限于网络' : '受限于磁盘'} />
            <Stat label="顺序写带宽上限" value={fmtBw(r.writeBw)} note={`写放大 ${r.byteAmp.toFixed(2)}×`} />
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <Stat label="坏一块盘需重建" value={fmtCap(r.diskData).v + ' ' + fmtCap(r.diskData).u} note="按规划水位估算" small />
            <Stat label="坏一台节点需重建" value={fmtCap(r.nodeData).v + ' ' + fmtCap(r.nodeData).u} note="重建期间性能下降" small />
            <Stat label="单存储池 PG 参考" value={String(r.pgs)} note="OSD × 100 ÷ 宽度，取 2 的幂" small />
          </div>

          {r.warnings.length > 0 && (
            <div className="rounded-xl border border-warning bg-warning-soft/50 p-5">
              <p className="text-sm font-semibold text-warning-deep">需要注意</p>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-body">
                {r.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </div>
          )}

          <p className="text-xs leading-5 text-mute">
            性能数字是按单 OSD 经验值线性累加的理论上限，没有算 CPU、客户端并发、元数据和网络拓扑的影响，真实集群通常只能达到其中一部分。上线前请用
            fio、rados bench 或 elbencho 实测，方法见{' '}
            <Link to="/learn/$slug" params={{ slug: 'benchmarking' }} className="text-accent hover:text-accent-deep">
              基准测试
            </Link>
            。
          </p>
        </div>
      </div>
    </main>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <p className="mb-2 text-sm font-medium text-ink">{label}</p>
      {children}
    </div>
  )
}

function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T
  options: [T, string][]
  onChange: (v: T) => void
}) {
  return (
    <div className="inline-flex rounded-lg border border-hairline bg-canvas p-1">
      {options.map(([v, label]) => (
        <button
          key={v}
          type="button"
          onClick={() => onChange(v)}
          className={`rounded-md px-3 py-1.5 text-sm transition-colors ${
            v === value ? 'bg-elevated text-ink shadow-[var(--shadow-whisper)]' : 'text-mute hover:text-ink'
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  )
}

function NumberField({
  label,
  value,
  min,
  max,
  step = 1,
  onChange,
}: {
  label: string
  value: number
  min: number
  max: number
  step?: number
  onChange: (v: number) => void
}) {
  return (
    <label className="block">
      <span className="mb-2 block text-sm font-medium text-ink">{label}</span>
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(e) => {
          if (e.target.value === '') return
          const v = Number(e.target.value)
          if (Number.isFinite(v)) onChange(Math.min(max, Math.max(min, v)))
        }}
        className="h-10 w-full rounded-md border border-hairline bg-elevated px-3 font-mono text-sm text-ink outline-none focus:border-accent"
      />
    </label>
  )
}

function Stat({ label, value, note, small }: { label: string; value: string; note: string; small?: boolean }) {
  return (
    <div className="rounded-xl border border-hairline bg-elevated p-5">
      <p className="text-sm text-mute">{label}</p>
      <p className={`mt-1 font-semibold text-ink ${small ? 'text-xl tracking-[-0.6px]' : 'text-3xl tracking-[-1.2px]'}`}>
        {value}
      </p>
      <p className="mt-1 text-xs text-faint">{note}</p>
    </div>
  )
}
