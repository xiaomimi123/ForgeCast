/**
 * renderSpecToHtml()：VideoSpec 的最后一步——把 `spec.layers`（Task 3 `lower()` 已经算好的
 * 时间轴：起止/时长/轨道）渲成 clip HTML + accents（挂主时间线的 GSAP 强调行）。
 *
 * 硬规则（本文件唯一职责边界）：**只读 layer.start/duration/track，不计算它们**。
 * 所有分组/吸附节拍/驻留上限逻辑都已经在 Task 3 的 lower() 里跑完，本文件只负责“图层 → HTML”
 * 这一层映射。若发现某个模板的视觉效果需要一个 layers 里没有的时间量，说明 lower() 漏了什么，
 * 应该回去补 lower()，而不是在这里现算。
 *
 * 不做的事（明确边界）：
 * - 不渲染 `<audio>`——音轨完全不在 spec.layers 里（by design，见 videospec.ts AudioSpec 注释），
 *   由 injectAudioCaptions 在更上层单独注入。若在这里把它塞进任何 wrapper 元素，会重现三个提交前
 *   踩过的坑：HyperFrames 解码时找不到直接挂在 composition 根下的 <audio>，静默不出声。
 * - 不用 CSS @keyframes、不用裸 gsap.to、不用 repeat:-1——全部会在 HyperFrames 逐帧 seek 渲染下失效
 *   或不受控；强调动画一律走 `tl.to(...)`/`tl.from(...)`/`tl.set(...)` 挂主时间线。
 * - `content.kind === 'video'` 是 videospec.ts 里标注的「④ 预留，本次不渲染」占位，这里同样跳过。
 */
import { escapeHtml } from './hyperframes'
import type { Effect, Layer, LayerStyle, VideoSpec } from './videospec'

/** LayerStyle 里通用几何/视觉属性 → 内联 style。cssClass 不在这里处理（走 class 属性）。 */
function styleAttr(style: LayerStyle): string {
  const decls: string[] = []
  if (style.x !== undefined) decls.push(`left:${style.x}px`)
  if (style.y !== undefined) decls.push(`top:${style.y}px`)
  if (style.width !== undefined) decls.push(`width:${style.width}px`)
  if (style.height !== undefined) decls.push(`height:${style.height}px`)
  if (style.color) decls.push(`color:${escapeHtml(style.color)}`)
  if (style.bg) decls.push(`background:${escapeHtml(style.bg)}`)
  if (style.opacity !== undefined) decls.push(`opacity:${style.opacity}`)
  if (style.align) decls.push(`text-align:${style.align}`)
  if (style.fontSize !== undefined) decls.push(`font-size:${style.fontSize}px`)
  return decls.length ? ` style="${decls.join(';')}"` : ''
}

/**
 * 文本/字幕内容：多行（lower() 里少数图层如 changelog 标题块、demo 痛点列表把多行拼进
 * 同一个 content.text，用 '\n' 分隔）拆成一行一个可寻址元素——单行时也一样，都套 `id="{layerId}-l{i}"`
 * （行号从 0 开始）。这不是「计算时间」，只是给同一 layer 内的多个子元素起稳定 id，好让
 * `effects[]` 里按 `params.line` 指认「渲染出来的第几行」（decode 的精确逐行落位、story 气泡的
 * 逐条 reveal 强调都靠这个）。
 *
 * decode（`.tw`）落位规则：effect.type==='decode' 且没有 `params.line` → 这一层渲出来的**每一行**
 * 都套 `.tw`（原版五个模板里绝大多数文字图层本就是单行、整块解码，这是默认档）；带
 * `params.line` → 只有指定行号解码（changelog 的 clTitle 是唯一例外：label+title+subtitle
 * 三行拼一层，只有 title/subtitle 该解码，见 lower.ts DECODE_LINE）。
 */
function renderTextContent(layer: Layer, text: string): string {
  const lines = text.split('\n')
  const decodeEffects = layer.effects.filter((e) => e.type === 'decode')
  const decodeAllLines = decodeEffects.some((e) => e.params?.line === undefined)
  const decodeLineSet = new Set(
    decodeEffects.map((e) => e.params?.line).filter((l): l is number => typeof l === 'number'),
  )
  const tag = lines.length > 1 ? 'div' : 'span'
  return lines.map((line, i) => {
    const isTw = decodeAllLines || decodeLineSet.has(i)
    const cls = isTw ? ' class="tw"' : ''
    return `<${tag} id="${escapeHtml(layer.id)}-l${i}"${cls}>${escapeHtml(line)}</${tag}>`
  }).join('')
}

