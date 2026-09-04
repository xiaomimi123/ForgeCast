import { describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'
import { SpecView } from '../src/SpecView'
import { charStateAt } from '../src/decode'
import { secToFrames, FPS } from '../src/time'
import type { Layer, VideoSpec } from '../src/videospec-types'

// video 图层 Task 8 起真渲染 Remotion <Video>，其内部依赖 useVideoConfig()，
// 该 hook 只在 <Composition> 树内可用。这里跟 video-layer.test.tsx 一样 mock
// 'remotion'，只为让「不抛错」这条契约测试脱离渲染上下文也能跑；
// src/attribute 级别的断言（src 编码、muted 透传、zIndex 叠层）见 video-layer.test.tsx。
vi.mock('remotion', () => ({
  Video: (p: Record<string, unknown>) => <video data-testid="rv" src={p.src as string} muted={p.muted as boolean} />,
  Sequence: (p: Record<string, unknown>) => <>{p.children as React.ReactNode}</>,
  useCurrentFrame: () => 0,
  useVideoConfig: () => ({ fps: 30, width: 1080, height: 1920, durationInFrames: 360 }),
}))

function layer(over: Partial<Layer>): Layer {
  return {
    id: 'l1', kind: 'text', from: null, overridden: false, start: 0, duration: 2, track: 1,
    content: { kind: 'text', text: 'hello' }, style: {}, effects: [], ...over,
  } as Layer
}
function spec(layers: Layer[], durationSec = 10): VideoSpec {
  return {
    version: 1, videoId: 'v1', slug: 's', template: 'flash', createdAt: '',
    semantic: { hook: null, sourceAssetId: null, sections: [] },
    canvas: { width: 1080, height: 1920 }, durationSec, layers,
    audio: { narration: null, bgm: null, beatGrid: null, captionsEnabled: false }, warnings: [],
  }
}

describe('SpecView 可见性', () => {
  it('图层只在 [start, start+duration) 内出现', () => {
    const s = spec([layer({ start: 2, duration: 3, content: { kind: 'text', text: '出现了' } })])
    expect(render(<SpecView spec={s} timeSec={1.9} />).container.textContent).not.toContain('出现了')
    expect(render(<SpecView spec={s} timeSec={2} />).container.textContent).toContain('出现了')
    expect(render(<SpecView spec={s} timeSec={4.9} />).container.textContent).toContain('出现了')
    expect(render(<SpecView spec={s} timeSec={5} />).container.textContent).not.toContain('出现了')
  })

  it('track 映射为 zIndex', () => {
    const s = spec([layer({ id: 'lz', track: 7 })])
    const el = render(<SpecView spec={s} timeSec={0} />).container.querySelector('#lz') as HTMLElement
    expect(el.style.zIndex).toBe('7')
  })

  it('图层带 clip 类与 cssClass', () => {
    const s = spec([layer({ id: 'lc', style: { cssClass: 'painT' } })])
    const el = render(<SpecView spec={s} timeSec={0} />).container.querySelector('#lc') as HTMLElement
    expect(el.className).toContain('clip')
    expect(el.className).toContain('painT')
  })

  it('video 图层可渲染，不抛错（Task 8 已开）', () => {
    const s = spec([layer({ id: 'lv', kind: 'video', content: { kind: 'video', src: 'a.mp4', muted: true } })])
    expect(() => render(<SpecView spec={s} timeSec={0} />)).not.toThrow()
  })
})

describe('时长契约', () => {
  it('秒转帧按 30fps', () => {
    expect(FPS).toBe(30)
    expect(secToFrames(12)).toBe(360)
    expect(secToFrames(6.2207)).toBe(187)
  })
})

describe('.tw 全局序号（elemIndex）分配', () => {
  // 第一层两行解码，第二层一行解码。第二层第一行的 elemIndex 必须等于第一层解码行数（2）——
  // 且这个累加必须覆盖 spec.layers 里的每一层，不论它在当前 timeSec 是否可见。
  function decodeLayer(over: Partial<Layer>): Layer {
    return layer({ effects: [{ type: 'decode', params: { line: 0 } }] as Layer['effects'], ...over })
  }

  it('第二层第一行的 elemIndex = 第一层解码行数，且与第一层可见性无关', () => {
    // 第一层：2 行都解码，仅在 [0,1) 可见。
    const layerA = layer({
      id: 'a', start: 0, duration: 1,
      content: { kind: 'text', text: 'X\nY' },
      effects: [
        { type: 'decode', params: { line: 0 } },
        { type: 'decode', params: { line: 1 } },
      ] as Layer['effects'],
    })
    // 第二层：1 行解码，start=5，在 timeSec=5.05 可见；此刻 layerA 已经不可见（[0,1) 之外）。
    const layerB = layer({
      id: 'b', start: 5, duration: 10,
      content: { kind: 'text', text: 'Z' },
      effects: [{ type: 'decode', params: { line: 0 } }] as Layer['effects'],
    })
    const s = spec([layerA, layerB])
    const timeSec = 5.05
    const el = render(<SpecView spec={s} timeSec={timeSec} />).container.querySelector('#b-l0') as HTMLElement
    const ghost = el.querySelector('.gh')
    expect(ghost).not.toBeNull()

    // 期望的 elemIndex 是 2（layerA 两行解码，无论此刻是否可见都要计入）。
    const expected = charStateAt(0, 1, 2, layerB.start, timeSec)
    expect(expected.kind).toBe('ghost')
    expect(ghost!.textContent).toBe((expected as { kind: 'ghost'; glyph: string }).glyph)

    // 反证：若按错误方式（只数可见图层）计算，elemIndex 会是 0，glyph 应该不同。
    const wrong = charStateAt(0, 1, 0, layerB.start, timeSec)
    expect(wrong.kind).toBe('ghost')
    expect((wrong as { kind: 'ghost'; glyph: string }).glyph).not.toBe(ghost!.textContent)
  })

  it('第一层只有 1 行解码时，第二层 elemIndex 相应变为 1', () => {
    const layerA = decodeLayer({ id: 'a', start: 0, duration: 1, content: { kind: 'text', text: 'X' } })
    const layerB = decodeLayer({ id: 'b', start: 5, duration: 10, content: { kind: 'text', text: 'Z' } })
    const s = spec([layerA, layerB])
    const timeSec = 5.05
    const el = render(<SpecView spec={s} timeSec={timeSec} />).container.querySelector('#b-l0') as HTMLElement
    const ghost = el.querySelector('.gh')
    const expected = charStateAt(0, 1, 1, layerB.start, timeSec)
    expect(ghost!.textContent).toBe((expected as { kind: 'ghost'; glyph: string }).glyph)
  })
})

/**
 * 内联 transform 只写给「真被动画的图层」。
 *
 * 回归背景：曾经无条件写 `translateY(0px) scale(1)`，恒等值看着无害，但**内联样式胜过样式表**
 * ——字幕层在五份模板 CSS 里靠 `left:50%` + `transform: translateX(-50%)` 居中，被恒等 transform
 * 顶掉后左边缘落在画布中线、右半截裁出画面，而视频照常渲出、时长正确、零报错。
 */
describe('内联 transform 不覆盖样式表', () => {
  it('无 effects 的图层不带内联 transform', () => {
    const s = spec([layer({ id: 'lt', effects: [] })])
    const el = render(<SpecView spec={s} timeSec={0} />).container.querySelector('#lt') as HTMLElement
    expect(el.style.transform).toBe('')
  })

  it('字幕图层（cssClass:cap、effects 空）渲出后 transform 为空——否则 .cap 的 translateX(-50%) 被顶掉', () => {
    const cap = layer({
      id: 'cap0', kind: 'caption', start: 0, duration: 3,
      content: { kind: 'caption', text: '一行字幕' }, style: { cssClass: 'cap' }, effects: [],
    })
    const el = render(<SpecView spec={spec([cap])} timeSec={1} />).container.querySelector('#cap0') as HTMLElement
    expect(el.className).toContain('cap')
    expect(el.style.transform).toBe('')
  })

  it('有位移/缩放 effect 的图层仍照常写 transform', () => {
    const s = spec([layer({
      id: 'lf', start: 0, duration: 2,
      effects: [{ type: 'slideUp', at: 0, duration: 0.3 }] as Layer['effects'],
    })])
    const el = render(<SpecView spec={s} timeSec={0} />).container.querySelector('#lf') as HTMLElement
    expect(el.style.transform).toContain('translateY')
  })
})
