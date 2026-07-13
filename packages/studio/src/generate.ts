import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { CoreCtx } from '@forgecast/core'
import { parseCopyOutput } from '@forgecast/copywriter'
import { buildFlashProps } from './props'
import { renderFlash } from './render'

export interface GenerateVideoInput {
  slug: string
  assetId?: number
  tpl?: 'flash'
  onProgress?: (msg: string) => void
}
export interface GeneratedVideo { assetId: number; filePath: string }

// Remotion 打包入口（相对本文件定位到 src/remotion/entry.ts）
const ENTRY = fileURLToPath(new URL('./remotion/entry.ts', import.meta.url))

/** 取 copy 素材 → 解析 → buildFlashProps → 写 props.json → 渲染 mp4 → 登记 video 素材 */
export async function generateVideo(ctx: CoreCtx, input: GenerateVideoInput): Promise<GeneratedVideo> {
  const { slug, onProgress = () => {} } = input
  const project: any = ctx.db.prepare('SELECT * FROM projects WHERE slug = ?').get(slug)
  if (!project) throw new Error(`项目不存在: ${slug}`)

  const copy: any = input.assetId
    ? ctx.db.prepare("SELECT * FROM assets WHERE id = ? AND type = 'copy'").get(input.assetId)
    : ctx.db.prepare("SELECT * FROM assets WHERE project_id = ? AND type = 'copy' ORDER BY id DESC LIMIT 1").get(project.id)
  if (!copy) throw new Error(`没有可用的文案素材（先在素材工坊生成文案）: ${slug}`)

  onProgress('解析文案、组装视频参数…')
  const copyAbs = path.join(ctx.config.paths.workspace, copy.file_path)
  const doc = parseCopyOutput(fs.readFileSync(copyAbs, 'utf8'))
  const props = buildFlashProps(doc, project.brand_name ?? slug)

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const base = `${copy.hook ?? 'flash'}-${stamp}-${randomUUID().slice(0, 6)}`
  const videoDir = path.join(ctx.config.paths.workspace, slug, 'videos')
  fs.mkdirSync(videoDir, { recursive: true })
  fs.writeFileSync(path.join(videoDir, `${base}.props.json`), JSON.stringify(props, null, 2), 'utf8')

  onProgress(`渲染视频（${ctx.config.video.mode} 模式）…`)
  const relPath = path.join(slug, 'videos', `${base}.mp4`)
  await renderFlash(
    ENTRY,
    props as unknown as Record<string, unknown>,
    path.join(ctx.config.paths.workspace, relPath),
    ctx.config.video.mode,
    { onProgress },
  )

  const info = ctx.db.prepare(
    'INSERT INTO assets (project_id, type, hook, file_path, warnings) VALUES (?, ?, ?, ?, ?)',
  ).run(project.id, 'video', copy.hook, relPath, '[]')
  onProgress(`视频完成: ${relPath}`)
  return { assetId: Number(info.lastInsertRowid), filePath: relPath }
}
