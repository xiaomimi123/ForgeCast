import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, subscribeTask, type Asset, type BgmList, type Project } from '../api'
import AssetCard from '../components/AssetCard'
import CutPlanEditor from './CutPlanEditor'

const HOOKS = [
  { value: 'pain', label: '行业痛点型' },
  { value: 'sideline', label: '副业型' },
  { value: 'infogap', label: '信息差型' },
  { value: 'story', label: '接单故事型' },
]

const VIDEO_TPLS = [
  { value: 'flash', label: 'flash · 文字快闪' },
  { value: 'story', label: 'story · 微信气泡' },
  { value: 'demo', label: 'demo · 产品截图轮播' },
  { value: 'changelog', label: 'changelog · 代码变更' },
]
const MOODS = [
  { value: '', label: '自动（按钩子情绪）' },
  { value: 'tense', label: '紧张' },
  { value: 'upbeat', label: '热血' },
  { value: 'tech', label: '科技' },
  { value: 'warm', label: '温情' },
]
const BGS = [
  { value: 'grid', label: '赛博网格' },
  { value: 'aurora', label: '极光' },
  { value: 'matrix', label: '数据雨' },
  { value: 'synth', label: '合成波' },
  { value: 'mesh', label: '深空' },
  { value: 'random', label: '随机' },
  { value: 'none', label: '不加背景' },
]

