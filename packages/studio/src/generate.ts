import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { advanceStage, type CoreCtx } from '@forgecast/core'
import { parseCopyOutput } from '@forgecast/copywriter'
import { analyzeBeats, buildDemoSections, buildFlashSections, buildInsightSections, buildStorySections, chooseBgmPath, gridBeats, injectAudioCaptions, injectTechFx, fillAccents, fillTemplate, mixAudio, pickBgm, planCutTimes, readShots, readTemplate, renderHyperframes, scaffoldHfProject } from './hyperframes'
import type { BeatGrid } from './hyperframes'
import { buildChangelogProps, buildDemoSlots, buildFlashSlots, buildInsightSlots, buildStorySlots } from './props'
import { synthesizeVoice } from './tts'
import { bucketCuesBySegments, computeSegmentWindows, customTemplateHtmlPath } from './custom-template'
import type { Pacing } from './benchmark'

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
 * - 节拍分析失败（analyzeBeats 返 null）→ 仍加 BGM，但不卡点（strongBeats 空），打 ⚠。
 */
type VideoCfg = CoreCtx['config']['video']

async function selectBgm(ctx: CoreCtx, video: VideoCfg, durationSec: number, onProgress: (m: string) => void, hook: string): Promise<{ grid: BeatGrid | null; audioMix: AudioMix | undefined }> {
  let grid: BeatGrid | null = null
  let audioMix: AudioMix | undefined
  const bgmDir = path.join(ctx.config.paths.templates, 'bgm')
  // 优先级链：--bgm 指定 > --mood > hook 自动映射情绪 > 根回落 > none/空→不加
  const bgmPath = chooseBgmPath(bgmDir, { bgm: video.bgm, mood: video.mood, hook }, Math.random)
  if (bgmPath && video.beatPython && video.mode !== 'stub') {
    grid = await analyzeBeats(bgmPath, video.beatPython)
    if (!grid) onProgress('⚠ 节拍分析失败，加 BGM 但不卡点')
    const sfxDir = path.join(ctx.config.paths.templates, 'sfx')
    const sfxPath = pickBgm(sfxDir) // 复用：取 sfx 目录第一个（不分情绪）
    audioMix = { bgmPath, sfxPath, strongBeats: grid?.strongBeats ?? [], durationSec }
  }
  return { grid, audioMix }
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

  if (tpl.startsWith('custom-')) {
    const id = Number(tpl.slice('custom-'.length))
    if (!Number.isFinite(id)) throw new Error(`非法自定义模板标识: ${tpl}`)
    const row: any = ctx.db.prepare('SELECT * FROM custom_templates WHERE id = ?').get(id)
    if (!row) throw new Error(`自定义模板不存在: ${tpl}`)
    return renderCustomTemplate(ctx, row, { slug, doc, hook: copy.hook, projectId: project.id, video, onProgress })
  }

  // changelog：独立走 HyperFrames 路径，不碰下方 flash/story/demo 的旧 Remotion 逻辑（后续任务再迁移）
  if (tpl === 'changelog') {
    const slots = buildChangelogProps(doc, brandName)
    const hfDir = path.join(ctx.config.paths.workspace, slug, 'hf')
    // 配音
    onProgress('TTS 配音…')
    const wavAbs = path.join(hfDir, 'assets', 'narration.wav')
    const voice = await synthesizeVoice(ctx, doc.douyinScript, wavAbs)
    if (voice.degraded) onProgress(`⚠ TTS 降级：${voice.degraded}`)
    // 自适应时长：跟旁白末尾对齐（下限 12s），s2 吸收标题段之后的剩余
    const lastEnd = voice.cues.length ? voice.cues[voice.cues.length - 1].end : 0
    const duration = Math.max(12, Math.ceil(lastEnd))
    // BGM：选曲→分析节拍（fail-soft）。段边界写死在模板、不吸附；静态文字场不加脉冲，只混音
    const { audioMix } = await selectBgm(ctx, video, duration, onProgress, copy.hook)
    // 先 fillTemplate 填转义 slot，再注入音轨/字幕（注释标记，不被 {{}} 正则误吃）
    const filled = fillTemplate(readTemplate('changelog'), { ...slots, duration: String(duration), s2dur: String(duration - 6) })
    let html = injectTechFx(filled, { bg: video.bg, durationSec: duration })
    html = injectAudioCaptions(html, voice.audioRel, voice.cues, duration, video.captions)
    html = fillAccents(html, '')
    scaffoldHfProject(hfDir, html)
    return renderAndRegister(ctx, hfDir, slug, 'changelog', copy.hook, project.id, onProgress, audioMix)
  }

  // insight：数据卡片解说（HyperFrames）。卡片直接从 TTS cue 文本挖数字，时机跟着旁白逐句走
  if (tpl === 'insight') {
    const s = buildInsightSlots(doc, brandName)
    const hfDir = path.join(ctx.config.paths.workspace, slug, 'hf')
    onProgress('TTS 配音…')
    const wavAbs = path.join(hfDir, 'assets', 'narration.wav')
    const voice = await synthesizeVoice(ctx, doc.douyinScript, wavAbs)
    if (voice.degraded) onProgress(`⚠ TTS 降级：${voice.degraded}`)
    const lastEnd = voice.cues.length ? voice.cues[voice.cues.length - 1].end : 0
    const duration = Math.max(16, Math.ceil(lastEnd))
    const { audioMix } = await selectBgm(ctx, video, duration, onProgress, copy.hook)
    const sections = buildInsightSections({ cues: voice.cues, durationSec: duration, painTitle: s.painTitle, cta: s.cta, brandName: s.brandName })
    let html = fillTemplate(readTemplate('insight'), { duration: String(duration) })
    html = html.replace('<!--HF_SECTIONS-->', () => sections.html)
    html = injectTechFx(html, { bg: video.bg, durationSec: duration })
    html = injectAudioCaptions(html, voice.audioRel, voice.cues, duration, video.captions)
    html = fillAccents(html, sections.accents)
    scaffoldHfProject(hfDir, html)
    return renderAndRegister(ctx, hfDir, slug, 'insight', copy.hook, project.id, onProgress, audioMix)
  }

  // demo：产品截图轮播（HyperFrames）。读 shots/，无图报错退出（本模板无图即无意义）
  if (tpl === 'demo') {
    const shots = readShots(path.join(ctx.config.paths.workspace, slug, 'shots'))
    if (!shots.length) throw new Error(`demo 模板需要产品截图，请放入 workspace/${slug}/shots/（png/jpg/webp）`)
    const s = buildDemoSlots(doc, brandName)
    const hfDir = path.join(ctx.config.paths.workspace, slug, 'hf')
    onProgress('TTS 配音…')
    const wavAbs = path.join(hfDir, 'assets', 'narration.wav')
    const voice = await synthesizeVoice(ctx, doc.douyinScript, wavAbs)
    if (voice.degraded) onProgress(`⚠ TTS 降级：${voice.degraded}`)
    // 时长自适应：跟旁白末尾对齐（下限 14s），避免旁白被截断
    const lastEnd = voice.cues.length ? voice.cues[voice.cues.length - 1].end : 0
    const duration = Math.max(14, Math.ceil(lastEnd))
    // 有 cutplan.json 则按方案渲染（钉曲 + 方案 cuts，不重跑选曲/分析）；否则自动
    const planPath = path.join(ctx.config.paths.workspace, slug, 'cutplan.json')
    let cutPlan: any = null
    if (fs.existsSync(planPath)) { try { cutPlan = JSON.parse(fs.readFileSync(planPath, 'utf8')) } catch { cutPlan = null } }
    let grid: BeatGrid | null = null
    let audioMix: AudioMix | undefined
    let demoPlan: { cuts: Array<{ start: number; shot: number }> } | undefined
    if (cutPlan?.bgm && cutPlan?.grid && typeof cutPlan.grid.T === 'number' && typeof cutPlan.grid.t0 === 'number'
      && fs.existsSync(path.join(ctx.config.paths.templates, 'bgm', cutPlan.bgm))) {
      grid = cutPlan.grid
      demoPlan = { cuts: planCutTimes(cutPlan, shots.length) }
      if (video.mode !== 'stub') {
        const bgmAbs = path.join(ctx.config.paths.templates, 'bgm', cutPlan.bgm)
        const sfxPath = pickBgm(path.join(ctx.config.paths.templates, 'sfx'))
        audioMix = { bgmPath: bgmAbs, sfxPath, strongBeats: cutPlan.grid.strongBeats ?? [], durationSec: duration }
      }
    } else {
      if (cutPlan?.bgm) onProgress('⚠ 卡点方案曲子不存在，改用自动卡点')
      const sel = await selectBgm(ctx, video, duration, onProgress, copy.hook)
      grid = sel.grid; audioMix = sel.audioMix
    }
    const demo = buildDemoSections({ ...s, shots, durationSec: duration, beats: (!demoPlan && grid) ? gridBeats(grid, duration) : undefined, plan: demoPlan })
    let html = fillTemplate(readTemplate('demo'), { duration: String(duration) })
    html = html.replace('<!--HF_SECTIONS-->', () => demo.html)
    html = injectTechFx(html, { bg: video.bg, durationSec: duration })
    html = injectAudioCaptions(html, voice.audioRel, voice.cues, duration, video.captions)
    html = fillAccents(html, demo.accents)
    // 截图拷进 hf/assets
    const shotAssets: Record<string, Buffer> = {}
    for (const sh of shots) shotAssets[sh.rel] = fs.readFileSync(path.join(ctx.config.paths.workspace, slug, 'shots', sh.rel))
    scaffoldHfProject(hfDir, html, shotAssets)
    return renderAndRegister(ctx, hfDir, slug, 'demo', copy.hook, project.id, onProgress, audioMix)
  }

  // story：气泡对话（HyperFrames）
  if (tpl === 'story') {
    const s = buildStorySlots(doc, brandName)
    const hfDir = path.join(ctx.config.paths.workspace, slug, 'hf')
    onProgress('TTS 配音…')
    const wavAbs = path.join(hfDir, 'assets', 'narration.wav')
    const voice = await synthesizeVoice(ctx, doc.douyinScript, wavAbs)
    if (voice.degraded) onProgress(`⚠ TTS 降级：${voice.degraded}`)
    const lastEnd = voice.cues.length ? voice.cues[voice.cues.length - 1].end : 0
    const duration = Math.max(14, Math.ceil(lastEnd))
    // BGM：选曲→分析节拍（fail-soft）；聊天场/卖点/CTA 段切换边界吸附节拍；静态文字场不加脉冲
    const { grid, audioMix } = await selectBgm(ctx, video, duration, onProgress, copy.hook)
    const sections = buildStorySections({ ...s, durationSec: duration, beats: grid ? gridBeats(grid, duration) : undefined })
    let html = fillTemplate(readTemplate('story'), { duration: String(duration) })
    html = html.replace('<!--HF_SECTIONS-->', () => sections)
    // story 聊天场保持"真截图"感：不加科技背景（bg 不适用于此模板），只让结尾卖点/CTA 卡逐字解码
    html = injectTechFx(html, { durationSec: duration })
    html = injectAudioCaptions(html, voice.audioRel, voice.cues, duration, video.captions)
    html = fillAccents(html, '')
    scaffoldHfProject(hfDir, html)
    return renderAndRegister(ctx, hfDir, slug, 'story', copy.hook, project.id, onProgress, audioMix)
  }

  // flash：开场钩子→中段流动字幕（按旁白节奏）→结尾CTA（HyperFrames）。支持横竖屏。
  const s = buildFlashSlots(doc, brandName)
  const ratio = input.ratio ?? 'portrait'
  const hfDir = path.join(ctx.config.paths.workspace, slug, 'hf')
  onProgress('TTS 配音…')
  const wavAbs = path.join(hfDir, 'assets', 'narration.wav')
  const voice = await synthesizeVoice(ctx, doc.douyinScript, wavAbs)
  if (voice.degraded) onProgress(`⚠ TTS 降级：${voice.degraded}`)
  const lastEnd = voice.cues.length ? voice.cues[voice.cues.length - 1].end : 0
  const duration = Math.max(12, Math.ceil(lastEnd))
  // BGM：选曲→分析节拍（fail-soft）。段落时长按 duration 动态算，不再写死；静态文字场不加脉冲，只混音
  const { audioMix } = await selectBgm(ctx, video, duration, onProgress, copy.hook)
  const sections = buildFlashSections({
    cues: voice.cues, durationSec: duration, painTitle: s.painTitle, sellingPoint: s.sellingPoint, cta: s.cta, brandName: s.brandName,
  })
  let html = fillTemplate(readTemplate(ratio === 'landscape' ? 'flash-landscape' : 'flash'), { duration: String(duration) })
  html = html.replace('<!--HF_SECTIONS-->', () => sections.html)
  html = injectTechFx(html, { bg: video.bg, durationSec: duration })
  html = injectAudioCaptions(html, voice.audioRel, voice.cues, duration, video.captions)
  html = fillAccents(html, sections.accents)
  scaffoldHfProject(hfDir, html)
  return renderAndRegister(ctx, hfDir, slug, 'flash', copy.hook, project.id, onProgress, audioMix)
}

