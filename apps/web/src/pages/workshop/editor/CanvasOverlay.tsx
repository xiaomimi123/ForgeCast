import type { LayerStyle, VideoSpec } from '@forgecast/compositions/src/videospec-types'
import { clampToCanvas, setLayerStyle, snapPosition, type CanvasRect, type SnapGuide } from '@forgecast/editing'
import type { PlayerRef } from '@remotion/player'
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react'
import type { useEditorState } from './useEditorState'

/** 吸附命中阈值（画布 px）。与 `snapPosition` 的默认值一致，写在这里是为了 Alt 旁路那一行读得懂。 */
const SNAP_PX = 8
/** 选中态四角手柄边长（**显示 px**，不随画布缩放变）。 */
const HANDLE = 8
/** 缩放的宽度下限（画布 px）。比这更窄的层在 1080 宽的画布里是一条缝，选都选不回来。 */
const MIN_WIDTH = 40
/** 方向键微移步长（画布 px）；按住 Shift 走 NUDGE_FAST。 */
const NUDGE = 1
const NUDGE_FAST = 10
/** 方向键 → 单位位移。写成表而不是四个 if，键盘分支里只剩一次查表。 */
const ARROWS: Record<string, { x: number; y: number }> = {
  ArrowLeft: { x: -1, y: 0 }, ArrowRight: { x: 1, y: 0 }, ArrowUp: { x: 0, y: -1 }, ArrowDown: { x: 0, y: 1 },
}
/**
 * 起拖阈值（显示 px）。指针在这个范围内挪动一律**只算点选**：不置 `moved`、不固化、不写 spec。
 * 没有它的话，点一下卡片时手抖一两个像素就会把「点选高亮」变成一次真实改动（spec 变脏 + 一格 undo），
 * 而在 148px 宽的预览里 1 显示 px ≈ 7 画布 px，抖出去的位移肉眼还看不出来——最难查的那种脏。
 */
const DRAG_START_PX = 3
const round3 = (n: number) => Math.round(n * 1000) / 1000

/**
 * 一次测量的结果。`rect` 是**视觉**矩形（画布坐标系，含该图层自身 transform），`tx/ty` 是视觉左上角
 * 相对**布局**左上角的偏移，`layoutW` 是未经 transform 的布局宽。
 *
 * 三者必须分开：
 * - 模板 CSS 里 `.cap` 是 `left:50%; transform:translateX(-50%)`——`offsetLeft` **不受 transform 影响**，
 *   量到的是 540（left 的值），而肉眼看到的左缘在 540 - w/2；
 * - 入场特效期间 LayerView 还会写 `scale(...)`（highlightCard 的淡入就是缩放），此刻元素在屏幕上比布局盒小一圈。
 *
 * 所以「画命中框 / 算吸附」用 `rect`（所见即所得），「写进 style.x/width」用 `rect.x - tx` / `layoutW`
 * （布局口径）——否则固化会把一个**动画中间态**的位置和宽度烧进 spec。
 *
 * `layoutH` 只在 `needHeight` 时才写回：模板里 `.cap` 是 `bottom:150px` 定位的，我们再写一个 `top`
 * 就**过约束**了——CSS 在 top/height:auto/bottom 三者中会去算 height，字幕条会从一行高被抻到贴底
 * （实测高度 21→41px，深色底条整片变高）。补一个显式 height 让 bottom 被忽略即可。反过来，普通
 * 文档流图层（bottom 是 auto）**不写** height：那会把「文字变长自动撑高」这条也一起冻死。
 *
 * 判据**自守，不需要调用方门控**：`heightWouldCollapse` 先按 `bottom === 'auto'` 挡掉没有底部约束的层，
 * 再拿「把 top 挪 1px 高度变不变」实测一次（见该函数）。已经固化过的层再探一遍只会得到同样的答案，
 * 而且 `setLayerStyle` 是合并式的 patch——判成 false 时不写 height，也不会把上一次写下的 height 抹掉。
 *
 * **已知限制**：从 transform 还原视觉矩形时假定 `transform-origin` 是默认的元素中心（六份模板的 CSS 与
 * LayerView 写的 transform 都没改过它）。哪天模板给某个类写了非中心的 transform-origin，那一层的命中框
 * 会与画面错开——真出现时按 `getComputedStyle(el).transformOrigin` 解析补上即可。
 */
interface Measured {
  rect: CanvasRect; tx: number; ty: number; layoutW: number; layoutH: number
  /**
   * 该层**自身的 margin**（画布 px）。写 `style.top/left` 时必须减掉它。
   *
   * 绝对定位的元素，margin 仍然生效：最终位置是「包含块原点 + top + margin-top」。而 `offsetTop`
   * 量到的是加过 margin 之后的位置。两边不扣掉的话，写回的 top 会比目标位置多一份 margin——
   * 每写一次多漂一次（changelog 的 `.title` 有 44px 上边距，方向键按一下漂 45px 就是这么来的；
   * 拖拽同样中招，只是一次手势只写一次，看着像「一按下就跳一下」）。
   * flash/story/demo/insight 的首层 margin 恰好是 0，所以 Task 3 的自测没撞上。
   */
  mx: number; my: number
}

/**
 * 全片推镜（`#cam` 的 `translate(...)scale(1→1.06)`，见 compositions/Background.tsx）的当前值。
 *
 * 量图层用 offset 系（免疫 transform，量出来就是画布 px，正是要写进 style.x 的口径），但**肉眼看到的**
 * 位置还被推镜推过一道：越靠画面边缘、越到片尾偏得越多（片尾 6%，1920 高的底部约 58px）。命中框/选中框
 * 若不跟着推，用户会发现框和卡片错开一截。故：坐标算 / 存都在 offset 系，**只有渲染**时把浮层整体套上
 * 同一个推镜变换；指针位移换算也要除掉它（屏幕上动 1px，画布里只动 1/s px）。
 */
