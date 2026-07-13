import fs from 'node:fs'
import path from 'node:path'
import type { CoreCtx } from '@forgecast/core'
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

  return app
}
