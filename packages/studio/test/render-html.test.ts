import { describe, expect, it } from 'vitest'
import { renderSpecToHtml } from '../src/render-html'

const spec: any = {
  version: 1, videoId: 'v1', slug: 's', template: 'flash', createdAt: '',
  semantic: { hook: null, sourceAssetId: null, sections: [] },
  canvas: { width: 1080, height: 1920 }, durationSec: 30,
  audio: { narration: null, bgm: null, beatGrid: null, captionsEnabled: false },
  warnings: [],
  layers: [
    { id: 'flash-hook', kind: 'text', from: 'hook', overridden: false, start: 0, duration: 4, track: 1,
      content: { kind: 'text', text: '钩子<script>' }, style: { cssClass: 'painT' }, effects: [{ type: 'decode' }] },
  ],
}

/**
 * Fix round 3 回归测试，Fix round 4 改写断言：`lower.ts` 原来存的图片路径是
 * `assets/${c.shot.rel}` 原样，`rel` 是操作者自己命名的截图文件名，可能带空格/`#`/`?`/`%`/
 * 子目录——equivalence 门禁看不到这个问题（它从不检查 `src` 内容，只看 id/时间/轨道/tw/accent），
 * 所以这条只能靠专门的单测守住。
 *
 * round 3 曾用 `encodeURI` 修（照抄原版 buildDemoSections 同款），断言里写的是 `#` 不转义——
 * 这是 `encodeURI` 的真实行为，但也是原版自带的 bug：`encodeURI` 特意放过一批 URL 结构字符
 * （`# ? / : @ & = + $ , ; ' ( ) ! ~ * .` 等）不转义，而 `#`/`?` 在文件名里出现时，浏览器会把
 * 它们当成 fragment/query 分隔符去解析——`my shot#1.png` 编码成 `my%20shot#1.png` 后，
 * 浏览器实际请求的是 `.../my%20shot`（`#1.png` 变成锚点），文件根本找不到。round 4 改成按
 * `/` 分段、每段单独 `encodeURIComponent`（`#`/`?` 都会被转义成 `%23`/`%3F`），段间的 `/`
 * 保留（`rel` 允许带子目录）。
 */
const imgSrc = 'assets/my shot#1.png'
const encodedSrc = 'assets/my%20shot%231.png'
const queryImgSrc = 'assets/a?b.png'
const encodedQuerySrc = 'assets/a%3Fb.png'
const subdirSrc = 'assets/screens/a b.png'
const encodedSubdirSrc = 'assets/screens/a%20b.png'
function imageSpec(cssClass: string, src: string): any {
  return {
    version: 1, videoId: 'v1', slug: 's', template: 'demo', createdAt: '',
    semantic: { hook: null, sourceAssetId: null, sections: [] },
    canvas: { width: 1080, height: 1920 }, durationSec: 30,
    audio: { narration: null, bgm: null, beatGrid: null, captionsEnabled: false },
    warnings: [],
    layers: [
      { id: 'car0', kind: 'image', from: null, overridden: false, start: 6, duration: 6, track: 2,
        content: { kind: 'image', src }, style: { cssClass }, effects: [] },
    ],
  }
}

describe('renderSpecToHtml：图片路径的 URL 编码（Fix round 3/4）', () => {
  it('phoneWrap 的 <img src> 把空格和 # 都编码成 %XX，不是 encodeURI 那种放过 # 的编码', () => {
    const { html } = renderSpecToHtml(imageSpec('phoneWrap', imgSrc))
    expect(html).toContain(`src="${encodedSrc}"`)
    expect(html).not.toContain(imgSrc) // 未编码的原始路径不该原样出现在 HTML 里
  })
  it('wideWrap 的 background-image:url(...) 和 <img src> 都要编码，# 同样不能放过', () => {
    const { html } = renderSpecToHtml(imageSpec('wideWrap', imgSrc))
    expect(html).toContain(`url('${encodedSrc}')`)
    expect(html).toContain(`src="${encodedSrc}"`)
    expect(html).not.toContain(imgSrc)
  })
  it('? 也要编码成 %3F，不能被浏览器当成 query 分隔符吃掉文件名后半段', () => {
    const { html } = renderSpecToHtml(imageSpec('phoneWrap', queryImgSrc))
    expect(html).toContain(`src="${encodedQuerySrc}"`)
    expect(html).not.toContain(queryImgSrc)
  })
  it('子目录的 / 必须保留，只编码每一段里的特殊字符', () => {
    const { html } = renderSpecToHtml(imageSpec('phoneWrap', subdirSrc))
    expect(html).toContain(`src="${encodedSubdirSrc}"`)
    expect(html).not.toContain('%2F') // / 不应该被编码
  })
})

