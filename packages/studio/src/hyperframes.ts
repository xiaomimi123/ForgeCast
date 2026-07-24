import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Cue } from './tts'

const STUB_BYTES = Buffer.from('FORGECAST_STUB_MP4\n')
// templates/hf 相对本文件：packages/studio/src → 仓库根/templates/hf
const HF_TEMPLATES = fileURLToPath(new URL('../../../templates/hf', import.meta.url))
// pin HyperFrames 版本：npx 默认拉最新，破坏性升级会让渲染无预警变化
const HF_VERSION = '0.7.68'
// render/tts 单进程超时（Chrome/kokoro 卡死不能把进程内任务队列永久挂住）
const RENDER_TIMEOUT_MS = 600_000
const TTS_SPAWN_TIMEOUT_MS = 180_000
const COSY_TIMEOUT_MS = 600_000 // CosyVoice2 慢 + 长旁白，给足

// 本地 TTS 推理脚本相对本文件：packages/studio/src → packages/studio/scripts
const MELO_SCRIPT = fileURLToPath(new URL('../scripts/melo_infer.py', import.meta.url))
const COSY_SCRIPT = fileURLToPath(new URL('../scripts/cosy_infer.py', import.meta.url))
const BEAT_SCRIPT = fileURLToPath(new URL('../scripts/beat_grid.py', import.meta.url))

/** 带超时的 spawn：超时 kill 并 reject。stdin ignore。cmd 默认 npx（HyperFrames 用）。 */
function spawnWithTimeout(args: string[], opts: { cmd?: string; cwd?: string; timeoutMs: number; label: string; onStdout?: (s: string) => void }): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(opts.cmd ?? 'npx', args, { cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let err = ''
    const timer = setTimeout(() => { p.kill('SIGKILL'); reject(new Error(`${opts.label} 超时（${opts.timeoutMs}ms）已终止`)) }, opts.timeoutMs)
    p.stdout.on('data', (d) => opts.onStdout?.(d.toString().trim().slice(0, 120)))
    p.stderr.on('data', (d) => { err += d.toString() })
    p.on('error', (e) => { clearTimeout(timer); reject(e) })
    p.on('close', (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`${opts.label} 退出码 ${code}: ${err.slice(0, 400)}`)) })
  })
}

/** MeloTTS 配音：spawn <meloPython> scripts/melo_infer.py <text> <out>（强制 CPU，见脚本）。 */
export function runMeloTts(text: string, outWavAbs: string, meloPython: string): Promise<void> {
  return spawnWithTimeout([MELO_SCRIPT, text, outWavAbs], {
    cmd: meloPython, timeoutMs: TTS_SPAWN_TIMEOUT_MS, label: 'MeloTTS',
  })
}

/** CosyVoice2 零样本克隆配音：spawn <cosyHome>/venv/bin/python scripts/cosy_infer.py <cosyHome> <text> <out>。
 *  慢（RTF ~2.75x），超时给足。cosyHome 约定含 venv/CosyVoice/model/prompt.wav+txt。 */
export function runCosyTts(text: string, outWavAbs: string, cosyHome: string): Promise<void> {
  return spawnWithTimeout([COSY_SCRIPT, cosyHome, text, outWavAbs], {
    cmd: `${cosyHome}/venv/bin/python`, timeoutMs: COSY_TIMEOUT_MS, label: 'CosyVoice2',
  })
}

export interface BeatGrid { t0: number; T: number; bpm: number; beats: number[]; strongBeats: number[]; duration: number }

/** 节拍分析：读 <bgm>.beats.json 缓存；无则 spawn beat_grid.py 生成再读。任何失败返 null（调用方降级不卡点）。 */
export async function analyzeBeats(
  bgmPath: string, beatPython: string,
  deps: { run?: (args: string[]) => Promise<void> } = {},
): Promise<BeatGrid | null> {
  const cache = `${bgmPath}.beats.json`
  const readCache = (): BeatGrid | null => {
    try {
      const g = JSON.parse(fs.readFileSync(cache, 'utf8'))
      if (Array.isArray(g.beats) && typeof g.T === 'number') return g as BeatGrid
      return null
    } catch { return null }
  }
  if (fs.existsSync(cache)) { const g = readCache(); if (g) return g }
  const run = deps.run ?? ((args: string[]) => spawnWithTimeout(args, { cmd: beatPython, timeoutMs: TTS_SPAWN_TIMEOUT_MS, label: 'beat_grid' }))
  try {
    await run([BEAT_SCRIPT, bgmPath, cache])
    return readCache()
  } catch { return null }
}

/** 返回最近的 beat 时间；beats 空则原样返回。 */
export function snapToBeat(t: number, beats: number[]): number {
  if (!beats.length) return t
  return beats.reduce((best, b) => (Math.abs(b - t) < Math.abs(best - t) ? b : best), beats[0])
}

