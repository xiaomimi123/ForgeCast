import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnWithTimeout } from './hyperframes'

export interface AlignedCue { start: number; end: number }
export interface AsrDeps { run?: (args: string[]) => Promise<void> }

// 脚本相对本文件：packages/studio/src → packages/studio/scripts
const ASR_SCRIPT = fileURLToPath(new URL('../scripts/asr_align.py', import.meta.url))
const ASR_TIMEOUT_MS = 180_000

/**
 * 用本地 faster-whisper 转写 TTS 合成出的音频、跟原文句子做字符级对齐，拿真实起止时间。
 * 只用 ASR 的时间信息，识别出的文字本身丢弃不用——调用方展示的字幕内容始终是传入的 sentences。
 * asrPython 为空、sentences 为空、脚本超时/崩溃/输出非法、返回句子数对不上，均返回 null——
 * 调用方据此回落现有的按字数估算逻辑，这里绝不抛错。
 */
export async function alignCues(
  wavAbs: string, sentences: string[], asrPython: string, deps: AsrDeps = {},
): Promise<AlignedCue[] | null> {
  if (!asrPython || sentences.length === 0) return null
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-asr-'))
  const sentencesPath = path.join(dir, 'sentences.json')
  const outPath = path.join(dir, 'out.json')
  try {
    fs.writeFileSync(sentencesPath, JSON.stringify(sentences))
    const run = deps.run ?? ((args: string[]) => spawnWithTimeout(args, { cmd: asrPython, timeoutMs: ASR_TIMEOUT_MS, label: 'asr_align' }))
    await run([ASR_SCRIPT, wavAbs, sentencesPath, outPath])
    const result = JSON.parse(fs.readFileSync(outPath, 'utf8'))
    if (!result.ok || !Array.isArray(result.cues) || result.cues.length !== sentences.length) return null
    return result.cues
  } catch {
    return null
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}
