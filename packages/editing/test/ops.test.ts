import { describe, expect, it } from 'vitest'
import type { VideoSpec } from '@forgecast/studio'
import { moveLayer, resizeLayer, setLayerStyle, snapStart, toggleEffect, updateLayerText } from '../src/ops'
import { baseSpec, captionLayer, snapshot, textLayer } from './fixtures'

/** 同 track 三层：a[0,2) b[3,5) c[8,10)，总时长 12。用来钉钳制边界。 */
const trackSpec = (): VideoSpec =>
  baseSpec({
    durationSec: 12,
    layers: [
      textLayer({ id: 'a', start: 0, duration: 2, track: 1 }),
      textLayer({ id: 'b', start: 3, duration: 2, track: 1 }),
      textLayer({ id: 'c', start: 8, duration: 2, track: 1 }),
      textLayer({ id: 'z', start: 0, duration: 12, track: 2 }),
    ],
  })

const layerOf = (spec: VideoSpec, id: string) => spec.layers.find((l) => l.id === id)!

describe('updateLayerText', () => {
  it('text 图层改文案并置 overridden，返回新对象且原 spec 不变', () => {
    const spec = baseSpec()
    const before = snapshot(spec)
    const out = updateLayerText(spec, 'l-hook', '新文案')
    expect(out).not.toBe(spec)
    expect(spec).toEqual(before)
    expect(layerOf(out, 'l-hook').content).toEqual({ kind: 'text', text: '新文案' })
    expect(layerOf(out, 'l-hook').overridden).toBe(true)
    // 其它图层引用/内容不动
    expect(layerOf(out, 'l-other')).toEqual(layerOf(spec, 'l-other'))
  })

  it('caption 图层同样生效', () => {
    const out = updateLayerText(baseSpec(), 'l-caption', '新字幕')
    expect(layerOf(out, 'l-caption').content).toEqual({ kind: 'caption', text: '新字幕' })
  })

  it('非 text/caption 图层不生效，原样返回', () => {
    const spec = baseSpec({ layers: [textLayer({ id: 'img', kind: 'image', content: { kind: 'image', src: 'a.png' } })] })
    const out = updateLayerText(spec, 'img', '新文案')
    expect(out).toBe(spec)
  })

  it('图层不存在 → throw', () => {
    expect(() => updateLayerText(baseSpec(), 'nope', 'x')).toThrow(/nope/)
  })
})

describe('setLayerStyle', () => {
  it('浅合并 patch，未提及的属性保留；原 spec 不变', () => {
    const spec = baseSpec({ layers: [textLayer({ style: { fontSize: 40, color: '#fff' } })] })
    const before = snapshot(spec)
    const out = setLayerStyle(spec, 'l-hook', { color: '#000', align: 'center' })
    expect(spec).toEqual(before)
    expect(layerOf(out, 'l-hook').style).toEqual({ fontSize: 40, color: '#000', align: 'center' })
    expect(layerOf(out, 'l-hook').overridden).toBe(true)
  })

  it('空 patch 也返回新对象（不改内容）', () => {
    const spec = baseSpec()
    const out = setLayerStyle(spec, 'l-hook', {})
    expect(out).not.toBe(spec)
    expect(layerOf(out, 'l-hook').style).toEqual({})
  })
})

describe('toggleEffect', () => {
  it('on 加特效且不重复', () => {
    const spec = baseSpec()
    const once = toggleEffect(spec, 'l-hook', 'fadeIn', true)
    const twice = toggleEffect(once, 'l-hook', 'fadeIn', true)
    expect(layerOf(once, 'l-hook').effects).toEqual([{ type: 'fadeIn' }])
    expect(layerOf(twice, 'l-hook').effects).toEqual([{ type: 'fadeIn' }])
    expect(spec.layers[0].effects).toEqual([])
  })

  it('off 删掉该类型（含重复项）', () => {
    const spec = baseSpec({ layers: [textLayer({ effects: [{ type: 'fadeIn' }, { type: 'pulse' }, { type: 'fadeIn', at: 1 }] })] })
    const out = toggleEffect(spec, 'l-hook', 'fadeIn', false)
    expect(layerOf(out, 'l-hook').effects).toEqual([{ type: 'pulse' }])
  })

  it('off 一个本来就没有的类型 → 原样返回', () => {
    const spec = baseSpec()
    expect(toggleEffect(spec, 'l-hook', 'pulse', false)).toBe(spec)
  })

  it('固定类型集之外 → throw', () => {
    expect(() => toggleEffect(baseSpec(), 'l-hook', 'wobble' as never, true)).toThrow(/wobble/)
  })
})

