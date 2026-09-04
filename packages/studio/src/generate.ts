import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { advanceStage, type CoreCtx } from '@forgecast/core'
import { parseCopyOutput } from '@forgecast/copywriter'
import { analyzeBeats, chooseBgmPath, injectAudioCaptions, injectTechFx, fillAccents, fillTemplate, mixAudio, pickBgm, readShots, readTemplate, renderHyperframes, resolveTechBg, scaffoldHfAssets, scaffoldHfProject } from './hyperframes'
import { renderRemotion } from './remotion-render'
import type { BeatGrid, Shot } from './hyperframes'
import { lower, type LowerPlan } from './lower'
import { buildSemantic } from './semantic'
import { renderSpecToHtml } from './render-html'
import { synthesizeVoice } from './tts'
import { ASPECT_DIMENSIONS, bucketCuesBySegments, computeSegmentWindows, customTemplateHtmlPath } from './custom-template'
import type { Pacing } from './benchmark'
import { MIN_DURATION, type AudioSpec, type VideoSpec } from './videospec'

export interface GenerateVideoInput {
  slug: string
  assetId?: number
  tpl?: string
  /** talk 专用：口播底片的上传素材 id（assets 里 type='video' 且 origin='upload' 的行）。
   *  talk 模板必填，其余模板忽略。 */
  uploadAssetId?: number
  /** 渲染参数覆盖：缺省则用 ctx.config.video.* 的值。server 是长驻进程、ctx 是所有请求共享的单例，
   *  这几个覆盖值只在本次调用内生效（算一份局部 video 配置），绝不 mutate ctx.config.video——
   *  CLI 短进程里直接突变 ctx.config.video 是安全的，但 server 这样做会污染后续请求，是必须绕开的坑。 */
  bgm?: string
  mood?: string
  bg?: string
  captions?: boolean
  /** 画布比例：仅 flash 模板支持横竖屏切换，其余模板固定竖屏不受此参数影响。缺省 portrait。 */
  ratio?: 'portrait' | 'landscape'
  onProgress?: (msg: string) => void
}
export interface GeneratedVideo { assetId: number; filePath: string }
/** 传给 renderAndRegister，渲染后驱动 mixAudio 的参数（与 mixAudio 的 opts 对齐，去掉 deps）。 */
type AudioMix = { bgmPath: string; sfxPath: string | null; strongBeats: number[]; durationSec: number }

/**
 * BGM 选曲 + 节拍分析，全程 fail-soft：
 * - `video.bgm === 'none'`（`--no-bgm`）或曲库为空 → grid=null、audioMix=undefined，调用方完全跳过。
 * - 节拍分析失败（analyzeBeats 返 null）→ 仍加 BGM，但不卡点（strongBeats 空），打 ⚠，
 *   同时把原因 push 进 `warnings`（供最终落 assets.warnings，见 renderAndRegister）。
 */
type VideoCfg = CoreCtx['config']['video']

async function selectBgm(
  ctx: CoreCtx, video: VideoCfg, durationSec: number, onProgress: (m: string) => void, hook: string, warnings: string[] = [],
): Promise<{ grid: BeatGrid | null; audioMix: AudioMix | undefined }> {
  let grid: BeatGrid | null = null
  let audioMix: AudioMix | undefined
  const bgmDir = path.join(ctx.config.paths.templates, 'bgm')
  // 优先级链：--bgm 指定 > --mood > hook 自动映射情绪 > 根回落 > none/空→不加
  const bgmPath = chooseBgmPath(bgmDir, { bgm: video.bgm, mood: video.mood, hook }, Math.random)
  if (bgmPath && video.beatPython && video.mode !== 'stub') {
    grid = await analyzeBeats(bgmPath, video.beatPython)
    if (!grid) {
      onProgress('⚠ 节拍分析失败，加 BGM 但不卡点')
      warnings.push('节拍分析失败，加 BGM 但不卡点')
    }
    const sfxDir = path.join(ctx.config.paths.templates, 'sfx')
    const sfxPath = pickBgm(sfxDir) // 复用：取 sfx 目录第一个（不分情绪）
    audioMix = { bgmPath, sfxPath, strongBeats: grid?.strongBeats ?? [], durationSec }
  }
  return { grid, audioMix }
}

function canvasFor(ratio: 'portrait' | 'landscape'): { width: number; height: number } {
  return ASPECT_DIMENSIONS[ratio]
}

