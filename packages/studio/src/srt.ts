import type { Cue } from './tts'

/** 毫秒 → SRT 时间戳 HH:MM:SS,mmm（补零，跨分钟/小时正确进位） */
function msToSrtTimestamp(ms: number): string {
  const totalMs = Math.max(0, Math.round(ms))
  const h = Math.floor(totalMs / 3_600_000)
  const m = Math.floor((totalMs % 3_600_000) / 60_000)
  const s = Math.floor((totalMs % 60_000) / 1000)
  const msRemainder = totalMs % 1000
  const pad = (n: number, len: number) => String(n).padStart(len, '0')
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)},${pad(msRemainder, 3)}`
}

/** Cue[]（毫秒级 start/end + 文本）转标准 SRT 文本。空数组返回空串。不做任何文件 I/O。 */
export function cuesToSrt(cues: Cue[]): string {
  if (cues.length === 0) return ''
  return cues
    .map((cue, i) => `${i + 1}\n${msToSrtTimestamp(cue.start)} --> ${msToSrtTimestamp(cue.end)}\n${cue.text}\n`)
    .join('\n')
}
