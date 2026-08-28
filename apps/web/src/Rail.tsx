import { useQuery } from '@tanstack/react-query'
import { api, type Candidate, type Project, type TailorRequest } from './api'

export type SectionKey = 'scout' | 'projects' | 'workshop' | 'market' | 'tailor'

const STATIONS: Array<{ key: SectionKey; no: string; label: string }> = [
  { key: 'scout', no: '工位一', label: '找项目' },
  { key: 'projects', no: '工位二', label: '拆解' },
  { key: 'workshop', no: '工位三', label: '做内容' },
  { key: 'market', no: '工位四', label: '分发' },
]
const TAILOR_STATION = { key: 'tailor' as const, no: '按单', label: '定制' }

/** 顶部工位流水线导航：四工位 + 定制支线，单页 tab 切换（不占 URL）。计数用已有 query 就地算，算不出来的不显示。 */
export default function Rail({ active, onChange }: { active: SectionKey; onChange: (k: SectionKey) => void }) {
  const candidates = useQuery({ queryKey: ['candidates'], queryFn: () => api<Candidate[]>('/api/candidates') })
  const projects = useQuery({ queryKey: ['projects'], queryFn: () => api<Project[]>('/api/projects') })
  const tailor = useQuery({ queryKey: ['tailor'], queryFn: () => api<TailorRequest[]>('/api/tailor') })
  const inDecompose = (projects.data ?? []).filter((p) => p.stage === 'analysis' || p.stage === 'rebranding').length

  const count = (key: SectionKey): string | null => {
    if (key === 'scout') return candidates.data ? `候选 ${candidates.data.length}` : null
    if (key === 'projects') return projects.data ? `在制 ${inDecompose}` : null
    if (key === 'tailor') return tailor.data ? `需求 ${tailor.data.length}` : null
    return null
  }

  const station = (s: { key: SectionKey; no: string; label: string }, extraClass = '') => (
    <button key={s.key} className={`station ${extraClass}`} role="tab" aria-selected={active === s.key} onClick={() => onChange(s.key)}>
      <span className="no">{s.no}</span>
      <span className="nm">{s.label}{count(s.key) && <span className="ct">{count(s.key)}</span>}</span>
    </button>
  )

  return (
    <nav className="rail" role="tablist" aria-label="生产工位">
      {STATIONS.map((s) => station(s))}
      {station(TAILOR_STATION, 'spur')}
    </nav>
  )
}
