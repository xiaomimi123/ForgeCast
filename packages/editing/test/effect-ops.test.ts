import { describe, expect, it } from 'vitest'
import type { Effect, Layer, VideoSpec } from '@forgecast/studio'
import { setEffectParams } from '../src/effect-ops'
import { baseSpec, snapshot, textLayer } from './fixtures'

const zoomEffect = (over: Partial<Effect> = {}): Effect => ({
  type: 'zoomIn', at: 0, duration: 0.6, params: { scale: 1.2 }, ...over,
})

const slideEffect = (over: Partial<Effect> = {}): Effect => ({
  type: 'slideIn', at: 0.1, duration: 0.5, params: { direction: 'up', distance: 40 }, ...over,
})

const layerOf = (spec: VideoSpec, id: string) => spec.layers.find((l) => l.id === id)!
const effectOf = (spec: VideoSpec, id: string, type: Effect['type']) =>
  layerOf(spec, id).effects.find((e) => e.type === type)!

describe('setEffectParams — 顶层/params 分流', () => {
  it('at/duration 写 Effect 顶层，params 不动', () => {
    const spec = baseSpec({ layers: [textLayer({ id: 'l', effects: [zoomEffect()] })] })
    const out = setEffectParams(spec, 'l', 'zoomIn', { at: 0.3, duration: 1 })
    const e = effectOf(out, 'l', 'zoomIn')
    expect(e.at).toBe(0.3)
    expect(e.duration).toBe(1)
    expect(e.params).toEqual({ scale: 1.2 })
  })

  it('direction/distance/scale/blur 合并进 params，顶层不动', () => {
    const spec = baseSpec({ layers: [textLayer({ id: 'l', effects: [zoomEffect()] })] })
    const out = setEffectParams(spec, 'l', 'zoomIn', { scale: 1.5 })
    const e = effectOf(out, 'l', 'zoomIn')
    expect(e.params).toEqual({ scale: 1.5 })
    expect(e.at).toBe(0)
    expect(e.duration).toBe(0.6)
  })

  it('y 也走 params（fadeIn 的位移通道）', () => {
    const spec = baseSpec({ layers: [textLayer({ id: 'l', effects: [{ type: 'fadeIn' }] })] })
    const out = setEffectParams(spec, 'l', 'fadeIn', { y: 60 })
    expect(effectOf(out, 'l', 'fadeIn').params).toEqual({ y: 60 })
  })

  it('direction 存字符串键值写入 params', () => {
    const spec = baseSpec({ layers: [textLayer({ id: 'l', effects: [slideEffect()] })] })
    const out = setEffectParams(spec, 'l', 'slideIn', { direction: 'left' })
    const e = effectOf(out, 'l', 'slideIn')
    expect(e.params).toEqual({ direction: 'left', distance: 40 })
  })
})

describe('setEffectParams — params 合并保留未提键', () => {
  it('只 patch distance，scale/其余键保持原值', () => {
    const spec = baseSpec({
      layers: [textLayer({ id: 'l', effects: [{ type: 'blurIn', params: { blur: 8, scale: 1.1 } }] })],
    })
    const out = setEffectParams(spec, 'l', 'blurIn', { blur: 20 })
    const e = effectOf(out, 'l', 'blurIn')
    expect(e.params).toEqual({ blur: 20, scale: 1.1 })
  })

  it('顶层与 params 混合 patch：各自只改自己那部分', () => {
    const spec = baseSpec({ layers: [textLayer({ id: 'l', effects: [slideEffect()] })] })
    const out = setEffectParams(spec, 'l', 'slideIn', { at: 0.2, distance: 60 })
    const e = effectOf(out, 'l', 'slideIn')
    expect(e.at).toBe(0.2)
    expect(e.duration).toBe(0.5)
    expect(e.params).toEqual({ direction: 'up', distance: 60 })
  })
})

describe('setEffectParams — 同值原引用', () => {
  it('patch 后逐键相等：返回原 spec 引用', () => {
    const spec = baseSpec({ layers: [textLayer({ id: 'l', effects: [zoomEffect()] })] })
    const out = setEffectParams(spec, 'l', 'zoomIn', { at: 0, duration: 0.6, scale: 1.2 })
    expect(out).toBe(spec)
  })

  it('空 patch：返回原 spec 引用', () => {
    const spec = baseSpec({ layers: [textLayer({ id: 'l', effects: [zoomEffect()] })] })
    const out = setEffectParams(spec, 'l', 'zoomIn', {})
    expect(out).toBe(spec)
  })
})

describe('setEffectParams — 未开效果 / 目标层不存在', () => {
  it('层不存在 throw', () => {
    const spec = baseSpec({ layers: [textLayer({ id: 'l', effects: [] })] })
    expect(() => setEffectParams(spec, 'nope', 'zoomIn', { scale: 1.5 })).toThrow()
  })

  it('层存在但未开该类型特效 throw', () => {
    const spec = baseSpec({ layers: [textLayer({ id: 'l', effects: [slideEffect()] })] })
    expect(() => setEffectParams(spec, 'l', 'zoomIn', { scale: 1.5 })).toThrow()
  })
})

describe('setEffectParams — 不碰其他层与时间轴', () => {
  it('其余图层原引用不变，durationSec 不变，入参 spec 不被 mutate', () => {
    const other = textLayer({ id: 'other', effects: [zoomEffect()] })
    const target = textLayer({ id: 'l', effects: [slideEffect()] })
    const spec = baseSpec({ durationSec: 12, layers: [target, other] })
    const before = snapshot(spec)

    const out = setEffectParams(spec, 'l', 'slideIn', { distance: 80 })

    expect(out).not.toBe(spec)
    expect(layerOf(out, 'other')).toBe(other)
    expect(out.durationSec).toBe(12)
    expect(spec).toEqual(before)
  })
})