describe('renderSpecToHtml', () => {
  it('图层的 id/时间/轨道原样落到 clip 属性上', () => {
    const { html } = renderSpecToHtml(spec)
    expect(html).toContain('id="flash-hook"')
    expect(html).toContain('data-start="0"')
    expect(html).toContain('data-duration="4"')
    expect(html).toContain('data-track-index="1"')
  })
  it('文本经 HTML 转义，防注入', () => {
    const { html } = renderSpecToHtml(spec)
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })
  it('decode 特效落成 .tw 类（供 DECODE_RUNTIME 消费）', () => {
    const { html } = renderSpecToHtml(spec)
    expect(html).toMatch(/class="[^"]*\btw\b/)
  })
  it('音轨不在 layers 里，故 html 不含 audio 标签（由 injectAudioCaptions 负责）', () => {
    const { html } = renderSpecToHtml(spec)
    expect(html).not.toContain('<audio')
  })
  it('空 style（无任何字段）不输出 style 属性', () => {
    const { html } = renderSpecToHtml(spec)
    expect(html).not.toMatch(/id="flash-hook"[^>]*\sstyle="/)
  })
})

/**
 * 特效库 Task 1：LayerStyle 新字段 → styleAttr() 内联样式映射（HF 端，与 compositions 端
 * geom() 完全一致；值经 escapeHtml）。规则见
 * .superpowers/sdd/2026-09-08-effects-library/task-1-brief.md。
 */
function styleSpec(style: any): any {
  return {
    version: 1, videoId: 'v1', slug: 's', template: 'flash', createdAt: '',
    semantic: { hook: null, sourceAssetId: null, sections: [] },
    canvas: { width: 1080, height: 1920 }, durationSec: 30,
    audio: { narration: null, bgm: null, beatGrid: null, captionsEnabled: false },
    warnings: [],
    layers: [
      { id: 'l1', kind: 'text', from: null, overridden: false, start: 0, duration: 4, track: 1,
        content: { kind: 'text', text: 'x' }, style, effects: [] },
    ],
  }
}