export default function WorkshopPage() {
  const qc = useQueryClient()
  const [slug, setSlug] = useState('')
  const [hook, setHook] = useState('pain')
  const [n, setN] = useState(1)
  const [logs, setLogs] = useState<string[]>([])
  const [running, setRunning] = useState(false)
  const logRef = useRef<HTMLDivElement>(null)

  // 视频渲染参数：默认值与后端 config.video 默认一致（bgm/mood 空串=自动，bg=grid，字幕默认开）
  const [tpl, setTpl] = useState('flash')
  const [bgm, setBgm] = useState('')
  const [mood, setMood] = useState('')
  const [bg, setBg] = useState('grid')
  const [captions, setCaptions] = useState(true)

  const projects = useQuery({ queryKey: ['projects'], queryFn: () => api<Project[]>('/api/projects') })
  const selected = slug || projects.data?.[0]?.slug || ''
  const assets = useQuery({
    queryKey: ['assets', selected],
    queryFn: () => api<Asset[]>(`/api/projects/${selected}/assets`),
    enabled: !!selected,
  })
  const bgmList = useQuery({ queryKey: ['bgm'], queryFn: () => api<BgmList>('/api/bgm') })

  async function generate(feedback?: string, hookOverride?: string, nOverride?: number) {
    if (!selected || running) return
    setRunning(true)
    setLogs([])
    try {
      const { taskId } = await api<{ taskId: string }>(`/api/projects/${selected}/copy`, {
        method: 'POST', body: JSON.stringify({ hook: hookOverride ?? hook, n: nOverride ?? n, feedback }),
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
        method: 'POST', body: JSON.stringify({ assetId, tpl, bgm, mood, bg: tpl === 'story' ? undefined : bg, captions }),
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
    <div className="space-y-6">
      <div className="grid grid-cols-[320px_1fr] gap-6">
        {/* 左侧：生成面板 */}
        <div className="space-y-4">
          <div className="card-forge p-4 space-y-3">
            <div>
              <label className="text-sm text-sub">项目</label>
              <select className="mt-1 w-full rounded-md border-[1.5px] border-ink bg-card p-2" value={selected} onChange={(e) => setSlug(e.target.value)}>
                {projects.data?.map((p) => <option key={p.slug} value={p.slug}>{p.brand_name ?? p.slug}</option>)}
              </select>
              {selected && <Link to={`/projects/${selected}`} className="text-xs text-fire">查看项目详情 →</Link>}
            </div>
            <div>
              <label className="text-sm text-sub">钩子类型</label>
              <div className="mt-1 grid grid-cols-2 gap-2">
                {HOOKS.map((h) => (
                  <button key={h.value}
                    className={`rounded-md border-[1.5px] px-2 py-1.5 text-sm ${hook === h.value ? 'border-fire bg-fire-soft text-fire font-bold' : 'border-hairline bg-transparent text-sub'}`}
                    onClick={() => setHook(h.value)}>{h.label}</button>
                ))}
              </div>
            </div>
            <div>
              <label className="text-sm text-sub">篇数</label>
              <input type="number" min={1} max={5} className="mt-1 w-full rounded-md border-[1.5px] border-ink bg-card p-2"
                value={n} onChange={(e) => setN(Number(e.target.value))} />
            </div>
            <button className="btn-fire w-full py-2 disabled:opacity-50"
              disabled={!selected || running} onClick={() => generate()}>
              {running ? '生成中…' : '生成'}
            </button>
          </div>
          <div className="card-forge p-4 space-y-3">
            <h3 className="text-sm font-semibold">视频参数</h3>
            <div>
              <label className="text-sm text-sub">模板</label>
              <select className="mt-1 w-full rounded-md border-[1.5px] border-ink bg-card p-2 text-sm"
                value={tpl} onChange={(e) => setTpl(e.target.value)}>
                {VIDEO_TPLS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
              {tpl === 'demo' && <p className="mt-1 text-xs text-faint">需先在项目详情页上传 shots/ 截图</p>}
            </div>
            <div>
              <label className="text-sm text-sub">BGM</label>
              <select className="mt-1 w-full rounded-md border-[1.5px] border-ink bg-card p-2 text-sm"
                value={bgm} onChange={(e) => setBgm(e.target.value)}>
                <option value="">自动（按钩子情绪）</option>
                <option value="none">不加背景乐</option>
                {bgmList.data?.root.map((f) => <option key={f} value={f}>{f}</option>)}
                {Object.entries(bgmList.data?.byMood ?? {}).map(([m, files]) => (
                  <optgroup key={m} label={m}>
                    {files.map((f) => <option key={f} value={f}>{f}</option>)}
                  </optgroup>
                ))}
              </select>
            </div>
            <div>
              <label className="text-sm text-sub">情绪</label>
              <select className="mt-1 w-full rounded-md border-[1.5px] border-ink bg-card p-2 text-sm"
                value={mood} onChange={(e) => setMood(e.target.value)}>
                {MOODS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
              </select>
            </div>
            <div>
              <label className="text-sm text-sub">背景{tpl === 'story' && <span className="text-faint">（story 不显示背景层）</span>}</label>
              <select className="mt-1 w-full rounded-md border-[1.5px] border-ink bg-card p-2 text-sm disabled:opacity-50"
                disabled={tpl === 'story'} value={bg} onChange={(e) => setBg(e.target.value)}>
                {BGS.map((b) => <option key={b.value} value={b.value}>{b.label}</option>)}
              </select>
            </div>
            <label className="flex items-center gap-2 text-sm text-sub">
              <input type="checkbox" checked={captions} onChange={(e) => setCaptions(e.target.checked)} />
              烧字幕进视频
            </label>
          </div>
          {logs.length > 0 && (
            <div ref={logRef} className="rounded-lg border bg-neutral-900 p-3 text-xs text-green-400 font-mono h-48 overflow-y-auto space-y-1">
              {logs.map((l, i) => <div key={i}>{l}</div>)}
            </div>
          )}
        </div>
        {/* 右侧：素材列表 */}
        <div className="space-y-4">
          {assets.data?.length === 0 && <div className="text-faint text-sm">暂无素材，点左侧「生成」</div>}
          {assets.data?.map((a) => (
            <AssetCard key={a.id} asset={a} slug={selected} onRegenerate={(fb) => generate(fb, a.hook ?? hook, 1)} onVideo={(id) => makeVideo(id)} />
          ))}
        </div>
      </div>
      {/* 卡点编辑器（原在项目详情页，320px 侧栏放不下卡点列表，挪到这里下方全宽）；key 强制切项目时重挂载，
          否则 CutPlanEditor 内部 plan state 不会清空，会残留上一个项目的卡点方案 */}
      {selected && <CutPlanEditor key={selected} slug={selected} />}
    </div>
  )
}
