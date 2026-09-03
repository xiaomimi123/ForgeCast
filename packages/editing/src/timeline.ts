/**
 * 时间轴纯函数：分镜整体拖拽（moveShotBy）、行布局（layoutRow），以及拍点卡点工具
 * （allBeats/addManualBeat/removeManualBeat/snapToBeats）。
 * 与渲染无关、与 Node/DOM 无关——从 apps/web TimelinePane.tsx 逐字迁移（P1 终审确认的实现）。
 */
import type { VideoSpec } from '@forgecast/studio'
import { moveLayer } from './ops'
import type { ShotView } from './shots'

/** 秒值统一保留 3 位小数——与 ops.ts 同口径，钳制/比较里的加减会产生脏浮点值。 */
const round3 = (n: number) => Math.round(n * 1000) / 1000

/**
 * 把一个分镜整体平移 delta 秒。
 *
 * 分镜是**一组图层**（文本层 + 背景层 + …），必须整组同步移动，否则一次拖拽就把同段的图层拆散了。
 * `moveLayer` 逐层钳制（不越邻居、不越片长），组内任一层被钳住时，整组都退到那个「被钳后的最小
 * 位移」重算一遍——**宁紧不重叠**：让整组少移一点，也不能出现某层挤进邻居的情况。
 */
export function moveShotBy(base: VideoSpec, shot: ShotView, delta: number): VideoSpec {
  const startOf = (spec: VideoSpec, id: string) => spec.layers.find((l) => l.id === id)?.start
  // **移动顺序按位移方向排**：同 section 若有两层同 track，先移的会被还没动的同伴挡住（moveLayer
  // 是逐层对当时的邻居钳制的），effective 塌成 0，整组一动不动。右移先移最右边那层、左移先移最左边
  // 那层，让路总是先腾出来。今天每段恰好一层不发作，但顺序依赖的死锁不该留着等模板变复杂。
  const order = [...shot.layerIds].sort((a, b) => {
    const sa = startOf(base, a) ?? 0
    const sb = startOf(base, b) ?? 0
    return delta >= 0 ? sb - sa : sa - sb
  })
  const applyAll = (d: number) => {
    let next = base
    for (const id of order) {
      const s0 = startOf(base, id)
      if (s0 === undefined) continue
      next = moveLayer(next, id, s0 + d)
    }
    return next
  }
  const first = applyAll(delta)
  // 实际位移取组内**绝对值最小**的那个：它就是这次拖拽真正能走到的距离
  let effective = delta
  for (const id of order) {
    const s0 = startOf(base, id)
    const s1 = startOf(first, id)
    if (s0 === undefined || s1 === undefined) continue
    if (Math.abs(s1 - s0) < Math.abs(effective)) effective = s1 - s0
  }
  if (effective === delta) return first
  return applyAll(effective)
}

type Cell =
  | { kind: 'gap'; key: string; weight: number }
  | { kind: 'clip'; key: string; weight: number; shot: ShotView }

/**
 * 把分镜排成一行 flex 单元：`flex: 时长×10 1 0`（不用百分比）。
 * 分镜之间和首尾的空隙也占一个同口径的占位，否则「权重 : 时间」不再是 1:1，
 * Clip 的边缘就会和刻度、播放头对不上——那正是时间轴最不能出的错。
 */
export function layoutRow(shots: ShotView[], duration: number): Cell[] {
  const cells: Cell[] = []
  const w = (sec: number) => Math.max(0, sec) * 10
  const sorted = [...shots].sort((a, b) => a.startSec - b.startSec)
  let cursor = 0
  for (let i = 0; i < sorted.length; i++) {
    const shot = sorted[i]
    if (shot.startSec > cursor) cells.push({ kind: 'gap', key: `gap-${shot.sectionId}`, weight: w(shot.startSec - cursor) })
    // **重叠的分镜要把权重裁掉**：分镜之间本不该重叠，但语义段的图层区间是派生出来的，撞上一次
    // 就足以让「权重总和 > 片长×10」——flex 会把整轨等比压缩，于是**每一个** Clip 都跟刻度和
    // 播放头对不上（错位随重叠量放大）。裁成 [max(start,cursor), min(end, 下一段 start)] 这一段，
    // 宁可把重叠的那截画短，也不让整轨失准。
    const next = sorted[i + 1]
    const from = Math.max(shot.startSec, cursor)
    const to = Math.min(shot.endSec, next ? Math.max(next.startSec, from) : Infinity)
    cells.push({ kind: 'clip', key: shot.sectionId, weight: w(to - from), shot })
    cursor = Math.max(cursor, to)
  }
  if (duration > cursor) cells.push({ kind: 'gap', key: 'gap-tail', weight: w(duration - cursor) })
  return cells
}

