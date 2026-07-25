import fs from 'node:fs'
import path from 'node:path'
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

/** 登记开发过程碎片（人工 Claude Code 录屏）为 process 视频素材，走 draft→approve→publish 生命周期（§5.2 第三内容类别） */
export function registerClip(ctx: CoreCtx, input: { slug: string; file: string }): { id: number } {
  const proj = ctx.db.prepare('SELECT id FROM projects WHERE slug = ?').get(input.slug) as { id: number } | undefined
  if (!proj) throw new Error(`项目不存在: ${input.slug}`)
  const info = ctx.db.prepare(
    "INSERT INTO assets (project_id, type, hook, file_path, status) VALUES (?, 'video', 'process', ?, 'draft')",
  ).run(proj.id, input.file)
  return { id: Number(info.lastInsertRowid) }
}

/** 审核通过：draft/approved → approved（发布前的确认门）；已 published 的不回退 */
export function approveAsset(ctx: CoreCtx, assetId: number): void {
  assertAsset(ctx, assetId)
  ctx.db.prepare("UPDATE assets SET status = 'approved' WHERE id = ? AND status != 'published'").run(assetId)
}

/** 硬删素材：删 DB 行 + 磁盘文件。有关联询单则拦下（保护归因数据）。文件缺失不报错。 */
export function deleteAsset(ctx: CoreCtx, assetId: number): void {
  const row = ctx.db.prepare('SELECT id, file_path FROM assets WHERE id = ?').get(assetId) as { id: number; file_path: string } | undefined
  if (!row) throw new Error(`素材不存在: ${assetId}`)
  const lead = ctx.db.prepare('SELECT COUNT(*) AS n FROM leads WHERE asset_id = ?').get(assetId) as { n: number }
  if (lead.n > 0) throw new Error('该素材有关联询单，不能删除')
  // 删文件：解析后必须落在 workspace 内（防 file_path 里的 ../ 穿越），且文件存在才删
  const ws = path.resolve(ctx.config.paths.workspace)
  const abs = path.resolve(ws, row.file_path)
  if (abs.startsWith(ws + path.sep) && fs.existsSync(abs)) fs.rmSync(abs)
  ctx.db.prepare('DELETE FROM assets WHERE id = ?').run(assetId)
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
