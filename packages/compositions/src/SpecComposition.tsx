import React from 'react'
import { useCurrentFrame, useVideoConfig } from 'remotion'
import { SpecView } from './SpecView'
import type { VideoSpec } from './videospec-types'

/** 薄包装：唯一职责是把 Remotion 的帧换算成秒。视觉逻辑全在 SpecView 里（便于纯测）。 */
export function SpecComposition({ spec }: { spec: VideoSpec }): React.ReactElement {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  return <SpecView spec={spec} timeSec={frame / fps} />
}
