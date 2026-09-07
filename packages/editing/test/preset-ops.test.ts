import { describe, expect, it } from 'vitest'
import type { Layer, VideoSpec } from '@forgecast/studio'
import {
  applyLayoutTemplate,
  applyStylePreset,
  applyStylePresetToKind,
  deriveLayerRoles,
  extractLayoutTemplate,
  type LayoutEntry,
  type StylePresetPayload,
} from '../src/preset-ops'
import { baseSpec, snapshot, textLayer } from './fixtures'

/** cssClass 词表取自 packages/studio/src/lower.ts 的真实用法：card/cta/cap/hookT 等。 */
const cardLayer = (over: Partial<Layer> = {}): Layer =>
  textLayer({ id: over.id ?? 'card-a', from: 'sec-card', style: { cssClass: 'card' }, ...over })

const ctaLayer = (over: Partial<Layer> = {}): Layer =>
  textLayer({ id: over.id ?? 'cta-a', from: 'sec-cta', style: { cssClass: 'cta' }, ...over })

const capLayer = (over: Partial<Layer> = {}): Layer =>
  textLayer({ id: over.id ?? 'cap-a', kind: 'caption', from: 'sec-hook', style: { cssClass: 'cap' }, content: { kind: 'caption', text: '字幕' }, ...over })

const videoLayer = (over: Partial<Layer> = {}): Layer => ({
  id: over.id ?? 'v', kind: 'video', from: null, overridden: false,
  start: 0, duration: 12, track: 0,
  content: { kind: 'video', src: 'talk.mp4', muted: false },
  style: {}, effects: [],
})

/** 无 cssClass 的手动新建文本层：走 `manual-<kind>` 兜底键。 */
const manualLayer = (over: Partial<Layer> = {}): Layer =>
  textLayer({ id: over.id ?? 'manual-a', from: null, style: {}, ...over })

const fixtureSpec = (over: Partial<VideoSpec> = {}): VideoSpec =>
  baseSpec({
    layers: [
      cardLayer({ id: 'card-0' }),
      cardLayer({ id: 'card-1' }),
      ctaLayer({ id: 'cta-0' }),
      capLayer({ id: 'cap-0' }),
      videoLayer({ id: 'video-0' }),
      manualLayer({ id: 'manual-0' }),
    ],
    ...over,
  })

describe('deriveLayerRoles', () => {
  it('card 两层得 card#0/card#1，视频层也有角色但 extract 跳过', () => {
    const spec = fixtureSpec()
    const roles = deriveLayerRoles(spec.layers)
    expect(roles.get('card-0')).toBe('card#0')
    expect(roles.get('card-1')).toBe('card#1')
    expect(roles.get('cta-0')).toBe('cta#0')
    expect(roles.get('cap-0')).toBe('cap#0')
    expect(roles.get('manual-0')).toBe('manual-text#0')
    // 视频层没有 cssClass、from 为 null → manual-video；有角色，只是 extract 会跳过它
    expect(roles.get('video-0')).toBe('manual-video#0')
  })
})

describe('applyStylePreset', () => {
  const preset: StylePresetPayload = {
    style: { x: 999, y: 999, color: '#fff', fontSize: 40 },
    effects: [{ type: 'fadeIn' }],
  }

  it('withPosition:false 不写入 x/y（预设里有也剔除）', () => {
    const spec = fixtureSpec()
    const next = applyStylePreset(spec, 'card-0', preset, { withPosition: false })
    const layer = next.layers.find((l) => l.id === 'card-0')!
    expect(layer.style.x).toBeUndefined()
    expect(layer.style.y).toBeUndefined()
    expect(layer.style.color).toBe('#fff')
    expect(layer.style.fontSize).toBe(40)
    expect(layer.overridden).toBe(true)
  })

  it('withPosition:true 写入 x/y', () => {
    const spec = fixtureSpec()
    const next = applyStylePreset(spec, 'card-0', preset, { withPosition: true })
    const layer = next.layers.find((l) => l.id === 'card-0')!
    expect(layer.style.x).toBe(999)
    expect(layer.style.y).toBe(999)
  })

  it('effects 整组替换而非合并', () => {
    const spec = fixtureSpec({
      layers: [cardLayer({ id: 'card-0', effects: [{ type: 'pulse' }, { type: 'decode' }] })],
    })
    const next = applyStylePreset(spec, 'card-0', preset, { withPosition: false })
    const layer = next.layers.find((l) => l.id === 'card-0')!
    expect(layer.effects).toEqual([{ type: 'fadeIn' }])
  })

  it('目标层不存在 throw', () => {
    const spec = fixtureSpec()
    expect(() => applyStylePreset(spec, 'nope', preset, { withPosition: false })).toThrow()
  })

  it('preset.style 带 cssClass 时套用后层的 cssClass 保持原值不被覆盖（withPosition:false）', () => {
    const spec = fixtureSpec()
    const presetWithClass: StylePresetPayload = { style: { ...preset.style, cssClass: 'cta' }, effects: preset.effects }
    const next = applyStylePreset(spec, 'card-0', presetWithClass, { withPosition: false })
    const layer = next.layers.find((l) => l.id === 'card-0')!
    expect(layer.style.cssClass).toBe('card')
    expect(layer.style.color).toBe('#fff') // 其余样式仍照常套用
  })

  it('preset.style 带 cssClass 时套用后层的 cssClass 保持原值不被覆盖（withPosition:true）', () => {
    const spec = fixtureSpec()
    const presetWithClass: StylePresetPayload = { style: { ...preset.style, cssClass: 'cta' }, effects: preset.effects }
    const next = applyStylePreset(spec, 'card-0', presetWithClass, { withPosition: true })
    const layer = next.layers.find((l) => l.id === 'card-0')!
    expect(layer.style.cssClass).toBe('card')
    expect(layer.style.x).toBe(999) // x/y 仍照常套用（withPosition:true 只剔 cssClass）
  })

  it('不碰 start/duration/track 与语义层', () => {
    const spec = fixtureSpec()
    const before = snapshot(spec)
    const next = applyStylePreset(spec, 'card-0', preset, { withPosition: false })
    const layer = next.layers.find((l) => l.id === 'card-0')!
    expect(layer.start).toBe(before.layers[0].start)
    expect(layer.duration).toBe(before.layers[0].duration)
    expect(layer.track).toBe(before.layers[0].track)
    expect(next.semantic).toEqual(before.semantic)
    expect(spec).toEqual(before) // 原引用未被就地改写
  })
})

