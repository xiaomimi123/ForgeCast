import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import type { CoreCtx, HookType } from '@forgecast/core'
import type Database from 'better-sqlite3'

const execFileP = promisify(execFile)
// dbskill 上游（CC BY-NC 4.0）——只做内部创作提效，其内容不提交进本仓、不打包进对外产品（§5.6 合规边界）
const DBSKILL_REPO = 'https://github.com/dontbesilent2025/dbskill.git'

export interface Atom { id: number; topic: string | null; content: string }

export const HOOK_KEYWORDS: Record<HookType, string[]> = {
  pain: ['痛点', '效率', '现状'],
  sideline: ['副业', '收入', '接单'],
  infogap: ['信息差', '成本', '定价'],
  story: ['故事', '交付', '客户'],
}

interface RawAtom { topic: string | null; content: string; meta: string | null }

/** 把一篇 markdown 拆成知识原子：标题→topic，要点/编号项→content（跳过空行与纯标题/散文）。本地知识包/回退用。 */
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

/** 解析 dbskill atoms.jsonl（每行一个原子）：content=knowledge，topic=topics[0]||skills[0]，meta=整行原样 JSON（坏行/空 knowledge 跳过） */
export function parseAtomsJsonl(text: string): RawAtom[] {
  const out: RawAtom[] = []
  for (const line of text.split('\n')) {
    const s = line.trim()
    if (!s) continue
    let a: { knowledge?: unknown; topics?: unknown; skills?: unknown }
    try { a = JSON.parse(s) } catch { continue }
    if (typeof a !== 'object' || a === null) continue // 跳过 null / 非对象行
    const content = typeof a.knowledge === 'string' ? a.knowledge.trim() : ''
    if (!content) continue
    const topics = Array.isArray(a.topics) ? a.topics : []
    const skills = Array.isArray(a.skills) ? a.skills : []
    const topic = topics.length ? String(topics[0]) : skills.length ? String(skills[0]) : null
    out.push({ topic, content, meta: s })
  }
  return out
}

/** 拉取/更新 dbskill 上游到缓存目录（浅克隆；已存在则 pull） */
async function pullDbskill(cacheDir: string, repo: string): Promise<void> {
  const opts = { maxBuffer: 64 * 1024 * 1024 }
  if (fs.existsSync(path.join(cacheDir, '.git'))) {
    await execFileP('git', ['-C', cacheDir, 'pull', '--ff-only', '--depth', '1'], opts)
  } else {
    fs.mkdirSync(path.dirname(cacheDir), { recursive: true })
    await execFileP('git', ['clone', '--depth', '1', repo, cacheDir], opts)
  }
}

export interface SyncResult { count: number; version: string | null; mdFiles: number; source: 'dbskill' | 'markdown' }

/**
 * 知识同步（§5.6）。opts.source 指向本地 dbskill checkout（或普通 md 目录，跳过克隆）；否则克隆/更新 opts.repo（默认上游）到 <root>/.cache/dbskill。
 * dbskill 目录（含 知识库/原子库/atoms.jsonl）→ 导入 atoms.jsonl 为原子 + 复制 Skill知识包 md 到 templates/knowledge/dbskill/（gitignored）+ 记版本。
 * 否则把 source 当普通 markdown 目录用 parseAtoms 拆原子（自定义知识包/回退）。
 * 幂等替换 source='dbskill' 行 + 重建 FTS。
 */
export async function syncKnowledge(ctx: CoreCtx, opts: { source?: string; repo?: string } = {}): Promise<SyncResult> {
  let dir = opts.source
  if (!dir) {
    dir = path.join(ctx.config.root, '.cache', 'dbskill')
    await pullDbskill(dir, opts.repo ?? DBSKILL_REPO)
  }
  const atomsPath = path.join(dir, '知识库', '原子库', 'atoms.jsonl')
  let atoms: RawAtom[]
  let version: string | null = null
  let mdFiles = 0
  let mode: 'dbskill' | 'markdown'
  if (fs.existsSync(atomsPath)) {
    mode = 'dbskill'
    atoms = parseAtomsJsonl(fs.readFileSync(atomsPath, 'utf8'))
    const vPath = path.join(dir, 'VERSION')
    version = fs.existsSync(vPath) ? fs.readFileSync(vPath, 'utf8').trim() : null
    // 复制 Skill知识包 md → templates/knowledge/dbskill/（CC BY-NC，gitignored，供背景/参考）
    const skillDir = path.join(dir, '知识库', 'Skill知识包')
    if (fs.existsSync(skillDir)) {
      const dest = path.join(ctx.config.paths.templates, 'knowledge', 'dbskill')
      fs.mkdirSync(dest, { recursive: true })
      for (const f of fs.readdirSync(skillDir).filter((f) => f.endsWith('.md'))) {
        fs.copyFileSync(path.join(skillDir, f), path.join(dest, f))
        mdFiles++
      }
    }
  } else {
    mode = 'markdown'
    const mds = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort() : []
    atoms = mds.flatMap((f) => {
      mdFiles++
      return parseAtoms(fs.readFileSync(path.join(dir as string, f), 'utf8'), f.replace(/\.md$/, ''))
        .map((a) => ({ topic: a.topic, content: a.content, meta: null }))
    })
  }
  const tx = ctx.db.transaction(() => {
    ctx.db.prepare("DELETE FROM knowledge_atoms WHERE source = 'dbskill'").run()
    const ins = ctx.db.prepare("INSERT INTO knowledge_atoms (source, topic, content, meta) VALUES ('dbskill', ?, ?, ?)")
    for (const a of atoms) ins.run(a.topic, a.content, a.meta)
    // atoms_fts 是外部内容 FTS5，需手动重建以同步（供未来 MATCH/检索升级）
    ctx.db.prepare("INSERT INTO atoms_fts(atoms_fts) VALUES('rebuild')").run()
  })
  tx()
  return { count: atoms.length, version, mdFiles, source: mode }
}

/** LIKE 检索（中文短词 FTS 召回差，故用 LIKE）；按命中词数排序后取前 limit */
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
