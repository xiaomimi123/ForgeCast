import type { CoreCtx } from '@forgecast/core'

export interface Lead {
  id: number
  asset_id: number
  wechat: string | null
  intent: string | null
  status: string
  created_at: string
  hook: string | null
  slug: string | null
}

function assertAsset(ctx: CoreCtx, assetId: number): void {
  if (!ctx.db.prepare('SELECT id FROM assets WHERE id = ?').get(assetId)) {
    throw new Error(`素材不存在: ${assetId}`)
  }
}

/** 回填发布：状态置 published，记发布时间/平台/链接 */
export function publishAsset(ctx: CoreCtx, assetId: number, opts: { platform: string; url?: string }): void {
  assertAsset(ctx, assetId)
  ctx.db.prepare(
    "UPDATE assets SET status = 'published', published_at = datetime('now'), platform = ?, published_url = ? WHERE id = ?",
  ).run(opts.platform, opts.url ?? null, assetId)
}

/** 回填表现数据：曝光/赞/询单，存 perf JSON */
export function recordPerf(ctx: CoreCtx, assetId: number, perf: { views?: number; likes?: number; leads?: number }): void {
  assertAsset(ctx, assetId)
  const payload = JSON.stringify({
    views: perf.views ?? 0, likes: perf.likes ?? 0, leads: perf.leads ?? 0, recordedAt: new Date().toISOString(),
  })
  ctx.db.prepare('UPDATE assets SET perf = ? WHERE id = ?').run(payload, assetId)
}

/** 登记询单（归因到来源素材） */
export function addLead(ctx: CoreCtx, input: { assetId: number; wechat?: string; intent?: string }): { id: number } {
  assertAsset(ctx, input.assetId)
  const info = ctx.db.prepare('INSERT INTO leads (asset_id, wechat, intent) VALUES (?, ?, ?)')
    .run(input.assetId, input.wechat ?? null, input.intent ?? null)
  return { id: Number(info.lastInsertRowid) }
}

/** 列出所有询单，带来源素材的 hook 与项目 slug */
export function listLeads(ctx: CoreCtx): Lead[] {
  return ctx.db.prepare(`
    SELECT l.id, l.asset_id, l.wechat, l.intent, l.status, l.created_at,
           a.hook AS hook, p.slug AS slug
    FROM leads l
    LEFT JOIN assets a ON a.id = l.asset_id
    LEFT JOIN projects p ON p.id = a.project_id
    ORDER BY l.id DESC
  `).all() as Lead[]
}
