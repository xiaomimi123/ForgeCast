import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { spawnWithTimeout } from './hyperframes'

const pExecFile = promisify(execFile)
const TRANSCRIBE_SCRIPT = fileURLToPath(new URL('../scripts/asr_transcribe.py', import.meta.url))
const FFMPEG_TIMEOUT_MS = 180_000
const TRANSCRIBE_TIMEOUT_MS = 300_000

export interface TranscribeResult { text: string; segments: Array<{ start: number; end: number; text: string }> }
/** 外部进程注入点（测试替身用）：ffmpeg 抽音轨 / python 转写 / ffprobe 时长 */
export interface ReviewDeps {
  runFfmpeg?: (args: string[]) => Promise<void>
  runTranscribe?: (args: string[]) => Promise<void>
  probe?: (mp4Abs: string) => Promise<number | null>
}

/** ffprobe 读时长（秒）；ffprobe 缺失/文件坏/解析失败一律返 null（fail-soft，绝不抛错） */
export async function probeDuration(mp4Abs: string): Promise<number | null> {
  try {
    const { stdout } = await pExecFile('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', mp4Abs])
    const v = Number(stdout.trim())
    return Number.isFinite(v) && v > 0 ? v : null
  } catch {
    return null
  }
}

/** 抽音轨为 16k 单声道 wav（faster-whisper 输入）；超时 kill（spawnWithTimeout），失败抛错由调用方兜 */
export async function extractAudioWav(mp4Abs: string, wavAbs: string, deps: ReviewDeps = {}): Promise<void> {
  const run = deps.runFfmpeg ?? ((args: string[]) => spawnWithTimeout(args, { cmd: 'ffmpeg', timeoutMs: FFMPEG_TIMEOUT_MS, label: 'ffmpeg extract-audio' }))
  await run(['-y', '-i', mp4Abs, '-vn', '-ar', '16000', '-ac', '1', wavAbs])
}

/**
 * 本地 faster-whisper 全文转写。asrPython 为空、脚本超时/崩溃/输出非法均返 null——
 * 调用方据此降级为"未转写仅结构审"，这里绝不抛错（同 alignCues 的 fail-soft 风格）。
 */
export async function transcribeAudio(wavAbs: string, asrPython: string, deps: ReviewDeps = {}): Promise<TranscribeResult | null> {
  if (!asrPython) return null
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-trans-'))
  const outPath = path.join(dir, 'out.json')
  try {
    const run = deps.runTranscribe ?? ((args: string[]) => spawnWithTimeout(args, { cmd: asrPython, timeoutMs: TRANSCRIBE_TIMEOUT_MS, label: 'asr_transcribe' }))
    await run([TRANSCRIBE_SCRIPT, wavAbs, outPath])
    const result = JSON.parse(fs.readFileSync(outPath, 'utf8'))
    if (!result.ok || typeof result.text !== 'string' || !Array.isArray(result.segments)) return null
    return { text: result.text, segments: result.segments }
  } catch {
    return null
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}
