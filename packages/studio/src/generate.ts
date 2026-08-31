import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { advanceStage, type CoreCtx } from '@forgecast/core'
import { parseCopyOutput } from '@forgecast/copywriter'
import { analyzeBeats, chooseBgmPath, injectAudioCaptions, injectTechFx, fillAccents, fillTemplate, mixAudio, pickBgm, readShots, readTemplate, renderHyperframes, scaffoldHfProject } from './hyperframes'
import type { BeatGrid, Shot } from './hyperframes'
import { lower, type LowerPlan } from './lower'
import { buildSemantic } from './semantic'
import { renderSpecToHtml } from './render-html'
import { synthesizeVoice } from './tts'
import { ASPECT_DIMENSIONS, bucketCuesBySegments, computeSegmentWindows, customTemplateHtmlPath } from './custom-template'
import type { Pacing } from './benchmark'
import { MIN_DURATION, type AudioSpec, type VideoSpec } from './videospec'

export interface GenerateVideoInput {
  slug: string
  assetId?: number
  tpl?: string
  /** 渲染参数覆盖：缺省则用 ctx.config.video.* 的值。server 是长驻进程、ctx 是所有请求共享的单例，
   *  这几个覆盖值只在本次调用内生效（算一份局部 video 配置），绝不 mutate ctx.config.video——
   *  CLI 短进程里直接突变 ctx.config.video 是安全的，但 server 这样做会污染后续请求，是必须绕开的坑。 */
  bgm?: string
  mood?: string
  bg?: string
  captions?: boolean
  /** 画布比例：仅 flash 模板支持横竖屏切换，其余模板固定竖屏不受此参数影响。缺省 portrait。 */
  ratio?: 'portrait' | 'landscape'
  onProgress?: (msg: string) => void
}
export interface GeneratedVideo { assetId: number; filePath: string }
/** 传给 renderAndRegister，渲染后驱动 mixAudio 的参数（与 mixAudio 的 opts 对齐，去掉 deps）。 */
type AudioMix = { bgmPath: string; sfxPath: string | null; strongBeats: number[]; durationSec: number }

/**
 * BGM 选曲 + 节拍分析，全程 fail-soft：
 * - `video.bgm === 'none'`（`--no-bgm`）或曲库为空 → grid=null、audioMix=undefined，调用方完全跳过。
 * - 节拍分析失败（analyzeBeats 返 null）→ 仍加 BGM，但不卡点（strongBeats 空），打 ⚠，
 *   同时把原因 push 进 `warnings`（供最终落 assets.warnings，见 renderAndRegister）。
 */
type VideoCfg = CoreCtx['config']['video']

async function selectBgm(
  ctx: CoreCtx, video: VideoCfg, durationSec: number, onProgress: (m: string) => void, hook: string, warnings: string[] = [],
): Promise<{ grid: BeatGrid | null; audioMix: AudioMix | undefined }> {
  let grid: BeatGrid | null = null
  let audioMix: AudioMix | undefined
  const bgmDir = path.join(ctx.config.paths.templates, 'bgm')
  // 优先级链：--bgm 指定 > --mood > hook 自动映射情绪 > 根回落 > none/空→不加
  const bgmPath = chooseBgmPath(bgmDir, { bgm: video.bgm, mood: video.mood, hook }, Math.random)
  if (bgmPath && video.beatPython && video.mode !== 'stub') {
    grid = await analyzeBeats(bgmPath, video.beatPython)
    if (!grid) {
      onProgress('⚠ 节拍分析失败，加 BGM 但不卡点')
      warnings.push('节拍分析失败，加 BGM 但不卡点')
    }
    const sfxDir = path.join(ctx.config.paths.templates, 'sfx')
    const sfxPath = pickBgm(sfxDir) // 复用：取 sfx 目录第一个（不分情绪）
    audioMix = { bgmPath, sfxPath, strongBeats: grid?.strongBeats ?? [], durationSec }
  }
  return { grid, audioMix }
}

