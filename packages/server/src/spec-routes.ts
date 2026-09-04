import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { CoreCtx } from '@forgecast/core'
import { analyzeBeats, chooseBgmPath, renderFromSpec, RewriteUnsupportedError, rewriteSection } from '@forgecast/studio'
import type { Hono } from 'hono'
import type { TaskQueue } from './tasks'

/** uuid 形状（防路径穿越，照 cutplan 的 bgmInside 先例思路）。 */
const VIDEO_ID_RE = /^[0-9a-f-]{8,64}$/i

/** PUT 校验：拒绝理由要具体（直接进 400 的 error），供剪辑台展示。纯函数，可测可复用。 */
export function validateSpecPut(body: any, videoId: string): string | null {
  if (!body || typeof body !== 'object') return '请求体不是有效的 spec'
  if (body.version !== 1) return 'version 必须为 1'
  if (body.videoId !== videoId) return 'videoId 与路径参数不一致'
  if (!Array.isArray(body.layers)) return 'layers 必须为数组'
  for (const l of body.layers) {
    if (!l || typeof l !== 'object') return 'layers 中存在非法图层'
    if (typeof l.id !== 'string' || !l.id) return '图层缺少 id'
    if (typeof l.kind !== 'string' || !l.kind) return `图层 ${l.id ?? '?'} 缺少 kind`
    if (typeof l.start !== 'number') return `图层 ${l.id ?? '?'} 缺少 start`
    if (typeof l.duration !== 'number') return `图层 ${l.id ?? '?'} 缺少 duration`
    if (typeof l.track !== 'number') return `图层 ${l.id ?? '?'} 缺少 track`
    if (!(l.start >= 0)) return `图层 ${l.id} 的 start 必须 >= 0`
    if (!(l.duration > 0)) return `图层 ${l.id} 的 duration 必须 > 0`
    // content.src 是渲染时拼进 hf/<videoId>/ 的相对路径（图片、talk 底片、字体…）。
    // 绝对路径或含 .. 的段能把渲染器指到工作区外的任意文件，PUT 是外部输入，必须在这里拦：
    // 落盘之后再拦就晚了（磁盘上的 spec 会一直带着这条越界路径）。
    const src = l.content?.src
    if (typeof src === 'string' && (src.startsWith('/') || src.split('/').includes('..'))) {
      return `图层 ${l.id} 的 src 不允许绝对路径或 ..`
    }
  }
  // 同 track 时间不重叠：按 track 分组，组内按 start 排序后相邻比较
  const byTrack = new Map<number, Array<{ id: string; start: number; duration: number }>>()
  for (const l of body.layers) {
    const arr = byTrack.get(l.track) ?? []
    arr.push({ id: l.id, start: l.start, duration: l.duration })
    byTrack.set(l.track, arr)
  }
  for (const [track, arr] of byTrack) {
    arr.sort((a, b) => a.start - b.start)
    for (let i = 1; i < arr.length; i++) {
      const prev = arr[i - 1]
      const cur = arr[i]
      if (cur.start < prev.start + prev.duration) {
        return `track ${track} 上图层 ${prev.id} 与 ${cur.id} 时间重叠`
      }
    }
  }
  return null
}

/** VideoSpec 的已知顶层键。落盘前用它把 PUT body 剪成白名单——见 `pickKnownSpecFields`。 */
const SPEC_TOP_LEVEL_KEYS = [
  'version', 'videoId', 'slug', 'template', 'createdAt', 'semantic', 'canvas',
  'durationSec', 'layers', 'audio', 'warnings', 'bgVariant',
] as const

/**
 * 剥掉 PUT body 里不属于 VideoSpec 的顶层字段再落盘（未知键剥除，而不是 400 拒绝）。
 *
 * 典型触发：GET 响应带的 `hasOrig` 是响应包装字段（见上面 GET 路由的注释），前端 PUT 回来前
 * 本该摘掉，但这条防线不该只钉在前端——它忘摘一次，磁盘上的 spec 就永久带一个假字段，
 * 从此每次 dirty 的 JSON 比较都多一项、每次读盘都多一份垃圾。这里把「未知键」当协议噪声
 * 直接剪掉，而不是拒收整个请求：用户的合法改动不该因为前端一个无关字段的疏漏而保存失败。
 */
