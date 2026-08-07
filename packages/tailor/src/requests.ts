import type { CoreCtx } from '@forgecast/core'
import type { CapabilityDecision, TailorCapabilityView, TailorRequest, TailorRequestDetail, TailorWheel } from './types'

/** keywords 列存 JSON 数组；坏数据兜底空数组，不让单行脏数据炸整个接口 */
export function parseKeywordsCol(raw: string | null): string[] {
  try {
    const v = JSON.parse(raw ?? '[]')
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch { return [] }
}

export function addRequest(ctx: CoreCtx, input: { title: string; rawNeed: string; leadId?: number }): { id: number } {
  const title = input.title.trim()
  const rawNeed = input.rawNeed.trim()
  if (!title || !rawNeed) throw new Error('title 与 rawNeed 必填')
  const r = ctx.db.prepare('INSERT INTO tailor_requests (title, raw_need, lead_id) VALUES (?, ?, ?)')
    .run(title, rawNeed, input.leadId ?? null)
  return { id: Number(r.lastInsertRowid) }
}

export function listRequests(ctx: CoreCtx): TailorRequest[] {
  return ctx.db.prepare('SELECT * FROM tailor_requests ORDER BY id DESC').all() as TailorRequest[]
}

export function getRequestDetail(ctx: CoreCtx, id: number): TailorRequestDetail {
  const request = ctx.db.prepare('SELECT * FROM tailor_requests WHERE id = ?').get(id) as TailorRequest | undefined
  if (!request) throw new Error(`定制需求不存在: ${id}`)
  const caps = ctx.db.prepare('SELECT * FROM tailor_capabilities WHERE request_id = ? ORDER BY sort, id').all(id) as any[]
  const capabilities: TailorCapabilityView[] = caps.map((c) => ({
    ...c,
    keywords: parseKeywordsCol(c.keywords),
    wheels: ctx.db.prepare('SELECT * FROM tailor_wheels WHERE capability_id = ? ORDER BY score DESC, id').all(c.id) as TailorWheel[],
  }))
  return { request, capabilities }
}

export function addCapability(ctx: CoreCtx, requestId: number, input: { name: string; detail?: string; keywords: string[] }): { id: number } {
  if (!ctx.db.prepare('SELECT id FROM tailor_requests WHERE id = ?').get(requestId)) throw new Error(`定制需求不存在: ${requestId}`)
  if (!input.name.trim()) throw new Error('name 必填')
  const max = (ctx.db.prepare('SELECT MAX(sort) AS m FROM tailor_capabilities WHERE request_id = ?').get(requestId) as any).m ?? 0
  const r = ctx.db.prepare('INSERT INTO tailor_capabilities (request_id, name, detail, keywords, sort) VALUES (?, ?, ?, ?, ?)')
    .run(requestId, input.name.trim(), input.detail ?? null, JSON.stringify(input.keywords), max + 1)
  return { id: Number(r.lastInsertRowid) }
}

export type CapabilityPatch = Partial<{
  name: string; detail: string; keywords: string[]
  decision: CapabilityDecision; chosenRepo: string | null
}>

export function updateCapability(ctx: CoreCtx, capId: number, patch: CapabilityPatch): void {
  const row = ctx.db.prepare('SELECT * FROM tailor_capabilities WHERE id = ?').get(capId) as { chosen_repo: string | null } | undefined
  if (!row) throw new Error(`能力项不存在: ${capId}`)
  if (patch.decision === 'wheel' && !(patch.chosenRepo ?? row.chosen_repo)) throw new Error('decision=wheel 必须带 chosenRepo')
  const sets: string[] = []
  const vals: unknown[] = []
  if (patch.name !== undefined) { sets.push('name = ?'); vals.push(patch.name) }
  if (patch.detail !== undefined) { sets.push('detail = ?'); vals.push(patch.detail) }
  if (patch.keywords !== undefined) { sets.push('keywords = ?'); vals.push(JSON.stringify(patch.keywords)) }
  if (patch.decision !== undefined) { sets.push('decision = ?'); vals.push(patch.decision) }
  if (patch.chosenRepo !== undefined) { sets.push('chosen_repo = ?'); vals.push(patch.chosenRepo) }
  if (!sets.length) return
  ctx.db.prepare(`UPDATE tailor_capabilities SET ${sets.join(', ')} WHERE id = ?`).run(...vals, capId)
}

export function deleteCapability(ctx: CoreCtx, capId: number): void {
  ctx.db.prepare('DELETE FROM tailor_wheels WHERE capability_id = ?').run(capId)
  ctx.db.prepare('DELETE FROM tailor_capabilities WHERE id = ?').run(capId)
}

/** 询单一键转定制需求：intent 即原始需求文本；空 intent 让用户手动录入而不是造一条空需求 */
export function requestFromLead(ctx: CoreCtx, leadId: number): { id: number } {
  const lead = ctx.db.prepare('SELECT * FROM leads WHERE id = ?').get(leadId) as { wechat: string | null; intent: string | null } | undefined
  if (!lead) throw new Error(`询单不存在: ${leadId}`)
  const rawNeed = (lead.intent ?? '').trim()
  if (!rawNeed) throw new Error('该询单没有意向描述(intent)，请到定制板块手动录入需求')
  return addRequest(ctx, { title: `询单#${leadId} ${lead.wechat ?? ''}`.trim(), rawNeed, leadId })
}
