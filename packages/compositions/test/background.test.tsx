import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { Background, Camera } from '../src/Background'
import { SpecView } from '../src/SpecView'
import type { VideoSpec } from '../src/videospec-types'

/** 渲一个变体并取回 #techbg（null 表示没渲背景）。 */
const bgAt = (variant: string | undefined, timeSec: number, durationSec = 12): HTMLElement | null =>
  render(<Background variant={variant} timeSec={timeSec} durationSec={durationSec} />)
    .container.querySelector('#techbg')
/** 取某变体在时刻 t 的「会动的那个子元素」的内联 style。 */
const mvStyleAt = (variant: string, timeSec: number): CSSStyleDeclaration =>
  (bgAt(variant, timeSec)!.querySelector('.mv') as HTMLElement).style
/** 相机层在时刻 t 的 transform 字符串。 */
const camAt = (timeSec: number, durationSec = 12): string =>
  (render(<Camera timeSec={timeSec} durationSec={durationSec}><i /></Camera>)
    .container.querySelector('#cam') as HTMLElement).style.transform
const scaleOf = (transform: string): number => Number(/scale\(([-\d.]+)\)/.exec(transform)![1])

const VARIANTS = ['grid', 'aurora', 'matrix', 'synth', 'mesh'] as const

describe('Background', () => {
  it.each(VARIANTS)('变体 %s 渲出 #techbg，且挂对 bg-<variant> 类', (v) => {
    const el = bgAt(v, 1)
    expect(el).not.toBeNull()
    expect(el!.className).toBe(`bg-${v}`)
  })

  it('变体缺省/none 时不渲背景（story 聊天场不加科技背景）', () => {
    expect(bgAt(undefined, 1)).toBeNull()
    expect(bgAt('none', 1)).toBeNull()
  })

  it('未知变体名回落 grid（与 buildTechBg 的 default 分支一致）', () => {
    expect(bgAt('nope', 1)!.className).toBe('bg-grid')
  })

  // 以下三条把「逐个核对 buildTechBg」的结论固化下来——brief 给的骨架把五个变体
  // 当成同一种结构（.mv + .sweep），实际只有 grid 有 .sweep、只有 synth 有 .sun。
  it.each(VARIANTS)('变体 %s 都带暗角层 .vig', (v) => {
    expect(bgAt(v, 1)!.querySelector('.vig')).not.toBeNull()
  })

  it('只有 grid 有 .sweep，只有 synth 有 .sun', () => {
    for (const v of VARIANTS) {
      expect(!!bgAt(v, 1)!.querySelector('.sweep')).toBe(v === 'grid')
      expect(!!bgAt(v, 1)!.querySelector('.sun')).toBe(v === 'synth')
    }
  })

  it('synth 动 background-position 而不动 transform（.mv 的 CSS transform 是 perspective+rotateX，覆盖了地平线就塌）', () => {
    const s = mvStyleAt('synth', 6)
    expect(s.transform).toBe('')
    expect(s.backgroundPosition).not.toBe('')
  })

  it.each(['grid', 'aurora', 'matrix', 'mesh'])('变体 %s 动 transform 而不动 background-position', (v) => {
    const s = mvStyleAt(v, 6)
    expect(s.transform).not.toBe('')
    expect(s.backgroundPosition).toBe('')
  })

  it.each(VARIANTS)('变体 %s 随时间推进（不是静止帧）', (v) => {
    const key = (t: number) => {
      const s = mvStyleAt(v, t)
      return `${s.transform}|${s.backgroundPosition}`
    }
    expect(key(0)).not.toBe(key(6))
    expect(key(6)).not.toBe(key(12))
  })

  it('grid 的 .sweep 也在动，且保留 CSS 里的 skewX(-12deg)（GSAP 的 xPercent 与之复合）', () => {
    const sweep = (t: number) => (bgAt('grid', t)!.querySelector('.sweep') as HTMLElement).style.transform
    expect(sweep(0)).not.toBe(sweep(6))
    expect(sweep(6)).toContain('skewX(-12deg)')
  })
})

