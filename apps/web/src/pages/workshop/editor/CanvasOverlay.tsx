import type { VideoSpec } from '@forgecast/compositions/src/videospec-types'
import { clampToCanvas, setLayerStyle, snapPosition, type CanvasRect, type SnapGuide } from '@forgecast/editing'
import type { PlayerRef } from '@remotion/player'
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react'
import type { useEditorState } from './useEditorState'

/** 吸附命中阈值（画布 px）。与 `snapPosition` 的默认值一致，写在这里是为了 Alt 旁路那一行读得懂。 */
const SNAP_PX = 8
/** 选中态四角手柄边长（**显示 px**，不随画布缩放变）。本任务只画，缩放逻辑是 Task 4。 */
const HANDLE = 8
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
 * 判据只在**第一次固化**时可信：getComputedStyle 对已定位元素返回的是**used value**，一个被我们
 * 固化过（position:absolute + top）的层，它的 bottom 也会解析成 px 而不再是 'auto'。所以调用方要用
 * 「style.y 还没有」把这条判据关进第一次（见 onDown）。
 */
interface Measured { rect: CanvasRect; tx: number; ty: number; layoutW: number; layoutH: number; needHeight: boolean }

/**
 * 全片推镜（`#cam` 的 `translate(...)scale(1→1.06)`，见 compositions/Background.tsx）的当前值。
 *
 * 量图层用 offset 系（免疫 transform，量出来就是画布 px，正是要写进 style.x 的口径），但**肉眼看到的**
 * 位置还被推镜推过一道：越靠画面边缘、越到片尾偏得越多（片尾 6%，1920 高的底部约 58px）。命中框/选中框
 * 若不跟着推，用户会发现框和卡片错开一截。故：坐标算 / 存都在 offset 系，**只有渲染**时把浮层整体套上
 * 同一个推镜变换；指针位移换算也要除掉它（屏幕上动 1px，画布里只动 1/s px）。
 */
interface Cam { s: number; e: number; f: number }
const CAM_IDENTITY: Cam = { s: 1, e: 0, f: 0 }

interface DragState {
  layerId: string
  /** 按下那一刻的 spec，每帧都从它重算（不做增量累加，中途回拖不漂）——同 TimelinePane。 */
  base: VideoSpec
  startX: number
  startY: number
  rect: CanvasRect
  tx: number
  ty: number
  layoutW: number
  layoutH: number
  needHeight: boolean
  /** 显示 px → 画布 px 的换算比（containerWidth / canvas.width），按下时现取。 */
  scale: number
  /** 同时刻其他可见图层的视觉矩形——吸附参考线的来源，按下时算一次。 */
  others: CanvasRect[]
  /** 是否真的动过。纯点选（按下即抬起）不许固化，否则「点一下卡片高亮」就把 spec 弄脏了。 */
  moved: boolean
}

/**
 * 画布上的选中 / 拖动 / 吸附线浮层（子项目⑤ Task 3）。
 *
 * 测量口径：图层 DOM 的 `id` 就是 `layer.id`（LayerView），沿 `offsetParent` 链把 `offsetLeft/Top`
 * 累加到合成根 `.specRoot`。**用 offset 系而不是 getBoundingClientRect**：Player 用 `transform:scale`
 * 缩放整个合成、`#cam` 还有一层全片推镜 scale(1→1.06)，rect 系会把这两层缩放一起量进来，而 offset 系
 * 天然免疫 transform，量出来的就是画布 px。
 *
 * 测量时机：pointerdown 现取（比例）+ 可见图层集合 / spec / 播放态变化时重测一次（见 measure effect），
 * **不每帧测**——拖拽期间 spec 每帧换新对象，每帧重测是白烧 CPU，且被拖的那层位置已由 drag 状态给出。
 *
 * 撤销口径沿用 TimelinePane：拖拽期间 `applyTransient`，`pointerup` 才 `commit`，一次拖拽 = 一步 undo；
 * 「文档流固化」（把测量出的 x/y/width 写进 style）也压在同一格里，⌘Z 一步回到拖之前。
 */
