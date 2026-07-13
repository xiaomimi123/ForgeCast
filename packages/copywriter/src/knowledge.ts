import type Database from 'better-sqlite3'
import type { HookType } from '@forgecast/core'

export interface Atom { id: number; topic: string | null; content: string }

export const HOOK_KEYWORDS: Record<HookType, string[]> = {
  pain: ['痛点', '效率', '现状'],
  sideline: ['副业', '收入', '接单'],
  infogap: ['信息差', '成本', '定价'],
  story: ['故事', '交付', '客户'],
}

/** P1 用 LIKE 检索（中文 FTS 分词差，原子量小）；接口稳定，后续内部升级 FTS/embedding */
export function searchAtoms(db: Database.Database, terms: string[], limit = 8): Atom[] {
  const clean = terms.filter(Boolean)
  if (!clean.length) return []
  const where = clean.map(() => 'content LIKE ?').join(' OR ')
  const rows = db.prepare(
    `SELECT id, topic, content FROM knowledge_atoms WHERE ${where} LIMIT ?`,
  ).all(...clean.map((t) => `%${t}%`), limit) as Atom[]
  return rows
}
