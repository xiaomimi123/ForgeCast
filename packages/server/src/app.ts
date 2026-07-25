import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { analyzeProject, parseAnalysisSummary } from '@forgecast/analyst'
import { HOOKS, maskKey, refreshCtx, SETTING_KEYS, setSettings, type CoreCtx, type SettingKey } from '@forgecast/core'
import { generateCopy } from '@forgecast/copywriter'
import { addLead, calendarSuggestions, deleteAsset, listLeads, publishAsset, recordPerf, weeklyReport } from '@forgecast/ops'
import { rebrandPlan } from '@forgecast/rebrand'
import { addRepo, backfillCategories, candidatesNeedingRescore, pickCandidate, rescoreCandidate, scoutCandidates } from '@forgecast/scout'
import { analyzeBeats, autoCutPlan, chooseBgmPath, generateVideo, readShots, synthesizeVoice } from '@forgecast/studio'
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import type { TaskEvent, TaskQueue } from './tasks'

// 可通过 PATCH 修改的项目字段白名单
const PATCHABLE = ['brand_name', 'target_buyer', 'demo_url', 'price_deploy', 'price_custom', 'stage'] as const

/**
 * fail-soft 读文件：读不到（不存在 / 权限异常 / 被换成目录 / TOCTOU 等）一律返回空串，不抛错。
 * 用于 analysis.md 这类"没有也正常"的可选文件——不该让整个项目列表接口因为单个项目的文件问题而 500。
 */
function readFileSafe(p: string): string {
  try {
    return fs.readFileSync(p, 'utf8')
  } catch {
    return ''
  }
}

