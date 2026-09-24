import { Link, createFileRoute } from '@tanstack/react-router'
import { allLessons, stages, totalMinutes } from '~/content/curriculum'

export const Route = createFileRoute('/')({
  component: Home,
})

const terminal = [
  { p: '$', t: 'fio --name=randread --rw=randread --bs=4k --iodepth=32 \\' },
  { p: ' ', t: '    --direct=1 --ioengine=io_uring --runtime=30 --filename=/dev/nvme0n1' },
  { p: ' ', t: '  read: IOPS=412k, BW=1609MiB/s (1687MB/s)', m: true },
  { p: ' ', t: '    clat percentiles (usec): 50.00th=[   74], 99.00th=[  145]', m: true },
  { p: '$', t: 'iostat -xz 1 nvme0n1' },
  { p: ' ', t: 'Device     r/s     rkB/s   r_await  aqu-sz  %util', m: true },
  { p: ' ', t: 'nvme0n1  411873  1647492     0.08    31.6  100.0', m: true },
  { p: '$', t: 'ceph -s | grep -E "health|pgs"' },
  { p: ' ', t: '    health: HEALTH_OK', m: true },
  { p: ' ', t: '    pgs:    1025 active+clean', m: true },
]

// 首页的 I/O 路径示意：课程会沿着这条路径一层层往下讲，再扩展到网络与集群
const ioPath = [
  { layer: '应用', detail: 'read() / write() / fsync()', lessons: ['io-stack', 'page-cache'] },
  { layer: 'VFS 与页缓存', detail: '缓存命中、脏页回写', lessons: ['page-cache', 'fs-observability'] },
  { layer: '文件系统', detail: 'ext4 / XFS / CephFS / GPFS', lessons: ['filesystems', 'distributed-fs'] },
  { layer: '块层', detail: 'bio、blk-mq、I/O 调度器', lessons: ['block-devices', 'io-tuning'] },
  { layer: '网络', detail: 'NFS / iSCSI / NVMe-oF / RDMA', lessons: ['network-storage', 'rdma'] },
  { layer: '设备与集群', detail: 'NVMe、RAID、副本与纠删码', lessons: ['storage-hardware', 'replication-ec'] },
]

const method = [
  {
    k: '01',
    title: '先建地图，再走细节',
    body: '第一阶段就画出一次 write() 从应用到磁盘的完整路径，之后每一课都在这张地图上定位，知识不会碎成一地。',
  },
  {
    k: '02',
    title: '先测量，再下结论',
    body: '用 USE 方法、fio、iostat 和 BPF 工具说话。没有基线的调优都是玄学，每个结论都要能被复现。',
  },
  {
    k: '03',
    title: '对齐生产实践',
    body: '生产与专家阶段取材于真实 GPU / AI 集群的存储建设：cephadm、Rook-Ceph、GPFS ECE、Weka 与 CSI。',
  },
]

