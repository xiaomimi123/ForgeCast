import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createLlmClient, loadConfig, openDb, type CoreCtx } from '@forgecast/core'
import { describe, expect, it } from 'vitest'
import { parseAtoms, parseAtomsJsonl, searchAtoms, syncKnowledge } from '../src/knowledge'

function db() {
  const d = openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fc-')), 't.db'))
  const ins = d.prepare('INSERT INTO knowledge_atoms (topic, content) VALUES (?, ?)')
  ins.run('hook', '前3秒必须出现行业称呼，痛点要量化')
  ins.run('hook', '标题带数字的点击率更高')
  ins.run('pricing', '定价用锚点对比，不用绝对承诺')
  return d
}

describe('searchAtoms', () => {
  it('按词命中并限量返回', () => {
    const out = searchAtoms(db(), ['痛点', '数字'], 8)
    expect(out.length).toBe(2)
    expect(out[0].content).toContain('痛点')
  })
  it('多命中的原子排在前（相关性优先）', () => {
    const d = openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fc-')), 't.db'))
    const ins = d.prepare('INSERT INTO knowledge_atoms (topic, content) VALUES (?, ?)')
    ins.run('a', '只讲痛点') // 命中 1 词
    ins.run('b', '痛点要量化，数字更有说服力') // 命中 2 词
    const out = searchAtoms(d, ['痛点', '数字'], 8)
    expect(out[0].content).toBe('痛点要量化，数字更有说服力')
  })
  it('无命中返回空数组', () => {
    expect(searchAtoms(db(), ['不存在的词'])).toEqual([])
  })
  it('空检索词返回空数组', () => {
    expect(searchAtoms(db(), [])).toEqual([])
  })
})

describe('parseAtoms', () => {
  it('标题→topic，要点/编号→原子，跳过空行与散文', () => {
    const md = '# 大标题\n\n这是一段散文，应跳过\n- 第一个要点\n* 第二个要点\n## 子标题\n1. 编号要点\n2) 括号编号\n\n'
    const atoms = parseAtoms(md, '兜底')
    expect(atoms).toHaveLength(4)
    expect(atoms[0]).toEqual({ topic: '大标题', content: '第一个要点' })
    expect(atoms[2]).toEqual({ topic: '子标题', content: '编号要点' })
  })
  it('无标题时用文件名兜底', () => {
    const atoms = parseAtoms('- 只有要点', 'hooks-basics')
    expect(atoms[0].topic).toBe('hooks-basics')
  })
})