describe('applyStylePresetToKind', () => {
  const preset: StylePresetPayload = { style: { color: '#000' }, effects: [] }

  it('只动同 kind 层，其余层保持原引用', () => {
    const spec = fixtureSpec()
    const next = applyStylePresetToKind(spec, 'text', preset, { withPosition: false })
    const capLayerNext = next.layers.find((l) => l.id === 'cap-0')!
    const videoLayerNext = next.layers.find((l) => l.id === 'video-0')!
    expect(capLayerNext).toBe(spec.layers.find((l) => l.id === 'cap-0'))
    expect(videoLayerNext).toBe(spec.layers.find((l) => l.id === 'video-0'))
    const cardNext = next.layers.find((l) => l.id === 'card-0')!
    expect(cardNext.style.color).toBe('#000')
    expect(cardNext.overridden).toBe(true)
  })

  it('零命中返回原 spec 引用', () => {
    const spec = fixtureSpec()
    const next = applyStylePresetToKind(spec, 'shape', preset, { withPosition: false })
    expect(next).toBe(spec)
  })

  it('preset.style 带 cssClass 时批量套用后各命中层的 cssClass 各保持原值', () => {
    const spec = fixtureSpec()
    const presetWithClass: StylePresetPayload = { style: { color: '#000', cssClass: 'cta' }, effects: [] }
    const next = applyStylePresetToKind(spec, 'text', presetWithClass, { withPosition: false })
    const card0 = next.layers.find((l) => l.id === 'card-0')!
    const card1 = next.layers.find((l) => l.id === 'card-1')!
    const cta0 = next.layers.find((l) => l.id === 'cta-0')!
    expect(card0.style.cssClass).toBe('card')
    expect(card1.style.cssClass).toBe('card')
    expect(cta0.style.cssClass).toBe('cta') // 本来就是 cta，套用后仍是 cta（未被换成别的）
  })
})

describe('extractLayoutTemplate', () => {
  it('跳过 video 层，条目带角色', () => {
    const spec = fixtureSpec()
    const entries = extractLayoutTemplate(spec)
    expect(entries.some((e) => e.role === 'manual-video#0')).toBe(false)
    expect(entries.length).toBe(spec.layers.length - 1)
    const cardEntry = entries.find((e) => e.role === 'card#0')!
    expect(cardEntry).toBeDefined()
    expect(cardEntry.style).toEqual(spec.layers.find((l) => l.id === 'card-0')!.style)
  })
})

describe('applyLayoutTemplate', () => {
  it('按角色对位：卡片数不同时多余层不动、多余条目忽略', () => {
    const spec = fixtureSpec({
      layers: [
        cardLayer({ id: 'card-0' }),
        cardLayer({ id: 'card-1' }),
        cardLayer({ id: 'card-2' }),
      ],
    })
    const entries: LayoutEntry[] = [
      { role: 'card#0', style: { x: 1, y: 2, width: 100, fontSize: 20 }, effects: [{ type: 'fadeIn' }] },
      { role: 'card#1', style: { x: 3, y: 4, width: 200, fontSize: 30 }, effects: [{ type: 'pulse' }] },
      { role: 'cta#0', style: { x: 5, y: 6 }, effects: [] }, // 多余条目：spec 里没有 cta，忽略
    ]
    const next = applyLayoutTemplate(spec, entries)
    const c0 = next.layers.find((l) => l.id === 'card-0')!
    const c1 = next.layers.find((l) => l.id === 'card-1')!
    const c2 = next.layers.find((l) => l.id === 'card-2')!
    expect(c0.style).toEqual({ cssClass: 'card', x: 1, y: 2, width: 100, fontSize: 20 })
    expect(c0.effects).toEqual([{ type: 'fadeIn' }])
    expect(c0.overridden).toBe(true)
    expect(c1.style).toEqual({ cssClass: 'card', x: 3, y: 4, width: 200, fontSize: 30 })
    // card#2 没有对应条目：原样不动（原引用）
    expect(c2).toBe(spec.layers.find((l) => l.id === 'card-2'))
  })

  it('全未命中返回原 spec 引用', () => {
    const spec = fixtureSpec()
    const entries: LayoutEntry[] = [{ role: 'nonexistent#0', style: { x: 1 }, effects: [] }]
    const next = applyLayoutTemplate(spec, entries)
    expect(next).toBe(spec)
  })

  it('套用不碰 start/duration/track 与语义层', () => {
    const spec = fixtureSpec()
    const before = snapshot(spec)
    const entries = extractLayoutTemplate(spec).map((e) => ({ ...e, style: { ...e.style, x: 42 } }))
    const next = applyLayoutTemplate(spec, entries)
    for (const layer of next.layers) {
      const b = before.layers.find((l: Layer) => l.id === layer.id)!
      expect(layer.start).toBe(b.start)
      expect(layer.duration).toBe(b.duration)
      expect(layer.track).toBe(b.track)
    }
    expect(next.semantic).toEqual(before.semantic)
  })
})
