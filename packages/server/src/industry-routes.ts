import type { CoreCtx } from '@forgecast/core'
import { generateIndustryQueries, type Industry } from '@forgecast/scout'
import type { Hono } from 'hono'

/** 挂载行业 CRUD 路由。与 preset-routes.ts 同风格：纯路由 + 直连 sqlite。
 *  DELETE 必须在同一事务里显式删 industry_queries 对应行——本仓没开
 *  `PRAGMA foreign_keys`，industry_queries 的 `ON DELETE CASCADE` 不生效，
 *  光删 industries 会留孤儿缓存行。 */
export function registerIndustryRoutes(app: Hono, ctx: CoreCtx): void {
  app.get('/api/industries', (c) => {
    const rows = ctx.db.prepare(
      `SELECT i.id, i.name, i.note, i.enabled, i.sort_order,
              iq.keywords AS keywords, iq.generated_at AS generated_at
       FROM industries i
       LEFT JOIN industry_queries iq ON iq.industry_id = i.id
       ORDER BY i.sort_order, i.id`,
    ).all() as any[]
    return c.json(rows.map((r) => {
      let keywordCount = 0
      if (r.keywords) {
        try {
          const kws = JSON.parse(r.keywords)
          if (Array.isArray(kws)) keywordCount = kws.length
        } catch { /* 缓存坏了当 0 个 */ }
      }
      return {
        id: r.id, name: r.name, note: r.note, enabled: !!r.enabled, sortOrder: r.sort_order,
        keywordCount, generatedAt: r.generated_at ?? null,
      }
    }))
  })

  app.post('/api/industries', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) ?? {}
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    if (!name) return c.json({ error: '缺少行业名称' }, 400)
    if (ctx.db.prepare('SELECT id FROM industries WHERE name = ?').get(name)) {
      return c.json({ error: `行业名称已存在: ${name}` }, 400)
    }
    const note = typeof body.note === 'string' ? body.note : null
    const info = ctx.db.prepare('INSERT INTO industries (name, note) VALUES (?, ?)').run(name, note)
    return c.json({ id: Number(info.lastInsertRowid) })
  })

  app.patch('/api/industries/:id', async (c) => {
    const id = Number(c.req.param('id'))
    const existing: any = ctx.db.prepare('SELECT id FROM industries WHERE id = ?').get(id)
    if (!Number.isFinite(id) || !existing) return c.json({ error: '行业不存在' }, 404)
    const body = (await c.req.json().catch(() => ({}))) ?? {}

    const sets: string[] = []
    const params: any[] = []
    if (body.name !== undefined) {
      const name = typeof body.name === 'string' ? body.name.trim() : ''
      if (!name) return c.json({ error: '行业名称不能为空' }, 400)
      const dup: any = ctx.db.prepare('SELECT id FROM industries WHERE name = ? AND id != ?').get(name, id)
      if (dup) return c.json({ error: `行业名称已存在: ${name}` }, 400)
      sets.push('name = ?'); params.push(name)
    }
    if (body.note !== undefined) {
      if (body.note !== null && typeof body.note !== 'string') return c.json({ error: 'note 必须是字符串' }, 400)
      sets.push('note = ?'); params.push(body.note)
    }
    if (body.enabled !== undefined) {
      if (typeof body.enabled !== 'boolean') return c.json({ error: 'enabled 必须是布尔值' }, 400)
      sets.push('enabled = ?'); params.push(body.enabled ? 1 : 0)
    }
    if (body.sortOrder !== undefined) {
      if (typeof body.sortOrder !== 'number' || !Number.isFinite(body.sortOrder)) {
        return c.json({ error: 'sortOrder 必须是数字' }, 400)
      }
      sets.push('sort_order = ?'); params.push(body.sortOrder)
    }
    if (sets.length) {
      params.push(id)
      ctx.db.prepare(`UPDATE industries SET ${sets.join(', ')} WHERE id = ?`).run(...params)
    }
    return c.json({ ok: true })
  })

  app.delete('/api/industries/:id', (c) => {
    const id = Number(c.req.param('id'))
    if (!Number.isFinite(id) || !ctx.db.prepare('SELECT id FROM industries WHERE id = ?').get(id)) {
      return c.json({ error: '行业不存在' }, 404)
    }
    // 同一事务显式删缓存行：本仓未开 PRAGMA foreign_keys，ON DELETE CASCADE 不生效。
    const tx = ctx.db.transaction(() => {
      ctx.db.prepare('DELETE FROM industry_queries WHERE industry_id = ?').run(id)
      ctx.db.prepare('DELETE FROM industries WHERE id = ?').run(id)
    })
    tx()
    return c.json({ ok: true })
  })

  app.post('/api/industries/:id/queries', async (c) => {
    const id = Number(c.req.param('id'))
    const industry = ctx.db.prepare('SELECT id, name, note, enabled FROM industries WHERE id = ?').get(id) as
      Industry | undefined
    if (!Number.isFinite(id) || !industry) return c.json({ error: '行业不存在' }, 404)
    const keywords = await generateIndustryQueries(ctx, industry)
    return c.json({ keywords })
  })
}
