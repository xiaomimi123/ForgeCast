import React from 'react'
import { Audio, useCurrentFrame, useVideoConfig } from 'remotion'
import { encodePathForUrl } from './Image'
import { SpecView } from './SpecView'
import type { VideoSpec } from './videospec-types'

/** 薄包装：唯一职责是把 Remotion 的帧换算成秒 + 挂旁白音轨。视觉逻辑全在 SpecView 里（便于纯测）。
 *  bgVariant 原样透传给 SpecView，由那里与 `spec.bgVariant` 收口成一个取值点（组件内不随机）。
 *
 *  旁白（设计稿 §5「旁白：<Audio> 进合成」）：src 必须是 **publicDir 相对**路径——
 *  spec 里存的是 workspace 相对（见 tts.ts），由 studio 侧 remotion-render.ts 在构造 inputProps
 *  时归一化，schema 与 lower() 都不动（那是 ①② 共用层）。
 *  漏了这条音轨不会报错也不会渲失败：Remotion 会自带一条静音 AAC，成片只剩 BGM、没有人声，
 *  连 `mean_volume ≠ -91dB` 的验收判据都能骗过去——所以它由 narration.test.tsx 钉死。 */
export function SpecComposition(
  { spec, bgVariant }: { spec: VideoSpec; bgVariant?: string },
): React.ReactElement {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  const narration = spec.audio.narration
  return (
    <>
      {narration ? <Audio src={encodePathForUrl(narration.src)} /> : null}
      <SpecView spec={spec} timeSec={frame / fps} bgVariant={bgVariant} />
    </>
  )
}
