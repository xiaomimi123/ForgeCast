import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, subscribeTask, type Asset, type Project } from '../api'
import AssetCard from '../components/AssetCard'

const HOOKS = [
  { value: 'pain', label: '行业痛点型' },
  { value: 'sideline', label: '副业型' },
  { value: 'infogap', label: '信息差型' },
  { value: 'story', label: '接单故事型' },
]

export default function WorkshopPage() {
  const qc = useQueryClient()
  const [slug, setSlug] = useState('')
  const [hook, setHook] = useState('pain')
  const [n, setN] = useState(1)
  const [logs, setLogs] = useState<string[]>([])
  const [running, setRunning] = useState(false)
  const logRef = useRef<HTMLDivElement>(null)

  const projects = useQuery({ queryKey: ['projects'], queryFn: () => api<Project[]>('/api/projects') })
  const selected = slug || projects.data?.[0]?.slug || ''
  const assets = useQuery({
    queryKey: ['assets', selected],
    queryFn: () => api<Asset[]>(`/api/projects/${selected}/assets`),
    enabled: !!selected,
  })

  async function generate(feedback?: string) {
    if (!selected || running) return
    setRunning(true)
    setLogs([])
    try {
      const { taskId } = await api<{ taskId: string }>(`/api/projects/${selected}/copy`, {
        method: 'POST', body: JSON.stringify({ hook, n, feedback }),
      })
      subscribeTask(taskId, (e) => {
        setLogs((l) => [...l, `${e.type === 'error' ? '❌ ' : ''}${e.message}`])
        logRef.current?.scrollTo({ top: 999999 })
        if (e.type === 'done' || e.type === 'error') {
          setRunning(false)
          qc.invalidateQueries({ queryKey: ['assets', selected] })
        }
      })
    } catch (err) {
      setLogs((l) => [...l, `❌ ${err instanceof Error ? err.message : String(err)}`])
      setRunning(false)
    }
  }

  async function makeVideo(assetId: number) {
    if (!selected || running) return
    setRunning(true)
    setLogs([])
    try {
      const { taskId } = await api<{ taskId: string }>(`/api/projects/${selected}/video`, {
        method: 'POST', body: JSON.stringify({ assetId }),
      })
      subscribeTask(taskId, (e) => {
        setLogs((l) => [...l, `${e.type === 'error' ? '❌ ' : ''}${e.message}`])
        logRef.current?.scrollTo({ top: 999999 })
        if (e.type === 'done' || e.type === 'error') {
          setRunning(false)
          qc.invalidateQueries({ queryKey: ['assets', selected] })
        }
      })
    } catch (err) {
      setLogs((l) => [...l, `❌ ${err instanceof Error ? err.message : String(err)}`])
      setRunning(false)
    }
  }

  return (
    <div className="grid grid-cols-[320px_1fr] gap-6">
      {/* 左侧：生成面板 */}
      <div className="space-y-4">
        <div className="rounded-lg border bg-white p-4 space-y-3">
          <div>
            <label className="text-sm text-neutral-500">项目</label>
            <select className="mt-1 w-full rounded border p-2" value={selected} onChange={(e) => setSlug(e.target.value)}>
              {projects.data?.map((p) => <option key={p.slug} value={p.slug}>{p.brand_name ?? p.slug}</option>)}
            </select>
            {selected && <Link to={`/projects/${selected}`} className="text-xs text-blue-600">查看项目详情 →</Link>}
          </div>
          <div>
            <label className="text-sm text-neutral-500">钩子类型</label>
            <div className="mt-1 grid grid-cols-2 gap-2">
              {HOOKS.map((h) => (
                <button key={h.value}
                  className={`rounded border px-2 py-1.5 text-sm ${hook === h.value ? 'border-blue-600 bg-blue-50 text-blue-700' : ''}`}
                  onClick={() => setHook(h.value)}>{h.label}</button>
              ))}
            </div>
          </div>
          <div>
            <label className="text-sm text-neutral-500">篇数</label>
            <input type="number" min={1} max={5} className="mt-1 w-full rounded border p-2"
              value={n} onChange={(e) => setN(Number(e.target.value))} />
          </div>
          <button className="w-full rounded bg-blue-600 py-2 text-white disabled:opacity-50"
            disabled={!selected || running} onClick={() => generate()}>
            {running ? '生成中…' : '生成'}
          </button>
        </div>
        {logs.length > 0 && (
          <div ref={logRef} className="rounded-lg border bg-neutral-900 p-3 text-xs text-green-400 font-mono h-48 overflow-y-auto space-y-1">
            {logs.map((l, i) => <div key={i}>{l}</div>)}
          </div>
        )}
      </div>
      {/* 右侧：素材列表 */}
      <div className="space-y-4">
        {assets.data?.length === 0 && <div className="text-neutral-400 text-sm">暂无素材，点左侧「生成」</div>}
        {assets.data?.map((a) => (
          <AssetCard key={a.id} asset={a} onRegenerate={(fb) => generate(fb)} onVideo={(id) => makeVideo(id)} />
        ))}
      </div>
    </div>
  )
}
