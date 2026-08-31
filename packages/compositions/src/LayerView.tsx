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
    transform: `translateY(${clipFx.y}px) scale(${clipFx.scale})`,
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
      inner = <Video src={encodePathForUrl(layer.content.src)} muted={layer.content.muted} />
      break
  }
  return <div id={layer.id} className={cls} style={style}>{inner}</div>
}
