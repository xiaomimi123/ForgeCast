import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import ReactMarkdown from 'react-markdown'
import { api, type TailorCapability, type TailorDetail } from '../api'
import Drawer from '../components/Drawer'
import TaskProgress from '../components/TaskProgress'
import { useTaskRun } from '../useTaskRun'

export default function TailorDrawer({ id, onClose }: { id: number; onClose: () => void }) {
  const qc = useQueryClient()
  const detail = useQuery({ queryKey: ['tailor', id], queryFn: () => api<TailorDetail>(`/api/tailor/${id}`) })
  const proposal = useQuery({
    queryKey: ['tailor-proposal', id],
    queryFn: () => api<{ md: string }>(`/api/tailor/${id}/proposal`),
    enabled: detail.data?.request.status === 'proposed',
    retry: false,
  })
  const [activeKey, setActiveKey] = useState<'decompose' | 'search' | 'proposal'>('decompose')
  const decomposeRun = useTaskRun()
  const searchRun = useTaskRun()
  const proposalRun = useTaskRun()
  const runs = { decompose: decomposeRun, search: searchRun, proposal: proposalRun }
  const activeRun = runs[activeKey]
  const busy = decomposeRun.running || searchRun.running || proposalRun.running

  function runAction(action: 'decompose' | 'search' | 'proposal') {
    if (action === 'decompose' && (detail.data?.capabilities.length ?? 0) > 0
      && !window.confirm('重新拆解会清掉现有能力清单和已搜的轮子，继续？')) return
    setActiveKey(action)
    const r = action === 'decompose' ? decomposeRun : action === 'search' ? searchRun : proposalRun
    r.run(
      async () => (await api<{ taskId: string }>(`/api/tailor/${id}/${action}`, { method: 'POST', body: '{}' })).taskId,
      (ok, e) => {
        qc.invalidateQueries({ queryKey: ['tailor', id] })
        qc.invalidateQueries({ queryKey: ['tailor-proposal', id] })
        if (!ok) alert(e?.message ?? '任务失败')
      },
    )
  }

  async function patchCap(capId: number, patch: Record<string, unknown>) {
    try {
      await api(`/api/tailor/capabilities/${capId}`, { method: 'PATCH', body: JSON.stringify(patch) })
      qc.invalidateQueries({ queryKey: ['tailor', id] })
    } catch (e) { alert(e instanceof Error ? e.message : String(e)) }
  }
  async function removeCap(capId: number) {
    if (!window.confirm('删除该能力项及其轮子候选？')) return
    try {
      await api(`/api/tailor/capabilities/${capId}`, { method: 'DELETE' })
      qc.invalidateQueries({ queryKey: ['tailor', id] })
    } catch (e) { alert(e instanceof Error ? e.message : String(e)) }
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
  if (!d) return <Drawer onClose={onClose}><div className="text-faint">{detail.isError ? '需求不存在' : '加载中…'}</div></Drawer>
  const caps = d.capabilities
  const pendingCount = caps.filter((c) => c.decision === 'pending').length
  const btn = 'btn px-4 py-2 text-sm disabled:opacity-50'
  return (
    <Drawer onClose={onClose} width={900}>
      <div className="space-y-4">
        <div className="card p-4">
          <div className="flex items-center justify-between">
            <div className="font-semibold">#{d.request.id} {d.request.title}</div>
            <span className="text-xs text-sub">{d.request.status}</span>
          </div>
          <div className="mt-2 whitespace-pre-wrap text-sm text-sub">{d.request.raw_need}</div>
          <div className="mt-3 flex gap-2">
            <button className={btn} disabled={busy} onClick={() => runAction('decompose')}>
              {decomposeRun.running ? '拆解中…' : caps.length ? '重新拆解' : '拆解需求'}
            </button>
            <button className={btn} disabled={busy || d.request.status === 'draft'} onClick={() => runAction('search')}>
              {searchRun.running ? '搜索中…' : '搜轮子'}
            </button>
            <button className={btn} disabled={busy || !caps.length || pendingCount > 0}
              title={pendingCount ? `还有 ${pendingCount} 项未决策` : ''} onClick={() => runAction('proposal')}>
              {proposalRun.running ? '生成中…' : '生成方案书'}
            </button>
            {pendingCount > 0 && caps.length > 0 && <span className="self-center text-xs text-faint">每项能力选「轮子/自研/不做」后才能出方案书</span>}
            <TaskProgress run={activeRun} className="self-center max-w-[320px]" />
          </div>
        </div>
        {activeRun.logs.length > 0 && (
          <div className="max-h-32 space-y-1 overflow-y-auto rounded-lg border bg-neutral-900 p-3 font-mono text-xs text-green-400">
            {activeRun.logs.map((l, i) => <div key={i}>{l}</div>)}
          </div>
        )}
        {caps.map((c) => <CapabilityCard key={c.id} cap={c} onPatch={patchCap} onRemove={removeCap} />)}
        {caps.length > 0 && (
          <div className="flex gap-2">
            <input className="rounded-md border border-hairline-strong bg-card px-2 py-1 text-sm" placeholder="能力名" value={newCap.name}
              onChange={(e) => setNewCap((s) => ({ ...s, name: e.target.value }))} />
            <input className="w-64 rounded-md border border-hairline-strong bg-card px-2 py-1 text-sm" placeholder="GitHub 搜索关键词，逗号分隔" value={newCap.keywords}
              onChange={(e) => setNewCap((s) => ({ ...s, keywords: e.target.value }))} />
            <button className="btn ghost px-3 py-1 text-sm" onClick={addCap}>+ 加能力项</button>
          </div>
        )}
        {proposal.data?.md && (
          <div className="card p-6 text-sm leading-relaxed [&_h1]:text-lg [&_h1]:font-bold [&_h2]:mt-4 [&_h2]:font-semibold [&_table]:my-2 [&_td]:border [&_td]:px-2 [&_th]:border [&_th]:px-2">
            <ReactMarkdown>{proposal.data.md}</ReactMarkdown>
          </div>
        )}
      </div>
    </Drawer>
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
    <div className={`card p-4 ${cap.decision === 'dropped' ? 'opacity-50' : ''}`}>
      <div className="flex items-center justify-between">
        <div className="font-medium">
          {cap.name}
          <span className="chip ml-2">{badge}</span>
        </div>
        <div className="flex gap-2 text-xs">
          <button className="rounded-md border border-hairline-strong px-2 py-1 text-xs" onClick={() => onPatch(cap.id, { decision: 'self_build' })}>标自研</button>
          <button className="rounded-md border border-hairline-strong px-2 py-1 text-xs" onClick={() => onPatch(cap.id, { decision: 'dropped' })}>不做</button>
          <button className="rounded-md border border-danger px-2 py-1 text-xs text-danger" onClick={() => onRemove(cap.id)}>删除</button>
        </div>
      </div>
      {cap.detail && <div className="mt-1 text-sm text-sub">{cap.detail}</div>}
      <div className="mt-1 text-xs text-faint">关键词: {cap.keywords.join(', ') || '—'}</div>
      {okWheels.length > 0 && (
        <div className="mt-2 grid gap-2 md:grid-cols-2">
          {okWheels.map((w) => (
            <label key={w.id} className={`flex cursor-pointer items-start gap-2 rounded-md border p-2 text-sm ${cap.decision === 'wheel' && cap.chosen_repo === w.repo ? 'border-fire bg-fire-soft' : 'border-hairline-strong bg-card'}`}>
              <input type="radio" className="mt-1" checked={cap.decision === 'wheel' && cap.chosen_repo === w.repo}
                onChange={() => onPatch(cap.id, { decision: 'wheel', chosenRepo: w.repo })} />
              <span>
                <a className="font-medium text-fire" href={w.url} target="_blank" rel="noreferrer"
                  onClick={(e) => e.stopPropagation()}>{w.repo}</a>
                <span className="ml-2 text-xs text-faint">{w.score} 分 · ⭐{w.stars} · {w.license ?? '无协议'}</span>
                {w.description && <span className="block text-xs text-sub">{w.description}</span>}
              </span>
            </label>
          ))}
        </div>
      )}
      {badWheels.length > 0 && (
        <details className="mt-2 text-xs text-sub">
          <summary className="cursor-pointer">另有 {badWheels.length} 个协议非白名单轮子（GPL 系等，仅客户内部部署可考虑）</summary>
          <div className="mt-1 space-y-1">
            {badWheels.map((w) => (
              <label key={w.id} className="flex items-center gap-2">
                <input type="radio" checked={cap.decision === 'wheel' && cap.chosen_repo === w.repo}
                  onChange={() => onPatch(cap.id, { decision: 'wheel', chosenRepo: w.repo })} />
                <a className="text-sub" href={w.url} target="_blank" rel="noreferrer">{w.repo}</a>
                <span>⚠ {w.license ?? '无协议'} · {w.score} 分</span>
              </label>
            ))}
          </div>
        </details>
      )}
    </div>
  )
}
