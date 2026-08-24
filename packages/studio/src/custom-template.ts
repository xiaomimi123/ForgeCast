import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { CoreCtx } from '@forgecast/core'
import { analyzeBenchmark, type Pacing, type PacingSegment } from './benchmark'
import { mockCustomTemplateHtml } from './fixtures/custom-template-fixture'
import { fillTemplate, HF_VERSION, scaffoldHfProject, spawnWithTimeout } from './hyperframes'
import type { Cue } from './tts'

export type AspectRatio = 'portrait' | 'landscape'
export const ASPECT_DIMENSIONS: Record<AspectRatio, { width: number; height: number }> = {
  portrait: { width: 1080, height: 1920 },
  landscape: { width: 1920, height: 1080 },
}

export interface CustomTemplateInput { pacing: Pacing; aspectRatio: AspectRatio; styleNote?: string }
export interface CustomTemplateResult { html: string; segmentCount: number }
export interface CustomTemplateDeps { checkComposition?: (dir: string) => Promise<boolean> }

const CHECK_TIMEOUT_MS = 120_000
const MAX_ATTEMPTS = 2

/** 校验产出 HTML 满足占位符契约；返回缺失项描述数组，空数组=合法。 */
export function validateCustomTemplateHtml(html: string, segmentCount: number, width: number, height: number): string[] {
  const errors: string[] = []
  const count = (re: RegExp) => (html.match(re) ?? []).length
  if (count(/\{\{duration\}\}/g) < 1) errors.push('缺少 {{duration}} 占位符')
  if (count(/<!--HF_AUDIO-->/g) !== 1) errors.push('<!--HF_AUDIO--> 标记必须恰好出现一次')
  if (count(/<!--HF_CAPTIONS-->/g) !== 1) errors.push('<!--HF_CAPTIONS--> 标记必须恰好出现一次')
  if (!html.includes(`data-width="${width}"`)) errors.push(`缺少 data-width="${width}"`)
  if (!html.includes(`data-height="${height}"`)) errors.push(`缺少 data-height="${height}"`)
  for (let k = 0; k < segmentCount; k++) {
    if (count(new RegExp(`\\{\\{seg${k}_start\\}\\}`, 'g')) < 1) errors.push(`缺少 {{seg${k}_start}} 占位符`)
    if (count(new RegExp(`\\{\\{seg${k}_dur\\}\\}`, 'g')) < 1) errors.push(`缺少 {{seg${k}_dur}} 占位符`)
    if (count(new RegExp(`\\{\\{seg${k}_text\\}\\}`, 'g')) < 1) errors.push(`缺少 {{seg${k}_text}} 占位符`)
  }
  return errors
}

function fillSampleValues(html: string, segmentCount: number): string {
  const sampleDuration = Math.max(6, segmentCount * 3)
  const each = sampleDuration / segmentCount
  const slots: Record<string, string> = { duration: String(sampleDuration) }
  for (let k = 0; k < segmentCount; k++) {
    slots[`seg${k}_start`] = String(k * each)
    slots[`seg${k}_dur`] = String(each)
    slots[`seg${k}_text`] = '示例文字'
  }
  return fillTemplate(html, slots)
}

async function defaultCheckComposition(dir: string): Promise<boolean> {
  try {
    await spawnWithTimeout(['--yes', `hyperframes@${HF_VERSION}`, 'check', '.', '--json'], { cwd: dir, timeoutMs: CHECK_TIMEOUT_MS, label: 'hyperframes check' })
    return true
  } catch {
    return false
  }
}

function buildPrompt(pacing: Pacing, aspectRatio: AspectRatio, styleNote: string | undefined, priorErrors?: string[]): string {
  const { width, height } = ASPECT_DIMENSIONS[aspectRatio]
  const segCount = pacing.segments.length
  const ratios = pacing.segments.map((s) => (((s.end - s.start) / pacing.durationSec) * 100).toFixed(1))
  const lines = [
    `分段数：${segCount}`,
    `各段时长占比（%，从第0段到第${segCount - 1}段）：${ratios.join(', ')}`,
    `画布尺寸：${width}x${height}（${aspectRatio === 'portrait' ? '竖屏' : '横屏'}）`,
    styleNote ? `风格/调性参考：${styleNote}` : '风格/调性：未提供，自由发挥',
  ]
  if (priorErrors?.length) {
    lines.push(`上一次产出未通过校验，请修正以下问题后重新输出完整 HTML：\n${priorErrors.map((e) => `- ${e}`).join('\n')}`)
  }
  return lines.join('\n')
}

/**
 * 拆解节奏 + 风格描述 → LLM 设计一个新 HyperFrames 模板（mock 走固定 fixture，绝不调 ctx.llm）。
 * 校验两道：①占位符契约 regex ②hyperframes check 结构合法性（仅 live 模式跑，mock fixture 信任合法）。
 * 任一不过重试一次，仍不过抛错不落库。
 */
