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
 * 注入配音音轨 + 字幕脚本。用 HTML 注释标记 <!--HF_AUDIO--> / <!--HF_CAPTIONS-->，
 * 避开 fillTemplate 的 {{}} 正则（否则会被当未知 slot 提前吃成空串）——故本函数须在 fillTemplate 之后调。
 * cue 文本经 JSON.stringify 后把 < 转成 <，防止字面 </script> 截断脚本标签。
 * 四套模板共用此注入逻辑（DRY）。
 */
export function injectAudioCaptions(html: string, audioRel: string | null, cues: Cue[], durationSec: number): string {
  const audioTag = audioRel
    ? `<audio id="narration" class="clip" data-start="0" data-duration="${durationSec}" data-track-index="0" data-audio="true" src="assets/narration.wav"></audio>`
    : ''
  const capScript = cues.length
    ? 'const __cap = document.getElementById("cap");\n' + cues.map((c) =>
        `if (__cap) tl.set(__cap, { textContent: ${JSON.stringify(c.text).replace(/</g, '\\u003c')} }, ${c.start});`,
      ).join('\n')
    : ''
  return html.replace('<!--HF_AUDIO-->', audioTag).replace('<!--HF_CAPTIONS-->', capScript)
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
