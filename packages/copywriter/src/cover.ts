import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import type { CoreCtx } from '@forgecast/core'
import { parseCopyOutput } from './parser'

const execFileP = promisify(execFile)

export type CoverTemplate = 'bigtext' | 'annotate' | 'contrast'

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** 纯函数：模板填槽（可单测，与 Playwright 解耦）。shot 为 data URI，用于 annotate 截图位。 */
export function buildCoverHtml(templateHtml: string, slots: { main: string; sub: string; shot?: string }): string {
  return templateHtml
    .replaceAll('{{main}}', esc(slots.main))
    .replaceAll('{{sub}}', esc(slots.sub))
    .replaceAll('{{shot}}', slots.shot ?? '')
}

export const IMG_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp'])
export const VIDEO_EXT = new Set(['.mp4', '.mov'])

/** 从 raw 目录挑一个封面截图源：图片优先，其次视频；无则 null（纯 fs，可单测） */
export function pickRawShot(rawDir: string): { kind: 'image' | 'video'; path: string } | null {
  if (!fs.existsSync(rawDir)) return null
  const files = fs.readdirSync(rawDir, { withFileTypes: true }).filter((d) => d.isFile()).map((d) => d.name).sort()
  const img = files.find((f) => IMG_EXT.has(path.extname(f).toLowerCase()))
  if (img) return { kind: 'image', path: path.join(rawDir, img) }
  const vid = files.find((f) => VIDEO_EXT.has(path.extname(f).toLowerCase()))
  if (vid) return { kind: 'video', path: path.join(rawDir, vid) }
  return null
}

/** 读图片为 data URI（mime 按扩展名） */
export function imageToDataUri(imgPath: string): string {
  const ext = path.extname(imgPath).toLowerCase()
  const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg'
  return `data:${mime};base64,${fs.readFileSync(imgPath).toString('base64')}`
}

/** ffmpeg 抽视频首帧为 data URI；系统无 ffmpeg 或失败返回 null（fail-soft） */
export async function videoFrameDataUri(videoPath: string): Promise<string | null> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-shot-'))
  const out = path.join(dir, 'frame.png')
  try {
    await execFileP('ffmpeg', ['-y', '-ss', '1', '-i', videoPath, '-vframes', '1', out])
    if (!fs.existsSync(out)) return null
    return imageToDataUri(out)
  } catch {
    return null
  } finally {
    fs.rmSync(dir, { recursive: true, force: true }) // 清理临时抽帧目录
  }
}

/** Playwright 打开 demo_url 截图为 data URI；失败返回 null（fail-soft） */
export async function urlShotDataUri(url: string): Promise<string | null> {
  try {
    const { chromium } = await import('playwright')
    const browser = await chromium.launch()
    try {
      const page = await browser.newPage({ viewport: { width: 1242, height: 932 } })
      await page.goto(url, { waitUntil: 'load', timeout: 15000 })
      const buf = await page.screenshot({ type: 'png' })
      return `data:image/png;base64,${Buffer.from(buf).toString('base64')}`
    } finally {
      await browser.close()
    }
  } catch {
    return null
  }
}

/** 解析封面截图源：raw 图片 → raw 视频抽帧 → demo_url 截图 → null（逐级 fail-soft） */
export async function resolveCoverShot(i: { rawDir: string; demoUrl?: string | null }): Promise<string | null> {
  const raw = pickRawShot(i.rawDir)
  if (raw?.kind === 'image') return imageToDataUri(raw.path)
  if (raw?.kind === 'video') {
    const frame = await videoFrameDataUri(raw.path)
    if (frame) return frame
  }
  if (i.demoUrl) {
    const shot = await urlShotDataUri(i.demoUrl)
    if (shot) return shot
  }
  return null
}

export interface RenderCoverInput {
  templatesDir: string
  template?: CoverTemplate
  main: string
  sub: string
  shotDataUri?: string
  outPath: string
}

export interface RegenerateCoverOptions {
  template?: CoverTemplate
  /** raw/ 目录下的具体文件名；缺省则复用 resolveCoverShot 的自动逻辑（raw 字典序第一张 → demo_url 截图） */
  shot?: string
}
export interface RegeneratedCover { assetId: number; filePath: string }

