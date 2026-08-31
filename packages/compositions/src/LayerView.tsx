import React from 'react'
import { Video } from 'remotion'
import { styleAt } from './effects'
import { encodePathForUrl, ImageContent } from './Image'
import { TextContent } from './Text'
import type { Layer, LayerStyle } from './videospec-types'

/** LayerStyle 通用几何/视觉属性 → 内联样式（迁自 render-html.ts styleAttr）。 */
function geom(style: LayerStyle): React.CSSProperties {
  const s: React.CSSProperties = {}
  if (style.x !== undefined) s.left = style.x
  if (style.y !== undefined) s.top = style.y
  if (style.width !== undefined) s.width = style.width
  if (style.height !== undefined) s.height = style.height
  if (style.color) s.color = style.color
  if (style.bg) s.background = style.bg
  if (style.opacity !== undefined) s.opacity = style.opacity
  if (style.align) s.textAlign = style.align
  if (style.fontSize !== undefined) s.fontSize = style.fontSize
  return s
}

/** 单图层。只读 layer.start/duration/track，不计算它们。 */
export function LayerView(
  { layer, timeSec, elemIndexBase }: { layer: Layer; timeSec: number; elemIndexBase: number },
): React.ReactElement {
  const clipFx = styleAt(layer.effects, layer.start, layer.duration, timeSec, null)
  const base = geom(layer.style)
  const style: React.CSSProperties = {
    ...base,
    zIndex: layer.track,
    opacity: (base.opacity as number ?? 1) * clipFx.opacity,
  }
  // 只有真被动画到的图层才写 transform。恒等值 `translateY(0px) scale(1)` 看着无害，但内联样式
  // 胜过样式表——字幕层（cssClass:'cap'、effects: []）在五份模板 CSS 里靠 `left:50%` +
  // `transform: translateX(-50%)` 居中，被这条恒等 transform 顶掉后字幕左边缘落在画布中线，
  // 右半截裁出画面，而视频照常渲出、零报错。GSAP 语义本来也是「只写被动画的目标」。
  if (clipFx.y !== 0 || clipFx.scale !== 1) {
    style.transform = `translateY(${clipFx.y}px) scale(${clipFx.scale})`
  }
  const cls = ['clip', layer.style.cssClass].filter(Boolean).join(' ')
  let inner: React.ReactNode = null
  switch (layer.content.kind) {
    case 'text':
    case 'caption':
      inner = <TextContent layer={layer} text={layer.content.text} timeSec={timeSec} elemIndexBase={elemIndexBase} />
      break
    case 'image':
      inner = <ImageContent src={layer.content.src} cssClass={layer.style.cssClass} />
      break
    case 'shape':
      inner = <div className={`shape shape-${layer.content.shape}`} />
      break
    case 'video':
      // 未包 <Sequence>：<Video> 的片源始终从 0 秒起播，故 start > 0 的 video 图层拿到的是
      // 「片源 0 秒处的画面」而不是「时间轴 start 处对应的片源偏移」。当前五模板的 video 图层
      // 都是整段铺满、start=0，所以不暴露；子项目④（真实素材剪辑）要按时间轴裁片段时，
      // 必须在这里包一层 <Sequence from={secToFrames(layer.start)}> 并决定 trim 语义。
      inner = <Video src={encodePathForUrl(layer.content.src)} muted={layer.content.muted} />
      break
  }
  return <div id={layer.id} className={cls} style={style}>{inner}</div>
}
