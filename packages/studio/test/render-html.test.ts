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
})
