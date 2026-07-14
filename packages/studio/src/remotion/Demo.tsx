import type { FC, ReactNode } from 'react'
import { AbsoluteFill, Audio, OffthreadVideo, Sequence, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion'
import type { DemoProps } from '../props'
import { Subtitles } from './Subtitles'

const FONT = '"PingFang SC","Noto Sans CJK SC",sans-serif'

const Center: FC<{ children: ReactNode; bg: string }> = ({ children, bg }) => {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  const s = spring({ frame, fps, config: { damping: 200 } })
  return (
    <AbsoluteFill style={{ background: bg, justifyContent: 'center', alignItems: 'center', padding: 80, fontFamily: FONT, textAlign: 'center' }}>
      <div style={{ transform: `scale(${0.85 + s * 0.15})` }}>{children}</div>
    </AbsoluteFill>
  )
}

// 痛点逐条弹出（hook 只在本组件调一次，避免在 map 里调 hook）
const PainPoints: FC<{ points: string[] }> = ({ points }) => {
  const frame = useCurrentFrame()
  return (
    <AbsoluteFill style={{ background: '#16213e', justifyContent: 'center', padding: 80, fontFamily: FONT }}>
      {points.map((p, i) => {
        const op = interpolate(frame - i * 20, [0, 10], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })
        return <div key={i} style={{ color: '#fff', fontSize: 60, fontWeight: 700, margin: '20px 0', opacity: op }}>· {p}</div>
      })}
    </AbsoluteFill>
  )
}

// 模板A 产品演示型：钩子→痛点→录屏演示→报价锚点→CTA
export const Demo: FC<DemoProps> = ({ painTitle, painPoints, demoVideoSrc, priceAnchor, cta, brandName, audioSrc, cues }) => {
  return (
    <AbsoluteFill style={{ background: '#0f0f1a', fontFamily: FONT }}>
      {audioSrc ? <Audio src={audioSrc} /> : null}
      <Sequence from={0} durationInFrames={90}>
        <Center bg="linear-gradient(160deg,#1a1a2e,#16213e)"><div style={{ color: '#fff', fontSize: 96, fontWeight: 900, lineHeight: 1.3 }}>{painTitle}</div></Center>
      </Sequence>
      <Sequence from={90} durationInFrames={150}>
        <PainPoints points={painPoints} />
      </Sequence>
      <Sequence from={240} durationInFrames={1110}>
        <AbsoluteFill style={{ background: '#000' }}>
          {demoVideoSrc
            ? <OffthreadVideo src={demoVideoSrc} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            : <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center', border: '6px dashed #555', color: '#888', fontSize: 48, fontFamily: FONT }}>（演示录屏位）</AbsoluteFill>}
          <div style={{ position: 'absolute', top: 60, left: 60, background: 'rgba(0,0,0,.6)', color: '#ffd54f', fontSize: 40, fontWeight: 700, padding: '8px 20px', borderRadius: 10 }}>{painTitle}</div>
        </AbsoluteFill>
      </Sequence>
      <Sequence from={1350} durationInFrames={210}>
        <Center bg="linear-gradient(160deg,#0f3460,#16213e)"><div style={{ color: '#ffd54f', fontSize: 72, fontWeight: 800, lineHeight: 1.4 }}>{priceAnchor}</div></Center>
      </Sequence>
      <Sequence from={1560} durationInFrames={240}>
        <Center bg="#1a1a2e"><div><div style={{ color: '#fff', fontSize: 72, fontWeight: 800, marginBottom: 40 }}>{cta}</div><div style={{ color: '#8888aa', fontSize: 40 }}>@{brandName}</div></div></Center>
      </Sequence>
      {cues ? <Subtitles cues={cues} /> : null}
    </AbsoluteFill>
  )
}
