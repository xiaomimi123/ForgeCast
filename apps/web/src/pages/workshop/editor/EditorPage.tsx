// 深导入而非走包入口 `@forgecast/compositions`：入口带六份 CSS 的**副作用导入**，那样进来的样式
// 是「无层」的，会压过 Tailwind v4 放在 @layer utilities 里的所有工具类（base.css 里
// `* { margin:0;padding:0 }` 是给 1080×1920 渲染页写的，泄漏进控制台会把全站间距打平）。
// 样式改由 index.css 用 `@import ... layer(forgecast-compositions)` 引入，见那里的注释。
// **别顺手改回包入口**——子项目②的 Critical 就是这么来的。
import { SpecComposition } from '@forgecast/compositions/src/SpecComposition'
import { FPS, secToFrames } from '@forgecast/compositions/src/time'
import { Player, type PlayerRef } from '@remotion/player'
import { useQueryClient, type UseQueryResult } from '@tanstack/react-query'
import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { api, type BgmList, type ContentItemView } from '../../../api'
import { StatusTag } from '../../../components/ContentCard'
import { useConfirm } from '../../../components/ui/Confirm'
import { isUnsupported, videoIdFromSpecPath } from '../../../lib/rebase'
import type { TaskRun } from '../../../useTaskRun'
import InspectorPane from './InspectorPane'
import QueuePane from './QueuePane'
import ShotList from './ShotList'
import TimelinePane from './TimelinePane'
import { OUTLINE, SOLID, type VideoParams } from './ui'
import { NoOrigSnapshotError, useEditorState } from './useEditorState'

// 常量与按钮 class 住在 ./ui（叶子模块，无 import）。这里**转出**是为了不动既有调用方的 import
// 路径；新代码请直接从 './ui' 取，别再经 EditorPage 中转。
export { BGS, MOODS, OUTLINE, SOLID, VIDEO_TPLS, type VideoParams } from './ui'

/** 尺寸表（实施说明 §4）。数字集中在这里，三栏和时间轴都从这里取，避免各写各的对不上。 */
const TOOLBAR_H = 46
const MAT_H = 300
const MAT_PAD = 18
const TIMELINE_H = 186
/**
 * 右栏收抽屉的阈值（§4 窄屏表：<1240 右栏收成抽屉，toolbar 出现「参数」按钮）。
 * 三栏一起摆下时中栏最小宽必须是 **560 而不是 620**：300 + 620 + 320 + 两道 8 的 gap = 1256 > 1240，
 * 于是 1240–1256 这一段窗口宽度里整块网格比视口宽，横向滚动条从页面底部冒出来。
 */
