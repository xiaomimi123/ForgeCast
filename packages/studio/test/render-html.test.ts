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
 * Fix round 3 回归测试：`lower.ts` 原来存的图片路径是 `assets/${c.shot.rel}` 原样（没有
 * `encodeURI`），而 `rel` 是操作者自己命名的截图文件名，可能带空格/`#`/`?`/`%`——equivalence
 * 门禁看不到这个问题（它从不检查 `src` 内容，只看 id/时间/轨道/tw/accent），所以这条只能靠专门的
 * 单测守住。故意用一个既带空格又带 `#` 的文件名，同时覆盖 `<img src>` 和
 * `background-image:url(...)` 两个发射点（phoneWrap 用前者，wideWrap 两个都用）。
 */
// encodeURI（跟原版 buildDemoSections 用的是同一个函数，不是 encodeURIComponent）保留 URI
// 语法字符（含 '#'）不转义，只转义空格这类真正非法的字符——`#1` 原样留着，这是 encodeURI 的
// 真实行为，不是本次修复要改变的东西；断言按这个真实行为写，不是按直觉里"全都该编码"来写。
const imgSrc = 'assets/my shot#1.png'
const encodedSrc = 'assets/my%20shot#1.png'
function imageSpec(cssClass: string): any {
  return {
    version: 1, videoId: 'v1', slug: 's', template: 'demo', createdAt: '',
    semantic: { hook: null, sourceAssetId: null, sections: [] },
    canvas: { width: 1080, height: 1920 }, durationSec: 30,
    audio: { narration: null, bgm: null, beatGrid: null, captionsEnabled: false },
    warnings: [],
    layers: [
      { id: 'car0', kind: 'image', from: null, overridden: false, start: 6, duration: 6, track: 2,
        content: { kind: 'image', src: imgSrc }, style: { cssClass }, effects: [] },
    ],
  }
}

describe('renderSpecToHtml：图片路径的 URL 编码（Fix round 3）', () => {
  it('phoneWrap 的 <img src> 编码空格和 #，且仍转义成合法 HTML 属性', () => {
    const { html } = renderSpecToHtml(imageSpec('phoneWrap'))
    expect(html).toContain(`src="${encodedSrc}"`)
    expect(html).not.toContain(imgSrc) // 未编码的原始路径不该原样出现在 HTML 里
  })
  it('wideWrap 的 background-image:url(...) 和 <img src> 都要编码', () => {
    const { html } = renderSpecToHtml(imageSpec('wideWrap'))
    expect(html).toContain(`url('${encodedSrc}')`)
    expect(html).toContain(`src="${encodedSrc}"`)
    expect(html).not.toContain(imgSrc)
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
})