export function pickKnownSpecFields(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of SPEC_TOP_LEVEL_KEYS) {
    if (key in body) out[key] = body[key]
  }
  return out
}

/** 波形分辨率：ffmpeg 重采样到 200Hz 单声道，再分桶到最多 1000 个 peak（时间轴像素级够用）。 */
const WAVEFORM_RATE = 200
const WAVEFORM_MAX_PEAKS = 1000

/** 按 `src + mtimeMs` 缓存波形——同一首曲子不重复 spawn ffmpeg（进程内，重启即失效，够了）。 */
const waveformCache = new Map<string, { peaks: number[]; durationSec: number }>()

/** decodeMono 的超时上限：畸形/超大音频文件让 ffmpeg 卡住时，别让请求（连带这条 worker）一直挂着。 */
export const DECODE_TIMEOUT_MS = 30_000

/** spawn `ffmpeg -i src -ac 1 -ar 200 -f s16le -` 收 stdout。
 *  失败（spawn 错/非零退出）→ null；`timeoutMs` 内未 close → kill 子进程并返回 `'timeout'`。 */
export function decodeMono(src: string, timeoutMs = DECODE_TIMEOUT_MS): Promise<Buffer | null | 'timeout'> {
  return new Promise((resolve) => {
    const p = spawn('ffmpeg', ['-v', 'error', '-i', src, '-ac', '1', '-ar', String(WAVEFORM_RATE), '-f', 's16le', '-acodec', 'pcm_s16le', '-'], { stdio: ['ignore', 'pipe', 'pipe'] })
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      p.kill('SIGKILL')
      resolve('timeout')
    }, timeoutMs)
    const chunks: Buffer[] = []
    p.stdout.on('data', (d) => chunks.push(d as Buffer))
    p.stderr.on('data', () => {}) // 排空，避免管道写满把 ffmpeg 卡死
    p.on('error', () => { if (settled) return; settled = true; clearTimeout(timer); resolve(null) })
    p.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(code === 0 ? Buffer.concat(chunks) : null)
    })
  })
}

/** s16le 单声道 → 每样本 |s|/32768 归一，按 ceil(n/1000) 分桶取 max。纯函数，可测。 */
export function bucketPeaks(pcm: Buffer): { peaks: number[]; durationSec: number } {
  const n = Math.floor(pcm.length / 2)
  const step = Math.max(1, Math.ceil(n / WAVEFORM_MAX_PEAKS))
  const peaks: number[] = []
  for (let i = 0; i < n; i += step) {
    let max = 0
    for (let j = i; j < Math.min(i + step, n); j++) {
      const v = Math.abs(pcm.readInt16LE(j * 2)) / 32768
      if (v > max) max = v
    }
    peaks.push(+max.toFixed(4))
  }
  return { peaks, durationSec: +(n / WAVEFORM_RATE).toFixed(3) }
}

