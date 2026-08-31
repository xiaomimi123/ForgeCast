import React from 'react'
import { Composition } from 'remotion'
import { COMPOSITION_ID, specMetadata } from './composition'
import { SpecComposition } from './SpecComposition'
import { FPS, secToFrames } from './time'
import type { VideoSpec } from './videospec-types'

const EMPTY: VideoSpec = {
  version: 1, videoId: '', slug: '', template: 'flash', createdAt: '',
  semantic: { hook: null, sourceAssetId: null, sections: [] },
  canvas: { width: 1080, height: 1920 }, durationSec: 12, layers: [],
  audio: { narration: null, bgm: null, beatGrid: null, captionsEnabled: false }, warnings: [],
}

/** 单一 composition，宽高/时长全部由 inputProps 里的 spec 决定（calculateMetadata）。
 *  故 portrait/landscape 共用一个组件，不做 10 个变体。 */
export const RemotionRoot: React.FC = () => (
  <Composition
    id={COMPOSITION_ID}
    component={SpecComposition as never}
    durationInFrames={secToFrames(EMPTY.durationSec)}
    fps={FPS}
    width={EMPTY.canvas.width}
    height={EMPTY.canvas.height}
    defaultProps={{ spec: EMPTY }}
    calculateMetadata={({ props }: { props: { spec: VideoSpec } }) => specMetadata(props.spec)}
  />
)
