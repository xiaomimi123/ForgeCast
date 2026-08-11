import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import ReactMarkdown from 'react-markdown'
import { useNavigate, useParams } from 'react-router-dom'
import { api, subscribeTask, type IntroDetail, type Project } from '../api'
import IntroSections from './board/IntroSections'

const FIELDS = [
  { key: 'brand_name', label: '品牌名' },
  { key: 'target_buyer', label: '买家画像' },
  { key: 'demo_url', label: 'Demo 地址' },
  { key: 'price_deploy', label: '部署价（元）', number: true },
  { key: 'price_custom', label: '定制起步价（元）', number: true },
] as const

const DOC_TABS = [
  { key: 'analysis', label: '分析' },
  { key: 'rebrand', label: '换皮清单' },
] as const
type DocTab = (typeof DOC_TABS)[number]['key']

export default function ProjectDetailPage() {
  const { slug = '' } = useParams()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [form, setForm] = useState<Record<string, string>>({})
  const [docTab, setDocTab] = useState<DocTab>('analysis')
  const [analyzing, setAnalyzing] = useState(false)
  const [analyzeLog, setAnalyzeLog] = useState<string[]>([])
  const [rebranding, setRebranding] = useState(false)
  const [rebrandLog, setRebrandLog] = useState<string[]>([])
  const [copied, setCopied] = useState(false)
  const [screensBusy, setScreensBusy] = useState(false)
  const [screensLog, setScreensLog] = useState<string[]>([])

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

  async function rebrand() {
    if (rebranding) return
    setRebranding(true)
    setRebrandLog([])
    try {
      const { taskId } = await api<{ taskId: string }>(`/api/projects/${slug}/rebrand`, { method: 'POST' })
      subscribeTask(taskId, (e) => {
        setRebrandLog((l) => [...l, `${e.type === 'error' ? '❌ ' : ''}${e.message}`])
        if (e.type === 'done' || e.type === 'error') {
          setRebranding(false)
          qc.invalidateQueries({ queryKey: ['project', slug] })
        }
      })
    } catch (err) {
      setRebrandLog((l) => [...l, `❌ ${err instanceof Error ? err.message : String(err)}`])
      setRebranding(false)
    }
  }

  async function generateScreens() {
    if (screensBusy) return
    setScreensBusy(true)
    setScreensLog([])
    try {
      const { taskId } = await api<{ taskId: string }>(`/api/projects/${slug}/screens`, { method: 'POST' })
      subscribeTask(taskId, (e) => {
        setScreensLog((l) => [...l, `${e.type === 'error' ? '❌ ' : ''}${e.message}`])
        if (e.type === 'done' || e.type === 'error') {
          setScreensBusy(false)
          qc.invalidateQueries({ queryKey: ['shots', slug] })
        }
      })
    } catch (err) {
      setScreensLog((l) => [...l, `❌ ${err instanceof Error ? err.message : String(err)}`])
      setScreensBusy(false)
    }
  }

  function copyRebrandMd(md: string) {
    navigator.clipboard.writeText(md).then(
      () => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      },
      // 剪贴板 API 在文档失焦等场景会拒绝（如 "Document is not focused"），不能静默失败
      (err) => alert(`复制失败: ${err instanceof Error ? err.message : String(err)}`),
    )
  }

  const project = useQuery({
    queryKey: ['project', slug],
    queryFn: () => api<Project>(`/api/projects/${slug}`),
  })
  const raw = useQuery({
    queryKey: ['raw', slug],
    queryFn: () => api<{ files: string[] }>(`/api/projects/${slug}/raw`),
  })
  const shots = useQuery({
    queryKey: ['shots', slug],
    queryFn: () => api<{ files: string[] }>(`/api/projects/${slug}/shots`),
  })
  const [saved, setSaved] = useState(false)
  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api(`/api/projects/${slug}`, { method: 'PATCH', body: JSON.stringify(body) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['project', slug] })
      setSaved(true)
      setTimeout(() => setSaved(false), 1500)
    },
    onError: (e) => {
      const m = e instanceof Error ? e.message : String(e)
      const i = m.indexOf('{'); let text = m
      if (i >= 0) { try { const j = JSON.parse(m.slice(i)); if (j?.error) text = j.error } catch { /* 非 JSON */ } }
      alert('保存失败：' + text)
    },
  })
  const del = useMutation({
    mutationFn: () => api(`/api/projects/${slug}`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['projects'] })
      navigate('/projects')
    },
    onError: (e) => {
      const m = e instanceof Error ? e.message : String(e)
      const i = m.indexOf('{'); let text = m
      if (i >= 0) { try { const j = JSON.parse(m.slice(i)); if (j?.error) text = j.error } catch { /* 非 JSON */ } }
      alert('删除失败：' + text)
    },
  })

  async function upload(file: File) {
    const fd = new FormData()
    fd.append('file', file)
    const res = await fetch(`/api/projects/${slug}/raw`, { method: 'POST', body: fd })
    if (!res.ok) alert(`上传失败: ${await res.text()}`)
    qc.invalidateQueries({ queryKey: ['raw', slug] })
  }

  async function uploadShot(file: File) {
    const fd = new FormData()
    fd.append('file', file)
    const res = await fetch(`/api/projects/${slug}/shots`, { method: 'POST', body: fd })
    if (!res.ok) alert(`上传失败: ${await res.text()}`)
    qc.invalidateQueries({ queryKey: ['shots', slug] })
  }

  if (!project.data) return <div className="text-faint">加载中…</div>
  const p = project.data
  // 未分析时的回退：立项继承自候选的产品说明书（intro_detail 常为 null——只在 live 模式且用户开过候选抽屉时才有）
  let inheritedIntro: IntroDetail | null = null
  if (!p.analysisMd && p.intro_detail) {
    try { inheritedIntro = JSON.parse(p.intro_detail) as IntroDetail } catch { /* 坏 JSON 按无数据处理 */ }
  }

  return (
    <div className="grid grid-cols-[1fr_360px] gap-6">
      <div className="card-forge p-6 text-sm leading-relaxed [&_h1]:text-xl [&_h1]:font-bold [&_h2]:font-bold [&_h2]:mt-4 [&_li]:ml-4">
        <div className="mb-3 flex items-center gap-3 border-b border-hairline pb-2">
          <div className="seg-tabs">
            {DOC_TABS.map((t) => (
              <button key={t.key} className={docTab === t.key ? 'on' : ''} onClick={() => setDocTab(t.key)}>{t.label}</button>
            ))}
          </div>
          {docTab === 'analysis' ? (
            <>
              <button className="btn-fire px-3 py-1 text-sm disabled:opacity-50"
                disabled={analyzing} onClick={analyze}>
                {analyzing ? '分析中…' : (p.analysisMd ? '重新生成分析' : '生成分析')}
              </button>
              <span className="text-xs text-faint">读 source/README 生成 analysis.md</span>
            </>
          ) : (
            <>
              <button className="btn-fire px-3 py-1 text-sm disabled:opacity-50"
                disabled={rebranding || !p.analysisMd} onClick={rebrand}>
                {rebranding ? '生成中…' : (p.rebrandMd ? '重新生成换皮清单' : '生成换皮清单')}
              </button>
              <span className="text-xs text-faint">
                {p.analysisMd ? '读 analysis.md 生成可执行 checklist' : '先在「分析」tab 生成分析报告'}
              </span>
            </>
          )}
        </div>
        {docTab === 'analysis' ? (
          <>
            {analyzeLog.length > 0 && (
              <div className="mb-3 rounded bg-neutral-900 p-2 text-xs text-green-400 font-mono max-h-32 overflow-y-auto space-y-1">
                {analyzeLog.map((l, i) => <div key={i}>{l}</div>)}
              </div>
            )}
            {p.analysisMd
              ? <ReactMarkdown>{p.analysisMd}</ReactMarkdown>
              : inheritedIntro
                ? (
                  <div>
                    <div className="mb-3 rounded bg-fire-soft px-3 py-2 text-xs text-fire">
                      以下来自候选期说明书，点上方「生成分析」得到正式的商业化分析报告
                    </div>
                    <IntroSections intro={inheritedIntro} />
                  </div>
                )
                : <div className="text-faint">暂无 analysis.md——在 workspace/{slug}/ 下补充分析报告</div>}
          </>
        ) : (
          <>
            {rebrandLog.length > 0 && (
              <div className="mb-3 rounded bg-neutral-900 p-2 text-xs text-green-400 font-mono max-h-32 overflow-y-auto space-y-1">
                {rebrandLog.map((l, i) => <div key={i}>{l}</div>)}
              </div>
            )}
            {p.rebrandMd
              ? (
                <div>
                  <div className="mb-3 flex justify-end">
                    <button className="btn-ink px-3 py-1 text-xs" onClick={() => copyRebrandMd(p.rebrandMd!)}>
                      {copied ? '已复制' : '复制全文'}
                    </button>
                  </div>
                  <ReactMarkdown>{p.rebrandMd}</ReactMarkdown>
                </div>
              )
              : <div className="text-faint">{p.analysisMd ? '点上方「生成换皮清单」' : '先生成分析'}</div>}
          </>
        )}
      </div>
      <div className="space-y-4">
        <div className="card-forge p-4 space-y-3">
          <h3 className="font-semibold">项目信息 · {p.slug}（{p.stage}）</h3>
          {FIELDS.map((f) => (
            <div key={f.key}>
              <label className="text-xs text-sub">{f.label}</label>
              <input className="mt-0.5 w-full rounded-md border-[1.5px] border-ink bg-card px-2 py-1 text-sm"
                defaultValue={(p as any)[f.key] ?? ''}
                onChange={(e) => setForm((s) => ({ ...s, [f.key]: e.target.value }))} />
            </div>
          ))}
          <button className="btn-fire w-full py-1.5 text-sm disabled:opacity-50"
            disabled={save.isPending}
            onClick={() => save.mutate(Object.fromEntries(
              Object.entries(form).map(([k, v]) => [k, FIELDS.find((f) => f.key === k && 'number' in f && (f as any).number) ? Number(v) : v]),
            ))}>{save.isPending ? '保存中…' : (saved ? '已保存' : '保存')}</button>
        </div>
        <div className="card-forge p-4 space-y-2">
          <h3 className="font-semibold">raw 素材（录屏/截图）</h3>
          <input type="file" className="text-sm"
            onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
          <ul className="text-sm text-sub space-y-1">
            {raw.data?.files.map((f) => (
              <li key={f}><a className="text-fire" href={`/files/${slug}/raw/${f}`} target="_blank" rel="noreferrer">{f}</a></li>
            ))}
            {raw.data?.files.length === 0 && <li className="text-faint">暂无</li>}
          </ul>
        </div>
        <div className="card-forge p-4 space-y-2">
          <h3 className="font-semibold">shots（demo 视频模板用）</h3>
          <p className="text-xs text-faint">文件名前缀控制播放顺序，如 01-xxx.png</p>
          <input type="file" accept="image/png,image/jpeg,image/webp" className="text-sm"
            onChange={(e) => e.target.files?.[0] && uploadShot(e.target.files[0])} />
          <button className="btn-ink w-full py-1.5 text-sm disabled:opacity-50"
            disabled={screensBusy} onClick={generateScreens}>
            {screensBusy ? '生成中…' : 'AI 生成演示图'}
          </button>
          <p className="text-xs text-faint">会调用 3 次大模型 + 渲染，约十几秒到 1 分钟；生成 3 张固定文件名的图，重新点会覆盖</p>
          {screensLog.length > 0 && (
            <div className="rounded bg-neutral-900 p-2 text-xs text-green-400 font-mono max-h-24 overflow-y-auto space-y-1">
              {screensLog.map((l, i) => <div key={i}>{l}</div>)}
            </div>
          )}
          <ul className="text-sm text-sub space-y-1">
            {shots.data?.files.map((f) => (
              <li key={f}><a className="text-fire" href={`/files/${slug}/shots/${f}`} target="_blank" rel="noreferrer">{f}</a></li>
            ))}
            {shots.data?.files.length === 0 && <li className="text-faint">暂无</li>}
          </ul>
        </div>
        <div className="card-forge p-4 space-y-2">
          <h3 className="font-semibold text-danger">危险操作</h3>
          <button className="w-full rounded-md border-[1.5px] border-danger py-1.5 text-sm text-danger disabled:opacity-50"
            disabled={del.isPending}
            onClick={() => {
              if (window.confirm('删除这个项目？连带的文案/视频素材和 workspace 文件都会删掉，不可恢复。删除后对应候选可以重新立项。'))
                del.mutate()
            }}>
            {del.isPending ? '删除中…' : '删除项目'}
          </button>
        </div>
      </div>
    </div>
  )
}