/** 取 copy 素材 → 解析 → 按 tpl 组装参数（flash 三段文字 / story 气泡+TTS配音字幕）→ 写 props.json → 渲染 mp4 → 登记 video 素材 */
export async function generateVideo(ctx: CoreCtx, input: GenerateVideoInput): Promise<GeneratedVideo> {
  const { slug, onProgress = () => {} } = input
  const tpl = input.tpl ?? 'flash'
  // 局部生效的渲染配置：覆盖值缺省则用 ctx.config.video.*，绝不 mutate ctx.config.video 本体（见 GenerateVideoInput 注释）
  const video: VideoCfg = {
    ...ctx.config.video,
    ...(input.bgm !== undefined && { bgm: input.bgm }),
    ...(input.mood !== undefined && { mood: input.mood }),
    ...(input.bg !== undefined && { bg: input.bg }),
    ...(input.captions !== undefined && { captions: input.captions }),
  }
  const project: any = ctx.db.prepare('SELECT * FROM projects WHERE slug = ?').get(slug)
  if (!project) throw new Error(`项目不存在: ${slug}`)

  const copy: any = input.assetId
    ? ctx.db.prepare("SELECT * FROM assets WHERE id = ? AND project_id = ? AND type = 'copy'").get(input.assetId, project.id)
    : ctx.db.prepare("SELECT * FROM assets WHERE project_id = ? AND type = 'copy' ORDER BY id DESC LIMIT 1").get(project.id)
  if (!copy) throw new Error(`没有可用的文案素材（先在素材工坊生成文案）: ${slug}`)

  onProgress('解析文案、组装视频参数…')
  const doc = parseCopyOutput(fs.readFileSync(path.join(ctx.config.paths.workspace, copy.file_path), 'utf8'))
  const brandName = project.brand_name ?? slug
  const ratio = input.ratio ?? 'portrait'

  if (tpl.startsWith('custom-')) {
    const id = Number(tpl.slice('custom-'.length))
    if (!Number.isFinite(id)) throw new Error(`非法自定义模板标识: ${tpl}`)
    const row: any = ctx.db.prepare('SELECT * FROM custom_templates WHERE id = ?').get(id)
    if (!row) throw new Error(`自定义模板不存在: ${tpl}`)
    return renderCustomTemplate(ctx, row, { slug, doc, hook: copy.hook, projectId: project.id, video, onProgress, sourceAssetId: Number(copy.id) })
  }

  // demo：产品截图轮播。读 shots/，无图报错退出（本模板无图即无意义）——需在通用管线前处理
  if (tpl === 'demo') {
    const shots = readShots(path.join(ctx.config.paths.workspace, slug, 'shots'))
    if (!shots.length) throw new Error(`demo 模板需要产品截图，请放入 workspace/${slug}/shots/（png/jpg/webp）`)
    const shotAssets: Record<string, Buffer> = {}
    for (const sh of shots) shotAssets[sh.rel] = fs.readFileSync(path.join(ctx.config.paths.workspace, slug, 'shots', sh.rel))
    return renderHfPipeline(ctx, {
      slug, tpl: 'demo', doc, hook: copy.hook, brandName, projectId: project.id, video, ratio, onProgress, shots, shotAssets,
      sourceAssetId: Number(copy.id),
    })
  }

  // talk：口播合成。与五模板的 renderHfPipeline **平行**的独立分支——不跑 TTS、不产 index.html，
  // 底片是用户上传的口播视频（软链进 hf 目录），动效层叠在上面。
  if (tpl === 'talk') {
    return renderTalkPipeline(ctx, {
      slug, doc, hook: copy.hook, brandName, projectId: project.id, video, ratio, onProgress,
      sourceAssetId: Number(copy.id), uploadAssetId: input.uploadAssetId, bgExplicit: input.bg,
    })
  }

  if (tpl === 'changelog' || tpl === 'insight' || tpl === 'story') {
    return renderHfPipeline(ctx, { slug, tpl, doc, hook: copy.hook, brandName, projectId: project.id, video, ratio, onProgress, sourceAssetId: Number(copy.id) })
  }

  // 兜底：未知 tpl 与 tpl==='flash' 一样都走 flash（原版行为，见下方分支硬编码 'flash'）
  return renderHfPipeline(ctx, { slug, tpl: 'flash', doc, hook: copy.hook, brandName, projectId: project.id, video, ratio, onProgress, sourceAssetId: Number(copy.id) })
}

/**
 * 统一管线：buildSemantic → lower → renderSpecToHtml → fillTemplate/inject* → scaffold → render。
 * 覆盖 flash/story/demo/changelog/insight 五个 HyperFrames 模板（custom-* 走独立的 renderCustomTemplate，
 * 它的 HTML 由 LLM/固定模板产出、按分段占位符填充，不是 Layer 模型，见该函数注释）。
 */
