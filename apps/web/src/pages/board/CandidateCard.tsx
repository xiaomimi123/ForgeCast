import type { Candidate } from '../../api'

// 三个评分维度各自的满分（§3 四维模型，协议为一票否决不计分）
const DIMS = [
  { key: 'rebrandCost', label: '换皮', max: 30 },
  { key: 'buyerClarity', label: '买家', max: 40 },
  { key: 'visualAppeal', label: '可视', max: 30 },
] as const

interface Detail {
  rebrandCost: number; buyerClarity: number; visualAppeal: number
  rationale: string; targetBuyer: string; painPoint: string
}
/** 旧行可能没有 targetBuyer/painPoint，一律按空串兜底 */
function parseDetail(sd: string | null): Detail | null {
  if (!sd) return null
  try {
    const o = JSON.parse(sd)
    return {
      rebrandCost: o.rebrandCost ?? 0, buyerClarity: o.buyerClarity ?? 0, visualAppeal: o.visualAppeal ?? 0,
      rationale: o.rationale ?? '', targetBuyer: o.targetBuyer ?? '', painPoint: o.painPoint ?? '',
    }
  } catch { return null }
}

function Bar({ label, value, max }: { label: string; value: number; max: number }) {
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

export default function CandidateCard({ c, rank, onPick, onRescore, picking, rescoring }: {
  c: Candidate; rank: number
  onPick: (repo: string) => void; onRescore: (id: number) => void
  picking: boolean; rescoring: boolean
}) {
  const d = parseDetail(c.score_detail)
  const empty = '未生成 — 配好 key 后点「重新评分」'

  return (
    <div className="rounded-lg border bg-white p-3 hover:border-blue-300">
      <div className="flex items-baseline gap-2">
        <span className="text-xs text-neutral-400">#{rank}</span>
        <a className="font-medium text-blue-600" href={c.url} target="_blank" rel="noreferrer">{c.repo}</a>
        <span className="text-xs text-neutral-400">★{c.stars.toLocaleString()}</span>
        <span className="rounded bg-green-50 px-1.5 py-0.5 text-xs text-green-700">{c.license ?? '—'}</span>
        <span className="ml-auto text-sm font-semibold">{c.score ?? '—'}</span>
      </div>

      {c.description && <div className="mt-1 text-xs text-neutral-500">{c.description}</div>}

      {d && (
        <div className="mt-2 space-y-1">
          {DIMS.map((dim) => <Bar key={dim.key} label={dim.label} value={d[dim.key]} max={dim.max} />)}
        </div>
      )}

      <div className="mt-2 space-y-1">
        <Row icon="👤" label="目标群体" value={d?.targetBuyer || empty} muted={!d?.targetBuyer} />
        <Row icon="💢" label="行业痛点" value={d?.painPoint || empty} muted={!d?.painPoint} />
        {d?.rationale && <Row icon="💡" label="评分说明" value={d.rationale} />}
      </div>

      <div className="mt-2 flex items-center gap-2">
        {c.status === 'picked'
          ? <span className="text-xs text-green-600">已立项</span>
          : <button className="rounded border px-2 py-1 text-xs disabled:opacity-50"
              disabled={picking} onClick={() => onPick(c.repo)}>立项</button>}
        <button className="rounded border px-2 py-1 text-xs text-neutral-500 disabled:opacity-50"
          disabled={rescoring} onClick={() => onRescore(c.id)}>{rescoring ? '评分中…' : '重新评分'}</button>
      </div>
    </div>
  )
}