describe('styleAttr：LayerStyle 新字段映射（特效库 Task 1）', () => {
  it('borderWidth/borderColor → border', () => {
    const { html } = renderSpecToHtml(styleSpec({ borderWidth: 3, borderColor: '#f00' }))
    expect(html).toContain('border:3px solid #f00')
  })

  it('borderWidth 缺省 borderColor 时回落 #fff', () => {
    const { html } = renderSpecToHtml(styleSpec({ borderWidth: 2 }))
    expect(html).toContain('border:2px solid #fff')
  })

  it('borderWidth<=0 不写 border', () => {
    const { html } = renderSpecToHtml(styleSpec({ borderWidth: 0, borderColor: '#f00' }))
    expect(html).not.toContain('border:')
  })

  it('radius → border-radius', () => {
    const { html } = renderSpecToHtml(styleSpec({ radius: 12 }))
    expect(html).toContain('border-radius:12px')
  })

  it('shadow → box-shadow', () => {
    const { html } = renderSpecToHtml(styleSpec({ shadow: { blur: 8, x: 2, y: 4, color: '#000' } }))
    expect(html).toContain('box-shadow:2px 4px 8px #000')
  })

  it('backdropBlur>0 → backdrop-filter', () => {
    const { html } = renderSpecToHtml(styleSpec({ backdropBlur: 6 }))
    expect(html).toContain('backdrop-filter:blur(6px)')
  })

  it('backdropBlur<=0 不写 backdrop-filter', () => {
    const { html } = renderSpecToHtml(styleSpec({ backdropBlur: 0 }))
    expect(html).not.toContain('backdrop-filter:')
  })

  it('textStrokeWidth>0 → -webkit-text-stroke（缺省色回落 #000）', () => {
    const { html } = renderSpecToHtml(styleSpec({ textStrokeWidth: 1 }))
    expect(html).toContain('-webkit-text-stroke:1px #000')
  })

  it('glow → text-shadow 与 --fx-glow 同时产出（后者供 FX_CSS 的 .twc .fin 取用）', () => {
    const { html } = renderSpecToHtml(styleSpec({ glow: { blur: 10, color: '#0ff' } }))
    expect(html).toContain('text-shadow:0 0 10px #0ff')
    expect(html).toContain('--fx-glow:0 0 10px #0ff')
  })

  it('不设 glow 时既不产 text-shadow 也不产 --fx-glow', () => {
    const { html } = renderSpecToHtml(styleSpec({ color: '#fff' }))
    expect(html).not.toContain('text-shadow')
    expect(html).not.toContain('--fx-glow')
  })

  it('bgGradient 有值时覆盖 bg（写在 bg 之后）', () => {
    const { html } = renderSpecToHtml(styleSpec({ bg: '#123456', bgGradient: { from: '#111', to: '#222', angle: 45 } }))
    expect(html).toContain('background:#123456;background:linear-gradient(45deg, #111, #222)')
  })

  it('色值/字符串字段经 escapeHtml', () => {
    const { html } = renderSpecToHtml(styleSpec({ borderWidth: 1, borderColor: '"><script>' }))
    expect(html).not.toContain('"><script>')
    expect(html).toContain('&quot;&gt;&lt;script&gt;')
  })
})

/**
 * 素材图层入口 Task 1：line 形状渲染（`shape` case 未新增任何分支，`shape-${layer.content.shape}`
 * 本就是通用拼接——`shape:'line'` 落地即渲成 `shape shape-line`，样式全由 style.bg/width/height
 * 驱动，无新 CSS）。既有 shape fixture（rect/ellipse）零变化——见下方独立 it。
 */
describe('renderSpecToHtml：line 形状（素材图层入口 Task 1）', () => {
  const shapeSpec = (shape: 'rect' | 'ellipse' | 'line', style: any): any => ({
    version: 1, videoId: 'v1', slug: 's', template: 'flash', createdAt: '',
    semantic: { hook: null, sourceAssetId: null, sections: [] },
    canvas: { width: 1080, height: 1920 }, durationSec: 30,
    audio: { narration: null, bgm: null, beatGrid: null, captionsEnabled: false },
    warnings: [],
    layers: [
      { id: 'media-0', kind: 'shape', from: null, overridden: true, start: 0, duration: 30, track: 1,
        content: { kind: 'shape', shape }, style, effects: [] },
    ],
  })

  it('渲成 class="shape shape-line"，几何/底色走内联 style，无新 CSS 规则', () => {
    const { html } = renderSpecToHtml(shapeSpec('line', { x: 240, y: 100, width: 600, height: 6, bg: '#fff' }))
    expect(html).toContain('<div id="media-0" class="clip"')
    expect(html).toContain('class="shape shape-line"')
    expect(html).toContain('left:240px')
    expect(html).toContain('top:100px')
    expect(html).toContain('width:600px')
    expect(html).toContain('height:6px')
    expect(html).toContain('background:#fff')
  })

  it('既有 rect/ellipse shape 渲染不受影响（①②门禁：非 line 形状零变化）', () => {
    for (const shape of ['rect', 'ellipse'] as const) {
      const { html } = renderSpecToHtml(shapeSpec(shape, { width: 400, height: 240 }))
      expect(html).toContain(`class="shape shape-${shape}"`)
      expect(html).not.toContain('shape-line')
    }
  })
})