const NARROW_PX = 1240
const MID_MIN = 560
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
  const { confirm, confirm3, element: confirmEl } = useConfirm()
  const playerRef = useRef<PlayerRef>(null)
  /** 当前播放头（秒）。Task 9 的时间轴消费；这里先存住，保证 frameupdate 接线在骨架期就是通的。 */
  const [currentSec, setCurrentSec] = useState(0)
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const [notice, setNotice] = useState<string | null>(null)
  /**
   * 重置端点 404 的兜底。**主判据是 `ed.hasOrig`（GET spec 带回来的，进场即知）**——这个 state
   * 只在「服务端说没快照」时补一刀，覆盖 hasOrig 与实际状态之间的竞态（比如快照被手工删掉）。
   */
  const [resetUnavailable, setResetUnavailable] = useState(false)
  /** 右栏图层检查器的选中图层。选中来源：ShotList 的 active 行、时间轴上点选的 Clip/字幕条。 */
  const [selectedLayerId, setSelectedLayerId] = useState<string | null>(null)
  /** 窄屏（<1240）时右栏收成抽屉；这个 state 是抽屉的开合。 */
  const [drawerOpen, setDrawerOpen] = useState(false)
  /**
   * spec 被**整包换掉**的次数（重置为生成结果 / 重写这段）。右栏的参数草稿是「相对当前 spec 的
   * 改动」，spec 换了草稿就无所指——但这两条路径都不换内容项，光靠 `current.id` 察觉不到。
   */
  const [specEpoch, setSpecEpoch] = useState(0)
  const wide = useViewportAtLeast(NARROW_PX)

  // 换内容项时复位这条内容独有的临时状态
  useEffect(() => {
    setCurrentSec(0); setMenuOpen(false); setNotice(null); setResetUnavailable(false); setSelectedLayerId(null)
  }, [videoId])
  const bumpSpecEpoch = useCallback(() => setSpecEpoch((v) => v + 1), [])

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
   * 原来是两段 window.confirm（先问要不要保存，答否再问确定丢弃），现在合成一个 confirm3
   * 三选弹层——'save'/'discard'/'cancel' 分别对应原来「确定＝保存并离开」「取消＋二次确定＝丢弃」
   * 「取消＋二次取消＝停留」。**保存失败时不放行**：语义与替换前完全一致，否则「保存了」的
   * 错觉加上改动丢失是最坏的组合。
   */
  async function confirmLeave(): Promise<boolean> {
    if (!ed.dirty) return true
    const choice = await confirm3({ title: '有未保存的改动', body: '要先保存吗？丢弃改动无法撤销。' })
    if (choice === 'cancel') return false
    if (choice === 'discard') return true
    try {
      await ed.save()
      return true
    } catch (e) {
      setNotice(`保存失败，已留在当前内容：${e instanceof Error ? e.message : String(e)}`)
      return false
    }
  }

  /** 队列点选：点的是当前这条就直接放行（不算离开），否则先过未保存闸门。 */
  function selectItemGuarded(item: ContentItemView) {
    if (item.id === selectedItemId) return
    confirmLeave().then((ok) => { if (ok) onSelectItem(item) })
  }

  async function doReset() {
    if (!(await confirm({ title: '重置为生成结果？', body: '剪辑台里的手工改动会全部丢弃，且不可撤销。', danger: true }))) return
    try {
      await ed.resetToOrig()
      bumpSpecEpoch()
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
  async function enqueueRender(): Promise<boolean> {
    if (!selected || !videoId) return false
    await api<{ taskId: string }>(`/api/projects/${selected}/specs/${videoId}/render`, { method: 'POST' })
    qc.invalidateQueries({ queryKey: ['content-items', selected] })
    return true
  }

  async function doRenderFromSpec() {
    if (!selected || !videoId) return
    if (!(await confirm({ title: '用当前编辑结果渲一版成片？', body: '旁白与字幕沿用上一版配音，改过的文字不会改配音。' }))) return
    try {
      // 与「重写这段」「用新参数重渲」互斥：这里也是服务端读改写（视需要先 PUT 落盘，
      // 再 POST 入队渲染读盘），在途时若并发发出另一条会静默互覆盖磁盘。
      const ran = await ed.runExclusive(async () => {
        // **防御式**：渲染端点读的是磁盘上的 spec，没落盘就入队等于渲了个旧版本。保存失败必须
        // 就地中止——继续入队会渲出一版「用户以为包含了刚才改动、其实没有」的成片，
        // 那比直接报错难查十倍。
        if (ed.dirty) {
          if (!(await ed.save())) { setNotice('渲成片已取消：当前内容没有可保存的素材包'); return true }
        }
        await enqueueRender()
        setNotice('已入队：渲染中，进度看队列卡片')
        return true
      })
      if (ran === undefined) setNotice('另一操作进行中，请稍候')
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
          // 窄屏（<1240）右栏收进抽屉，网格只剩两列——时间轴的 col-span 也跟着变，否则它会
          // 多占一列、把整块网格撑宽。
          gridTemplateColumns: wide ? `300px minmax(${MID_MIN}px,1fr) 320px` : `300px minmax(${MID_MIN}px,1fr)`,
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
              {/* 窄屏才出「参数」：宽屏右栏一直在，多一个按钮只是噪声 */}
              {!wide && (
                <button className={OUTLINE} onClick={() => setDrawerOpen((v) => !v)}
                  title="打开右栏参数检查器">参数</button>
              )}
              <button className={SOLID} disabled={!canApprove} onClick={approve}>通过并送分发</button>
              <div className="relative" ref={menuRef}>
                <button className={OUTLINE} onClick={() => setMenuOpen((v) => !v)} aria-label="更多">⋯</button>
                {menuOpen && (
                  <div className="absolute right-0 z-20 mt-1 w-52 rounded-[var(--fc-r-sm)] border border-[var(--fc-line-2)] bg-[var(--fc-surface-2)] py-1 text-sm shadow-lg">
                    <button className="block w-full px-3 py-1.5 text-left hover:bg-[var(--fc-bg)] disabled:text-[var(--fc-line-2)]"
                      disabled={!ed.spec} onClick={() => { setMenuOpen(false); doSave() }}>保存（⌘/Ctrl+S）</button>
                    {/* 「渲成片」不在这里了——它是右栏检查器底部的主线动作，两处入口只会让人犹豫点哪个 */}
                    {ed.hasOrig && !resetUnavailable && (
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

          {/* 分镜文案列表（Task 8）：改字即时可见 + 重写这段 */}
          <div className="min-h-0">
            <ShotList
              slug={selected} videoId={videoId} ed={ed} playerRef={playerRef}
              currentSec={currentSec} onNotice={setNotice} onSelectLayer={setSelectedLayerId}
              onSpecReplaced={bumpSpecEpoch} confirm={confirm}
            />
          </div>
        </section>

        {/* ── 右栏 320：Inspector（图层检查器 + 渲染参数暂存）。窄屏时移到下面的抽屉里 ── */}
        {wide && (
          <InspectorPane
            ed={ed} current={current} bgmList={bgmList} selectedLayerId={selectedLayerId}
            vp={vp} setVp={setVp} busy={busy} videoRun={videoRun} onMakeVideo={onMakeVideo}
            onNotice={setNotice} onEnqueueRender={enqueueRender} onRenderFromSpec={doRenderFromSpec}
            specEpoch={specEpoch} slug={selected} videoId={videoId} onSpecReplaced={bumpSpecEpoch}
          />
        )}

        {/* ── 时间轴 186 整宽（刻度 / 分镜 / 字幕 / BGM / 卡点 五轨）── */}
        <TimelinePane
          className={wide ? 'col-span-3' : 'col-span-2'}
          slug={selected} videoId={videoId}
          ed={ed} playerRef={playerRef} currentSec={currentSec}
          selectedLayerId={selectedLayerId} onSelectLayer={setSelectedLayerId}
          onNotice={setNotice} confirm={confirm}
        />
      </div>

      {/* 窄屏抽屉：右栏原样搬进来，宽度仍是 320——参数控件的排布是按这个宽度调的 */}
      {!wide && drawerOpen && (
        <div className="fixed inset-0 z-30 flex justify-end bg-black/25" onClick={() => setDrawerOpen(false)}>
          <div className="h-full w-[320px] bg-[var(--fc-surface)] shadow-xl" onClick={(e) => e.stopPropagation()}>
            {/* `h-full` 必须传到 aside 上：它是 `flex-col` + 内层 `overflow-y-auto`，不给高度约束
                内层永远算不出「超出」，矮窗口下底部的「渲成片」被挤出可视区且**滚不到**。 */}
            <InspectorPane
              className="h-full"
              ed={ed} current={current} bgmList={bgmList} selectedLayerId={selectedLayerId}
              vp={vp} setVp={setVp} busy={busy} videoRun={videoRun} onMakeVideo={onMakeVideo}
              onNotice={setNotice} onEnqueueRender={enqueueRender} onRenderFromSpec={doRenderFromSpec}
              specEpoch={specEpoch} slug={selected} videoId={videoId} onSpecReplaced={bumpSpecEpoch}
            />
          </div>
        </div>
      )}

      {notice && (
        <div className="rounded-[var(--fc-r-sm)] border border-[var(--fc-line-2)] bg-[var(--fc-surface-2)] px-3 py-2 text-xs text-[var(--fc-muted)]">
          {notice}
          <button className="ml-2 underline" onClick={() => setNotice(null)}>知道了</button>
        </div>
      )}

      {transitionExtras}
      {confirmEl}
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

/**
 * 视口宽是否 >= `px`。剪辑台的窄屏行为（§4）必须**跟着窗口实时变**：用一次性读 innerWidth 的写法，
 * 用户把窗口拉窄后右栏还在，三栏挤成一团；拉宽后抽屉按钮还在，点了出一个多余的浮层。
 * 用 matchMedia 而不是 resize 事件：只在越过阈值的那一刻回调一次，拖窗口时不会每帧 setState。
 */
function useViewportAtLeast(px: number): boolean {
  const [ok, setOk] = useState(() => (typeof window === 'undefined' ? true : window.innerWidth >= px))
  useEffect(() => {
    const mq = window.matchMedia(`(min-width: ${px}px)`)
    const on = () => setOk(mq.matches)
    on()
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [px])
  return ok
}
