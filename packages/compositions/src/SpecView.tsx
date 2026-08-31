import React from 'react'
import { Background, Camera } from './Background'
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
 *
 * `bgVariant` 由调用方（Task 9 的渲染入口）用 studio 侧的 resolveTechBg 解析一次后经 inputProps
 * 传入——**组件内绝不随机**，否则每帧结果不同、渲染必然闪烁。story 传 undefined（聊天场不加背景）。
 * 模板专属 CSS 在同一个全局样式包里，靠 .tpl-<template> 作用域隔离（见 styles/*.css）。
 */
export function SpecView(
  { spec, timeSec, bgVariant }: { spec: VideoSpec; timeSec: number; bgVariant?: string },
): React.ReactElement {
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
  return (
    <div className={`specRoot tpl-${spec.template}`} style={{ position: 'absolute', inset: 0 }}>
      <Background variant={bgVariant} timeSec={timeSec} durationSec={spec.durationSec} />
      <Camera timeSec={timeSec} durationSec={spec.durationSec}>{nodes}</Camera>
    </div>
  )
}