async function renderHfPipeline(
  ctx: CoreCtx,
  opts: {
    slug: string
    tpl: 'flash' | 'story' | 'demo' | 'changelog' | 'insight'
    doc: ReturnType<typeof parseCopyOutput>
    hook: string | null
    brandName: string
    projectId: number
    video: VideoCfg
    ratio: 'portrait' | 'landscape'
    onProgress: (m: string) => void
    shots?: Shot[]
    shotAssets?: Record<string, Buffer>
    sourceAssetId?: number
  },
): Promise<GeneratedVideo> {
  const { slug, tpl, doc, hook, brandName, projectId, video, ratio, onProgress, shots = [], shotAssets, sourceAssetId } = opts
  const videoId = randomUUID()
  const hfDir = path.join(ctx.config.paths.workspace, slug, 'hf', videoId)

  onProgress('TTS 配音…')
  const wavAbs = path.join(hfDir, 'assets', 'narration.wav')
  const voice = await synthesizeVoice(ctx, doc.douyinScript, wavAbs)
  const warnings: string[] = []
  if (voice.degraded) {
    onProgress(`⚠ TTS 降级：${voice.degraded}`)
    warnings.push(`TTS 降级：${voice.degraded}`)
  }
  const lastEnd = voice.cues.length ? voice.cues[voice.cues.length - 1].end : 0
  const duration = Math.max(MIN_DURATION[tpl], Math.ceil(lastEnd))

  // BGM / 卡点方案解析：demo 支持 cutplan.json 钉曲，其余模板都走自动选曲（fail-soft）
  let grid: BeatGrid | null = null
  let audioMix: AudioMix | undefined
  let plan: LowerPlan | null = null
  if (tpl === 'demo') {
    const planPath = path.join(ctx.config.paths.workspace, slug, 'cutplan.json')
    let cutPlan: any = null
    if (fs.existsSync(planPath)) { try { cutPlan = JSON.parse(fs.readFileSync(planPath, 'utf8')) } catch { cutPlan = null } }
    if (cutPlan?.bgm && cutPlan?.grid && typeof cutPlan.grid.T === 'number' && typeof cutPlan.grid.t0 === 'number'
      && fs.existsSync(path.join(ctx.config.paths.templates, 'bgm', cutPlan.bgm))) {
      grid = cutPlan.grid
      plan = { grid: { t0: cutPlan.grid.t0, T: cutPlan.grid.T }, offsetSec: cutPlan.offsetSec ?? 0, cuts: cutPlan.cuts }
      if (video.mode !== 'stub') {
        const bgmAbs = path.join(ctx.config.paths.templates, 'bgm', cutPlan.bgm)
        const sfxPath = pickBgm(path.join(ctx.config.paths.templates, 'sfx'))
        audioMix = { bgmPath: bgmAbs, sfxPath, strongBeats: cutPlan.grid.strongBeats ?? [], durationSec: duration }
      }
    } else {
      if (cutPlan?.bgm) {
        onProgress('⚠ 卡点方案曲子不存在，改用自动卡点')
        warnings.push('卡点方案曲子不存在，改用自动卡点')
      }
      const sel = await selectBgm(ctx, video, duration, onProgress, hook ?? '', warnings)
      grid = sel.grid; audioMix = sel.audioMix
    }
  } else {
    const sel = await selectBgm(ctx, video, duration, onProgress, hook ?? '', warnings)
    grid = sel.grid; audioMix = sel.audioMix
  }

  const canvas = canvasFor(ratio)
  const audioSpec: AudioSpec = {
    narration: voice.audioRel ? { src: voice.audioRel, degraded: voice.degraded ?? null } : null,
    bgm: audioMix ? { src: audioMix.bgmPath, mood: video.mood || null } : null,
    beatGrid: grid ? { t0: grid.t0, T: grid.T, bpm: grid.bpm, strongBeats: grid.strongBeats } : null,
    captionsEnabled: video.captions,
  }

  const semantic = buildSemantic(doc, tpl, { cues: voice.cues, brandName, sourceAssetId })
  const spec = lower(semantic, {
    videoId, slug, template: tpl, canvas, durationSec: duration, cues: voice.cues,
    beatGrid: grid, shots, plan, audio: audioSpec, brandName,
  })
  spec.warnings = warnings

  const rendered = renderSpecToHtml(spec)
  const ratioSuffix = ratio === 'landscape' ? '-landscape' : ''
  let html = fillTemplate(readTemplate(`${tpl}${ratioSuffix}`), { duration: String(duration) })
  html = html.replace('<!--HF_SECTIONS-->', () => rendered.html)
  // 背景变体**只解析一次**，HTML 与 Remotion 两处共用：video.bg='random' 时各自随机会让
  // 写进 hf 目录的 index.html 与实际渲出的背景对不上（Task 10 拿这份 HTML 做预览就会预览≠成片）。
  const bgVariant = resolveBgVariant(tpl, video.bg)
  // 必须在 renderAndRegister（内部先渲染、后落盘 spec）**之前**盖上：随机变体只解析一次，
  // 落盘的 spec 与传给渲染的 inputProps 才是同一个值，Web 预览的背景才等于成片。
  spec.bgVariant = bgVariant
  // story 特判：不加科技背景（保聊天真截图感）；其余四个模板都套 techFx
  html = injectTechFx(html, { bg: bgVariant, durationSec: duration })
  // 字幕已由 lower() 按 audio.captionsEnabled 生成进 spec.layers（随 rendered.html 一并注入），
  // 这里只负责音轨标记；captions 固定传 false，避免 HF_CAPTIONS 标记被重复注入一份字幕。
  html = injectAudioCaptions(html, voice.audioRel, voice.cues, duration, false)
  html = fillAccents(html, rendered.accents)
  scaffoldHfProject(hfDir, html, shotAssets)
  return renderAndRegister(ctx, hfDir, slug, tpl, hook, projectId, onProgress, spec, audioMix,
    { engine: 'remotion', bgVariant })
}

