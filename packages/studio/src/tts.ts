import fs from 'node:fs'
import path from 'node:path'
import type { CoreCtx } from '@forgecast/core'
import { runKokoroTts } from './hyperframes'

export interface Cue { start: number; end: number; text: string }
/** degraded：live/kokoro 模式失败回落占位音轨时的原因（stub 模式下为 undefined，不算降级） */
export interface VoiceResult { audioRel: string | null; cues: Cue[]; degraded?: string }

/** synthesizeVoice 可注入依赖：测试用 mock，生产走默认实现 */
export interface TtsDeps {
  runKokoro?: (text: string, outWavAbs: string) => Promise<void>
  fetchImpl?: typeof fetch
}

/**
 * 清理口播脚本：去掉舞台提示，只留要念/要显示的话。
 * 抖音脚本形如「【0-3s 钩子】（大字弹出）正文…」——【…】是段落节奏标记、（…）是画面指示，
 * 都不该被 TTS 念出来、也不该进字幕。全角/半角括号都处理。
 */
export function cleanNarrationText(text: string): string {
  return text
    .replace(/【[^】]*】/g, '')
    .replace(/（[^）]*）/g, '')
    .replace(/\([^)]*\)/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim()
}

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

/** live 单次请求超时（配音文本可能较长，给足余量） */
const TTS_TIMEOUT_MS = 120_000

/** 默认 Kokoro 运行器：复用 hyperframes.ts 的 runKokoroTts（带超时 + --yes + pin 版本）。 */
function defaultRunKokoro(voice: string): (text: string, outWavAbs: string) => Promise<void> {
  return (text, outWavAbs) => runKokoroTts(text, outWavAbs, voice)
}

/**
 * 文本→语音+字幕。stub：占位静音 wav + 估算字幕（不需 key/网络）。
 * kokoro：spawn 本地 Kokoro（`hyperframes tts`）离线合成中文配音；缺依赖/失败均回落占位并带出原因。
 * live：调 OpenAI 兼容 /audio/speech（response_format=wav）；任何失败都回落占位音轨，
 * 但通过 degraded 带出原因——静默降级会让"live 到底跑通没有"无从判断。
 */
export async function synthesizeVoice(
  ctx: CoreCtx, text: string, outWavAbs: string, deps: TtsDeps = {},
): Promise<VoiceResult> {
  const rel = path.relative(ctx.config.paths.workspace, outWavAbs)
  // 去舞台提示后再念/切句：TTS 不念【节奏标记】（画面指示），字幕也用干净文本
  const clean = cleanNarrationText(text)
  const cues = cuesFrom(splitSentences(clean))
  const writeStub = () => { fs.mkdirSync(path.dirname(outWavAbs), { recursive: true }); fs.writeFileSync(outWavAbs, minimalWav()) }
  const degrade = (reason: string): VoiceResult => { writeStub(); return { audioRel: rel, cues, degraded: reason } }

  if (ctx.config.tts.mode === 'stub') {
    writeStub()
    return { audioRel: rel, cues }
  }

  if (ctx.config.tts.mode === 'kokoro') {
    const run = deps.runKokoro ?? defaultRunKokoro('zf_xiaobei')
    try {
      await run(clean, outWavAbs)
      if (!fs.existsSync(outWavAbs) || fs.statSync(outWavAbs).size === 0) return degrade('Kokoro 未产出音频')
      return { audioRel: rel, cues }
    } catch (err) {
      return degrade(`Kokoro 失败: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // 以下均为 live：缺配置也要说清楚缺什么，不能装作正常
  const fetchImpl = deps.fetchImpl ?? fetch
  if (!ctx.config.tts.apiKey) return degrade('live 模式但未配置 FORGECAST_TTS_KEY')
  if (!ctx.config.tts.model) return degrade('live 模式但未配置 FORGECAST_TTS_MODEL')
  try {
    const res = await fetchImpl(`${ctx.config.tts.baseURL}/audio/speech`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ctx.config.tts.apiKey}` },
      body: JSON.stringify({ model: ctx.config.tts.model, input: clean, voice: 'default', response_format: 'wav' }),
      signal: AbortSignal.timeout(TTS_TIMEOUT_MS),
    })
    if (!res.ok) return degrade(`TTS HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`)
    const bytes = Buffer.from(await res.arrayBuffer())
    // 空响应写进 wav 会变成静默的"成功"，渲染出来没声音也查不出原因
    if (bytes.length === 0) return degrade('TTS 返回空音频')
    fs.mkdirSync(path.dirname(outWavAbs), { recursive: true })
    fs.writeFileSync(outWavAbs, bytes)
    return { audioRel: rel, cues } // 真实时间轴待接 ASR，暂用估算
  } catch (err) {
    return degrade(`TTS 请求失败: ${err instanceof Error ? err.message : String(err)}`)
  }
}
