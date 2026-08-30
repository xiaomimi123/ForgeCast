import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { api, type Asset, type BgmList, type Project } from '../api'
import TaskProgress from '../components/TaskProgress'
import { useTaskRun } from '../useTaskRun'
import CopyTab from './workshop/CopyTab'
import ScriptTab from './workshop/ScriptTab'
import UploadTab from './workshop/UploadTab'
import VideoTab, { type VideoParams } from './workshop/VideoTab'
import CutPlanEditor from './CutPlanEditor'
import TemplatesTab from './workshop/TemplatesTab'

// 做内容五 tab：按人机协作主线排序（文案→拍摄脚本→成片上传审片）；自动渲染（出视频）降为辅助
const TABS = [
  { key: 'copy', label: '文案' },
  { key: 'script', label: '拍摄脚本' },
  { key: 'upload', label: '成片' },
  { key: 'video', label: '出视频' },
  { key: 'cut', label: '卡点' },
  { key: 'templates', label: '模板库' },
] as const
type TabKey = (typeof TABS)[number]['key']

export default function WorkshopPage({ onOpenProject }: { onOpenProject: (slug: string) => void }) {
  const qc = useQueryClient()
  const [tab, setTab] = useState<TabKey>('copy')
  const [slug, setSlug] = useState('')
  const [hook, setHook] = useState('pain')
  const [n, setN] = useState(1)
  const logRef = useRef<HTMLDivElement>(null)

  const copyRun = useTaskRun()
  const videoRun = useTaskRun()
  // 生成脚本的 run 由 ScriptTab 自己持有，通过 onRunningChange 回传忙碌态
  const [scriptBusy, setScriptBusy] = useState(false)
  const busy = copyRun.running || videoRun.running || scriptBusy
  const [activeKey, setActiveKey] = useState<'copy' | 'video'>('copy')
  const runs = { copy: copyRun, video: videoRun }
  const activeRun = runs[activeKey]
  useEffect(() => { logRef.current?.scrollTo({ top: 999999 }) }, [activeRun.logs.length])

  // 视频渲染参数：默认值与后端 config.video 默认一致（bgm/mood 空串=自动，bg=grid，旁白字幕默认关）
  const [vp, setVp] = useState<VideoParams>({ tpl: 'flash', bgm: '', mood: '', bg: 'grid', captions: false, ratio: 'portrait' })
  // 「出视频」tab 当前选中的文案来源；从「文案」tab 点「去出视频 →」时被预选
  const [videoFromAsset, setVideoFromAsset] = useState<number | null>(null)

  const projects = useQuery({ queryKey: ['projects'], queryFn: () => api<Project[]>('/api/projects') })
  const selected = slug || projects.data?.[0]?.slug || ''
  const assets = useQuery({
    queryKey: ['assets', selected],
    queryFn: () => api<Asset[]>(`/api/projects/${selected}/assets`),
    enabled: !!selected,
  })
  const bgmList = useQuery({ queryKey: ['bgm'], queryFn: () => api<BgmList>('/api/bgm') })

  function generate(feedback?: string, hookOverride?: string, nOverride?: number) {
    if (!selected) return
    setActiveKey('copy')
    copyRun.run(
      async () => (await api<{ taskId: string }>(`/api/projects/${selected}/copy`, {
        method: 'POST',
        body: JSON.stringify({ hook: hookOverride ?? hook, n: nOverride ?? n, feedback }),
      })).taskId,
      () => qc.invalidateQueries({ queryKey: ['assets', selected] }),
    )
  }

  function makeVideo(assetId: number) {
    if (!selected) return
    setActiveKey('video')
    videoRun.run(
      async () => (await api<{ taskId: string }>(`/api/projects/${selected}/video`, {
        method: 'POST', body: JSON.stringify({ assetId, tpl: vp.tpl, bgm: vp.bgm, mood: vp.mood, bg: vp.tpl === 'story' ? undefined : vp.bg, captions: vp.captions, ratio: vp.ratio }),
      })).taskId,
      () => qc.invalidateQueries({ queryKey: ['assets', selected] }),
    )
  }

  const copyAssets = (assets.data ?? []).filter((a) => a.type === 'copy')
  const scriptAssets = (assets.data ?? []).filter((a) => a.type === 'script')
  const uploadAssets = (assets.data ?? []).filter((a) => a.type === 'video' && a.origin === 'upload')
  const renderAssets = (assets.data ?? []).filter((a) => a.type === 'video' && a.origin !== 'upload')

  function setAssetStatus(id: number) {
    api(`/api/assets/${id}`, { method: 'PATCH', body: JSON.stringify({ status: 'approved' }) })
      .then(() => qc.invalidateQueries({ queryKey: ['assets', selected] }))
  }
  function deleteAsset(id: number) {
    api(`/api/assets/${id}`, { method: 'DELETE' })
      .then(() => qc.invalidateQueries({ queryKey: ['assets', selected] }))
      .catch((e) => alert('删除失败：' + (e instanceof Error ? e.message : String(e))))
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 border-b border-hairline pb-2">
        <select className="w-48 rounded-md border border-hairline-strong bg-card p-1.5 text-sm" value={selected} onChange={(e) => setSlug(e.target.value)}>
          {projects.data?.map((p) => <option key={p.slug} value={p.slug}>{p.brand_name ?? p.slug}</option>)}
        </select>
        {selected && <button onClick={() => onOpenProject(selected)} className="text-xs text-fire">查看项目详情 →</button>}
        <TaskProgress run={activeRun} className="max-w-[360px]" />
        <div className="ml-auto seg-tabs">
          {TABS.map((t) => (
            <button key={t.key} className={tab === t.key ? 'on' : ''} onClick={() => setTab(t.key)}>{t.label}</button>
          ))}
        </div>
      </div>

      {tab === 'copy' && (
        <CopyTab
          selected={selected} hook={hook} setHook={setHook} n={n} setN={setN} running={busy} run={copyRun}
          onGenerate={() => generate()} assets={assets.data ?? []} slug={selected}
          onRegenerate={(fb, a) => generate(fb, a.hook ?? hook, 1)}
          onVideo={(id) => { setVideoFromAsset(id); setTab('video') }}
        />
      )}
      {tab === 'script' && (
        <ScriptTab selected={selected} copyAssets={copyAssets} scriptAssets={scriptAssets}
          running={busy} onRunningChange={setScriptBusy} />
      )}
      {tab === 'upload' && (
        <UploadTab selected={selected} uploadAssets={uploadAssets} scriptAssets={scriptAssets}
          onStatus={setAssetStatus} onDelete={deleteAsset} />
      )}
      {tab === 'video' && (
        <VideoTab
          selected={selected} vp={vp} setVp={setVp} copyAssets={copyAssets}
          videoFromAsset={videoFromAsset} setVideoFromAsset={setVideoFromAsset}
          running={busy} run={videoRun} onMakeVideo={makeVideo} bgmList={bgmList.data}
          videoAssets={renderAssets} slug={selected}
          onRegenerate={(fb, a) => generate(fb, a.hook ?? hook, 1)}
        />
      )}
      {/* key 强制切项目时重挂载，否则 CutPlanEditor 内部 plan state 不会清空，会残留上一个项目的卡点方案 */}
      {tab === 'cut' && selected && <CutPlanEditor key={selected} slug={selected} />}
      {tab === 'templates' && <TemplatesTab />}

      {activeRun.logs.length > 0 && (
        <div ref={logRef} className="rounded-lg border bg-neutral-900 p-3 text-xs text-green-400 font-mono h-48 overflow-y-auto space-y-1">
          {activeRun.logs.map((l, i) => <div key={i}>{l}</div>)}
        </div>
      )}
    </div>
  )
}
