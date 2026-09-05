import { describe, expect, it } from 'vitest'
import { lower } from '../src/lower'

const base = {
  videoId: 'v1', slug: 's', canvas: { width: 1080, height: 1920 },
  durationSec: 30, cues: [{ start: 2, end: 6, text: 'a' }],
  audio: { narration: null, bgm: null, beatGrid: null, captionsEnabled: false },
}
const sem = (sections: any[]) => ({ hook: 'pain', sourceAssetId: null, sections })

const sections = [
  { id: 'pain', role: 'pain', text: '钩子文案' },
  { id: 'body', role: 'body', text: '卖点', items: ['卖点一', '卖点二', '卖点三'] },
  { id: 'cta', role: 'cta', text: '行动号召' },
]

describe('lowerTalk：视频底层', () => {
  it('track 0 只有一个视频层，字段齐全，from=sec-video，durationSec 透传', () => {
    const spec = lower(sem(sections), { ...base, template: 'talk', videoSrc: 'clips/a.mp4' } as any)
    const track0 = spec.layers.filter((l) => l.track === 0)
    expect(track0.length).toBe(1)
    const v = track0[0]
    expect(v.id).toBe('talkVideo')
    expect(v.kind).toBe('video')
    expect(v.from).toBe('sec-video')
    expect(v.overridden).toBe(false)
    expect(v.start).toBe(0)
    expect(v.duration).toBe(base.durationSec)
    // 初始态不裁剪：trimEnd/sourceDurationSec 都是片源末尾（缺 sourceDurationSec 时回落 durationSec）
    expect(v.content).toEqual({ kind: 'video', src: 'clips/a.mp4', muted: false, trimEnd: 30, sourceDurationSec: 30 })
    expect(v.style).toEqual({})
    expect(v.effects).toEqual([])
  })

  it('显式 sourceDurationSec（片源比成片长，如已裁过的重 lower）落进 content，不跟 durationSec 走', () => {
    const spec = lower(sem(sections), { ...base, durationSec: 12, template: 'talk', videoSrc: 'clips/a.mp4', sourceDurationSec: 42 } as any)
    const v = spec.layers.find((l) => l.kind === 'video')!
    expect(v.duration).toBe(12)
    expect((v.content as any).sourceDurationSec).toBe(42)
    expect((v.content as any).trimEnd).toBe(42)
  })

  it('videoSrc 缺失时 throw 明确消息', () => {
    expect(() => lower(sem(sections), { ...base, template: 'talk' } as any)).toThrow(/videoSrc/)
  })
})

describe('lowerTalk：动效层', () => {
  it('无 caption 层', () => {
    const spec = lower(sem(sections), {
      ...base, template: 'talk', videoSrc: 'clips/a.mp4',
      audio: { narration: null, bgm: null, beatGrid: null, captionsEnabled: true },
    } as any)
    expect(spec.layers.some((l) => l.kind === 'caption')).toBe(false)
  })

  it('动效层时间全部落在 [0, durationSec] 内', () => {
    const spec = lower(sem(sections), { ...base, template: 'talk', videoSrc: 'clips/a.mp4' } as any)
    for (const l of spec.layers) {
      expect(l.start).toBeGreaterThanOrEqual(0)
      expect(l.start + l.duration).toBeLessThanOrEqual(base.durationSec + 1e-6)
    }
  })

  it('动效层同 track 上不重叠', () => {
    const spec = lower(sem(sections), { ...base, template: 'talk', videoSrc: 'clips/a.mp4' } as any)
    const byTrack = new Map<number, Array<{ s: number; e: number }>>()
    for (const l of spec.layers) {
      const arr = byTrack.get(l.track) ?? []
      arr.push({ s: l.start, e: l.start + l.duration })
      byTrack.set(l.track, arr)
    }
    for (const arr of byTrack.values()) {
      arr.sort((a, b) => a.s - b.s)
      for (let i = 1; i < arr.length; i++) expect(arr[i].s).toBeGreaterThanOrEqual(arr[i - 1].e - 1e-6)
    }
  })

  it('标题层用 hook 段文案，起点为 0；CTA 层引用 cta 段', () => {
    const spec = lower(sem(sections), { ...base, template: 'talk', videoSrc: 'clips/a.mp4' } as any)
    const hook = spec.layers.find((l) => l.id === 'talkHook')!
    expect(hook.start).toBe(0)
    expect(hook.from).toBe('pain')
    expect((hook.content as any).text).toBe('钩子文案')

    const cta = spec.layers.find((l) => l.id === 'talkCta')!
    expect(cta.from).toBe('cta')
    expect((cta.content as any).text).toContain('行动号召')
  })

  it('卖点卡按 body items 均分中段，均引用 body 段', () => {
    const spec = lower(sem(sections), { ...base, template: 'talk', videoSrc: 'clips/a.mp4' } as any)
    const cards = spec.layers.filter((l) => l.id.startsWith('talkCard'))
    expect(cards.length).toBe(3)
    for (const c of cards) expect(c.from).toBe('body')
  })

  it('品牌名烧进 CTA 文本第二行；缺失退化为仅 cta 一行', () => {
    const withBrand = lower(sem(sections), { ...base, template: 'talk', videoSrc: 'clips/a.mp4', brandName: '牌子' } as any)
    const ctaWith = withBrand.layers.find((l) => l.id === 'talkCta')!
    expect((ctaWith.content as any).text).toBe('行动号召\n@牌子')

    const noBrand = lower(sem(sections), { ...base, template: 'talk', videoSrc: 'clips/a.mp4' } as any)
    const ctaNo = noBrand.layers.find((l) => l.id === 'talkCta')!
    expect((ctaNo.content as any).text).toBe('行动号召')
  })

  it('动效层不属于 track 0（视频独占底层）', () => {
    const spec = lower(sem(sections), { ...base, template: 'talk', videoSrc: 'clips/a.mp4' } as any)
    const nonVideo = spec.layers.filter((l) => l.kind !== 'video')
    expect(nonVideo.every((l) => l.track >= 1)).toBe(true)
  })
})

describe('lowerTalk：MIN_DURATION 边界（durationSec=6）', () => {
  it('固定 6s、卖点 3 张：各层 duration>0 且同轨不重叠', () => {
    const spec = lower(sem(sections), { ...base, durationSec: 6, template: 'talk', videoSrc: 'clips/a.mp4' } as any)
    for (const l of spec.layers) expect(l.duration).toBeGreaterThan(0)

    const byTrack = new Map<number, Array<{ s: number; e: number }>>()
    for (const l of spec.layers) {
      const arr = byTrack.get(l.track) ?? []
      arr.push({ s: l.start, e: l.start + l.duration })
      byTrack.set(l.track, arr)
    }
    for (const arr of byTrack.values()) {
      arr.sort((a, b) => a.s - b.s)
      for (let i = 1; i < arr.length; i++) expect(arr[i].s).toBeGreaterThanOrEqual(arr[i - 1].e - 1e-6)
    }
  })
})
