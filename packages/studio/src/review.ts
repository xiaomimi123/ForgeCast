import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import type { CoreCtx } from '@forgecast/core'
import { parseCopyOutput } from '@forgecast/copywriter'
import { mockReviewReport, type ReviewDraft, type ReviewScores } from './fixtures/review-fixture'
import { spawnWithTimeout } from './hyperframes'

export type { ReviewDraft, ReviewScores } from './fixtures/review-fixture'

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

export interface ReviewReport {
  scores: ReviewScores
  suggestions: string[]
  transcript?: string
  metrics: { durationSec: number | null; charCount: number; charsPerSec: number | null }
  scriptAssetId?: number
  degraded?: string
  reviewedAt: string
}

function stripFence(raw: string): string {
  return raw.trim().replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/```\s*$/, '').trim()
}

function parseReviewJson(raw: string): ReviewDraft {
  const v = JSON.parse(stripFence(raw))
  const s = v?.scores
  const scoresOk = s && (['hook', 'pacing', 'fidelity', 'cta', 'overall'] as const)
    .every((k) => typeof s[k] === 'number' && s[k] >= 0 && s[k] <= 100)
  if (!scoresOk || !Array.isArray(v.suggestions) || !v.suggestions.length) {
    throw new Error(`审片输出非法（需 scores 五项 0-100 + suggestions 非空）: ${raw.slice(0, 120)}`)
  }
  return { scores: s, suggestions: v.suggestions.map(String) }
}

/**
 * 审片主流程：时长探测→抽音轨→转写（三步全 fail-soft，失败降级 degraded）→结构指标→
 * LLM 对照基准评分（mock 走 fixture；输出校验失败整体抛错不写 review）→覆盖写 assets.review。
 * 对照基准回落链：scriptAssetId 指定 → 项目最新 script → 最新 copy 口播稿 → 无基准通用审。
 */
export async function reviewVideo(
  ctx: CoreCtx, videoAssetId: number,
  opts: { scriptAssetId?: number; onProgress?: (msg: string) => void; deps?: ReviewDeps } = {},
): Promise<ReviewReport> {
  const { onProgress = () => {}, deps = {} } = opts
  const asset: any = ctx.db.prepare("SELECT * FROM assets WHERE id = ? AND type = 'video'").get(videoAssetId)
  if (!asset) throw new Error(`视频素材不存在: #${videoAssetId}`)
  const mp4Abs = path.join(ctx.config.paths.workspace, asset.file_path)
  if (!fs.existsSync(mp4Abs)) throw new Error(`视频文件不存在: ${asset.file_path}`)

  onProgress('读取时长…')
  const durationSec = deps.probe ? await deps.probe(mp4Abs) : await probeDuration(mp4Abs)

  let baseline = ''
  let scriptAssetId: number | undefined
  if (opts.scriptAssetId !== undefined) {
    const s: any = ctx.db.prepare("SELECT * FROM assets WHERE id = ? AND type = 'script'").get(opts.scriptAssetId)
    if (!s) throw new Error(`拍摄脚本不存在: #${opts.scriptAssetId}`)
    baseline = fs.readFileSync(path.join(ctx.config.paths.workspace, s.file_path), 'utf8')
    scriptAssetId = s.id
  } else {
    const s: any = ctx.db.prepare("SELECT * FROM assets WHERE project_id = ? AND type = 'script' ORDER BY id DESC LIMIT 1").get(asset.project_id)
    if (s) {
      baseline = fs.readFileSync(path.join(ctx.config.paths.workspace, s.file_path), 'utf8')
      scriptAssetId = s.id
    } else {
      const cp: any = ctx.db.prepare("SELECT * FROM assets WHERE project_id = ? AND type = 'copy' ORDER BY id DESC LIMIT 1").get(asset.project_id)
      if (cp) {
        try { baseline = parseCopyOutput(fs.readFileSync(path.join(ctx.config.paths.workspace, cp.file_path), 'utf8')).douyinScript } catch { baseline = '' }
      }
    }
  }

  let transcript: TranscribeResult | null = null
  let degraded: string | undefined
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-review-'))
  try {
    onProgress('抽取音轨…')
    const wavAbs = path.join(tmp, 'audio.wav')
    try {
      await extractAudioWav(mp4Abs, wavAbs, deps)
      onProgress('转写台词…')
      transcript = await transcribeAudio(wavAbs, ctx.config.tts.asrPython, deps)
    } catch {
      transcript = null // 抽音轨失败也走降级（如无音轨/文件损坏）
    }
    if (!transcript) degraded = '未转写（ASR 未配置或音轨处理失败），仅按时长与脚本给结构建议'
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }

  const charCount = transcript?.text.length ?? 0
  const metrics = {
    durationSec, charCount,
    charsPerSec: transcript && durationSec ? +(charCount / durationSec).toFixed(2) : null,
  }

  onProgress('审片评分…')
  let draft: ReviewDraft
  if (ctx.config.llm.mode === 'mock') {
    draft = mockReviewReport()
  } else {
    const tpl = fs.readFileSync(path.join(ctx.config.paths.templates, 'prompts', 'video-review.md'), 'utf8')
    const system = '你是短视频内容教练，只输出给定 JSON 结构，不要多余文字。'
    const first3s = transcript ? transcript.segments.filter((s) => s.start < 3).map((s) => s.text).join('') : ''
    const prompt = [
      tpl,
      `【结构指标】时长 ${durationSec ?? '未知'} 秒；转写字数 ${charCount}；语速 ${metrics.charsPerSec ?? '未知'} 字/秒；前3秒台词：${first3s || '（无转写）'}`,
      baseline ? `【拍摄脚本基准】\n${baseline}` : '【拍摄脚本基准】（无——按通用短视频结构审）',
      transcript ? `【成片转写】\n${transcript.text}` : '【成片转写】（未转写）',
    ].join('\n\n---\n\n')
    draft = parseReviewJson(await ctx.llm.complete({ model: ctx.config.llm.models.copy, system, prompt }))
  }

  const report: ReviewReport = {
    scores: draft.scores,
    suggestions: draft.suggestions,
    ...(transcript && { transcript: transcript.text }),
    metrics,
    ...(scriptAssetId !== undefined && { scriptAssetId }),
    ...(degraded && { degraded }),
    reviewedAt: new Date().toISOString(),
  }
  ctx.db.prepare('UPDATE assets SET review = ? WHERE id = ?').run(JSON.stringify(report), videoAssetId)
  onProgress(`审片完成：总分 ${report.scores.overall}`)
  return report
}
