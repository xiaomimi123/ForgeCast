/**
 * 子项目④ talk：口播底片的裁剪/音量与手动字幕。纯函数、与 ops.ts 同风格
 *（入参 spec 不可变，未触及的图层保持原引用，秒值统一 round3，无操作返回同一引用）。
 */
import type { Layer, VideoSpec } from '@forgecast/studio'
import { MIN_LAYER_DURATION } from './ops'

const round3 = (n: number) => Math.round(n * 1000) / 1000

/** 手动字幕的最短时长——比 MIN_LAYER_DURATION 长，0.2s 的字幕根本读不完。 */
const MIN_CAPTION_DURATION = 0.5
/** 手动字幕的默认时长。 */
const DEFAULT_CAPTION_DURATION = 2.5

type VideoContent = Extract<Layer['content'], { kind: 'video' }>

function requireVideoLayer(spec: VideoSpec, layerId: string): Layer {
  const layer = spec.layers.find((l) => l.id === layerId)
  if (!layer) throw new Error(`图层「${layerId}」不存在`)
  if (layer.content.kind !== 'video') throw new Error(`图层「${layerId}」不是视频层，不能裁剪/调音量`)
  return layer
}

/**
 * 底片时长变化后把其余图层钳回 [0, durationSec)。三种情况，都不删层——用户还能自己拉回来：
 *   1. start 仍在界内且右缘越界 → 截短 duration
 *   2. start 太靠后（界内不足 MIN_LAYER_DURATION）但整条放得下 → 贴末尾（保时长左移）
 *   3. 整条都放不下（duration > durationSec）→ duration 钳到 0.2 贴末尾
 * 被钳的层置 overridden：它们的时间确实被程序改过了，语义与「被剪辑台改过」一致——
 * 下次重新 lower 时应当保护/提示，而不是悄悄用生成值把用户看到的时间轴覆盖回去。
 */
function clampLayer(layer: Layer, durationSec: number): Layer {
  if (layer.start + layer.duration <= durationSec) return layer
  if (durationSec - layer.start >= MIN_LAYER_DURATION) {
    return { ...layer, duration: round3(durationSec - layer.start), overridden: true }
  }
  if (layer.duration <= durationSec) {
    return { ...layer, start: round3(durationSec - layer.duration), overridden: true }
  }
  return { ...layer, start: round3(durationSec - MIN_LAYER_DURATION), duration: MIN_LAYER_DURATION, overridden: true }
}

/**
 * 裁剪口播底片。δ>0 一律表示「多裁掉」，δ<0 表示「吐回来」：
 *   edge='start'：trimStart += δ、duration −= δ，图层 start 不动（口播底片恒从 0 起）
 *   edge='end'  ：duration −= δ，trimStart 不动
 * trimEnd 始终维护为 (trimStart ?? 0) + 新 duration，保持片源区间与时间轴时长一致，
 * 即便调用方只看 duration。
 * 钳制：trimStart ≥ 0（吐不回没裁过的头）、duration ≥ MIN_LAYER_DURATION。
 * spec.durationSec 联动为视频层新 duration，其余图层按 clampLayer 钳回。
 */
export function trimVideoLayer(spec: VideoSpec, layerId: string, edge: 'start' | 'end', deltaSec: number): VideoSpec {
  const layer = requireVideoLayer(spec, layerId)
  const content = layer.content as VideoContent
  const trimStart = content.trimStart ?? 0

  // δ 的合法上界：裁到 MIN_LAYER_DURATION 为止。裁头时还有下界：最多吐回已裁掉的 trimStart。
  const upper = round3(layer.duration - MIN_LAYER_DURATION)
  const lower = edge === 'start' ? -trimStart : -Infinity
  const delta = round3(Math.min(Math.max(deltaSec, lower), upper))
  if (delta === 0) return spec

  const duration = round3(layer.duration - delta)
  const nextTrimStart = edge === 'start' ? round3(trimStart + delta) : trimStart
  const nextContent: VideoContent = { ...content, trimStart: nextTrimStart, trimEnd: round3(nextTrimStart + duration) }
  const nextVideo: Layer = { ...layer, duration, content: nextContent, overridden: true }

  return {
    ...spec,
    durationSec: duration,
    layers: spec.layers.map((l) => (l.id === layerId ? nextVideo : clampLayer(l, duration))),
  }
}

/** 口播底片音量。clamp 0..1；非视频层 throw；同值返回同一引用。 */
export function setVideoVolume(spec: VideoSpec, layerId: string, volume: number): VideoSpec {
  const layer = requireVideoLayer(spec, layerId)
  const content = layer.content as VideoContent
  const next = round3(Math.min(Math.max(volume, 0), 1))
  if (content.volume === next) return spec
  const nextLayer: Layer = { ...layer, content: { ...content, volume: next }, overridden: true }
  return { ...spec, layers: spec.layers.map((l) => (l.id === layerId ? nextLayer : l)) }
}

/** 'cap-manual-<n>'，n 从 1 起找第一个不与既有 id 冲突的号。 */
function nextCaptionId(spec: VideoSpec): string {
  const used = new Set(spec.layers.map((l) => l.id))
  let n = 1
  while (used.has(`cap-manual-${n}`)) n += 1
  return `cap-manual-${n}`
}

/**
 * 在 tSec 处插一条手动字幕。track 取既有 caption 层的轨（没有则另开 max(track)+1，不去挤别人的轨）；
 * 同轨重叠时把起点向后顺延到第一个放得下的位置（同 moveLayer：绝不为了贴边制造重叠），
 * 顺延到末尾仍放不下就贴末尾缩短，最短 MIN_CAPTION_DURATION。
 */
export function addCaptionLayer(spec: VideoSpec, tSec: number, text: string): VideoSpec {
  const captions = spec.layers.filter((l) => l.kind === 'caption')
  const track = captions.length
    ? captions[0].track
    : (spec.layers.length ? Math.max(...spec.layers.map((l) => l.track)) : -1) + 1

  let start = round3(Math.min(Math.max(tSec, 0), Math.max(0, spec.durationSec - MIN_CAPTION_DURATION)))
  let duration = DEFAULT_CAPTION_DURATION

  const neighbours = spec.layers.filter((l) => l.track === track).sort((a, b) => a.start - b.start)
  for (const n of neighbours) {
    if (n.start + n.duration <= start) continue     // 完全在左边
    if (start + duration <= n.start) break          // 在这位邻居之前塞得下
    start = round3(n.start + n.duration)            // 重叠：顺延到它的右缘
  }

  if (start + duration > spec.durationSec) {
    // 末尾放不下最短时长：不加层，返回同一引用。绝不「贴末尾缩短」——那会与同轨最后一条邻居重叠，
    // 而同 track 不重叠是 spec 硬规则（server 的 validateSpecPut 会直接 400，用户一保存就被拒）。
    // 调用方靠引用相等识别「这次什么也没加」，提示用户换个位置。
    if (spec.durationSec - start < MIN_CAPTION_DURATION) return spec
    duration = round3(spec.durationSec - start)
  }

  const layer: Layer = {
    id: nextCaptionId(spec), kind: 'caption', from: null, overridden: true,
    start, duration, track,
    content: { kind: 'caption', text }, style: { cssClass: 'cap' }, effects: [],
  }
  return { ...spec, layers: [...spec.layers, layer] }
}
