import fs from 'node:fs'
import path from 'node:path'
import { analyzeProject } from '@forgecast/analyst'
import { HOOKS, type CoreCtx } from '@forgecast/core'
import { generateCopy } from '@forgecast/copywriter'
import { addLead, calendarSuggestions, listLeads, publishAsset, recordPerf, weeklyReport } from '@forgecast/ops'
import { rebrandPlan } from '@forgecast/rebrand'
import { addRepo, pickCandidate, scoutCandidates } from '@forgecast/scout'
import { generateVideo } from '@forgecast/studio'
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import type { TaskEvent, TaskQueue } from './tasks'

// 可通过 PATCH 修改的项目字段白名单
const PATCHABLE = ['brand_name', 'target_buyer', 'demo_url', 'price_deploy', 'price_custom', 'stage'] as const

/** 创建 Hono app：项目 REST API + 任务队列 SSE 进度流 */
export function createApp(ctx: CoreCtx, queue: TaskQueue): Hono {
  const app = new Hono()

  app.get('/api/projects', (c) => {
    return c.json(ctx.db.prepare('SELECT * FROM projects ORDER BY id').all())
  })

  app.get('/api/projects/:slug', (c) => {
    const row: any = ctx.db.prepare('SELECT * FROM projects WHERE slug = ?').get(c.req.param('slug'))
    if (!row) return c.json({ error: '项目不存在' }, 404)
    const analysisPath = path.join(ctx.config.paths.workspace, row.slug, 'analysis.md')
    const analysisMd = fs.existsSync(analysisPath) ? fs.readFileSync(analysisPath, 'utf8') : ''
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
    // tpl 白名单校验：story/demo 显式放行，其余（含未传）一律回落 flash
    const tpl = ['story', 'demo'].includes(body.tpl) ? body.tpl : 'flash'
    const taskId = queue.enqueue((log) => generateVideo(ctx, {
      slug,
      assetId: typeof body.assetId === 'number' ? body.assetId : undefined,
      tpl,
      onProgress: log,
    }))
    return c.json({ taskId })
  })

  // —— M6 运营辅助 ——
  const assetExists = (id: string) => !!ctx.db.prepare('SELECT id FROM assets WHERE id = ?').get(id)

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

  return app
}
