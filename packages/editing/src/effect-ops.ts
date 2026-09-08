/**
 * 特效库 Task 3：编辑图层特效参数的纯函数内核。与 ops.ts / video-ops.ts / preset-ops.ts 同风格——
 * 纯函数、入参不可变、未变的东西返回原引用。
 *
 * `Effect.params` 是 `Record<string, number | string>`（direction 存字符串、其余数值键存 number，
 * 见 videospec.ts Task 2 注释）——本文件落 params 时保持这个形状，不做额外转换。
 */
import type { Effect, Layer, VideoSpec } from '@forgecast/studio'

/** 与 Task 4 逐字消费的 patch 形状：顶层键(at/duration)写 Effect 顶层，其余写 params 合并。 */
export interface EffectPatch {
  at?: number
  duration?: number
  direction?: 'up' | 'down' | 'left' | 'right'
  distance?: number
  scale?: number
  blur?: number
}

/** patch 里落在 Effect 顶层（而非 params）的键。 */
const TOP_LEVEL_KEYS = ['at', 'duration'] as const
type TopLevelKey = (typeof TOP_LEVEL_KEYS)[number]

function isTopLevelKey(key: string): key is TopLevelKey {
  return (TOP_LEVEL_KEYS as readonly string[]).includes(key)
}

function requireLayerWithEffect(spec: VideoSpec, layerId: string, type: Effect['type']): { layer: Layer; effect: Effect } {
  const layer = spec.layers.find((l) => l.id === layerId)
  if (!layer) throw new Error(`图层「${layerId}」不存在`)
  const effect = layer.effects.find((e) => e.type === type)
  if (!effect) throw new Error(`图层「${layerId}」未开启特效「${type}」`)
  return { layer, effect }
}

/**
 * 编辑指定图层上某个特效的参数。顶层键(at/duration)直接改 Effect 顶层字段；其余键(direction/
 * distance/scale/blur)合并进 params——逐键合并，不提的键保留原值，绝不整组替换 params。
 *
 * 逐键比较值：patch 后每个键都与原值相等时，判定为无操作，返回**原 spec 引用**（不新建 Effect/
 * Layer/spec 对象，toBe 可测）。目标层不存在、或该层没开这个特效类型，一律 throw——不静默创建。
 * 只改目标层，其余层与 spec 其它字段（含时间轴 durationSec）原样不动。
 */
export function setEffectParams(spec: VideoSpec, layerId: string, type: Effect['type'], patch: EffectPatch): VideoSpec {
  const { layer, effect } = requireLayerWithEffect(spec, layerId, type)

  let next: Effect = effect
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    if (isTopLevelKey(key)) {
      if (next[key] === value) continue
      next = { ...next, [key]: value }
    } else {
      if (next.params?.[key] === value) continue
      next = { ...next, params: { ...next.params, [key]: value } }
    }
  }

  if (next === effect) return spec

  const nextLayer: Layer = { ...layer, effects: layer.effects.map((e) => (e === effect ? next : e)), overridden: true }
  return { ...spec, layers: spec.layers.map((l) => (l.id === layerId ? nextLayer : l)) }
}
