import React from 'react'
import { Background, Camera } from './Background'
import { LayerView } from './LayerView'
import { twCountOf } from './Text'
import type { VideoSpec } from './videospec-types'

/** 有专属 CSS 的模板。styles/<name>.css 里的选择器都作用域在 .tpl-<name> 下。 */
const TEMPLATE_CLASSES = ['flash', 'story', 'demo', 'insight', 'changelog'] as const
/** 默认模板：spec.template 可能是 `custom-<id>`（见 videospec.ts），那样 .tpl-custom-xxx 匹配不到
 *  任何 CSS，整页会静默裸奔。故未知模板一律回落到 flash 的样式，宁可长得像 flash 也不要没样式。 */
export const FALLBACK_TEMPLATE = 'flash'

/** spec.template → 根节点要挂的模板样式类名（含未知/custom 模板的回落）。 */
export function templateClass(template: string): string {
  return (TEMPLATE_CLASSES as readonly string[]).includes(template) ? template : FALLBACK_TEMPLATE
}

/**
 * 纯展示：给定 spec 与时刻，渲出该时刻应该看到的全部图层。**自身不碰任何 Remotion hook**——
 * 内容断言门禁直接打这一层，用普通 React 测试即可。
 * 例外：video 图层落到 remotion 的 <Video>（见 LayerView），它内部要 useVideoConfig——
 * 含 video 图层的 spec 仍需 Remotion 上下文（测试里 mock remotion 即可，见 video-layer.test.tsx）。
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
 * 模板专属 CSS 在同一个全局样式包里，靠 .tpl-<template> 作用域隔离（见 styles/*.css）；横版规则
 * 靠 .landscape 类而非媒体查询（媒体查询在 Studio 预览里按浏览器窗口求值，会误命中，见 styles/*.css 注释）。
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
  const landscape = spec.canvas.width >= spec.canvas.height
  const cls = `specRoot tpl-${templateClass(spec.template)}${landscape ? ' landscape' : ''}`
  // #techbg 必须在 #cam **内部**——源模板的 <!--HF_BG--> 就在 <div id="cam"> 里（flash/demo/
  // insight/changelog 四份都是，story 不出背景），故背景也随全片相机 scale 1→1.06 一起推进。
  // 放到 Camera 外面会让网格间距恒定，与原版逐帧对不上。
  return (
    <div className={cls} style={{ position: 'absolute', inset: 0 }}>
      <Camera timeSec={timeSec} durationSec={spec.durationSec}>
        <Background variant={bgVariant} timeSec={timeSec} durationSec={spec.durationSec} />
        {nodes}
      </Camera>
    </div>
  )
}
