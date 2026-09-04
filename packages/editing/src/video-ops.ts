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
 * 单层钳回 [0, limit)。三种情况，都不删层——用户还能自己拉回来：
 *   1. start 仍在界内且右缘越界 → 截短 duration
 *   2. start 太靠后（界内不足 MIN_LAYER_DURATION）但整条放得下 → 贴末尾（保时长左移）
 *   3. 整条都放不下（duration > limit）→ duration 钳到 0.2 贴末尾
 * 被钳的层置 overridden：它们的时间确实被程序改过了，语义与「被剪辑台改过」一致——
 * 下次重新 lower 时应当保护/提示，而不是悄悄用生成值把用户看到的时间轴覆盖回去。
 *
 * `limit` 不一定是 durationSec：见 clampLayers——同轨右边的邻居先落位后，左边这条的可用右界
 * 就是那位邻居的新 start。
 */
function clampLayer(layer: Layer, limit: number, floor: number): Layer {
  if (layer.start + layer.duration <= limit) return layer
  if (limit - layer.start >= MIN_LAYER_DURATION) {
    return { ...layer, duration: round3(limit - layer.start), overridden: true }
  }
  const start = round3(Math.max(floor, limit - layer.duration))
  const duration = start + layer.duration <= limit
    ? layer.duration
    : Math.max(MIN_LAYER_DURATION, round3(limit - start))
  return { ...layer, start, duration, overridden: true }
}

/**
 * 底片时长变化后把其余图层整体钳回 [0, durationSec)，**按轨分组、从右往左带游标**。
 *
 * 逐层独立钳是错的：真实 lowerTalk 把 hook/card/cta 三层全放 track 1
 * （比例 `[0,.15D) / [.15D,.85D) / [.85D,D)`）。裁短后 card 只被「截短」、cta 却「保时长左移」，
 * 两者必然叠在一起；同 track 不重叠是 spec 硬规则，server 的 validateSpecPut 会直接 400 ——
 * 剪辑台 ⌘S 与渲成片一起挂。20s 的片裁掉 2.9s 就够触发。
 *
 * 从右往左的理由：末尾那条（cta）的「贴末尾保时长」是设计意图，应当优先满足；让位的该是它
 * 左边那条。游标 `limit` 从 durationSec 起，每落位一层就收缩到该层的新 start，左边的层只能
 * 在 [0, limit) 里安身——于是截短/左移都不可能压到右邻居身上。
 *
 * 左移还带一条地板 `floor = 左边层数 × MIN_LAYER_DURATION`：不给左邻居留下最低限度的位置，
 * 它们就只能挤成重叠。地板与游标一起，保证 durationSec ≥ 同轨层数 × 0.2 时结果必然无重叠。
 * 再短也不会产生重叠：末层的最短时长回落会让它的 end 超出 durationSec（server 不校验这条，
 * Remotion 对超出合成时长的 Sequence 直接裁掉，良性）；不删层的铁律始终维持。
 */
function clampLayers(layers: Layer[], durationSec: number, skipId: string): Layer[] {
  const byTrack = new Map<number, Layer[]>()
  for (const l of layers) {
    if (l.id === skipId) continue
    byTrack.set(l.track, [...(byTrack.get(l.track) ?? []), l])
  }
  const clamped = new Map<string, Layer>()
  for (const track of byTrack.values()) {
    const sorted = [...track].sort((a, b) => a.start - b.start)
    let limit = durationSec
    for (let i = sorted.length - 1; i >= 0; i--) {
      const next = clampLayer(sorted[i], limit, round3(i * MIN_LAYER_DURATION))
      if (next !== sorted[i]) clamped.set(next.id, next)
      limit = next.start
    }
  }
  // 未被钳的层返回原引用（前端 memo 依赖），且保持原数组顺序
  return layers.map((l) => clamped.get(l.id) ?? l)
}