/**
 * 科技背景变体的取值规则（HTML 与 Remotion 两条渲染路径共用，解析一次）：
 * - story：一律不加背景（保微信聊天截图观感）；
 * - 其余模板：走 video.bg，`random`/`auto` 随机挑一套，`none`/空则不加背景。
 * 组件侧绝不再随机——每帧重算会让画面闪烁（见 SpecView 注释）。
 */
export function resolveBgVariant(
  tpl: string, bg: string | undefined, rand?: () => number,
): string | undefined {
  if (tpl === 'story') return undefined
  return resolveTechBg(bg || 'none', rand)
}

/** ffprobe 量片源时长（秒）。30s 超时；拿不到就抛——talk 的整条时间轴都从这个值算出来，
 *  猜一个默认值只会产出「时长对不上、后半段黑屏」的成片，不如当场失败。 */
export async function probeDurationSec(absPath: string, timeoutMs = 30_000): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const fail = (why: string) => reject(new Error(`无法读取口播素材时长：${why}`))
    const child = spawn('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', absPath])
    let out = ''
    let err = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill('SIGKILL')
      fail(`ffprobe 超时（${timeoutMs}ms）`)
    }, timeoutMs)
    timer.unref?.()
    child.stdout.on('data', (d) => { out += String(d) })
    child.stderr.on('data', (d) => { err += String(d) })
    child.on('error', (e) => {
      if (settled) return
      settled = true; clearTimeout(timer); fail(e instanceof Error ? e.message : String(e))
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true; clearTimeout(timer)
      const sec = Number.parseFloat(out.trim())
      if (code !== 0 || !Number.isFinite(sec) || sec <= 0) fail(err.trim() || `ffprobe 退出码 ${code}，输出「${out.trim()}」`)
      else resolve(+sec.toFixed(4))
    })
  })
}

/**
 * talk（口播合成）管线：与 renderHfPipeline **平行**，不是它的一个分支。三处根本差异决定了必须分开：
 * 1. 无 TTS——声音就在片源里，narration 恒 null、cues 恒空、captionsEnabled 恒 false
 *    （人声字幕由剪辑台手动打，见 lower.ts 的 talk 兜底）；
 * 2. 不产 index.html——`templates/hf/` 里没有 talk.html，readTemplate 会直接抛；talk 只走 Remotion；
 * 3. 时长不由文案/旁白决定，而是 ffprobe 量出来的片源时长（成片就是这段口播本身）。
 *
 * 片源零拷贝：把片源**所在目录**整体软链成 `hf/<videoId>/assets/talk-src`，src 写
 * `assets/talk-src/<原文件名>`（几百 MB 的口播不该每生成一版拷一份）。
 * **必须链目录、不能链文件**：Remotion 静态服务器（serve-handler 用 lstat）对最终路径是软链的
 * 文件一律 404，但路径中间的软链目录由内核解析、不受影响——同一条事实见 remotion-render.ts 的
 * linkPublicDirToBundleRoot 注释；bundle 的 copy-dir 也保留目录软链（绝对化目标、不复制本体）。
 * 软链不可用的文件系统（某些挂载卷/Windows 无权限）回落真拷贝并记一条 warning——比整条渲染失败强。
 */
