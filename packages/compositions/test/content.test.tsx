/**
 * 内容断言门禁（本子项目的主闸）。
 *
 * 为什么不是像素/SSIM 比对：②的产物**不可能**与 HyperFrames 逐像素相同（不同渲染器、不同字体
 * 光栅化），像素比对既脆弱又会给假绿。为什么不是子项目①那套 clip 指纹：那套只比对
 * `id/start/duration/track/twCount/accentCount`，**看不见 cssClass、文本字面、img src、DOM 嵌套**
 * ——历史上 6 个内容回归里有 5 个（解码动效整体丢失 / 品牌名跨五模板丢失 / 字幕类丢失 /
 * 图片路径未编码 / 编码函数选错）就是这么溜过去的。
 *
 * 所以本门禁直接**断言内容**：在保证图层可见（且逐字解码已锁定）的时刻渲 SpecView，
 * 断言该出现的文字、类名、图片路径确实在 DOM 里。
 *
 * fixture 见 fixtures/generate.ts（含重生成命令与「为什么是这批输入」）。
 */
import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { SpecView } from '../src/SpecView'
import type { Layer, VideoSpec } from '../src/videospec-types'
import flash from './fixtures/flash.json'
import story from './fixtures/story.json'
import changelog from './fixtures/changelog.json'
import demo from './fixtures/demo.json'
import demoCarousel from './fixtures/demoCarousel.json'
import demoPlan from './fixtures/demoPlan.json'
import insight from './fixtures/insight.json'
import flashCaptions from './fixtures/flashCaptions.json'
import demoSpacedShots from './fixtures/demoSpacedShots.json'

const FIXTURES: Array<[string, VideoSpec]> = [
  ['flash', flash as VideoSpec], ['story', story as VideoSpec], ['changelog', changelog as VideoSpec],
  ['demo', demo as VideoSpec], ['demoCarousel', demoCarousel as VideoSpec],
  ['demoPlan', demoPlan as VideoSpec], ['insight', insight as VideoSpec],
  ['flashCaptions', flashCaptions as VideoSpec], ['demoSpacedShots', demoSpacedShots as VideoSpec],
]

/** 生成 fixture 时统一用的 brandName（generate.ts 里九组都是 '品牌'）。 */
const BRAND = '品牌'

/** 图层中点时刻——保证该图层一定可见，且避开入场动画的极端帧。 */
const mid = (l: Layer) => l.start + l.duration / 2

const strip = (s: string) => s.replace(/\s+/g, '')

/** 按 id 取元素。用属性选择器而不是 `#${CSS.escape(id)}`——jsdom 环境下全局 `CSS` 是
 *  undefined（实测），且 id 里出现 `-`/`_` 之外的字符时属性选择器同样安全。 */
const byId = (root: ParentNode, id: string) => root.querySelector(`[id="${id}"]`)

const textOf = (l: Layer): string | null =>
  l.content.kind === 'text' || l.content.kind === 'caption' ? l.content.text : null

/**
 * 该图层「逐字解码全部锁定」的最早时刻。
 *
 * 必须算准，不能随手取一个时间：解码中的字符会同时渲出真字（.fin，opacity 0）和鬼影字
 * （.gh），textContent 里两者交错，字面比对会被鬼影污染成假红。锁定条件见 decode.ts：
 * 第 i 个字 t0 = start + i*step（step = min(0.055, 1.1/字数)），t0 + K*GSTEP(=0.225) 后变 final。
 */
function decodedAt(layer: Layer, text: string): number {
  const longest = Math.max(1, ...text.split('\n').map((l) => Array.from(l).length))
  const step = Math.min(0.055, 1.1 / longest)
  return layer.start + (longest - 1) * step + 0.225 + 1e-6
}