/**
 * 独立重新生成封面：以一条 copy 素材为入口（读它已落盘的 md 重新解析封面文案，不重新生成正文）。
 *
 * **就地覆盖，不插新行**：输出文件复用 copy 的词干（`copy/pain-xxx.md` → `covers/pain-xxx.png`），
 * db 里更新同词干的既有 cover 行（没有才插）。这是内容工位聚合（server content-items.ts）
 * 拿词干把 cover 关联到 copy 的前提——早先每次插一条新时间戳词干的行，聚合永远连不上，
 * 卡片缩略图不换、新行成孤儿，属「看着成功实则没效果」。
 */
export async function regenerateCover(ctx: CoreCtx, copyAssetId: number, opts: RegenerateCoverOptions = {}): Promise<RegeneratedCover> {
  const copy: any = ctx.db.prepare("SELECT * FROM assets WHERE id = ? AND type = 'copy'").get(copyAssetId)
  if (!copy) throw new Error(`文案素材不存在: ${copyAssetId}`)
  const project: any = ctx.db.prepare('SELECT * FROM projects WHERE id = ?').get(copy.project_id)
  if (!project) throw new Error(`项目不存在（project_id=${copy.project_id}）`)

  const md = fs.readFileSync(path.join(ctx.config.paths.workspace, copy.file_path), 'utf8')
  const doc = parseCopyOutput(md)
  const wsDir = path.join(ctx.config.paths.workspace, project.slug)

  let coverShot: string | null
  if (opts.shot) {
    const shotPath = path.join(wsDir, 'raw', opts.shot)
    if (!fs.existsSync(shotPath)) throw new Error(`raw 文件不存在: ${opts.shot}`)
    const ext = path.extname(shotPath).toLowerCase()
    if (VIDEO_EXT.has(ext)) {
      const frame = await videoFrameDataUri(shotPath)
      if (!frame) throw new Error(`无法从视频抽帧: ${opts.shot}（需要系统装了 ffmpeg）`)
      coverShot = frame
    } else if (IMG_EXT.has(ext)) {
      coverShot = imageToDataUri(shotPath)
    } else {
      throw new Error(`不支持的文件类型: ${opts.shot}`)
    }
  } else {
    coverShot = await resolveCoverShot({ rawDir: path.join(wsDir, 'raw'), demoUrl: project.demo_url })
  }

  const template = opts.template ?? (coverShot ? 'annotate' : 'bigtext')
  // 词干＝copy 文件名去扩展名，与批量生成路径（generate.ts）落封面用的是同一个词干
  const copyStem = (copy.file_path.split('/').pop() ?? String(copy.file_path)).replace(/\.[^.]+$/, '')
  const coverRel = path.join(project.slug, 'covers', `${copyStem}.png`)
  await renderCover({
    templatesDir: ctx.config.paths.templates,
    template, main: doc.cover.main, sub: doc.cover.sub,
    shotDataUri: coverShot ?? undefined,
    outPath: path.join(ctx.config.paths.workspace, coverRel),
  })
  const existing: any = ctx.db.prepare(
    "SELECT id FROM assets WHERE project_id = ? AND type = 'cover' AND file_path = ?",
  ).get(project.id, coverRel)
  if (existing) {
    // 文件已被上面覆盖写掉，行只需回到 draft（重生过的封面要重新过审）并清掉旧 warnings
    ctx.db.prepare("UPDATE assets SET status = 'draft', warnings = '[]', hook = ? WHERE id = ?").run(copy.hook, existing.id)
    return { assetId: Number(existing.id), filePath: coverRel }
  }
  const info = ctx.db.prepare(
    'INSERT INTO assets (project_id, type, hook, file_path, warnings) VALUES (?, ?, ?, ?, ?)',
  ).run(project.id, 'cover', copy.hook, coverRel, '[]')
  return { assetId: Number(info.lastInsertRowid), filePath: coverRel }
}

/** Playwright 截图 1242×1660（小红书 3:4）。调用方自行 try/catch——封面失败不应阻断文案。 */
export async function renderCover(i: RenderCoverInput): Promise<void> {
  const { chromium } = await import('playwright')
  const tpl = fs.readFileSync(path.join(i.templatesDir, 'covers', `${i.template ?? 'bigtext'}.html`), 'utf8')
  const html = buildCoverHtml(tpl, { main: i.main, sub: i.sub, shot: i.shotDataUri })
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage({ viewport: { width: 1242, height: 1660 } })
    await page.setContent(html, { waitUntil: 'load' })
    fs.mkdirSync(path.dirname(i.outPath), { recursive: true })
    await page.screenshot({ path: i.outPath })
  } finally {
    await browser.close()
  }
}
