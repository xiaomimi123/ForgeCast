import fs from 'node:fs'
import path from 'node:path'
import type { CoreCtx } from '@forgecast/core'

export interface Cue { start: number; end: number; text: string }
export interface VoiceResult { audioRel: string | null; cues: Cue[] }

/** 文本切句 */
function splitSentences(text: string): string[] {
  return text.split(/[。！？\n]+/).map((s) => s.trim()).filter(Boolean)
}
/** 按句估算字幕时间轴（秒） */
function cuesFrom(sentences: string[]): Cue[] {
  let t = 0
  const out: Cue[] = []
  for (const s of sentences) { const dur = Math.max(1.2, s.length * 0.28); out.push({ start: t, end: t + dur, text: s }); t += dur }
  return out
}
/** 合法头的极短静音 WAV（占位用，无实际音频） */
function minimalWav(): Buffer {
  const b = Buffer.alloc(44)
  b.write('RIFF', 0); b.writeUInt32LE(36, 4); b.write('WAVE', 8)
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22)
  b.writeUInt32LE(44100, 24); b.writeUInt32LE(88200, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34)
  b.write('data', 36); b.writeUInt32LE(0, 40)
  return b
}

/** 文本→语音+字幕。stub：占位静音 wav + 估算字幕（不需 key/网络）。live：TTS 最佳努力，失败降级 stub（未验证）。 */
export async function synthesizeVoice(
  ctx: CoreCtx, text: string, outWavAbs: string, fetchImpl: typeof fetch = fetch,
): Promise<VoiceResult> {
  const rel = path.relative(ctx.config.paths.workspace, outWavAbs)
  const cues = cuesFrom(splitSentences(text))
  const writeStub = () => { fs.mkdirSync(path.dirname(outWavAbs), { recursive: true }); fs.writeFileSync(outWavAbs, minimalWav()) }

  if (ctx.config.tts.mode === 'stub' || !ctx.config.tts.apiKey) {
    writeStub()
    return { audioRel: rel, cues }
  }
  // live：最佳努力（未验证），失败降级 stub
  try {
    const res = await fetchImpl(`${ctx.config.tts.baseURL}/audio/speech`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ctx.config.tts.apiKey}` },
      body: JSON.stringify({ model: ctx.config.tts.model, input: text, voice: 'default' }),
    })
    if (!res.ok) throw new Error(`TTS HTTP ${res.status}`)
    fs.mkdirSync(path.dirname(outWavAbs), { recursive: true })
    fs.writeFileSync(outWavAbs, Buffer.from(await res.arrayBuffer()))
    return { audioRel: rel, cues } // 真实时间轴待有 key 后接入，暂用估算
  } catch {
    writeStub()
    return { audioRel: rel, cues }
  }
}
