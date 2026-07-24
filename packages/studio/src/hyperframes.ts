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

/**
 * 用线性网格 t0+n·T 外推整条视频时长内的所有拍点（不止 BGM 检测到的那段）。
 * BGM 短于视频时会 loop，检测到的 beats 只覆盖 BGM 长度；靠 t0/T 外推让卡点全程持续。
 * 注：loop 边界（BGM 时长非整数拍倍数处）之后，外推拍与循环后的可闻拍会有相位差——
 * 建议用 ≥ 视频时长的 BGM。T 非正时返回检测到的 beats 兜底。
 */
export function gridBeats(grid: BeatGrid, durationSec: number): number[] {
  if (!(grid.T > 0)) return grid.beats
  const out: number[] = []
  for (let t = grid.t0 % grid.T; t <= durationSec + 1e-9; t += grid.T) {
    if (t >= 0) out.push(+t.toFixed(4))
  }
  return out
}

/**
 * 顺序吸附一组 (start,dur) 段的 start 到最近拍：吸附后保证**不早于前一段结束**(prevStart+prevDur)，
 * 防止独立吸附把相邻段拉到同一拍/倒序，导致同 track 画面重叠或错序。段须已按时间先后排列。
 * 无网格时原样返回 start。
 */
export function snapStarts(segs: Array<{ start: number; dur: number }>, beats?: number[]): number[] {
  if (!beats || !beats.length) return segs.map((s) => s.start)
  const out: number[] = []
  let prevEnd = -Infinity
  for (const { start, dur } of segs) {
    let s = snapToBeat(start, beats)
    if (s < prevEnd) s = prevEnd // 不早于前一段结束
    out.push(s)
    prevEnd = s + dur
  }
  return out
}

/** hook 类型 → 情绪键（文件夹名）。hook 本身即内容的情绪策略角度。 */
export const HOOK_MOOD: Record<string, string> = { pain: 'tense', sideline: 'upbeat', infogap: 'tech', story: 'warm' }
/** 情绪键：显式 override 优先，否则按 hook 映射；都无则空串（走根目录回落）。 */
export function resolveMood(hook: string, override?: string): string {
  return override || HOOK_MOOD[hook] || ''
}

/** 选曲：有 name 则补后缀命中；无 name 时给了 rand 从音频随机、否则字典序第一个（向后兼容）。 */
export function pickBgm(bgmDir: string, name?: string, rand?: () => number): string | null {
  if (!fs.existsSync(bgmDir)) return null
  if (name) {
    for (const ext of ['', '.mp3', '.wav', '.m4a']) {
      const p = path.join(bgmDir, name + ext)
      if (fs.existsSync(p) && fs.statSync(p).isFile()) return p
    }
    return null
  }
  const audio = fs.readdirSync(bgmDir).filter((f) => /\.(mp3|wav|m4a)$/i.test(f)).sort()
  if (!audio.length) return null
  const idx = rand ? Math.min(audio.length - 1, Math.floor(rand() * audio.length)) : 0
  return path.join(bgmDir, audio[idx])
}

/** 情绪选曲：mood 非空且 <dir>/<mood>/ 有曲 → 该子目录随机；否则根目录随机；都空 → null。 */
export function pickMoodBgm(bgmDir: string, mood: string, rand?: () => number): string | null {
  if (mood) {
    const hit = pickBgm(path.join(bgmDir, mood), undefined, rand)
    if (hit) return hit
  }
  return pickBgm(bgmDir, undefined, rand)
}

/** 选曲优先级链：bgm='none'→null；bgm 具体名→指定曲；否则按 resolveMood(hook,mood) 走情绪/根随机。 */
export function chooseBgmPath(bgmDir: string, opts: { bgm: string; mood: string; hook: string }, rand?: () => number): string | null {
  if (opts.bgm === 'none') return null
  if (opts.bgm) return pickBgm(bgmDir, opts.bgm)
  return pickMoodBgm(bgmDir, resolveMood(opts.hook, opts.mood), rand)
}

/** 科技感背景变体名。CSS 定义在各模板 <style>（class bg-<name>），此处只出内层结构 + GSAP 微动。 */
export const TECH_BGS = ['grid', 'aurora', 'matrix', 'synth', 'mesh'] as const

