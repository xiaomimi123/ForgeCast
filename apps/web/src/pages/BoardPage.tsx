import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, subscribeTask, type Candidate, type Project } from '../api'

// 立项项目阶段泳道（§8）：analysis→rebranding→producing→publishing→selling
const STAGES: Array<{ key: string; label: string }> = [
  { key: 'analysis', label: '分析' },
  { key: 'rebranding', label: '换皮' },
  { key: 'producing', label: '产素材' },
  { key: 'publishing', label: '发布' },
  { key: 'selling', label: '成交' },
]

function dims(sd: string | null): { rebrandCost: number; buyerClarity: number; visualAppeal: number } | null {
  if (!sd) return null
  try { const o = JSON.parse(sd); return { rebrandCost: o.rebrandCost ?? 0, buyerClarity: o.buyerClarity ?? 0, visualAppeal: o.visualAppeal ?? 0 } } catch { return null }
}
function rationale(sd: string | null): string {
  if (!sd) return ''
  try { return JSON.parse(sd).rationale ?? '' } catch { return '' }
}

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
      <div className="overflow-x-auto rounded-lg border bg-white">
        <table className="w-full text-sm">
          <thead className="border-b bg-neutral-50 text-left text-neutral-500">
            <tr><th className="p-2">#</th><th className="p-2">项目</th><th className="p-2">stars</th><th className="p-2">协议</th><th className="p-2">score</th><th className="p-2">换皮/买家/可视</th><th className="p-2">一句话</th><th className="p-2">操作</th></tr>
          </thead>
          <tbody>
            {rows.map((c, i) => {
              const d = dims(c.score_detail)
              const ok = c.license_ok === 1
              return (
                <tr key={c.id} className={`border-b ${ok ? '' : 'bg-neutral-50 text-neutral-400'}`}>
                  <td className="p-2">{i + 1}</td>
                  <td className="p-2"><a className="text-blue-600" href={c.url} target="_blank" rel="noreferrer">{c.repo}</a></td>
                  <td className="p-2">{c.stars}</td>
                  <td className="p-2">{c.license ?? '—'}</td>
                  <td className="p-2 font-medium">{c.score ?? '—'}</td>
                  <td className="p-2 text-xs">{d ? `${d.rebrandCost}/${d.buyerClarity}/${d.visualAppeal}` : '—'}</td>
                  <td className="p-2 text-xs text-neutral-500 max-w-xs truncate">{rationale(c.score_detail)}</td>
                  <td className="p-2">
                    {!ok ? <span className="text-xs">协议不可商用</span>
                      : c.status === 'picked' ? <span className="text-xs text-green-600">已立项</span>
                      : c.status === 'candidate' ? <button className="rounded border px-2 py-1 text-xs" disabled={pick.isPending} onClick={() => pick.mutate(c.repo)}>立项</button>
                      : <span className="text-xs text-neutral-400">{c.status}</span>}
                  </td>
                </tr>
              )
            })}
            {rows.length === 0 && <tr><td colSpan={8} className="p-4 text-center text-neutral-400">暂无候选，点「抓取候选」</td></tr>}
          </tbody>
        </table>
      </div>

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
        {(projects.data ?? []).length === 0 && <div className="mt-1 text-xs text-neutral-400">暂无立项项目，先在候选表点「立项」</div>}
      </div>
    </div>
  )
}
