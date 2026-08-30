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

/** 文本/字幕内容：多行（lower() 里少数图层如 changelog 标题块、demo 痛点列表把多行拼进
 *  同一个 content.text，用 '\n' 分隔）逐行 escape 后用 <br> 连接——避免把换行符原样吐进 HTML
 *  被浏览器折叠成空格。decode 效果落成外层 span 的 `.tw` 类，供 DECODE_RUNTIME 消费。 */
function renderTextContent(text: string, hasDecode: boolean): string {
  const body = text.split('\n').map(escapeHtml).join('<br>')
  const cls = hasDecode ? ' class="tw"' : ''
  return `<span${cls}>${body}</span>`
}

/** demo 轮播图承袭原 buildDemoSections 的两种取景框（phoneWrap 竖图套手机外框 / wideWrap 横图
 *  居中+同图虚化背景）——cssClass 由 lower() 按 shot.orientation 写好，这里只按名字分流结构，
 *  不重新判断朝向（朝向判断是 lower() 的活）。未知/缺省 cssClass 时退化成裸 <img>。 */
function renderImageContent(src: string, cssClass: string | undefined): string {
  const escapedSrc = escapeHtml(src)
  if (cssClass === 'phoneWrap') {
    return `<div class="phoneWrap"><div class="phone"><img src="${escapedSrc}"/></div></div>`
  }
  if (cssClass === 'wideWrap') {
    return `<div class="wideWrap"><div class="wideBg" style="background-image:url('${escapedSrc}')"></div><div class="wideFg"><img src="${escapedSrc}"/></div></div>`
  }
  return `<img src="${escapedSrc}"/>`
}

function renderContent(layer: Layer, hasDecode: boolean): string {
  switch (layer.content.kind) {
    case 'text':
    case 'caption':
      return renderTextContent(layer.content.text, hasDecode)
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
 *  这里只做 layer.start + effect.at 的加法拼回绝对时间，不重新推导偏移量本身。 */
function effectToAccentLine(layer: Layer, effect: Effect): string | null {
  const at = +(layer.start + (effect.at ?? 0)).toFixed(4)
  const duration = effect.duration ?? 0.3
  switch (effect.type) {
    // demote：迁自 buildInsightSections 的 hero 降级动效（原样保留数值：透明度 .55、缩放 .78）
    case 'demote':
      return `tl.to("#${layer.id}", { opacity: .55, scale: .78, duration: ${duration} }, ${at});`
    case 'fadeIn':
      return `tl.from("#${layer.id}", { opacity: 0, y: 20, duration: ${duration} }, ${at});`
    case 'slideUp':
      return `tl.from("#${layer.id}", { opacity: 0, y: 40, duration: ${duration} }, ${at});`
    // pulse：迁自 buildDemoSections 的图片弹跳强调（原样保留 keyframes 数值）
    case 'pulse':
      return `tl.to("#${layer.id}", { keyframes: [{ scale: 1.06, duration: 0.08 }, { scale: 1.0, duration: 0.12 }] }, ${at});`
    case 'decode':
      return null // decode 不落 accent 行，落成 .tw 类（见 renderContent）
    default:
      return null
  }
}

/** 单个 layer → 一个 `<div class="clip ...">` + 该 layer 产生的 accent 行。
 *  data-start/data-duration/data-track-index 直接原样写 layer.start/duration/track——
 *  这是本函数的唯一时间来源，不做任何 clamp/round/重算。 */
function renderLayer(layer: Layer): { clipHtml: string; accentLines: string[] } {
  const hasDecode = layer.effects.some((e) => e.type === 'decode')
  const cls = ['clip', layer.style.cssClass].filter(Boolean).join(' ')
  const inner = renderContent(layer, hasDecode)
  const clipHtml = `<div id="${escapeHtml(layer.id)}" class="${cls}"${styleAttr(layer.style)}`
    + ` data-start="${layer.start}" data-duration="${layer.duration}" data-track-index="${layer.track}">${inner}</div>`
  const accentLines = layer.effects
    .map((e) => effectToAccentLine(layer, e))
    .filter((l): l is string => l !== null)
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
