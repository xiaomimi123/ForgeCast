import fs from 'node:fs'
import path from 'node:path'
import type { CoreCtx } from '@forgecast/core'
import { mockDemandExtract, type DemandExtractDraft } from './fixtures/demand-fixture'
import type { DemandKind } from './signals'

export type { DemandExtractDraft } from './fixtures/demand-fixture'

const KINDS: DemandKind[] = ['traffic', 'emotional', 'supply']

/** 剥 ```json 围栏 → JSON.parse（malformed 直接抛）→ 必须是数组。 */
function parseDraftsJson(raw: string): DemandExtractDraft[] {
  const cleaned = raw.trim().replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/```\s*$/, '').trim()
  const arr = JSON.parse(cleaned)
  if (!Array.isArray(arr)) throw new Error('LLM 输出不是数组')
  return arr
}

/**
 * 对 kind 为空的新信号批量分类（traffic/emotional/supply）+ 生成 opportunity（可承接方向）。
 * mock 走固定 fixture / live 调 LLM → 校验（id 必须在本批、kind 在枚举、opportunity 非空，
 * 任一条非法整批抛错不写脏数据）→ 事务回写。返回更新条数。
 */
export async function extractSignals(
  ctx: CoreCtx,
  opts: { batch?: number; onProgress?: (msg: string) => void } = {},
): Promise<number> {
  const { batch = 30, onProgress = () => {} } = opts
  onProgress('筛选未分类信号…')
  const pending = ctx.db.prepare('SELECT id, source, title, summary, heat FROM demand_signals WHERE kind IS NULL ORDER BY id LIMIT ?')
    .all(batch) as Array<{ id: number; source: string; title: string; summary: string | null; heat: number | null }>
  if (!pending.length) { onProgress('没有待分类的信号'); return 0 }

  let drafts: DemandExtractDraft[]
  if (ctx.config.llm.mode === 'mock') {
    onProgress('mock 模式：使用固定分类示例…')
    drafts = mockDemandExtract(pending.map((p) => p.id))
  } else {
    onProgress(`调用大模型分类 ${pending.length} 条信号…`)
    const tpl = fs.readFileSync(path.join(ctx.config.paths.templates, 'prompts', 'demand-extract.md'), 'utf8')
    const system = '你是消费趋势与产品机会分析专家，只输出给定 JSON 结构，不要多余文字。'
    const block = pending.map((p) => `- id=${p.id} [${p.source}] ${p.title}${p.summary ? `：${p.summary}` : ''}${p.heat != null ? `（热度 ${p.heat}）` : ''}`).join('\n')
    const prompt = [tpl, `以下是本批需求信号：\n${block}`].join('\n\n---\n\n')
    drafts = parseDraftsJson(await ctx.llm.complete({ model: ctx.config.llm.models.analysis, system, prompt }))
  }

  const idSet = new Set(pending.map((p) => p.id))
  for (const d of drafts) {
    const bad: string[] = []
    if (!idSet.has(d.id)) bad.push('id')
    if (!KINDS.includes(d.kind)) bad.push('kind')
    if (typeof d.opportunity !== 'string' || !d.opportunity.trim()) bad.push('opportunity')
    if (bad.length) throw new Error(`分类结果非法（${bad.join('、')}）: ${JSON.stringify(d)}`)
  }

  onProgress('写入分类结果…')
  const upd = ctx.db.prepare('UPDATE demand_signals SET kind = ?, opportunity = ? WHERE id = ?')
  const tx = ctx.db.transaction(() => { for (const d of drafts) upd.run(d.kind, d.opportunity, d.id) })
  tx()
  onProgress(`提炼完成：更新 ${drafts.length} 条`)
  return drafts.length
}