/** 曲库选曲：name 指定则补 .mp3/.wav 后缀命中；否则字典序第一个音频；无则 null。 */
export function pickBgm(bgmDir: string, name?: string): string | null {
  if (!fs.existsSync(bgmDir)) return null
  if (name) {
    for (const ext of ['', '.mp3', '.wav', '.m4a']) {
      const p = path.join(bgmDir, name + ext)
      if (fs.existsSync(p) && fs.statSync(p).isFile()) return p
    }
    return null
  }
  const audio = fs.readdirSync(bgmDir).filter((f) => /\.(mp3|wav|m4a)$/i.test(f)).sort()
  return audio.length ? path.join(bgmDir, audio[0]) : null
}

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
  // 用函数 replacer：替换值含用户文案，直接传字符串会让 $& / $` 等被当替换模式解释
  return html.replace('<!--HF_AUDIO-->', () => audioTag).replace('<!--HF_CAPTIONS-->', () => capClips)
}

/** 读 templates/hf/<name>.html */
export function readTemplate(name: string): string {
  return fs.readFileSync(path.join(HF_TEMPLATES, `${name}.html`), 'utf8')
}

/** 脚手架：写 hyperframes.json + index.html + assets/*，软链 fonts。 */
export function scaffoldHfProject(destDir: string, indexHtml: string, assets: Record<string, Buffer> = {}): void {
  fs.mkdirSync(path.join(destDir, 'assets'), { recursive: true })
  fs.copyFileSync(path.join(HF_TEMPLATES, 'hyperframes.json'), path.join(destDir, 'hyperframes.json'))
  // GSAP 本地化（模板引用 gsap.min.js）：离线/部署目标渲染不依赖 CDN
  fs.copyFileSync(path.join(HF_TEMPLATES, 'gsap.min.js'), path.join(destDir, 'gsap.min.js'))
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

/**
 * 组装 demo 模板的分镜段 HTML（填进 <!--HF_SECTIONS-->）。五段：钩子→痛点→截图轮播→报价→CTA。
 * 时长自适应：碰头/痛点/报价/CTA 固定 3s，截图轮播吸收中段剩余、按图数均分。
 * 竖图套手机外框（.phone），横图居中缩放 + 同图虚化背景（.wide*）。文本全 escapeHtml。
 */
export function buildDemoSections(opts: {
  hookTitle: string; painPoints: string[]; priceAnchor: string; cta: string; brandName: string
  shots: Shot[]; durationSec: number
}): string {
  const { hookTitle, painPoints, priceAnchor, cta, brandName, shots, durationSec } = opts
  const clip = (start: number, dur: number, track: number, inner: string) =>
    `<div class="clip" data-start="${start}" data-duration="${dur}" data-track-index="${track}">${inner}</div>`
  const carStart = 6, carEnd = Math.max(carStart + 1, durationSec - 6)
  const per = shots.length ? (carEnd - carStart) / shots.length : 0
  const painHtml = painPoints.map((p) => `<div class="pain">· ${escapeHtml(p)}</div>`).join('')
  const shotHtml = shots.map((s, i) => {
    // 文件名由操作者放入，转义 + encodeURI 防属性/CSS url 破坏
    const src = escapeHtml(`assets/${encodeURI(s.rel)}`)
    const body = s.orientation === 'portrait'
      ? `<div class="phoneWrap"><div class="phone"><img src="${src}"/></div></div>`
      : `<div class="wideWrap"><div class="wideBg" style="background-image:url('${src}')"></div><div class="wideFg"><img src="${src}"/></div></div>`
    return clip(carStart + i * per, per, 2, body)
  }).join('\n')
  return [
    clip(0, 3, 1, `<div class="fill pad center"><div class="hookT">${escapeHtml(hookTitle)}</div></div>`),
    clip(3, 3, 1, `<div class="fill pad painWrap">${painHtml}</div>`),
    shotHtml,
    clip(durationSec - 6, 3, 1, `<div class="fill pad center"><div class="price">${escapeHtml(priceAnchor)}</div></div>`),
    clip(durationSec - 3, 3, 1, `<div class="fill pad center"><div class="cta">${escapeHtml(cta)}</div><div class="brand">@${escapeHtml(brandName)}</div></div>`),
  ].join('\n')
}

/**
 * 组装 story 模板分镜段（填 <!--HF_SECTIONS-->）。三段：聊天场→卖点→CTA。
 * 聊天场吸收前段（0..dur-6），卖点/CTA 固定各 3s。气泡文本 escapeHtml。
 */
export function buildStorySections(opts: {
  bubbles: Array<{ who: 'them' | 'me'; text: string }>; sellingPoint: string; cta: string; brandName: string
  durationSec: number
}): string {
  const { bubbles, sellingPoint, cta, brandName, durationSec } = opts
  const clip = (start: number, dur: number, track: number, inner: string) =>
    `<div class="clip" data-start="${start}" data-duration="${dur}" data-track-index="${track}">${inner}</div>`
  const bubbleHtml = bubbles.map((b) => `<div class="bubble ${b.who}">${escapeHtml(b.text)}</div>`).join('')
  const chatDur = Math.max(1, durationSec - 6)
  return [
    clip(0, chatDur, 1, `<div class="chat">${bubbleHtml}</div>`),
    clip(durationSec - 6, 3, 1, `<div class="fill pad center sellFill"><div class="sell">${escapeHtml(sellingPoint)}</div></div>`),
    clip(durationSec - 3, 3, 1, `<div class="fill pad center sellFill"><div class="cta">${escapeHtml(cta)}</div><div class="brand">@${escapeHtml(brandName)}</div></div>`),
  ].join('\n')
}

/** 渲染：stub 写占位；render spawn `hyperframes render`（需 Node 22+、已 ensure 浏览器）。带超时 + --yes。 */
export async function renderHyperframes(
  projectDir: string, outPath: string, mode: 'render' | 'stub',
  opts: { onProgress?: (m: string) => void } = {},
): Promise<void> {
  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  if (mode === 'stub') { fs.writeFileSync(outPath, STUB_BYTES); return }
  await spawnWithTimeout(['--yes', `hyperframes@${HF_VERSION}`, 'render', '--output', outPath], {
    cwd: projectDir, timeoutMs: RENDER_TIMEOUT_MS, label: 'hyperframes render', onStdout: opts.onProgress,
  })
}

/** Kokoro 配音：spawn `hyperframes tts`（带超时 + --yes + pin 版本）。供 tts.ts 复用。 */
export function runKokoroTts(text: string, outWavAbs: string, voice: string, lang = 'zh'): Promise<void> {
  return spawnWithTimeout(['--yes', `hyperframes@${HF_VERSION}`, 'tts', text, '--voice', voice, '--lang', lang, '--output', outWavAbs], {
    timeoutMs: TTS_SPAWN_TIMEOUT_MS, label: 'hyperframes tts',
  })
}

/** ffmpeg filter_complex：BGM 裁/loop 到时长+压 -18dB+被旁白 sidechaincompress；SFX 各强拍 adelay 后并入；最后与旁白 amix。 */
export function buildMixFilter(opts: { hasSfx: boolean; strongBeats: number[]; durationSec: number }): string {
  const ms = opts.durationSec * 1000
  // [0:a]=旁白 [1:a]=BGM [2:a]=SFX(单次)
  const parts: string[] = []
  parts.push('[0:a]asplit=2[narr][sc]')
  // BGM：截到时长、压低、以旁白(sc)为触发做 ducking
  parts.push(`[1:a]atrim=0:${opts.durationSec},volume=-18dB[bgmv]`)
  parts.push('[bgmv][sc]sidechaincompress=threshold=0.03:ratio=8:attack=5:release=300[bgmduck]')
  const mixIns = ['[narr]', '[bgmduck]']
  if (opts.hasSfx && opts.strongBeats.length) {
    opts.strongBeats.forEach((t, i) => {
      const delay = Math.round(t * 1000)
      parts.push(`[2:a]adelay=${delay}|${delay},volume=-6dB[sfx${i}]`)
      mixIns.push(`[sfx${i}]`)
    })
  }
  parts.push(`${mixIns.join('')}amix=inputs=${mixIns.length}:normalize=0:duration=first[aout]`)
  return parts.join(';')
}

/** 把 BGM/SFX 混进已渲染的 mp4（旁白轨来自 mp4）。失败抛错，调用方降级保留原视频。 */
export async function mixAudio(mp4: string, opts: {
  bgmPath: string; sfxPath: string | null; strongBeats: number[]; durationSec: number
  deps?: { run?: (args: string[]) => Promise<void> }
}): Promise<void> {
  const filter = buildMixFilter({ hasSfx: !!opts.sfxPath, strongBeats: opts.strongBeats, durationSec: opts.durationSec })
  const tmp = `${mp4}.mix.mp4`
  const args = ['-y', '-i', mp4, '-stream_loop', '-1', '-i', opts.bgmPath]
  if (opts.sfxPath) args.push('-i', opts.sfxPath)
  args.push('-filter_complex', filter, '-map', '0:v', '-map', '[aout]', '-c:v', 'copy', '-c:a', 'aac', tmp)
  const run = opts.deps?.run ?? ((a: string[]) => spawnWithTimeout(a, { cmd: 'ffmpeg', timeoutMs: RENDER_TIMEOUT_MS, label: 'ffmpeg mix' }))
  await run(args)
  fs.renameSync(tmp, mp4)
}