/** 创建 Hono app：项目 REST API + 任务队列 SSE 进度流 */
export function createApp(ctx: CoreCtx, queue: TaskQueue): Hono {
  const app = new Hono()

  app.get('/api/projects', (c) => {
    const rows = ctx.db.prepare('SELECT * FROM projects ORDER BY id').all() as any[]
    // 附上 analysis.md 摘要给看板泳道卡片；没跑过分析的项目为空对象，不报错
    return c.json(rows.map((r) => {
      const p = path.join(ctx.config.paths.workspace, r.slug, 'analysis.md')
      const md = readFileSafe(p)
      return { ...r, analysis_summary: parseAnalysisSummary(md) }
    }))
  })

  app.get('/api/projects/:slug', (c) => {
    const row: any = ctx.db.prepare('SELECT * FROM projects WHERE slug = ?').get(c.req.param('slug'))
    if (!row) return c.json({ error: '项目不存在' }, 404)
    const analysisPath = path.join(ctx.config.paths.workspace, row.slug, 'analysis.md')
    const analysisMd = readFileSafe(analysisPath)
    return c.json({ ...row, analysisMd })
  })

  app.patch('/api/projects/:slug', async (c) => {
    const slug = c.req.param('slug')
    const exists = ctx.db.prepare('SELECT id FROM projects WHERE slug = ?').get(slug)
    if (!exists) return c.json({ error: '项目不存在' }, 404)
    const body = await c.req.json()
    const keys = PATCHABLE.filter((k) => k in body)
    if (keys.length) {
      ctx.db.prepare(`UPDATE projects SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE slug = ?`)
        .run(...keys.map((k) => body[k]), slug)
    }
    return c.json({ ok: true })
  })

  // —— 设置页：key/模型/模式（key 打码回显，绝不回明文）——
  // 全用 effective 的 ctx.config（applyStoredSettings 已把 stored 合进；这才是真实运行态，
  // 避免 env 配置的 live 被前端回填 stored 覆盖）
  function settingsView() {
    const cfg = ctx.config
    return {
      llm: {
        mode: cfg.llm.mode,
        key_set: !!cfg.llm.apiKey, key_masked: maskKey(cfg.llm.apiKey),
        base_url: cfg.llm.baseURL, models: { ...cfg.llm.models },
      },
      tts: {
        mode: cfg.tts.mode,
        key_set: !!cfg.tts.apiKey, key_masked: maskKey(cfg.tts.apiKey),
        base_url: cfg.tts.baseURL, model: cfg.tts.model, voice: cfg.tts.voice, melo_python: cfg.tts.meloPython, cosy_home: cfg.tts.cosyHome,
      },
      github: {
        mode: cfg.github.mode,
        token_set: !!cfg.github.token, token_masked: maskKey(cfg.github.token),
      },
      // 选了 live 却缺 key 时会被降级——不说明白的话，页面上模式会莫名其妙跳回 mock
      mode_notes: ctx.modeNotes ?? [],
    }
  }

  app.get('/api/settings', (c) => c.json(settingsView()))

  app.put('/api/settings', async (c) => {
    const body = await c.req.json().catch(() => ({}))
    const kv: Partial<Record<SettingKey, string>> = {}
    for (const k of SETTING_KEYS) {
      if (!(k in body) || typeof body[k] !== 'string') continue
      // key/token 字段留空/纯空白 = 保持原值（不写空覆盖，避免误抹已存 key）；非空才更新
      if ((k === 'llm_key' || k === 'tts_key' || k === 'github_token') && body[k].trim() === '') continue
      kv[k] = body[k]
    }
    setSettings(ctx.db, kv)
    refreshCtx(ctx) // 就地生效：重算 config + 重建 ctx.llm
    return c.json(settingsView())
  })

  app.post('/api/settings/test-llm', async (c) => {
    if (ctx.config.llm.mode !== 'live') {
      return c.json({ ok: false, message: '当前为 mock 模式（未配置 live key），未发起真实请求' })
    }
    try {
      const out = await ctx.llm.complete({ model: ctx.config.llm.models.copy, prompt: 'ping，请只回复 ok' })
      return c.json({ ok: true, message: `连接成功，模型返回：${out.slice(0, 40)}` })
    } catch (e) {
      return c.json({ ok: false, message: e instanceof Error ? e.message : String(e) })
    }
  })

  app.post('/api/settings/test-tts', async (c) => {
    if (ctx.config.tts.mode === 'stub') {
      return c.json({ ok: false, message: '当前为 stub 模式（静音占位），未发起真实合成' })
    }
    // 合成一句极短文本到临时文件：live 验 key/模型、kokoro/melo 验本地依赖，比渲一整条视频快
    const tmp = path.join(os.tmpdir(), `forgecast-tts-test-${process.pid}.wav`)
    try {
      const r = await synthesizeVoice(ctx, '连接测试', tmp)
      if (r.degraded) return c.json({ ok: false, message: r.degraded })
      const size = fs.statSync(tmp).size
      return c.json({ ok: true, message: `${ctx.config.tts.mode} 合成成功，音频 ${(size / 1024).toFixed(1)} KB` })
    } catch (e) {
      return c.json({ ok: false, message: e instanceof Error ? e.message : String(e) })
    } finally {
      fs.rmSync(tmp, { force: true })
    }
  })

  app.get('/api/tasks/:id/events', (c) => {
    const task = queue.get(c.req.param('id'))
    if (!task) return c.json({ error: '任务不存在' }, 404)
    return streamSSE(c, async (stream) => {
      let closed = false
      const send = (e: TaskEvent) => stream.writeSSE({ data: JSON.stringify(e) })
      for (const e of task.events) await send(e) // 回放历史（订阅前已发生的事件不丢）
      if (task.status === 'done' || task.status === 'failed') return
      await new Promise<void>((resolve) => {
        const off = queue.subscribe(task.id, async (e) => {
          await send(e)
          if (e.type === 'done' || e.type === 'error') { off(); closed = true; resolve() }
        })
        stream.onAbort(() => { if (!closed) { off(); resolve() } })
      })
    })
  })

  // —— 生成 ——
  app.post('/api/projects/:slug/copy', async (c) => {
    const slug = c.req.param('slug')
    const project = ctx.db.prepare('SELECT id FROM projects WHERE slug = ?').get(slug)
    if (!project) return c.json({ error: '项目不存在' }, 404)
    const body = await c.req.json()
    if (!HOOKS.includes(body.hook)) return c.json({ error: `hook 必须是 ${HOOKS.join('/')}` }, 400)
    const n = Math.min(Math.max(1, Number(body.n) || 1), 5)
    const taskId = queue.enqueue((log) => generateCopy(ctx, {
      slug, hook: body.hook, n, feedback: body.feedback,
      renderCovers: body.renderCovers ?? true, onProgress: log,
    }))
    return c.json({ taskId })
  })

  // —— 素材 ——
  app.get('/api/projects/:slug/assets', (c) => {
    const project: any = ctx.db.prepare('SELECT id FROM projects WHERE slug = ?').get(c.req.param('slug'))
    if (!project) return c.json({ error: '项目不存在' }, 404)
    return c.json(ctx.db.prepare('SELECT * FROM assets WHERE project_id = ? ORDER BY id DESC').all(project.id))
  })

  function assetAbsPath(id: string): { row: any; abs: string } | null {
    const row: any = ctx.db.prepare('SELECT * FROM assets WHERE id = ?').get(id)
    if (!row) return null
    return { row, abs: path.join(ctx.config.paths.workspace, row.file_path) }
  }

  app.get('/api/assets/:id/content', (c) => {
    const hit = assetAbsPath(c.req.param('id'))
    if (!hit || !fs.existsSync(hit.abs)) return c.json({ error: '素材不存在' }, 404)
    return c.json({ content: fs.readFileSync(hit.abs, 'utf8') })
  })

  app.put('/api/assets/:id/content', async (c) => {
    const hit = assetAbsPath(c.req.param('id'))
    if (!hit) return c.json({ error: '素材不存在' }, 404)
    const { content } = await c.req.json()
    if (typeof content !== 'string') return c.json({ error: 'content 必须是字符串' }, 400)
    fs.writeFileSync(hit.abs, content, 'utf8')
    return c.json({ ok: true })
  })

  app.patch('/api/assets/:id', async (c) => {
    const hit = assetAbsPath(c.req.param('id'))
    if (!hit) return c.json({ error: '素材不存在' }, 404)
    const { status } = await c.req.json()
    if (!['draft', 'approved', 'published'].includes(status)) return c.json({ error: '非法 status' }, 400)
    ctx.db.prepare('UPDATE assets SET status = ? WHERE id = ?').run(status, hit.row.id)
    return c.json({ ok: true })
  })

  // —— raw 上传与列表 ——
  app.post('/api/projects/:slug/raw', async (c) => {
    const slug = c.req.param('slug')
    if (!ctx.db.prepare('SELECT id FROM projects WHERE slug = ?').get(slug)) return c.json({ error: '项目不存在' }, 404)
    const body = await c.req.parseBody()
    const file = body.file
    if (!(file instanceof File)) return c.json({ error: '缺少 file 字段' }, 400)
    const rawDir = path.join(ctx.config.paths.workspace, slug, 'raw')
    fs.mkdirSync(rawDir, { recursive: true })
    const safeName = path.basename(file.name)
    fs.writeFileSync(path.join(rawDir, safeName), Buffer.from(await file.arrayBuffer()))
    return c.json({ ok: true, name: safeName })
  })

  app.get('/api/projects/:slug/raw', (c) => {
    const dir = path.join(ctx.config.paths.workspace, c.req.param('slug'), 'raw')
    return c.json({ files: fs.existsSync(dir) ? fs.readdirSync(dir) : [] })
  })

  // —— workspace 静态文件（封面/视频预览）——
  const MIME: Record<string, string> = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.mp4': 'video/mp4', '.md': 'text/markdown; charset=utf-8',
  }
  app.get('/files/*', (c) => {
    const rel = decodeURIComponent(c.req.path.replace(/^\/files\//, ''))
    const wsRoot = path.resolve(ctx.config.paths.workspace)
    const abs = path.resolve(wsRoot, rel)
    if (!abs.startsWith(wsRoot + path.sep) || !fs.existsSync(abs) || fs.statSync(abs).isDirectory()) {
      return c.notFound()
    }
    return c.body(fs.readFileSync(abs) as any, 200, {
      'content-type': MIME[path.extname(abs)] ?? 'application/octet-stream',
    })
  })

  // —— M1 scout ——
  app.post('/api/scout', async (c) => {
    const body = await c.req.json().catch(() => ({}))
    const taskId = queue.enqueue((log) => scoutCandidates(ctx, {
      topics: Array.isArray(body.topics) ? body.topics : undefined,
      limit: typeof body.limit === 'number' ? body.limit : undefined,
    }).then((r) => { log(`发现 ${r.found} 个，评分 ${r.scored}，协议不过 ${r.rejected}`); return r }))
    return c.json({ taskId })
  })

  app.post('/api/candidates/add', async (c) => {
    const { url } = await c.req.json().catch(() => ({}))
    if (typeof url !== 'string' || !url) return c.json({ error: '缺少 url' }, 400)
    const taskId = queue.enqueue((log) => addRepo(ctx, url).then(() => log(`已投喂 ${url}`)))
    return c.json({ taskId })
  })

  app.get('/api/candidates', (c) => {
    return c.json(ctx.db.prepare(
      'SELECT * FROM candidates ORDER BY license_ok DESC, (score IS NULL), score DESC',
    ).all())
  })

  app.post('/api/candidates/pick', async (c) => {
    const { repo } = await c.req.json().catch(() => ({}))
    if (typeof repo !== 'string' || !repo) return c.json({ error: '缺少 repo' }, 400)
    try {
      const { slug } = await pickCandidate(ctx, repo)
      return c.json({ slug })
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400)
    }
  })

  app.post('/api/candidates/backfill-categories', (c) => {
    return c.json({ updated: backfillCategories(ctx) })
  })

  app.post('/api/candidates/rescore-all', (c) => {
    const taskId = queue.enqueue(async (log) => {
      if (ctx.config.llm.mode === 'mock') { log('⚠ 当前为 mock 模式，真评分不生效；请先到「设置」把大模型切 live 并填 key'); return }
      const need = candidatesNeedingRescore(ctx)
      if (!need.length) { log('无需评分：候选都已真评过'); return }
      log(`共 ${need.length} 个候选需真评分，开始…`)
      let ok = 0, fail = 0
      for (const [i, id] of need.entries()) {
        const repo = (ctx.db.prepare('SELECT repo FROM candidates WHERE id = ?').get(id) as any)?.repo ?? id
        log(`评分中 ${i + 1}/${need.length}：${repo}`)
        try { await rescoreCandidate(ctx, id); ok++ } catch (e) { fail++; log(`⚠ ${repo} 评分失败：${e instanceof Error ? e.message : String(e)}`) }
      }
      log(`完成：真评 ${ok} 个，失败跳过 ${fail} 个`)
    })
    return c.json({ taskId })
  })

  app.post('/api/candidates/:id/rescore', async (c) => {
    const id = Number(c.req.param('id'))
    if (!Number.isInteger(id)) return c.json({ error: '非法 id' }, 400)
    // 与本文件其余路由一致：先在路由层做存在性检查，404 不再依赖下游错误消息文本
    if (!ctx.db.prepare('SELECT id FROM candidates WHERE id = ?').get(id)) {
      return c.json({ error: '候选不存在' }, 404)
    }
    try {
      await rescoreCandidate(ctx, id)
      // 带上模式：mock 下不会产生痛点/目标群体，前端据此提示
      return c.json({ ok: true, mode: ctx.config.llm.mode })
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400)
    }
  })

  // —— M2 analyst ——
  app.post('/api/projects/:slug/analyze', async (c) => {
    const slug = c.req.param('slug')
    if (!ctx.db.prepare('SELECT id FROM projects WHERE slug = ?').get(slug)) return c.json({ error: '项目不存在' }, 404)
    const taskId = queue.enqueue((log) => analyzeProject(ctx, slug, { onProgress: log }))
    return c.json({ taskId })
  })

  // —— M5 视频 ——
  app.post('/api/projects/:slug/video', async (c) => {
    const slug = c.req.param('slug')
    if (!ctx.db.prepare('SELECT id FROM projects WHERE slug = ?').get(slug)) return c.json({ error: '项目不存在' }, 404)
    const body = await c.req.json().catch(() => ({}))
    // tpl 白名单校验：story/demo/changelog 显式放行，其余（含未传）一律回落 flash
    const tpl = ['story', 'demo', 'changelog'].includes(body.tpl) ? body.tpl : 'flash'
    const taskId = queue.enqueue((log) => generateVideo(ctx, {
      slug,
      assetId: typeof body.assetId === 'number' ? body.assetId : undefined,
      tpl,
      onProgress: log,
    }))
    return c.json({ taskId })
  })

  // —— 卡点方案（cutplan）——
  const cutplanPath = (slug: string) => path.join(ctx.config.paths.workspace, slug, 'cutplan.json')
  const projExists = (slug: string) => !!ctx.db.prepare('SELECT id FROM projects WHERE slug = ?').get(slug)

  // bgm 相对名必须落在 templates/bgm 内（防 ../ 穿越读到曲库外文件）
  const bgmInside = (rel: string) => {
    const bgmRoot = path.resolve(ctx.config.paths.templates, 'bgm')
    const abs = path.resolve(bgmRoot, rel)
    return abs === bgmRoot ? false : abs.startsWith(bgmRoot + path.sep)
  }

  app.post('/api/projects/:slug/cutplan/analyze', async (c) => {
    const slug = c.req.param('slug')
    if (!projExists(slug)) return c.json({ error: '项目不存在' }, 404)
    if (!ctx.config.video.beatPython) return c.json({ error: '需配置 FORGECAST_BEAT_PYTHON（librosa）才能分析卡点' }, 400)
    const body = await c.req.json().catch(() => ({} as any))
    if (typeof body.bgm === 'string' && body.bgm && !bgmInside(body.bgm)) return c.json({ error: 'bgm 路径非法' }, 400)
    const shots = readShots(path.join(ctx.config.paths.workspace, slug, 'shots'))
    if (!shots.length) return c.json({ error: 'demo 需要 workspace/<slug>/shots/ 里的截图' }, 400)
    const copyRow: any = ctx.db.prepare("SELECT hook FROM assets WHERE project_id = (SELECT id FROM projects WHERE slug=?) AND type='copy' ORDER BY id DESC LIMIT 1").get(slug)
    const bgmDir = path.join(ctx.config.paths.templates, 'bgm')
    const bgmPath = chooseBgmPath(bgmDir, { bgm: body.bgm ?? '', mood: body.mood ?? ctx.config.video.mood, hook: copyRow?.hook ?? '' }, Math.random)
    if (!bgmPath) return c.json({ error: '曲库为空（templates/bgm 无曲）' }, 400)
    const grid = await analyzeBeats(bgmPath, ctx.config.video.beatPython)
    if (!grid) return c.json({ error: '节拍分析失败（librosa）' }, 500)
    const rel = path.relative(bgmDir, bgmPath)
    const cadence = 4
    const cuts = autoCutPlan(grid, shots.length, grid.duration, cadence)
    return c.json({ bgm: rel, grid, cadence, offsetSec: 0, cuts, shots: shots.map((s) => ({ rel: s.rel })) })
  })

  app.get('/api/projects/:slug/cutplan', (c) => {
    const slug = c.req.param('slug')
    if (!projExists(slug)) return c.json({ error: '项目不存在' }, 404)
    const p = cutplanPath(slug)
    if (!fs.existsSync(p)) return c.json(null)
    try { return c.json(JSON.parse(fs.readFileSync(p, 'utf8'))) } catch { return c.json(null) }
  })

  app.put('/api/projects/:slug/cutplan', async (c) => {
    const slug = c.req.param('slug')
    if (!projExists(slug)) return c.json({ error: '项目不存在' }, 404)
    const { plan } = await c.req.json().catch(() => ({} as any))
    const ok = plan && typeof plan.bgm === 'string' && plan.grid && typeof plan.grid.t0 === 'number' && typeof plan.grid.T === 'number'
      && typeof plan.cadence === 'number' && typeof plan.offsetSec === 'number' && Array.isArray(plan.cuts)
    if (!ok) return c.json({ error: '方案字段非法' }, 400)
    if (!bgmInside(plan.bgm)) return c.json({ error: 'bgm 路径非法' }, 400)
    fs.mkdirSync(path.dirname(cutplanPath(slug)), { recursive: true })
    fs.writeFileSync(cutplanPath(slug), JSON.stringify(plan, null, 2))
    return c.json({ ok: true })
  })

  app.delete('/api/projects/:slug/cutplan', (c) => {
    const slug = c.req.param('slug')
    if (!projExists(slug)) return c.json({ error: '项目不存在' }, 404)
    const p = cutplanPath(slug)
    if (fs.existsSync(p)) fs.rmSync(p)
    return c.json({ ok: true })
  })

  // —— M6 运营辅助 ——
  const assetExists = (id: string) => !!ctx.db.prepare('SELECT id FROM assets WHERE id = ?').get(id)

  app.delete('/api/assets/:id', (c) => {
    const id = c.req.param('id')
    if (!assetExists(id)) return c.json({ error: '素材不存在' }, 404)
    try {
      deleteAsset(ctx, Number(id))
      return c.json({ ok: true })
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e)
      return c.json({ error: m }, m.includes('询单') ? 409 : 500) // 询单护栏→409，其它→500
    }
  })

  app.post('/api/assets/:id/publish', async (c) => {
    const id = c.req.param('id')
    if (!assetExists(id)) return c.json({ error: '素材不存在' }, 404)
    const { platform, url } = await c.req.json().catch(() => ({}))
    publishAsset(ctx, Number(id), { platform: platform ?? '', url })
    return c.json({ ok: true })
  })

  app.post('/api/assets/:id/perf', async (c) => {
    const id = c.req.param('id')
    if (!assetExists(id)) return c.json({ error: '素材不存在' }, 404)
    const body = await c.req.json().catch(() => ({}))
    recordPerf(ctx, Number(id), { views: body.views, likes: body.likes, leads: body.leads })
    return c.json({ ok: true })
  })

  app.post('/api/leads', async (c) => {
    const body = await c.req.json().catch(() => ({}))
    if (typeof body.assetId !== 'number') return c.json({ error: '缺少 assetId' }, 400)
    if (!assetExists(String(body.assetId))) return c.json({ error: '素材不存在' }, 404)
    return c.json(addLead(ctx, { assetId: body.assetId, wechat: body.wechat, intent: body.intent }))
  })

  app.get('/api/leads', (c) => c.json(listLeads(ctx)))
  app.get('/api/calendar', (c) => c.json(calendarSuggestions(ctx)))
  app.get('/api/report', (c) => c.json(weeklyReport(ctx, c.req.query('since') || undefined)))

  // —— M3 换皮清单 ——
  app.post('/api/projects/:slug/rebrand', async (c) => {
    const slug = c.req.param('slug')
    if (!ctx.db.prepare('SELECT id FROM projects WHERE slug = ?').get(slug)) return c.json({ error: '项目不存在' }, 404)
    const taskId = queue.enqueue((log) => rebrandPlan(ctx, slug, { onProgress: log }))
    return c.json({ taskId })
  })

  // —— 静态托管构建好的 Web（Docker 单容器部署）。本地 dev 用 Vite，无 dist 则不注册，不影响 ——
  const webDist = path.resolve(process.env.FORGECAST_WEB_DIST ?? path.join(ctx.config.root, 'apps/web/dist'))
  if (fs.existsSync(webDist)) {
    const MIME: Record<string, string> = {
      '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
      '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
      '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.map': 'application/json',
    }
    const indexRes = () => new Response(fs.readFileSync(path.join(webDist, 'index.html')), { headers: { 'content-type': 'text/html; charset=utf-8' } })
    app.get('/*', (c) => {
      let pathname: string
      try { pathname = decodeURIComponent(new URL(c.req.url).pathname) } catch { return c.json({ error: 'bad path' }, 400) }
      if (pathname.startsWith('/api')) return c.json({ error: 'not found' }, 404) // 未匹配的 /api 返 JSON 404
      const file = path.resolve(webDist, pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, ''))
      // 路径边界须严格在 webDist 内（加 path.sep 防 dist-evil 之类同名前缀兄弟目录绕过）
      if ((file === webDist || file.startsWith(webDist + path.sep)) && fs.existsSync(file) && fs.statSync(file).isFile()) {
        return new Response(fs.readFileSync(file), { headers: { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' } })
      }
      return indexRes() // SPA 回落
    })
  }

  return app
}