async function renderTalkPipeline(
  ctx: CoreCtx,
  opts: {
    slug: string
    doc: ReturnType<typeof parseCopyOutput>
    hook: string | null
    brandName: string
    projectId: number
    video: VideoCfg
    ratio: 'portrait' | 'landscape'
    onProgress: (m: string) => void
    sourceAssetId?: number
    uploadAssetId?: number
    /** 用户**显式**传的 --bg（`input.bg`），与 video.bg 不同：后者含配置默认值 'grid'。
     *  talk 默认不加科技背景（底片是真人画面，再叠一层网格只会脏），只有显式指定才加。 */
    bgExplicit?: string
  },
): Promise<GeneratedVideo> {
  const { slug, doc, hook, brandName, projectId, video, ratio, onProgress, sourceAssetId, uploadAssetId, bgExplicit } = opts
  if (typeof uploadAssetId !== 'number') throw new Error('talk 模板需要口播素材：请先上传口播视频并选中它')
  const upload: any = ctx.db.prepare(
    "SELECT * FROM assets WHERE id = ? AND project_id = ? AND type = 'video' AND origin = 'upload'",
  ).get(uploadAssetId, projectId)
  if (!upload) throw new Error(`口播素材不存在或不是本项目上传的视频: ${uploadAssetId}`)
  const srcAbs = path.join(ctx.config.paths.workspace, upload.file_path)

  onProgress('读取口播素材时长…')
  const durationSec = await probeDurationSec(srcAbs)

  const videoId = randomUUID()
  const hfDir = path.join(ctx.config.paths.workspace, slug, 'hf', videoId)
  scaffoldHfAssets(hfDir)   // 建 assets/ + 字体软链；index.html 那半边 talk 不需要

  const warnings: string[] = []
  const srcBase = path.basename(srcAbs)
  const linkDir = path.join(hfDir, 'assets', 'talk-src')
  const videoSrc = `assets/talk-src/${srcBase}`
  // 绝对目标：片源在 workspace/<slug>/uploads/ 下，与 hf 目录不同支，相对链没有可移植性优势
  try {
    fs.symlinkSync(path.dirname(srcAbs), linkDir, 'dir')
  } catch {
    // 回落：把 talk-src 建成真目录，片源真拷进去——src 形态不变，下游（spec/剪辑台/渲染）无感
    fs.mkdirSync(linkDir, { recursive: true })
    fs.copyFileSync(srcAbs, path.join(linkDir, srcBase))
    onProgress('⚠ 文件系统不支持软链，已复制口播素材')
    warnings.push('文件系统不支持软链，已复制口播素材')
  }

  const { grid, audioMix } = await selectBgm(ctx, video, durationSec, onProgress, hook ?? '', warnings)
  const audioSpec: AudioSpec = {
    narration: null,                 // 声音在片源里，不做 TTS
    bgm: audioMix ? { src: audioMix.bgmPath, mood: video.mood || null } : null,
    beatGrid: grid ? { t0: grid.t0, T: grid.T, bpm: grid.bpm, strongBeats: grid.strongBeats } : null,
    captionsEnabled: false,          // 人声字幕手动打，不由 cues 自动生成
  }

  const semantic = buildSemantic(doc, 'talk', { brandName, sourceAssetId })
  // 视频层的 from 指向 'sec-video'（lowerTalk 的跨任务约定）——这个 section 由本管线追加，
  // buildSemantic 不产（它只认文案里的语义段）。role 借用 'demo'：片源就是"演示画面"这一类。
  semantic.sections.push({ id: 'sec-video', role: 'demo' })

  const spec = lower(semantic, {
    videoId, slug, template: 'talk', canvas: canvasFor(ratio), durationSec,
    cues: [], beatGrid: grid, audio: audioSpec, brandName,
    videoSrc, sourceDurationSec: durationSec,
  })
  spec.warnings = warnings
  // talk 默认无背景（见 bgExplicit 注释）；显式给了才按五模板同一套规则解析
  const bgVariant = bgExplicit ? resolveBgVariant('talk', bgExplicit) : undefined
  spec.bgVariant = bgVariant

  return renderAndRegister(ctx, hfDir, slug, 'talk', hook, projectId, onProgress, spec, audioMix,
    { engine: 'remotion', bgVariant })
}