/**
 * spec.audio.beatGrid 的运行时形状。manualBeats 已是 videospec.ts 里 AudioSpec.beatGrid
 * 的正式可选字段（P2 Task 2），故这里不再需要 Task 1 的 `BeatGrid` 交叉类型过渡。
 */
export type BeatGrid = { t0: number; T: number; bpm: number; strongBeats: number[]; manualBeats?: number[] }

export interface Beat {
  t: number
  kind: 'strong' | 'derived' | 'manual'
}

/** 越界（<0 或 >durationSec）剔除；同 t（±0.01s）去重，优先级 manual > strong > derived。 */
const BEAT_EPS = 0.01

/**
 * 汇总一条时间轴上全部可吸附拍点：strongBeats（strong）+ t0+n·T 网格外推里不在 strongBeats
 * 的位置（derived）+ manualBeats（manual）。T<=0 时（如仅手动点、无网格）跳过外推。
 */
export function allBeats(grid: BeatGrid | null, durationSec: number): Beat[] {
  const raw: Beat[] = []
  if (grid) {
    for (const t of grid.strongBeats) raw.push({ t, kind: 'strong' })
    if (grid.T > 0) {
      // 从 >=0 的最小 n 开始外推，直到超过 durationSec；t0 为负时先把 n 推进到非负区间。
      let n = grid.t0 < 0 ? Math.ceil((0 - grid.t0) / grid.T) : 0
      let t = round3(grid.t0 + n * grid.T)
      while (t <= durationSec) {
        const isStrong = grid.strongBeats.some((s) => round3(Math.abs(s - t)) <= BEAT_EPS)
        if (!isStrong) raw.push({ t, kind: 'derived' })
        n += 1
        t = round3(grid.t0 + n * grid.T)
      }
    }
    for (const t of grid.manualBeats ?? []) raw.push({ t, kind: 'manual' })
  }

  const priority: Record<Beat['kind'], number> = { manual: 3, strong: 2, derived: 1 }
  const result: Beat[] = []
  for (const b of raw) {
    if (b.t < 0 || b.t > durationSec) continue
    const idx = result.findIndex((r) => round3(Math.abs(r.t - b.t)) <= BEAT_EPS)
    if (idx === -1) result.push(b)
    else if (priority[b.kind] > priority[result[idx].kind]) result[idx] = b
  }
  return result.sort((a, b) => a.t - b.t)
}

function withManualBeats(spec: VideoSpec, grid: BeatGrid | null, manualBeats: number[]): VideoSpec {
  const nextGrid: BeatGrid = grid ? { ...grid, manualBeats } : { t0: 0, T: 0, bpm: 0, strongBeats: [], manualBeats }
  return { ...spec, audio: { ...spec.audio, beatGrid: nextGrid } }
}

/**
 * 加一个手动拍点。beatGrid 为 null 时建 `{t0:0,T:0,bpm:0,strongBeats:[],manualBeats:[t]}`——
 * T=0 表示无网格仅手动点，`allBeats` 对 T<=0 跳过外推。不可变；重复 t（±0.01s）幂等。
 */
export function addManualBeat(spec: VideoSpec, tSec: number): VideoSpec {
  const grid = spec.audio.beatGrid
  const existing = grid?.manualBeats ?? []
  if (existing.some((t) => round3(Math.abs(t - tSec)) <= BEAT_EPS)) return spec
  return withManualBeats(spec, grid, [...existing, round3(tSec)])
}

/** 删一个手动拍点（±0.01s 匹配）。没有网格或没匹配到时原样返回。 */
export function removeManualBeat(spec: VideoSpec, tSec: number): VideoSpec {
  const grid = spec.audio.beatGrid
  const existing = grid?.manualBeats ?? []
  const next = existing.filter((t) => round3(Math.abs(t - tSec)) > BEAT_EPS)
  if (next.length === existing.length) return spec
  return withManualBeats(spec, grid, next)
}

/**
 * 拖拽时的拍点吸附：|raw-beat| 最小且 ≤threshold（round3 后比较）则吸到该拍点，否则原值。
 * 与 ops.ts 的 snapStart 同一套浮点比较写法：距离先 round3 再比，避免「恰好等于阈值」被判成阈值外。
 */
export function snapToBeats(beats: number[], raw: number, thresholdSec: number): number {
  let best: number | null = null
  let bestDist = Infinity
  for (const b of beats) {
    const dist = round3(Math.abs(raw - b))
    if (dist < bestDist) {
      bestDist = dist
      best = b
    }
  }
  return best !== null && bestDist <= thresholdSec ? round3(best) : raw
}
