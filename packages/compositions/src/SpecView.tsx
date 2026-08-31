import React from 'react'
import { LayerView } from './LayerView'
import { twCountOf } from './Text'
import type { VideoSpec } from './videospec-types'

/**
 * 纯展示：给定 spec 与时刻，渲出该时刻应该看到的全部图层。**不碰任何 Remotion hook**——
 * 内容断言门禁直接打这一层，用普通 React 测试即可，不必起 Remotion 运行时。
 *
 * 可见性判断只在这里做一次（`SpecComposition` 不再包 <Sequence>），避免两处判断不一致。
 * `.tw` 全局序号按 spec.layers 顺序、层内按行号累加，复现原 DECODE_RUNTIME 的
 * `document.querySelectorAll('.tw')` 文档顺序——序号错了鬼影字符就变了。
 *
 * 注意：twBase 必须对 spec.layers 里**每一个**文本/字幕图层累加，不论它此刻是否可见——
 * 否则同一图层的鬼影字符会随着其他图层的出现/消失而改变（可见性与序号分配互相污染）。
 */
export function SpecView({ spec, timeSec }: { spec: VideoSpec; timeSec: number }): React.ReactElement {
  let twBase = 0
  const nodes: React.ReactElement[] = []
  for (const layer of spec.layers) {
    const base = twBase
    if (layer.content.kind === 'text' || layer.content.kind === 'caption') {
      twBase += twCountOf(layer, layer.content.text)
    }
    const visible = timeSec >= layer.start && timeSec < layer.start + layer.duration
    if (!visible) continue
    nodes.push(<LayerView key={layer.id} layer={layer} timeSec={timeSec} elemIndexBase={base} />)
  }
  return <div className="specRoot" style={{ position: 'absolute', inset: 0 }}>{nodes}</div>
}