/**
 * spec 落盘 + orig 快照写入（renderAndRegister 与直连测试共用，抽出来是为了让「orig 只在
 * 首次生成时写」这条守卫可以脱离整条渲染管线单独测试——mock crypto.randomUUID 拦不住具名导入，
 * 真实重渲场景下想验证「同一 videoId 二次落盘不覆盖 orig」，直接调用本函数两次即可，不必造随机数陷阱。
 * 只在 origAbsPath 不存在时写 orig：重渲不覆盖 orig——重置的语义是回到「第一次生成」。
 */
export function writeSpecFiles(specAbsPath: string, spec: VideoSpec): void {
  fs.mkdirSync(path.dirname(specAbsPath), { recursive: true })
  fs.writeFileSync(specAbsPath, JSON.stringify(spec, null, 2), 'utf8')
  const origAbsPath = specAbsPath.replace(/\.json$/, '.orig.json')
  if (!fs.existsSync(origAbsPath)) fs.writeFileSync(origAbsPath, JSON.stringify(spec, null, 2), 'utf8')
}

/**
 * 渲染 hf 项目并登记 video 素材（各 HyperFrames 分支收尾共用）。
 * `audioMix` 可选：渲染后调 mixAudio 把 BGM/SFX 混进成片，失败 fail-soft（保留无背景乐版本，打 ⚠，
 * 原因同时 push 进 `spec.warnings`）。
 * stub 模式下即便传了 audioMix 也不真跑 mixAudio（不 spawn ffmpeg）。
 * 收尾统一把 `spec` 落盘到 `workspace/<slug>/specs/<videoId>.json`，并把 spec_path/warnings 写入 assets 行。
 */
async function renderAndRegister(
  ctx: CoreCtx, hfDir: string, slug: string, tpl: string, hook: string | null,
  projectId: number, onProgress: (m: string) => void, spec: VideoSpec, audioMix: AudioMix | undefined,
  via: { engine: 'remotion'; bgVariant?: string } | { engine: 'hyperframes' },
): Promise<GeneratedVideo> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const relPath = path.join(slug, 'videos', `${tpl}-${hook ?? tpl}-${stamp}-${spec.videoId.slice(0, 6)}.mp4`)
  const outAbs = path.join(ctx.config.paths.workspace, relPath)
  const mode = ctx.config.video.mode === 'stub' ? 'stub' : 'render'
  if (via.engine === 'remotion') {
    onProgress(`渲染视频（Remotion，${ctx.config.video.mode}）…`)
    // publicDir 指向 hf 项目目录：spec 里的图片 src 是 `assets/<rel>`，字体是 assets/fonts，
    // 都以这个目录为根（scaffoldHfProject 摆好的）。只有 bundle() 收 publicDir，renderMedia 不收。
    await renderRemotion(spec, outAbs, { mode, publicDir: hfDir, bgVariant: via.bgVariant, onProgress })
  } else {
    onProgress(`渲染视频（HyperFrames，${ctx.config.video.mode}）…`)
    await renderHyperframes(hfDir, outAbs, mode, { onProgress })
  }
  if (audioMix && ctx.config.video.mode !== 'stub') {
    try {
      onProgress('混入 BGM/音效…')
      await mixAudio(outAbs, audioMix)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      onProgress(`⚠ BGM 混音失败，保留无背景乐版本：${msg}`)
      spec.warnings.push(`BGM 混音失败，保留无背景乐版本：${msg}`)
    }
  }
  const specRelPath = path.join(slug, 'specs', `${spec.videoId}.json`)
  const specAbsPath = path.join(ctx.config.paths.workspace, specRelPath)
  writeSpecFiles(specAbsPath, spec)
  const info = ctx.db.prepare(
    'INSERT INTO assets (project_id, type, hook, file_path, warnings, spec_path) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(projectId, 'video', hook, relPath, JSON.stringify(spec.warnings), specRelPath)
  advanceStage(ctx.db, projectId, 'producing')
  onProgress(`视频完成: ${relPath}`)
  return { assetId: Number(info.lastInsertRowid), filePath: relPath }
}

/** 渲染期 warnings 的前缀白名单：这两类由「本轮渲染」产生，重渲时必须先清掉上一轮的，
 *  否则上次的 BGM 失败会一路跟着每个新版本落库（且含变量的消息用 includes 去重也盖不住）。
 *  生成期 warnings（TTS 降级、节拍分析失败等）属于「这条稿子的历史」，保留不动。 */
