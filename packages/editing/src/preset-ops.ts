/**
 * 预设与品牌 kit 的纯函数内核：角色推导 / 套样式 / 提取版式 / 套用版式。
 * 与 ops.ts / video-ops.ts / canvas-ops.ts 同风格——纯函数、入参不可变、未变层返回原引用。
 */
import type { Effect, Layer, LayerStyle, VideoSpec } from '@forgecast/studio'

export interface StylePresetPayload { style: Partial<LayerStyle>; effects: Effect[] }
export interface LayoutEntry { role: string; style: Partial<LayerStyle>; effects: Effect[] }

/**
 * 角色键：`style.cssClass` 优先（模板真实词表，如 card/cta/cap/hookT——见 studio/lower.ts），
 * 没有 cssClass 时退到 `from`（语义段 id），两者都没有（手工新建、无来源）时退到 `manual-<kind>`。
 * 同一基础键在 layers 里按出现顺序追加 `#n`（从 0 起）——序号取决于兄弟层，必须对整个数组一次算，
 * 不能逐层单独求值。
 */
export function deriveLayerRoles(layers: Layer[]): Map<string, string> {
  const counts = new Map<string, number>()
  const roles = new Map<string, string>()
  for (const layer of layers) {
    const base = layer.style.cssClass ?? layer.from ?? `manual-${layer.kind}`
    const n = counts.get(base) ?? 0
    counts.set(base, n + 1)
    roles.set(layer.id, `${base}#${n}`)
  }
  return roles
}

function requireLayer(spec: VideoSpec, layerId: string): Layer {
  const layer = spec.layers.find((l) => l.id === layerId)
  if (!layer) throw new Error(`图层「${layerId}」不存在`)
  return layer
}

/** preset.style 剔除 cssClass（无条件——类名是角色身份不是样式值，套预设不该把目标层「变身」成
 *  另一个角色）与 x/y（withPosition:false 时）后再合并；effects 整组替换；置 overridden。 */
function mergeStylePreset(layer: Layer, preset: StylePresetPayload, withPosition: boolean): Layer {
  const { cssClass: _cssClass, x, y, ...withoutClassAndPos } = preset.style
  const styleDelta = withPosition ? { ...withoutClassAndPos, x, y } : withoutClassAndPos
  return {
    ...layer,
    style: { ...layer.style, ...styleDelta },
    effects: [...preset.effects],
    overridden: true,
  }
}

/** 对单个图层套用样式预设。style 合并（withPosition:false 时剔除 x/y）、effects 整组替换、overridden:true。
 *  目标层不存在 throw（同 video-ops 报错风格）。 */
export function applyStylePreset(
  spec: VideoSpec,
  layerId: string,
  preset: StylePresetPayload,
  opts: { withPosition: boolean },
): VideoSpec {
  const layer = requireLayer(spec, layerId)
  const next = mergeStylePreset(layer, preset, opts.withPosition)
  return { ...spec, layers: spec.layers.map((l) => (l.id === layerId ? next : l)) }
}

/** 对同 kind 的所有图层批量套用样式预设。零命中（该 kind 不存在）返回原 spec 引用。 */
export function applyStylePresetToKind(
  spec: VideoSpec,
  kind: Layer['kind'],
  preset: StylePresetPayload,
  opts: { withPosition: boolean },
): VideoSpec {
  let hit = false
  const layers = spec.layers.map((l) => {
    if (l.kind !== kind) return l
    hit = true
    return mergeStylePreset(l, preset, opts.withPosition)
  })
  if (!hit) return spec
  return { ...spec, layers }
}

/** 提取当前 spec 的版式模板：每个非 video 层一条 {role, style, effects}，role 取自 deriveLayerRoles。 */
export function extractLayoutTemplate(spec: VideoSpec): LayoutEntry[] {
  const roles = deriveLayerRoles(spec.layers)
  const entries: LayoutEntry[] = []
  for (const layer of spec.layers) {
    if (layer.kind === 'video') continue
    entries.push({ role: roles.get(layer.id)!, style: { ...layer.style }, effects: [...layer.effects] })
  }
  return entries
}

/**
 * 按 deriveLayerRoles 对位套用版式模板：命中层的 style **全量合并**（含 x/y/width/fontSize）、
 * effects 整组替换、overridden 置位；未命中层与多余条目均静默跳过。一个层都没命中返回原 spec 引用。
 */
export function applyLayoutTemplate(spec: VideoSpec, entries: LayoutEntry[]): VideoSpec {
  const roles = deriveLayerRoles(spec.layers)
  const byRole = new Map(entries.map((e) => [e.role, e]))
  let hit = false
  const layers = spec.layers.map((layer) => {
    const role = roles.get(layer.id)!
    const entry = byRole.get(role)
    if (!entry) return layer
    hit = true
    return {
      ...layer,
      style: { ...layer.style, ...entry.style },
      effects: [...entry.effects],
      overridden: true,
    }
  })
  if (!hit) return spec
  return { ...spec, layers }
}
