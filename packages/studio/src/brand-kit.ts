/**
 * applyBrandKit：把「品牌 kit」（主色/强调色/标题倍数/CTA 文案）统一套到一份 VideoSpec 的图层上。
 *
 * 定位：kit 是**预设级**的批量套用，不是逐层手调。因此两条硬规则：
 * 1. `overridden: true` 的图层一律跳过——剪辑台手调过的层是用户意志，kit 不得覆盖。
 * 2. kit 为空（空对象 / 字段全 undefined）时**返回原 spec 引用**，一个字节都不动。
 *    lower() 收尾无条件走这条路径，所以「不给 kit 的六模板产出」与加此功能之前逐字节一致。
 *
 * 作用目标一律按 `style.cssClass` 判定（不按 layer.id——id 是模板私有的，cssClass 才是
 * 「这层长什么样」的公共语汇）。下面三张表是**读 lower.ts 六个 lowerXxx 分支实际产出**枚举出来的，
 * 不是猜模板 CSS：
 *
 *   模板       | 图层(cssClass)
 *   -----------|------------------------------------------------------------------
 *   flash      | painT(标题) / flowCap / highlightCard / cta(CTA)
 *   changelog  | title(标题) / tag / brand(CTA 层——见下方说明)
 *   story      | chat / sell / cta(CTA)            ← story 无标题类层
 *   demo       | hookT(标题) / painWrap / phoneWrap|wideWrap(图) / price / cta(CTA)
 *   insight    | painT(标题) / card / cta(CTA)
 *   talk       | (视频层无 cssClass) / hookT(标题) / card / cta(CTA)
 *   字幕       | cap
 *
 * changelog 的 CTA 层 cssClass 是 'brand' 而非 'cta'，**且它的品牌名在第一行、cta 在第二行**
 * （lower.ts:228 `${brandName}\n${cta}`，与其余五模板的 `${cta}\n@${brandName}` 相反）。
 * 需求书把 CTA 目标定义为「cssClass 含 'cta' 的层」——changelog 因此天然落在作用域外，
 * 这正好避开「换第一行」会误删 changelog 品牌名的雷（品牌名烧录是回归过多次的红线区）。
 */
import type { BrandKit, Layer, VideoSpec } from './videospec'

/** CTA 类：primaryColor(color) 与 ctaText(第一行) 的作用对象。含 'cta' 子串即算（当前恰好只有 'cta'）。 */
function isCtaClass(cssClass: string | undefined): boolean {
  return !!cssClass && cssClass.includes('cta')
}

/** 强调块类：accentColor(bg) 的作用对象。flash 的 highlightCard、insight/talk 的 card。 */
const ACCENT_CLASSES = new Set(['card', 'highlightCard'])

/** 标题类：titleScale(fontSize 乘数) 的作用对象。painT(flash/insight)、hookT(demo/talk)、title(changelog)。
 *  story 没有标题类层，故 titleScale 对 story 天然无效。基准字号见 TITLE_BASE_PORTRAIT/LANDSCAPE。 */
const TITLE_CLASSES = new Set(['painT', 'hookT', 'title'])

/**
 * 标题类的**基准字号**（px），按「画幅取向 → 模板 → cssClass」三级查表。
 * 来源：`packages/compositions/src/styles/{flash,insight,demo,talk,changelog}.css`，
 * 竖版取 `.tpl-<模板> .<类名>`、横版取 `.tpl-<模板>.landscape .<类名>` 的 `font-size`：
 *
 *   模板       类名     竖版                    横版
 *   flash      painT    100px (flash.css:10)     84px (flash.css:26)
 *   insight    painT    100px (insight.css:7)    68px (insight.css:37)
 *   demo       hookT     96px (demo.css:8)       76px (demo.css:32)
 *   talk       hookT    100px (talk.css:16)      84px (talk.css:34)
 *   changelog  title     82px (changelog.css:8)  64px (changelog.css:21)
 *
 * 同名类在不同模板下并不同值（横版 painT：flash 84 vs insight 68；hookT：demo 76 vs talk 84），
 * 所以表按模板逐条列出，不做「一个类一个值 + 例外表」的压缩——那样读表的人得先记住哪些是例外。
 * story 没有标题类层，故整表无 story 条目，titleScale 对 story 天然无效。
 *
 * **漂移风险**：这是把 CSS 里的数值抄进 TS 的一份副本，改了 CSS 不会自动同步。
 * `test/brand-kit.test.ts` 有一条「读 CSS 文件正则抽 font-size 与本表逐项比对（竖版+横版）」的
 * 防漂移断言——改 CSS 后那条会先红，按新值更新本表即可。
 */
