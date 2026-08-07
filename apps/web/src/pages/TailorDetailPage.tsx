import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import ReactMarkdown from 'react-markdown'
import { useParams } from 'react-router-dom'
import { api, subscribeTask, type TailorCapability, type TailorDetail } from '../api'

export default function TailorDetailPage() {
  const { id } = useParams()
  const qc = useQueryClient()
  const detail = useQuery({ queryKey: ['tailor', id], queryFn: () => api<TailorDetail>(`/api/tailor/${id}`) })
  const proposal = useQuery({
    queryKey: ['tailor-proposal', id],
    queryFn: () => api<{ md: string }>(`/api/tailor/${id}/proposal`),
    enabled: detail.data?.request.status === 'proposed',
    retry: false,
  })
  const [logs, setLogs] = useState<string[]>([])
  const [running, setRunning] = useState<'decompose' | 'search' | 'proposal' | null>(null)

  async function runAction(action: 'decompose' | 'search' | 'proposal') {
    if (running) return
    if (action === 'decompose' && (detail.data?.capabilities.length ?? 0) > 0
      && !window.confirm('重新拆解会清掉现有能力清单和已搜的轮子，继续？')) return
    setRunning(action); setLogs([])
    try {
      const { taskId } = await api<{ taskId: string }>(`/api/tailor/${id}/${action}`, { method: 'POST', body: '{}' })
      subscribeTask(taskId, (e) => {
        setLogs((l) => [...l, e.message])
        if (e.type === 'done' || e.type === 'error') {
          setRunning(null)
          qc.invalidateQueries({ queryKey: ['tailor', id] })
          qc.invalidateQueries({ queryKey: ['tailor-proposal', id] })
        }
      })
    } catch (err) { alert(err instanceof Error ? err.message : String(err)); setRunning(null) }
  }

  async function patchCap(capId: number, patch: Record<string, unknown>) {
    try {
      await api(`/api/tailor/capabilities/${capId}`, { method: 'PATCH', body: JSON.stringify(patch) })
      qc.invalidateQueries({ queryKey: ['tailor', id] })
    } catch (e) { alert(e instanceof Error ? e.message : String(e)) }
  }
  async function removeCap(capId: number) {
    if (!window.confirm('删除该能力项及其轮子候选？')) return
    await api(`/api/tailor/capabilities/${capId}`, { method: 'DELETE' })
    qc.invalidateQueries({ queryKey: ['tailor', id] })
  }
  const [newCap, setNewCap] = useState({ name: '', keywords: '' })
  async function addCap() {
    if (!newCap.name.trim()) return
    try {
      await api(`/api/tailor/${id}/capabilities`, {
        method: 'POST',
        body: JSON.stringify({ name: newCap.name, keywords: newCap.keywords.split(/[,，]/).map((s) => s.trim()).filter(Boolean) }),
      })
      setNewCap({ name: '', keywords: '' })
      qc.invalidateQueries({ queryKey: ['tailor', id] })
    } catch (e) { alert(e instanceof Error ? e.message : String(e)) }
  }

  const d = detail.data
  if (!d) return <div className="text-neutral-400">{detail.isError ? '需求不存在' : '加载中…'}</div>
  const caps = d.capabilities
  const pendingCount = caps.filter((c) => c.decision === 'pending').length
  const btn = 'rounded bg-blue-600 px-4 py-2 text-sm text-white disabled:opacity-50'
  return (
    <div className="space-y-4">
      <div className="rounded-lg border bg-white p-4">
        <div className="flex items-center justify-between">
          <div className="font-semibold">#{d.request.id} {d.request.title}</div>
          <span className="text-xs text-neutral-500">{d.request.status}</span>
        </div>
        <div className="mt-2 whitespace-pre-wrap text-sm text-neutral-600">{d.request.raw_need}</div>
        <div className="mt-3 flex gap-2">
          <button className={btn} disabled={!!running} onClick={() => runAction('decompose')}>
            {running === 'decompose' ? '拆解中…' : caps.length ? '重新拆解' : '拆解需求'}
          </button>
          <button className={btn} disabled={!!running || d.request.status === 'draft'} onClick={() => runAction('search')}>
            {running === 'search' ? '搜索中…' : '搜轮子'}
          </button>
          <button className={btn} disabled={!!running || !caps.length || pendingCount > 0}
            title={pendingCount ? `还有 ${pendingCount} 项未决策` : ''} onClick={() => runAction('proposal')}>
            {running === 'proposal' ? '生成中…' : '生成方案书'}
          </button>
          {pendingCount > 0 && caps.length > 0 && <span className="self-center text-xs text-neutral-400">每项能力选「轮子/自研/不做」后才能出方案书</span>}
        </div>
      </div>
      {logs.length > 0 && (
        <div className="max-h-32 space-y-1 overflow-y-auto rounded-lg border bg-neutral-900 p-3 font-mono text-xs text-green-400">
          {logs.map((l, i) => <div key={i}>{l}</div>)}
        </div>
      )}
      {caps.map((c) => <CapabilityCard key={c.id} cap={c} onPatch={patchCap} onRemove={removeCap} />)}
      {caps.length > 0 && (
        <div className="flex gap-2">
          <input className="rounded border px-2 py-1 text-sm" placeholder="能力名" value={newCap.name}
            onChange={(e) => setNewCap((s) => ({ ...s, name: e.target.value }))} />
          <input className="w-64 rounded border px-2 py-1 text-sm" placeholder="GitHub 搜索关键词，逗号分隔" value={newCap.keywords}
            onChange={(e) => setNewCap((s) => ({ ...s, keywords: e.target.value }))} />
          <button className="rounded border px-3 py-1 text-sm" onClick={addCap}>+ 加能力项</button>
        </div>
      )}
      {proposal.data?.md && (
        <div className="rounded-lg border bg-white p-6 text-sm leading-relaxed [&_h1]:text-lg [&_h1]:font-bold [&_h2]:mt-4 [&_h2]:font-semibold [&_table]:my-2 [&_td]:border [&_td]:px-2 [&_th]:border [&_th]:px-2">
          <ReactMarkdown>{proposal.data.md}</ReactMarkdown>
        </div>
      )}
    </div>
  )
}