export async function generateCustomTemplate(
  ctx: CoreCtx, input: CustomTemplateInput, deps: CustomTemplateDeps = {},
): Promise<CustomTemplateResult> {
  const { pacing, aspectRatio, styleNote } = input
  const segmentCount = pacing.segments.length
  const { width, height } = ASPECT_DIMENSIONS[aspectRatio]
  const isMock = ctx.config.llm.mode === 'mock'
  const checkComposition = deps.checkComposition ?? defaultCheckComposition
  const systemPrompt = isMock ? '' : fs.readFileSync(path.join(ctx.config.paths.templates, 'prompts', 'custom-template.md'), 'utf8')

  let priorErrors: string[] | undefined
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const html = isMock
      ? mockCustomTemplateHtml(segmentCount, width, height)
      : await ctx.llm.complete({ model: ctx.config.llm.models.copy, system: systemPrompt, prompt: buildPrompt(pacing, aspectRatio, styleNote, priorErrors) })

    const tokenErrors = validateCustomTemplateHtml(html, segmentCount, width, height)
    if (tokenErrors.length) {
      if (attempt < MAX_ATTEMPTS) { priorErrors = tokenErrors; continue }
      throw new Error(`自定义模板校验失败（占位符契约）：${tokenErrors.join('；')}`)
    }

    if (!isMock) {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-custom-tpl-check-'))
      scaffoldHfProject(tmpDir, fillSampleValues(html, segmentCount))
      const ok = await checkComposition(tmpDir)
      if (!ok) {
        if (attempt < MAX_ATTEMPTS) { priorErrors = ['hyperframes check 未通过（结构不合法，请简化 CSS/避免超出画布）']; continue }
        throw new Error('自定义模板校验失败（hyperframes check 未通过）')
      }
    }
    return { html, segmentCount }
  }
  throw new Error('自定义模板生成失败')
}

/** 自定义模板 HTML 落盘路径（全局共享，不挂项目）：templates/hf/custom/<id>.html */
export function customTemplateHtmlPath(ctx: CoreCtx, id: number): string {
  return path.join(ctx.config.paths.templates, 'hf', 'custom', `${id}.html`)
}

/**
 * 把拆解出的相对节奏（相对对标视频时长的比例）映射到目标（实际配音）时长的绝对秒数窗口。
 * 末段强制对齐 targetDurationSec，消除浮点误差导致的尾部空隙。
 */
export function computeSegmentWindows(segments: PacingSegment[], benchmarkDurationSec: number, targetDurationSec: number): { start: number; end: number }[] {
  if (benchmarkDurationSec <= 0) throw new Error('benchmarkDurationSec 必须大于 0')
  const scale = targetDurationSec / benchmarkDurationSec
  const windows = segments.map((s) => ({ start: s.start * scale, end: s.end * scale }))
  windows[windows.length - 1].end = targetDurationSec
  return windows
}

/** 把 TTS cue 按时间窗口分桶拼成每段的文字；窗口没分到 cue 时回退用邻近 cue（按索引夹取），不留空串。 */
export function bucketCuesBySegments(cues: Cue[], windows: { start: number; end: number }[]): string[] {
  const buckets: string[][] = windows.map(() => [])
  for (const c of cues) {
    const mid = (c.start + c.end) / 2
    let idx = windows.findIndex((w) => mid >= w.start && mid < w.end)
    if (idx === -1) idx = windows.length - 1
    buckets[idx].push(c.text)
  }
  return buckets.map((texts, i) => (texts.length ? texts.join('') : (cues[Math.min(i, cues.length - 1)]?.text ?? '')))
}

export interface CreateCustomTemplateInput {
  name: string; aspectRatio: AspectRatio; styleNote?: string
  benchmarkAbsPath: string; benchmarkRelPath: string
  onProgress?: (msg: string) => void
}
export interface CreateCustomTemplateResult { id: number; name: string }

/** 拆解 → LLM 设计 → 落库 + 写模板文件。失败（拆解本身 fail-soft 不会失败；LLM 校验失败会）直接抛错，不落库。 */
export async function createCustomTemplate(ctx: CoreCtx, input: CreateCustomTemplateInput): Promise<CreateCustomTemplateResult> {
  const { name, aspectRatio, styleNote, benchmarkAbsPath, benchmarkRelPath, onProgress = () => {} } = input
  onProgress('拆解对标视频节奏…')
  const pacing = await analyzeBenchmark(benchmarkAbsPath)
  onProgress(`拆解出 ${pacing.segments.length} 段，设计模板中…`)
  const { html, segmentCount } = await generateCustomTemplate(ctx, { pacing, aspectRatio, styleNote })
  const info = ctx.db.prepare(
    'INSERT INTO custom_templates (name, aspect_ratio, segment_count, style_note, benchmark_path, segments_json) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(name, aspectRatio, segmentCount, styleNote ?? null, benchmarkRelPath, JSON.stringify(pacing))
  const id = Number(info.lastInsertRowid)
  const htmlPath = customTemplateHtmlPath(ctx, id)
  fs.mkdirSync(path.dirname(htmlPath), { recursive: true })
  fs.writeFileSync(htmlPath, html, 'utf8')
  onProgress(`模板「${name}」已生成`)
  return { id, name }
}