/** 解析背景名：random/auto → 随机挑一套（内容池自然有变化）；其余原样返回。rand 可注入便于测试。 */
export function resolveTechBg(name: string, rand: () => number = Math.random): string {
  if (name === 'random' || name === 'auto') return TECH_BGS[Math.floor(rand() * TECH_BGS.length)]
  return name
}
/**
 * 组装科技背景：返回 #techbg 的 class、内层 HTML、GSAP 微动行（时长已烘进，供填 <!--HF_BGANIM-->）。
 * 动画只用 GSAP 挂主线 tl（可 seek）——不用 CSS @keyframes（逐帧 seek 下不随帧走）。未知名回落 grid。
 */
export function buildTechBg(variant: string, durationSec: number): { cls: string; inner: string; anim: string } {
  const v = (TECH_BGS as readonly string[]).includes(variant) ? variant : 'grid'
  const d = durationSec
  const vig = '<div class="vig"></div>'
  switch (v) {
    case 'aurora':
      return { cls: 'bg-aurora', inner: `<div class="mv"></div>${vig}`,
        anim: `tl.fromTo("#techbg .mv",{xPercent:-6,yPercent:-4},{xPercent:6,yPercent:4,duration:${d},ease:"none"},0);` }
    case 'matrix':
      return { cls: 'bg-matrix', inner: `<div class="mv"></div>${vig}`,
        anim: `tl.fromTo("#techbg .mv",{y:-220},{y:220,duration:${d},ease:"none"},0);` }
    case 'synth':
      return { cls: 'bg-synth', inner: `<div class="sun"></div><div class="mv"></div>${vig}`,
        anim: `tl.to("#techbg .mv",{backgroundPosition:"0px 70px",duration:${d},ease:"none"},0);` }
    case 'mesh':
      return { cls: 'bg-mesh', inner: `<div class="mv"></div>${vig}`,
        anim: `tl.fromTo("#techbg .mv",{y:0},{y:46,duration:${d},ease:"none"},0);` }
    default:
      return { cls: 'bg-grid', inner: `<div class="mv"></div><div class="sweep"></div>${vig}`,
        anim: `tl.fromTo("#techbg .mv",{y:0},{y:80,duration:${d},ease:"none"},0);tl.fromTo("#techbg .sweep",{xPercent:0},{xPercent:320,duration:${d},ease:"none"},0);` }
  }
}

