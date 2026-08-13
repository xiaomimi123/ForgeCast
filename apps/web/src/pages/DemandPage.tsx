import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { api, subscribeTask, type DemandCollectStatus, type DemandMatch, type DemandSignal } from '../api'

const KIND_CHIPS = [
  { value: '', label: '全部' },
  { value: 'traffic', label: '热点流量' },
  { value: 'emotional', label: '情绪价值' },
  { value: 'supply', label: '供给热度' },
]
const SOURCE_LABELS: Record<string, string> = {
  douyin_hot: '抖音热点', xhs: '小红书', github_trending: 'GitHub', ecommerce: '电商榜单',
}
const KIND_LABELS: Record<string, string> = { traffic: '热点流量', emotional: '情绪价值', supply: '供给热度' }
const BIZ_LABELS: Record<string, string> = { shop: '开店卖货', custom: '私人定制', both: '皆可' }

/** evidence JSON 里挖出 http 链接（对象值/数组元素里的字符串），最多取 2 条 */
function evidenceLinks(evidence: string | null): string[] {
  if (!evidence) return []
  try {
    const v = JSON.parse(evidence)
    const strs = (Array.isArray(v) ? v : Object.values(v as Record<string, unknown>))
      .filter((x): x is string => typeof x === 'string' && x.startsWith('http'))
    return strs.slice(0, 2)
  } catch { return [] }
}

/** 匹配结果单行：repo 元数据 + 模式徽章 + 建议 + 入候选池（任务队列，per-row busy） */
function MatchRow({ m }: { m: DemandMatch }) {
  const [adding, setAdding] = useState(false)
  const [added, setAdded] = useState(false)
  async function addToPool() {
    if (adding || added) return
    setAdding(true)
    try {
      const { taskId } = await api<{ taskId: string }>('/api/candidates/add', {
        method: 'POST', body: JSON.stringify({ url: m.url }),
      })
      subscribeTask(taskId, (e) => {
        if (e.type === 'done' || e.type === 'error') {
          setAdding(false)
          if (e.type === 'error') alert('入池失败：' + e.message)
          else setAdded(true)
        }
      })
    } catch (err) {
      setAdding(false)
      alert('入池失败：' + (err instanceof Error ? err.message : String(err)))
    }
  }
  return (
    <div className="space-y-1 border-t border-hairline pt-2">
      <div className="flex items-center justify-between gap-2">
        <a className="truncate text-sm font-bold text-fire" href={m.url} target="_blank" rel="noreferrer">{m.repo}</a>
        <div className="flex shrink-0 items-center gap-1.5 text-xs text-sub">
          <span>★{m.stars}</span>
          <span>{m.license ?? '无协议'}</span>
          <span>{Math.round(m.score)}分</span>
          <span className="rounded-full bg-fire-soft px-2 py-0.5 font-bold text-fire">{BIZ_LABELS[m.biz_mode]}</span>
        </div>
      </div>
      {m.description && <div className="truncate text-xs text-faint">{m.description}</div>}
      <div className="text-sm">{m.biz_plan}</div>
      <button className="btn-ink px-2 py-0.5 text-xs disabled:opacity-50" disabled={adding || added} onClick={addToPool}>
        {added ? '已入候选池' : adding ? '入池中…' : '入候选池'}
      </button>
    </div>
  )
}

