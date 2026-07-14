import type { FC } from 'react'
import { useCurrentFrame, useVideoConfig } from 'remotion'
import type { Cue } from '../tts'

// 硬字幕：按当前秒命中 cue 逐句显示（抖音风底部白字黑底）
export const Subtitles: FC<{ cues: Cue[] }> = ({ cues }) => {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  const t = frame / fps
  const cur = cues.find((c) => t >= c.start && t < c.end)
  if (!cur) return null
  return (
    <div style={{ position: 'absolute', bottom: 180, left: 0, right: 0, textAlign: 'center', padding: '0 60px', fontFamily: '"PingFang SC","Noto Sans CJK SC",sans-serif' }}>
      <span style={{ background: 'rgba(0,0,0,.72)', color: '#fff', fontSize: 52, fontWeight: 700, padding: '10px 22px', borderRadius: 12, lineHeight: 1.7 }}>{cur.text}</span>
    </div>
  )
}
