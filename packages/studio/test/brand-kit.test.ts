import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { applyBrandKit, titleBaseFontSize } from '../src/brand-kit'
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

describe('applyBrandKit：titleScale → 标题类层写 round(基准 × scale)', () => {
  // 防漂移：基准表是把模板 CSS 的字号抄进 TS 的副本，改了 CSS 不会自动同步。
  // 这条断言直接读 CSS 文件正则抽竖版 font-size 与表逐项比对——CSS 一改它先红。
  it('基准表与模板 CSS 的竖版 font-size 逐项一致（防 CSS 漂移）', () => {
    const stylesDir = path.resolve(__dirname, '../../compositions/src/styles')
    const expected: Array<[template: string, cls: string, file: string]> = [
      ['flash', 'painT', 'flash.css'],
      ['insight', 'painT', 'insight.css'],
      ['demo', 'hookT', 'demo.css'],
      ['talk', 'hookT', 'talk.css'],
      ['changelog', 'title', 'changelog.css'],
    ]
    for (const [template, cls, file] of expected) {
      const css = fs.readFileSync(path.join(stylesDir, file), 'utf8')
      // 只认竖版规则：`.tpl-<模板> .<类> { ... font-size: Npx`（横版是 `.tpl-x.landscape .cls`）
      const re = new RegExp(`\\.tpl-${template}\\s+\\.${cls}\\s*\\{[^}]*?font-size:\\s*(\\d+)px`)
      const m = re.exec(css)
      expect(m, `${file} 里找不到 .tpl-${template} .${cls} 的 font-size`).not.toBeNull()
      expect(titleBaseFontSize(template, cls), `${template}/.${cls} 基准表与 ${file} 漂移了`).toBe(Number(m![1]))
    }
  })

  it('非标题类不在基准表内（cta/card/chat/flowCap…）', () => {
    for (const cls of ['cta', 'card', 'highlightCard', 'chat', 'sell', 'price', 'tag', 'brand', 'cap', 'painWrap']) {
      expect(titleBaseFontSize('flash', cls)).toBeUndefined()
    }
  })

  const TITLE_LAYER: Record<string, { id: string; base: number } | null> = {
    flash: { id: 'flashHook', base: 100 },     // painT
    insight: { id: 'insight-intro', base: 100 },  // painT
    demo: { id: 'demo-hook', base: 96 },       // hookT
    talk: { id: 'talkHook', base: 100 },       // hookT（talk 例外值）
    changelog: { id: 'clTitle', base: 82 },    // title
    story: null,                               // story 没有标题类层
  }

  for (const t of TEMPLATES) {
    it(`${t}: 标题层拿到 round(基准 × scale)，非标题层不动`, () => {
      const s = spec(t)
      expect(s.layers.every((l) => l.style.fontSize === undefined)).toBe(true)   // lower 自己不写 fontSize
      const out = applyBrandKit(s, { titleScale: 1.25 })
      const target = TITLE_LAYER[t]
      for (let i = 0; i < s.layers.length; i++) {
        const before = s.layers[i], after = out.layers[i]
        if (target && before.id === target.id) {
          expect(after.style.fontSize).toBe(Math.round(target.base * 1.25))
        } else {
          expect(JSON.stringify(after)).toBe(JSON.stringify(before))
        }
      }
      if (!target) expect(JSON.stringify(out.layers)).toBe(JSON.stringify(s.layers))   // story 全不动
    })
  }

  it('取整用 Math.round（96 × 1.33 = 127.68 → 128）', () => {
    const out = applyBrandKit(spec('demo'), { titleScale: 1.33 })
    expect(out.layers.find((l) => l.id === 'demo-hook')!.style.fontSize).toBe(128)
  })

  it('层已有显式 fontSize 时以它为基准（手调值优先于基准表）', () => {
    const s = spec('flash')
    const withSize = { ...s, layers: s.layers.map((l) => (l.id === 'flashHook' ? { ...l, style: { ...l.style, fontSize: 80 } } : l)) }
    const out = applyBrandKit(withSize, { titleScale: 1.25 })
    expect(out.layers.find((l) => l.id === 'flashHook')!.style.fontSize).toBe(100)   // 80×1.25，不是 100×1.25
  })

  it('titleScale 缺省时一个字节都不写', () => {
    const s = spec('flash')
    const out = applyBrandKit(s, { primaryColor: '#ff0066' })
    expect(out.layers.every((l) => l.style.fontSize === undefined)).toBe(true)
  })

  it('overridden 的标题层仍然跳过', () => {
    const s = spec('flash')
    const marked = { ...s, layers: s.layers.map((l) => (l.id === 'flashHook' ? { ...l, overridden: true } : l)) }
    const out = applyBrandKit(marked, { titleScale: 2 })
    expect(out.layers.find((l) => l.id === 'flashHook')!.style.fontSize).toBeUndefined()
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
      // 三类作用对象（CTA / 强调块 / 标题）全部标成手调过
      layers: s.layers.map((l) => (['cta', 'highlightCard', 'painT'].includes(l.style.cssClass ?? '')
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