describe('syncKnowledge', () => {
  function ctxWithSource(): { ctx: CoreCtx; source: string } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-sync-'))
    const config = loadConfig(root, {})
    const ctx: CoreCtx = { db: openDb(config.paths.db), config, llm: createLlmClient(config.llm) }
    const source = path.join(root, 'kb')
    fs.mkdirSync(source, { recursive: true })
    fs.writeFileSync(path.join(source, 'a.md'), '# 钩子\n- 前3秒给信号\n- 数字比形容词强')
    fs.writeFileSync(path.join(source, 'b.md'), '# 定价\n- 用锚点对比')
    return { ctx, source }
  }
  // 造一个迷你 dbskill checkout（知识库/原子库/atoms.jsonl + Skill知识包/*.md + VERSION）
  function ctxWithDbskill(): { ctx: CoreCtx; source: string } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-dbs-'))
    const config = loadConfig(root, {})
    const ctx: CoreCtx = { db: openDb(config.paths.db), config, llm: createLlmClient(config.llm) }
    const src = path.join(root, 'dbskill')
    fs.mkdirSync(path.join(src, '知识库', '原子库'), { recursive: true })
    fs.mkdirSync(path.join(src, '知识库', 'Skill知识包'), { recursive: true })
    const jsonl = [
      JSON.stringify({ id: '2024Q4_001', knowledge: '前3秒要给"与我有关"的信号', topics: ['内容创作'], skills: ['dbs-hook'], type: 'insight' }),
      JSON.stringify({ id: '2024Q4_002', knowledge: '定价用锚点对比更有说服力', topics: ['商业模式'], skills: ['dbs-diagnosis'] }),
      '  ', // 空行跳过
      '{坏 json', // 坏行跳过
      JSON.stringify({ id: 'x', knowledge: '' }), // 空 knowledge 跳过
    ].join('\n')
    fs.writeFileSync(path.join(src, '知识库', '原子库', 'atoms.jsonl'), jsonl)
    fs.writeFileSync(path.join(src, '知识库', 'Skill知识包', 'content_x.md'), '# 内容\n- 要点')
    fs.writeFileSync(path.join(src, 'VERSION'), '2.17.10\n')
    return { ctx, source: src }
  }

  it('markdown 模式：摄取目录 md 入库，条数/topic 正确', async () => {
    const { ctx, source } = ctxWithSource()
    const r = await syncKnowledge(ctx, { source })
    expect(r).toMatchObject({ count: 3, mdFiles: 2, source: 'markdown', version: null })
    const rows = ctx.db.prepare('SELECT topic, content FROM knowledge_atoms ORDER BY id').all() as any[]
    expect(rows).toHaveLength(3)
    expect(rows[0].topic).toBe('钩子')
    expect(rows[2].topic).toBe('定价')
  })
  it('dbskill 模式：导入 atoms.jsonl（跳坏行/空）、存 meta、复制 md、记版本', async () => {
    const { ctx, source } = ctxWithDbskill()
    const r = await syncKnowledge(ctx, { source })
    expect(r).toMatchObject({ count: 2, source: 'dbskill', version: '2.17.10', mdFiles: 1 })
    const rows = ctx.db.prepare("SELECT topic, content, meta FROM knowledge_atoms WHERE source='dbskill' ORDER BY id").all() as any[]
    expect(rows).toHaveLength(2)
    expect(rows[0].topic).toBe('内容创作')
    expect(rows[0].content).toContain('前3秒')
    expect(JSON.parse(rows[0].meta).id).toBe('2024Q4_001') // meta 原样存
    // Skill知识包 md 复制到 templates/knowledge/dbskill/
    expect(fs.existsSync(path.join(ctx.config.paths.templates, 'knowledge', 'dbskill', 'content_x.md'))).toBe(true)
  })
  it('重跑幂等，不翻倍', async () => {
    const { ctx, source } = ctxWithDbskill()
    await syncKnowledge(ctx, { source })
    await syncKnowledge(ctx, { source })
    const n = (ctx.db.prepare('SELECT COUNT(*) c FROM knowledge_atoms').get() as any).c
    expect(n).toBe(2)
  })
  it('入库后 searchAtoms 可检索到', async () => {
    const { ctx, source } = ctxWithDbskill()
    await syncKnowledge(ctx, { source })
    const out = searchAtoms(ctx.db, ['锚点'])
    expect(out.some((a) => a.content.includes('锚点'))).toBe(true)
  })
})

describe('parseAtomsJsonl', () => {
  it('content=knowledge、topic=topics[0]、meta 原样；跳空/坏/空 knowledge', () => {
    const text = [
      JSON.stringify({ id: 'a', knowledge: '洞见一', topics: ['选题'], type: 'insight' }),
      '',
      '{bad',
      JSON.stringify({ id: 'b', knowledge: '', topics: ['x'] }),
      JSON.stringify({ id: 'c', knowledge: '洞见二', skills: ['dbs-hook'] }), // 无 topics → 用 skills[0]
    ].join('\n')
    const out = parseAtomsJsonl(text)
    expect(out).toHaveLength(2)
    expect(out[0]).toMatchObject({ topic: '选题', content: '洞见一' })
    expect(JSON.parse(out[0].meta!).id).toBe('a')
    expect(out[1].topic).toBe('dbs-hook') // 回退到 skills[0]
  })
})