/**
 * 「视觉位置 → 写进 style 的几何 patch」的**唯一**出口。拖动 / 缩放 / 键盘微移三条写回路径都走它，
 * 免得 `- tx - mx` 这类修正项在三处各抄一份（margin 那条就是漏抄一处才被发现的，见 Measured.mx）。
 *
 * `vx/vy` 是目标**视觉**左上角（画布坐标），`r` 是缩放比（拖动/微移恒为 1）。
 * `tx` 随 r 缩、`ty` 不缩、margin 都不缩——三者的理由见 `onResize` 的注释。
 */
function geometryPatch(
  src: { tx: number; ty: number; mx: number; my: number; layoutW: number; layoutH: number },
  vx: number, vy: number,
  opts: { r?: number; height?: boolean; fontSize?: number } = {},
): Partial<LayerStyle> {
  const r = opts.r ?? 1
  const patch: Partial<LayerStyle> = {
    x: round3(vx - src.tx * r - src.mx),
    y: round3(vy - src.ty - src.my),
    width: round3(src.layoutW * r),
  }
  if (opts.height) patch.height = round3(src.layoutH * r)
  if (opts.fontSize !== undefined) patch.fontSize = opts.fontSize
  return patch
}

interface Cam { s: number; e: number; f: number }
const CAM_IDENTITY: Cam = { s: 1, e: 0, f: 0 }

interface DragState {
  layerId: string
  /** `move`＝拖整层改 x/y；`resize`＝拖四角手柄改宽（文字层顺带联动字号）。 */
  mode: 'move' | 'resize'
  /** resize：抓的是左侧 / 上侧的手柄吗——决定对角哪个点固定不动。 */
  fromLeft: boolean
  fromTop: boolean
  /** resize：按下那一刻该层的 computed font-size（画布 px）。0＝解析不出，此次不联动字号。 */
  baseFont: number
  /** resize：等比缩放时要不要一起写 height。文字/caption 不写（高度该由字号与换行自己决定），
   *  image/shape 与「写 top 会塌高」的层（needHeight）必须写。 */
  resizeHeight: boolean
  /** resize：宽度变化是否联动字号（text/caption 才联动；image/shape 只改宽高）。 */
  scalesFont: boolean
  /** resize：最后一帧用的比例 / 视觉左上角 / 字号——松手时的高度校正要用同一组参数重算（见 fixBottomEdge）。 */
  lastR: number
  lastX: number
  lastY: number
  lastFont: number | undefined
  /** 按下那一刻的 spec，每帧都从它重算（不做增量累加，中途回拖不漂）——同 TimelinePane。 */
  base: VideoSpec
  startX: number
  startY: number
  rect: CanvasRect
  tx: number
  ty: number
  layoutW: number
  layoutH: number
  /** 该层自身的 margin（见 Measured.mx）。写 top/left 时要减掉。 */
  mx: number
  my: number
  needHeight: boolean
  /** 显示 px → 画布 px 的换算比（containerWidth / canvas.width），按下时现取。 */
  scale: number
  /** 同时刻其他可见图层的视觉矩形——吸附参考线的来源，按下时算一次。 */
  others: CanvasRect[]
  /** 是否真的动过（超过 DRAG_START_PX）。纯点选不许固化，否则「点一下卡片高亮」就把 spec 弄脏了。 */
  moved: boolean
  /** 本次拖拽挂在 window 上的监听，收尾时按这个引用摘掉（见 onDown 的注释）。 */
  off: () => void
}

/**
 * 画布上的选中 / 拖动 / 吸附线浮层（子项目⑤ Task 3）。
 *
 * 测量口径：图层 DOM 的 `id` 就是 `layer.id`（LayerView），沿 `offsetParent` 链把 `offsetLeft/Top`
 * 累加到合成根 `.specRoot`。**用 offset 系而不是 getBoundingClientRect**：Player 用 `transform:scale`
 * 缩放整个合成、`#cam` 还有一层全片推镜 scale(1→1.06)，rect 系会把这两层缩放一起量进来，而 offset 系
 * 天然免疫 transform，量出来的就是画布 px。
 *
 * 测量时机：pointerdown 现取（原点与比例）+ `spec / currentSec / 可见集合 / 播放态`变化时重测一次
 * （见 measure effect）。拖拽期间 spec 每帧换新对象，effect 照样每帧进来，但**开头就按 dragRef 早退**，
 * 所以「不每帧测」靠的是那道早退而不是漏依赖——漏了 spec 才是真出事：⌘Z 撤销、右栏改 X/Y 之后 measured
 * 还停在旧值，下一次拖拽拿 stale 基线把图层弹回撤销前的位置。
 *
 * 撤销口径沿用 TimelinePane：拖拽期间 `applyTransient`，`pointerup` 才 `commit`，一次拖拽 = 一步 undo；
 * 「文档流固化」（把测量出的 x/y/width 写进 style）也压在同一格里，⌘Z 一步回到拖之前。
 */