const TITLE_BASE_PORTRAIT: Record<string, Record<string, number>> = {
  flash: { painT: 100 },
  insight: { painT: 100 },
  demo: { hookT: 96 },
  talk: { hookT: 100 },
  changelog: { title: 82 },
}
const TITLE_BASE_LANDSCAPE: Record<string, Record<string, number>> = {
  flash: { painT: 84 },
  insight: { painT: 68 },
  demo: { hookT: 76 },
  talk: { hookT: 84 },
  changelog: { title: 64 },
}

/** 有专属 CSS / 专属 lower 分支的模板。与 `SpecView.tsx:8` 的 TEMPLATE_CLASSES 同一份名单。 */
const KNOWN_TEMPLATES = new Set(['flash', 'story', 'demo', 'insight', 'changelog', 'talk'])

/** 解析某模板/某取向下某标题类的基准字号；无表项则返回 undefined（该类不受 titleScale 影响）。
 *
 *  未知模板（`custom-<id>`，见 videospec.ts）回落到 flash——与渲染侧 `SpecView.tsx:14 templateClass`
 *  的回落同一口径：custom 走的正是 `lower()` 的 default 分支（= lowerFlash，真产 painT 层），
 *  渲染时也挂 `.tpl-flash` 的 CSS，所以它的标题基准字号就是 flash 的那一份。不回落的话 custom
 *  查表落空、titleScale 对 custom 空转。
 *
 *  `landscape` 由调用方按 `canvas.width >= canvas.height` 判定（正方形算横版——与
 *  `SpecView.tsx:55` 挂 `.landscape` 类的判定同口径；kit 写的行内字号会盖掉 CSS，两处分叉就会错配）。 */
export function titleBaseFontSize(template: string, cssClass: string, landscape = false): number | undefined {
  const t = KNOWN_TEMPLATES.has(template) ? template : 'flash'
  return (landscape ? TITLE_BASE_LANDSCAPE : TITLE_BASE_PORTRAIT)[t]?.[cssClass]
}

/** 只替换文本的第一行，其余行（五模板的 `@品牌名` 第二行）原样保留。 */
function replaceFirstLine(text: string, first: string): string {
  const rest = text.split('\n').slice(1)
  return [first, ...rest].join('\n')
}

export function applyBrandKit(spec: VideoSpec, kit: BrandKit): VideoSpec {
  const { primaryColor, accentColor, titleScale, ctaText } = kit
  // 空 kit = 恒等（门禁：lower 不传 kit 时产出必须与本功能上线前逐字节一致）
  if (primaryColor === undefined && accentColor === undefined && titleScale === undefined && ctaText === undefined) {
    return spec
  }

  // 画幅取向决定标题基准字号取哪张表（横版各模板字号更小）。kit 写的是**行内** fontSize、会盖掉
  // CSS，所以这里必须跟渲染侧挂 `.landscape` 类的判定逐字同口径（`SpecView.tsx:55` 是
  // `width >= height`，正方形算横版），否则两处分叉时会落一个与实际 CSS 不匹配的字号。
  const landscape = spec.canvas.width >= spec.canvas.height

  const layers = spec.layers.map((layer): Layer => {
    if (layer.overridden) return layer            // 手调过的层：kit 不碰
    const cssClass = layer.style.cssClass
    let style = layer.style
    let content = layer.content

    if (isCtaClass(cssClass)) {
      if (primaryColor !== undefined) style = { ...style, color: primaryColor }
      if (ctaText !== undefined && content.kind === 'text') {
        content = { ...content, text: replaceFirstLine(content.text, ctaText) }
      }
    }
    if (accentColor !== undefined && cssClass && ACCENT_CLASSES.has(cssClass)) {
      style = { ...style, bg: accentColor }
    }
    // titleScale：标题层写 fontSize = round(基准 × scale)。基准取值顺序——
    // ① 该层已有显式 fontSize（剪辑台手调过字号，以用户的值为准）；
    // ② 否则查 TITLE_BASE_PORTRAIT / TITLE_BASE_LANDSCAPE（抄自模板 CSS，按画幅取向选表）。
    // lower 产出本身不写 fontSize（字号归模板 CSS），所以走的基本都是 ②——没有基准表的话
    // titleScale 就是空转，这正是引入该表的原因。
    if (titleScale !== undefined && cssClass && TITLE_CLASSES.has(cssClass)) {
      const base = style.fontSize ?? titleBaseFontSize(spec.template, cssClass, landscape)
      if (base !== undefined) style = { ...style, fontSize: Math.round(base * titleScale) }
    }

    if (style === layer.style && content === layer.content) return layer
    return { ...layer, style, content }
  })

  return { ...spec, layers }
}