export default function CanvasOverlay({
  spec, currentSec, playerRef, selectedLayerId, onSelectLayer, ed, containerRef,
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
}) {
  const [measured, setMeasured] = useState<Record<string, Measured>>({})
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
  useEffect(() => {
    const p = playerRef.current
    if (!p) return
    setPlaying(p.isPlaying())
    const on = () => setPlaying(true)
    const off = () => setPlaying(false)
    p.addEventListener('play', on)
    p.addEventListener('pause', off)
    return () => { p.removeEventListener('play', on); p.removeEventListener('pause', off) }
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
    const r = container.getBoundingClientRect()
    if (r.width === 0) return false
    const next: Record<string, Measured> = {}
    for (const l of visible) {
      const el = container.querySelector<HTMLElement>(`#${CSS.escape(l.id)}`)
      if (!el) continue
      const m = measureLayer(root, el)
      if (m) next[l.id] = m
    }
    setScale(r.width / spec.canvas.width)
    setCam(camOf(root))
    setMeasured(next)
    return true
  }
  const measureRef = useRef(doMeasure)
  measureRef.current = doMeasure

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
    // currentSec 也在依赖里（控制器裁决）：推镜随时刻变，且拖不同时刻的图层要按那一刻的布局量。
    // 播放中上面已提前 return，所以这不会变成「每帧测」——播放时一次也不测。
  }, [playing, visibleKey, currentSec, nonce])

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

  function onDown(e: ReactPointerEvent<HTMLDivElement>, layerId: string) {
    e.preventDefault()
    onSelectLayer(layerId)
    const s = ed.spec
    const m = measured[layerId]
    const container = containerRef.current
    if (!s || !m || !container) return
    // 先收掉右栏输入框可能还没收尾的 transient 序列（pointerdown 早于 blur），
    // 否则这次拖拽会和上一次数值编辑挤进同一格 undo。姿势同 TimelinePane.startDrag。
    ed.commit()
    const r = container.getBoundingClientRect()
    if (r.width === 0) return
    dragRef.current = {
      layerId, base: s, startX: e.clientX, startY: e.clientY,
      rect: m.rect, tx: m.tx, ty: m.ty, layoutW: m.layoutW, layoutH: m.layoutH,
      // 只有第一次固化才补 height，理由见 Measured 的注释（computed bottom 对已定位元素是 used value）
      needHeight: m.needHeight && s.layers.find((l) => l.id === layerId)?.style.y === undefined,
      scale: (r.width / s.canvas.width) * cam.s,
      others: visible.filter((l) => l.id !== layerId).map((l) => measured[l.id]?.rect).filter((x): x is CanvasRect => !!x),
      moved: false,
    }
    try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* 捕获失败就退回冒泡，行为不变 */ }
  }

  function onMove(e: ReactPointerEvent<HTMLDivElement>) {
    const d = dragRef.current
    if (!d) return
    const raw: CanvasRect = {
      x: d.rect.x + (e.clientX - d.startX) / d.scale,
      y: d.rect.y + (e.clientY - d.startY) / d.scale,
      w: d.rect.w, h: d.rect.h,
    }
    // 吸附**先于**钳制：先把「用户想放的位置」吸到参考线，再由钳制把出界的拉回来。
    // 反过来会把刚钳到边上的位置又吸走，重新推出画布。（同 TimelinePane 的先吸后钳。）
    const snapped = snapPosition(raw, d.others, canvas, SNAP_PX, e.altKey)
    const clamped = clampToCanvas({ ...raw, x: snapped.x, y: snapped.y }, canvas)
    d.moved = true
    setDrag({ id: d.layerId, rect: { ...raw, x: clamped.x, y: clamped.y } })
    // 被钳制拉走的那个轴上，参考线已经不成立了——还画着就是在骗人
    setGuides(snapped.guides.filter((g) => (g.axis === 'x' ? clamped.x === snapped.x : clamped.y === snapped.y)))
    // 固化与位移写在**同一次** applyTransient 里：width 必须一起写死，否则 position:absolute 之后
    // 宽度从「文档流里的整行」塌成内容宽，文字换行、观感全变。style.x 存的是 left，故要减掉 transform。
    ed.applyTransient(setLayerStyle(d.base, d.layerId, {
      x: round3(clamped.x - d.tx), y: round3(clamped.y - d.ty), width: round3(d.layoutW),
      ...(d.needHeight ? { height: round3(d.layoutH) } : null),
    }))
  }

  function onUp(e: ReactPointerEvent<HTMLDivElement>) {
    const d = dragRef.current
    if (!d) return
    dragRef.current = null
    setDrag(null)
    setGuides([])
    setNonce((n) => n + 1)
    // 一次拖拽收成一步 undo（没动过则 transient 序列压根没开，commit 是空操作）
    if (d.moved) ed.commit()
    try { if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId) } catch { /* 同上 */ }
  }

  if (playing) return null

  const px = (v: number) => v * scale
  /** 浮层整体套上与 `#cam` 相同的推镜（translate 要换算到显示 px；缩放原点同为几何中心）。 */
  const camStyle = { width: px(canvas.w), height: px(canvas.h), transform: `translate(${px(cam.e)}px, ${px(cam.f)}px) scale(${cam.s})`, transformOrigin: '50% 50%' } as const
  const rectOf = (id: string): CanvasRect | null =>
    (drag && drag.id === id ? drag.rect : measured[id]?.rect) ?? null
  const sel = selectedLayerId ? rectOf(selectedLayerId) : null

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
        <div style={{ position: 'absolute', left: 0, top: 0, ...camStyle }}>
          {visible.map((l) => {
            const r = rectOf(l.id)
            if (!r) return null
            return (
              <div
                key={l.id}
                data-canvas-hit={l.id}
                title="拖动改位置（按住 Alt 关掉吸附）"
                onPointerDown={(e) => onDown(e, l.id)}
                onPointerMove={onMove}
                onPointerUp={onUp}
                onPointerCancel={onUp}
                style={{
                  position: 'absolute', left: px(r.x), top: px(r.y), width: px(r.w), height: px(r.h),
                  pointerEvents: 'auto', cursor: 'move',
                }}
              />
            )
          })}
        </div>
      </div>

      {/* 视觉层：吸附线 + 选中框 + 四角手柄。全程不吃指针（手柄的缩放交互是 Task 4） */}
      <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'hidden' }}>
        <div style={{ position: 'absolute', left: 0, top: 0, ...camStyle }}>
          {guides.map((g, i) => (
            <div
              key={`${g.axis}-${g.pos}-${i}`}
              style={g.axis === 'x'
                ? { position: 'absolute', left: px(g.pos), top: 0, width: 1, height: '100%', background: 'var(--fc-accent)' }
                : { position: 'absolute', top: px(g.pos), left: 0, height: 1, width: '100%', background: 'var(--fc-accent)' }}
            />
          ))}
          {sel && (
            <div style={{ position: 'absolute', left: px(sel.x), top: px(sel.y), width: px(sel.w), height: px(sel.h), outline: '1px solid var(--fc-accent)' }}>
              {/* 四角手柄：本任务只显示（缩放是 Task 4），故不吃指针 */}
              {([['0%', '0%', 'nwse-resize'], ['100%', '0%', 'nesw-resize'], ['0%', '100%', 'nesw-resize'], ['100%', '100%', 'nwse-resize']] as const).map(([l, t, cur]) => (
                <div
                  key={`${l}-${t}`}
                  style={{
                    position: 'absolute', left: l, top: t, width: HANDLE, height: HANDLE,
                    marginLeft: -HANDLE / 2, marginTop: -HANDLE / 2, cursor: cur,
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
  return {
    rect, tx: rect.x - x, ty: rect.y - y, layoutW: lw, layoutH: lh,
    needHeight: getComputedStyle(el).bottom !== 'auto',
  }
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
