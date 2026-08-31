import React from 'react'
import { charStateAt, decodeTargets, stepFor } from './decode'
import { styleAt } from './effects'
import type { Layer } from './videospec-types'

/**
 * 文本/字幕内容。多行按 '\n' 拆开，每行一个可寻址元素 `{layerId}-l{i}`（迁自 render-html.ts
 * renderTextContent——effects 的 params.line 靠这个落位）。解码行逐字渲染。
 * elemIndexBase：本层第 0 个解码行在全局 `.tw` 序列中的序号，由 SpecView 统一分配。
 */
export function TextContent(
  { layer, text, timeSec, elemIndexBase }: { layer: Layer; text: string; timeSec: number; elemIndexBase: number },
): React.ReactElement {
  const lines = text.split('\n')
  const targets = decodeTargets(layer)
  const Tag = lines.length > 1 ? 'div' : 'span'
  let twSeen = 0
  return (
    <>
      {lines.map((line, i) => {
        const isTw = targets.all || targets.lines.has(i)
        const s = styleAt(layer.effects, layer.start, layer.duration, timeSec, i)
        // 同 LayerView：恒等 transform 也会顶掉样式表里的 transform（行级同样有模板 CSS 会用），
        // 故只在这一行真被动画时才写。
        const style: React.CSSProperties = { opacity: s.opacity }
        if (s.y !== 0 || s.scale !== 1) style.transform = `translateY(${s.y}px) scale(${s.scale})`
        if (!isTw) {
          return <Tag key={i} id={`${layer.id}-l${i}`} style={style}>{line}</Tag>
        }
        const elemIndex = elemIndexBase + twSeen++
        const chars = Array.from(line)
        return (
          <Tag key={i} id={`${layer.id}-l${i}`} className="tw" style={style}>
            {chars.map((ch, ci) => {
              if (ch === ' ') {
                const t0 = layer.start + ci * stepFor(chars.length)
                return <span key={ci} className="twc" style={{ opacity: timeSec >= t0 ? 1 : 0 }}>&nbsp;</span>
              }
              const st = charStateAt(ci, chars.length, elemIndex, layer.start, timeSec)
              // .twc 的定位声明（position:relative + display:inline-block）是结构性的，不是装饰：
              // .fin 恒挂载并占据正常文档流，靠它一个人决定字符框宽度；.gh 是绝对定位覆盖层，
              // 不参与宽度计算。这样字符宽度在 hidden/ghost/final 三态之间保持恒定，不会因为
              // POOL 里 CJK/片假名/ASCII 字宽不同而在每次 45ms 换鬼影时抖动。视觉细节（青色/
              // 发光/text-shadow）留给样式表任务，这里只放定位。
              const twcStyle: React.CSSProperties = { position: 'relative', display: 'inline-block' }
              const ghStyle: React.CSSProperties = { position: 'absolute', left: 0, top: 0 }
              if (st.kind === 'hidden') {
                return <span key={ci} className="twc" style={twcStyle}><span className="fin" style={{ opacity: 0 }}>{ch}</span></span>
              }
              if (st.kind === 'ghost') {
                return (
                  <span key={ci} className="twc" style={twcStyle}>
                    <span className="fin" style={{ opacity: 0 }}>{ch}</span>
                    <span className="gh" style={ghStyle}>{st.glyph}</span>
                  </span>
                )
              }
              return <span key={ci} className="twc" style={twcStyle}><span className="fin">{ch}</span></span>
            })}
          </Tag>
        )
      })}
    </>
  )
}

/** 本层消耗掉多少个 `.tw` 全局序号——SpecView 靠它累加，保证序号与原脚本文档顺序一致。 */
export function twCountOf(layer: Layer, text: string): number {
  const targets = decodeTargets(layer)
  return text.split('\n').filter((_, i) => targets.all || targets.lines.has(i)).length
}
