import { describe, expect, it } from 'vitest'
import type { Layer } from '@forgecast/studio'
import { addImageLayer, addShapeLayer, removeMediaLayer } from '../src/media-ops'
import { baseSpec, snapshot } from './fixtures'

const layerOf = (spec: ReturnType<typeof baseSpec>, id: string) => spec.layers.find((l) => l.id === id)!

// baseSpec: canvas 1080×1920，layers 用 track 1/2/3，durationSec 12（见 fixtures.ts）。

describe('addImageLayer', () => {
  it('id 从 media-0 起；已有 media-0 时下一条是 media-1（序号推进，不是长度计数）', () => {
    const spec = baseSpec()
    expect(spec.layers.some((l) => l.id.startsWith('media-'))).toBe(false)

    const out1 = addImageLayer(spec, 'a.png')
    expect(out1.layers.at(-1)!.id).toBe('media-0')

    const out2 = addImageLayer(out1, 'b.png')
    expect(out2.layers.at(-1)!.id).toBe('media-1')
  })

  it('序号推进看最大值而非计数：先删中间那条，再加一条也不会撞号', () => {
    const spec = addImageLayer(addImageLayer(baseSpec(), 'a.png'), 'b.png') // media-0, media-1
    const afterRemove = removeMediaLayer(spec, 'media-0')
    const out = addImageLayer(afterRemove, 'c.png')
    expect(out.layers.at(-1)!.id).toBe('media-2')
  })

  it('track = 全 spec 现有 track 最大值 +1（baseSpec 最大 track 是 3）', () => {
    const out = addImageLayer(baseSpec(), 'a.png')
    expect(layerOf(out, 'media-0').track).toBe(4)
  })

  it('from:null，start:0，duration:spec.durationSec，overridden:true', () => {
    const out = addImageLayer(baseSpec(), 'a.png')
    const l = layerOf(out, 'media-0')
    expect(l.from).toBeNull()
    expect(l.start).toBe(0)
    expect(l.duration).toBe(12)
    expect(l.overridden).toBe(true)
    expect(l.kind).toBe('image')
    expect(l.content).toEqual({ kind: 'image', src: 'a.png' })
  })

  it('默认几何：width 640，水平居中（(1080-640)/2=220），不写 height/y（图片自比例）', () => {
    const out = addImageLayer(baseSpec(), 'a.png')
    const l = layerOf(out, 'media-0')
    expect(l.style.width).toBe(640)
    expect(l.style.x).toBe(220)
    expect(l.style.y).toBeUndefined()
    expect(l.style.height).toBeUndefined()
  })

  it('opts 覆盖默认几何字段（其余仍走默认）', () => {
    const out = addImageLayer(baseSpec(), 'a.png', { x: 10, width: 300 })
    const l = layerOf(out, 'media-0')
    expect(l.style.x).toBe(10)
    expect(l.style.width).toBe(300)
    expect(l.style.y).toBeUndefined()
  })

  it('opts 显式给 y/height 时会落到 style 上（缺省才不写）', () => {
    const out = addImageLayer(baseSpec(), 'a.png', { y: 5, height: 50 })
    const l = layerOf(out, 'media-0')
    expect(l.style.y).toBe(5)
    expect(l.style.height).toBe(50)
  })

  it('不可变：入参 spec 原样未变，返回新引用；未触及的图层保持原引用', () => {
    const spec = baseSpec()
    const before = snapshot(spec)
    const originalLayers = spec.layers
    const out = addImageLayer(spec, 'a.png')
    expect(out).not.toBe(spec)
    expect(spec).toEqual(before)
    originalLayers.forEach((l, i) => expect(out.layers[i]).toBe(l))
  })
})

describe('addShapeLayer', () => {
  it.each([
    ['rect', 400, 240],
    ['ellipse', 400, 240],
    ['line', 600, 6],
  ] as const)('%s 默认几何：%d×%d，居中', (shape, width, height) => {
    const out = addShapeLayer(baseSpec(), shape)
    const l = layerOf(out, 'media-0')
    expect(l.content).toEqual({ kind: 'shape', shape })
    expect(l.style.width).toBe(width)
    expect(l.style.height).toBe(height)
    expect(l.style.x).toBe(Math.round((1080 - width) / 2))
    expect(l.style.y).toBe(Math.round((1920 - height) / 2))
  })

  it('id/track/from/start/duration/overridden 与 addImageLayer 同规则', () => {
    const out = addShapeLayer(baseSpec(), 'rect')
    const l = layerOf(out, 'media-0')
    expect(l.from).toBeNull()
    expect(l.start).toBe(0)
    expect(l.duration).toBe(12)
    expect(l.overridden).toBe(true)
    expect(l.track).toBe(4)
    expect(l.kind).toBe('shape')
  })

  it('opts 覆盖默认几何', () => {
    const out = addShapeLayer(baseSpec(), 'line', { width: 100, height: 2, x: 0, y: 0 })
    const l = layerOf(out, 'media-0')
    expect(l.style).toEqual({ x: 0, y: 0, width: 100, height: 2 })
  })

  it('不可变：入参 spec 原样未变，未触及图层保持原引用', () => {
    const spec = baseSpec()
    const before = snapshot(spec)
    const originalLayers = spec.layers
    const out = addShapeLayer(spec, 'ellipse')
    expect(out).not.toBe(spec)
    expect(spec).toEqual(before)
    originalLayers.forEach((l, i) => expect(out.layers[i]).toBe(l))
  })
})

describe('removeMediaLayer', () => {
  it('media- 前缀的层可删（含 addImageLayer/addShapeLayer 产出的层）', () => {
    const spec = addShapeLayer(addImageLayer(baseSpec(), 'a.png'), 'rect') // media-0(image), media-1(rect)
    const out = removeMediaLayer(spec, 'media-1')
    expect(out.layers.some((l) => l.id === 'media-1')).toBe(false)
    expect(out.layers.some((l) => l.id === 'media-0')).toBe(true)
  })

  it('media-logo 这种非纯数字后缀、但仍是 media- 前缀的 id 也可删（前缀判据，不是 media-<n> 正则）', () => {
    const spec = baseSpec()
    const withLogo: typeof spec = {
      ...spec,
      layers: [...spec.layers, {
        id: 'media-logo', kind: 'image', from: null, overridden: true,
        start: 0, duration: 12, track: 4, content: { kind: 'image', src: 'logo.png' }, style: {}, effects: [],
      } as Layer],
    }
    const out = removeMediaLayer(withLogo, 'media-logo')
    expect(out.layers.some((l) => l.id === 'media-logo')).toBe(false)
  })

  it('非 media- 前缀的层一律 throw：模板生成的文案层、手动字幕层都不行', () => {
    const spec = baseSpec() // l-hook 是模板文案层
    expect(() => removeMediaLayer(spec, 'l-hook')).toThrow()
    expect(() => removeMediaLayer(spec, 'cap-manual-1')).toThrow()
  })

  it('不存在的 id throw', () => {
    const spec = addImageLayer(baseSpec(), 'a.png')
    expect(() => removeMediaLayer(spec, 'media-99')).toThrow()
  })

  it('不可变：入参 spec 原样未变，未删的层保持原引用', () => {
    const spec = addShapeLayer(addImageLayer(baseSpec(), 'a.png'), 'rect')
    const before = snapshot(spec)
    const keptRef = spec.layers.find((l) => l.id === 'media-0')!
    const out = removeMediaLayer(spec, 'media-1')
    expect(out).not.toBe(spec)
    expect(spec).toEqual(before)
    expect(out.layers.find((l) => l.id === 'media-0')).toBe(keptRef)
  })
})
