import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import ReactMarkdown from 'react-markdown'
import { useParams } from 'react-router-dom'
import { api, subscribeTask, type Project } from '../api'
import CutPlanEditor from './CutPlanEditor'

const FIELDS = [
  { key: 'brand_name', label: '品牌名' },
  { key: 'target_buyer', label: '买家画像' },
  { key: 'demo_url', label: 'Demo 地址' },
  { key: 'price_deploy', label: '部署价（元）', number: true },
  { key: 'price_custom', label: '定制起步价（元）', number: true },
] as const

export default function ProjectDetailPage() {
  const { slug = '' } = useParams()
  const qc = useQueryClient()
  const [form, setForm] = useState<Record<string, string>>({})
  const [analyzing, setAnalyzing] = useState(false)
  const [analyzeLog, setAnalyzeLog] = useState<string[]>([])

  async function analyze() {
    if (analyzing) return
    setAnalyzing(true)
    setAnalyzeLog([])
    try {
      const { taskId } = await api<{ taskId: string }>(`/api/projects/${slug}/analyze`, { method: 'POST' })
      subscribeTask(taskId, (e) => {
        setAnalyzeLog((l) => [...l, `${e.type === 'error' ? '❌ ' : ''}${e.message}`])
        if (e.type === 'done' || e.type === 'error') {
          setAnalyzing(false)
          qc.invalidateQueries({ queryKey: ['project', slug] })
        }
      })
    } catch (err) {
      setAnalyzeLog((l) => [...l, `❌ ${err instanceof Error ? err.message : String(err)}`])
      setAnalyzing(false)
    }
  }

  const project = useQuery({
    queryKey: ['project', slug],
    queryFn: () => api<Project>(`/api/projects/${slug}`),
  })
  const raw = useQuery({
    queryKey: ['raw', slug],
    queryFn: () => api<{ files: string[] }>(`/api/projects/${slug}/raw`),
  })
  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api(`/api/projects/${slug}`, { method: 'PATCH', body: JSON.stringify(body) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['project', slug] }),
  })

  async function upload(file: File) {
    const fd = new FormData()
    fd.append('file', file)
    const res = await fetch(`/api/projects/${slug}/raw`, { method: 'POST', body: fd })
    if (!res.ok) alert(`上传失败: ${await res.text()}`)
    qc.invalidateQueries({ queryKey: ['raw', slug] })
  }

  if (!project.data) return <div className="text-neutral-400">加载中…</div>
  const p = project.data

  return (
    <div className="grid grid-cols-[1fr_360px] gap-6">
      <div className="rounded-lg border bg-white p-6 text-sm leading-relaxed [&_h1]:text-xl [&_h1]:font-bold [&_h2]:font-bold [&_h2]:mt-4 [&_li]:ml-4">
        <div className="mb-3 flex items-center gap-3 border-b pb-2">
          <button className="rounded bg-blue-600 px-3 py-1 text-sm text-white disabled:opacity-50"
            disabled={analyzing} onClick={analyze}>
            {analyzing ? '分析中…' : (p.analysisMd ? '重新生成分析' : '生成分析')}
          </button>
          <span className="text-xs text-neutral-400">读 source/README 生成 analysis.md</span>
        </div>
        {analyzeLog.length > 0 && (
          <div className="mb-3 rounded bg-neutral-900 p-2 text-xs text-green-400 font-mono max-h-32 overflow-y-auto space-y-1">
            {analyzeLog.map((l, i) => <div key={i}>{l}</div>)}
          </div>
        )}
        {p.analysisMd
          ? <ReactMarkdown>{p.analysisMd}</ReactMarkdown>
          : <div className="text-neutral-400">暂无 analysis.md——在 workspace/{slug}/ 下补充分析报告</div>}
      </div>
      <div className="space-y-4">
        <div className="rounded-lg border bg-white p-4 space-y-3">
          <h3 className="font-semibold">项目信息 · {p.slug}（{p.stage}）</h3>
          {FIELDS.map((f) => (
            <div key={f.key}>
              <label className="text-xs text-neutral-500">{f.label}</label>
              <input className="mt-0.5 w-full rounded border px-2 py-1 text-sm"
                defaultValue={(p as any)[f.key] ?? ''}
                onChange={(e) => setForm((s) => ({ ...s, [f.key]: e.target.value }))} />
            </div>
          ))}
          <button className="w-full rounded bg-blue-600 py-1.5 text-sm text-white"
            onClick={() => save.mutate(Object.fromEntries(
              Object.entries(form).map(([k, v]) => [k, FIELDS.find((f) => f.key === k && 'number' in f && (f as any).number) ? Number(v) : v]),
            ))}>保存</button>
        </div>
        <div className="rounded-lg border bg-white p-4 space-y-2">
          <h3 className="font-semibold">raw 素材（录屏/截图）</h3>
          <input type="file" className="text-sm"
            onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
          <ul className="text-sm text-neutral-600 space-y-1">
            {raw.data?.files.map((f) => (
              <li key={f}><a className="text-blue-600" href={`/files/${slug}/raw/${f}`} target="_blank" rel="noreferrer">{f}</a></li>
            ))}
            {raw.data?.files.length === 0 && <li className="text-neutral-400">暂无</li>}
          </ul>
        </div>
        <CutPlanEditor slug={slug} />
      </div>
    </div>
  )
}