/**
 * 裁剪口播底片。δ>0 一律表示「多裁掉」，δ<0 表示「吐回来」：
 *   edge='start'：trimStart += δ、duration −= δ，图层 start 不动（口播底片恒从 0 起）
 *   edge='end'  ：duration −= δ，trimStart 不动
 * trimEnd 始终维护为 (trimStart ?? 0) + 新 duration，保持片源区间与时间轴时长一致，
 * 即便调用方只看 duration。
 * 钳制：trimStart ≥ 0（吐不回没裁过的头）、duration ≥ MIN_LAYER_DURATION，
 * 吐尾（edge='end' 且 δ<0）不得越过片源物理末尾——见下方 lower 的注释。
 * spec.durationSec 联动为视频层新 duration，其余图层按 clampLayer 钳回。
 */
export function trimVideoLayer(spec: VideoSpec, layerId: string, edge: 'start' | 'end', deltaSec: number): VideoSpec {
  const layer = requireVideoLayer(spec, layerId)
  const content = layer.content as VideoContent
  const trimStart = content.trimStart ?? 0

  // δ 的合法上界：裁到 MIN_LAYER_DURATION 为止。下界（吐回量）两端各有一条物理边界：
  // - 裁头：最多吐回已裁掉的 trimStart（吐不回没裁过的头）；
  // - 裁尾：最多吐到片源末尾——`trimStart + duration` 不得超过 `sourceDurationSec`。
  //   越界的 trimEnd 会让 Remotion 读到片源之外（画面定格／报错），钳制必须落在这个纯函数里：
  //   放到 UI 上钳不彻底（Inspector 的数字输入照样能填一个越界值）。
  //   `sourceDurationSec` 缺省（老 spec、外部导入的 spec）时维持原行为——不知道片源多长，
  //   就不假装知道，宁可不钳也不按猜出来的长度砍掉用户合法的吐回。
  const upper = round3(layer.duration - MIN_LAYER_DURATION)
  const sourceDur = content.sourceDurationSec
  const lower = edge === 'start'
    ? -trimStart
    : (sourceDur === undefined ? -Infinity : -Math.max(0, round3(sourceDur - (trimStart + layer.duration))))
  const delta = round3(Math.min(Math.max(deltaSec, lower), upper))
  if (delta === 0) return spec

  const duration = round3(layer.duration - delta)
  const nextTrimStart = edge === 'start' ? round3(trimStart + delta) : trimStart
  const nextContent: VideoContent = { ...content, trimStart: nextTrimStart, trimEnd: round3(nextTrimStart + duration) }
  const nextVideo: Layer = { ...layer, duration, content: nextContent, overridden: true }

  return {
    ...spec,
    durationSec: duration,
    layers: clampLayers(spec.layers, duration, layerId).map((l) => (l.id === layerId ? nextVideo : l)),
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

/** 手动字幕 id 的前缀（`addCaptionLayer` 生成的形状）。 */
const MANUAL_CAPTION_PREFIX = 'cap-manual-'

/**
 * 删除一条**手动**字幕层（剪辑台「清空文本即删除」的落点）。
 *
 * **只接受 `cap-manual-` 前缀的 id**，其余一律 throw：五模板的 `cap0/1/2…` 是 TTS cues 生成的，
 * 与旁白一一对应，删掉就和语音对不上——那不是用户「清空一行字」该有的后果。
 * 前缀是 `addCaptionLayer` 唯一的产出形状（见 `nextCaptionId`），拿它当「这条是手打的」的判据，
 * 比看 `from === null || overridden` 都稳：后两者在别的编辑路径上也会成立。
 */
export function removeCaptionLayer(spec: VideoSpec, layerId: string): VideoSpec {
  if (!layerId.startsWith(MANUAL_CAPTION_PREFIX)) {
    throw new Error(`图层「${layerId}」不是手动字幕，不能删除`)
  }
  const layer = spec.layers.find((l) => l.id === layerId)
  if (!layer) throw new Error(`图层「${layerId}」不存在`)
  if (layer.kind !== 'caption') throw new Error(`图层「${layerId}」不是字幕层，不能删除`)
  return { ...spec, layers: spec.layers.filter((l) => l.id !== layerId) }
}
