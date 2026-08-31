import React from 'react'
import { useCurrentFrame, useVideoConfig } from 'remotion'
import { SpecView } from './SpecView'
import type { VideoSpec } from './videospec-types'

/** 薄包装：唯一职责是把 Remotion 的帧换算成秒。视觉逻辑全在 SpecView 里（便于纯测）。
 *  bgVariant 原样透传——它是 inputProps，由调用方解析好（组件内不随机，见 SpecView 注释）。 */
export function SpecComposition(
  { spec, bgVariant }: { spec: VideoSpec; bgVariant?: string },
): React.ReactElement {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  return <SpecView spec={spec} timeSec={frame / fps} bgVariant={bgVariant} />
}
