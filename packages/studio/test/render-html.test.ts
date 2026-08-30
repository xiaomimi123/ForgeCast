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
