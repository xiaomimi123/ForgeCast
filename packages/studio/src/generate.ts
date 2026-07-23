import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { CoreCtx } from '@forgecast/core'
import { parseCopyOutput } from '@forgecast/copywriter'
import { fillTemplate, readTemplate, renderHyperframes, scaffoldHfProject } from './hyperframes'
import { buildChangelogProps, buildDemoProps, buildFlashProps, buildStoryProps } from './props'
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
    // 音轨标签 + 字幕脚本（非用户数据，直接替换不转义）
    const audioTag = voice.audioRel
      ? '<audio id="narration" class="clip" data-start="0" data-duration="12" data-track-index="0" data-audio="true" src="assets/narration.wav"></audio>'
      : ''
    const capScript = voice.cues.map((c) =>
      `tl.set(document.getElementById("cap"), { textContent: ${JSON.stringify(c.text)} }, ${c.start});`,
    ).join('\n')
    // 填模板 → 脚手架 → 渲染
    const html = fillTemplate(readTemplate('changelog'), slots)
      .replace('{{audioTag}}', audioTag).replace('{{captionScript}}', capScript)
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

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const base = `${tpl}-${copy.hook ?? tpl}-${stamp}-${randomUUID().slice(0, 6)}`
  const videoDir = path.join(ctx.config.paths.workspace, slug, 'videos')
  fs.mkdirSync(videoDir, { recursive: true })

  let compositionId: string
  let props: Record<string, unknown>
  if (tpl === 'demo') {
    // demo：痛点列表 + 报价锚点 + 录屏演示底 + TTS 配音（wav）+ 估算字幕（cues）
    const dp = buildDemoProps(doc, brandName)
    // 找 raw/ 下第一个录屏作演示底（无则占位）
    const rawDir = path.join(ctx.config.paths.workspace, slug, 'raw')
    if (fs.existsSync(rawDir)) {
      const vid = fs.readdirSync(rawDir).find((f) => /\.(mp4|mov)$/i.test(f))
      if (vid) dp.demoVideoSrc = path.join(slug, 'raw', vid)
    }
    onProgress('TTS 配音…')
    const wavAbs = path.join(videoDir, `${base}.wav`)
    const voice = await synthesizeVoice(ctx, doc.douyinScript, wavAbs)
    if (voice.degraded) onProgress(`⚠ TTS 降级为占位音轨：${voice.degraded}`)
    dp.audioSrc = voice.audioRel ?? undefined
    dp.cues = voice.cues
    props = dp as unknown as Record<string, unknown>
    compositionId = 'Demo'
  } else if (tpl === 'story') {
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
