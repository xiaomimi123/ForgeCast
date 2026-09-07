import { describe, expect, it } from 'vitest'
import { applyBrandKit } from '../src/brand-kit'
import { lower } from '../src/lower'
import type { BrandKit, Layer, VideoSpec } from '../src/videospec'

const base = {
  videoId: 'v1', slug: 's', canvas: { width: 1080, height: 1920 },
  durationSec: 30,
  cues: [{ start: 2, end: 6, text: '三天涨粉 500 人' }, { start: 8, end: 12, text: '成本降了 30%' }],
  audio: { narration: null, bgm: null, beatGrid: null, captionsEnabled: false },
  brandName: '阿米',
}
const sem = () => ({
  hook: 'pain',
  sourceAssetId: null,
  sections: [
    { id: 'pain', role: 'pain', text: '你的痛点' },
    { id: 'pain-1', role: 'pain', items: ['痛一', '痛二'] },
    { id: 'body', role: 'body', text: '卖点', items: ['卖点一', '卖点二'] },
    { id: 'body-1', role: 'body', text: '锚价', dialogue: [{ who: 'them', text: '真的吗' }, { who: 'me', text: '真的' }] },
    { id: 'cta', role: 'cta', text: '点个关注' },
  ],
})
const TEMPLATES = ['flash', 'story', 'demo', 'changelog', 'insight', 'talk']
function spec(template: string): VideoSpec {
  return lower(sem() as any, { ...base, template, videoSrc: 'assets/talk.mp4', sourceDurationSec: 30 } as any)
}
const textOf = (l: Layer) => (l.content as any).text as string

describe('applyBrandKit：空 kit 是恒等（门禁）', () => {
  for (const t of TEMPLATES) {
    it(`${t}: kit 为空对象/全 undefined 时返回原 spec 引用`, () => {
      const s = spec(t)
      expect(applyBrandKit(s, {})).toBe(s)
      expect(applyBrandKit(s, { primaryColor: undefined, accentColor: undefined, titleScale: undefined, ctaText: undefined })).toBe(s)
    })

    it(`${t}: lower 不传 brandKit 时产出与传空 kit 逐字节一致`, () => {
      const a = spec(t)
      const b = lower(sem() as any, { ...base, template: t, videoSrc: 'assets/talk.mp4', sourceDurationSec: 30, brandKit: {} } as any)
      expect(JSON.stringify(b.layers)).toBe(JSON.stringify(a.layers))
    })
  }
})

describe('applyBrandKit：primaryColor → CTA 层 color', () => {
  for (const t of TEMPLATES) {
    it(`${t}: 只动 cssClass 含 'cta' 的层的 color，其余层逐字节不变`, () => {
      const s = spec(t)
      const out = applyBrandKit(s, { primaryColor: '#ff0066' })
      expect(out).not.toBe(s)
      for (let i = 0; i < s.layers.length; i++) {
        const before = s.layers[i], after = out.layers[i]
        if ((before.style.cssClass ?? '').includes('cta')) {
          expect(after.style.color).toBe('#ff0066')
          expect(JSON.stringify({ ...after, style: { ...after.style, color: before.style.color } })).toBe(JSON.stringify(before))
        } else {
          expect(JSON.stringify(after)).toBe(JSON.stringify(before))
        }
      }
    })
  }
  it('flash: 原 spec 不被就地改写', () => {
    const s = spec('flash')
    applyBrandKit(s, { primaryColor: '#ff0066' })
    expect(s.layers.find((l) => l.id === 'flashCta')!.style.color).toBeUndefined()
  })
})

describe('applyBrandKit：accentColor → card/highlightCard 层 bg', () => {
  it('flash: highlightCard 层拿到 bg', () => {
    const out = applyBrandKit(spec('flash'), { accentColor: '#0af' })
    expect(out.layers.find((l) => l.style.cssClass === 'highlightCard')!.style.bg).toBe('#0af')
    expect(out.layers.find((l) => l.style.cssClass === 'cta')!.style.bg).toBeUndefined()
  })
  it('insight: card 层拿到 bg，且既有 color（配色板）不动', () => {
    const s = spec('insight')
    const cards = s.layers.filter((l) => l.style.cssClass === 'card')
    expect(cards.length).toBeGreaterThan(0)
    const out = applyBrandKit(s, { accentColor: '#0af' })
    for (const l of out.layers.filter((x) => x.style.cssClass === 'card')) {
      expect(l.style.bg).toBe('#0af')
      expect(l.style.color).toBeDefined()
    }
  })
  it('talk: card 层拿到 bg', () => {
    const out = applyBrandKit(spec('talk'), { accentColor: '#0af' })
    const cards = out.layers.filter((l) => l.style.cssClass === 'card')
    expect(cards.length).toBeGreaterThan(0)
    expect(cards.every((l) => l.style.bg === '#0af')).toBe(true)
  })
})

