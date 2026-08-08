import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createLlmClient, loadConfig, openDb, type CoreCtx } from '@forgecast/core'
import { beforeEach, describe, expect, it } from 'vitest'
import { addRepo, backfillCategories, candidatesNeedingRescore, scoutCandidates } from '../src/scout'
import { candidateFixtures } from '../src/fixtures/candidate-fixtures'
import { isLicenseOk } from '../src/license'

let ctx: CoreCtx
beforeEach(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-scout-'))
  const config = loadConfig(root, {}) // github mock + llm mock
  ctx = { db: openDb(config.paths.db), config, llm: createLlmClient(config.llm) }
})

const okCount = candidateFixtures.filter((f) => isLicenseOk(f.license)).length

describe('scoutCandidates (mock)', () => {
  it('fixtures 入池：可商用者评分、GPL 标记不评分、按 score 排序、幂等去重', async () => {
    const r1 = await scoutCandidates(ctx)
    expect(r1.rejected).toBe(1) // GPL fixture
    expect(r1.scored).toBeGreaterThanOrEqual(4)

    const rows: any[] = ctx.db.prepare('SELECT * FROM candidates ORDER BY license_ok DESC, score DESC').all()
    const gpl = rows.find((x) => x.repo === 'gpl-example/copyleft-tool')
    expect(gpl.license_ok).toBe(0)
    expect(gpl.score).toBeNull()
    const scored = rows.filter((x) => x.license_ok === 1)
    expect(scored.every((x) => x.score > 0 && JSON.parse(x.score_detail).rationale)).toBe(true)
    // 评分写库须带 category（否则看板分类缺失，需再回填）
    expect(scored.every((x) => typeof JSON.parse(x.score_detail).category === 'string' && JSON.parse(x.score_detail).category.length > 0)).toBe(true)
    // 排序：第一名 score 不低于第二名
    expect(scored[0].score).toBeGreaterThanOrEqual(scored[1].score)

    // 幂等：再跑一次不新增行
    const before = rows.length
    await scoutCandidates(ctx)
    const after = (ctx.db.prepare('SELECT COUNT(*) c FROM candidates').get() as any).c
    expect(after).toBe(before)
  })
})

describe('addRepo (mock)', () => {
  it('投喂 fixture 中的 repo → 入池带评分', async () => {
    await addRepo(ctx, 'https://github.com/chatwoot/chatwoot')
    const row: any = ctx.db.prepare("SELECT * FROM candidates WHERE repo = 'chatwoot/chatwoot'").get()
    expect(row.license_ok).toBe(1)
    expect(row.score).toBeGreaterThan(0)
    expect(JSON.parse(row.tech_stack)).toContain('react')
  })
})

describe('description 采集', () => {
  it('fixture 的 description 落库（与 LLM 模式无关）', async () => {
    await scoutCandidates(ctx)
    const row: any = ctx.db.prepare('SELECT description FROM candidates WHERE repo = ?').get('chatwoot/chatwoot')
    expect(row.description).toBe('开源多渠道在线客服平台')
  })
})

describe('candidatesNeedingRescore', () => {
  it('只返回 targetBuyer 为空/缺/坏JSON/NULL 的候选 id', () => {
    const ins = ctx.db.prepare("INSERT INTO candidates (repo,url,license_ok,score,score_detail,status) VALUES (?,?,1,50,?, 'candidate')")
    ins.run('a/done', 'u1', JSON.stringify({ rebrandCost: 10, targetBuyer: '律所老板' })) // 已真评
    ins.run('a/empty', 'u2', JSON.stringify({ rebrandCost: 10, targetBuyer: '' }))          // 空串→需评
    ins.run('a/missing', 'u3', JSON.stringify({ rebrandCost: 10 }))                          // 缺字段→需评
    ins.run('a/bad', 'u4', '{坏json')                                                        // 坏JSON→需评
    ins.run('a/null', 'u5', null)                                                            // NULL→需评
    const need = candidatesNeedingRescore(ctx)
    const repos = need.map((id) => (ctx.db.prepare('SELECT repo FROM candidates WHERE id=?').get(id) as any).repo).sort()
    expect(repos).toEqual(['a/bad', 'a/empty', 'a/missing', 'a/null']) // 不含 a/done
  })
})

