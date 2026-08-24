import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { analyzeProject, parseAnalysisSummary } from '@forgecast/analyst'
import { getAllSettings, HOOKS, isStage, maskKey, refreshCtx, SETTING_KEYS, setSettings, type CoreCtx, type SettingKey } from '@forgecast/core'
import { generateCopy, generateDemoScreens, generateShootScript, regenerateCover } from '@forgecast/copywriter'
import { addLead, calendarSuggestions, deleteAsset, listLeads, publishAsset, recordPerf, weeklyReport } from '@forgecast/ops'
import { rebrandPlan } from '@forgecast/rebrand'
import { addRepo, backfillCandidateSummary, backfillCategories, candidatesNeedingRescore, candidatesNeedingSummary, deleteProject, generateCandidateIntro, pickCandidate, rescoreCandidate, scoutBreakouts, scoutCandidates } from '@forgecast/scout'
import { analyzeBeats, autoCutPlan, chooseBgmPath, createCustomTemplate, customTemplateHtmlPath, generateRetro, generateVideo, readShots, reviewVideo, synthesizeVoice } from '@forgecast/studio'
import {
  addCapability, addRequest, decomposeRequest, deleteCapability, generateProposal,
  getRequestDetail, listRequests, requestFromLead, searchWheels, updateCapability,
} from '@forgecast/tailor'
import { addSource, deleteSource, extractPatterns, listPatterns, listSources, requestScrape, updateSource } from '@forgecast/topics'
import { collectStatus, extractSignals, importSignals, listMatches, listSignals, matchSignal, requestCollect, setSignalStatus } from '@forgecast/demand'
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import type { TaskEvent, TaskQueue } from './tasks'
import { readAutoScoutCfg } from './scheduler'

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

  // 立项时继承的候选字段（intro_detail/score_detail 是产品说明书/评分明细的种子，供泳道卡片和详情页在未分析时回退展示）
  const PROJECT_SELECT = `
    SELECT p.*, c.intro_detail AS intro_detail, c.score_detail AS score_detail
    FROM projects p LEFT JOIN candidates c ON c.id = p.candidate_id
  `

  /** 按 project_id 聚合真实产物计数（各一条 SQL，不逐项目查库，避免 N+1） */
  function projectCounts(): Map<number, { copies: number; videos: number; published: number; leads: number }> {
    const assetRows = ctx.db.prepare(`
      SELECT project_id,
             SUM(type = 'copy') AS copies,
             SUM(type = 'video') AS videos,
             SUM(status = 'published') AS published
      FROM assets GROUP BY project_id
    `).all() as Array<{ project_id: number; copies: number; videos: number; published: number }>
    const leadRows = ctx.db.prepare(`
      SELECT a.project_id AS project_id, COUNT(*) AS leads
      FROM leads l JOIN assets a ON a.id = l.asset_id
      GROUP BY a.project_id
    `).all() as Array<{ project_id: number; leads: number }>
    const map = new Map<number, { copies: number; videos: number; published: number; leads: number }>()
    for (const r of assetRows) map.set(r.project_id, { copies: r.copies, videos: r.videos, published: r.published, leads: 0 })
    for (const r of leadRows) {
      const cur = map.get(r.project_id) ?? { copies: 0, videos: 0, published: 0, leads: 0 }
      cur.leads = r.leads
      map.set(r.project_id, cur)
    }
    return map
  }

  app.get('/api/projects', (c) => {
    const rows = ctx.db.prepare(`${PROJECT_SELECT} ORDER BY p.id`).all() as any[]
    const counts = projectCounts()
    // 附上 analysis.md 摘要给看板泳道卡片；没跑过分析的项目为空对象，不报错
    return c.json(rows.map((r) => {
      const p = path.join(ctx.config.paths.workspace, r.slug, 'analysis.md')
      const md = readFileSafe(p)
      return {
        ...r,
        analysis_summary: parseAnalysisSummary(md),
        counts: counts.get(r.id) ?? { copies: 0, videos: 0, published: 0, leads: 0 },
      }
    }))
  })

  app.get('/api/projects/:slug', (c) => {
    const row: any = ctx.db.prepare(`${PROJECT_SELECT} WHERE p.slug = ?`).get(c.req.param('slug'))
    if (!row) return c.json({ error: '项目不存在' }, 404)
    const analysisPath = path.join(ctx.config.paths.workspace, row.slug, 'analysis.md')
    const analysisMd = readFileSafe(analysisPath)
    const rebrandMd = readFileSafe(path.join(ctx.config.paths.workspace, row.slug, 'rebrand-plan.md'))
    return c.json({ ...row, analysisMd, rebrandMd })
  })

  app.patch('/api/projects/:slug', async (c) => {
    const slug = c.req.param('slug')
    const exists = ctx.db.prepare('SELECT id FROM projects WHERE slug = ?').get(slug)
    if (!exists) return c.json({ error: '项目不存在' }, 404)
    const body = await c.req.json()
    if ('stage' in body && !isStage(body.stage)) return c.json({ error: '非法 stage' }, 400)
    const keys = PATCHABLE.filter((k) => k in body)
    if (keys.length) {
      ctx.db.prepare(`UPDATE projects SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE slug = ?`)
        .run(...keys.map((k) => body[k]), slug)
    }
    return c.json({ ok: true })
  })

  app.delete('/api/projects/:slug', (c) => {
    const slug = c.req.param('slug')
    try {
      deleteProject(ctx, slug)
      return c.json({ ok: true })
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e)
      if (m.includes('不存在')) return c.json({ error: m }, 404)
      return c.json({ error: m }, m.includes('询单') ? 409 : 500) // 询单护栏→409，其它→500
    }
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
      scout: { weights: { ...cfg.scout.weights } },
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

  // 独立重新生成封面：:id 是 copy 素材 id（读它的正文重新解析封面文案，不重跑文案生成）
  app.post('/api/assets/:id/cover', async (c) => {
    const id = Number(c.req.param('id'))
    if (!ctx.db.prepare("SELECT id FROM assets WHERE id = ? AND type = 'copy'").get(id)) return c.json({ error: '文案素材不存在' }, 404)
    const body = await c.req.json().catch(() => ({}))
    const taskId = queue.enqueue((log) => regenerateCover(ctx, id, {
      template: typeof body.template === 'string' ? body.template : undefined,
      shot: typeof body.shot === 'string' ? body.shot : undefined,
    }).then((r) => { log(`封面完成: ${r.filePath}`); return r }))
    return c.json({ taskId })
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

  // —— shots 上传与列表（demo 视频模板用；readShots 只吃 png/jpg/webp，上传时同一白名单拦非法扩展名）——
  app.post('/api/projects/:slug/shots', async (c) => {
    const slug = c.req.param('slug')
    if (!ctx.db.prepare('SELECT id FROM projects WHERE slug = ?').get(slug)) return c.json({ error: '项目不存在' }, 404)
    const body = await c.req.parseBody()
    const file = body.file
    if (!(file instanceof File)) return c.json({ error: '缺少 file 字段' }, 400)
    const safeName = path.basename(file.name)
    if (!/\.(png|jpe?g|webp)$/i.test(safeName)) return c.json({ error: '仅支持 png/jpg/jpeg/webp' }, 400)
    const shotsDir = path.join(ctx.config.paths.workspace, slug, 'shots')
    fs.mkdirSync(shotsDir, { recursive: true })
    fs.writeFileSync(path.join(shotsDir, safeName), Buffer.from(await file.arrayBuffer()))
    return c.json({ ok: true, name: safeName })
  })

  app.get('/api/projects/:slug/shots', (c) => {
    const dir = path.join(ctx.config.paths.workspace, c.req.param('slug'), 'shots')
    return c.json({ files: fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [] })
  })

  // AI 生成演示图：LLM 写 3 份完整 HTML（仪表盘/列表/详情）+ Playwright 截图，落进 shots/
  app.post('/api/projects/:slug/screens', async (c) => {
    const slug = c.req.param('slug')
    if (!ctx.db.prepare('SELECT id FROM projects WHERE slug = ?').get(slug)) return c.json({ error: '项目不存在' }, 404)
    const taskId = queue.enqueue((log) => generateDemoScreens(ctx, slug, { onProgress: log }))
    return c.json({ taskId })
  })

  // —— 拍摄脚本（LLM 从文案扩展分镜表）/ 成片上传 / 审片（人机协作主线）——
  app.post('/api/projects/:slug/script', async (c) => {
    const slug = c.req.param('slug')
    if (!ctx.db.prepare('SELECT id FROM projects WHERE slug = ?').get(slug)) return c.json({ error: '项目不存在' }, 404)
    const body = await c.req.json().catch(() => ({}))
    const taskId = queue.enqueue((log) => generateShootScript(ctx, {
      slug, assetId: typeof body.assetId === 'number' ? body.assetId : undefined,
      mode: ['screen', 'live', 'mixed'].includes(body.mode) ? body.mode : undefined, // 缺省 screen（录屏+口播）
      onProgress: log,
    }))
    return c.json({ taskId })
  })

  app.post('/api/projects/:slug/upload-video', async (c) => {
    const slug = c.req.param('slug')
    const project: any = ctx.db.prepare('SELECT id FROM projects WHERE slug = ?').get(slug)
    if (!project) return c.json({ error: '项目不存在' }, 404)
    const body = await c.req.parseBody()
    const file = body.file
    if (!(file instanceof File)) return c.json({ error: '缺少 file 字段' }, 400)
    const safeName = path.basename(file.name)
    if (!/\.(mp4|mov|m4v)$/i.test(safeName)) return c.json({ error: '仅支持 mp4/mov/m4v' }, 400)
    const dir = path.join(ctx.config.paths.workspace, slug, 'uploads')
    fs.mkdirSync(dir, { recursive: true })
    // 同名文件不覆盖旧成片：加时间戳前缀（旧素材行还指着旧文件）
    const finalName = fs.existsSync(path.join(dir, safeName)) ? `${Date.now()}-${safeName}` : safeName
    fs.writeFileSync(path.join(dir, finalName), Buffer.from(await file.arrayBuffer()))
    const relPath = path.join(slug, 'uploads', finalName)
    const info = ctx.db.prepare(
      "INSERT INTO assets (project_id, type, hook, file_path, warnings, origin) VALUES (?, 'video', NULL, ?, '[]', 'upload')",
    ).run(project.id, relPath)
    return c.json({ ok: true, assetId: Number(info.lastInsertRowid), name: finalName })
  })

  app.post('/api/templates', async (c) => {
    const body = await c.req.parseBody()
    const file = body.file
    if (!(file instanceof File)) return c.json({ error: '缺少 file 字段' }, 400)
    const aspectRatio = body.aspectRatio === 'portrait' || body.aspectRatio === 'landscape' ? body.aspectRatio : null
    if (!aspectRatio) return c.json({ error: 'aspectRatio 必须是 portrait 或 landscape' }, 400)
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    if (!name) return c.json({ error: '缺少模板名称' }, 400)
    const safeName = path.basename(file.name)
    if (!/\.(mp4|mov|m4v)$/i.test(safeName)) return c.json({ error: '仅支持 mp4/mov/m4v' }, 400)
    const styleNote = typeof body.styleNote === 'string' && body.styleNote.trim() ? body.styleNote.trim() : undefined

    const dirId = randomUUID()
    const dir = path.join(ctx.config.paths.workspace, '_templates', dirId)
    fs.mkdirSync(dir, { recursive: true })
    const ext = path.extname(safeName) || '.mp4'
    const benchmarkAbsPath = path.join(dir, `benchmark${ext}`)
    fs.writeFileSync(benchmarkAbsPath, Buffer.from(await file.arrayBuffer()))
    const benchmarkRelPath = path.relative(ctx.config.paths.workspace, benchmarkAbsPath)

    const taskId = queue.enqueue((log) => createCustomTemplate(ctx, {
      name, aspectRatio, styleNote, benchmarkAbsPath, benchmarkRelPath, onProgress: log,
    }))
    return c.json({ taskId })
  })

  app.get('/api/templates', (c) => {
    const rows = ctx.db.prepare(
      'SELECT id, name, aspect_ratio, segment_count, style_note, created_at FROM custom_templates ORDER BY id DESC',
    ).all()
    return c.json(rows)
  })

  app.delete('/api/templates/:id', (c) => {
    const id = Number(c.req.param('id'))
    const row: any = ctx.db.prepare('SELECT * FROM custom_templates WHERE id = ?').get(id)
    if (!row) return c.json({ error: '模板不存在' }, 404)
    ctx.db.prepare('DELETE FROM custom_templates WHERE id = ?').run(id)
    const htmlPath = customTemplateHtmlPath(ctx, id)
    if (fs.existsSync(htmlPath)) fs.rmSync(htmlPath)
    if (row.benchmark_path) {
      const benchDir = path.dirname(path.join(ctx.config.paths.workspace, row.benchmark_path))
      if (fs.existsSync(benchDir)) fs.rmSync(benchDir, { recursive: true, force: true })
    }
    return c.json({ ok: true })
  })

  app.post('/api/assets/:id/review', async (c) => {
    const id = Number(c.req.param('id'))
    const body = await c.req.json().catch(() => ({}))
    const taskId = queue.enqueue((log) => reviewVideo(ctx, id, {
      scriptAssetId: typeof body.scriptAssetId === 'number' ? body.scriptAssetId : undefined, onProgress: log,
    }))
    return c.json({ taskId })
  })

  app.post('/api/assets/:id/retro', (c) => {
    const id = Number(c.req.param('id'))
    const taskId = queue.enqueue((log) => generateRetro(ctx, id, { onProgress: log }))
    return c.json({ taskId })
  })

  // —— workspace 静态文件（封面/视频预览）——
  const MIME: Record<string, string> = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
    '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.m4v': 'video/mp4', '.md': 'text/markdown; charset=utf-8',
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

  app.post('/api/scout/breakouts', async (c) => {
    const body = await c.req.json().catch(() => ({}))
    const taskId = queue.enqueue((log) => scoutBreakouts(ctx, {
      minStars: typeof body.minStars === 'number' ? body.minStars : undefined,
      withinDays: typeof body.withinDays === 'number' ? body.withinDays : undefined,
      limit: typeof body.limit === 'number' ? body.limit : undefined,
    }).then((r) => {
      log(`发现 ${r.found} 个爆款候选，评分 ${r.scored}，协议不过 ${r.rejected}`)
      for (const h of r.hits) log(`  🔥 ${h.repo}`)
      return r
    }))
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
      'SELECT id, repo, url, license, license_ok, stars, last_commit, tech_stack, description, score, score_detail, status, favorite, created_at FROM candidates ORDER BY license_ok DESC, (score IS NULL), score DESC',
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

  app.post('/api/candidates/backfill-summary', (c) => {
    const taskId = queue.enqueue(async (log) => {
      const need = candidatesNeedingSummary(ctx)
      if (!need.length) { log('无需补充：候选都已有中文简介'); return }
      if (ctx.config.llm.mode === 'mock') { log('⚠ 当前为 mock 模式，中文简介不会真生成；请先到「设置」把大模型切 live 并填 key'); return }
      log(`共 ${need.length} 个候选需补中文简介，开始…`)
      let ok = 0, fail = 0
      for (const [i, id] of need.entries()) {
        const repo = (ctx.db.prepare('SELECT repo FROM candidates WHERE id = ?').get(id) as any)?.repo ?? id
        log(`生成中 ${i + 1}/${need.length}：${repo}`)
        try { await backfillCandidateSummary(ctx, id); ok++ } catch (e) { fail++; log(`⚠ ${repo} 生成失败：${e instanceof Error ? e.message : String(e)}`) }
      }
      log(`完成：补充 ${ok} 个，失败跳过 ${fail} 个`)
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

  app.post('/api/candidates/:id/intro', async (c) => {
    const id = Number(c.req.param('id'))
    if (!Number.isInteger(id)) return c.json({ error: '非法 id' }, 400)
    const row = ctx.db.prepare('SELECT intro_detail FROM candidates WHERE id = ?').get(id) as { intro_detail: string | null } | undefined
    if (!row) return c.json({ error: '候选不存在' }, 404)
    // mock 模式不生成（详情需 live 大模型），前端据此提示切 live
    if (ctx.config.llm.mode === 'mock') return c.json({ mode: 'mock' })
    const { force } = await c.req.json().catch(() => ({}))
    if (row.intro_detail && !force) {
      try { return c.json({ mode: 'live', cached: true, intro: JSON.parse(row.intro_detail) }) } catch { /* 坏缓存 → 落到重生成 */ }
    }
    try {
      const intro = await generateCandidateIntro(ctx, id)
      ctx.db.prepare('UPDATE candidates SET intro_detail = ? WHERE id = ?').run(JSON.stringify(intro), id)
      return c.json({ mode: 'live', cached: false, intro })
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500)
    }
  })

  app.post('/api/candidates/:id/favorite', async (c) => {
    const id = c.req.param('id')
    if (!ctx.db.prepare('SELECT id FROM candidates WHERE id = ?').get(id)) return c.json({ error: '候选不存在' }, 404)
    const body = await c.req.json().catch(() => ({}))
    ctx.db.prepare('UPDATE candidates SET favorite = ? WHERE id = ?').run(body.favorite ? 1 : 0, id)
    return c.json({ ok: true })
  })

  app.get('/api/scout/auto-status', (c) => {
    const cfg = readAutoScoutCfg(ctx.db)
    const s = getAllSettings(ctx.db)
    let lastResult: unknown = null
    try { lastResult = s.auto_scout_last_result ? JSON.parse(s.auto_scout_last_result) : null } catch { /* 坏 JSON 兜底 null */ }
    return c.json({ enabled: cfg.enabled, time: cfg.time, lastRun: s.auto_scout_last_run ?? null, lastResult })
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
    // tpl 白名单校验：story/demo/changelog/insight 显式放行，其余（含未传）一律回落 flash
    const tpl = ['story', 'demo', 'changelog', 'insight'].includes(body.tpl) || /^custom-\d+$/.test(body.tpl)
      ? body.tpl : 'flash'
    const taskId = queue.enqueue((log) => generateVideo(ctx, {
      slug,
      assetId: typeof body.assetId === 'number' ? body.assetId : undefined,
      tpl,
      bgm: typeof body.bgm === 'string' ? body.bgm : undefined,
      mood: typeof body.mood === 'string' ? body.mood : undefined,
      bg: typeof body.bg === 'string' ? body.bg : undefined,
      captions: typeof body.captions === 'boolean' ? body.captions : undefined,
      onProgress: log,
    }))
    return c.json({ taskId })
  })

  // 曲库列表：根目录 + tense/upbeat/tech/warm 四个情绪子目录（存在才扫），前端拼 BGM 下拉用
  app.get('/api/bgm', (c) => {
    const bgmDir = path.join(ctx.config.paths.templates, 'bgm')
    const isAudio = (f: string) => /\.(mp3|wav|m4a)$/i.test(f)
    const listDir = (dir: string) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter(isAudio).sort() : [])
    const root = listDir(bgmDir)
    const byMood: Record<string, string[]> = {}
    for (const mood of ['tense', 'upbeat', 'tech', 'warm']) {
      const files = listDir(path.join(bgmDir, mood))
      if (files.length) byMood[mood] = files
    }
    return c.json({ root, byMood })
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

  // —— 定制项目板块（tailor）——
  const tailorExists = (id: number) => !!ctx.db.prepare('SELECT id FROM tailor_requests WHERE id = ?').get(id)
  const DECISIONS = ['pending', 'wheel', 'self_build', 'dropped']

  app.get('/api/tailor', (c) => c.json(listRequests(ctx)))
  app.post('/api/tailor', async (c) => {
    const body = await c.req.json().catch(() => ({}))
    if (typeof body.title !== 'string' || !body.title.trim()) return c.json({ error: '缺少 title' }, 400)
    if (typeof body.rawNeed !== 'string' || !body.rawNeed.trim()) return c.json({ error: '缺少 rawNeed' }, 400)
    return c.json(addRequest(ctx, { title: body.title, rawNeed: body.rawNeed }))
  })
  app.get('/api/tailor/:id', (c) => {
    const id = Number(c.req.param('id'))
    if (!tailorExists(id)) return c.json({ error: '需求不存在' }, 404)
    return c.json(getRequestDetail(ctx, id))
  })
  app.post('/api/tailor/:id/decompose', (c) => {
    const id = Number(c.req.param('id'))
    if (!tailorExists(id)) return c.json({ error: '需求不存在' }, 404)
    return c.json({ taskId: queue.enqueue((log) => decomposeRequest(ctx, id, { onProgress: log })) })
  })
  app.post('/api/tailor/:id/search', async (c) => {
    const id = Number(c.req.param('id'))
    if (!tailorExists(id)) return c.json({ error: '需求不存在' }, 404)
    const st = (ctx.db.prepare('SELECT status FROM tailor_requests WHERE id = ?').get(id) as any).status
    if (st === 'draft') return c.json({ error: '先拆解需求再搜轮子' }, 400)
    const body = await c.req.json().catch(() => ({}))
    const capabilityId = typeof body.capabilityId === 'number' ? body.capabilityId : undefined
    return c.json({ taskId: queue.enqueue((log) => searchWheels(ctx, id, { capabilityId, onProgress: log })) })
  })
  app.post('/api/tailor/:id/proposal', (c) => {
    const id = Number(c.req.param('id'))
    if (!tailorExists(id)) return c.json({ error: '需求不存在' }, 404)
    // 决策门禁在路由层同步拦（同样的检查 generateProposal 内部还有一道，双保险）——用户要的是 400 而不是任务失败
    const total = (ctx.db.prepare('SELECT COUNT(*) AS n FROM tailor_capabilities WHERE request_id = ?').get(id) as any).n
    if (!total) return c.json({ error: '没有能力清单，先拆解需求' }, 400)
    const pending = (ctx.db.prepare("SELECT COUNT(*) AS n FROM tailor_capabilities WHERE request_id = ? AND decision = 'pending'").get(id) as any).n
    if (pending) return c.json({ error: `还有 ${pending} 项能力未决策，决策完才能出方案书` }, 400)
    return c.json({ taskId: queue.enqueue((log) => generateProposal(ctx, id, { onProgress: log })) })
  })
  app.get('/api/tailor/:id/proposal', (c) => {
    const id = Number(c.req.param('id'))
    const row = ctx.db.prepare('SELECT proposal_path FROM tailor_requests WHERE id = ?').get(id) as { proposal_path: string | null } | undefined
    if (!row) return c.json({ error: '需求不存在' }, 404)
    if (!row.proposal_path) return c.json({ error: '方案书未生成' }, 404)
    return c.json({ md: readFileSafe(path.join(ctx.config.paths.workspace, row.proposal_path)) })
  })
  app.post('/api/tailor/:id/capabilities', async (c) => {
    const id = Number(c.req.param('id'))
    if (!tailorExists(id)) return c.json({ error: '需求不存在' }, 404)
    const body = await c.req.json().catch(() => ({}))
    if (typeof body.name !== 'string' || !body.name.trim()) return c.json({ error: '缺少 name' }, 400)
    const keywords = Array.isArray(body.keywords) ? body.keywords.filter((x: unknown): x is string => typeof x === 'string') : []
    return c.json(addCapability(ctx, id, { name: body.name, detail: body.detail, keywords }))
  })
  app.patch('/api/tailor/capabilities/:capId', async (c) => {
    const capId = Number(c.req.param('capId'))
    const body = await c.req.json().catch(() => ({}))
    if (body.decision !== undefined && !DECISIONS.includes(body.decision)) return c.json({ error: `decision 须为 ${DECISIONS.join('/')}` }, 400)
    try {
      updateCapability(ctx, capId, body)
      return c.json({ ok: true })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return c.json({ error: msg }, msg.includes('不存在') ? 404 : 400)
    }
  })
  app.delete('/api/tailor/capabilities/:capId', (c) => {
    deleteCapability(ctx, Number(c.req.param('capId')))
    return c.json({ ok: true })
  })
  app.post('/api/leads/:id/to-tailor', (c) => {
    try {
      return c.json(requestFromLead(ctx, Number(c.req.param('id'))))
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return c.json({ error: msg }, msg.includes('不存在') ? 404 : 400)
    }
  })

  // —— 选题库 ——
  app.get('/api/topics/sources', (c) => c.json(listSources(ctx)))
  app.post('/api/topics/sources', async (c) => {
    const body = await c.req.json().catch(() => ({}))
    if (body.platform !== 'douyin' && body.platform !== 'xiaohongshu') return c.json({ error: 'platform 必须是 douyin/xiaohongshu' }, 400)
    if (typeof body.handle !== 'string' || !body.handle.trim()) return c.json({ error: '缺少 handle' }, 400)
    try {
      return c.json(addSource(ctx, {
        platform: body.platform, handle: body.handle,
        displayName: body.displayName, followerCount: body.followerCount, note: body.note,
      }))
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400)
    }
  })
  app.put('/api/topics/sources/:id', async (c) => {
    const id = Number(c.req.param('id'))
    const body = await c.req.json().catch(() => ({}))
    try {
      updateSource(ctx, id, { followerCount: body.followerCount, note: body.note })
      return c.json({ ok: true })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return c.json({ error: msg }, msg.includes('不存在') ? 404 : 400)
    }
  })
  app.delete('/api/topics/sources/:id', (c) => {
    deleteSource(ctx, Number(c.req.param('id')))
    return c.json({ ok: true })
  })
  app.post('/api/topics/sources/:id/request-scrape', (c) => {
    const id = Number(c.req.param('id'))
    try {
      requestScrape(ctx, id)
      return c.json({ ok: true })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return c.json({ error: msg }, msg.includes('不存在') ? 404 : 400)
    }
  })
  app.get('/api/topics/patterns', (c) => {
    const hook = c.req.query('hook')
    return c.json(listPatterns(ctx, hook as any))
  })
  app.post('/api/topics/extract', async (c) => {
    const body = await c.req.json().catch(() => ({}))
    const taskId = queue.enqueue((log) => extractPatterns(ctx, {
      topN: typeof body.top === 'number' ? body.top : undefined,
      minRatio: typeof body.minRatio === 'number' ? body.minRatio : undefined,
      onProgress: log,
    }))
    return c.json({ taskId })
  })

  // —— 需求信号库（demand）。采集由 agent 会话完成后经 import 导入，服务端零抓取逻辑 ——
  app.get('/api/demand/signals', (c) => {
    const q = c.req.query()
    return c.json(listSignals(ctx, { source: q.source, kind: q.kind, status: q.status }))
  })
  app.post('/api/demand/import', async (c) => {
    const body = await c.req.json().catch(() => ({}))
    if (!body?.source || !Array.isArray(body?.signals)) return c.json({ error: 'source 与 signals 必填' }, 400)
    try {
      return c.json(importSignals(ctx, { source: body.source, signals: body.signals }))
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400)
    }
  })
  app.patch('/api/demand/signals/:id', async (c) => {
    const body = await c.req.json().catch(() => ({}))
    try {
      setSignalStatus(ctx, Number(c.req.param('id')), body.status)
      return c.json({ ok: true })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return c.json({ error: msg }, msg.includes('不存在') ? 404 : 400)
    }
  })
  app.post('/api/demand/extract', (c) => {
    const taskId = queue.enqueue((log) => extractSignals(ctx, { onProgress: log }))
    return c.json({ taskId })
  })
  app.post('/api/demand/request-collect', (c) => {
    requestCollect(ctx)
    return c.json({ ok: true })
  })
  app.get('/api/demand/collect-status', (c) => c.json(collectStatus(ctx)))
  app.post('/api/demand/signals/:id/match', (c) => {
    const id = Number(c.req.param('id'))
    const taskId = queue.enqueue((log) => matchSignal(ctx, id, { onProgress: log }))
    return c.json({ taskId })
  })
  app.get('/api/demand/signals/:id/matches', (c) => c.json(listMatches(ctx, Number(c.req.param('id')))))

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
