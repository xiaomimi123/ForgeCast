import { useQuery } from '@tanstack/react-query'
import { api, type Candidate, type Project, type TailorRequest, type WeeklyReport } from './api'

const P0_TARGET_DAYS = 14
const P0_TARGET_LEADS = 5

function since14dAgo(): string {
  const d = new Date(Date.now() - P0_TARGET_DAYS * 86400_000)
  return d.toISOString().slice(0, 10)
}

export type SectionKey = 'scout' | 'projects' | 'workshop' | 'market' | 'tailor'

const STATIONS: Array<{ key: SectionKey; label: string }> = [
  { key: 'scout', label: '找项目' },
  { key: 'projects', label: '拆解' },
  { key: 'workshop', label: '做内容' },
  { key: 'market', label: '分发' },
]
const TAILOR_STATION = { key: 'tailor' as const, label: '定制' }

/** 顶栏：品牌 + 工位面包屑（原 Rail 五个入口压成文字链）+ P0 状态条（近14天已发/询单，纯展示，不做达标判定业务逻辑）+ 设置/选题库入口，单行 52px */
export default function Topbar({
  active,
  onChange,
  onOpenSettings,
  onOpenTopics,
}: {
  active: SectionKey
  onChange: (k: SectionKey) => void
  onOpenSettings: () => void
  onOpenTopics: () => void
}) {
  const report = useQuery({ queryKey: ['report', 'p0'], queryFn: () => api<WeeklyReport>(`/api/report?since=${since14dAgo()}`) })
  const candidates = useQuery({ queryKey: ['candidates'], queryFn: () => api<Candidate[]>('/api/candidates') })
  const projects = useQuery({ queryKey: ['projects'], queryFn: () => api<Project[]>('/api/projects') })
  const tailor = useQuery({ queryKey: ['tailor'], queryFn: () => api<TailorRequest[]>('/api/tailor') })
  const inDecompose = (projects.data ?? []).filter((p) => p.stage === 'analysis' || p.stage === 'rebranding').length

  const published = report.data?.totals.published ?? 0
  const leads = report.data?.totals.leads ?? 0

  const count = (key: SectionKey): string | null => {
    if (key === 'scout') return candidates.data ? `候选 ${candidates.data.length}` : null
    if (key === 'projects') return projects.data ? `在制 ${inDecompose}` : null
    if (key === 'tailor') return tailor.data ? `需求 ${tailor.data.length}` : null
    return null
  }

  const crumb = (s: { key: SectionKey; label: string }, extraClass = '') => {
    const isActive = active === s.key
    const c = count(s.key)
    return (
      <button
        key={s.key}
        role="tab"
        aria-selected={isActive}
        onClick={() => onChange(s.key)}
        className={`flex items-baseline gap-1 text-sm ${isActive ? 'font-bold' : ''} ${extraClass}`}
        style={{ color: isActive ? 'var(--fc-accent)' : 'var(--fc-muted)' }}
      >
        {s.label}
        {c && (
          <span className="text-[0.62rem]" style={{ fontFamily: '"JetBrains Mono", monospace', color: 'inherit', opacity: 0.75 }}>
            {c}
          </span>
        )}
      </button>
    )
  }

  return (
    <header className="flex items-center gap-3.5 px-7" style={{ height: 52 }}>
      <div className="text-[1.35rem] font-black tracking-tight" style={{ fontFamily: '"Noto Serif SC", serif' }}>
        Forge<span className="text-fire">Cast</span>
      </div>
      <nav className="flex items-center gap-4" role="tablist" aria-label="生产工位">
        {STATIONS.map((s, i) => (
          <span key={s.key} className="flex items-center gap-4">
            {i > 0 && <span style={{ color: 'var(--fc-line-2)' }}>·</span>}
            {crumb(s)}
          </span>
        ))}
        <span style={{ color: 'var(--fc-line-2)' }}>|</span>
        {crumb(TAILOR_STATION)}
      </nav>
      <div className="flex-1" />
      <div className="text-[0.72rem] text-fire border border-fire rounded-[2px] bg-fire-soft px-2.5 py-0.5" style={{ fontFamily: '"JetBrains Mono", monospace' }}>
        近{P0_TARGET_DAYS}天已发 {published} 条 · 询单 {leads}/{P0_TARGET_LEADS}
      </div>
      <button className="btn-ink px-3 py-1 text-sm" onClick={onOpenTopics} title="选题库">📋 选题库</button>
      <button className="btn-ink px-3 py-1 text-sm" onClick={onOpenSettings} title="设置">⚙️ 设置</button>
    </header>
  )
}