function CapabilityCard({ cap, onPatch, onRemove }: {
  cap: TailorCapability
  onPatch: (capId: number, patch: Record<string, unknown>) => void
  onRemove: (capId: number) => void
}) {
  const okWheels = cap.wheels.filter((w) => w.license_ok === 1)
  const badWheels = cap.wheels.filter((w) => w.license_ok !== 1)
  const badge = cap.decision === 'wheel' ? `✔ ${cap.chosen_repo}`
    : cap.decision === 'self_build' ? '自研' : cap.decision === 'dropped' ? '不做' : '待决策'
  return (
    <div className={`rounded-lg border bg-white p-4 ${cap.decision === 'dropped' ? 'opacity-50' : ''}`}>
      <div className="flex items-center justify-between">
        <div className="font-medium">
          {cap.name}
          <span className="ml-2 rounded-full border px-2 py-0.5 text-xs text-neutral-500">{badge}</span>
        </div>
        <div className="flex gap-2 text-xs">
          <button className="rounded border px-2 py-1" onClick={() => onPatch(cap.id, { decision: 'self_build' })}>标自研</button>
          <button className="rounded border px-2 py-1" onClick={() => onPatch(cap.id, { decision: 'dropped' })}>不做</button>
          <button className="rounded border px-2 py-1 text-red-500" onClick={() => onRemove(cap.id)}>删除</button>
        </div>
      </div>
      {cap.detail && <div className="mt-1 text-sm text-neutral-500">{cap.detail}</div>}
      <div className="mt-1 text-xs text-neutral-400">关键词: {cap.keywords.join(', ') || '—'}</div>
      {okWheels.length > 0 && (
        <div className="mt-2 grid gap-2 md:grid-cols-2">
          {okWheels.map((w) => (
            <label key={w.id} className={`flex cursor-pointer items-start gap-2 rounded border p-2 text-sm ${cap.decision === 'wheel' && cap.chosen_repo === w.repo ? 'border-blue-500 bg-blue-50' : ''}`}>
              <input type="radio" className="mt-1" checked={cap.decision === 'wheel' && cap.chosen_repo === w.repo}
                onChange={() => onPatch(cap.id, { decision: 'wheel', chosenRepo: w.repo })} />
              <span>
                <a className="font-medium text-blue-600" href={w.url} target="_blank" rel="noreferrer"
                  onClick={(e) => e.stopPropagation()}>{w.repo}</a>
                <span className="ml-2 text-xs text-neutral-400">{w.score} 分 · ⭐{w.stars} · {w.license ?? '无协议'}</span>
                {w.description && <span className="block text-xs text-neutral-500">{w.description}</span>}
              </span>
            </label>
          ))}
        </div>
      )}
      {badWheels.length > 0 && (
        <details className="mt-2 text-xs text-neutral-500">
          <summary className="cursor-pointer">另有 {badWheels.length} 个协议非白名单轮子（GPL 系等，仅客户内部部署可考虑）</summary>
          <div className="mt-1 space-y-1">
            {badWheels.map((w) => (
              <label key={w.id} className="flex items-center gap-2">
                <input type="radio" checked={cap.decision === 'wheel' && cap.chosen_repo === w.repo}
                  onChange={() => onPatch(cap.id, { decision: 'wheel', chosenRepo: w.repo })} />
                <a className="text-neutral-600" href={w.url} target="_blank" rel="noreferrer">{w.repo}</a>
                <span>⚠ {w.license ?? '无协议'} · {w.score} 分</span>
              </label>
            ))}
          </div>
        </details>
      )}
    </div>
  )
}
