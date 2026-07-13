import type { FC, ReactNode } from 'react'
import { AbsoluteFill, Sequence, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion'
import type { FlashProps } from '../props'

const FONT = '"PingFang SC", "Noto Sans CJK SC", sans-serif'

// 单段文字卡：弹入 + 淡入
const Card: FC<{ children: ReactNode; bg: string }> = ({ children, bg }) => {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  const s = spring({ frame, fps, config: { damping: 200 } })
  const opacity = interpolate(frame, [0, 12], [0, 1], { extrapolateRight: 'clamp' })
  return (
    <AbsoluteFill style={{ background: bg, justifyContent: 'center', alignItems: 'center', padding: 80, fontFamily: FONT, textAlign: 'center' }}>
      <div style={{ transform: `scale(${0.8 + s * 0.2})`, opacity }}>{children}</div>
    </AbsoluteFill>
  )
}

// flash 模板：痛点大字(0-4s) → 一句卖点(4-10s) → CTA(10-15s)
export const Flash: FC<FlashProps> = ({ painTitle, sellingPoint, cta, brandName }) => {
  return (
    <AbsoluteFill style={{ background: '#0f0f1a' }}>
      <Sequence from={0} durationInFrames={120}>
        <Card bg="linear-gradient(160deg,#1a1a2e,#16213e)">
          <div style={{ color: '#fff', fontSize: 96, fontWeight: 900, lineHeight: 1.3 }}>{painTitle}</div>
        </Card>
      </Sequence>
      <Sequence from={120} durationInFrames={180}>
        <Card bg="linear-gradient(160deg,#16213e,#0f3460)">
          <div style={{ color: '#ffd54f', fontSize: 84, fontWeight: 800, lineHeight: 1.3 }}>{sellingPoint}</div>
        </Card>
      </Sequence>
      <Sequence from={300} durationInFrames={150}>
        <Card bg="linear-gradient(160deg,#0f3460,#1a1a2e)">
          <div>
            <div style={{ color: '#fff', fontSize: 72, fontWeight: 800, marginBottom: 40 }}>{cta}</div>
            <div style={{ color: '#8888aa', fontSize: 40 }}>@{brandName}</div>
          </div>
        </Card>
      </Sequence>
    </AbsoluteFill>
  )
}
