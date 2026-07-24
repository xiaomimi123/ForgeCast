import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { CoreCtx } from '@forgecast/core'
import { parseCopyOutput } from '@forgecast/copywriter'
import { analyzeBeats, buildDemoSections, buildStorySections, gridBeats, injectAudioCaptions, fillAccents, fillTemplate, mixAudio, pickBgm, readShots, readTemplate, renderHyperframes, scaffoldHfProject } from './hyperframes'
import type { BeatGrid } from './hyperframes'
import { buildChangelogProps, buildDemoSlots, buildFlashSlots, buildStorySlots } from './props'
import { synthesizeVoice } from './tts'

export interface GenerateVideoInput {
  slug: string
  assetId?: number
  tpl?: 'flash' | 'story' | 'demo' | 'changelog'
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
async function selectBgm(ctx: CoreCtx, durationSec: number, onProgress: (m: string) => void): Promise<{ grid: BeatGrid | null; audioMix: AudioMix | undefined }> {
  let grid: BeatGrid | null = null
  let audioMix: AudioMix | undefined
  if (ctx.config.video.bgm !== 'none') {
    const bgmDir = path.join(ctx.config.paths.templates, 'bgm')
    const bgmPath = pickBgm(bgmDir, ctx.config.video.bgm || undefined)
    if (bgmPath && ctx.config.video.beatPython && ctx.config.video.mode !== 'stub') {
      grid = await analyzeBeats(bgmPath, ctx.config.video.beatPython)
      if (!grid) onProgress('⚠ 节拍分析失败，加 BGM 但不卡点')
      const sfxDir = path.join(ctx.config.paths.templates, 'sfx')
      const sfxPath = pickBgm(sfxDir) // 复用：取 sfx 目录第一个
      audioMix = { bgmPath, sfxPath, strongBeats: grid?.strongBeats ?? [], durationSec }
    }
  }
  return { grid, audioMix }
}

/** 取 copy 素材 → 解析 → 按 tpl 组装参数（flash 三段文字 / story 气泡+TTS配音字幕）→ 写 props.json → 渲染 mp4 → 登记 video 素材 */
export async function generateVideo(ctx: CoreCtx, input: GenerateVideoInput): Promise<GeneratedVideo> {
  const { slug, onProgress = () => {} } = input
  const tpl = input.tpl ?? 'flash'
  const project: any = ctx.db.prepare('SELECT * FROM projects WHERE slug = ?').get(slug)
  if (!project) throw new Error(`项目不存在: ${slug}`)

  const copy: any = input.assetId
    ? ctx.db.prepare("SELECT * FROM assets WHERE id = ? AND project_id = ? AND type = 'copy'").get(input.assetId, project.id)
    : ctx.db.prepare("SELECT * FROM assets WHERE project_id = ? AND type = 'copy' ORDER BY id DESC LIMIT 1").get(project.id)
  if (!copy) throw new Error(`没有可用的文案素材（先在素材工坊生成文案）: ${slug}`)

  onProgress('解析文案、组装视频参数…')
  const doc = parseCopyOutput(fs.readFileSync(path.join(ctx.config.paths.workspace, copy.file_path), 'utf8'))
  const brandName = project.brand_name ?? slug

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
    const { audioMix } = await selectBgm(ctx, duration, onProgress)
    // 先 fillTemplate 填转义 slot，再注入音轨/字幕（注释标记，不被 {{}} 正则误吃）
    const filled = fillTemplate(readTemplate('changelog'), { ...slots, duration: String(duration), s2dur: String(duration - 6) })
    let html = injectAudioCaptions(filled, voice.audioRel, voice.cues, duration, ctx.config.video.captions)
    html = fillAccents(html, '')
    scaffoldHfProject(hfDir, html)
    return renderAndRegister(ctx, hfDir, slug, 'changelog', copy.hook, project.id, onProgress, audioMix)
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
    // BGM：选曲→分析节拍（fail-soft）；截图轮播每 4 拍快切+图片弹跳（卡点）
    const { grid, audioMix } = await selectBgm(ctx, duration, onProgress)
    const demo = buildDemoSections({ ...s, shots, durationSec: duration, beats: grid ? gridBeats(grid, duration) : undefined })
    let html = fillTemplate(readTemplate('demo'), { duration: String(duration) })
    html = html.replace('<!--HF_SECTIONS-->', () => demo.html)
    html = injectAudioCaptions(html, voice.audioRel, voice.cues, duration, ctx.config.video.captions)
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
    const { grid, audioMix } = await selectBgm(ctx, duration, onProgress)
    const sections = buildStorySections({ ...s, durationSec: duration, beats: grid ? gridBeats(grid, duration) : undefined })
    let html = fillTemplate(readTemplate('story'), { duration: String(duration) })
    html = html.replace('<!--HF_SECTIONS-->', () => sections)
    html = injectAudioCaptions(html, voice.audioRel, voice.cues, duration, ctx.config.video.captions)
    html = fillAccents(html, '')
    scaffoldHfProject(hfDir, html)
    return renderAndRegister(ctx, hfDir, slug, 'story', copy.hook, project.id, onProgress, audioMix)
  }

  // flash：纯文字快闪（HyperFrames）
  const s = buildFlashSlots(doc, brandName)
  const hfDir = path.join(ctx.config.paths.workspace, slug, 'hf')
  onProgress('TTS 配音…')
  const wavAbs = path.join(hfDir, 'assets', 'narration.wav')
  const voice = await synthesizeVoice(ctx, doc.douyinScript, wavAbs)
  if (voice.degraded) onProgress(`⚠ TTS 降级：${voice.degraded}`)
  const lastEnd = voice.cues.length ? voice.cues[voice.cues.length - 1].end : 0
  const duration = Math.max(12, Math.ceil(lastEnd))
  // BGM：选曲→分析节拍（fail-soft）。段边界写死在模板、不吸附；静态文字场不加脉冲，只混音
  const { audioMix } = await selectBgm(ctx, duration, onProgress)
  let html = fillTemplate(readTemplate('flash'), { ...s, duration: String(duration) })
  html = injectAudioCaptions(html, voice.audioRel, voice.cues, duration, ctx.config.video.captions)
  html = fillAccents(html, '')
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
  onProgress(`视频完成: ${relPath}`)
  return { assetId: Number(info.lastInsertRowid), filePath: relPath }
}