const RENDER_WARNING_PREFIXES = ['BGM 混音失败', 'BGM 文件缺失']
const BGM_MISSING_WARNING = 'BGM 文件缺失，本次无背景乐'

/**
 * 从落盘的 spec 重建渲染期的 AudioMix（AudioMix 本身不落 spec，spec 只留 bgm.src 与 beatGrid）。
 *
 * `bgm.src` 存的是**绝对路径**——见 selectBgm 的 `bgmPath = chooseBgmPath(绝对 bgmDir, …)`、
 * demo cutplan 分支的 `path.join(templates,'bgm',cutPlan.bgm)`，以及落盘处 `src: audioMix.bgmPath`。
 * 故这里直接 existsSync，不做任何前缀拼接。
 *
 * 返回 undefined 有两种含义（调用方据 `missing` 区分）：spec 本就没 BGM，或曲子文件没了（fail-soft）。
 * 抽成纯函数是为了让四个字段能被直接断言——stub 模式不跑 mixAudio，字段写错在端到端测试里是静默的。
 */
export function rebuildAudioMix(
  spec: VideoSpec, templatesDir: string,
): { audioMix: AudioMix | undefined; missing: boolean } {
  const src = spec.audio?.bgm?.src
  if (!src) return { audioMix: undefined, missing: false }
  if (!fs.existsSync(src)) return { audioMix: undefined, missing: true }
  return {
    audioMix: {
      bgmPath: src,
      // 与 selectBgm 同一条规则：取 sfx 目录第一个（不分情绪），保证重渲与首渲的音效一致
      sfxPath: pickBgm(path.join(templatesDir, 'sfx')),
      strongBeats: spec.audio.beatGrid?.strongBeats ?? [],
      durationSec: spec.durationSec,
    },
    missing: false,
  }
}

/**
 * 剪辑台「渲成片」：渲**当前编辑态的 spec**，不重跑 文案→TTS→buildSemantic→lower
 * （那条路会用生成结果覆盖用户在剪辑台上的手工改动，正是本函数要绕开的事）。
 *
 * 复用首次生成留下的两份产物：
 * - `workspace/<slug>/specs/<videoId>.json`：图层真相（用户改的就是它）；
 * - `workspace/<slug>/hf/<videoId>/`：素材目录（旁白 wav、截图、字体），做 Remotion 的 publicDir。
 *
 * **调用方须自行拒绝 custom-* 与空 layers**：本函数照 spec 渲，custom-* 的 spec 是空 layers 的占位
 * （HTML 由 LLM 产出、不走 Layer 模型），走 Remotion 只会渲出一片空白（见 spec-routes 的 400 分支）。
 *
 * 产出一条**新的** video asset 行（版本语义与 P0 聚合一致：同 spec_path 的多行 = 多个版本）；
 * orig 快照因 writeSpecFiles 的 exists 守卫不被覆盖——「重置」永远回到第一次生成。
 */
export async function renderFromSpec(
  ctx: CoreCtx, slug: string, videoId: string, onProgress: (m: string) => void = () => {},
): Promise<GeneratedVideo> {
  const project: any = ctx.db.prepare('SELECT * FROM projects WHERE slug = ?').get(slug)
  if (!project) throw new Error(`项目不存在: ${slug}`)
  const specAbs = path.join(ctx.config.paths.workspace, slug, 'specs', `${videoId}.json`)
  if (!fs.existsSync(specAbs)) throw new Error(`spec 不存在，无法重渲: ${videoId}`)
  const spec: VideoSpec = JSON.parse(fs.readFileSync(specAbs, 'utf8'))
  const hfDir = path.join(ctx.config.paths.workspace, slug, 'hf', videoId)
  if (!fs.existsSync(hfDir)) throw new Error(`素材目录缺失，无法重渲: ${path.join(slug, 'hf', videoId)}`)

  // 先清上一轮的渲染期 warnings，本轮真发生再 push（见 RENDER_WARNING_PREFIXES 注释）
  spec.warnings = (Array.isArray(spec.warnings) ? spec.warnings : [])
    .filter((w) => !RENDER_WARNING_PREFIXES.some((p) => String(w).startsWith(p)))

  const { audioMix, missing } = rebuildAudioMix(spec, ctx.config.paths.templates)
  if (missing) {
    onProgress(`⚠ ${BGM_MISSING_WARNING}`)
    spec.warnings.push(BGM_MISSING_WARNING)
  }

  // hook 回退：spec.semantic.hook 目前恒为 null（buildSemantic 读的 doc.hook 在 CopyDoc 里不存在，
  // 那条取值链属于子项目①，另行记账）。这里按 sourceAssetId 回查文案行的 hook，
  // 免得重渲行 assets.hook=NULL、文件名退化成 `flash-flash-…`，与 v1 在成片库里看着不像一家。
  let hook: string | null = spec.semantic?.hook ?? null
  if (!hook && spec.semantic?.sourceAssetId != null) {
    const copy: any = ctx.db.prepare("SELECT hook FROM assets WHERE id = ? AND type = 'copy'").get(spec.semantic.sourceAssetId)
    hook = copy?.hook ?? null
  }

  return renderAndRegister(ctx, hfDir, slug, spec.template, hook, project.id, onProgress, spec, audioMix,
    { engine: 'remotion', bgVariant: spec.bgVariant })
}

