// 深导入而非走包入口 `@forgecast/compositions`：入口带六份 CSS 的**副作用导入**，那样进来的样式
// 是「无层」的，会压过 Tailwind v4 放在 @layer utilities 里的所有工具类（base.css 里
// `* { margin:0;padding:0 }` 是给 1080×1920 渲染页写的，泄漏进控制台会把全站间距打平）。
// 样式改由 index.css 用 `@import ... layer(forgecast-compositions)` 引入，见那里的注释。
// **别顺手改回包入口**——子项目②的 Critical 就是这么来的。
import { SpecComposition } from '@forgecast/compositions/src/SpecComposition'
import { FPS, secToFrames } from '@forgecast/compositions/src/time'
import { Player, type PlayerRef } from '@remotion/player'
import { useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query'
import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { api, type BgmList, type ContentItemView, type CustomTemplate } from '../../../api'
import { StatusTag } from '../../../components/ContentCard'
import TaskProgress from '../../../components/TaskProgress'
import { isUnsupported, videoIdFromSpecPath } from '../../../lib/rebase'
import { useTaskRun, type TaskRun } from '../../../useTaskRun'
import QueuePane from './QueuePane'
import { NoOrigSnapshotError, useEditorState } from './useEditorState'

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

/** 实心（黑）与描边两套按钮 class——同屏只能有一个用 SOLID，见 docs/剪辑台-实施说明.md §7 */
export const SOLID = 'rounded-[var(--fc-r-sm)] bg-[var(--fc-ink)] px-3 py-1.5 text-sm font-medium text-white hover:bg-[var(--fc-ink-2)] disabled:bg-[var(--fc-line)] disabled:text-[var(--fc-faint)]'
export const OUTLINE = 'rounded-[var(--fc-r-sm)] border border-[var(--fc-line-2)] bg-transparent px-3 py-1.5 text-sm font-medium text-[var(--fc-ink)] hover:border-[var(--fc-ink)] hover:bg-[var(--fc-bg)] disabled:border-[var(--fc-line)] disabled:text-[var(--fc-line-2)]'
/** 左/右栏里的整宽描边按钮 */
const OUTLINE_BLOCK = `w-full ${OUTLINE}`

/** 尺寸表（实施说明 §4）。数字集中在这里，三栏和时间轴都从这里取，避免各写各的对不上。 */
const TOOLBAR_H = 46
const MAT_H = 300
const MAT_PAD = 18
const TIMELINE_H = 186
/** 9:16 画布：高度由 mat 高减上下留白得出，宽 = 高 × 0.5625 */
const CANVAS_H = MAT_H - MAT_PAD * 2
const CANVAS_W = Math.round(CANVAS_H * 0.5625)

/**
 * 剪辑台（P1 骨架，实施说明 §4）：三栏 300 / 1fr(min 620) / 320 + 整宽时间轴 186。
 *
 * 本任务只搭骨架与「单一真相」接线（载入 / 保存 / 撤销 / 预览 / 快捷键）。
 * 左栏队列、中栏分镜列表、右栏参数抽屉、时间轴的**正式**实现分别是 Task 7/8/9；
 * 这里各留一个占位容器，同时把 P0 过渡版（EditorTransitionTab）的生成面板 / 队列 /
 * 视频参数原样搬进临时区，保证 T6→T9 之间不出现功能空窗。
 */
export default function EditorPage({
  selected, hook, setHook, n, setN, busy, copyRun, videoRun, onGenerate,
  vp, setVp, bgmList, onMakeVideo,
  items, selectedItemId, onSelectItem, onDeleteItem, onCloseEditor,
  transitionExtras,
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
  /** 「打回重做」：退出编辑态回到队列视角（不改库内状态，见 §5 —— 它是「这版不要了，去重做」的视角切换） */
  onCloseEditor: () => void
  /** 过渡区：旧「拍摄脚本」「卡点」两个折叠面板，P1/P2 由分镜行与时间轴接管后删除 */
  transitionExtras?: ReactNode
}) {
  const qc = useQueryClient()
  const list = items.data ?? []
  const current = list.find((i) => i.id === selectedItemId) ?? null
  const specPath = current?.render?.specPath ?? null
  const videoId = specPath ? videoIdFromSpecPath(specPath) : null

  const ed = useEditorState(selected, videoId)
  const playerRef = useRef<PlayerRef>(null)
  /** 当前播放头（秒）。Task 9 的时间轴消费；这里先存住，保证 frameupdate 接线在骨架期就是通的。 */
  const [currentSec, setCurrentSec] = useState(0)
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const [notice, setNotice] = useState<string | null>(null)
  /** 重置端点 404（这条视频生成于旧版本、没有 .orig 快照）后隐藏「重置」——服务端没有单独的探测接口 */
  const [resetUnavailable, setResetUnavailable] = useState(false)

  // 换内容项时复位这条内容独有的临时状态
  useEffect(() => { setCurrentSec(0); setMenuOpen(false); setNotice(null); setResetUnavailable(false) }, [videoId])

  // 点菜单外面关掉它。用 mousedown 而非 click：click 要等按键抬起，期间菜单还盖在页面上，
  // 点它下面的控件会「第一下只关菜单」。写法与 ContentCard 的「⋯」一致。
  useEffect(() => {
    if (!menuOpen) return
    function onDown(e: MouseEvent) {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [menuOpen])

  // 播放头：Player 的 frameupdate 是 imperative API，只能在 ref 就绪后订阅
  useEffect(() => {
    const p = playerRef.current
    if (!p) return
    const onFrame = (e: { detail: { frame: number } }) => setCurrentSec(e.detail.frame / FPS)
    p.addEventListener('frameupdate', onFrame)
    return () => p.removeEventListener('frameupdate', onFrame)
  }, [ed.previewSpec])

  const saveRef = useRef(ed.save)
  saveRef.current = ed.save
  const undoRef = useRef(ed.undo)
  undoRef.current = ed.undo
  const redoRef = useRef(ed.redo)
  redoRef.current = ed.redo

  // 快捷键：Ctrl/Cmd+Z 撤销、Shift+Ctrl/Cmd+Z 重做、Ctrl/Cmd+S 保存。
  // 输入框聚焦时不抢撤销/重做——那时用户要的是输入框自己的撤销栈。
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey)) return
      const key = e.key.toLowerCase()
      const t = e.target as HTMLElement | null
      const inField = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)
      if (key === 's') {
        e.preventDefault()
        // save() 返回 false ＝ 没有 spec、什么都没写。此时不能弹「已保存」——在「待出片」内容上
        // 按 ⌘S 弹一句假回执，用户会以为改动落了盘。
        saveRef.current()
          .then((wrote) => { if (wrote) setNotice('已保存') })
          .catch((err) => setNotice(`保存失败：${err instanceof Error ? err.message : String(err)}`))
        return
      }
      if (key === 'z') {
        if (inField) return
        e.preventDefault()
        if (e.shiftKey) redoRef.current()
        else undoRef.current()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  async function doSave() {
    try {
      if (await ed.save()) setNotice('已保存')
    } catch (e) { setNotice(`保存失败：${e instanceof Error ? e.message : String(e)}`) }
  }

  /**
   * 离开当前内容（切队列 / 关编辑态）前的未保存改动闸门。返回 true 表示可以走。
   * 两段 confirm：第一段问「要不要先保存」，答否再问「确定丢弃吗」——关键是**不能无声丢**。
   * 保存失败时不放行，否则「保存了」的错觉加上改动丢失是最坏的组合。
   */
  async function confirmLeave(): Promise<boolean> {
    if (!ed.dirty) return true
    if (confirm('有未保存的改动。要先保存吗？\n\n确定＝保存并离开；取消＝进入丢弃确认')) {
      try {
        await ed.save()
        return true
      } catch (e) {
        setNotice(`保存失败，已留在当前内容：${e instanceof Error ? e.message : String(e)}`)
        return false
      }
    }
    return confirm('丢弃这些未保存的改动并离开？此操作不可撤销。')
  }

  /** 队列点选：点的是当前这条就直接放行（不算离开），否则先过未保存闸门。 */
  function selectItemGuarded(item: ContentItemView) {
    if (item.id === selectedItemId) return
    confirmLeave().then((ok) => { if (ok) onSelectItem(item) })
  }

  async function doReset() {
    if (!confirm('重置为生成结果？剪辑台里的手工改动会全部丢弃，且不可撤销。')) return
    try {
      await ed.resetToOrig()
      setNotice('已重置为生成结果')
    } catch (e) {
      if (e instanceof NoOrigSnapshotError) { setResetUnavailable(true); setNotice(e.message); return }
      setNotice(`重置失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  /**
   * 编辑态的「渲成片」：走 `POST /specs/:videoId/render`（renderFromSpec，只渲当前 spec），
   * **不是**旧的 `POST /video` 全管线——后者会重新 lower，把剪辑台上的手工改动整段覆盖掉。
   * 脏的时候先落盘再入队：端点读的是磁盘上的 spec，不先存等于渲了个旧版本。
   */
  async function doRenderFromSpec() {
    if (!selected || !videoId) return
    if (!confirm('用当前编辑结果渲一版成片？\n旁白与字幕沿用上一版配音，改过的文字不会改配音。')) return
    try {
      if (ed.dirty) await ed.save()
      await api<{ taskId: string }>(`/api/projects/${selected}/specs/${videoId}/render`, { method: 'POST' })
      qc.invalidateQueries({ queryKey: ['content-items', selected] })
      setNotice('已入队：渲染中，进度看队列卡片')
    } catch (e) {
      setNotice(`渲成片失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  function approve() {
    if (!current?.render) return
    api(`/api/assets/${current.render.assetId}`, { method: 'PATCH', body: JSON.stringify({ status: 'approved' }) })
      .then(() => {
        qc.invalidateQueries({ queryKey: ['content-items', selected] })
        qc.invalidateQueries({ queryKey: ['assets', selected] })
        setNotice('已通过，进入分发')
      })
      .catch((e) => setNotice(`通过失败：${e instanceof Error ? e.message : String(e)}`))
  }

  const canApprove = !!current?.render && current.status === 'review'

  return (
    <div className="space-y-4">
      <div
        className="grid gap-2"
        style={{
          gridTemplateColumns: '300px minmax(620px,1fr) 320px',
          gridTemplateRows: `minmax(0,1fr) ${TIMELINE_H}px`,
          height: 'calc(100vh - 190px)',
          minHeight: 620,
        }}
      >
        {/* ── 左栏 300：内容队列（QueuePane，实施说明 §4）── */}
        <QueuePane
          selected={selected} hook={hook} setHook={setHook} n={n} setN={setN}
          busy={busy} copyRun={copyRun} onGenerate={onGenerate}
          items={items} selectedItemId={selectedItemId}
          onSelectItem={selectItemGuarded} onDeleteItem={onDeleteItem} onMakeVideo={onMakeVideo}
        />

        {/* ── 中栏 Stage：toolbar 46 / preview mat 300 / 分镜列表 1fr ── */}
        <section
          className="grid min-h-0 min-w-0 overflow-hidden rounded-[var(--fc-r-md)] border border-[var(--fc-line)] bg-[var(--fc-surface)]"
          style={{ gridTemplateRows: `${TOOLBAR_H}px ${MAT_H}px minmax(0,1fr)`, boxSizing: 'border-box' }}
        >
          {/* toolbar */}
          <div className="flex items-center gap-2 border-b border-[var(--fc-line)] px-3">
            <div className="flex min-w-0 items-center gap-2">
              <span className="truncate text-sm font-medium text-[var(--fc-ink)]">
                {current ? `#${current.seq} ${current.title}` : '未选中内容'}
              </span>
              {current && <StatusTag status={current.status} progress={current.progress} />}
              {current?.render && <span className="font-mono text-[10px] text-[var(--fc-faint)]">v{current.render.version}</span>}
              {ed.dirty && (
                <span className="flex items-center gap-1 font-mono text-[10px] text-[var(--fc-accent-deep)]">
                  <span className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--fc-accent)]" />未保存
                </span>
              )}
              {ed.saving && <span className="font-mono text-[10px] text-[var(--fc-faint)]">保存中…</span>}
            </div>
            <div className="ml-auto flex shrink-0 items-center gap-2">
              <button className={OUTLINE} disabled={!current}
                onClick={() => { confirmLeave().then((ok) => { if (ok) onCloseEditor() }) }}
                title="这版不要了：退出编辑态，回队列重做">打回重做</button>
              <button className={SOLID} disabled={!canApprove} onClick={approve}>通过并送分发</button>
              <div className="relative" ref={menuRef}>
                <button className={OUTLINE} onClick={() => setMenuOpen((v) => !v)} aria-label="更多">⋯</button>
                {menuOpen && (
                  <div className="absolute right-0 z-20 mt-1 w-52 rounded-[var(--fc-r-sm)] border border-[var(--fc-line-2)] bg-[var(--fc-surface-2)] py-1 text-sm shadow-lg">
                    <button className="block w-full px-3 py-1.5 text-left hover:bg-[var(--fc-bg)] disabled:text-[var(--fc-line-2)]"
                      disabled={!ed.spec} onClick={() => { setMenuOpen(false); doSave() }}>保存（⌘/Ctrl+S）</button>
                    <button className="block w-full px-3 py-1.5 text-left hover:bg-[var(--fc-bg)] disabled:text-[var(--fc-line-2)]"
                      disabled={!ed.spec} onClick={() => { setMenuOpen(false); doRenderFromSpec() }}>用当前编辑结果渲成片</button>
                    {!resetUnavailable && (
                      <button className="block w-full px-3 py-1.5 text-left hover:bg-[var(--fc-bg)] disabled:text-[var(--fc-line-2)]"
                        disabled={!ed.spec} onClick={() => { setMenuOpen(false); doReset() }}>重置为生成结果</button>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* preview mat：--fc-mat 底，9:16 画布居中 */}
          <div className="flex items-center justify-center" style={{ background: 'var(--fc-mat)', padding: MAT_PAD, boxSizing: 'border-box' }}>
            <StageBody
              selected={selected} current={current} ed={ed} playerRef={playerRef}
              busy={busy} videoRun={videoRun} onMakeVideo={onMakeVideo}
            />
          </div>

          {/* 分镜列表占位（Task 8） */}
          <div className="min-h-0 overflow-y-auto">
            <div className="flex h-[34px] items-center border-b border-[var(--fc-line)] px-3 font-mono text-[10px] uppercase tracking-wide text-[var(--fc-muted)]">
              分镜脚本
              {ed.spec && <span className="ml-auto text-[var(--fc-faint)]">播放头 {currentSec.toFixed(1)}s</span>}
            </div>
            <div className="p-3 text-xs text-[var(--fc-faint)]">分镜列表由 Task 8 装配。</div>
          </div>
        </section>

        {/* ── 右栏 320：Inspector（Task 9 正式化；这里挂 P0 视频参数，保证功能不空窗）── */}
        <aside
          className="flex min-h-0 flex-col overflow-hidden rounded-[var(--fc-r-md)] border border-[var(--fc-line)] bg-[var(--fc-surface)]"
          style={{ boxSizing: 'border-box' }}
        >
          <div className="flex h-[34px] shrink-0 items-center border-b border-[var(--fc-line)] px-3 font-mono text-[10px] uppercase tracking-wide text-[var(--fc-muted)]">
            参数（过渡版 · Task 9 接管）
          </div>
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
            <div className="rounded-[var(--fc-r-sm)] bg-[var(--fc-sunken)] px-2 py-1.5 text-xs text-[var(--fc-muted)]">
              {current ? `当前内容 #${current.seq} · ${current.title}` : '未选中内容——点左侧队列里的一条'}
            </div>
            <VideoParamFields vp={vp} setVp={setVp} bgmList={bgmList} />
            <button className={OUTLINE_BLOCK} disabled={!selected || busy || !current}
              onClick={() => current && onMakeVideo(current.copyAssetId)}>
              {videoRun.running ? '渲染中…' : '按参数重新生成（走全管线，会覆盖手工改动）'}
            </button>
            <TaskProgress run={videoRun} />
          </div>
        </aside>

        {/* ── 时间轴 186 整宽占位（Task 9）── */}
        <section
          className="col-span-3 overflow-hidden rounded-[var(--fc-r-md)] border border-[var(--fc-line)] bg-[var(--fc-surface)]"
          style={{ height: TIMELINE_H, boxSizing: 'border-box' }}
        >
          <div className="flex h-8 items-center border-b border-[var(--fc-line)] px-3 font-mono text-[10px] uppercase tracking-wide text-[var(--fc-muted)]">
            时间轴
          </div>
          <div className="p-3 text-xs text-[var(--fc-faint)]">时间轴由 Task 9 装配（刻度 / 分镜 / 字幕 / BGM / 卡点五轨）。</div>
        </section>
      </div>

      {notice && (
        <div className="rounded-[var(--fc-r-sm)] border border-[var(--fc-line-2)] bg-[var(--fc-surface-2)] px-3 py-2 text-xs text-[var(--fc-muted)]">
          {notice}
          <button className="ml-2 underline" onClick={() => setNotice(null)}>知道了</button>
        </div>
      )}

      {transitionExtras}
    </div>
  )
}

/** 中栏预览区的四种状态：没选项 / 没 spec（待出片）/ 自定义模板 / 正常播放。 */
function StageBody({
  selected, current, ed, playerRef, busy, videoRun, onMakeVideo,
}: {
  selected: string
  current: ContentItemView | null
  ed: ReturnType<typeof useEditorState>
  playerRef: RefObject<PlayerRef>
  busy: boolean
  videoRun: TaskRun
  onMakeVideo: (assetId: number) => void
}) {
  const hint = 'max-w-[420px] text-center text-xs leading-relaxed text-[var(--fc-line)]'
  if (!selected) return <div className={hint}>先在左上角选一个项目</div>
  if (!current) return <div className={hint}>在左栏队列里点一条内容进入剪辑台</div>
  // 待出片：还没渲过，磁盘上没有素材包，编辑台无从下手 —— 给出下一步而不是空白
  if (!current.render?.specPath) {
    return (
      <div className="flex flex-col items-center gap-3">
        <div className={hint}>先渲一版才能进剪辑台——剪辑台改的是「上一版成片的时间线」，还没有成片就没有可改的东西。</div>
        <button
          className="rounded-[var(--fc-r-sm)] border border-[var(--fc-line-2)] px-3 py-1.5 text-sm font-medium text-[var(--fc-line)] hover:bg-white/10 disabled:opacity-40"
          disabled={busy} onClick={() => onMakeVideo(current.copyAssetId)}>
          {videoRun.running ? '渲染中…' : '渲成片'}
        </button>
      </div>
    )
  }
  if (ed.loading) return <div className={hint}>载入素材包…</div>
  if (ed.loadError) return <div className={hint}>{ed.loadError}</div>
  const spec = ed.spec
  const preview = ed.previewSpec
  if (!spec || !preview) return <div className={hint}>载入素材包…</div>
  if (isUnsupported(spec)) {
    return <div className={hint}>自定义模板暂不支持剪辑——它的画面由 LLM 产出的模板 HTML 直接渲染，没有走图层模型（spec 的 layers 是空的）。</div>
  }
  return (
    <div style={{ width: CANVAS_W, height: CANVAS_H }}>
      <Player
        ref={playerRef}
        component={SpecComposition}
        inputProps={{ spec: preview }}
        durationInFrames={Math.max(1, secToFrames(spec.durationSec))}
        fps={FPS}
        compositionWidth={spec.canvas.width}
        compositionHeight={spec.canvas.height}
        style={{ width: '100%', height: '100%' }}
        controls
      />
    </div>
  )
}

/** 视频参数控件（过渡版，原 EditorTransitionTab 右栏原样搬迁）。 */
function VideoParamFields({ vp, setVp, bgmList }: { vp: VideoParams; setVp: (v: VideoParams) => void; bgmList: BgmList | undefined }) {
  const templates = useQuery({
    queryKey: ['templates'], queryFn: () => api<CustomTemplate[]>('/api/templates'), networkMode: 'always',
  })
  const tplOptions = [
    ...VIDEO_TPLS,
    ...(templates.data ?? []).map((t) => ({ value: `custom-${t.id}`, label: `${t.name}（对标拆解 · ${t.aspect_ratio === 'portrait' ? '竖屏' : '横屏'}）` })),
  ]
  const sel = 'mt-1 w-full rounded-[var(--fc-r-sm)] border border-[var(--fc-line-2)] bg-[var(--fc-surface-2)] p-1.5 text-sm'
  return (
    <>
      <div>
        <label className="text-xs text-[var(--fc-muted)]">模板</label>
        <select className={sel} value={vp.tpl} onChange={(e) => setVp({ ...vp, tpl: e.target.value })}>
          {tplOptions.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
        </select>
        {vp.tpl === 'demo' && <p className="mt-1 text-xs text-[var(--fc-faint)]">需先在项目详情页上传 shots/ 截图</p>}
      </div>
      <div>
        <label className="text-xs text-[var(--fc-muted)]">画布比例</label>
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
        <label className="text-xs text-[var(--fc-muted)]">BGM</label>
        <select className={sel} value={vp.bgm} onChange={(e) => setVp({ ...vp, bgm: e.target.value })}>
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
        <label className="text-xs text-[var(--fc-muted)]">情绪</label>
        <select className={sel} value={vp.mood} onChange={(e) => setVp({ ...vp, mood: e.target.value })}>
          {MOODS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
        </select>
      </div>
      <div>
        <label className="text-xs text-[var(--fc-muted)]">背景{vp.tpl === 'story' && <span className="text-[var(--fc-faint)]">（story 不显示背景层）</span>}</label>
        <select className={`${sel} disabled:opacity-50`} disabled={vp.tpl === 'story'} value={vp.bg} onChange={(e) => setVp({ ...vp, bg: e.target.value })}>
          {BGS.map((b) => <option key={b.value} value={b.value}>{b.label}</option>)}
        </select>
      </div>
      <label className="flex items-center gap-2 text-xs text-[var(--fc-muted)]">
        <input type="checkbox" checked={vp.captions} onChange={(e) => setVp({ ...vp, captions: e.target.checked })} />
        烧旁白字幕进视频（默认关）
      </label>
    </>
  )
}
