import fs from 'node:fs'
import path from 'node:path'
import type { CoreCtx, HookType } from '@forgecast/core'
import type Database from 'better-sqlite3'

export interface Atom { id: number; topic: string | null; content: string }

export const HOOK_KEYWORDS: Record<HookType, string[]> = {
  pain: ['痛点', '效率', '现状'],
  sideline: ['副业', '收入', '接单'],
  infogap: ['信息差', '成本', '定价'],
  story: ['故事', '交付', '客户'],
}

/** 把一篇 markdown 拆成知识原子：标题→topic，要点/编号项→content（跳过空行与纯标题/散文） */
export function parseAtoms(md: string, topicFallback: string): Array<{ topic: string; content: string }> {
  const atoms: Array<{ topic: string; content: string }> = []
  let topic = topicFallback
  for (const raw of md.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    const h = line.match(/^#{1,6}\s+(.+)$/)
    if (h) { topic = h[1].trim(); continue }
    const bullet = line.match(/^(?:[-*]|\d+[.)])\s+(.+)$/)
    if (bullet) {
      const content = bullet[1].trim()
      if (content) atoms.push({ topic, content })
    }
  }
  return atoms
}

/** 从知识目录（默认 templates/knowledge，opts.source 覆盖）摄取原子入库；幂等替换 source='dbskill' 行 + 重建 FTS */
export function syncKnowledge(ctx: CoreCtx, opts: { source?: string } = {}): { count: number; files: number } {
  const dir = opts.source ?? path.join(ctx.config.paths.templates, 'knowledge')
  const atoms: Array<{ topic: string; content: string }> = []
  let files = 0
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort()) {
      files++
      atoms.push(...parseAtoms(fs.readFileSync(path.join(dir, f), 'utf8'), f.replace(/\.md$/, '')))
    }
  }
  const tx = ctx.db.transaction(() => {
    ctx.db.prepare("DELETE FROM knowledge_atoms WHERE source = 'dbskill'").run()
    const ins = ctx.db.prepare("INSERT INTO knowledge_atoms (source, topic, content) VALUES ('dbskill', ?, ?)")
    for (const a of atoms) ins.run(a.topic, a.content)
    // atoms_fts 是外部内容 FTS5，需手动重建以同步（供未来 MATCH/检索升级）
    ctx.db.prepare("INSERT INTO atoms_fts(atoms_fts) VALUES('rebuild')").run()
  })
  tx()
  return { count: atoms.length, files }
}

/** LIKE 检索（中文短词 FTS 召回差，故用 LIKE；原子量小性能无虞）；按命中词数排序后取前 limit */
export function searchAtoms(db: Database.Database, terms: string[], limit = 8): Atom[] {
  const clean = terms.filter(Boolean)
  if (!clean.length) return []
  const where = clean.map(() => 'content LIKE ?').join(' OR ')
  const rows = db.prepare(
    `SELECT id, topic, content FROM knowledge_atoms WHERE ${where}`,
  ).all(...clean.map((t) => `%${t}%`)) as Atom[]
  // 按命中词数排序（相关性优先），再取前 limit——修正旧实现 LIMIT 早于排序的问题
  return rows
    .map((r) => ({ r, hits: clean.filter((t) => r.content.includes(t)).length }))
    .sort((a, b) => b.hits - a.hits || a.r.id - b.r.id)
    .slice(0, limit)
    .map((s) => s.r)
}
