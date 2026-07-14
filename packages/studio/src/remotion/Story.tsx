import type { FC } from 'react'
import { AbsoluteFill, Audio, Sequence, interpolate, useCurrentFrame } from 'remotion'
import type { StoryProps } from '../props'
import { Subtitles } from './Subtitles'

const FONT = '"PingFang SC","Noto Sans CJK SC",sans-serif'

const Bubble: FC<{ who: 'them' | 'me'; text: string; delay: number }> = ({ who, text, delay }) => {
  const frame = useCurrentFrame()
  const op = interpolate(frame - delay, [0, 10], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })
  const mine = who === 'me'
  return (
    <div style={{ display: 'flex', justifyContent: mine ? 'flex-end' : 'flex-start', opacity: op, margin: '18px 0' }}>
      <div style={{ maxWidth: '75%', background: mine ? '#95ec69' : '#fff', color: '#111', fontSize: 44, padding: '20px 28px', borderRadius: 22, lineHeight: 1.4 }}>{text}</div>
    </div>
  )
}

// 模板B 接单故事型：聊天气泡 → 卖点 → CTA，挂 TTS 音频 + 硬字幕
export const Story: FC<StoryProps> = ({ bubbles, sellingPoint, cta, brandName, audioSrc, cues }) => {
  return (
    <AbsoluteFill style={{ background: '#ded6cc', fontFamily: FONT, padding: 60 }}>
      {audioSrc ? <Audio src={audioSrc} /> : null}
      <Sequence from={0} durationInFrames={360}>
        <div style={{ paddingTop: 80 }}>{bubbles.map((b, i) => <Bubble key={i} who={b.who} text={b.text} delay={i * 30} />)}</div>
      </Sequence>
      <Sequence from={360} durationInFrames={120}>
        <AbsoluteFill style={{ background: 'linear-gradient(160deg,#16213e,#0f3460)', justifyContent: 'center', alignItems: 'center', padding: 80 }}>
          <div style={{ color: '#ffd54f', fontSize: 80, fontWeight: 800, textAlign: 'center', lineHeight: 1.3 }}>{sellingPoint}</div>
        </AbsoluteFill>
      </Sequence>
      <Sequence from={480} durationInFrames={120}>
        <AbsoluteFill style={{ background: '#1a1a2e', justifyContent: 'center', alignItems: 'center', padding: 80, textAlign: 'center' }}>
          <div><div style={{ color: '#fff', fontSize: 72, fontWeight: 800, marginBottom: 40 }}>{cta}</div><div style={{ color: '#8888aa', fontSize: 40 }}>@{brandName}</div></div>
        </AbsoluteFill>
      </Sequence>
      {cues ? <Subtitles cues={cues} /> : null}
    </AbsoluteFill>
  )
}