/**
 * 逐段编码一条相对路径：按 `/` 切开、每一段单独喂 `encodeURIComponent`、再用 `/` 拼回去。
 *
 * Fix round 4：round 3 用的是 `encodeURI`（原版 buildDemoSections 同款，hyperframes.ts:467），
 * 但 `encodeURI` 故意放过一整串 URL 结构字符不转义——包括 `#`（fragment 分隔符）和 `?`
 * （query 分隔符）。这两个字符出现在文件名里是真实场景（截图工具/系统相册常见），一旦出现，
 * 浏览器会把 `#`/`?` 之后的部分整段切掉当成 fragment/query，而不是文件名的一部分——
 * `my shot#1.png` 用 encodeURI 编码后是 `my%20shot#1.png`，浏览器实际请求的是
 * `.../my%20shot`（`#1.png` 变成锚点），文件找不到。这是原版就带的 bug，照抄只会把缺陷继续
 * 传下去，不属于"忠于原版"该忠的部分。
 *
 * 之所以不能整串扔给 `encodeURIComponent`：那会把路径分隔符 `/` 也编码成 `%2F`，
 * `rel` 允许带子目录（如 `screens/a.png`），整串编码会把目录结构拆没。所以按段编码、
 * 段与段之间的 `/` 原样保留。
 */
function encodePathForUrl(src: string): string {
  return src.split('/').map((seg) => encodeURIComponent(seg)).join('/')
}

/**
 * demo 轮播图承袭原 buildDemoSections 的两种取景框（phoneWrap 竖图套手机外框 / wideWrap 横图
 * 居中+同图虚化背景）——cssClass 由 lower() 按 shot.orientation 写好，这里只按名字分流结构，
 * 不重新判断朝向（朝向判断是 lower() 的活）。未知/缺省 cssClass 时退化成裸 <img>。
 *
 * URL 编码故意放在这里、不放在 lower()（Fix round 3）：`layer.content.src` 是"这张图逻辑上在哪"
 * 的一条路径，编码是"往 HTML/CSS 里写一条 URL 时才需要做"的转换——这是两件事，混在一起会出问题。
 * spec 是要按视频存盘、被剪辑台加载**手工编辑**的：如果在 lower() 里就编码，存盘的 spec 里
 * `content.src` 会变成形如 `my%20shot.png` 这种给机器看的字符串，用户在剪辑台里看到的就是这个
 * 乱码，而不是真实文件名 `my shot.png`；更糟的是，如果用户再手改一次并存盘，下一次渲染会对一个
 * 已经编码过的字符串再编码一遍（双重编码，`%2520` 这类）。所以 `lower()` 只存"逻辑路径"这个原始
 * 真相，编码放在真正"发射一条 URL"的这一刻——不管 spec 是刚生成的、手改过的、还是从存盘 JSON
 * 读回来重渲的，这里都会对它当前的路径值正确编码一次，不会算重也不会漏算。
 * 两处发射点（`<img src>` 和 `background-image:url(...)`）都要编码；`encodePathForUrl` 处理 URL
 * 安全性（空格/`#`/`?`/`%` 等，逐段编码保留 `/`），`escapeHtml` 处理 HTML 属性安全性，两者管
 * 不同的问题、缺一不可，且顺序固定是先编码 URL 再转义 HTML——颠倒顺序会把编码产出的 `%` 又喂给
 * `escapeHtml`（那不转义 `%`，无害，但顺序仍按这个来，不做无谓的偏离）。
 */
function renderImageContent(src: string, cssClass: string | undefined): string {
  const safeSrc = escapeHtml(encodePathForUrl(src))
  if (cssClass === 'phoneWrap') {
    return `<div class="phoneWrap"><div class="phone"><img src="${safeSrc}"/></div></div>`
  }
  if (cssClass === 'wideWrap') {
    return `<div class="wideWrap"><div class="wideBg" style="background-image:url('${safeSrc}')"></div><div class="wideFg"><img src="${safeSrc}"/></div></div>`
  }
  return `<img src="${safeSrc}"/>`
}

function renderContent(layer: Layer): string {
  switch (layer.content.kind) {
    case 'text':
    case 'caption':
      return renderTextContent(layer, layer.content.text)
    case 'image':
      return renderImageContent(layer.content.src, layer.style.cssClass)
    case 'shape':
      return `<div class="shape shape-${layer.content.shape}"></div>`
    case 'video':
      // 预留，本次不渲染（videospec.ts LayerContent 注释）
      return ''
    default:
      return ''
  }
}

