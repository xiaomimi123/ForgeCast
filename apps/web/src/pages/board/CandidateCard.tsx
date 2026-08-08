import type { Candidate } from '../../api'

// 三个评分维度各自的满分（§3 四维模型，协议为一票否决不计分）
export const DIMS = [
  { key: 'rebrandCost', label: '换皮', max: 30 },
  { key: 'buyerClarity', label: '买家', max: 40 },
  { key: 'visualAppeal', label: '可视', max: 30 },
] as const

export interface Detail {
  rebrandCost: number; buyerClarity: number; visualAppeal: number
  rationale: string; targetBuyer: string; painPoint: string
  category: string
}
/** 数值字段兜底：非 number 或 NaN/Infinity 一律按 0 处理，避免脏数据渲染出 NaN% 的色条 */
function num(x: unknown): number {
  return typeof x === 'number' && Number.isFinite(x) ? x : 0
}
/** 字符串字段兜底：非 string 一律按空串处理 */
function str(x: unknown): string {
  return typeof x === 'string' ? x : ''
}
/** 旧行可能没有 targetBuyer/painPoint，一律按空串兜底 */
export function parseDetail(sd: string | null): Detail | null {
  if (!sd) return null
  try {
    const o = JSON.parse(sd)
    return {
      rebrandCost: num(o.rebrandCost), buyerClarity: num(o.buyerClarity), visualAppeal: num(o.visualAppeal),
      rationale: str(o.rationale), targetBuyer: str(o.targetBuyer), painPoint: str(o.painPoint),
      category: str(o.category),
    }
  } catch { return null }
}

export function Bar({ label, value, max }: { label: string; value: number; max: number }) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100))
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="w-8 shrink-0 text-neutral-500">{label}</span>
      <div className="h-1.5 w-24 shrink-0 rounded bg-neutral-200">
        <div className="h-1.5 rounded bg-blue-500" style={{ width: `${pct}%` }} />
      </div>
      <span className="tabular-nums text-neutral-400">{value}/{max}</span>
    </div>
  )
}

function Row({ icon, label, value, muted }: { icon: string; label: string; value: string; muted?: boolean }) {
  return (
    <div className="flex gap-2 text-xs">
      <span className="shrink-0">{icon}</span>
      <span className="w-14 shrink-0 text-neutral-500">{label}</span>
      <span className={muted ? 'text-neutral-400 italic' : 'text-neutral-700'}>{value}</span>
    </div>
  )
}

// 领域分类 → 图标底色（无真实 logo 数据，用色块 + 分类短名替代）
const CAT_COLORS: Record<string, string> = {
  '客服/IM': 'bg-sky-500', 'CRM/销售': 'bg-emerald-500', '电商/商城': 'bg-orange-500',
  '仪表盘/BI': 'bg-violet-500', '表单/问卷': 'bg-pink-500', '文档/知识库': 'bg-amber-500',
  '建站/CMS': 'bg-teal-500', '项目/协作': 'bg-indigo-500', '财务/发票': 'bg-lime-600',
  '预约/排期': 'bg-cyan-600', 'AI助手/Agent': 'bg-fuchsia-500', '其它': 'bg-neutral-400',
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
  const cat = d?.category || '其它'
  const empty = '未生成 — 详情里点「重新评分」'
  return (
    <div className="flex cursor-pointer flex-col rounded-xl border bg-white p-4 shadow-sm hover:border-blue-300"
      onClick={() => onOpenDetail(c)}>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs text-neutral-400">
            {owner}/{isNew && <span className="ml-1 rounded bg-red-500 px-1 py-0.5 text-[10px] font-semibold text-white">NEW</span>}
          </div>
          <div className="truncate text-lg font-bold leading-tight">{name}</div>
        </div>
        <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-xs font-medium text-white ${CAT_COLORS[cat] ?? CAT_COLORS['其它']}`}>
          {cat === '其它' ? (name?.[0] ?? '?').toUpperCase() : cat.split('/')[0].slice(0, 2)}
        </div>
      </div>
      <div className="mt-1 line-clamp-2 min-h-[2rem] text-xs text-neutral-500">{c.description ?? ''}</div>
      <div className="mt-2 flex items-center gap-2 text-xs">
        <span className="text-neutral-500">⭐ {num(c.stars).toLocaleString()}</span>
        <span className="rounded bg-blue-50 px-1.5 py-0.5 font-semibold text-blue-700">{c.score ?? '—'} 分</span>
        <span className="rounded bg-green-50 px-1.5 py-0.5 text-green-700">{c.license ?? '—'}</span>
        {d?.category && d.category !== '其它' && (
          <span className="truncate rounded bg-indigo-50 px-1.5 py-0.5 text-indigo-700">{d.category}</span>
        )}
      </div>
      <div className="mt-2 flex-1 space-y-1">
        <Row icon="👤" label="目标群体" value={d?.targetBuyer || empty} muted={!d?.targetBuyer} />
        <Row icon="💢" label="行业痛点" value={d?.painPoint || empty} muted={!d?.painPoint} />
      </div>
      <div className="mt-1 text-right text-xs text-neutral-400">{daysAgoText(c.last_commit)}</div>
      <div className="mt-2 flex items-center gap-2 border-t pt-2" onClick={(e) => e.stopPropagation()}>
        <button title={c.favorite ? '取消收藏' : '收藏'} disabled={favPending}
          className={`rounded-lg border px-2.5 py-1.5 text-sm disabled:opacity-50 ${c.favorite ? 'border-amber-400 bg-amber-50 text-amber-500' : 'text-neutral-400 hover:text-amber-500'}`}
          onClick={() => onToggleFavorite(c)}>
          {c.favorite ? '★' : '☆'}
        </button>
        <button className="flex-1 rounded-lg border py-1.5 text-sm hover:border-blue-400 hover:text-blue-600"
          onClick={() => onOpenDetail(c)}>详情</button>
        <a className="rounded-lg border px-2.5 py-1.5 text-sm text-neutral-500 hover:text-blue-600"
          title="打开 GitHub" href={c.url} target="_blank" rel="noreferrer">↗</a>
      </div>
    </div>
  )
}
