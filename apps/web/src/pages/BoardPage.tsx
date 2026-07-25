import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useRef, useState } from 'react'
import { api, subscribeTask, type Candidate, type Project } from '../api'
import CandidateCard from './board/CandidateCard'
import StageLanes from './board/StageLanes'

export default function BoardPage() {
  const qc = useQueryClient()
  const [logs, setLogs] = useState<string[]>([])
  const [scanning, setScanning] = useState(false)
  const logRef = useRef<HTMLDivElement>(null)

  const candidates = useQuery({ queryKey: ['candidates'], queryFn: () => api<Candidate[]>('/api/candidates') })
  const projects = useQuery({ queryKey: ['projects'], queryFn: () => api<Project[]>('/api/projects') })
  // 并发跟踪：用集合记录"哪些 id/repo 正在请求中"，每次 mutate 只增删自己那一个，
  // 避免共享单值 state 被先完成的请求提前清空、误伤仍在飞行中的其他卡片
  const [pickingRepos, setPickingRepos] = useState<Set<string>>(new Set())
  const pick = useMutation({
    mutationFn: (repo: string) => api('/api/candidates/pick', { method: 'POST', body: JSON.stringify({ repo }) }),
    onMutate: (repo) => setPickingRepos((prev) => new Set(prev).add(repo)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['candidates'] }),
    onError: (e) => alert(`立项失败: ${e instanceof Error ? e.message : String(e)}`),
    onSettled: (_data, _error, repo) => setPickingRepos((prev) => { const next = new Set(prev); next.delete(repo); return next }),
  })
  const moveStage = useMutation({
    mutationFn: ({ slug, stage }: { slug: string; stage: string }) =>
      api(`/api/projects/${slug}`, { method: 'PATCH', body: JSON.stringify({ stage }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['projects'] }),
    onError: (e) => alert(`移动失败: ${e instanceof Error ? e.message : String(e)}`),
  })
  const [rescoringIds, setRescoringIds] = useState<Set<number>>(new Set())
  const rescore = useMutation({
    mutationFn: (id: number) => api<{ ok: boolean; mode: string }>(`/api/candidates/${id}/rescore`, { method: 'POST' }),
    onMutate: (id) => setRescoringIds((prev) => new Set(prev).add(id)),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['candidates'] })
      if (r.mode === 'mock') alert('当前是 mock 模式，评分不会产生目标群体/行业痛点。去「设置」把大模型切到 live 并填 key。')
    },
    onError: (e) => alert(`重新评分失败: ${e instanceof Error ? e.message : String(e)}`),
    onSettled: (_data, _error, id) => setRescoringIds((prev) => { const next = new Set(prev); next.delete(id); return next }),
  })

  async function scout() {
    if (scanning) return
    setScanning(true); setLogs([])
    try {
      const { taskId } = await api<{ taskId: string }>('/api/scout', { method: 'POST', body: '{}' })
      subscribeTask(taskId, (e) => {
        setLogs((l) => [...l, e.message]); logRef.current?.scrollTo({ top: 999999 })
        if (e.type === 'done' || e.type === 'error') { setScanning(false); qc.invalidateQueries({ queryKey: ['candidates'] }) }
      })
    } catch (err) { setLogs((l) => [...l, `❌ ${err instanceof Error ? err.message : String(err)}`]); setScanning(false) }
  }

  const [rescoringAll, setRescoringAll] = useState(false)
  async function rescoreAll() {
    if (rescoringAll || scanning) return
    // 估算未评数：score_detail 里没有非空 targetBuyer 的
    const n = (candidates.data ?? []).filter((c) => {
      try { return !(c.score_detail && (JSON.parse(c.score_detail) as any)?.targetBuyer) } catch { return true }
    }).length
    if (n === 0) { alert('候选都已真评过，无需批量评分'); return }
    if (!window.confirm(`将对 ${n} 个未评候选真评分，消耗 key 额度、耗时较长（每个几秒），继续？`)) return
    setRescoringAll(true); setLogs([])
    try {
      const { taskId } = await api<{ taskId: string }>('/api/candidates/rescore-all', { method: 'POST' })
      subscribeTask(taskId, (e) => {
        setLogs((l) => [...l, e.message]); logRef.current?.scrollTo({ top: 999999 })
        if (e.type === 'done' || e.type === 'error') { setRescoringAll(false); qc.invalidateQueries({ queryKey: ['candidates'] }) }
      })
    } catch (err) { setLogs((l) => [...l, `❌ ${err instanceof Error ? err.message : String(err)}`]); setRescoringAll(false) }
  }

  const rows = candidates.data ?? []
  const ok = rows.filter((c) => c.license_ok === 1)
  const blocked = rows.filter((c) => c.license_ok !== 1)
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <button className="rounded bg-blue-600 px-4 py-2 text-sm text-white disabled:opacity-50" disabled={scanning || rescoringAll} onClick={scout}>
          {scanning ? '抓取中…' : '抓取候选'}
        </button>
        <button className="rounded border px-4 py-2 text-sm disabled:opacity-50" disabled={scanning || rescoringAll} onClick={rescoreAll}>
          {rescoringAll ? '评分中…' : '全部重新评分'}
        </button>
        <span className="text-sm text-neutral-500">共 {rows.length} 个候选</span>
      </div>
      {logs.length > 0 && (
        <div ref={logRef} className="rounded-lg border bg-neutral-900 p-3 text-xs text-green-400 font-mono h-32 overflow-y-auto space-y-1">
          {logs.map((l, i) => <div key={i}>{l}</div>)}
        </div>
      )}
      {/* 候选卡片：协议可商用的排前面，不可商用的折叠到底部 */}
      <div className="grid gap-3 md:grid-cols-2">
        {ok.map((c, i) => (
          <CandidateCard key={c.id} c={c} rank={i + 1}
            onPick={(repo) => pick.mutate(repo)} onRescore={(id) => rescore.mutate(id)}
            picking={pickingRepos.has(c.repo)} rescoring={rescoringIds.has(c.id)} />
        ))}
      </div>
      {rows.length === 0 && <div className="rounded-lg border p-6 text-center text-neutral-400">暂无候选，点「抓取候选」</div>}
      {blocked.length > 0 && (
        <details className="rounded-lg border bg-neutral-50 p-3 text-sm text-neutral-500">
          <summary className="cursor-pointer">另有 {blocked.length} 个协议不可商用（GPL/AGPL 系），点开查看</summary>
          <div className="mt-2 space-y-1">
            {blocked.map((c) => (
              <div key={c.id} className="flex gap-2 text-xs">
                <a className="text-neutral-600" href={c.url} target="_blank" rel="noreferrer">{c.repo}</a>
                <span className="text-neutral-400">{c.license ?? '无协议'}</span>
              </div>
            ))}
          </div>
        </details>
      )}

      <StageLanes projects={projects.data ?? []} loaded={projects.isSuccess} onMove={(slug, stage) => moveStage.mutate({ slug, stage })} />
    </div>
  )
}