describe('Camera', () => {
  it('全片缓慢推移：起点 scale 1，中途已放大', () => {
    expect(camAt(0)).toContain('scale(1)')
    expect(camAt(6)).not.toContain('scale(1)')
  })

  it('末键落在片长之外（×1.15）：t=片长时 scale 只到 1+0.06*sineInOut(1/1.15)，远不到 1.06', () => {
    // 独立算一遍期望值（不复用实现里的常量），这样把 1.15 改成 1.0 这条会立刻红。
    const expected = 1 + 0.06 * (-(Math.cos(Math.PI * (1 / 1.15)) - 1) / 2)
    expect(scaleOf(camAt(12))).toBeCloseTo(expected, 6)
    expect(scaleOf(camAt(12))).toBeLessThan(1.06)
  })

  it('片尾仍在移动（不会被判静止帧）', () => {
    expect(camAt(11.0)).not.toBe(camAt(12.0))
  })

  it('transform 函数顺序与 GSAP 一致：translate 在 scale 之前（否则位移被 scale 乘一遍）', () => {
    const t = camAt(6)
    expect(t.indexOf('translate')).toBeGreaterThanOrEqual(0)
    expect(t.indexOf('translate')).toBeLessThan(t.indexOf('scale'))
  })

  it('position/inset/transform-origin 交给 base.css 的 #cam 规则，不重复写内联', () => {
    const el = render(<Camera timeSec={1} durationSec={12}><i /></Camera>)
      .container.querySelector('#cam') as HTMLElement
    expect(el.style.position).toBe('')
    expect(el.style.inset).toBe('')
    expect(el.style.transformOrigin).toBe('')
  })
})

function spec(over: Partial<VideoSpec> = {}): VideoSpec {
  return {
    version: 1, videoId: 'v1', slug: 's', template: 'flash', createdAt: '',
    semantic: { hook: null, sourceAssetId: null, sections: [] },
    canvas: { width: 1080, height: 1920 }, durationSec: 12, layers: [],
    audio: { narration: null, bgm: null, beatGrid: null, captionsEnabled: false }, warnings: [],
    ...over,
  }
}
const rootOf = (s: VideoSpec, bgVariant?: string): HTMLElement =>
  render(<SpecView spec={s} timeSec={1} bgVariant={bgVariant} />).container
    .querySelector('.specRoot') as HTMLElement

describe('SpecView 的模板作用域与横竖版', () => {
  it.each(['flash', 'story', 'demo', 'insight', 'changelog'])('template=%s 挂 .tpl-<template>', (t) => {
    expect(rootOf(spec({ template: t })).classList.contains(`tpl-${t}`)).toBe(true)
  })

  it('未知/custom 模板回落到 tpl-flash（否则匹配不到任何 CSS，整页静默裸奔）', () => {
    const root = rootOf(spec({ template: 'custom-42' }))
    expect(root.classList.contains('tpl-custom-42')).toBe(false)
    expect(root.classList.contains('tpl-flash')).toBe(true)
  })

  it('竖版不挂 .landscape，横版挂', () => {
    expect(rootOf(spec({ canvas: { width: 1080, height: 1920 } })).classList.contains('landscape')).toBe(false)
    expect(rootOf(spec({ canvas: { width: 1920, height: 1080 } })).classList.contains('landscape')).toBe(true)
  })

  it('#techbg 在 #cam 内部（源模板的 <!--HF_BG--> 就在 <div id="cam"> 里，背景要跟着相机一起推）', () => {
    const root = rootOf(spec(), 'grid')
    const cam = root.querySelector('#cam') as HTMLElement
    expect(cam).not.toBeNull()
    expect(cam.querySelector('#techbg')).not.toBeNull()
    expect(root.querySelector(':scope > #techbg')).toBeNull()
  })
})