function canvasFor(ratio: 'portrait' | 'landscape'): { width: number; height: number } {
  return ASPECT_DIMENSIONS[ratio]
}

/** 取 copy 素材 → 解析 → 按 tpl 组装参数（flash 三段文字 / story 气泡+TTS配音字幕）→ 写 props.json → 渲染 mp4 → 登记 video 素材 */
export async function generateVideo(ctx: CoreCtx, input: GenerateVideoInput): Promise<GeneratedVideo> {
  const { slug, onProgress = () => {} } = input
  const tpl = input.tpl ?? 'flash'
  // 局部生效的渲染配置：覆盖值缺省则用 ctx.config.video.*，绝不 mutate ctx.config.video 本体（见 GenerateVideoInput 注释）
  const video: VideoCfg = {
    ...ctx.config.video,
    ...(input.bgm !== undefined && { bgm: input.bgm }),
    ...(input.mood !== undefined && { mood: input.mood }),
    ...(input.bg !== undefined && { bg: input.bg }),
    ...(input.captions !== undefined && { captions: input.captions }),
  }
  const project: any = ctx.db.prepare('SELECT * FROM projects WHERE slug = ?').get(slug)
  if (!project) throw new Error(`项目不存在: ${slug}`)

  const copy: any = input.assetId
    ? ctx.db.prepare("SELECT * FROM assets WHERE id = ? AND project_id = ? AND type = 'copy'").get(input.assetId, project.id)
    : ctx.db.prepare("SELECT * FROM assets WHERE project_id = ? AND type = 'copy' ORDER BY id DESC LIMIT 1").get(project.id)
  if (!copy) throw new Error(`没有可用的文案素材（先在素材工坊生成文案）: ${slug}`)

  onProgress('解析文案、组装视频参数…')
  const doc = parseCopyOutput(fs.readFileSync(path.join(ctx.config.paths.workspace, copy.file_path), 'utf8'))
  const brandName = project.brand_name ?? slug
  const ratio = input.ratio ?? 'portrait'

  if (tpl.startsWith('custom-')) {
    const id = Number(tpl.slice('custom-'.length))
    if (!Number.isFinite(id)) throw new Error(`非法自定义模板标识: ${tpl}`)
    const row: any = ctx.db.prepare('SELECT * FROM custom_templates WHERE id = ?').get(id)
    if (!row) throw new Error(`自定义模板不存在: ${tpl}`)
    return renderCustomTemplate(ctx, row, { slug, doc, hook: copy.hook, projectId: project.id, video, onProgress })
  }

  // demo：产品截图轮播。读 shots/，无图报错退出（本模板无图即无意义）——需在通用管线前处理
  if (tpl === 'demo') {
    const shots = readShots(path.join(ctx.config.paths.workspace, slug, 'shots'))
    if (!shots.length) throw new Error(`demo 模板需要产品截图，请放入 workspace/${slug}/shots/（png/jpg/webp）`)
    const shotAssets: Record<string, Buffer> = {}
    for (const sh of shots) shotAssets[sh.rel] = fs.readFileSync(path.join(ctx.config.paths.workspace, slug, 'shots', sh.rel))
    return renderHfPipeline(ctx, {
      slug, tpl: 'demo', doc, hook: copy.hook, brandName, projectId: project.id, video, ratio, onProgress, shots, shotAssets,
    })
  }

  if (tpl === 'changelog' || tpl === 'insight' || tpl === 'story') {
    return renderHfPipeline(ctx, { slug, tpl, doc, hook: copy.hook, brandName, projectId: project.id, video, ratio, onProgress })
  }

  // 兜底：未知 tpl 与 tpl==='flash' 一样都走 flash（原版行为，见下方分支硬编码 'flash'）
  return renderHfPipeline(ctx, { slug, tpl: 'flash', doc, hook: copy.hook, brandName, projectId: project.id, video, ratio, onProgress })
}