/** effect.at 是「相对图层起点的秒偏移」（videospec.ts 注释）——lower() 已经把它算成相对量，
 *  这里只做 layer.start + effect.at 的加法拼回绝对时间，不重新推导偏移量本身。
 *  target：带 `params.line` 时打到 renderTextContent 生成的那个子行 id（`{layer.id}-l{line}`）——
 *  story 气泡的逐条 reveal 就是这样落到 storyChat 的某一"行"上的；不带则打整个 clip 的 id
 *  （原有的 demote/pulse 等用法不变）。
 *  `params.y`/`params.scale`：fadeIn 默认是 y:20 位移淡入（迁自 flashHook/storySell 等最常见的
 *  形态），但 flashHighlight 是 scale:.9 缩放淡入、changelog 的 label 是 y:-30——用 params 覆盖
 *  默认值，不新增更多 effect 类型（形状仍是"淡入"，只是运动方向不同，不是不同语义）。
 *  `exit` 一次产出两行：先缩小+降透明度移出，再在 clip 结束时刻硬 set 收尾（迁自
 *  buildInsightSections 的卡片退场，见 videospec.ts Effect 类型注释）——退场终点直接用
 *  `layer.start+layer.duration`，不是重新计算，是读 lower() 已经给好的时长。 */
function effectToAccentLine(layer: Layer, effect: Effect): string[] {
  const at = +(layer.start + (effect.at ?? 0)).toFixed(4)
  const duration = effect.duration ?? 0.3
  const line = effect.params?.line
  const target = typeof line === 'number' ? `${layer.id}-l${line}` : layer.id
  switch (effect.type) {
    // demote：迁自 buildInsightSections 的 hero 降级动效（原样保留数值：透明度 .55、缩放 .78）
    case 'demote':
      return [`tl.to("#${target}", { opacity: .55, scale: .78, duration: ${duration} }, ${at});`]
    case 'fadeIn': {
      const scale = effect.params?.scale
      const y = effect.params?.y ?? 20
      const props = scale !== undefined ? `opacity: 0, scale: ${scale}` : `opacity: 0, y: ${y}`
      return [`tl.from("#${target}", { ${props}, duration: ${duration} }, ${at});`]
    }
    // slideUp：迁自 buildStorySections 的逐条气泡淡入+上移（原样保留数值：y 40、duration .5）
    case 'slideUp':
      return [`tl.from("#${target}", { opacity: 0, y: 40, duration: ${duration} }, ${at});`]
    // pulse：迁自 buildDemoSections 的图片弹跳强调（原样保留 keyframes 数值）
    case 'pulse':
      return [`tl.to("#${target}", { keyframes: [{ scale: 1.06, duration: 0.08 }, { scale: 1.0, duration: 0.12 }] }, ${at});`]
    case 'exit': {
      const clipEnd = +(layer.start + layer.duration).toFixed(4)
      const exitAt = +(clipEnd - duration).toFixed(4)
      return [
        `tl.to("#${target}", { opacity: 0, scale: .85, duration: ${duration} }, ${exitAt});`,
        `tl.set("#${target}", { opacity: 0 }, ${clipEnd});`,
      ]
    }
    case 'decode':
      return [] // decode 不落 accent 行，落成 .tw 类（见 renderTextContent）
    default:
      return []
  }
}

/** 单个 layer → 一个 `<div class="clip ...">` + 该 layer 产生的 accent 行。
 *  data-start/data-duration/data-track-index 直接原样写 layer.start/duration/track——
 *  这是本函数的唯一时间来源，不做任何 clamp/round/重算。 */
function renderLayer(layer: Layer): { clipHtml: string; accentLines: string[] } {
  const cls = ['clip', layer.style.cssClass].filter(Boolean).join(' ')
  const inner = renderContent(layer)
  const clipHtml = `<div id="${escapeHtml(layer.id)}" class="${cls}"${styleAttr(layer.style)}`
    + ` data-start="${layer.start}" data-duration="${layer.duration}" data-track-index="${layer.track}">${inner}</div>`
  const accentLines = layer.effects.flatMap((e) => effectToAccentLine(layer, e))
  return { clipHtml, accentLines }
}

/**
 * spec.layers → { html, accents }。html 是 clip 片段拼接（供替换旧 <!--HF_SECTIONS-->），
 * accents 是 GSAP 强调行拼接（供替换旧 <!--HF_ACCENTS-->，见 hyperframes.ts fillAccents）。
 * 不含 <audio>、不含页面外壳——两者都不是这一层的职责（见文件头注释）。
 */
export function renderSpecToHtml(spec: VideoSpec): { html: string; accents: string } {
  const clips: string[] = []
  const accents: string[] = []
  for (const layer of spec.layers) {
    const { clipHtml, accentLines } = renderLayer(layer)
    clips.push(clipHtml)
    accents.push(...accentLines)
  }
  return { html: clips.join('\n'), accents: accents.join('\n') }
}
