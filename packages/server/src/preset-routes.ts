import type { CoreCtx } from '@forgecast/core'
import type { Hono } from 'hono'

/** style_presets.layer_kind 白名单：VideoSpec.Layer.kind 去掉 'video'（品牌预设只套非底片层）。 */
const LAYER_KINDS = ['text', 'image', 'caption', 'shape'] as const
/** layout_templates.template 白名单：出片可选的六个模板（custom-* 走独立管线，不纳入版式套用范围）。 */
const TEMPLATES = ['flash', 'story', 'demo', 'changelog', 'insight', 'talk'] as const
const RATIOS = ['portrait', 'landscape'] as const

const HEX_RE = /^#[0-9a-fA-F]{6}$/
const BRAND_KIT_KEYS = ['primaryColor', 'accentColor', 'titleScale', 'ctaText'] as const

/** brand-kit PUT 校验：色值 hex、titleScale 0.5-2、ctaText <=60 字符、未知键 400。合法返回 null。 */
export function validateBrandKit(body: any): string | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return '请求体不是有效的 kit'
  for (const key of Object.keys(body)) {
    if (!(BRAND_KIT_KEYS as readonly string[]).includes(key)) return `未知字段: ${key}`
  }
  if (body.primaryColor !== undefined && (typeof body.primaryColor !== 'string' || !HEX_RE.test(body.primaryColor))) {
    return 'primaryColor 必须是形如 #RRGGBB 的色值'
  }
  if (body.accentColor !== undefined && (typeof body.accentColor !== 'string' || !HEX_RE.test(body.accentColor))) {
    return 'accentColor 必须是形如 #RRGGBB 的色值'
  }
  if (body.titleScale !== undefined
    && (typeof body.titleScale !== 'number' || !(body.titleScale >= 0.5 && body.titleScale <= 2))) {
    return 'titleScale 必须是 0.5-2 之间的数字'
  }
  if (body.ctaText !== undefined && (typeof body.ctaText !== 'string' || body.ctaText.length > 60)) {
    return 'ctaText 必须是不超过 60 字符的字符串'
  }
  return null
}

/** 挂载预设/版式模板/品牌 kit 三组 CRUD 路由。与 spec-routes.ts 同风格：纯路由 + 直连 sqlite。 */
export function registerPresetRoutes(app: Hono, ctx: CoreCtx): void {
  // —— 风格预设 ——
  app.get('/api/style-presets', (c) => {
    const rows = ctx.db.prepare('SELECT id, name, layer_kind, payload, created_at FROM style_presets ORDER BY id DESC').all() as any[]
    return c.json(rows.map((r) => ({
      id: r.id, name: r.name, layerKind: r.layer_kind, payload: JSON.parse(r.payload), createdAt: r.created_at,
    })))
  })

  app.post('/api/style-presets', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) ?? {}
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    if (!name) return c.json({ error: '缺少预设名称' }, 400)
    if (!(LAYER_KINDS as readonly string[]).includes(body.layerKind)) {
      return c.json({ error: `layerKind 必须是 ${LAYER_KINDS.join('/')} 之一` }, 400)
    }
    if (!body.payload || typeof body.payload !== 'object' || Array.isArray(body.payload)) {
      return c.json({ error: 'payload 必须是对象' }, 400)
    }
    if (ctx.db.prepare('SELECT id FROM style_presets WHERE name = ?').get(name)) {
      return c.json({ error: `预设名称已存在: ${name}` }, 400)
    }
    const info = ctx.db.prepare('INSERT INTO style_presets (name, layer_kind, payload) VALUES (?, ?, ?)')
      .run(name, body.layerKind, JSON.stringify(body.payload))
    return c.json({ id: Number(info.lastInsertRowid) })
  })

  app.delete('/api/style-presets/:id', (c) => {
    const id = Number(c.req.param('id'))
    if (!Number.isFinite(id) || !ctx.db.prepare('SELECT id FROM style_presets WHERE id = ?').get(id)) {
      return c.json({ error: '预设不存在' }, 404)
    }
    ctx.db.prepare('DELETE FROM style_presets WHERE id = ?').run(id)
    return c.json({ ok: true })
  })

  // —— 版式模板 ——
  app.get('/api/layout-templates', (c) => {
    const rows = ctx.db.prepare('SELECT id, name, template, ratio, payload, created_at FROM layout_templates ORDER BY id DESC').all() as any[]
    return c.json(rows.map((r) => ({
      id: r.id, name: r.name, template: r.template, ratio: r.ratio, payload: JSON.parse(r.payload), createdAt: r.created_at,
    })))
  })

  app.post('/api/layout-templates', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) ?? {}
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    if (!name) return c.json({ error: '缺少模板名称' }, 400)
    if (!(TEMPLATES as readonly string[]).includes(body.template)) {
      return c.json({ error: `template 必须是 ${TEMPLATES.join('/')} 之一` }, 400)
    }
    const ratio = body.ratio === undefined ? 'portrait' : body.ratio
    if (!(RATIOS as readonly string[]).includes(ratio)) {
      return c.json({ error: 'ratio 必须是 portrait/landscape 之一' }, 400)
    }
    if (!Array.isArray(body.payload)) {
      return c.json({ error: 'payload 必须是数组' }, 400)
    }
    if (ctx.db.prepare('SELECT id FROM layout_templates WHERE name = ?').get(name)) {
      return c.json({ error: `模板名称已存在: ${name}` }, 400)
    }
    const info = ctx.db.prepare('INSERT INTO layout_templates (name, template, ratio, payload) VALUES (?, ?, ?, ?)')
      .run(name, body.template, ratio, JSON.stringify(body.payload))
    return c.json({ id: Number(info.lastInsertRowid) })
  })

  app.delete('/api/layout-templates/:id', (c) => {
    const id = Number(c.req.param('id'))
    if (!Number.isFinite(id) || !ctx.db.prepare('SELECT id FROM layout_templates WHERE id = ?').get(id)) {
      return c.json({ error: '模板不存在' }, 404)
    }
    ctx.db.prepare('DELETE FROM layout_templates WHERE id = ?').run(id)
    return c.json({ ok: true })
  })

  // —— 项目品牌 kit ——
  app.get('/api/projects/:slug/brand-kit', (c) => {
    const slug = c.req.param('slug')
    const project: any = ctx.db.prepare('SELECT brand_kit FROM projects WHERE slug = ?').get(slug)
    if (!project) return c.json({ error: '项目不存在' }, 404)
    if (!project.brand_kit) return c.json({})
    try { return c.json(JSON.parse(project.brand_kit)) } catch { return c.json({}) }
  })

  app.put('/api/projects/:slug/brand-kit', async (c) => {
    const slug = c.req.param('slug')
    const project: any = ctx.db.prepare('SELECT id FROM projects WHERE slug = ?').get(slug)
    if (!project) return c.json({ error: '项目不存在' }, 404)
    const body = await c.req.json().catch(() => null)
    const err = validateBrandKit(body)
    if (err) return c.json({ error: err }, 400)
    ctx.db.prepare('UPDATE projects SET brand_kit = ? WHERE id = ?').run(JSON.stringify(body), project.id)
    return c.json(body)
  })
}
