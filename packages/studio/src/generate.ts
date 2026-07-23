import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { CoreCtx } from '@forgecast/core'
import { parseCopyOutput } from '@forgecast/copywriter'
import { buildDemoSections, fillTemplate, injectAudioCaptions, readShots, readTemplate, renderHyperframes, scaffoldHfProject } from './hyperframes'
import { buildChangelogProps, buildDemoSlots, buildFlashProps, buildStoryProps } from './props'
import { renderVideo } from './render'
import { synthesizeVoice } from './tts'

export interface GenerateVideoInput {
  slug: string
  assetId?: number
  tpl?: 'flash' | 'story' | 'demo' | 'changelog'
  onProgress?: (msg: string) => void
}
export interface GeneratedVideo { assetId: number; filePath: string }

// Remotion 打包入口（相对本文件定位到 src/remotion/entry.ts）
const ENTRY = fileURLToPath(new URL('./remotion/entry.ts', import.meta.url))

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
    // 先 fillTemplate 填转义 slot，再注入音轨/字幕（注释标记，不被 {{}} 正则误吃）
    const html = injectAudioCaptions(fillTemplate(readTemplate('changelog'), slots), voice.audioRel, voice.cues, 12)
    scaffoldHfProject(hfDir, html)
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const relPath = path.join(slug, 'videos', `changelog-${copy.hook ?? 'dev'}-${stamp}-${randomUUID().slice(0, 6)}.mp4`)
    const outAbs = path.join(ctx.config.paths.workspace, relPath)
    onProgress(`渲染视频（HyperFrames，${ctx.config.video.mode}）…`)
    await renderHyperframes(hfDir, outAbs, ctx.config.video.mode === 'stub' ? 'stub' : 'render', { onProgress })
    const info = ctx.db.prepare(
      'INSERT INTO assets (project_id, type, hook, file_path, warnings) VALUES (?, ?, ?, ?, ?)',
    ).run(project.id, 'video', copy.hook, relPath, '[]')
    onProgress(`视频完成: ${relPath}`)
    return { assetId: Number(info.lastInsertRowid), filePath: relPath }
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
    const sections = buildDemoSections({ ...s, shots, durationSec: duration })
    let html = fillTemplate(readTemplate('demo'), { duration: String(duration) })
    html = html.replace('<!--HF_SECTIONS-->', sections)
    html = injectAudioCaptions(html, voice.audioRel, voice.cues, duration)
    // 截图拷进 hf/assets
    const shotAssets: Record<string, Buffer> = {}
    for (const sh of shots) shotAssets[sh.rel] = fs.readFileSync(path.join(ctx.config.paths.workspace, slug, 'shots', sh.rel))
    scaffoldHfProject(hfDir, html, shotAssets)
    const stamp2 = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const relPath = path.join(slug, 'videos', `demo-${copy.hook ?? 'demo'}-${stamp2}-${randomUUID().slice(0, 6)}.mp4`)
    onProgress(`渲染视频（HyperFrames，${ctx.config.video.mode}）…`)
    await renderHyperframes(hfDir, path.join(ctx.config.paths.workspace, relPath), ctx.config.video.mode === 'stub' ? 'stub' : 'render', { onProgress })
    const info2 = ctx.db.prepare(
      'INSERT INTO assets (project_id, type, hook, file_path, warnings) VALUES (?, ?, ?, ?, ?)',
    ).run(project.id, 'video', copy.hook, relPath, '[]')
    onProgress(`视频完成: ${relPath}`)
    return { assetId: Number(info2.lastInsertRowid), filePath: relPath }
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const base = `${tpl}-${copy.hook ?? tpl}-${stamp}-${randomUUID().slice(0, 6)}`
  const videoDir = path.join(ctx.config.paths.workspace, slug, 'videos')
  fs.mkdirSync(videoDir, { recursive: true })

  let compositionId: string
  let props: Record<string, unknown>
  if (tpl === 'story') {
    // story：气泡文案 + TTS 配音（wav）+ 估算字幕（cues）
    const sp = buildStoryProps(doc, brandName)
    onProgress('TTS 配音…')
    const wavAbs = path.join(videoDir, `${base}.wav`)
    const voice = await synthesizeVoice(ctx, doc.douyinScript, wavAbs)
    if (voice.degraded) onProgress(`⚠ TTS 降级为占位音轨：${voice.degraded}`)
    sp.audioSrc = voice.audioRel ?? undefined
    sp.cues = voice.cues
    props = sp as unknown as Record<string, unknown>
    compositionId = 'Story'
  } else {
    props = buildFlashProps(doc, brandName) as unknown as Record<string, unknown>
    compositionId = 'Flash'
  }
  fs.writeFileSync(path.join(videoDir, `${base}.props.json`), JSON.stringify(props, null, 2), 'utf8')

  onProgress(`渲染视频（${ctx.config.video.mode} 模式，${tpl}）…`)
  const relPath = path.join(slug, 'videos', `${base}.mp4`)
  await renderVideo(ENTRY, compositionId, props, path.join(ctx.config.paths.workspace, relPath), ctx.config.video.mode, { onProgress, publicDir: ctx.config.paths.workspace })

  const info = ctx.db.prepare(
    'INSERT INTO assets (project_id, type, hook, file_path, warnings) VALUES (?, ?, ?, ?, ?)',
  ).run(project.id, 'video', copy.hook, relPath, '[]')
  onProgress(`视频完成: ${relPath}`)
  return { assetId: Number(info.lastInsertRowid), filePath: relPath }
}
