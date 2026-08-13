import type { CoreCtx } from '@forgecast/core'

export type DemandSource = 'douyin_hot' | 'xhs' | 'github_trending' | 'ecommerce'
export type DemandKind = 'traffic' | 'emotional' | 'supply'
export type DemandStatus = 'new' | 'starred' | 'dismissed' | 'matched'
export const DEMAND_SOURCES: DemandSource[] = ['douyin_hot', 'xhs', 'github_trending', 'ecommerce']
const STATUSES: DemandStatus[] = ['new', 'starred', 'dismissed', 'matched']

export interface DemandSignal {
  id: number
  source: DemandSource
  kind: DemandKind | null
  title: string
  summary: string | null
  /** JSON 串：链接/热度值/榜位等原始证据，自行解析 */
  evidence: string | null
  heat: number | null
  opportunity: string | null
  status: DemandStatus
  captured_at: string | null
  created_at: string
}

export interface RawSignal { title: string; summary?: string; evidence?: unknown; heat?: number }

/** settings 表直接写（采集标记不是用户配置项，不走 SETTING_KEYS 白名单） */
function setMeta(ctx: CoreCtx, key: string, value: string): void {
  ctx.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value)
}
function getMeta(ctx: CoreCtx, key: string): string | null {
  return (ctx.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? null
}

/**
 * 批量 upsert 一批采集到的原始信号（agent 会话内用 ego-browser 采集后导入，本函数不做任何抓取）。
 * 同 (source, title) 重复导入视为更新：summary/evidence/heat/captured_at 覆盖，
 * kind/opportunity/status 保留（分类和人工标记不被重复采集冲掉）。
 * 导入成功即清除「请求采集」标记并记录本次采集时间。
 */
export function importSignals(ctx: CoreCtx, input: { source: DemandSource; signals: RawSignal[] }): { imported: number; updated: number } {
  if (!DEMAND_SOURCES.includes(input.source)) throw new Error(`未知数据源: ${input.source}`)
  const now = new Date().toISOString()
  const findExisting = ctx.db.prepare('SELECT id FROM demand_signals WHERE source = ? AND title = ?')
  const upsert = ctx.db.prepare(`
    INSERT INTO demand_signals (source, title, summary, evidence, heat, captured_at)
    VALUES (@source, @title, @summary, @evidence, @heat, @captured_at)
    ON CONFLICT(source, title) DO UPDATE SET
      summary = excluded.summary, evidence = excluded.evidence,
      heat = excluded.heat, captured_at = excluded.captured_at
  `)
  let imported = 0
  let updated = 0
  for (const s of input.signals) {
    if (!s.title?.trim()) continue
    const exists = findExisting.get(input.source, s.title)
    upsert.run({
      source: input.source, title: s.title, summary: s.summary ?? null,
      evidence: s.evidence !== undefined ? JSON.stringify(s.evidence) : null,
      heat: s.heat ?? null, captured_at: now,
    })
    if (exists) updated++
    else imported++
  }
  setMeta(ctx, 'demand_last_collected_at', now)
  ctx.db.prepare("DELETE FROM settings WHERE key = 'demand_collect_requested_at'").run()
  return { imported, updated }
}

export function listSignals(ctx: CoreCtx, filter: { source?: string; kind?: string; status?: string } = {}): DemandSignal[] {
  const conds: string[] = []
  const args: string[] = []
  if (filter.source) { conds.push('source = ?'); args.push(filter.source) }
  if (filter.kind) { conds.push('kind = ?'); args.push(filter.kind) }
  if (filter.status) { conds.push('status = ?'); args.push(filter.status) }
  const where = conds.length ? ` WHERE ${conds.join(' AND ')}` : ''
  return ctx.db.prepare(`SELECT * FROM demand_signals${where} ORDER BY (heat IS NULL), heat DESC, id DESC`).all(...args) as DemandSignal[]
}

export function setSignalStatus(ctx: CoreCtx, id: number, status: DemandStatus): void {
  if (!STATUSES.includes(status)) throw new Error(`非法状态: ${status}`)
  const r = ctx.db.prepare('UPDATE demand_signals SET status = ? WHERE id = ?').run(status, id)
  if (r.changes === 0) throw new Error(`信号不存在: #${id}`)
}

/** Web「请求采集」按钮打标记；agent 会话导入后自动清除（见 importSignals） */
export function requestCollect(ctx: CoreCtx): void {
  setMeta(ctx, 'demand_collect_requested_at', new Date().toISOString())
}

export function collectStatus(ctx: CoreCtx): { requestedAt: string | null; lastCollectedAt: string | null } {
  return {
    requestedAt: getMeta(ctx, 'demand_collect_requested_at'),
    lastCollectedAt: getMeta(ctx, 'demand_last_collected_at'),
  }
}
