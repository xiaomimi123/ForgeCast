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
import { describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'
import { SpecView } from '../src/SpecView'

// talk fixture 含 video 图层——LayerView 里的 <Sequence>/<Video> 靠 remotion 的 useVideoConfig()
// 才能渲，脱离 <Composition /> 上下文会直接抛错（见 video-layer.test.tsx 同款 mock）。
// 这里只是让它能渲出 DOM 节点，不测 remotion 自身的时间轴换算（那是 video-layer.test.tsx 的活）。
vi.mock('remotion', () => ({
  Video: (p: Record<string, unknown>) => (
    <video data-testid="rv" src={p.src as string} muted={p.muted as boolean} />
  ),
  Sequence: (p: Record<string, unknown>) => <div data-testid="seq">{p.children as React.ReactNode}</div>,
  useCurrentFrame: () => 0,
  useVideoConfig: () => ({ fps: 30, width: 1080, height: 1920, durationInFrames: 360 }),
}))
import { lockTimeFor } from '../src/decode'
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
import talk from './fixtures/talk.json'

const FIXTURES: Array<[string, VideoSpec]> = [
  ['flash', flash as VideoSpec], ['story', story as VideoSpec], ['changelog', changelog as VideoSpec],
  ['demo', demo as VideoSpec], ['demoCarousel', demoCarousel as VideoSpec],
  ['demoPlan', demoPlan as VideoSpec], ['insight', insight as VideoSpec],
  ['flashCaptions', flashCaptions as VideoSpec], ['demoSpacedShots', demoSpacedShots as VideoSpec],
  ['talk', talk as VideoSpec],
]

/** 生成 fixture 时统一用的 brandName（generate.ts 里十组都是 '品牌'）。 */
const BRAND = '品牌'

/** 图层中点时刻——保证该图层一定可见，且避开入场动画的极端帧。 */
const mid = (l: Layer) => l.start + l.duration / 2

/**
 * 空白**归一化**，不是删除。
 *
 * 曾经写成 `replace(/\s+/g, '')`（整个抹掉），评审做变异实验时抓到：把 Text.tsx 里
 * `if (ch === ' ')` 那支改成不渲染任何东西（解码行的每个空格都丢），整包 123 tests 照样全绿——
 * `返工率高达 30%，每单多花 3 个工作日` 静默退化成 `返工率高达30%…` 能从门禁眼皮底下溜过去。
 *
 * 但也不能原样比对：DOM 里空格渲的是 `&nbsp;`（U+00A0），与 spec 文本里的普通空格不是同一个
 * 码点，逐字节等值会假红。折叠成单个普通空格 + 去首尾，两边都成立，且行内空格的**有无**
 * 仍然可见。
 */
const strip = (s: string) => s.replace(/\s+/g, ' ').trim()

/** 按 id 取元素。用属性选择器而不是 `#${CSS.escape(id)}`——jsdom 环境下全局 `CSS` 是
 *  undefined（实测），且 id 里出现 `-`/`_` 之外的字符时属性选择器同样安全。 */
const byId = (root: ParentNode, id: string) => root.querySelector(`[id="${id}"]`)

const textOf = (l: Layer): string | null =>
  l.content.kind === 'text' || l.content.kind === 'caption' ? l.content.text : null

/**
 * 该图层「逐字解码全部锁定」的最早时刻。
 *
 * 必须算准，不能随手取一个时间：解码中的字符会同时渲出真字（.fin，opacity 0）和鬼影字
 * （.gh），textContent 里两者交错，字面比对会被鬼影污染成假红。
 *
 * 锁定时长直接调 `decode.ts` 的 `lockTimeFor()`，**不在这里抄一份 0.055/1.1/0.225**——
 * 常量抄多份的话，将来正当地调解码节奏就得多处同步改，漏一处 = 门禁假红（自伤）。
 *
 * 取**最长的一行**：finish(n) = (n-1)·min(0.055, 1.1/n) 对 n 单调递增（n≤20 时 step 恒为
 * 1.1/n、finish=1.1·(n-1)/n 递增；n>20 时 step 封顶 0.055、finish=0.055(n-1) 也递增），
 * 所以最长行锁定了，其余行必然也锁定了。
 */
function decodedAt(layer: Layer, text: string): number {
  const longest = Math.max(1, ...text.split('\n').map((l) => Array.from(l).length))
  return layer.start + lockTimeFor(longest) + 1e-6
}

/**
 * 覆盖面守护（文件级，不是每组一条）。
 *
 * 下面按 kind 分流的断言里，image / caption 两类在多数 fixture 组里一次都不进循环——单个 `it`
 * 空转不可避免，但**整个 fixture 集合**必须至少各有一组带这两类图层，否则那两条断言就全空转了。
 * 这不是杞人忧天：`lower()` 只在 `audio.captionsEnabled` 为真时才产 caption 图层，
 * image 只在 `shots` 非空时才有；将来 `lower()` 语义变了、有人重跑 generate.ts，
 * 这两类覆盖会**静默蒸发而九组全绿**。变异实验里「跳过 caption 图层」这一项能变红，
 * 唯一的依托就是 flashCaptions 这组存在。
 */
describe('fixture 集合覆盖面守护', () => {
  it('至少一组 fixture 含 image 图层（否则 src 编码断言全空转）', () => {
    expect(FIXTURES.some(([, s]) => s.layers.some((l) => l.content.kind === 'image'))).toBe(true)
  })
  it('至少一组 fixture 含 caption 图层（否则字幕类图层完全没被渲染过）', () => {
    expect(FIXTURES.some(([, s]) => s.layers.some((l) => l.content.kind === 'caption'))).toBe(true)
  })
  it('至少一组 fixture 的图片路径含需要编码的字符（否则编码断言恒真）', () => {
    const needsEncoding = (p: string) => /[ #?]/.test(p) || /[^\x00-\x7F]/.test(p)
    expect(FIXTURES.some(([, s]) => s.layers.some(
      (l) => l.content.kind === 'image' && needsEncoding(l.content.src),
    ))).toBe(true)
  })
  /** talk（口播合成）独有：video 图层带 trimStart。①的七组、②补的两组都不含 video 图层——
   *  talk fixture（见 generate.ts 文件头注释）是它唯一的来源，缺了它 trimStart 相关的任何
   *  断言/回归都会在全部 fixture 上恒真恒绿。 */
  it('至少一组 fixture 含带 trimStart 的 video 图层', () => {
    expect(FIXTURES.some(([, s]) => s.layers.some(
      (l) => l.content.kind === 'video' && l.content.trimStart !== undefined,
    ))).toBe(true)
  })
})

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

      // 4) `wideWrap`（横图）还有**第二个编码发射点**：`.wideBg` 的 background-image。
      // 只查 img[src] 等于只收了一半口——「图片路径编码丢失 / 编码函数选错」这一族回归
      // 恰恰在 CSS url() 这个形状上翻过车（未编码的 `#`/`?` 在 url() 里同样截断）。
      if (layer.style.cssClass === 'wideWrap') {
        const bgEl = byId(container, layer.id)?.querySelector('.wideBg') as HTMLElement
        expect(bgEl, `图层 ${layer.id} 未渲出 .wideBg`).not.toBeNull()
        const bg = bgEl.style.backgroundImage
        const inUrl = /url\(\s*['"]?([^'")]*)['"]?\s*\)/.exec(bg)?.[1] ?? ''
        expect(inUrl, `图层 ${layer.id} 的 .wideBg 没带上图片路径`).not.toBe('')
        for (const bad of [' ', '#', '?']) {
          expect(inUrl, `图层 ${layer.id} 的 .wideBg url() 未编码 ${JSON.stringify(bad)}`).not.toContain(bad)
        }
        expect(decodeURIComponent(inUrl), `图层 ${layer.id} 的 .wideBg url() 与 spec 不一致`).toBe(raw)
      }
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
    const known = ['flash', 'story', 'demo', 'insight', 'changelog', 'talk']
    expect(cls).toContain(`tpl-${known.includes(spec.template) ? spec.template : 'flash'}`)
    expect(cls.includes('landscape')).toBe(spec.canvas.width >= spec.canvas.height)
  })
})
