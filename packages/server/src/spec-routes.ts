import fs from 'node:fs'
import path from 'node:path'
import type { CoreCtx } from '@forgecast/core'
import { renderFromSpec, RewriteUnsupportedError, rewriteSection } from '@forgecast/studio'
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
    try { return c.json(JSON.parse(fs.readFileSync(p, 'utf8'))) } catch { return c.json({ error: 'spec 文件损坏' }, 500) }
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
    fs.writeFileSync(p, JSON.stringify(body, null, 2), 'utf8')
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
}
