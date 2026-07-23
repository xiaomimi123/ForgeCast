import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Cue } from './tts'

const STUB_BYTES = Buffer.from('FORGECAST_STUB_MP4\n')
// templates/hf 相对本文件：packages/studio/src → 仓库根/templates/hf
const HF_TEMPLATES = fileURLToPath(new URL('../../../templates/hf', import.meta.url))

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

/** 具名 slot 替换：{{key}} → escapeHtml(slots[key])；未提供的 slot 替空。 */
export function fillTemplate(tplHtml: string, slots: Record<string, string>): string {
  return tplHtml.replace(/\{\{(\w+)\}\}/g, (_, k) => (k in slots ? escapeHtml(slots[k]) : ''))
}

/**
 * 注入配音音轨 + 字幕。用 HTML 注释标记 <!--HF_AUDIO--> / <!--HF_CAPTIONS-->，
 * 避开 fillTemplate 的 {{}} 正则（否则会被当未知 slot 提前吃成空串）——故本函数须在 fillTemplate 之后调。
 *
 * 字幕按每条 cue 生成一个 .cap.clip 元素，data-start/data-duration 交给 HyperFrames 原生
 * 时间轴显隐——而非用 gsap .set(textContent)，后者在逐帧 seek 渲染下不生效（试跑验证过）。
 * cue 文本经 escapeHtml 防注入。两个标记都在 body 内。四套模板共用此逻辑（DRY），
 * 模板须提供 .cap 定位样式（bottom 字幕条）。
 */
export function injectAudioCaptions(html: string, audioRel: string | null, cues: Cue[], durationSec: number): string {
  const audioTag = audioRel
    ? `<audio id="narration" class="clip" data-start="0" data-duration="${durationSec}" data-track-index="0" data-audio="true" src="assets/narration.wav"></audio>`
    : ''
  const capClips = cues.map((c) => {
    const dur = Math.max(0.5, c.end - c.start)
    return `<div class="cap clip" data-start="${c.start}" data-duration="${dur}" data-track-index="9">${escapeHtml(c.text)}</div>`
  }).join('\n')
  return html.replace('<!--HF_AUDIO-->', audioTag).replace('<!--HF_CAPTIONS-->', capClips)
}

/** 读 templates/hf/<name>.html */
export function readTemplate(name: string): string {
  return fs.readFileSync(path.join(HF_TEMPLATES, `${name}.html`), 'utf8')
}

/** 脚手架：写 hyperframes.json + index.html + assets/*，软链 fonts。 */
export function scaffoldHfProject(destDir: string, indexHtml: string, assets: Record<string, Buffer> = {}): void {
  fs.mkdirSync(path.join(destDir, 'assets'), { recursive: true })
  fs.copyFileSync(path.join(HF_TEMPLATES, 'hyperframes.json'), path.join(destDir, 'hyperframes.json'))
  // fonts 目录软链（相对 index.html 的 assets/fonts 引用统一）
  const fontsSrc = path.join(HF_TEMPLATES, 'fonts')
  const fontsDst = path.join(destDir, 'assets', 'fonts')
  if (fs.existsSync(fontsSrc) && !fs.existsSync(fontsDst)) {
    try { fs.symlinkSync(fontsSrc, fontsDst, 'dir') } catch { fs.cpSync(fontsSrc, fontsDst, { recursive: true }) }
  }
  fs.writeFileSync(path.join(destDir, 'index.html'), indexHtml, 'utf8')
  for (const [name, buf] of Object.entries(assets)) fs.writeFileSync(path.join(destDir, 'assets', name), buf)
}

export interface Shot { rel: string; orientation: 'portrait' | 'landscape' }

/** 从图片文件头解析宽高（纯 Node，不引图像库）：支持 PNG / JPEG / WEBP(VP8X)。 */
function imageSize(buf: Buffer): { w: number; h: number } | null {
  // PNG: 8B 签名 + IHDR
  if (buf.length >= 24 && buf[0] === 0x89 && buf[1] === 0x50) return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) }
  // JPEG: 扫 SOF0/2 段
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let o = 2
    while (o < buf.length) {
      if (buf[o] !== 0xff) { o++; continue }
      const m = buf[o + 1]
      if (m === 0xc0 || m === 0xc2) return { h: buf.readUInt16BE(o + 5), w: buf.readUInt16BE(o + 7) }
      o += 2 + buf.readUInt16BE(o + 2)
    }
  }
  // WEBP (VP8X/VP8/VP8L 简化：VP8X 有 24bit 宽高-1)
  if (buf.length >= 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const fmt = buf.toString('ascii', 12, 16)
    if (fmt === 'VP8X') return { w: (buf.readUIntLE(24, 3) & 0xffffff) + 1, h: (buf.readUIntLE(27, 3) & 0xffffff) + 1 }
  }
  return null
}

/** 读截图目录：按文件名排序，解析竖/横向；非图片忽略；损坏/无法解析按 landscape 兜底。 */
export function readShots(shotsDir: string): Shot[] {
  if (!fs.existsSync(shotsDir)) return []
  return fs.readdirSync(shotsDir).filter((f) => /\.(png|jpe?g|webp)$/i.test(f)).sort().map((f) => {
    const size = imageSize(fs.readFileSync(path.join(shotsDir, f)))
    return { rel: f, orientation: size && size.w < size.h ? 'portrait' : 'landscape' }
  })
}

/** 渲染：stub 写占位；render spawn `hyperframes render`（需 Node 22+、已 ensure 浏览器）。 */
export async function renderHyperframes(
  projectDir: string, outPath: string, mode: 'render' | 'stub',
  opts: { onProgress?: (m: string) => void } = {},
): Promise<void> {
  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  if (mode === 'stub') { fs.writeFileSync(outPath, STUB_BYTES); return }
  await new Promise<void>((resolve, reject) => {
    const p = spawn('npx', ['hyperframes', 'render', '--output', outPath], { cwd: projectDir, stdio: ['ignore', 'pipe', 'pipe'] })
    let err = ''
    p.stdout.on('data', (d) => opts.onProgress?.(d.toString().trim().slice(0, 120)))
    p.stderr.on('data', (d) => { err += d.toString() })
    p.on('error', reject)
    p.on('close', (code) => code === 0 ? resolve() : reject(new Error(`hyperframes render 退出码 ${code}: ${err.slice(0, 400)}`)))
  })
}
