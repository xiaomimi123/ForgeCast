import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { api, type Asset, type BgmList, type ContentItemView, type Project } from '../api'
import { Failure } from '../components/ui/States'
import { useTaskRun } from '../useTaskRun'
import EditorTransitionTab, { type VideoParams } from './workshop/EditorTransitionTab'
import LibraryTab from './workshop/LibraryTab'
import TemplatesTab from './workshop/TemplatesTab'

// 做内容三视图（实施说明 §2 / P0-2）：旧 7 个 tab 的能力全部并进剪辑台与成片库。
const TABS = [
  { key: 'editor', label: '剪辑台' },
  { key: 'library', label: '成片库' },
  { key: 'templates', label: '模板库' },
] as const
type TabKey = (typeof TABS)[number]['key']

export default function WorkshopPage({ onOpenProject }: { onOpenProject: (slug: string) => void }) {
  const qc = useQueryClient()
  const [tab, setTab] = useState<TabKey>('editor')
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
  // 剪辑台左栏队列当前选中的 ContentItem（右栏「渲成片」的作用对象）
  const [selectedItemId, setSelectedItemId] = useState<number | null>(null)

  // 做内容工位的查询统一 networkMode:'always'：react-query 默认的 'online' 在断网时把查询挂成
  // fetchStatus:'paused'、isError 永远为 false，页面于是渲染成「空态」——断网看到「还没有内容」
  // 正是本仓最忌的零报错坏结果。改成 always 让 fetch 真失败进 isError，交给 <Failure/> 显示。
  const projects = useQuery({ queryKey: ['projects'], queryFn: () => api<Project[]>('/api/projects'), networkMode: 'always' })
  const selected = slug || projects.data?.[0]?.slug || ''
  const assets = useQuery({
    queryKey: ['assets', selected],
    queryFn: () => api<Asset[]>(`/api/projects/${selected}/assets`),
    enabled: !!selected,
    networkMode: 'always',
  })
  // 渲染中每 2s 拉一次进度；没有 rendering 的条目就完全不轮询（refetchInterval 返回 false）
  const contentItems = useQuery({
    queryKey: ['content-items', selected],
    queryFn: () => api<ContentItemView[]>(`/api/projects/${selected}/content-items`),
    enabled: !!selected,
    refetchInterval: (q) => (q.state.data?.some((i) => i.status === 'rendering') ? 2000 : false),
    networkMode: 'always',
  })
  const bgmList = useQuery({ queryKey: ['bgm'], queryFn: () => api<BgmList>('/api/bgm'), networkMode: 'always' })

  // 切项目时清掉上一个项目的选中项，避免右栏对着不存在的内容渲片
  useEffect(() => { setSelectedItemId(null) }, [selected])

  function invalidateProjectData() {
    qc.invalidateQueries({ queryKey: ['assets', selected] })
    qc.invalidateQueries({ queryKey: ['content-items', selected] })
  }

  function generate() {
    if (!selected) return
    setActiveKey('copy')
    copyRun.run(
      async () => {
        const { taskId } = await api<{ taskId: string }>(`/api/projects/${selected}/copy`, {
          method: 'POST',
          body: JSON.stringify({ hook, n }),
        })
        // 入队即失效（见 makeVideo 里的说明），保持两条链路对称
        qc.invalidateQueries({ queryKey: ['content-items', selected] })
        return taskId
      },
      invalidateProjectData,
    )
  }

  function makeVideo(assetId: number) {
    if (!selected) return
    setActiveKey('video')
    videoRun.run(
      async () => {
        const { taskId } = await api<{ taskId: string }>(`/api/projects/${selected}/video`, {
          method: 'POST', body: JSON.stringify({ assetId, tpl: vp.tpl, bgm: vp.bgm, mood: vp.mood, bg: vp.tpl === 'story' ? undefined : vp.bg, captions: vp.captions, ratio: vp.ratio }),
        })
        // 拿到 taskId（＝任务已入队、meta 已写）后立刻失效 content-items：
        // 派生 rendering 靠的是任务队列（server content-items.ts：pending|running ⇒ rendering），
        // 而 refetchInterval 只在缓存里已经有 rendering 项时才轮询。不在这里主动失效一次，
        // 缓存永远停在 script_ready → 不轮询 → 发现不了 rendering，鸡生蛋。
        qc.invalidateQueries({ queryKey: ['content-items', selected] })
        return taskId
      },
      invalidateProjectData,
    )
  }

  const copyAssets = (assets.data ?? []).filter((a) => a.type === 'copy')
  const scriptAssets = (assets.data ?? []).filter((a) => a.type === 'script')

  function setAssetStatus(id: number) {
    api(`/api/assets/${id}`, { method: 'PATCH', body: JSON.stringify({ status: 'approved' }) })
      .then(invalidateProjectData)
  }
  function deleteAsset(id: number) {
    api(`/api/assets/${id}`, { method: 'DELETE' })
      .then(invalidateProjectData)
      .catch((e) => alert('删除失败：' + (e instanceof Error ? e.message : String(e))))
  }
  /** 删一条内容 = 删掉它背后的文案/封面/成片素材（ContentItem 只是这三者的视图） */
  function deleteContentItem(item: ContentItemView) {
    // render.assetIds 是全部版本（不是只有最新那条），否则旧版素材行与文件成孤儿且再也无法从队列触达
    const ids = [...(item.render?.assetIds ?? []), item.cover?.assetId, item.copyAssetId].filter((v): v is number => typeof v === 'number')
    Promise.all(ids.map((id) => api(`/api/assets/${id}`, { method: 'DELETE' })))
      .then(() => { if (selectedItemId === item.id) setSelectedItemId(null) })
      .catch((e) => alert('删除失败：' + (e instanceof Error ? e.message : String(e))))
      .finally(invalidateProjectData)
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 border-b border-hairline pb-2">
        <select className="w-48 rounded-md border border-hairline-strong bg-card p-1.5 text-sm" value={selected} onChange={(e) => setSlug(e.target.value)}>
          {projects.data?.map((p) => <option key={p.slug} value={p.slug}>{p.brand_name ?? p.slug}</option>)}
        </select>
        {selected && <button onClick={() => onOpenProject(selected)} className="text-xs text-fire">查看项目详情 →</button>}
        <div className="ml-auto seg-tabs">
          {TABS.map((t) => (
            <button key={t.key} className={tab === t.key ? 'on' : ''} onClick={() => setTab(t.key)}>{t.label}</button>
          ))}
        </div>
      </div>

      {/* 项目列表本身挂了：两个 tab 谁都没法工作，直接给整屏失败态——否则会掉进「这个项目还没有内容」的空态 */}
      {projects.isError && (
        <Failure step="载入项目列表"
          error={projects.error instanceof Error ? projects.error.message : String(projects.error)}
          onRetry={() => projects.refetch()} />
      )}
      {!projects.isError && tab === 'editor' && (
        <EditorTransitionTab
          selected={selected} hook={hook} setHook={setHook} n={n} setN={setN}
          busy={busy} copyRun={copyRun} videoRun={videoRun} onGenerate={() => generate()}
          vp={vp} setVp={setVp} bgmList={bgmList.data} onMakeVideo={makeVideo}
          items={contentItems} selectedItemId={selectedItemId}
          onSelectItem={(item) => setSelectedItemId(item.id)} onDeleteItem={deleteContentItem}
          assetsQuery={assets} copyAssets={copyAssets} scriptAssets={scriptAssets}
          onScriptBusyChange={setScriptBusy}
        />
      )}
      {!projects.isError && tab === 'library' && (
        <LibraryTab selected={selected} assetsQuery={assets} scriptAssets={scriptAssets}
          onStatus={setAssetStatus} onDelete={deleteAsset} />
      )}
      {!projects.isError && tab === 'templates' && <TemplatesTab />}

      {activeRun.logs.length > 0 && (
        <div ref={logRef} className="rounded-lg border bg-neutral-900 p-3 text-xs text-green-400 font-mono h-48 overflow-y-auto space-y-1">
          {activeRun.logs.map((l, i) => <div key={i}>{l}</div>)}
        </div>
      )}
    </div>
  )
}