/**
 * 统一管线：buildSemantic → lower → renderSpecToHtml → fillTemplate/inject* → scaffold → render。
 * 覆盖 flash/story/demo/changelog/insight 五个 HyperFrames 模板（custom-* 走独立的 renderCustomTemplate，
 * 它的 HTML 由 LLM/固定模板产出、按分段占位符填充，不是 Layer 模型，见该函数注释）。
 */
async function renderHfPipeline(
  ctx: CoreCtx,
  opts: {
    slug: string
    tpl: 'flash' | 'story' | 'demo' | 'changelog' | 'insight'
    doc: ReturnType<typeof parseCopyOutput>
    hook: string | null
    brandName: string
    projectId: number
    video: VideoCfg
    ratio: 'portrait' | 'landscape'
    onProgress: (m: string) => void
    shots?: Shot[]
    shotAssets?: Record<string, Buffer>
  },
): Promise<GeneratedVideo> {
  const { slug, tpl, doc, hook, brandName, projectId, video, ratio, onProgress, shots = [], shotAssets } = opts
  const videoId = randomUUID()
  const hfDir = path.join(ctx.config.paths.workspace, slug, 'hf', videoId)

  onProgress('TTS 配音…')
  const wavAbs = path.join(hfDir, 'assets', 'narration.wav')
  const voice = await synthesizeVoice(ctx, doc.douyinScript, wavAbs)
  const warnings: string[] = []
  if (voice.degraded) {
    onProgress(`⚠ TTS 降级：${voice.degraded}`)
    warnings.push(`TTS 降级：${voice.degraded}`)
  }
  const lastEnd = voice.cues.length ? voice.cues[voice.cues.length - 1].end : 0
  const duration = Math.max(MIN_DURATION[tpl], Math.ceil(lastEnd))

  // BGM / 卡点方案解析：demo 支持 cutplan.json 钉曲，其余模板都走自动选曲（fail-soft）
  let grid: BeatGrid | null = null
  let audioMix: AudioMix | undefined
  let plan: LowerPlan | null = null
  if (tpl === 'demo') {
    const planPath = path.join(ctx.config.paths.workspace, slug, 'cutplan.json')
    let cutPlan: any = null
    if (fs.existsSync(planPath)) { try { cutPlan = JSON.parse(fs.readFileSync(planPath, 'utf8')) } catch { cutPlan = null } }
    if (cutPlan?.bgm && cutPlan?.grid && typeof cutPlan.grid.T === 'number' && typeof cutPlan.grid.t0 === 'number'
      && fs.existsSync(path.join(ctx.config.paths.templates, 'bgm', cutPlan.bgm))) {
      grid = cutPlan.grid
      plan = { grid: { t0: cutPlan.grid.t0, T: cutPlan.grid.T }, offsetSec: cutPlan.offsetSec ?? 0, cuts: cutPlan.cuts }
      if (video.mode !== 'stub') {
        const bgmAbs = path.join(ctx.config.paths.templates, 'bgm', cutPlan.bgm)
        const sfxPath = pickBgm(path.join(ctx.config.paths.templates, 'sfx'))
        audioMix = { bgmPath: bgmAbs, sfxPath, strongBeats: cutPlan.grid.strongBeats ?? [], durationSec: duration }
      }
    } else {
      if (cutPlan?.bgm) {
        onProgress('⚠ 卡点方案曲子不存在，改用自动卡点')
        warnings.push('卡点方案曲子不存在，改用自动卡点')
      }
      const sel = await selectBgm(ctx, video, duration, onProgress, hook ?? '', warnings)
      grid = sel.grid; audioMix = sel.audioMix
    }
  } else {
    const sel = await selectBgm(ctx, video, duration, onProgress, hook ?? '', warnings)
    grid = sel.grid; audioMix = sel.audioMix
  }

  const canvas = canvasFor(ratio)
  const audioSpec: AudioSpec = {
    narration: voice.audioRel ? { src: voice.audioRel, degraded: voice.degraded ?? null } : null,
    bgm: audioMix ? { src: audioMix.bgmPath, mood: video.mood || null } : null,
    beatGrid: grid ? { t0: grid.t0, T: grid.T, bpm: grid.bpm, strongBeats: grid.strongBeats } : null,
    captionsEnabled: video.captions,
  }

  const semantic = buildSemantic(doc, tpl, { cues: voice.cues, brandName })
  const spec = lower(semantic, {
    videoId, slug, template: tpl, canvas, durationSec: duration, cues: voice.cues,
    beatGrid: grid, shots, plan, audio: audioSpec, brandName,
  })
  spec.warnings = warnings

  const rendered = renderSpecToHtml(spec)
  const ratioSuffix = ratio === 'landscape' ? '-landscape' : ''
  let html = fillTemplate(readTemplate(`${tpl}${ratioSuffix}`), { duration: String(duration) })
  html = html.replace('<!--HF_SECTIONS-->', () => rendered.html)
  // story 特判：不加科技背景（保聊天真截图感）；其余四个模板都套 techFx
  html = injectTechFx(html, tpl === 'story' ? { durationSec: duration } : { bg: video.bg, durationSec: duration })
  // 字幕已由 lower() 按 audio.captionsEnabled 生成进 spec.layers（随 rendered.html 一并注入），
  // 这里只负责音轨标记；captions 固定传 false，避免 HF_CAPTIONS 标记被重复注入一份字幕。
  html = injectAudioCaptions(html, voice.audioRel, voice.cues, duration, false)
  html = fillAccents(html, rendered.accents)
  scaffoldHfProject(hfDir, html, shotAssets)
  return renderAndRegister(ctx, hfDir, slug, tpl, hook, projectId, onProgress, spec, audioMix)
}

