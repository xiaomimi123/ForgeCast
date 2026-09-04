import React from 'react'
import { Sequence, Video } from 'remotion'
import { styleAt } from './effects'
import { encodePathForUrl, ImageContent } from './Image'
import { secToFrames } from './time'
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
    case 'video': {
      // 子项目④ talk 还债：包一层 <Sequence from={secToFrames(layer.start)}>，让 <Video> 内部
      // useCurrentFrame() 在时间轴 start 处归零，片源才会从「时间轴 start 对应的偏移」起播，
      // 而不是从片源 0 秒硬播（②Task 8 遗留，start>0 的图层此前会跳播）。trimStart/trimEnd
      // 只管「片源裁剪范围」，与 Sequence.from（时间轴定位）是两件事，缺省即①②行为不变。
      const { trimStart, trimEnd, volume } = layer.content
      inner = (
        <Sequence from={secToFrames(layer.start)} durationInFrames={secToFrames(layer.duration)}>
          <Video
            src={encodePathForUrl(layer.content.src)}
            muted={layer.content.muted}
            startFrom={secToFrames(trimStart ?? 0)}
            endAt={trimEnd != null ? secToFrames(trimEnd) : undefined}
            volume={volume ?? 1}
          />
        </Sequence>
      )
      break
    }
  }
  return <div id={layer.id} className={cls} style={style}>{inner}</div>
}
