/**
 * 剪辑台的编辑原语。全部纯函数：入参 spec 不可变，改动落在新对象上（未触及的图层保持原引用）。
 * 与渲染无关、与 Node/DOM 无关——Task 6/8/9 的前端 dispatch 直接消费这些签名。
 */
import type { Effect, Layer, LayerStyle, VideoSpec } from '@forgecast/studio'

/** Effect['type'] 的运行时镜像。类型层的联合在运行时消失，用户输入（拖拽面板的按钮 id）必须在这里过一遍。 */
const EFFECT_TYPES: ReadonlyArray<Effect['type']> = ['decode', 'fadeIn', 'slideUp', 'pulse', 'demote', 'exit']

/** 最短图层时长（秒）。低于这个值在时间轴上点不中，也没有观感意义。 */
export const MIN_LAYER_DURATION = 0.2

/** 秒值统一保留 3 位小数——钳制里的加减会产生 4.300000000000001 这种脏值，落进 spec 后 diff 全是噪声。 */
const round3 = (n: number) => Math.round(n * 1000) / 1000

function requireLayer(spec: VideoSpec, layerId: string): Layer {
  const layer = spec.layers.find((l) => l.id === layerId)
  if (!layer) throw new Error(`图层「${layerId}」不存在`)
  return layer
}

/** 只替换目标图层，其余图层保持原引用（前端可靠引用相等做 memo）。 */
function replaceLayer(spec: VideoSpec, layerId: string, next: Layer): VideoSpec {
  return { ...spec, layers: spec.layers.map((l) => (l.id === layerId ? next : l)) }
}

/** 任何一次剪辑台改动都置 overridden——重新 lower 时据此保护用户改过的图层。 */
const edited = (layer: Layer, patch: Partial<Layer>): Layer => ({ ...layer, ...patch, overridden: true })

export function updateLayerText(spec: VideoSpec, layerId: string, text: string): VideoSpec {
  const layer = requireLayer(spec, layerId)
  const kind = layer.content.kind
  // image/video/shape 没有文本可改：原样返回（同一引用），调用方据此判断「这次点击什么也没发生」。
  if (kind !== 'text' && kind !== 'caption') return spec
  return replaceLayer(spec, layerId, edited(layer, { content: { kind, text } }))
}

export function setLayerStyle(spec: VideoSpec, layerId: string, patch: Partial<LayerStyle>): VideoSpec {
  const layer = requireLayer(spec, layerId)
  return replaceLayer(spec, layerId, edited(layer, { style: { ...layer.style, ...patch } }))
}

export function toggleEffect(spec: VideoSpec, layerId: string, type: Effect['type'], on: boolean): VideoSpec {
  if (!EFFECT_TYPES.includes(type)) throw new Error(`未知特效类型「${type}」`)
  const layer = requireLayer(spec, layerId)
  const has = layer.effects.some((e) => e.type === type)
  if (on && has) return spec
  if (!on && !has) return spec
  const effects = on ? [...layer.effects, { type }] : layer.effects.filter((e) => e.type !== type)
  return replaceLayer(spec, layerId, edited(layer, { effects }))
}

/** 同 track 的其它图层，按 start 升序——moveLayer/resizeLayer 的邻居都从这里取。 */
function siblings(spec: VideoSpec, layer: Layer): Layer[] {
  return spec.layers.filter((l) => l.id !== layer.id && l.track === layer.track).sort((a, b) => a.start - b.start)
}

/**
 * 移动图层起点。钳制口径（同 CutPlanEditor 的 nudge）：
 *   合法区间 = [前邻居 end, 后邻居 start - duration] ∩ [0, durationSec - duration]
 * 前后邻居按「当前 start」在同 track 的排序里取；首尾相接（end === next.start）算合法。
 * 交集为空 = 前后邻居之间根本塞不下这一层：此时唯一保证不重叠的位置就是原位，原样返回，
 * 绝不为了"贴边"制造重叠。
 */
export function moveLayer(spec: VideoSpec, layerId: string, newStart: number): VideoSpec {
  const layer = requireLayer(spec, layerId)
  const others = siblings(spec, layer)
  const prev = others.filter((l) => l.start <= layer.start).pop()
  const next = others.find((l) => l.start > layer.start)

  const lower = Math.max(0, prev ? prev.start + prev.duration : 0)
  const upper = Math.min(spec.durationSec - layer.duration, next ? next.start - layer.duration : Infinity)
  if (lower > upper) return spec

  const start = round3(Math.min(Math.max(newStart, lower), upper))
  if (start === layer.start) return spec
  return replaceLayer(spec, layerId, edited(layer, { start }))
}

/** 改时长。钳制：>= MIN_LAYER_DURATION，右缘不越后邻居左缘、不越 durationSec。塞不下 0.2s 时原样返回。 */
export function resizeLayer(spec: VideoSpec, layerId: string, newDuration: number): VideoSpec {
  const layer = requireLayer(spec, layerId)
  const next = siblings(spec, layer).find((l) => l.start > layer.start)
  const rightEdge = Math.min(spec.durationSec, next ? next.start : Infinity)
  const upper = rightEdge - layer.start
  if (upper < MIN_LAYER_DURATION) return spec

  const duration = round3(Math.min(Math.max(newDuration, MIN_LAYER_DURATION), upper))
  if (duration === layer.duration) return spec
  return replaceLayer(spec, layerId, edited(layer, { duration }))
}

/**
 * 拖拽时的拍点吸附。beatGrid 的 strongBeats 只是采样出来的前若干个拍，时间轴后半段没有条目，
 * 所以按 t0 + n·T 外推整条网格，而不是在 strongBeats 数组里找最近值。
 * layerId 目前不参与计算（吸附只看时间轴），保留在签名里是给「按图层禁用吸附」留的位置。
 */
export function snapStart(spec: VideoSpec, layerId: string, rawStart: number, thresholdSec: number): number {
  void layerId
  const grid = spec.audio.beatGrid
  if (!grid || grid.T <= 0) return rawStart
  const n = Math.round((rawStart - grid.t0) / grid.T)
  const beat = round3(grid.t0 + n * grid.T)
  return Math.abs(rawStart - beat) <= thresholdSec ? beat : rawStart
}