function Home() {
  const hours = Math.round(totalMinutes / 60)
  return (
    <main>
      {/* Hero */}
      <section className="relative overflow-hidden border-b border-hairline">
        <div className="mesh pointer-events-none absolute inset-0 -z-10" />
        <div className="grid-bg pointer-events-none absolute inset-0 -z-10" />
        <div className="mx-auto grid max-w-[1200px] items-center gap-14 px-4 py-20 sm:px-6 lg:grid-cols-[1.1fr_1fr] lg:py-28">
          <div>
            <p className="eyebrow">Storage · 中文教程 · 从零到专业</p>
            <h1 className="mt-5 text-[40px] font-semibold leading-[1.05] tracking-[-2px] text-ink sm:text-[56px] sm:tracking-[-2.8px]">
              从第一块磁盘，
              <br />
              到生产级存储集群。
            </h1>
            <p className="mt-6 max-w-lg text-lg leading-8 text-body">
              一条循序渐进的存储学习路线。从磁盘与 Linux I/O 栈讲起，逐步深入性能观测、分布式原理、Ceph
              生产部署运维，直到 GPFS 与 AI 训练存储。
            </p>
            <div className="mt-9 flex flex-wrap gap-3">
              <Link
                to="/learn/$slug"
                params={{ slug: 'welcome' }}
                className="inline-flex h-11 items-center rounded-full bg-ink px-6 font-medium text-white hover:bg-[#383838] transition-colors"
              >
                从第一课开始
              </Link>
              <Link
                to="/learn"
                className="inline-flex h-11 items-center rounded-full border border-hairline bg-elevated px-6 font-medium text-ink hover:border-[#d4d4d4] transition-colors"
              >
                查看学习路线
              </Link>
              <Link
                to="/calculator"
                className="inline-flex h-11 items-center gap-2 rounded-full px-4 font-medium text-accent hover:text-accent-deep transition-colors"
              >
                容量计算器 →
              </Link>
            </div>
            <dl className="mt-12 grid max-w-md grid-cols-3 gap-6">
              {[
                [String(stages.length), '个阶段'],
                [String(allLessons.length), '篇课文'],
                [`~${hours}`, '小时学习'],
              ].map(([v, l]) => (
                <div key={l}>
                  <dt className="text-3xl font-semibold tracking-[-1.2px] text-ink">{v}</dt>
                  <dd className="mt-1 text-sm text-mute">{l}</dd>
                </div>
              ))}
            </dl>
          </div>

          <div className="rounded-2xl border border-hairline bg-elevated shadow-[var(--shadow-float)]">
            <div className="flex items-center gap-1.5 border-b border-hairline px-4 py-3">
              <span className="size-2.5 rounded-full bg-[#ebebeb]" />
              <span className="size-2.5 rounded-full bg-[#ebebeb]" />
              <span className="size-2.5 rounded-full bg-[#ebebeb]" />
              <span className="ml-3 font-mono text-xs text-mute">~/storage-journey — zsh</span>
            </div>
            <pre className="overflow-x-auto p-5 font-mono text-[12.5px] leading-6">
              {terminal.map((l, i) => (
                <div key={i} className={l.m ? 'text-mute' : 'text-ink'}>
                  <span className="mr-2 select-none text-accent">{l.p}</span>
                  {l.t}
                </div>
              ))}
            </pre>
          </div>
        </div>
      </section>

      {/* I/O path */}
      <section className="mx-auto max-w-[1200px] px-4 pt-24 sm:px-6">
        <div className="grid items-start gap-10 lg:grid-cols-[5fr_7fr]">
          <div className="lg:sticky lg:top-24">
            <p className="eyebrow">The I/O Path</p>
            <h2 className="mt-3 text-[32px] font-semibold leading-10 tracking-[-1.28px]">一次 I/O，穿过六层</h2>
            <p className="mt-3 text-body">
              应用发出的每一次读写，都要经过页缓存、文件系统、块层、网络，最后落到设备与集群上。性能问题和数据丢失，都藏在某一层里。这门课就沿着这条路径，一层一层往下走。
            </p>
            <Link
              to="/learn/$slug"
              params={{ slug: 'io-stack' }}
              className="mt-6 inline-flex h-11 items-center rounded-full bg-ink px-6 font-medium text-white hover:bg-[#383838] transition-colors"
            >
              先看 I/O 栈全景
            </Link>
          </div>
          <ol className="relative space-y-3 before:absolute before:inset-y-6 before:left-[37px] before:w-px before:bg-hairline">
            {ioPath.map((p, i) => (
              <li
                key={p.layer}
                className="relative flex items-start gap-5 rounded-xl border border-hairline bg-elevated p-5 transition-shadow hover:shadow-[var(--shadow-float)]"
              >
                <span className="z-10 flex size-8 shrink-0 items-center justify-center rounded-full border border-accent bg-accent-soft font-mono text-xs text-accent-deep">
                  L{i}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-4">
                    <h3 className="text-lg font-semibold tracking-[-0.3px] text-ink">{p.layer}</h3>
                    <span className="font-mono text-xs text-mute">{p.detail}</span>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {p.lessons.map((slug) => (
                      <Link
                        key={slug}
                        to="/learn/$slug"
                        params={{ slug }}
                        className="rounded-full border border-hairline px-3 py-1 text-xs text-body hover:border-accent hover:text-accent transition-colors"
                      >
                        {allLessons.find((l) => l.slug === slug)?.title ?? slug}
                      </Link>
                    ))}
                  </div>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* Stages */}
      <section className="mx-auto max-w-[1200px] px-4 py-24 sm:px-6">
        <p className="eyebrow">Roadmap</p>
        <h2 className="mt-3 text-[32px] font-semibold leading-10 tracking-[-1.28px]">六个阶段，逐级攀升</h2>
        <p className="mt-3 max-w-2xl text-body">
          每个阶段都有明确的目标。学完一个阶段，你就能独立完成这一层级的工作，再向上一级。
        </p>
        <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {stages.map((s) => (
            <Link
              key={s.id}
              to="/learn/$slug"
              params={{ slug: s.lessons[0].slug }}
              className="group flex flex-col rounded-xl border border-hairline bg-elevated p-6 transition-shadow hover:shadow-[var(--shadow-float)]"
            >
              <div className="flex items-center justify-between">
                <span className="eyebrow">
                  Stage {String(s.index).padStart(2, '0')} · {s.level}
                </span>
                <span className="font-mono text-xs text-faint">{s.lessons.length} 课</span>
              </div>
              <h3 className="mt-4 text-xl font-semibold tracking-[-0.4px] text-ink">
                {s.name}
                <span className="font-normal text-mute"> · {s.tagline}</span>
              </h3>
              <p className="mt-2 text-sm leading-6 text-body">{s.goal}</p>
              <ul className="mt-5 space-y-1.5 border-t border-hairline pt-4 text-sm text-mute">
                {s.lessons.slice(0, 4).map((l) => (
                  <li key={l.slug} className="truncate">
                    {l.title}
                  </li>
                ))}
                {s.lessons.length > 4 && <li className="text-faint">…还有 {s.lessons.length - 4} 课</li>}
              </ul>
              <span className="mt-5 text-sm font-medium text-accent group-hover:text-accent-deep">
                进入本阶段 →
              </span>
            </Link>
          ))}
        </div>
      </section>

      {/* Method */}
      <section className="border-y border-hairline bg-elevated">
        <div className="mx-auto max-w-[1200px] px-4 py-24 sm:px-6">
          <p className="eyebrow">How it works</p>
          <h2 className="mt-3 text-[32px] font-semibold leading-10 tracking-[-1.28px]">这样学，更扎实</h2>
          <div className="mt-12 grid gap-4 md:grid-cols-3">
            {method.map((m) => (
              <div key={m.k} className="rounded-xl border border-hairline bg-canvas p-6">
                <span className="font-mono text-sm text-accent">{m.k}</span>
                <h3 className="mt-3 text-lg font-semibold tracking-[-0.3px]">{m.title}</h3>
                <p className="mt-2 text-sm leading-6 text-body">{m.body}</p>
              </div>
            ))}
          </div>
          <div className="mt-10 grid gap-4 md:grid-cols-2">
            <a
              href="https://www.brendangregg.com/systems-performance-2nd-edition-book.html"
              target="_blank"
              rel="noreferrer"
              className="rounded-xl border border-hairline p-6 hover:shadow-[var(--shadow-float)] transition-shadow"
            >
              <p className="eyebrow">Reference 01</p>
              <p className="mt-2 font-semibold">Systems Performance, 2nd Edition</p>
              <p className="mt-1 text-sm text-body">
                Brendan Gregg 的经典著作。性能方法论、文件系统、磁盘、基准测试与 BPF 观测的主要参考。
              </p>
            </a>
            <div className="rounded-xl border border-hairline p-6">
              <p className="eyebrow">Reference 02</p>
              <p className="mt-2 font-semibold">k8s-in-action 生产实践手册</p>
              <p className="mt-1 text-sm text-body">
                一线 GPU / AI 集群的存储部署手册：cephadm、Rook-Ceph、GPFS ECE、Weka、VAST 与各类 CSI。
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="mx-auto max-w-[1200px] px-4 py-24 text-center sm:px-6">
        <h2 className="text-[36px] font-semibold leading-tight tracking-[-1.6px] sm:text-[48px] sm:tracking-[-2.4px]">
          准备好出发了吗？
        </h2>
        <p className="mx-auto mt-4 max-w-md text-body">只需要一台电脑和一台 Linux 虚拟机。第一课 10 分钟，带你看清整条路线。</p>
        <Link
          to="/learn/$slug"
          params={{ slug: 'welcome' }}
          className="mt-8 inline-flex h-11 items-center rounded-full bg-ink px-6 font-medium text-white hover:bg-[#383838] transition-colors"
        >
          开始学习
        </Link>
      </section>
    </main>
  )
}