describe('backfillCategories', () => {
  it('给缺/非法 category 的候选写启发式类；已有合法的不动；无 score_detail 跳过；返回更新数', () => {
    const ins = ctx.db.prepare("INSERT INTO candidates (repo,url,description,license_ok,score,score_detail,status) VALUES (?,?,?,1,50,?, 'candidate')")
    ins.run('a/chat', 'u1', 'live chat helpdesk', JSON.stringify({ rebrandCost: 10, techStack: [] }))       // 缺 category → 回填
    ins.run('a/inv', 'u2', 'invoice billing', JSON.stringify({ category: '不在表内', techStack: [] }))       // 非法 → 回填
    ins.run('a/keep', 'u3', 'whatever', JSON.stringify({ category: 'CRM/销售', techStack: [] }))             // 合法 → 不动
    ins.run('a/none', 'u4', 'x', null)                                                                        // 无 detail → 跳过
    const n = backfillCategories(ctx)
    expect(n).toBe(2)
    const cat = (repo: string) => JSON.parse((ctx.db.prepare('SELECT score_detail FROM candidates WHERE repo=?').get(repo) as any).score_detail).category
    expect(cat('a/chat')).toBe('客服/IM')
    expect(cat('a/inv')).toBe('财务/发票')
    expect(cat('a/keep')).toBe('CRM/销售') // 未被改
    expect((ctx.db.prepare("SELECT score_detail FROM candidates WHERE repo='a/none'").get() as any).score_detail).toBeNull()
  })
})

describe('scoutCandidates onlyNew', () => {
  it('已存在候选：保留评分/收藏只刷元数据；新候选照常评分；added 只数新入库的可商用项', async () => {
    const first = candidateFixtures.find((f) => isLicenseOk(f.license))!
    ctx.db.prepare(
      "INSERT INTO candidates (repo, url, license, license_ok, stars, score, score_detail, favorite, status) VALUES (?, ?, ?, 1, 1, 99, '{\"targetBuyer\":\"真评\"}', 1, 'candidate')",
    ).run(first.repo, first.url, first.license)
    const r = await scoutCandidates(ctx, { onlyNew: true })
    const row = ctx.db.prepare('SELECT stars, score, score_detail, favorite FROM candidates WHERE repo = ?').get(first.repo) as any
    expect(row.score).toBe(99)                                     // 评分未被洗
    expect(JSON.parse(row.score_detail).targetBuyer).toBe('真评')
    expect(row.favorite).toBe(1)                                   // 收藏未被洗
    expect(row.stars).toBe(first.stars)                            // 元数据已刷新（seed 时是 1）
    expect(r.added).toBe(okCount - 1)                              // 排除已存在的 first
    // 新入库的可商用候选都评了分
    const fresh = ctx.db.prepare('SELECT score FROM candidates WHERE repo != ? AND license_ok = 1').all(first.repo) as any[]
    expect(fresh.length).toBe(okCount - 1)
    for (const f of fresh) expect(f.score).not.toBeNull()
  })
  it('全新库跑 onlyNew：全部视为新项，added = 可商用 fixture 数', async () => {
    const r = await scoutCandidates(ctx, { onlyNew: true })
    expect(r.added).toBe(okCount)
  })
  it('非 onlyNew 行为不变，也返回 added', async () => {
    await scoutCandidates(ctx, {})
    const r2 = await scoutCandidates(ctx, {})   // 第二次全是已存在
    expect(r2.added).toBe(0)
    expect(r2.found).toBe(candidateFixtures.length)
  })
})