/**
 * 自定义模板渲染：TTS→BGM 流程与统一管线一致，差异只在按拆解节奏比例填 N 个动态分段占位符——
 * 模板 HTML 由 LLM/固定 fixture 产出（见 props.ts generateCustomTemplate），不经过 buildSemantic/
 * lower/renderSpecToHtml 那套 Layer 模型，故这里独立落一份「空 layers」的 VideoSpec，
 * 只为满足 renderAndRegister 统一的 spec 落盘/spec_path/warnings 落库契约。
 */
async function renderCustomTemplate(
  ctx: CoreCtx, row: any,
  opts: { slug: string; doc: ReturnType<typeof parseCopyOutput>; hook: string; projectId: number; video: VideoCfg; onProgress: (m: string) => void; sourceAssetId: number },
): Promise<GeneratedVideo> {
  const { slug, doc, hook, projectId, video, onProgress, sourceAssetId } = opts
  const videoId = randomUUID()
  const hfDir = path.join(ctx.config.paths.workspace, slug, 'hf', videoId)
  onProgress('TTS 配音…')
  const wavAbs = path.join(hfDir, 'assets', 'narration.wav')
  const voice = await synthesizeVoice(ctx, doc.douyinScript, wavAbs)
  const warnings: string[] = []
  if (voice.degraded) {
    onProgress(`⚠ TTS 降级：${voice.degraded}`)
    warnings.push(`TTS 降级：${voice.degraded}`)
  }
  const lastEnd = voice.cues.length ? voice.cues[voice.cues.length - 1].end : 0
  const duration = Math.max(MIN_DURATION.custom, Math.ceil(lastEnd))
  const { grid, audioMix } = await selectBgm(ctx, video, duration, onProgress, hook, warnings)

  const pacing: Pacing = JSON.parse(row.segments_json)
  const windows = computeSegmentWindows(pacing.segments, pacing.durationSec, duration)
  const texts = bucketCuesBySegments(voice.cues, windows)
  const rawHtml = fs.readFileSync(customTemplateHtmlPath(ctx, row.id), 'utf8')
  const slots: Record<string, string> = { duration: String(duration) }
  windows.forEach((w, i) => {
    slots[`seg${i}_start`] = String(w.start)
    slots[`seg${i}_dur`] = String(Math.max(0.5, w.end - w.start))
    slots[`seg${i}_text`] = texts[i] ?? ''
  })
  let html = fillTemplate(rawHtml, slots)
  html = injectAudioCaptions(html, voice.audioRel, voice.cues, duration, video.captions)
  scaffoldHfProject(hfDir, html)

  const canvas: { width: number; height: number } = row.aspect_ratio === 'landscape'
    ? ASPECT_DIMENSIONS.landscape
    : ASPECT_DIMENSIONS.portrait
  const spec: VideoSpec = {
    version: 1,
    videoId,
    slug,
    template: `custom-${row.id}`,
    createdAt: new Date().toISOString(),
    semantic: { hook: null, sourceAssetId, sections: [] },
    canvas,
    durationSec: duration,
    layers: [],
    audio: {
      narration: voice.audioRel ? { src: voice.audioRel, degraded: voice.degraded ?? null } : null,
      bgm: audioMix ? { src: audioMix.bgmPath, mood: video.mood || null } : null,
      beatGrid: grid ? { t0: grid.t0, T: grid.T, bpm: grid.bpm, strongBeats: grid.strongBeats } : null,
      captionsEnabled: video.captions,
    },
    warnings,
  }
  // 自定义模板不走 Layer 模型（HTML 由 LLM 产出），本期继续用 HyperFrames 渲
  return renderAndRegister(ctx, hfDir, slug, `custom-${row.id}`, hook, projectId, onProgress, spec, audioMix,
    { engine: 'hyperframes' })
}