describe('applyBrandKit：titleScale → 标题类层的显式 fontSize 乘数', () => {
  for (const t of TEMPLATES) {
    it(`${t}: lower 产出的标题层没有显式 fontSize，故 titleScale 不改任何层`, () => {
      const s = spec(t)
      expect(s.layers.every((l) => l.style.fontSize === undefined)).toBe(true)
      const out = applyBrandKit(s, { titleScale: 1.5 })
      expect(JSON.stringify(out.layers)).toBe(JSON.stringify(s.layers))
    })
  }

  it('手调过 fontSize 的标题层（painT/hookT/title）按乘数放大；非标题层不动', () => {
    const s = spec('flash')
    const withSizes: VideoSpec = {
      ...s,
      layers: s.layers.map((l) => {
        if (l.id === 'flashHook') return { ...l, style: { ...l.style, fontSize: 80 } }        // painT
        if (l.id === 'flashCta') return { ...l, style: { ...l.style, fontSize: 40 } }         // cta，非标题
        return l
      }),
    }
    const out = applyBrandKit(withSizes, { titleScale: 1.25 })
    expect(out.layers.find((l) => l.id === 'flashHook')!.style.fontSize).toBe(100)
    expect(out.layers.find((l) => l.id === 'flashCta')!.style.fontSize).toBe(40)
  })

  it('hookT / title 也在标题表内', () => {
    const d = spec('demo')
    const dOut = applyBrandKit({ ...d, layers: d.layers.map((l) => (l.id === 'demo-hook' ? { ...l, style: { ...l.style, fontSize: 60 } } : l)) }, { titleScale: 2 })
    expect(dOut.layers.find((l) => l.id === 'demo-hook')!.style.fontSize).toBe(120)

    const c = spec('changelog')
    const cOut = applyBrandKit({ ...c, layers: c.layers.map((l) => (l.id === 'clTitle' ? { ...l, style: { ...l.style, fontSize: 60 } } : l)) }, { titleScale: 0.5 })
    expect(cOut.layers.find((l) => l.id === 'clTitle')!.style.fontSize).toBe(30)
  })
})

describe('applyBrandKit：ctaText 只换第一行主文案，品牌名第二行不丢', () => {
  for (const t of ['flash', 'story', 'demo', 'insight', 'talk']) {
    it(`${t}: 第一行换成新文案，@品牌名第二行原样保留`, () => {
      const s = spec(t)
      const before = s.layers.find((l) => (l.style.cssClass ?? '').includes('cta'))!
      expect(textOf(before)).toBe('点个关注\n@阿米')
      const out = applyBrandKit(s, { ctaText: '主页领资料' })
      const after = out.layers.find((l) => l.id === before.id)!
      expect(textOf(after)).toBe('主页领资料\n@阿米')
      expect(JSON.stringify(after.effects)).toBe(JSON.stringify(before.effects))
    })
  }

  it('无 brandName 时 CTA 只有一行，替换后仍是一行', () => {
    const s = lower(sem() as any, { ...base, brandName: undefined, template: 'flash' } as any)
    const out = applyBrandKit(s, { ctaText: '主页领资料' })
    expect(textOf(out.layers.find((l) => l.id === 'flashCta')!)).toBe('主页领资料')
  })

  it("changelog 的 CTA 层 cssClass 是 'brand'（品牌名在第一行），不在 kit 作用域内，逐字节不变", () => {
    const s = spec('changelog')
    const clCta = s.layers.find((l) => l.id === 'clCta')!
    expect(clCta.style.cssClass).toBe('brand')
    expect(textOf(clCta)).toBe('阿米\n点个关注')
    const out = applyBrandKit(s, { ctaText: '主页领资料', primaryColor: '#ff0066' })
    expect(JSON.stringify(out.layers.find((l) => l.id === 'clCta')!)).toBe(JSON.stringify(clCta))
  })
})

describe('applyBrandKit：overridden 层一律跳过', () => {
  it('手调过的 CTA / card / 标题层不被 kit 覆盖', () => {
    const s = spec('flash')
    const marked: VideoSpec = {
      ...s,
      layers: s.layers.map((l) => (l.style.cssClass === 'cta' || l.style.cssClass === 'highlightCard'
        ? { ...l, overridden: true, style: { ...l.style, fontSize: 50 } }
        : l)),
    }
    const kit: BrandKit = { primaryColor: '#ff0066', accentColor: '#0af', titleScale: 2, ctaText: '主页领资料' }
    const out = applyBrandKit(marked, kit)
    expect(JSON.stringify(out.layers)).toBe(JSON.stringify(marked.layers))
  })
})

describe('lower(opts.brandKit)：收尾注入', () => {
  it('传 brandKit 等价于对 lower 产出调用 applyBrandKit', () => {
    const kit: BrandKit = { primaryColor: '#ff0066', accentColor: '#0af', ctaText: '主页领资料' }
    const direct = applyBrandKit(spec('flash'), kit)
    const injected = lower(sem() as any, { ...base, template: 'flash', brandKit: kit } as any)
    expect(JSON.stringify(injected.layers)).toBe(JSON.stringify(direct.layers))
  })
})