/** 科技背景（5 变体）+ 逐字解码 的共享 CSS。四模板经 <!--HF_FXCSS--> 注入，避免复制多份。 */
export const FX_CSS = `
      /* 科技感背景变体（--bg=grid|aurora|matrix|synth|mesh 切换） */
      #techbg { position: absolute; inset: 0; z-index: 0; overflow: hidden; }
      #techbg .vig { position: absolute; inset: 0; box-shadow: inset 0 0 420px rgba(0,0,0,.72); }
      .bg-grid { background: radial-gradient(1200px 900px at 50% 20%, rgba(34,98,168,.38), transparent 62%), radial-gradient(1100px 850px at 82% 92%, rgba(96,52,168,.30), transparent 60%), linear-gradient(165deg, #0a0e1a, #0d1117 55%, #080a11); }
      .bg-grid .mv { position: absolute; inset: -25%; background-image: linear-gradient(rgba(96,178,255,.11) 2px, transparent 2px), linear-gradient(90deg, rgba(96,178,255,.11) 2px, transparent 2px); background-size: 80px 80px; -webkit-mask-image: radial-gradient(circle at 50% 45%, #000 52%, transparent 84%); mask-image: radial-gradient(circle at 50% 45%, #000 52%, transparent 84%); }
      .bg-grid .sweep { position: absolute; top: -50%; left: -30%; width: 55%; height: 200%; background: linear-gradient(105deg, transparent, rgba(120,200,255,.10), transparent); transform: skewX(-12deg); }
      .bg-aurora { background: linear-gradient(160deg, #07101a, #0a1020 60%, #0b0a18); }
      .bg-aurora .mv { position: absolute; inset: -30%; filter: blur(30px); background: radial-gradient(600px 380px at 30% 30%, rgba(40,180,150,.34), transparent 60%), radial-gradient(680px 420px at 72% 40%, rgba(60,120,230,.32), transparent 62%), radial-gradient(560px 400px at 50% 80%, rgba(150,60,210,.30), transparent 62%); }
      .bg-matrix { background: linear-gradient(180deg, #020806, #04120b 50%, #020806); }
      .bg-matrix .mv { position: absolute; left: 0; right: 0; top: -100%; height: 200%; opacity: .5; background-image: repeating-linear-gradient(0deg, rgba(0,255,140,.18) 0 2px, transparent 2px 26px); -webkit-mask-image: repeating-linear-gradient(90deg, #000 0 4px, transparent 4px 42px); mask-image: repeating-linear-gradient(90deg, #000 0 4px, transparent 4px 42px); }
      .bg-synth { background: linear-gradient(180deg, #160a2a 0%, #2a1150 42%, #4a1a5e 52%, #0a0618 52%, #0a0618 100%); }
      .bg-synth .sun { position: absolute; left: 50%; top: 34%; width: 520px; height: 520px; transform: translate(-50%,-50%); border-radius: 50%; background: radial-gradient(circle, #ff8a3d 0%, #ff4d8d 46%, rgba(255,77,141,0) 70%); filter: blur(6px); }
      .bg-synth .mv { position: absolute; left: -20%; right: -20%; bottom: 0; height: 48%; transform: perspective(320px) rotateX(72deg); transform-origin: bottom; background-image: linear-gradient(rgba(255,90,200,.5) 2px, transparent 2px), linear-gradient(90deg, rgba(120,120,255,.45) 2px, transparent 2px); background-size: 70px 70px; }
      .bg-mesh { background: radial-gradient(900px 700px at 28% 26%, rgba(70,40,150,.42), transparent 60%), radial-gradient(1000px 800px at 78% 74%, rgba(30,70,150,.36), transparent 62%), linear-gradient(160deg, #060812, #0a0a16 60%, #05040d); }
      .bg-mesh .mv { position: absolute; inset: 0; opacity: .5; background-image: radial-gradient(rgba(150,180,255,.25) 1.5px, transparent 1.5px); background-size: 46px 46px; -webkit-mask-image: radial-gradient(circle at 50% 50%, #000 40%, transparent 80%); mask-image: radial-gradient(circle at 50% 50%, #000 40%, transparent 80%); }
      /* 逐字解码/故障风：每字叠「乱码层 .gh + 最终字 .fin」，靠 opacity 点亮做扫描→锁定 */
      .twc { position: relative; display: inline-block; }
      .twc .gh { position: absolute; left: 0; top: 0; color: #5cf; text-shadow: 0 0 18px rgba(90,200,255,.95), 0 0 4px rgba(90,200,255,.9); }
      .twc .fin { text-shadow: 0 0 12px rgba(120,190,255,.45); }`

/**
 * 逐字解码运行时（经 <!--HF_DECODE--> 注入各模板 <script>，须在 tl 定义后、__timelines 赋值前）。
 * .tw 文字拆单字，随所属 clip 的 data-start 逐字敲出，每字先闪 K 帧青色乱码鬼影(.gh)再锁定(.fin)。
 * 全程只动 opacity——不改 textContent（后者逐帧 seek 下不生效，见 injectAudioCaptions 注释）。
 */
export const DECODE_RUNTIME = `(function () {
        var POOL = '日月火水木金土山川云电系统数据端口零一二三ABCDEF0123456789#@%&*<>/|=+アイウエオカキクケコサシスセソ';
        function rc() { return POOL[(Math.random() * POOL.length) | 0]; }
        var K = 5, gstep = 0.045;
        document.querySelectorAll('.tw').forEach(function (el) {
          var clip = el.closest('.clip') || el;
          var start = parseFloat(clip.getAttribute('data-start') || '0');
          var chars = Array.from(el.textContent);
          el.textContent = '';
          var step = Math.min(0.055, 1.1 / Math.max(1, chars.length));
          chars.forEach(function (ch, i) {
            var t0 = start + i * step;
            var c = document.createElement('span'); c.className = 'twc';
            if (ch === ' ') { c.innerHTML = '&nbsp;'; el.appendChild(c); tl.set(c, { opacity: 0 }, 0); tl.set(c, { opacity: 1 }, t0); return; }
            var fin = document.createElement('span'); fin.className = 'fin'; fin.textContent = ch; c.appendChild(fin);
            var ghosts = [];
            for (var j = 0; j < K; j++) { var g = document.createElement('span'); g.className = 'gh'; g.textContent = rc(); c.appendChild(g); ghosts.push(g); }
            el.appendChild(c);
            tl.set(c, { opacity: 0 }, 0); tl.set(c, { opacity: 1 }, t0);
            tl.set(fin, { opacity: 0 }, 0);
            ghosts.forEach(function (g, j) { tl.set(g, { opacity: 0 }, 0); tl.set(g, { opacity: 1 }, t0 + j * gstep); tl.set(g, { opacity: 0 }, t0 + (j + 1) * gstep); });
            tl.set(fin, { opacity: 1 }, t0 + K * gstep);
          });
        });
      })();`

