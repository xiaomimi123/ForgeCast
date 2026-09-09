/**
 * 子项目⑥「素材图层入口」：剪辑台直接加图片/形状层、删素材层。纯函数、与 ops.ts/video-ops.ts
 * 同风格（入参 spec 不可变，未触及的图层保持原引用）。
 */
import type { Layer, LayerStyle, VideoSpec } from '@forgecast/studio'

/** 新加素材层的可选几何覆盖；缺省即下方各自的默认居中几何。 */
export interface MediaLayerOpts { x?: number; y?: number; width?: number; height?: number }

/** 素材层 id 前缀——唯一判据（含 'media-logo' 这类非纯数字后缀的 id，同样按此前缀放行删除）。 */
const MEDIA_PREFIX = 'media-'

/** 'media-<n>'，n 取现有 media- 层里最大的数字后缀 +1（没有则从 0 起）。 */
function nextMediaId(spec: VideoSpec): string {
  let max = -1
  for (const l of spec.layers) {
    if (!l.id.startsWith(MEDIA_PREFIX)) continue
    const suffix = l.id.slice(MEDIA_PREFIX.length)
    if (!/^\d+$/.test(suffix)) continue
    const n = Number(suffix)
    if (n > max) max = n
  }
  return `${MEDIA_PREFIX}${max + 1}`
}

/** 新层永远开一条新轨：全 spec 现有 track 的最大值 +1（空 spec 时为 0）。不去挤别人的轨。 */
function nextTrack(spec: VideoSpec): number {
  return (spec.layers.length ? Math.max(...spec.layers.map((l) => l.track)) : -1) + 1
}

const centerX = (spec: VideoSpec, width: number) => Math.round((spec.canvas.width - width) / 2)
const centerY = (spec: VideoSpec, height: number) => Math.round((spec.canvas.height - height) / 2)

/**
 * 加一张图片层。默认几何：宽 640，水平居中；不写 height——图片自身比例决定高度，写死会拉伸变形，
 * 故同样不写 y（没有 height 无法算出居中的 top）。`opts` 里给了对应字段就用 opts 的（B 期字段
 * 面板改的也是这几个 style 字段，与这里落的形状一致）。
 */
export function addImageLayer(spec: VideoSpec, src: string, opts: MediaLayerOpts = {}): VideoSpec {
  const width = opts.width ?? 640
  const style: LayerStyle = { x: opts.x ?? centerX(spec, width), width }
  if (opts.y !== undefined) style.y = opts.y
  if (opts.height !== undefined) style.height = opts.height

  const layer: Layer = {
    id: nextMediaId(spec), kind: 'image', from: null, overridden: true,
    start: 0, duration: spec.durationSec, track: nextTrack(spec),
    content: { kind: 'image', src }, style, effects: [],
  }
  return { ...spec, layers: [...spec.layers, layer] }
}

/** 各形状的默认宽高（居中）。line 是一条 600×6 的细条，不是几何意义上的零高线段——
 *  两端渲染只认 style.width/height，给它非零高度才有东西可画。 */
const SHAPE_DEFAULT_SIZE: Record<'rect' | 'ellipse' | 'line', { width: number; height: number }> = {
  rect: { width: 400, height: 240 },
  ellipse: { width: 400, height: 240 },
  line: { width: 600, height: 6 },
}

/** 加一个形状层（矩形/椭圆/直线）。默认几何按 `SHAPE_DEFAULT_SIZE` 居中；`opts` 覆盖对应字段。 */
export function addShapeLayer(spec: VideoSpec, shape: 'rect' | 'ellipse' | 'line', opts: MediaLayerOpts = {}): VideoSpec {
  const def = SHAPE_DEFAULT_SIZE[shape]
  const width = opts.width ?? def.width
  const height = opts.height ?? def.height
  const style: LayerStyle = {
    x: opts.x ?? centerX(spec, width), y: opts.y ?? centerY(spec, height), width, height,
  }

  const layer: Layer = {
    id: nextMediaId(spec), kind: 'shape', from: null, overridden: true,
    start: 0, duration: spec.durationSec, track: nextTrack(spec),
    content: { kind: 'shape', shape }, style, effects: [],
  }
  return { ...spec, layers: [...spec.layers, layer] }
}

/**
 * 删除一条素材层（`addImageLayer`/`addShapeLayer` 产出的形状）。
 *
 * **只接受 `media-` 前缀的 id**，其余一律 throw——同 `removeCaptionLayer` 的判据风格：
 * 其余图层（模板生成的文案/图片/字幕）都对应 `semantic.sections`，删掉就和原文案对不上，
 * 不是用户删一个素材层该有的后果。前缀覆盖 `media-<n>` 与任何以 `media-` 打头的 id
 * （如未来手动改名成 `media-logo`），不看数字后缀。
 */
export function removeMediaLayer(spec: VideoSpec, layerId: string): VideoSpec {
  if (!layerId.startsWith(MEDIA_PREFIX)) {
    throw new Error(`图层「${layerId}」不是素材层，不能删除`)
  }
  if (!spec.layers.some((l) => l.id === layerId)) {
    throw new Error(`图层「${layerId}」不存在`)
  }
  return { ...spec, layers: spec.layers.filter((l) => l.id !== layerId) }
}
