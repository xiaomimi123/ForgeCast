import { useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query'
import { api, type Asset, type BgmList, type ContentItemView, type CustomTemplate } from '../../api'
import ContentCard from '../../components/ContentCard'
import TaskProgress from '../../components/TaskProgress'
import { Empty, Failure, Skeleton } from '../../components/ui/States'
import { useTaskRun, type TaskRun } from '../../useTaskRun'
import CutPlanEditor from '../CutPlanEditor'
import PreviewTab from './PreviewTab'
import ScriptTab from './ScriptTab'

/** 钩子枚举（旧「文案」tab 生成面板常量，随面板一起搬进剪辑台左栏） */
export const HOOKS = [
  { value: 'pain', label: '行业痛点型' },
  { value: 'sideline', label: '副业型' },
  { value: 'infogap', label: '信息差型' },
  { value: 'story', label: '接单故事型' },
]

export const VIDEO_TPLS = [
  { value: 'flash', label: 'flash · 文字快闪' },
  { value: 'story', label: 'story · 微信气泡' },
  { value: 'demo', label: 'demo · 产品截图轮播' },
  { value: 'changelog', label: 'changelog · 代码变更' },
  { value: 'insight', label: 'insight · 数据卡片解说' },
]
export const MOODS = [
  { value: '', label: '自动（按钩子情绪）' },
  { value: 'tense', label: '紧张' },
  { value: 'upbeat', label: '热血' },
  { value: 'tech', label: '科技' },
  { value: 'warm', label: '温情' },
]
export const BGS = [
  { value: 'grid', label: '赛博网格' },
  { value: 'aurora', label: '极光' },
  { value: 'matrix', label: '数据雨' },
  { value: 'synth', label: '合成波' },
  { value: 'mesh', label: '深空' },
  { value: 'random', label: '随机' },
  { value: 'none', label: '不加背景' },
]

export interface VideoParams { tpl: string; bgm: string; mood: string; bg: string; captions: boolean; ratio: 'portrait' | 'landscape' }

/** 实心（黑）与描边两套按钮 class——同屏只能有一个用 solid，见 docs/剪辑台-实施说明.md §7 */
const SOLID = 'w-full rounded-[var(--fc-r-sm)] bg-[var(--fc-ink)] px-3 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-40'
const OUTLINE = 'w-full rounded-[var(--fc-r-sm)] border border-[var(--fc-line-2)] bg-transparent px-3 py-2 text-sm font-medium text-[var(--fc-ink)] hover:bg-[var(--fc-line-3)] disabled:opacity-40'

/**
 * 剪辑台（P0 过渡版）：三列 320 / 1fr / 360。
 * 左＝生成面板 + ContentItem 队列；中＝预览播放器；右＝渲染参数 + 对选中项「渲成片」。
 * 正式三栏骨架（尺寸表 §4）留到 P1，这里只做信息架构合并。
 */
export default function EditorTransitionTab({
  selected, hook, setHook, n, setN, busy, copyRun, videoRun, onGenerate,
  vp, setVp, bgmList, onMakeVideo,
  items, selectedItemId, onSelectItem, onDeleteItem,
  assetsQuery, copyAssets, scriptAssets, onScriptBusyChange,
}: {
  selected: string
  hook: string
  setHook: (v: string) => void
  n: number
  setN: (v: number) => void
  busy: boolean
  copyRun: TaskRun
  videoRun: TaskRun
  onGenerate: () => void
  vp: VideoParams
  setVp: (v: VideoParams) => void
  bgmList: BgmList | undefined
  onMakeVideo: (assetId: number) => void
  items: UseQueryResult<ContentItemView[]>
  selectedItemId: number | null
  onSelectItem: (item: ContentItemView) => void
  onDeleteItem: (item: ContentItemView) => void
  assetsQuery: UseQueryResult<Asset[]>
  copyAssets: Asset[]
  scriptAssets: Asset[]
  onScriptBusyChange: (v: boolean) => void
}) {
  const qc = useQueryClient()
  // networkMode:'always'——默认的 'online' 在断网时把查询挂成 paused、isError 永远为 false，
  // 页面就会掉进空态而不是失败态（验收清单第 4 条要求断网显示可读失败态）
  const templates = useQuery({
    queryKey: ['templates'], queryFn: () => api<CustomTemplate[]>('/api/templates'), networkMode: 'always',
  })

  // 重生封面：唯一入口是队列卡「⋯」菜单（`POST /api/assets/:copyAssetId/cover`，模板/选图走默认自动）
  const coverRun = useTaskRun()
  function regenCover(item: ContentItemView) {
    coverRun.run(
      async () => (await api<{ taskId: string }>(`/api/assets/${item.copyAssetId}/cover`, {
        method: 'POST', body: JSON.stringify({}),
      })).taskId,
      (ok, e) => {
        qc.invalidateQueries({ queryKey: ['content-items', selected] })
        qc.invalidateQueries({ queryKey: ['assets', selected] })
        if (!ok) alert('封面生成失败：' + (e?.message ?? '未知错误'))
      },
    )
  }
  const tplOptions = [
    ...VIDEO_TPLS,
    ...(templates.data ?? []).map((t) => ({ value: `custom-${t.id}`, label: `${t.name}（对标拆解 · ${t.aspect_ratio === 'portrait' ? '竖屏' : '横屏'}）` })),
  ]

  const list = items.data ?? []
  const current = list.find((i) => i.id === selectedItemId) ?? null
  // §7 一屏一个黑实心按钮：没选中内容时下一步是「生成」；选中后下一步是「渲成片」，「生成」降为描边。
  const generateClass = current ? OUTLINE : SOLID
  const renderClass = current ? SOLID : OUTLINE

  const generateBtn = (
    <button className={generateClass} disabled={!selected || busy} onClick={onGenerate}>
      {copyRun.running ? '生成中…' : '生成'}
    </button>
  )

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-[320px_1fr_360px] gap-4">
        {/* ── 左：生成面板 + 内容队列 ── */}
        <div className="space-y-4">
          <div className="card space-y-3 p-4">
            <div>
              <label className="text-sm text-sub">钩子类型</label>
              <div className="mt-1 grid grid-cols-2 gap-2">
                {HOOKS.map((h) => (
                  <button key={h.value}
                    className={`rounded-md border px-2 py-1.5 text-sm ${hook === h.value ? 'border-fire bg-fire-soft text-fire font-bold' : 'border-hairline-strong bg-transparent text-sub'}`}
                    onClick={() => setHook(h.value)}>{h.label}</button>
                ))}
              </div>
            </div>
            <div>
              <label className="text-sm text-sub">篇数</label>
              <input type="number" min={1} max={5} className="mt-1 w-full rounded-md border border-hairline-strong bg-card p-2"
                value={n} onChange={(e) => setN(Number(e.target.value))} />
            </div>
            {generateBtn}
            <TaskProgress run={copyRun} />
          </div>

          <div className="card p-2">
            <div className="flex items-center gap-2 px-1.5 pb-1.5">
              <span className="font-mono text-[10px] uppercase tracking-wide text-[var(--fc-muted)]">内容队列</span>
              {coverRun.running && <span className="text-[10px] text-[var(--fc-muted)]">封面生成中…</span>}
            </div>
            {items.isLoading && <div className="p-2"><Skeleton lines={4} /></div>}
            {items.isError && (
              <div className="p-2">
                <Failure step="载入内容列表" error={items.error instanceof Error ? items.error.message : String(items.error)} onRetry={() => items.refetch()} />
              </div>
            )}
            {!items.isLoading && !items.isError && list.length === 0 && (
              <div className="p-2">
                <Empty why="这个项目还没有内容" action={
                  <button className={OUTLINE} disabled={!selected || busy} onClick={onGenerate}>
                    {copyRun.running ? '生成中…' : '生成'}
                  </button>
                } />
              </div>
            )}
            {list.map((item) => (
              <div key={item.id}>
                <ContentCard item={item} selected={item.id === selectedItemId} onOpen={onSelectItem}
                  onDelete={onDeleteItem} onRegenCover={regenCover} />
                {item.status === 'failed' && (
                  <div className="px-1 pb-2">
                    <Failure step="渲染" error={item.error ?? ''} onRetry={() => onMakeVideo(item.copyAssetId)} />
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* ── 中：预览播放器（原「预览」tab 原样内嵌）── */}
        <div className="min-w-0">
          {assetsQuery.isError
            ? <Failure step="载入素材" error={assetsQuery.error instanceof Error ? assetsQuery.error.message : String(assetsQuery.error)} onRetry={() => assetsQuery.refetch()} />
            : selected
              ? <PreviewTab key={selected} slug={selected} assets={assetsQuery.data ?? []} />
              : <Empty why="先在左上角选一个项目" />}
        </div>

        {/* ── 右：渲染参数 + 对选中内容「渲成片」── */}
        <div className="card h-fit space-y-3 p-4">
          <h3 className="text-sm font-semibold">视频参数</h3>
          <div className="rounded-[var(--fc-r-sm)] bg-[var(--fc-sunken)] px-2 py-1.5 text-xs text-[var(--fc-muted)]">
            {current ? `当前内容 #${current.seq} · ${current.title}` : '未选中内容——点左侧队列里的一条'}
          </div>
          <div>
            <label className="text-sm text-sub">模板</label>
            <select className="mt-1 w-full rounded-md border border-hairline-strong bg-card p-2 text-sm"
              value={vp.tpl} onChange={(e) => setVp({ ...vp, tpl: e.target.value })}>
              {tplOptions.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
            {vp.tpl === 'demo' && <p className="mt-1 text-xs text-faint">需先在项目详情页上传 shots/ 截图</p>}
          </div>
          <div>
            <label className="text-sm text-sub">画布比例</label>
            <div className="mt-1 flex items-center gap-4 text-sm">
              <label className="flex items-center gap-1">
                <input type="radio" checked={vp.ratio === 'portrait'} onChange={() => setVp({ ...vp, ratio: 'portrait' })} /> 竖屏 9:16
              </label>
              <label className="flex items-center gap-1">
                <input type="radio" checked={vp.ratio === 'landscape'} onChange={() => setVp({ ...vp, ratio: 'landscape' })} /> 横屏 16:9
              </label>
            </div>
          </div>
          <div>
            <label className="text-sm text-sub">BGM</label>
            <select className="mt-1 w-full rounded-md border border-hairline-strong bg-card p-2 text-sm"
              value={vp.bgm} onChange={(e) => setVp({ ...vp, bgm: e.target.value })}>
              <option value="">自动（按钩子情绪）</option>
              <option value="none">不加背景乐</option>
              {bgmList?.root.map((f) => <option key={f} value={f}>{f}</option>)}
              {Object.entries(bgmList?.byMood ?? {}).map(([m, files]) => (
                <optgroup key={m} label={m}>
                  {files.map((f) => <option key={f} value={f}>{f}</option>)}
                </optgroup>
              ))}
            </select>
          </div>
          <div>
            <label className="text-sm text-sub">情绪</label>
            <select className="mt-1 w-full rounded-md border border-hairline-strong bg-card p-2 text-sm"
              value={vp.mood} onChange={(e) => setVp({ ...vp, mood: e.target.value })}>
              {MOODS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
            </select>
          </div>
          <div>
            <label className="text-sm text-sub">背景{vp.tpl === 'story' && <span className="text-faint">（story 不显示背景层）</span>}</label>
            <select className="mt-1 w-full rounded-md border border-hairline-strong bg-card p-2 text-sm disabled:opacity-50"
              disabled={vp.tpl === 'story'} value={vp.bg} onChange={(e) => setVp({ ...vp, bg: e.target.value })}>
              {BGS.map((b) => <option key={b.value} value={b.value}>{b.label}</option>)}
            </select>
          </div>
          <label className="flex items-center gap-2 text-sm text-sub">
            <input type="checkbox" checked={vp.captions} onChange={(e) => setVp({ ...vp, captions: e.target.checked })} />
            烧旁白字幕进视频（默认关，模板大字标题不受影响）
          </label>
          <button className={renderClass} disabled={!selected || busy || !current}
            onClick={() => current && onMakeVideo(current.copyAssetId)}>
            {videoRun.running ? '渲染中…' : '渲成片'}
          </button>
          <TaskProgress run={videoRun} />
        </div>
      </div>

      {/* ── 底部折叠区：旧「拍摄脚本」「卡点」两个 tab（P1/P2 各自被分镜行与时间轴接管）── */}
      <details className="card p-3">
        <summary className="cursor-pointer select-none text-sm font-medium">拍摄脚本</summary>
        <div className="pt-3">
          <ScriptTab selected={selected} copyAssets={copyAssets} scriptAssets={scriptAssets}
            running={busy} onRunningChange={onScriptBusyChange} />
        </div>
      </details>
      <details className="card p-3">
        <summary className="cursor-pointer select-none text-sm font-medium">卡点（旧版，P2 由时间轴接管）</summary>
        <div className="pt-3">
          {/* key 强制切项目时重挂载，否则 CutPlanEditor 内部 plan state 会残留上一个项目的方案 */}
          {selected && <CutPlanEditor key={selected} slug={selected} />}
        </div>
      </details>
    </div>
  )
}
