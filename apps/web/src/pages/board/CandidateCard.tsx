import type { Candidate } from '../../api'

export type Track = 'profit' | 'traffic'

/** 三个评分维度的展示定义，max 读当前配置的权重（不再硬编码 30/40/30） */
export function buildDims(weights: { rebrandCost: number; buyerClarity: number; visualAppeal: number }) {
  return [
    { key: 'rebrandCost' as const, label: '换皮', max: weights.rebrandCost },
    { key: 'buyerClarity' as const, label: '买家', max: weights.buyerClarity },
    { key: 'visualAppeal' as const, label: '可视', max: weights.visualAppeal },
  ]
}

export interface Detail {
  rebrandCost: number; buyerClarity: number; visualAppeal: number
  rationale: string; targetBuyer: string; painPoint: string
  summaryZh: string
  category: string
  track?: Track
  gapScore?: number
  threshold?: number
  exitRoutes?: string[]
  emotionScore?: number
  wowScore?: number
}
/** 数值字段兜底：非 number 或 NaN/Infinity 一律按 0 处理，避免脏数据渲染出 NaN% 的色条 */
function num(x: unknown): number {
  return typeof x === 'number' && Number.isFinite(x) ? x : 0
}
/** 字符串字段兜底：非 string 一律按空串处理 */
function str(x: unknown): string {
  return typeof x === 'string' ? x : ''
}
/** 分轨专属数值字段：非 number/NaN/Infinity 或压根没给 → undefined（不像 num() 那样兜底成 0——0 是有效差价分，undefined 才代表"没打过这个分") */
function optNum(x: unknown): number | undefined {
  return typeof x === 'number' && Number.isFinite(x) ? x : undefined
}
/** exitRoutes 专属：必须是纯字符串数组，否则 undefined */
function optStrArr(x: unknown): string[] | undefined {
  return Array.isArray(x) && x.every((v) => typeof v === 'string') ? x : undefined
}
/** track 专属：只接受两个合法值，否则 undefined（老候选/坏数据一律按"未分轨"处理） */
function optTrack(x: unknown): Track | undefined {
  return x === 'profit' || x === 'traffic' ? x : undefined
}
/** 旧行可能没有 targetBuyer/painPoint，一律按空串兜底 */
export function parseDetail(sd: string | null): Detail | null {
  if (!sd) return null
  try {
    const o = JSON.parse(sd)
    return {
      rebrandCost: num(o.rebrandCost), buyerClarity: num(o.buyerClarity), visualAppeal: num(o.visualAppeal),
      rationale: str(o.rationale), targetBuyer: str(o.targetBuyer), painPoint: str(o.painPoint),
      summaryZh: str(o.summaryZh),
      category: str(o.category),
      track: optTrack(o.track),
      gapScore: optNum(o.gapScore),
      threshold: optNum(o.threshold),
      exitRoutes: optStrArr(o.exitRoutes),
      emotionScore: optNum(o.emotionScore),
      wowScore: optNum(o.wowScore),
    }
  } catch { return null }
}

export function Bar({ label, value, max }: { label: string; value: number; max: number }) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100))
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="w-8 shrink-0 text-sub">{label}</span>
      <div className="h-1.5 w-24 shrink-0 rounded bg-hairline">
        <div className="h-1.5 rounded bg-fire" style={{ width: `${pct}%` }} />
      </div>
      <span className="tabular-nums text-faint">{value}/{max}</span>
    </div>
  )
}

function daysAgoText(iso: string | null): string {
  if (!iso) return ''
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return ''
  const days = Math.floor((Date.now() - t) / 86400000)
  return days <= 0 ? '今天更新' : `${days} 天前更新`
}

export default function CandidateCard({ c, isNew, onOpenDetail, onToggleFavorite, favPending }: {
  c: Candidate; isNew: boolean
  onOpenDetail: (c: Candidate) => void
  onToggleFavorite: (c: Candidate) => void
  favPending: boolean
}) {
  const d = parseDetail(c.score_detail)
  const [owner, name] = c.repo.split('/')
  const empty = '未生成 — 详情里点「重新评分」'
  return (
    <div className="card-forge relative flex cursor-pointer flex-col gap-2.5 p-4"
      onClick={() => onOpenDetail(c)}>
      {isNew && (
        <div className="absolute -top-3 right-3 rounded bg-fire px-2.5 py-0.5 text-[10px] font-extrabold tracking-widest text-white shadow-[2px_2px_0_rgba(28,23,18,0.85)]">
          今日入炉
        </div>
      )}
      <div className="flex items-start">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[11px] text-faint">{owner} /</div>
          <div className="truncate text-lg font-black tracking-tight">{name}</div>
        </div>
        {d?.category && (
          <span className="ml-2 shrink-0 rounded border-[1.5px] border-ink px-1.5 py-0.5 text-[10px] font-extrabold tracking-[2px]">
            {d.category.split('/')[0]}
          </span>
        )}
      </div>
      <div className="line-clamp-2 min-h-[2.5rem] text-xs leading-relaxed text-sub">{d?.summaryZh || c.description || ''}</div>
      <div className="flex items-baseline gap-1.5 border-t-2 border-ink pt-2">
        <span className="text-[26px] font-black tracking-tighter text-fire">{c.score ?? '—'}</span>
        <span className="text-[10px] font-bold tracking-[2px] text-faint">变现分</span>
        <span className="ml-auto text-[10.5px] text-faint">
          ⭐{num(c.stars).toLocaleString()} · {c.license ?? '无协议'}{daysAgoText(c.last_commit) ? ` · ${daysAgoText(c.last_commit)}` : ''}
        </span>
      </div>
      <div className="flex-1 space-y-0.5 text-[11px] text-sub">
        <div className="truncate"><em className="mr-2 font-extrabold not-italic text-ink">谁掏钱</em>{d?.targetBuyer || empty}</div>
        <div className="truncate"><em className="mr-2 font-extrabold not-italic text-ink">为何掏</em>{d?.painPoint || empty}</div>
      </div>
      <div className="flex gap-2" onClick={(e) => e.stopPropagation()}>
        <button disabled={favPending}
          className={`rounded-md border-[1.5px] px-2.5 py-1.5 text-xs font-semibold disabled:opacity-50 ${
            c.favorite ? 'border-fire bg-fire-soft text-fire' : 'border-ink bg-card text-ink'
          }`}
          title={c.favorite ? '取消收藏' : '收藏'}
          onClick={() => onToggleFavorite(c)}>
          {c.favorite ? '★ 已收' : '☆ 收藏'}
        </button>
        <button className="flex-1 rounded-md border-[1.5px] border-ink bg-ink py-1.5 text-xs font-semibold text-paper"
          onClick={() => onOpenDetail(c)}>看详情</button>
        <a className="rounded-md border-[1.5px] border-ink bg-card px-2.5 py-1.5 text-xs font-semibold text-ink"
          href={c.url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>GitHub ↗</a>
      </div>
    </div>
  )
}