/**
 * 渲染 hf 项目并登记 video 素材（各 HyperFrames 分支收尾共用）。
 * `audioMix` 可选：渲染后调 mixAudio 把 BGM/SFX 混进成片，失败 fail-soft（保留无背景乐版本，打 ⚠）。
 * stub 模式下即便传了 audioMix 也不真跑 mixAudio（不 spawn ffmpeg）。
 */
async function renderAndRegister(
  ctx: CoreCtx, hfDir: string, slug: string, tpl: string, hook: string | null,
  projectId: number, onProgress: (m: string) => void, audioMix?: AudioMix,
): Promise<GeneratedVideo> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const relPath = path.join(slug, 'videos', `${tpl}-${hook ?? tpl}-${stamp}-${randomUUID().slice(0, 6)}.mp4`)
  const outAbs = path.join(ctx.config.paths.workspace, relPath)
  onProgress(`渲染视频（HyperFrames，${ctx.config.video.mode}）…`)
  await renderHyperframes(hfDir, outAbs, ctx.config.video.mode === 'stub' ? 'stub' : 'render', { onProgress })
  if (audioMix && ctx.config.video.mode !== 'stub') {
    try {
      onProgress('混入 BGM/音效…')
      await mixAudio(outAbs, audioMix)
    } catch (e) {
      onProgress(`⚠ BGM 混音失败，保留无背景乐版本：${e instanceof Error ? e.message : String(e)}`)
    }
  }
  const info = ctx.db.prepare(
    'INSERT INTO assets (project_id, type, hook, file_path, warnings) VALUES (?, ?, ?, ?, ?)',
  ).run(projectId, 'video', hook, relPath, '[]')
  advanceStage(ctx.db, projectId, 'producing')
  onProgress(`视频完成: ${relPath}`)
  return { assetId: Number(info.lastInsertRowid), filePath: relPath }
}

/** 自定义模板渲染：TTS→BGM 流程与 flash 一致，差异只在按拆解节奏比例填 N 个动态分段占位符。 */
async function renderCustomTemplate(
  ctx: CoreCtx, row: any,
  opts: { slug: string; doc: ReturnType<typeof parseCopyOutput>; hook: string; projectId: number; video: VideoCfg; onProgress: (m: string) => void },
): Promise<GeneratedVideo> {
  const { slug, doc, hook, projectId, video, onProgress } = opts
  const hfDir = path.join(ctx.config.paths.workspace, slug, 'hf')
  onProgress('TTS 配音…')
  const wavAbs = path.join(hfDir, 'assets', 'narration.wav')
  const voice = await synthesizeVoice(ctx, doc.douyinScript, wavAbs)
  if (voice.degraded) onProgress(`⚠ TTS 降级：${voice.degraded}`)
  const lastEnd = voice.cues.length ? voice.cues[voice.cues.length - 1].end : 0
  const duration = Math.max(6, Math.ceil(lastEnd))
  const { audioMix } = await selectBgm(ctx, video, duration, onProgress, hook)

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
  return renderAndRegister(ctx, hfDir, slug, `custom-${row.id}`, hook, projectId, onProgress, audioMix)
}
