import { FPS, secToFrames } from './time'
import type { VideoSpec } from './videospec-types'

/**
 * Root.tsx 注册的唯一 composition id，也是 studio 侧 selectComposition 要传的那个 id。
 * **单一来源**：这两处曾是两句各自的字面量靠人对齐，改一处忘另一处不会有任何测试变红，
 * 直到真渲几分钟后炸在 selectComposition 上。
 */
export const COMPOSITION_ID = 'spec'

/** spec → Remotion 元数据（Root 的 calculateMetadata 就是它）。fps 固定 30，见 time.ts。 */
export function specMetadata(spec: VideoSpec): { durationInFrames: number; width: number; height: number; fps: number } {
  return {
    durationInFrames: secToFrames(spec.durationSec),
    width: spec.canvas.width,
    height: spec.canvas.height,
    fps: FPS,
  }
}