/**
 * 渲染 hf 项目并登记 video 素材（各 HyperFrames 分支收尾共用）。
 * `audioMix` 可选：渲染后调 mixAudio 把 BGM/SFX 混进成片，失败 fail-soft（保留无背景乐版本，打 ⚠，
 * 原因同时 push 进 `spec.warnings`）。
 * stub 模式下即便传了 audioMix 也不真跑 mixAudio（不 spawn ffmpeg）。
 * 收尾统一把 `spec` 落盘到 `workspace/<slug>/specs/<videoId>.json`，并把 spec_path/warnings 写入 assets 行。
 */
async function renderAndRegister(
  ctx: CoreCtx, hfDir: string, slug: string, tpl: string, hook: string | null,
  projectId: number, onProgress: (m: string) => void, spec: VideoSpec, audioMix?: AudioMix,
): Promise<GeneratedVideo> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const relPath = path.join(slug, 'videos', `${tpl}-${hook ?? tpl}-${stamp}-${spec.videoId.slice(0, 6)}.mp4`)
  const outAbs = path.join(ctx.config.paths.workspace, relPath)
  onProgress(`渲染视频（HyperFrames，${ctx.config.video.mode}）…`)
  await renderHyperframes(hfDir, outAbs, ctx.config.video.mode === 'stub' ? 'stub' : 'render', { onProgress })
  if (audioMix && ctx.config.video.mode !== 'stub') {
    try {
      onProgress('混入 BGM/音效…')
      await mixAudio(outAbs, audioMix)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      onProgress(`⚠ BGM 混音失败，保留无背景乐版本：${msg}`)
      spec.warnings.push(`BGM 混音失败，保留无背景乐版本：${msg}`)
    }
  }
  const specRelPath = path.join(slug, 'specs', `${spec.videoId}.json`)
  const specAbsPath = path.join(ctx.config.paths.workspace, specRelPath)
  fs.mkdirSync(path.dirname(specAbsPath), { recursive: true })
  fs.writeFileSync(specAbsPath, JSON.stringify(spec, null, 2), 'utf8')
  const info = ctx.db.prepare(
    'INSERT INTO assets (project_id, type, hook, file_path, warnings, spec_path) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(projectId, 'video', hook, relPath, JSON.stringify(spec.warnings), specRelPath)
  advanceStage(ctx.db, projectId, 'producing')
  onProgress(`视频完成: ${relPath}`)
  return { assetId: Number(info.lastInsertRowid), filePath: relPath }
}

