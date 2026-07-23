import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, subscribeTask, type Candidate, type Project } from '../api'
import CandidateCard from './board/CandidateCard'

// 立项项目阶段泳道（§8）：analysis→rebranding→producing→publishing→selling
const STAGES: Array<{ key: string; label: string }> = [
  { key: 'analysis', label: '分析' },
  { key: 'rebranding', label: '换皮' },
  { key: 'producing', label: '产素材' },
  { key: 'publishing', label: '发布' },
  { key: 'selling', label: '成交' },
]

export default function BoardPage() {
  const qc = useQueryClient()
  const [logs, setLogs] = useState<string[]>([])
  const [scanning, setScanning] = useState(false)
  const logRef = useRef<HTMLDivElement>(null)

  const navigate = useNavigate()
  const [dragSlug, setDragSlug] = useState<string | null>(null)
  const candidates = useQuery({ queryKey: ['candidates'], queryFn: () => api<Candidate[]>('/api/candidates') })
  const projects = useQuery({ queryKey: ['projects'], queryFn: () => api<Project[]>('/api/projects') })
  const pick = useMutation({
    mutationFn: (repo: string) => api('/api/candidates/pick', { method: 'POST', body: JSON.stringify({ repo }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['candidates'] }),
    onError: (e) => alert(`立项失败: ${e instanceof Error ? e.message : String(e)}`),
  })
  const moveStage = useMutation({
    mutationFn: ({ slug, stage }: { slug: string; stage: string }) =>
      api(`/api/projects/${slug}`, { method: 'PATCH', body: JSON.stringify({ stage }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['projects'] }),
    onError: (e) => alert(`移动失败: ${e instanceof Error ? e.message : String(e)}`),
  })
  const [rescoreId, setRescoreId] = useState<number | null>(null)
  const rescore = useMutation({
    mutationFn: (id: number) => { setRescoreId(id); return api<{ ok: boolean; mode: string }>(`/api/candidates/${id}/rescore`, { method: 'POST' }) },
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['candidates'] })
      if (r.mode === 'mock') alert('当前是 mock 模式，评分不会产生目标群体/行业痛点。去「设置」把大模型切到 live 并填 key。')
    },
    onError: (e) => alert(`重新评分失败: ${e instanceof Error ? e.message : String(e)}`),
    onSettled: () => setRescoreId(null),
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

  const rows = candidates.data ?? []
  const ok = rows.filter((c) => c.license_ok === 1)
  const blocked = rows.filter((c) => c.license_ok !== 1)
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <button className="rounded bg-blue-600 px-4 py-2 text-sm text-white disabled:opacity-50" disabled={scanning} onClick={scout}>
          {scanning ? '抓取中…' : '抓取候选'}
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
            picking={pick.isPending} rescoring={rescore.isPending && rescoreId === c.id} />
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

      {/* 立项项目 stage 泳道：拖拽卡片在阶段间流转（§8） */}
      <div>
        <div className="mb-2 text-sm font-medium text-neutral-600">立项项目 · 拖拽卡片流转阶段</div>
        <div className="flex gap-3 overflow-x-auto pb-2">
          {STAGES.map((s) => {
            const items = (projects.data ?? []).filter((p) => p.stage === s.key)
            return (
              <div key={s.key}
                className="min-w-[180px] flex-1 rounded-lg border bg-neutral-50 p-2"
                onDragOver={(e) => e.preventDefault()}
                onDrop={() => { if (dragSlug) moveStage.mutate({ slug: dragSlug, stage: s.key }); setDragSlug(null) }}>
                <div className="mb-2 flex items-center justify-between px-1 text-xs font-medium text-neutral-500">
                  <span>{s.label}</span><span>{items.length}</span>
                </div>
                <div className="space-y-2">
                  {items.map((p) => (
                    <div key={p.id} draggable
                      onDragStart={() => setDragSlug(p.slug)}
                      onDragEnd={() => setDragSlug(null)}
                      onClick={() => navigate(`/projects/${p.slug}`)}
                      className="cursor-grab rounded border bg-white p-2 text-sm shadow-sm hover:border-blue-400 active:cursor-grabbing">
                      <div className="font-medium">{p.brand_name || p.slug}</div>
                      <div className="text-xs text-neutral-400">{p.slug}</div>
                    </div>
                  ))}
                  {items.length === 0 && <div className="rounded border border-dashed p-3 text-center text-xs text-neutral-300">拖到此</div>}
                </div>
              </div>
            )
          })}
        </div>
        {projects.isSuccess && projects.data.length === 0 && <div className="mt-1 text-xs text-neutral-400">暂无立项项目，先在候选表点「立项」</div>}
      </div>
    </div>
  )
}