describe('moveLayer 钳制', () => {
  it('空档内自由移动', () => {
    const out = moveLayer(trackSpec(), 'b', 6)
    expect(layerOf(out, 'b').start).toBe(6)
    expect(layerOf(out, 'b').duration).toBe(2)
  })

  it('撞左邻居 → 贴住左邻居右缘（首尾相接合法）', () => {
    const out = moveLayer(trackSpec(), 'b', 1)
    expect(layerOf(out, 'b').start).toBe(2) // a 的 end
  })

  it('撞右邻居 → 贴住右邻居左缘减自身时长', () => {
    const out = moveLayer(trackSpec(), 'b', 9)
    expect(layerOf(out, 'b').start).toBe(6) // c.start(8) - duration(2)
  })

  it('越 0 → 钳到 0', () => {
    const out = moveLayer(trackSpec(), 'a', -5)
    expect(layerOf(out, 'a').start).toBe(0)
  })

  it('越 durationSec → 钳到 durationSec - duration', () => {
    const out = moveLayer(trackSpec(), 'c', 99)
    expect(layerOf(out, 'c').start).toBe(10)
  })

  it('不同 track 的图层互不钳制', () => {
    // z 在 track 2 独占整条时间轴，track 1 的 b 移动完全不受它影响
    const out = moveLayer(trackSpec(), 'b', 6)
    expect(layerOf(out, 'b').start).toBe(6)
    expect(layerOf(out, 'z').start).toBe(0)
  })

  it('合法区间为空（spec 本身已越界，如时长被调小过）时原样返回，绝不制造重叠', () => {
    // durationSec 被调到 5，但 b[3,6) 已经越界：合法区间 [a.end=3, 5-3=2] 为空
    const spec = baseSpec({
      durationSec: 5,
      layers: [
        textLayer({ id: 'a', start: 0, duration: 3, track: 1 }),
        textLayer({ id: 'b', start: 3, duration: 3, track: 1 }),
      ],
    })
    const out = moveLayer(spec, 'b', 1)
    expect(out).toBe(spec)
    const b = layerOf(out, 'b')
    for (const other of out.layers.filter((l) => l.id !== 'b' && l.track === b.track)) {
      expect(b.start >= other.start + other.duration || b.start + b.duration <= other.start).toBe(true)
    }
  })

  it('不可变：返回新 spec，原 spec 逐字段不变', () => {
    const spec = trackSpec()
    const before = snapshot(spec)
    const out = moveLayer(spec, 'b', 6)
    expect(out).not.toBe(spec)
    expect(spec).toEqual(before)
  })
})

describe('resizeLayer 钳制', () => {
  it('正常路径', () => {
    const out = resizeLayer(trackSpec(), 'b', 4)
    expect(layerOf(out, 'b').duration).toBe(4) // b[3,7)，c 在 8 开始
  })

  it('最短 0.2s', () => {
    const out = resizeLayer(trackSpec(), 'b', 0.01)
    expect(layerOf(out, 'b').duration).toBe(0.2)
  })

  it('不越右邻居左缘', () => {
    const out = resizeLayer(trackSpec(), 'b', 99)
    expect(layerOf(out, 'b').duration).toBe(5) // c.start(8) - b.start(3)
  })

  it('无右邻居时不越 durationSec', () => {
    const out = resizeLayer(trackSpec(), 'c', 99)
    expect(layerOf(out, 'c').duration).toBe(4) // 12 - 8
  })

  it('不可变', () => {
    const spec = trackSpec()
    const before = snapshot(spec)
    const out = resizeLayer(spec, 'b', 4)
    expect(out).not.toBe(spec)
    expect(spec).toEqual(before)
  })
})

describe('snapStart 拍点吸附', () => {
  const beatSpec = (over: Partial<VideoSpec> = {}) =>
    baseSpec({
      audio: { narration: null, bgm: null, beatGrid: { t0: 0.5, T: 0.5, bpm: 120, strongBeats: [0.5, 1.5] }, captionsEnabled: true },
      ...over,
    })

  it('阈值内吸到最近拍点', () => {
    expect(snapStart(beatSpec(), 'l-hook', 2.03, 0.08)).toBe(2)
  })

  it('网格外推：beat 超出 strongBeats 数组仍按 t0+n·T 吸附', () => {
    // strongBeats 只列到 1.5，7.48 应吸到 7.5
    expect(snapStart(beatSpec(), 'l-hook', 7.48, 0.08)).toBe(7.5)
  })

  it('恰好等于阈值 → 吸附（边界是闭区间）', () => {
    expect(snapStart(beatSpec(), 'l-hook', 2.08, 0.08)).toBe(2)
  })

  it('阈值外原值返回', () => {
    expect(snapStart(beatSpec(), 'l-hook', 2.2, 0.08)).toBe(2.2)
  })

  it('无 beatGrid 原值返回', () => {
    expect(snapStart(baseSpec(), 'l-hook', 2.03, 0.08)).toBe(2.03)
  })

  it('向左外推的负拍点钳到 0，绝不吸出负起点', () => {
    // t0=0.5 T=1：raw=-0.6 的最近网格点是 -0.5，钳到 0 后已在阈值外 → 原值返回，而不是返回 -0.5
    const g = baseSpec({
      audio: { narration: null, bgm: null, beatGrid: { t0: 0.5, T: 1, bpm: 60, strongBeats: [0.5] }, captionsEnabled: true },
    })
    expect(snapStart(g, 'l-hook', -0.6, 0.15)).toBe(-0.6)
    // 落在 0 附近时吸到 0（合法起点）
    expect(snapStart(g, 'l-hook', -0.05, 0.08)).toBe(0)
  })

  it('纯函数：不改 spec', () => {
    const spec = beatSpec()
    const before = snapshot(spec)
    snapStart(spec, 'l-hook', 2.03, 0.08)
    expect(spec).toEqual(before)
  })
})