/**
 * 注入科技背景 + 解码运行时到模板。填 <!--HF_FXCSS-->（CSS）、<!--HF_DECODE-->（解码脚本），
 * bg 提供时再填 <!--HF_BG-->（背景 DOM）与 <!--HF_BGANIM-->（GSAP 微动）；bg 省略/none 则背景标记清空
 * （story 聊天场不加科技背景但仍要解码卖点/CTA）。全用函数 replacer 避免 $& 被当替换模式。
 */
export function injectTechFx(html: string, opts: { bg?: string; durationSec: number }): string {
  let out = html
    .replace('<!--HF_FXCSS-->', () => FX_CSS)
    .replace('<!--HF_DECODE-->', () => DECODE_RUNTIME)
  if (opts.bg && opts.bg !== 'none') {
    const bg = buildTechBg(resolveTechBg(opts.bg), opts.durationSec)
    out = out.replace('<!--HF_BG-->', () => `<div id="techbg" class="${bg.cls}">${bg.inner}</div>`).replace('<!--HF_BGANIM-->', () => bg.anim)
  } else {
    out = out.replace('<!--HF_BG-->', () => '').replace('<!--HF_BGANIM-->', () => '')
  }
  return out
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
export function injectAudioCaptions(html: string, audioRel: string | null, cues: Cue[], durationSec: number, captions = true): string {
  const audioTag = audioRel
    ? `<audio id="narration" class="clip" data-start="0" data-duration="${durationSec}" data-track-index="0" data-audio="true" src="assets/narration.wav"></audio>`
    : ''
  // 字幕默认烧进片；captions=false 则不注入（用户在平台自配字幕，避免底部文字杂乱）。
  // 字幕不做逐字解码（会显乱），保持整齐——解码只用于标题大字（见各模板 .tw）。
  const capClips = captions
    ? cues.map((c) => {
        const dur = Math.max(0.5, c.end - c.start)
        return `<div class="cap clip" data-start="${c.start}" data-duration="${dur}" data-track-index="9">${escapeHtml(c.text)}</div>`
      }).join('\n')
    : ''
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

/** 自动卡点方案：轮播窗口 [6, durationSec-6) 内每隔 cadence 拍取一刀，beat=拍序号，shot=k%shotCount。 */
export function autoCutPlan(grid: { t0: number; T: number }, shotCount: number, durationSec: number, cadence: number): Array<{ beat: number; shot: number }> {
  if (shotCount <= 0 || !(grid.T > 0)) return []
  const carStart = 6, carEnd = Math.max(7, durationSec - 6)
  const nStart = Math.max(0, Math.ceil((carStart - grid.t0) / grid.T - 1e-9))
  // cadence 非法（0/负/NaN）时步进不前进甚至往 -∞ 走会死循环——规整为 ≥1 的整数步进，非法回落 4
  const step = Number.isFinite(cadence) && cadence >= 1 ? Math.floor(cadence) : 4
  const cuts: Array<{ beat: number; shot: number }> = []
  let k = 0
  for (let n = nStart; grid.t0 + n * grid.T < carEnd; n += step) {
    cuts.push({ beat: n, shot: k % shotCount }); k++
  }
  return cuts
}

/** 方案每刀 → 时间：start = t0 + offsetSec + beat×T；shot 钳到 [0,shotCount-1]；按 start 升序。 */
export function planCutTimes(plan: { grid: { t0: number; T: number }; offsetSec: number; cuts: Array<{ beat: number; shot: number }> }, shotCount: number): Array<{ start: number; shot: number }> {
  if (shotCount <= 0) return []
  return plan.cuts
    .map((c) => ({ start: plan.grid.t0 + plan.offsetSec + c.beat * plan.grid.T, shot: Math.max(0, Math.min(shotCount - 1, c.shot)) }))
    .sort((a, b) => a.start - b.start)
}

/**
 * 组装 demo 模板的分镜段（填 <!--HF_SECTIONS-->）+ 图片强拍弹跳（填 <!--HF_ACCENTS-->）。
 * 五段：钩子→痛点→截图轮播→报价→CTA。碰头/痛点/报价/CTA 固定 3s。
 * **截图轮播卡点**：有节拍网格时每 4 拍切一张、图不够循环轮播（切点踩拍）；无网格退回按图数均分。
 * 每张切进来时在拍点上轻微放大回落一下（`accents`，作用在图片 clip 上，读作卡点）。
 * 竖图套手机外框（.phone），横图居中缩放 + 同图虚化背景（.wide*）。文本全 escapeHtml。
 */
export function buildDemoSections(opts: {
  hookTitle: string; painPoints: string[]; priceAnchor: string; cta: string; brandName: string
  shots: Shot[]; durationSec: number; beats?: number[]; plan?: { cuts: Array<{ start: number; shot: number }> }
}): { html: string; accents: string } {
  const { hookTitle, painPoints, priceAnchor, cta, brandName, shots, durationSec, beats, plan } = opts
  const clip = (start: number, dur: number, track: number, inner: string, id?: string) =>
    `<div class="clip"${id ? ` id="${id}"` : ''} data-start="${start}" data-duration="${dur}" data-track-index="${track}">${inner}</div>`
  const carStart = 6, carEnd = Math.max(carStart + 1, durationSec - 6)

  // 是否需要图片弹跳强调：有节拍网格，或用了卡点方案（方案本身就是卡点，同样按刀弹一下）
  const hasBeats = !!(beats && beats.length) || !!(plan && plan.cuts.length)

  let carClips: Array<{ id: string; start: number; dur: number; shot: Shot }>
  if (plan && plan.cuts.length) {
    // 方案模式：用方案 cuts（过滤超出窗口末的），时长到下一刀/carEnd
    const pc = plan.cuts.filter((c) => c.start >= carStart && c.start < carEnd).sort((a, b) => a.start - b.start)
    carClips = pc.map((c, k) => ({
      id: `car${k}`, start: c.start, dur: (pc[k + 1]?.start ?? carEnd) - c.start,
      shot: shots[Math.max(0, Math.min(shots.length - 1, c.shot))],
    }))
  } else {
    // 自动模式（现有逻辑）：每 4 拍一刀 / 图数均分
    let cutStarts: number[] = []
    if (hasBeats) {
      const win = beats!.filter((b) => b >= carStart && b < carEnd)
      cutStarts = win.filter((_, i) => i % 4 === 0) // 每 4 拍取一刀
    }
    if (cutStarts.length < 2) {
      // 无 BGM / 窗口内拍太少：退回按图数均分（与原行为一致，保证有图能播）
      const per = shots.length ? (carEnd - carStart) / shots.length : 0
      cutStarts = shots.map((_, i) => carStart + i * per)
    }
    // 每刀循环取一张图；时长 = 到下一刀（末刀到 carEnd）
    carClips = cutStarts.map((start, k) => ({
      id: `car${k}`, start, dur: (cutStarts[k + 1] ?? carEnd) - start, shot: shots[k % shots.length],
    }))
  }

  const painHtml = painPoints.map((p) => `<div class="pain tw">· ${escapeHtml(p)}</div>`).join('')

  // 段顺序（时间先后）：hook(0,3)→pain(3,3)→轮播各刀→price(dur-6,3)→cta(dur-3,3)
  // 一次性顺序吸附（防相邻段吸到同一拍/倒序）
  const segs = [
    { start: 0, dur: 3 },
    { start: 3, dur: 3 },
    ...carClips.map((c) => ({ start: c.start, dur: c.dur })),
    { start: durationSec - 6, dur: 3 },
    { start: durationSec - 3, dur: 3 },
  ]
  const st = snapStarts(segs, beats)

  const shotBody = (s: Shot) => {
    // 文件名由操作者放入，转义 + encodeURI 防属性/CSS url 破坏
    const src = escapeHtml(`assets/${encodeURI(s.rel)}`)
    return s.orientation === 'portrait'
      ? `<div class="phoneWrap"><div class="phone"><img src="${src}"/></div></div>`
      : `<div class="wideWrap"><div class="wideBg" style="background-image:url('${src}')"></div><div class="wideFg"><img src="${src}"/></div></div>`
  }
  const nCar = carClips.length
  const carHtml = carClips.map((c, k) => clip(st[2 + k], c.dur, 2, shotBody(c.shot), c.id)).join('\n')
  const html = [
    clip(st[0], 3, 1, `<div class="fill pad center"><div class="hookT tw">${escapeHtml(hookTitle)}</div></div>`),
    clip(st[1], 3, 1, `<div class="fill pad painWrap">${painHtml}</div>`),
    carHtml,
    clip(st[2 + nCar], 3, 1, `<div class="fill pad center"><div class="price tw">${escapeHtml(priceAnchor)}</div></div>`),
    clip(st[2 + nCar + 1], 3, 1, `<div class="fill pad center"><div class="cta tw">${escapeHtml(cta)}</div><div class="brand">@${escapeHtml(brandName)}</div></div>`),
  ].join('\n')

  // 图片弹跳：每张切进来时（吸附后的 start，与画面切同拍）scale 1→1.06→1.0 弹一下。
  // 用 keyframes 不依赖 EasePack；挂主线 tl（HF seek 暂停 tl 逐帧渲）。无 BGM 不弹。
  const accents = hasBeats
    ? carClips.map((_, k) =>
        `tl.to("#car${k}", { keyframes: [{ scale: 1.06, duration: 0.08 }, { scale: 1.0, duration: 0.12 }] }, ${st[2 + k]});`,
      ).join('\n')
    : ''
  return { html, accents }
}

/**
 * 组装 story 模板分镜段（填 <!--HF_SECTIONS-->）。三段：聊天场→卖点→CTA。
 * 聊天场吸收前段（0..dur-6），卖点/CTA 固定各 3s。气泡文本 escapeHtml。
 */
export function buildStorySections(opts: {
  bubbles: Array<{ who: 'them' | 'me'; text: string }>; sellingPoint: string; cta: string; brandName: string
  durationSec: number; beats?: number[]
}): string {
  const { bubbles, sellingPoint, cta, brandName, durationSec, beats } = opts
  const clip = (start: number, dur: number, track: number, inner: string) =>
    `<div class="clip" data-start="${start}" data-duration="${dur}" data-track-index="${track}">${inner}</div>`
  const bubbleHtml = bubbles.map((b) => `<div class="bubble ${b.who}">${escapeHtml(b.text)}</div>`).join('')
  const chatDur = Math.max(1, durationSec - 6)
  // 段顺序：chat(0, chatDur)→sell(dur-6,3)→cta(dur-3,3)。有节拍网格时一次性顺序吸附
  const st = snapStarts([
    { start: 0, dur: chatDur },
    { start: durationSec - 6, dur: 3 },
    { start: durationSec - 3, dur: 3 },
  ], beats)
  return [
    clip(st[0], chatDur, 1, `<div class="chat">${bubbleHtml}</div>`),
    clip(st[1], 3, 1, `<div class="fill pad center sellFill"><div class="sell tw">${escapeHtml(sellingPoint)}</div></div>`),
    clip(st[2], 3, 1, `<div class="fill pad center sellFill"><div class="cta tw">${escapeHtml(cta)}</div><div class="brand">@${escapeHtml(brandName)}</div></div>`),
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

/**
 * 填 <!--HF_ACCENTS--> 标记为 GSAP 关键帧行（无强调则清空标记）。accentLines 由各模板自备：
 * demo 传截图弹跳（见 buildDemoSections），story/flash/changelog 这类静态文字场传 '' 不加脉冲。
 * 关键帧行必须挂主时间线 `tl`（`tl.to(...)`）——HyperFrames 靠 seek 暂停的 tl 逐帧渲染，
 * 裸 gsap.to 不受 tl 时间轴控制、加载时就实时跑完，渲不出来。
 */
export function fillAccents(html: string, accentLines: string): string {
  return html.replace('<!--HF_ACCENTS-->', () => accentLines)
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