export default function CanvasOverlay({
  spec, currentSec, playerRef, selectedLayerId, onSelectLayer, ed, containerRef, blocked = false,
}: {
  /** 权威 spec（`ed.spec`，不是 previewSpec）——写回要用它；两者的图层 id/时间完全一致。 */
  spec: VideoSpec
  currentSec: number
  playerRef: RefObject<PlayerRef>
  selectedLayerId: string | null
  onSelectLayer: (layerId: string | null) => void
  ed: ReturnType<typeof useEditorState>
  /** 包住 Player 的相对定位容器：既是测量的宿主，也是浮层的坐标原点。 */
  containerRef: RefObject<HTMLDivElement>
  /**
   * confirm 弹层是否开着。开着时方向键微移要让路——与 EditorPage 里 ⌘Z 的 `confirmOpenRef` 同一道门：
   * 弹层通常正在问「要不要保存/丢弃」，此刻不该再被键盘悄悄改动 spec。
   */
  blocked?: boolean
}) {
  const [measured, setMeasured] = useState<Record<string, Measured>>({})
  /** 合成在容器里的左上角（显示 px，相对容器）。**不假定合成铺满容器**：横屏 spec 在 9:16 的容器里
   *  是按宽适配、上下留黑边的，原点当成 (0,0) 会让整层浮层纵向错位半个黑边。 */
  const [origin, setOrigin] = useState({ x: 0, y: 0 })
  const [scale, setScale] = useState(1)
  const [cam, setCam] = useState<Cam>(CAM_IDENTITY)
  const [playing, setPlaying] = useState(false)
  const [guides, setGuides] = useState<SnapGuide[]>([])
  /** 拖拽中被拖那层的**实时视觉矩形**（画布坐标）。null＝没在拖。 */
  const [drag, setDrag] = useState<{ id: string; rect: CanvasRect } | null>(null)
  /** 拖拽收尾后强制重测一次：measure effect 在拖拽中是主动跳过的，不 bump 它就停在拖前的值。 */
  const [nonce, setNonce] = useState(0)
  const dragRef = useRef<DragState | null>(null)

  const canvas = useMemo(() => ({ w: spec.canvas.width, h: spec.canvas.height }), [spec.canvas.width, spec.canvas.height])

  /** 此刻可见、且可拖的图层：video 层不进（口播底片铺满全画布，拖它没有意义）。 */
  const visible = useMemo(
    () => spec.layers.filter((l) => l.content.kind !== 'video' && currentSec >= l.start && currentSec < l.start + l.duration),
    [spec, currentSec],
  )
  /** 可见集合的指纹：spec 每帧换新对象，用它当依赖才不会每帧重测。 */
  const visibleKey = visible.map((l) => l.id).join(',')

  // 播放态：用 Player 的 play/pause 事件订阅，**不轮询**。播放中不渲命中区（观看态）。
  // ref 在本组件首次 effect 时可能还没填上（Player 与浮层是同一次提交里挂的，谁先谁后不保证），
  // 直接 return 会让订阅**永久缺席**——播放时命中区照旧铺着。故按帧重试到拿到 ref 为止。
  useEffect(() => {
    let raf = 0
    let tries = 0
    let p: PlayerRef | null = null
    const on = () => setPlaying(true)
    const off = () => setPlaying(false)
    const attach = () => {
      p = playerRef.current
      if (!p) { if (tries++ < 60) raf = requestAnimationFrame(attach); return }
      setPlaying(p.isPlaying())
      p.addEventListener('play', on)
      p.addEventListener('pause', off)
    }
    attach()
    return () => {
      if (raf) cancelAnimationFrame(raf)
      p?.removeEventListener('play', on)
      p?.removeEventListener('pause', off)
    }
  }, [playerRef, spec.canvas.width])

  /**
   * 量一遍当前可见图层。放进 ref 而不是进 effect 的依赖数组：它闭包里的 `visible` 每次渲染都是
   * 新数组（spec 每帧换新对象），当依赖会让 effect **每次渲染都重跑**，正好破坏「不每帧测」。
   */
  const doMeasure = (): boolean => {
    const container = containerRef.current
    if (!container) return false
    // 合成根：offsetParent 链的终点。Player 首帧还没挂上时它是 null——调用方按 false 重试。
    const root = container.querySelector<HTMLElement>('.specRoot')
    if (!root) return false
    const box = stageBox(container, root)
    if (!box) return false
    const next: Record<string, Measured> = {}
    for (const l of visible) {
      const el = container.querySelector<HTMLElement>(`#${CSS.escape(l.id)}`)
      if (!el) continue
      const m = measureLayer(root, el)
      if (m) next[l.id] = m
    }
    setScale(box.scale)
    setOrigin({ x: box.x, y: box.y })
    setCam(camOf(root))
    setMeasured(next)
    return true
  }
  // 写 ref 是副作用，不能在 render 阶段做（StrictMode 下 render 会跑两次；并发渲染还可能丢弃这次结果）。
  // 声明在 measure effect **之前**：同一次提交里 effect 按声明序执行，所以下面那个 effect 读到的一定是新的。
  const measureRef = useRef(doMeasure)
  useEffect(() => { measureRef.current = doMeasure })

  useEffect(() => {
    if (playing) { setMeasured({}); return }
    let raf = 0
    let tries = 0
    const run = () => {
      // 拖拽中主动跳过：被拖那层的位置由 drag 状态给出，别人也没动
      if (dragRef.current) return
      // Player 的首帧可能还没挂进 DOM（.specRoot 找不到）——退回下一帧再试，最多约 1 秒。
      if (!measureRef.current() && tries++ < 60) raf = requestAnimationFrame(run)
    }
    run()
    return () => { if (raf) cancelAnimationFrame(raf) }
    // 依赖里必须有 `spec` 本体：⌘Z 撤销、右栏改 X/Y 都只换 spec 引用，可见集合与 currentSec 一动不动，
    // 漏了它 measured 就停在旧值，下一次拖拽会拿 stale 基线把图层弹回撤销前的位置。
    // 拖拽期间 spec 每帧换新对象，effect 照样进来，但开头 `dragRef.current` 早退，不会真的重测。
  }, [playing, visibleKey, currentSec, nonce, spec])

  // 点在图层命中区之外（画面空白 / 视频层 / 播放器控制条）＝取消选中。
  // 用容器上的**原生**监听而不是铺一层 pointer-events:auto 的背板：背板会把 Player 自己的
  // 点击（点画面播放/暂停）整片吃掉。原生监听不拦事件，只是顺带看一眼落点。
  // 判据用 `closest('[data-canvas-hit]')` 而不是 React 侧 stopPropagation——React 的合成事件
  // 挂在 root 上，比容器上的原生监听**后**触发，那时再 stopPropagation 已经晚了。
  useEffect(() => {
    const c = containerRef.current
    if (!c) return
    const onDown = (e: PointerEvent) => {
      const t = e.target as HTMLElement | null
      if (t?.closest?.('[data-canvas-hit]')) return
      onSelectLayer(null)
    }
    c.addEventListener('pointerdown', onDown)
    return () => c.removeEventListener('pointerdown', onDown)
  }, [containerRef, onSelectLayer])

  /** ed 的最新引用。卸载清理（下面那个 effect）跑在最后一次渲染之后，闭包捕获的 ed 会是过期的那份。 */
  const edRef = useRef(ed)
  useEffect(() => { edRef.current = ed })

  // 拖拽中被卸载（切内容项 / loading 翻转 / 中途开播）：pointerup 永远不会到达，
  // 不收尾的话 transient 序列的基线一直攥在 useEditorState 手里，`undo/redo` 被 `dragging()` 判定
  // 为「拖拽中」而**永久失效**——用户此后按 ⌘Z 一动不动，且看不出为什么。故卸载时强制收尾。
  useEffect(() => () => {
    const d = dragRef.current
    if (!d) return
    dragRef.current = null
    d.off()
    if (d.moved) edRef.current.commit()
  }, [])

  /**
   * 方向键微移：选中层 ±1px（Shift ±10px）。**一次按键 = 一步 undo**（直接 `apply`，不走 transient）
   * ——长按连发会压出一串 undo，但比「连按十下只能撤销一下」好：微移本来就是逐格试位置的动作。
   *
   * 让路的四道门：输入框/textarea/contentEditable 聚焦（那时方向键是光标移动）、confirm 弹层开着、
   * 服务端读改写在途（busy/saving，同拖拽那道闸）、以及正在拖拽中。带修饰键（⌘/Ctrl/Alt）的一律不接，
   * 免得吃掉浏览器或后续可能新增的组合键。
   *
   * 位置一律从 `measured`（视觉矩形）现算而不是读 `style.x + 1`：这样未固化的层第一次按方向键就会
   * 被就地固化（写 x/y/width），与拖拽的固化口径完全一致，不必分两条路。
   */
  function onKey(e: KeyboardEvent) {
    const dir = ARROWS[e.key]
    if (!dir) return
    if (e.metaKey || e.ctrlKey || e.altKey) return
    if (!selectedLayerId || playing || blocked || ed.busy || ed.saving || dragRef.current) return
    // 用 closest 而不是只看 target 自己的 tagName：右栏的下拉（背景变体/BGM/情绪）是 `<select>`，
    // 漏了它的话，聚焦下拉按 ↓ 会「既翻不动选项、又把图层挪 1px」；closest 还顺手覆盖了包了一层
    // 壳的控件（点在 label/包装 div 上但焦点在里面的 input）。
    const t = e.target as HTMLElement | null
    if (t?.closest?.('input, textarea, select, [contenteditable]')) return
    const s = ed.spec
    const m = measured[selectedLayerId]
    const container = containerRef.current
    if (!s || !m || !container) return
    e.preventDefault()
    const step = e.shiftKey ? NUDGE_FAST : NUDGE
    const raw: CanvasRect = { ...m.rect, x: m.rect.x + dir.x * step, y: m.rect.y + dir.y * step }
    const c = clampToCanvas(raw, canvas)
    // 收掉右栏输入框可能还没收尾的 transient 序列（同 onDown），免得这一下微移挤进上一次数值编辑那格。
    ed.commit()
    const needHeight = heightWouldCollapse(container.querySelector<HTMLElement>(`#${CSS.escape(selectedLayerId)}`))
    ed.apply(setLayerStyle(s, selectedLayerId, geometryPatch(m, c.x, c.y, { height: needHeight })))
  }
  // 闭包每次渲染都换新（measured/ed/selectedLayerId 都会变），放进 ref 由一个常挂的监听转发，
  // 免得每帧摘挂一次 window 监听。姿势同上面的 measureRef。
  const keyRef = useRef(onKey)
  useEffect(() => { keyRef.current = onKey })
  useEffect(() => {
    const h = (e: KeyboardEvent) => keyRef.current(e)
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [])

  /**
   * 一次手势的起点，拖动与缩放共用：`mode==='move'` 是整层平移，`'resize'` 是四角手柄改宽。
   * 两者的基线（按下那刻的 spec / 视觉矩形 / 布局宽高 / 换算比）完全一样，差别只在 onMove 怎么算。
   */
  function onDown(e: ReactPointerEvent<HTMLDivElement>, layerId: string, mode: 'move' | 'resize' = 'move', fromLeft = false, fromTop = false) {
    // 服务端读改写在途（重写这段 / 渲成片）或正在落盘时不许拖：那几条路径会整包换掉或写回 spec，
    // 此刻改本地 spec 等于和它们赛跑。与右栏/时间轴按钮的 disabled 同一道闸。
    if (ed.busy || ed.saving) return
    e.preventDefault()
    onSelectLayer(layerId)
    const s = ed.spec
    const m = measured[layerId]
    const container = containerRef.current
    const root = container?.querySelector<HTMLElement>('.specRoot') ?? null
    if (!s || !m || !container || !root) return
    const box = stageBox(container, root)
    if (!box) return
    // 先收掉右栏输入框可能还没收尾的 transient 序列（pointerdown 早于 blur），
    // 否则这次拖拽会和上一次数值编辑挤进同一格 undo。姿势同 TimelinePane.startDrag。
    ed.commit()
    const target = e.currentTarget
    // move/up 挂 **window** 而不是 hitbox：指针捕获失败（某些浏览器/合成事件下 setPointerCapture 会抛）
    // 时事件不会再回到 hitbox，挂在它身上的 move/up 就此失联，拖拽卡在半途、dragRef 再也收不了尾。
    // 挂 window 则捕获成功与否行为都一样（捕获只是把事件重定向到 hitbox，照样冒泡到 window）。
    const move = (ev: PointerEvent) => onMove(ev)
    const up = (ev: PointerEvent) => onUp(ev)
    const off = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      try { if (target.hasPointerCapture(e.pointerId)) target.releasePointerCapture(e.pointerId) } catch { /* 已释放/元素已卸载 */ }
    }
    const el = container.querySelector<HTMLElement>(`#${CSS.escape(layerId)}`)
    // 要不要补 height：现场探一次（见 heightWouldCollapse）。一次手势只探一次，不进逐层测量。
    const needHeight = heightWouldCollapse(el)
    const kind = s.layers.find((l) => l.id === layerId)?.content.kind
    // 文字与字幕按字号联动（宽变大字也变大，观感才是「整体放大」）；image/shape 没有字号可联动，
    // 改的是宽高本身。缺省按文字处理：新出现的图层类型多半是带字的。
    const scalesFont = kind !== 'image' && kind !== 'shape'
    dragRef.current = {
      layerId, mode, fromLeft, fromTop,
      base: s, startX: e.clientX, startY: e.clientY,
      rect: m.rect, tx: m.tx, ty: m.ty, layoutW: m.layoutW, layoutH: m.layoutH, mx: m.mx, my: m.my,
      needHeight,
      // 文字层的高度让字号与换行自己决定，别写死；image/shape 必须等比写高，
      // needHeight 的层（如 bottom 定位的字幕条）本来就得有显式高度，缩放时按比例跟着走。
      resizeHeight: !scalesFont || needHeight,
      scalesFont,
      lastR: 1, lastX: m.rect.x, lastY: m.rect.y, lastFont: undefined,
      baseFont: el ? parseFloat(getComputedStyle(el).fontSize) || 0 : 0,
      scale: box.scale * cam.s,
      others: visible.filter((l) => l.id !== layerId).map((l) => measured[l.id]?.rect).filter((x): x is CanvasRect => !!x),
      moved: false,
      off,
    }
    try { target.setPointerCapture(e.pointerId) } catch { /* 捕获失败也无妨：move/up 挂在 window 上 */ }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
  }

  function onMove(e: PointerEvent) {
    const d = dragRef.current
    if (!d) return
    const dx = e.clientX - d.startX
    const dy = e.clientY - d.startY
    // 起拖阈值：没越过就当纯点选，一个字都不写（见 DRAG_START_PX）
    if (!d.moved && Math.hypot(dx, dy) < DRAG_START_PX) return
    d.moved = true
    if (d.mode === 'resize') { onResize(d, dx); return }
    const raw: CanvasRect = { x: d.rect.x + dx / d.scale, y: d.rect.y + dy / d.scale, w: d.rect.w, h: d.rect.h }
    // 吸附**先于**钳制：先把「用户想放的位置」吸到参考线，再由钳制把出界的拉回来。
    // 反过来会把刚钳到边上的位置又吸走，重新推出画布。（同 TimelinePane 的先吸后钳。）
    const snapped = snapPosition(raw, d.others, canvas, SNAP_PX, e.altKey)
    const clamped = clampToCanvas({ ...raw, x: snapped.x, y: snapped.y }, canvas)
    setDrag({ id: d.layerId, rect: { ...raw, x: clamped.x, y: clamped.y } })
    // 被钳制拉走的那个轴上，参考线已经不成立了——还画着就是在骗人
    setGuides(snapped.guides.filter((g) => (g.axis === 'x' ? clamped.x === snapped.x : clamped.y === snapped.y)))
    // 固化与位移写在**同一次** applyTransient 里：width 必须一起写死，否则 position:absolute 之后
    // 宽度从「文档流里的整行」塌成内容宽，文字换行、观感全变。style.x 存的是 left，故要减掉 transform。
    ed.applyTransient(setLayerStyle(d.base, d.layerId, geometryPatch(d, clamped.x, clamped.y, { height: d.needHeight })))
  }

  /**
   * 四角手柄的缩放。**只看横向位移**：一个比例 r 同时决定宽、（等比的）高与字号，
   * 纵向再掺一脚就会出现「拖出的框和真实渲染结果对不上」——文字层的高度本来就由字号和换行决定，
   * 用户拖出来的高度不可能被兑现，不如从一开始就只认宽度这一维（四个角的手感因此完全一致）。
   *
   * 固定点是被抓那个角的对角：抓左侧则右缘不动、抓上侧则下缘不动。
   *
   * `tx`（自身 transform 的横向位移）要**跟着比例缩**：它在实际模板里都是按元素宽算出来的
   * （`.cap` 的 translateX(-50%) 就是 -w/2），宽变 r 倍位移也变 r 倍。不缩的话，字幕条一放大就向右漂
   * （实测放大 5% 左缘漂 29 画布 px）。`ty` **不缩**：纵向位移在模板里是 slideUp 那种固定 px 的入场
   * 位移，与尺寸无关，跟着缩会让图层在缩放时莫名上下窜（实测放大 12% 窜 2px）。唯一不吻合的是入场
   * 缩放动画带来的那点 ty，但那是个转瞬即逝的中间态，缩不缩都不准。
   */
  function onResize(d: DragState, dxPx: number) {
    const dx = dxPx / d.scale
    const w = Math.max(MIN_WIDTH, d.fromLeft ? d.rect.w - dx : d.rect.w + dx)
    const r = d.rect.w > 0 ? w / d.rect.w : 1
    // 文字层的真实新高度要等重排后才知道，这里按同比例给个预览高度（松手重测就对齐了）。
    const h = d.rect.h * r
    const x = d.fromLeft ? d.rect.x + d.rect.w - w : d.rect.x
    const y = d.fromTop ? d.rect.y + d.rect.h - h : d.rect.y
    setDrag({ id: d.layerId, rect: { x, y, w, h } })
    // 字号取整：spec 里留一串 23.9997 既没意义，也会让右栏的数字框变得没法看。
    const fontSize = d.scalesFont && d.baseFont > 0 ? Math.round(d.baseFont * r) : undefined
    // 松手时的下缘校正要用同一组参数重算一次（见 onUp），故记下来。
    d.lastR = r
    d.lastX = x
    d.lastY = y
    d.lastFont = fontSize
    ed.applyTransient(setLayerStyle(d.base, d.layerId, geometryPatch(d, x, y, { r, height: d.resizeHeight, fontSize })))
  }

  /**
   * 缩放松手时的**高度校正**：把「按比例估的高度」换成浏览器重排后的真实高度。
   *
   * 缩放期间没法知道文字层的真实新高度（换行要等重排），`onResize` 只能按比例估一个 `h`。它有两处会
   * 把误差**写进 spec**（不只是拖拽时的视觉抖动）：
   * - 抓上侧手柄时「下缘不动」的 y 是由这个 h 算出来的——多行文本换行位置一跳，能差一整行；
   * - 需要显式高度的文字/字幕层（`.cap` 那种 bottom 定位的，见 `needHeight`）会把 `layoutH × r` 直接
   *   冻进 `style.height`——字号联动之后真实高度并不等比（行高取整、换行数变化），底条要么留一截空、
   *   要么把最后一行压出去。
   *
   * 松手这一刻 DOM 已按最后一帧重排完，此时重测一次再补一发 `applyTransient`——仍在同一段 transient
   * 序列里，所以依旧是**一步 undo**。
   *
   * `image`/`shape`（`!scalesFont`）不在校正范围内：它们的「等比改宽高」本来就是要写死的那个值，
   * 量出来也只会原样量回我们写下的数，校正是空转。
   */
  function fixBottomEdge(d: DragState) {
    if (d.mode !== 'resize' || !d.moved) return
    /** 高度由字号和换行决定、却被我们写成显式值的那一支——要拿「内容自然高」把它换掉。 */
    const refitHeight = d.scalesFont && d.resizeHeight
    if (!d.fromTop && !refitHeight) return
    const container = containerRef.current
    const root = container?.querySelector<HTMLElement>('.specRoot')
    const el = container?.querySelector<HTMLElement>(`#${CSS.escape(d.layerId)}`)
    if (!root || !el) return
    const m = measureLayer(root, el)
    const lh = el.offsetHeight
    if (!m || !lh) return
    /** 布局高 → 视觉高的比（该层自身 transform 的纵向缩放，一般是 1）。 */
    const a = m.rect.h / lh
    const layoutH = refitHeight ? naturalHeight(el) : lh
    const y = d.fromTop ? d.rect.y + d.rect.h - layoutH * a : d.lastY
    const patch = geometryPatch(d, d.lastX, y, { r: d.lastR, fontSize: d.lastFont })
    if (d.resizeHeight) patch.height = round3(refitHeight ? layoutH : d.layoutH * d.lastR)
    ed.applyTransient(setLayerStyle(d.base, d.layerId, patch))
  }

  function onUp(_e?: PointerEvent | ReactPointerEvent<HTMLDivElement>) {
    const d = dragRef.current
    if (!d) return
    dragRef.current = null
    d.off()
    fixBottomEdge(d)
    setDrag(null)
    setGuides([])
    setNonce((n) => n + 1)
    // 一次拖拽收成一步 undo（没越过起拖阈值则 transient 序列压根没开，commit 是空操作）
    if (d.moved) ed.commit()
  }

  if (playing) return null

  const px = (v: number) => v * scale
  /** 浮层整体套上与 `#cam` 相同的推镜（translate 要换算到显示 px；缩放原点同为几何中心）。 */
  const camStyle = {
    position: 'absolute', left: origin.x, top: origin.y, width: px(canvas.w), height: px(canvas.h),
    transform: `translate(${px(cam.e)}px, ${px(cam.f)}px) scale(${cam.s})`, transformOrigin: '50% 50%',
  } as const
  const rectOf = (id: string): CanvasRect | null =>
    (drag && drag.id === id ? drag.rect : measured[id]?.rect) ?? null
  const sel = selectedLayerId ? rectOf(selectedLayerId) : null
  const selKind = selectedLayerId ? spec.layers.find((l) => l.id === selectedLayerId)?.content.kind : undefined

  return (
    <>
      {/*
        命中区。整层 pointer-events:none，只有 hitbox 自己是 auto。

        **与 Player 控制条的取舍**：控制条铺在画布底部，命中区盖住它之后那一片就点不动了。
        试过在底部留一条 44px 不可点的缝，但模板里贴底的恰恰是最需要拖的那批（`.cap` 字幕条
        `bottom:150px`、CTA），留缝等于让它们**永远选不中**——功能本身破了个洞，比控制条被挡更糟。
        故不留缝。代偿：图层之外的画面仍可点（控制条在没有图层盖住的横向区段照常可用），
        空格键切播放/暂停仍生效，时间轴那一栏本来就能拖播放头；且**播放中整层不渲染**，
        所以「播放时点暂停」永远点得到。
      */}
      <div
        style={{
          position: 'absolute', inset: 0, overflow: 'hidden', pointerEvents: 'none',
        }}
      >
        <div style={camStyle}>
          {visible.map((l) => {
            const r = rectOf(l.id)
            if (!r) return null
            return (
              <div
                key={l.id}
                data-canvas-hit={l.id}
                // tooltip 只给选中层：命中区铺满整个图层，人人都挂 title 的话，鼠标在画面上一停就弹一条
                // 黄条盖住画面（还正好挡住你要对齐的那块）。选中之后才提示，此时用户确实在找拖拽手感。
                title={l.id === selectedLayerId ? '拖动改位置（按住 Alt 关掉吸附）' : undefined}
                onPointerDown={(e) => onDown(e, l.id)}
                // move/up 挂在 window 上（见 onDown）。这里只兜一手「捕获被系统收走」：
                // 元素被移除/别处抢走捕获时收尾，不至于留下一个永远收不了尾的 transient 序列。
                onLostPointerCapture={() => onUp()}
                style={{
                  position: 'absolute', left: px(r.x), top: px(r.y), width: px(r.w), height: px(r.h),
                  pointerEvents: 'auto', cursor: 'move',
                }}
              />
            )
          })}
        </div>
      </div>

      {/* 视觉层：吸附线 + 选中框 + 四角手柄。除手柄自己外不吃指针 */}
      <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'hidden' }}>
        <div style={camStyle}>
          {guides.map((g, i) => (
            <div
              key={`${g.axis}-${g.pos}-${i}`}
              style={g.axis === 'x'
                ? { position: 'absolute', left: px(g.pos), top: 0, width: 1, height: '100%', background: 'var(--fc-accent)' }
                : { position: 'absolute', top: px(g.pos), left: 0, height: 1, width: '100%', background: 'var(--fc-accent)' }}
            />
          ))}
          {sel && selectedLayerId && (
            <div style={{ position: 'absolute', left: px(sel.x), top: px(sel.y), width: px(sel.w), height: px(sel.h), outline: '1px solid var(--fc-accent)' }}>
              {/*
                四角手柄。带 `data-canvas-hit` 是为了不被容器上那道「点空白＝取消选中」的原生监听误伤
                （它按 closest('[data-canvas-hit]') 放行），否则点手柄的第一下会先把选中态清掉、
                连带把手柄自己从 DOM 里撤走，缩放永远起不来。
              */}
              {([[0, 0, 'nwse-resize'], [1, 0, 'nesw-resize'], [0, 1, 'nesw-resize'], [1, 1, 'nwse-resize']] as const).map(([hx, hy, cur]) => (
                <div
                  key={`${hx}-${hy}`}
                  data-canvas-hit={selectedLayerId}
                  data-canvas-handle=""
                  // 文案跟着层的类型走：说「字号同比联动」而选中的是图片/形状层，就是在描述一件不会发生的事
                  title={selKind === 'image' || selKind === 'shape' ? '拖动改宽（等比改高）' : '拖动改宽（字号同比联动）'}
                  onPointerDown={(e) => { e.stopPropagation(); onDown(e, selectedLayerId, 'resize', hx === 0, hy === 0) }}
                  onLostPointerCapture={() => onUp()}
                  style={{
                    // 手柄画在选中框**内侧**而不是骑在角上：浮层整层 `overflow:hidden` 裁到画布边缘，
                    // 骑在角上的话，铺满画布宽的图层（模板里一大半是这种）右侧那两个手柄有一半被裁掉，
                    // 剩下的几 px 几乎点不中——自测里 flash 的 `.painT` 就是这么拖不动的。
                    position: 'absolute', left: `${hx * 100}%`, top: `${hy * 100}%`, width: HANDLE, height: HANDLE,
                    marginLeft: hx ? -HANDLE : 0, marginTop: hy ? -HANDLE : 0, cursor: cur, pointerEvents: 'auto',
                    background: 'var(--fc-surface)', border: '1px solid var(--fc-accent)',
                  }}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  )
}

/**
 * 沿 offsetParent 链把图层量到合成根。返回**视觉**矩形与该层自身 transform 的位移（见 Measured）。
 * 链断了（root 不在链上，理论上不该发生）返回 null——宁可少画一个命中框，也不要画在错的地方。
 */
function measureLayer(root: HTMLElement, el: HTMLElement): Measured | null {
  let x = 0
  let y = 0
  let cur: HTMLElement | null = el
  while (cur && cur !== root) {
    x += cur.offsetLeft
    y += cur.offsetTop
    cur = cur.offsetParent as HTMLElement | null
  }
  if (cur !== root) return null
  // transform-origin 默认是元素中心，故变换后**中心不动、宽高按比例缩**：由此还原视觉矩形。
  const m = matrixOf(el)
  const lw = el.offsetWidth
  const lh = el.offsetHeight
  const w = lw * m.a
  const h = lh * m.d
  const rect: CanvasRect = { x: x + lw / 2 + m.e - w / 2, y: y + lh / 2 + m.f - h / 2, w, h }
  const cs = getComputedStyle(el)
  const mx = parseFloat(cs.marginLeft) || 0
  const my = parseFloat(cs.marginTop) || 0
  return { rect, tx: rect.x - x, ty: rect.y - y, layoutW: lw, layoutH: lh, mx, my }
}

/**
 * 「给这个元素写一个 top，它的高度会不会跟着变？」——会变就必须连 height 一起固化。
 *
 * 直接探而不是靠 `getComputedStyle` 的 top/bottom 判：**Chrome 对任何已定位元素返回的都是 used value**
 * （实测 `.cap` 明明只写了 `bottom:150px`，computed top 也是 `1615.22px`），单看这两个值区分不出
 * 「作者写的是 bottom」还是「作者写的是 top」。而我们真正关心的只有一件事：写 top 之后高度变不变。
 * 于是把 used top 挪 1px 写进 inline，量一次高，再原样还原——一次同步的读改读，React 看不见，
 * 用户也看不见（没有跨帧的中间态）。静态流内元素直接 false（它压根没有 bottom 约束）。
 */
function heightWouldCollapse(el: HTMLElement | null): boolean {
  if (!el) return false
  const cs = getComputedStyle(el)
  if (cs.position !== 'absolute' && cs.position !== 'fixed') return false
  if (cs.bottom === 'auto') return false
  const top = parseFloat(cs.top)
  if (!Number.isFinite(top)) return false
  const h0 = el.offsetHeight
  const prev = el.style.top
  el.style.top = `${top + 1}px`
  const h1 = el.offsetHeight
  el.style.top = prev
  return h1 !== h0
}

/**
 * 「这个元素的内容自然高是多少？」——即把我们写下的 `height` 拿掉、也不让 `bottom` 参与约束时的高度。
 *
 * 不能直接读 `offsetHeight`：需要显式高度的层（`.cap` 那种 `bottom` 定位的）上，`offsetHeight` 就是我们
 * 刚写进去的那个估算值，量回来只会原样得到它。也不能只清 `height`：top 与 bottom 同时成立时 CSS 会
 * 反过来去算 height，字幕条又会被抻到贴底（见 `Measured` 的说明）。故两者一起临时置 auto。
 *
 * 同 `heightWouldCollapse`：一次同步的读改读，改完原样还原，React 与用户都看不见中间态。
 */
function naturalHeight(el: HTMLElement): number {
  const h0 = el.style.height
  const b0 = el.style.bottom
  el.style.height = 'auto'
  el.style.bottom = 'auto'
  const h = el.offsetHeight
  el.style.height = h0
  el.style.bottom = b0
  return h
}

/**
 * 合成在容器里的位置与缩放（显示 px，相对容器左上角）。
 *
 * **不能拿容器自己的宽算**：Player 按合成宽高比适配容器，横屏 spec（1920×1080）放进 9:16 的容器里是
 * 按宽适配、上下留黑边的——把原点当成容器左上角、比例当成 `容器宽/画布宽`，整层浮层就会纵向错位
 * 半个黑边。故一律以 `.specRoot`（合成根，absolute inset:0，正好是合成的可视矩形）现算：
 * 布局宽 `offsetWidth` 是画布 px，屏幕宽 `rect.width` 是显示 px，两者的比就是缩放。
 *
 * **就绪判据**：Player 的缩放是挂在祖先上的 transform，首帧里可能还没写上，此刻 rect 宽 == 布局宽
 * （比例算出来是 1，命中框会撑成画布那么大铺满整个剪辑台）。合成不可能比容器还宽，故用「装得下容器」
 * 当就绪判据，没就绪返回 null 让调用方下一帧重试。
 */
function stageBox(container: HTMLElement, root: HTMLElement): { x: number; y: number; scale: number } | null {
  const c = container.getBoundingClientRect()
  const r = root.getBoundingClientRect()
  if (r.width === 0 || root.offsetWidth === 0 || c.width === 0) return null
  if (r.width > c.width + 1 || r.height > c.height + 1) return null
  return { x: r.left - c.left, y: r.top - c.top, scale: r.width / root.offsetWidth }
}

/** `#cam` 当前的推镜变换（缩放 + 平移，见 Cam）。找不到/解析不了就当没推镜。 */
function camOf(root: HTMLElement): Cam {
  const cam = root.querySelector<HTMLElement>('#cam')
  if (!cam) return CAM_IDENTITY
  const t = getComputedStyle(cam).transform
  if (!t || t === 'none') return CAM_IDENTITY
  try {
    const m = new DOMMatrixReadOnly(t)
    return { s: m.a, e: m.e, f: m.f }
  } catch {
    return CAM_IDENTITY
  }
}

/** 元素自身 transform 的缩放与平移分量。`.cap` 的 translateX(-50%)、淡入的 scale 都靠它，见 Measured。 */
function matrixOf(el: HTMLElement): { a: number; d: number; e: number; f: number } {
  const t = getComputedStyle(el).transform
  if (!t || t === 'none') return { a: 1, d: 1, e: 0, f: 0 }
  try {
    const m = new DOMMatrixReadOnly(t)
    return { a: m.a, d: m.d, e: m.e, f: m.f }
  } catch {
    return { a: 1, d: 1, e: 0, f: 0 }
  }
}