/**
 * 自定义模板渲染：TTS→BGM 流程与统一管线一致，差异只在按拆解节奏比例填 N 个动态分段占位符——
 * 模板 HTML 由 LLM/固定 fixture 产出（见 props.ts generateCustomTemplate），不经过 buildSemantic/
 * lower/renderSpecToHtml 那套 Layer 模型，故这里独立落一份「空 layers」的 VideoSpec，
 * 只为满足 renderAndRegister 统一的 spec 落盘/spec_path/warnings 落库契约。
 */
async function renderCustomTemplate(
  ctx: CoreCtx, row: any,
  opts: { slug: string; doc: ReturnType<typeof parseCopyOutput>; hook: string; projectId: number; video: VideoCfg; onProgress: (m: string) => void },
): Promise<GeneratedVideo> {
  const { slug, doc, hook, projectId, video, onProgress } = opts
  const videoId = randomUUID()
  const hfDir = path.join(ctx.config.paths.workspace, slug, 'hf', videoId)
  onProgress('TTS 配音…')
  const wavAbs = path.join(hfDir, 'assets', 'narration.wav')
  const voice = await synthesizeVoice(ctx, doc.douyinScript, wavAbs)
  const warnings: string[] = []
  if (voice.degraded) {
    onProgress(`⚠ TTS 降级：${voice.degraded}`)
    warnings.push(`TTS 降级：${voice.degraded}`)
  }
  const lastEnd = voice.cues.length ? voice.cues[voice.cues.length - 1].end : 0
  const duration = Math.max(MIN_DURATION.custom, Math.ceil(lastEnd))
  const { grid, audioMix } = await selectBgm(ctx, video, duration, onProgress, hook, warnings)

  const pacing: Pacing = JSON.parse(row.segments_json)
  const windows = computeSegmentWindows(pacing.segments, pacing.durationSec, duration)
  const texts = bucketCuesBySegments(voice.cues, windows)
  const rawHtml = fs.readFileSync(customTemplateHtmlPath(ctx, row.id), 'utf8')
  const slots: Record<string, string> = { duration: String(duration) }
  windows.forEach((w, i) => {
    slots[`seg${i}_start`] = String(w.start)
    slots[`seg${i}_dur`] = String(Math.max(0.5, w.end - w.start))
    slots[`seg${i}_text`] = texts[i] ?? ''
  })
  let html = fillTemplate(rawHtml, slots)
  html = injectAudioCaptions(html, voice.audioRel, voice.cues, duration, video.captions)
  scaffoldHfProject(hfDir, html)

  const canvas: { width: number; height: number } = row.aspect_ratio === 'landscape'
    ? ASPECT_DIMENSIONS.landscape
    : ASPECT_DIMENSIONS.portrait
  const spec: VideoSpec = {
    version: 1,
    videoId,
    slug,
    template: `custom-${row.id}`,
    createdAt: new Date().toISOString(),
    semantic: { hook: null, sourceAssetId: null, sections: [] },
    canvas,
    durationSec: duration,
    layers: [],
    audio: {
      narration: voice.audioRel ? { src: voice.audioRel, degraded: voice.degraded ?? null } : null,
      bgm: audioMix ? { src: audioMix.bgmPath, mood: video.mood || null } : null,
      beatGrid: grid ? { t0: grid.t0, T: grid.T, bpm: grid.bpm, strongBeats: grid.strongBeats } : null,
      captionsEnabled: video.captions,
    },
    warnings,
  }
  return renderAndRegister(ctx, hfDir, slug, `custom-${row.id}`, hook, projectId, onProgress, spec, audioMix)
}
