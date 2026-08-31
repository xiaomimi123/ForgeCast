import React from 'react'
import { charStateAt, decodeTargets } from './decode'
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
        const style: React.CSSProperties = {
          opacity: s.opacity,
          transform: `translateY(${s.y}px) scale(${s.scale})`,
        }
        if (!isTw) {
          return <Tag key={i} id={`${layer.id}-l${i}`} style={style}>{line}</Tag>
        }
        const elemIndex = elemIndexBase + twSeen++
        const chars = Array.from(line)
        return (
          <Tag key={i} id={`${layer.id}-l${i}`} className="tw" style={style}>
            {chars.map((ch, ci) => {
              if (ch === ' ') {
                const t0 = layer.start + ci * Math.min(0.055, 1.1 / Math.max(1, chars.length))
                return <span key={ci} className="twc" style={{ opacity: timeSec >= t0 ? 1 : 0 }}>&nbsp;</span>
              }
              const st = charStateAt(ci, chars.length, elemIndex, layer.start, timeSec)
              if (st.kind === 'hidden') return <span key={ci} className="twc" style={{ opacity: 0 }}>{ch}</span>
              if (st.kind === 'ghost') return <span key={ci} className="twc"><span className="gh">{st.glyph}</span></span>
              return <span key={ci} className="twc"><span className="fin">{ch}</span></span>
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
