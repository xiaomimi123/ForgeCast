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
 *  story 没有标题类层，故 titleScale 对 story 天然无效。 */
const TITLE_CLASSES = new Set(['painT', 'hookT', 'title'])

/**
 * 标题类的**基准字号**（px）。来源：`packages/compositions/src/styles/{flash,insight,demo,talk,changelog}.css`
 * 里各自 `.tpl-<模板> .<类名>` 的竖版 `font-size`（1080×1920 是默认画幅）：
 *   flash.css:10      .tpl-flash .painT      100px
 *   insight.css:7     .tpl-insight .painT    100px   ← 与 flash 同值，故 painT 单值即可
 *   demo.css:8        .tpl-demo .hookT        96px
 *   talk.css:16       .tpl-talk .hookT       100px   ← 与 demo 不同值，走 TITLE_BASE_BY_TEMPLATE 例外
 *   changelog.css:8   .tpl-changelog .title   82px
 *
 * **漂移风险**：这是把 CSS 里的数值抄进 TS 的一份副本，改了 CSS 不会自动同步。
 * `test/brand-kit.test.ts` 里有一条「读 CSS 文件正则抽 font-size 与本表逐项比对」的防漂移断言——
 * 改 CSS 后那条会先红，按新值更新本表即可。
 *
 * **已知限制（横版）**：横版（`.landscape`）各模板另有一套更小的字号
 * （flash 84 / insight 68 / demo 76 / talk 84 / changelog 64）。kit 写的是**行内** fontSize，
 * 会盖掉 CSS，故横版下按竖版基准算出来的字号会偏大。当前 kit 无从得知画幅取向
 * （VideoSpec 只有 canvas 宽高，取向判定散在渲染侧），故先按竖版基准落值；
 * 若后续预设要支持横版，应在此按 `spec.canvas.width > spec.canvas.height` 切换第二张表。
 */
const TITLE_BASE_FONT_SIZE: Record<string, number> = { painT: 100, hookT: 96, title: 82 }
/** 同名类在不同模板下字号不一致的例外（见上表）。key = template，value = { cssClass: px }。 */
const TITLE_BASE_BY_TEMPLATE: Record<string, Record<string, number>> = { talk: { hookT: 100 } }

/** 解析某模板下某标题类的基准字号；无表项则返回 undefined（该类不受 titleScale 影响）。 */
export function titleBaseFontSize(template: string, cssClass: string): number | undefined {
  return TITLE_BASE_BY_TEMPLATE[template]?.[cssClass] ?? TITLE_BASE_FONT_SIZE[cssClass]
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
    // ② 否则查 TITLE_BASE_FONT_SIZE（抄自模板 CSS 的竖版字号）。
    // lower 产出本身不写 fontSize（字号归模板 CSS），所以走的基本都是 ②——没有基准表的话
    // titleScale 就是空转，这正是引入该表的原因。
    if (titleScale !== undefined && cssClass && TITLE_CLASSES.has(cssClass)) {
      const base = style.fontSize ?? titleBaseFontSize(spec.template, cssClass)
      if (base !== undefined) style = { ...style, fontSize: Math.round(base * titleScale) }
    }

    if (style === layer.style && content === layer.content) return layer
    return { ...layer, style, content }
  })

  return { ...spec, layers }
}
