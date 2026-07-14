import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

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

const IMG_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp'])
const VIDEO_EXT = new Set(['.mp4', '.mov'])

/** 从 raw 目录挑一个封面截图源：图片优先，其次视频；无则 null（纯 fs，可单测） */
export function pickRawShot(rawDir: string): { kind: 'image' | 'video'; path: string } | null {
  if (!fs.existsSync(rawDir)) return null
  const files = fs.readdirSync(rawDir).sort()
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
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fc-shot-')), 'frame.png')
  try {
    await execFileP('ffmpeg', ['-y', '-ss', '1', '-i', videoPath, '-vframes', '1', out])
    if (!fs.existsSync(out)) return null
    return imageToDataUri(out)
  } catch {
    return null
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