describe.each(FIXTURES)('%s 内容断言', (_name, spec) => {
  it('每个图层在其中点时刻都出现在 DOM 中', () => {
    for (const layer of spec.layers) {
      const { container } = render(<SpecView spec={spec} timeSec={mid(layer)} />)
      expect(byId(container, layer.id), `图层 ${layer.id} 未渲出`).not.toBeNull()
    }
  })

  it('文本/字幕图层的每一行文字都完整上屏（逐字解码后逐行等值）', () => {
    for (const layer of spec.layers) {
      const text = textOf(layer)
      if (text === null || !strip(text)) continue
      const t = decodedAt(layer, text)
      // 解码时间必须落在图层生命周期内，否则下面比的是一个根本不可见的时刻——断言会静默恒真。
      expect(t, `图层 ${layer.id} 太短，解码未结束就消失了`).toBeLessThan(layer.start + layer.duration)
      const { container } = render(<SpecView spec={spec} timeSec={t} />)
      const lines = text.split('\n')
      lines.forEach((line, i) => {
        const el = byId(container, `${layer.id}-l${i}`)
        expect(el, `图层 ${layer.id} 第 ${i} 行未渲出`).not.toBeNull()
        // 等值而非 contain：contain 放得过松，一行被截断成前半段照样能过。
        expect(strip(el!.textContent ?? ''), `图层 ${layer.id} 第 ${i} 行文字不符`).toBe(strip(line))
      })
      // 整层文本也必须能在整棵树里读到（防止行元素渲出来了却没挂进 SpecView 的情况）。
      expect(strip(container.textContent ?? '')).toContain(strip(lines[0]))
    }
  })

  it('cssClass 全部保留（.cap/.painT/.cta 这类类名丢失过一次）', () => {
    // 至少要有一个带 cssClass 的图层，否则这条 it 是空转的。
    expect(spec.layers.some((l) => !!l.style.cssClass)).toBe(true)
    for (const layer of spec.layers) {
      if (!layer.style.cssClass) continue
      const { container } = render(<SpecView spec={spec} timeSec={mid(layer)} />)
      const el = byId(container, layer.id) as HTMLElement
      expect(el?.className.split(/\s+/), `图层 ${layer.id} 丢了 cssClass`).toContain(layer.style.cssClass)
      expect(el?.className.split(/\s+/), `图层 ${layer.id} 丢了 clip 类`).toContain('clip')
    }
  })

  it('图片图层的 src 出现、路径分段完整、且已 percent 编码', () => {
    for (const layer of spec.layers) {
      if (layer.content.kind !== 'image') continue
      const raw = layer.content.src
      const { container } = render(<SpecView spec={spec} timeSec={mid(layer)} />)
      const el = byId(container, layer.id)?.querySelector('img') as HTMLImageElement
      expect(el, `图层 ${layer.id} 未渲出 img`).not.toBeNull()
      const src = el.getAttribute('src') ?? ''
      // 1) 空格与 #/? 必须已编码——`#`/`?` 未编码会让浏览器把后半段当 fragment/query 截掉。
      for (const bad of [' ', '#', '?']) {
        expect(src, `图层 ${layer.id} 的 src 未编码 ${JSON.stringify(bad)}`).not.toContain(bad)
      }
      // 2) 目录分隔符 `/` 必须原样保留（整串 encodeURIComponent 会把它编成 %2F 拆掉子目录）。
      expect(src.split('/').length, `图层 ${layer.id} 的 src 目录层级被编坏`).toBe(raw.split('/').length)
      // 3) 解回来必须与 spec 里的原路径逐字相等——既防漏编，也防多编/编错。
      expect(decodeURIComponent(src), `图层 ${layer.id} 的 src 与 spec 不一致`).toBe(raw)
    }
  })

  it('品牌名上屏（跨五模板丢失过，修了四轮）', () => {
    const brandLayers = spec.layers.filter((l) => (textOf(l) ?? '').includes(BRAND))
    // 九组 fixture 全部传了 brandName，任何一组一个品牌图层都没有 = lower 侧把品牌名丢了。
    expect(brandLayers.length, '整个 spec 里没有任何一层带品牌名').toBeGreaterThan(0)
    for (const layer of brandLayers) {
      const text = textOf(layer)!
      const { container } = render(<SpecView spec={spec} timeSec={decodedAt(layer, text)} />)
      expect(strip(container.textContent ?? ''), `图层 ${layer.id} 品牌行丢失`).toContain(BRAND)
    }
  })

  it('根节点模板类与画布方向类正确（未知模板回落 tpl-flash）', () => {
    const { container } = render(<SpecView spec={spec} timeSec={0} />)
    const root = container.firstElementChild as HTMLElement
    const cls = root.className.split(/\s+/)
    expect(cls).toContain('specRoot')
    const known = ['flash', 'story', 'demo', 'insight', 'changelog']
    expect(cls).toContain(`tpl-${known.includes(spec.template) ? spec.template : 'flash'}`)
    expect(cls.includes('landscape')).toBe(spec.canvas.width >= spec.canvas.height)
  })
})
