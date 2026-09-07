/**
 * 画布拖拽排版的纯函数内核：吸附对齐 / 出界钳制 / 几何重置。
 * 与 ops.ts / video-ops.ts 同风格——纯函数、入参不可变、未变层返回原引用。
 */
import type { LayerStyle, VideoSpec } from '@forgecast/studio'

const round3 = (n: number) => Math.round(n * 1000) / 1000

/** 吸附的默认命中阈值（px）。 */
const DEFAULT_SNAP_THRESHOLD = 8
/** 出界钳制默认至少留在画布内的可见像素。 */
const DEFAULT_MIN_VISIBLE = 40
/** 吸附候选里的安全边距（画布内缩 60px 的参考线）。 */
const SAFE_MARGIN = 60

export interface CanvasRect { x: number; y: number; w: number; h: number }
export interface SnapGuide { axis: 'x' | 'y'; pos: number }   // axis:'x'=竖线(pos为x坐标), 'y'=横线
export interface SnapResult { x: number; y: number; guides: SnapGuide[] }

interface AxisHit { diff: number; delta: number; pos: number }

/**
 * moving 在该轴上的三条边（起/中/末）逐一与候选线比距离，取全局最小距离且 ≤threshold 的一对
 * ——「取最近」而非「取第一个命中」：候选线之间可能同时有多个在阈值内，必须挑离 moving 真正最近的
 * 那条，否则拖拽时会吸到一条视觉上更远的线，观感是错的（Step 4 变异实验专门守这一条）。
 */
function nearestHit(edges: number[], lines: number[], threshold: number): AxisHit | null {
  let best: AxisHit | null = null
  for (const edge of edges) {
    for (const line of lines) {
      const diff = Math.abs(edge - line)
      if (diff <= threshold && (!best || diff < best.diff)) {
        best = { diff, delta: line - edge, pos: line }
      }
    }
  }
  return best
}

/** 对齐吸附。moving 为拖动中矩形（x/y 是候选新位置），others 为同画布其他图层矩形。
 *  候选线：画布中线(w/2,h/2)、安全边距(60 与 w-60/h-60)、others 的左/中/右(上/中/下)。
 *  moving 的左/中/右边缘各自与候选线比距离，≤ thresholdPx(默认8) 时吸上，取最近命中。
 *  disabled=true 时原样返回（Alt 旁路走这里，保持纯函数可测）。 */
export function snapPosition(
  moving: CanvasRect,
  others: CanvasRect[],
  canvas: { w: number; h: number },
  thresholdPx: number = DEFAULT_SNAP_THRESHOLD,
  disabled: boolean = false,
): SnapResult {
  if (disabled) return { x: moving.x, y: moving.y, guides: [] }

  const xLines = [canvas.w / 2, SAFE_MARGIN, canvas.w - SAFE_MARGIN, ...others.flatMap((o) => [o.x, o.x + o.w / 2, o.x + o.w])]
  const yLines = [canvas.h / 2, SAFE_MARGIN, canvas.h - SAFE_MARGIN, ...others.flatMap((o) => [o.y, o.y + o.h / 2, o.y + o.h])]

  const xEdges = [moving.x, moving.x + moving.w / 2, moving.x + moving.w]
  const yEdges = [moving.y, moving.y + moving.h / 2, moving.y + moving.h]

  const guides: SnapGuide[] = []
  const xHit = nearestHit(xEdges, xLines, thresholdPx)
  const yHit = nearestHit(yEdges, yLines, thresholdPx)

  const x = xHit ? round3(moving.x + xHit.delta) : moving.x
  const y = yHit ? round3(moving.y + yHit.delta) : moving.y
  if (xHit) guides.push({ axis: 'x', pos: xHit.pos })
  if (yHit) guides.push({ axis: 'y', pos: yHit.pos })

  return { x, y, guides }
}

/** 出界钳制：矩形至少 minVisible(默认40)px 留在画布内。 */
export function clampToCanvas(
  rect: CanvasRect,
  canvas: { w: number; h: number },
  minVisible: number = DEFAULT_MIN_VISIBLE,
): { x: number; y: number } {
  const x = Math.min(Math.max(rect.x, minVisible - rect.w), canvas.w - minVisible)
  const y = Math.min(Math.max(rect.y, minVisible - rect.h), canvas.h - minVisible)
  return { x: round3(x), y: round3(y) }
}

/** style 里属于「排版几何」的字段——回文档流时全部删掉。
 *  导出是给 UI 用的：右栏「清除位置覆盖」要按同一套键判断「这层有没有覆盖」，
 *  两边各抄一份数组的话，将来加一个几何字段就会出现「清得掉但按钮是灰的」。 */
export const GEOMETRY_KEYS = ['x', 'y', 'width', 'height', 'fontSize'] as const

/** 单层排版重置：从 style 删除 x/y/width/height/fontSize（回文档流）。全都没有时返回原 spec 引用。 */
export function clearLayerGeometry(spec: VideoSpec, layerId: string): VideoSpec {
  const layer = spec.layers.find((l) => l.id === layerId)
  if (!layer) throw new Error(`图层「${layerId}」不存在`)

  const hasGeometry = GEOMETRY_KEYS.some((k) => layer.style[k] !== undefined)
  if (!hasGeometry) return spec

  const nextStyle = { ...layer.style } as LayerStyle
  for (const k of GEOMETRY_KEYS) delete nextStyle[k]

  return {
    ...spec,
    layers: spec.layers.map((l) => (l.id === layerId ? { ...l, style: nextStyle, overridden: true } : l)),
  }
}