/** 剪辑台的「保存」（GET/PUT spec）与「重置为生成结果」（POST .../reset，靠 orig 快照逐字节还原）。 */
export function registerSpecRoutes(app: Hono, ctx: CoreCtx, queue: TaskQueue): void {
  const projExists = (slug: string) => !!ctx.db.prepare('SELECT id FROM projects WHERE slug = ?').get(slug)
  const specAbs = (slug: string, videoId: string) => path.join(ctx.config.paths.workspace, slug, 'specs', `${videoId}.json`)
  const origAbs = (slug: string, videoId: string) => path.join(ctx.config.paths.workspace, slug, 'specs', `${videoId}.orig.json`)

  app.get('/api/projects/:slug/specs/:videoId', (c) => {
    const slug = c.req.param('slug')
    const videoId = c.req.param('videoId')
    if (!VIDEO_ID_RE.test(videoId)) return c.json({ error: 'videoId 非法' }, 400)
    if (!projExists(slug)) return c.json({ error: '项目不存在' }, 404)
    const p = specAbs(slug, videoId)
    if (!fs.existsSync(p)) return c.json({ error: 'spec 不存在' }, 404)
    try {
      const spec = JSON.parse(fs.readFileSync(p, 'utf8'))
      // `hasOrig`：这条视频有没有 `.orig.json` 生成快照，即「重置为生成结果」能不能用。
      // 加在 GET 响应里而不是另开探测端点，是为了让剪辑台**进场即知**——否则只能等用户点了
      // 重置、吃一个 404 才把按钮藏起来，那是「先让用户撞墙再告诉他没有门」。
      // ⚠️ 这是**响应包装字段，不属于 VideoSpec**：客户端 PUT 回来之前必须把它摘掉
      //（见 apps/web useEditorState 的解构），否则会被原样写进磁盘上的 spec。
      return c.json({ ...spec, hasOrig: fs.existsSync(origAbs(slug, videoId)) })
    } catch { return c.json({ error: 'spec 文件损坏' }, 500) }
  })

  app.put('/api/projects/:slug/specs/:videoId', async (c) => {
    const slug = c.req.param('slug')
    const videoId = c.req.param('videoId')
    if (!VIDEO_ID_RE.test(videoId)) return c.json({ error: 'videoId 非法' }, 400)
    if (!projExists(slug)) return c.json({ error: '项目不存在' }, 404)
    const body = await c.req.json().catch(() => null)
    const err = validateSpecPut(body, videoId)
    if (err) return c.json({ error: err }, 400)
    const p = specAbs(slug, videoId)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, JSON.stringify(pickKnownSpecFields(body), null, 2), 'utf8')
    return c.json({ ok: true })
  })

  app.post('/api/projects/:slug/specs/:videoId/reset', (c) => {
    const slug = c.req.param('slug')
    const videoId = c.req.param('videoId')
    if (!VIDEO_ID_RE.test(videoId)) return c.json({ error: 'videoId 非法' }, 400)
    if (!projExists(slug)) return c.json({ error: '项目不存在' }, 404)
    const op = origAbs(slug, videoId)
    if (!fs.existsSync(op)) return c.json({ error: '无生成快照（此视频生成于旧版本）' }, 404)
    const content = fs.readFileSync(op, 'utf8')
    fs.mkdirSync(path.dirname(specAbs(slug, videoId)), { recursive: true })
    fs.writeFileSync(specAbs(slug, videoId), content, 'utf8')
    try { return c.json(JSON.parse(content)) } catch { return c.json({ error: 'orig 快照文件损坏' }, 500) }
  })

  /** 「渲成片」：渲当前编辑态的 spec（renderFromSpec），不重跑全管线——重跑会重新 lower，
   *  把用户在剪辑台上的手工改动覆盖掉。meta 照 POST /video 的形状给全，P0 的「渲染中」派生直接生效。 */
  app.post('/api/projects/:slug/specs/:videoId/render', (c) => {
    const slug = c.req.param('slug')
    const videoId = c.req.param('videoId')
    if (!VIDEO_ID_RE.test(videoId)) return c.json({ error: 'videoId 非法' }, 400)
    if (!projExists(slug)) return c.json({ error: '项目不存在' }, 404)
    const p = specAbs(slug, videoId)
    if (!fs.existsSync(p)) return c.json({ error: 'spec 不存在' }, 404)
    let spec: any
    try { spec = JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return c.json({ error: 'spec 文件损坏' }, 500) }
    // 两类都渲不出东西，但成因不同，文案分开——用户看到的提示要指向他能做的事：
    // custom-* 的 spec 是「空 layers 的占位」（HTML 由 LLM 产出、不走 Layer 模型，见 generate.ts
    // renderCustomTemplate 注释），换模板才行；普通模板被删空图层，则是加回图层的事。
    if (String(spec.template ?? '').startsWith('custom-')) {
      return c.json({ error: '自定义模板暂不支持从剪辑台重渲' }, 400)
    }
    if (!Array.isArray(spec.layers) || spec.layers.length === 0) {
      return c.json({ error: '图层为空，无可渲染内容' }, 400)
    }
    const taskId = queue.enqueue((log) => renderFromSpec(ctx, slug, videoId, log), {
      kind: 'video', slug, sourceAssetId: spec.semantic?.sourceAssetId ?? undefined,
    })
    return c.json({ taskId })
  })

  /** 「重写这段」：只换该段文本图层的 text，不重跑 lower（见 rewriteSection 注释）。
   *  手工改过的图层（overridden===true）默认拦下，避免 LLM 悄悄覆盖用户的手改；带 force 时放行。 */
  app.post('/api/projects/:slug/specs/:videoId/rewrite-section', async (c) => {
    const slug = c.req.param('slug')
    const videoId = c.req.param('videoId')
    if (!VIDEO_ID_RE.test(videoId)) return c.json({ error: 'videoId 非法' }, 400)
    if (!projExists(slug)) return c.json({ error: '项目不存在' }, 404)
    const p = specAbs(slug, videoId)
    if (!fs.existsSync(p)) return c.json({ error: 'spec 不存在' }, 404)
    let spec: any
    try { spec = JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return c.json({ error: 'spec 文件损坏' }, 500) }
    const body = await c.req.json().catch(() => null)
    const sectionId = body?.sectionId
    if (typeof sectionId !== 'string' || !sectionId) return c.json({ error: '缺少 sectionId' }, 400)

    const affected = (spec.layers ?? []).filter((l: any) => l.from === sectionId && l.content?.kind === 'text' && l.overridden === true)
    if (affected.length > 0 && !body?.force) {
      return c.json({ error: '该段有手工改动', affected: affected.map((l: any) => l.id) }, 409)
    }

    try {
      const { spec: out, newText } = await rewriteSection(ctx, spec, sectionId, body?.instruction)
      fs.mkdirSync(path.dirname(p), { recursive: true })
      fs.writeFileSync(p, JSON.stringify(out, null, 2), 'utf8')
      return c.json({ spec: out, newText })
    } catch (err) {
      if (err instanceof RewriteUnsupportedError) return c.json({ error: err.message }, 400)
      throw err
    }
  })

  // bgm 相对名必须落在 templates/bgm 内（防 ../ 穿越读到曲库外文件）。同 app.ts cutplan 的 bgmInside。
  const bgmInside = (rel: string) => {
    const bgmRoot = path.resolve(ctx.config.paths.templates, 'bgm')
    const abs = path.resolve(bgmRoot, rel)
    return abs === bgmRoot ? false : abs.startsWith(bgmRoot + path.sep)
  }

  /**
   * 「换 BGM」：选曲 + 节拍重分析一体。分析失败**仍换曲**（fail-soft，同 cutplan analyze 的降级思路），
   * 只是没网格可吸附 → 打 warning。
   *
   * ⚠️ 关键不变量：`manualBeats`（用户手点的卡点）在任何分支都不能丢——它是手工劳动，
   * 自动重分析只该覆盖自动出来的 t0/T/bpm/strongBeats。所以失败分支不是简单 `beatGrid = null`：
   * 有手动卡点时退化成 `{t0:0,T:0,bpm:0,strongBeats:[],manualBeats}`（T=0 表示无网格仅手动点，
   * editing 的 allBeats 对 T<=0 跳过外推），只有本来就没手动卡点时才真的置 null。
   */
  app.post('/api/projects/:slug/specs/:videoId/pick-bgm', async (c) => {
    const slug = c.req.param('slug')
    const videoId = c.req.param('videoId')
    if (!VIDEO_ID_RE.test(videoId)) return c.json({ error: 'videoId 非法' }, 400)
    if (!projExists(slug)) return c.json({ error: '项目不存在' }, 404)
    const p = specAbs(slug, videoId)
    if (!fs.existsSync(p)) return c.json({ error: 'spec 不存在' }, 404)
    let spec: any
    try { spec = JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return c.json({ error: 'spec 文件损坏' }, 500) }
    const body = await c.req.json().catch(() => ({} as any)) ?? {}
    if (typeof body.bgm === 'string' && body.bgm && body.bgm !== 'none' && !bgmInside(body.bgm)) {
      return c.json({ error: 'bgm 路径非法' }, 400)
    }

    const bgmDir = path.join(ctx.config.paths.templates, 'bgm')
    const bgmPath = chooseBgmPath(bgmDir, {
      bgm: body.bgm ?? '', mood: body.mood ?? '', hook: spec.semantic?.hook ?? '',
    }, Math.random)
    if (!bgmPath) return c.json({ error: '曲库为空或无匹配（templates/bgm）' }, 400)

    const manualBeats: number[] | undefined = spec.audio?.beatGrid?.manualBeats
    const grid = await analyzeBeats(bgmPath, ctx.config.video.beatPython)
    spec.audio = { ...(spec.audio ?? {}), bgm: { src: bgmPath, mood: body.mood ?? null } }
    if (grid) {
      spec.audio.beatGrid = { t0: grid.t0, T: grid.T, bpm: grid.bpm, strongBeats: grid.strongBeats, ...(manualBeats ? { manualBeats } : {}) }
    } else {
      spec.audio.beatGrid = manualBeats ? { t0: 0, T: 0, bpm: 0, strongBeats: [], manualBeats } : null
      spec.warnings = Array.isArray(spec.warnings) ? spec.warnings : []
      if (!spec.warnings.includes('节拍分析失败，卡点吸附不可用')) spec.warnings.push('节拍分析失败，卡点吸附不可用')
    }

    const out = pickKnownSpecFields(spec)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, JSON.stringify(out, null, 2), 'utf8')
    return c.json(out)
  })

  /** BGM 波形（时间轴画卡点背景用）：≤1000 个 0..1 的 peak + 时长。ffmpeg 不可用 → 503（不是 500，
   *  这是「环境缺件、稍后/换机可用」而非请求错误；剪辑台据此只隐藏波形层，其它照常）。 */
  app.get('/api/projects/:slug/specs/:videoId/waveform', async (c) => {
    const slug = c.req.param('slug')
    const videoId = c.req.param('videoId')
    if (!VIDEO_ID_RE.test(videoId)) return c.json({ error: 'videoId 非法' }, 400)
    if (!projExists(slug)) return c.json({ error: '项目不存在' }, 404)
    const p = specAbs(slug, videoId)
    if (!fs.existsSync(p)) return c.json({ error: 'spec 不存在' }, 404)
    let spec: any
    try { spec = JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return c.json({ error: 'spec 文件损坏' }, 500) }
    const src = spec.audio?.bgm?.src
    if (typeof src !== 'string' || !src) return c.json({ error: '此视频没有可用的 BGM 音频' }, 404)
    // 子树限制（照 cutplan 的 bgmInside 先例）：spec.audio.bgm.src 来自磁盘上的 spec 文件，
    // 理论上可被手工改成任意路径（如 /etc/hosts）——这里 spawn ffmpeg 读它，必须先圈定范围，
    // 只认 templates（曲库）与 workspace（各项目产物）两棵子树。
    const abs = path.resolve(src)
    const inside = (root: string) => {
      const r = path.resolve(root)
      return abs === r || abs.startsWith(r + path.sep)
    }
    if (!inside(ctx.config.paths.templates) && !inside(ctx.config.paths.workspace)) {
      return c.json({ error: 'BGM 路径非法' }, 400)
    }
    if (!fs.existsSync(abs)) return c.json({ error: '此视频没有可用的 BGM 音频' }, 404)

    const key = `${abs}:${fs.statSync(abs).mtimeMs}`
    const hit = waveformCache.get(key)
    if (hit) return c.json(hit)
    const pcm = await decodeMono(abs)
    if (pcm === 'timeout') return c.json({ error: '波形解码超时' }, 503)
    if (!pcm || pcm.length < 2) return c.json({ error: '波形不可用（ffmpeg 解码失败）' }, 503)
    const out = bucketPeaks(pcm)
    waveformCache.set(key, out)
    return c.json(out)
  })
}