/** 单张需求信号卡片：状态操作 + 找项目（任务队列+SSE）+ 匹配结果展开区 */
function SignalCard({ s, onStatus }: { s: DemandSignal; onStatus: (id: number, status: string) => void }) {
  const qc = useQueryClient()
  const [matching, setMatching] = useState(false)
  const [open, setOpen] = useState(s.status === 'matched')
  const matches = useQuery({
    queryKey: ['demand-matches', s.id],
    queryFn: () => api<DemandMatch[]>(`/api/demand/signals/${s.id}/matches`),
    enabled: s.status === 'matched',
  })
  async function runMatch() {
    if (matching) return
    setMatching(true)
    try {
      const { taskId } = await api<{ taskId: string }>(`/api/demand/signals/${s.id}/match`, { method: 'POST' })
      subscribeTask(taskId, (e) => {
        if (e.type === 'done' || e.type === 'error') {
          setMatching(false)
          qc.invalidateQueries({ queryKey: ['demand'] })
          qc.invalidateQueries({ queryKey: ['demand-matches', s.id] })
          if (e.type === 'error') alert('匹配失败：' + e.message)
          else setOpen(true)
        }
      })
    } catch (err) {
      setMatching(false)
      alert('匹配失败：' + (err instanceof Error ? err.message : String(err)))
    }
  }
  return (
    <div className={`card-forge space-y-2 p-3 ${s.status === 'dismissed' ? 'opacity-50' : ''}`}>
      <div className="flex items-start justify-between gap-2">
        <div className={`font-bold ${s.status === 'starred' ? 'text-fire' : ''}`}>{s.title}</div>
        <div className="flex shrink-0 items-center gap-1.5">
          <button className="btn-fire px-2 py-0.5 text-xs disabled:opacity-50" disabled={matching} onClick={runMatch}>
            {matching ? '匹配中…' : s.status === 'matched' ? '重新匹配' : '找项目'}
          </button>
          {s.status !== 'starred' && s.status !== 'matched' && (
            <button className="btn-ink px-2 py-0.5 text-xs" onClick={() => onStatus(s.id, 'starred')}>看好</button>
          )}
          {s.status !== 'dismissed' && (
            <button className="rounded-md border-[1.5px] border-hairline px-2 py-0.5 text-xs text-sub"
              onClick={() => onStatus(s.id, 'dismissed')}>忽略</button>
          )}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs text-sub">
        <span className="rounded-full border-[1.5px] border-hairline px-2 py-0.5">{SOURCE_LABELS[s.source] ?? s.source}</span>
        {s.kind && <span className="rounded-full border-[1.5px] border-hairline px-2 py-0.5">{KIND_LABELS[s.kind]}</span>}
        {s.heat != null && <span>热度 {s.heat}</span>}
        {s.status === 'starred' && <span className="rounded-full bg-fire-soft px-2 py-0.5 font-bold text-fire">已看好</span>}
        {s.status === 'matched' && <span className="rounded-full bg-fire-soft px-2 py-0.5 font-bold text-fire">已匹配</span>}
      </div>
      {s.summary && <div className="text-sm text-sub">{s.summary}</div>}
      {s.opportunity && <div className="border-t border-hairline pt-2 text-sm">💡 {s.opportunity}</div>}
      {evidenceLinks(s.evidence).map((url) => (
        <a key={url} className="block truncate text-xs text-fire" href={url} target="_blank" rel="noreferrer">{url}</a>
      ))}
      {s.status === 'matched' && (
        <button className="text-xs text-sub underline" onClick={() => setOpen(!open)}>
          {open ? '收起匹配结果' : `展开匹配结果（${matches.data?.length ?? '…'}）`}
        </button>
      )}
      {open && matches.data?.map((m) => <MatchRow key={m.id} m={m} />)}
    </div>
  )
}

export default function DemandPage() {
  const qc = useQueryClient()
  const [kind, setKind] = useState('')
  const [extracting, setExtracting] = useState(false)
  const signals = useQuery({
    queryKey: ['demand', kind],
    queryFn: () => api<DemandSignal[]>(`/api/demand/signals${kind ? `?kind=${kind}` : ''}`),
  })
  const collect = useQuery({ queryKey: ['demand-collect'], queryFn: () => api<DemandCollectStatus>('/api/demand/collect-status') })
  const setStatus = useMutation({
    mutationFn: ({ id, status }: { id: number; status: string }) =>
      api(`/api/demand/signals/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['demand'] }),
  })
  const requestCollect = useMutation({
    mutationFn: () => api('/api/demand/request-collect', { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['demand-collect'] }),
  })

  async function extract() {
    if (extracting) return
    setExtracting(true)
    try {
      const { taskId } = await api<{ taskId: string }>('/api/demand/extract', { method: 'POST' })
      subscribeTask(taskId, (e) => {
        if (e.type === 'done' || e.type === 'error') {
          setExtracting(false)
          qc.invalidateQueries({ queryKey: ['demand'] })
          if (e.type === 'error') alert('提炼失败：' + e.message)
        }
      })
    } catch (err) {
      setExtracting(false)
      alert('提炼失败：' + (err instanceof Error ? err.message : String(err)))
    }
  }

  const pendingCount = (signals.data ?? []).filter((s) => !s.kind).length
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {KIND_CHIPS.map((k) => (
          <button key={k.value}
            className={`rounded-full border-[1.5px] px-3 py-1 text-sm ${kind === k.value ? 'border-fire bg-fire-soft font-bold text-fire' : 'border-hairline text-sub'}`}
            onClick={() => setKind(k.value)}>{k.label}</button>
        ))}
        <div className="ml-auto flex items-center gap-3">
          <span className="text-xs text-faint">
            {collect.data?.requestedAt
              ? `待采集（请求于 ${collect.data.requestedAt.slice(0, 16).replace('T', ' ')}）`
              : collect.data?.lastCollectedAt
                ? `上次采集：${collect.data.lastCollectedAt.slice(0, 16).replace('T', ' ')}`
                : '从未采集'}
          </span>
          <button className="btn-ink px-3 py-1 text-sm" onClick={() => requestCollect.mutate()}>请求采集</button>
          <button className="btn-fire px-3 py-1 text-sm disabled:opacity-50" disabled={extracting || pendingCount === 0} onClick={extract}>
            {extracting ? '提炼中…' : `提炼分类${pendingCount ? `（${pendingCount} 条待分）` : ''}`}
          </button>
        </div>
      </div>
      {signals.data?.length === 0 && (
        <div className="text-sm text-faint">暂无需求信号。点「请求采集」打标记，然后在对话里喊 Claude 用 ego-browser 采一轮。</div>
      )}
      <div className="grid grid-cols-2 gap-4 2xl:grid-cols-3">
        {signals.data?.map((s) => (
          <SignalCard key={s.id} s={s} onStatus={(id, status) => setStatus.mutate({ id, status })} />
        ))}
      </div>
    </div>
  )
}
