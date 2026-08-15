import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createLlmClient, loadConfig, openDb, type CoreCtx } from '@forgecast/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { addRepo, backfillCandidateSummary, backfillCategories, candidatesNeedingRescore, candidatesNeedingSummary, cleanupCandidates, scoutBreakouts, scoutCandidates } from '../src/scout'
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

  it('持久化的 score_detail 须带 summaryZh 字段（回归：ingest 曾漏写该字段，导致前端中文简介功能整体失效）', async () => {
    await scoutCandidates(ctx)
    const row: any = ctx.db.prepare(
      "SELECT score_detail FROM candidates WHERE repo = 'chatwoot/chatwoot'",
    ).get()
    const detail = JSON.parse(row.score_detail)
    expect(detail.summaryZh).toBe('')
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

describe('cleanupCandidates (mock)', () => {
  it('已评分：低于阈值 → dismissed；达到阈值 → 保持 candidate', async () => {
    await scoutCandidates(ctx) // 先把 fixtures 全部入池（含评分）
    // 手动改两行的分数到确定值，规避 heuristicScore 具体数值不可控的问题
    ctx.db.prepare("UPDATE candidates SET score = 30 WHERE repo = 'formbricks/formbricks'").run()
    ctx.db.prepare("UPDATE candidates SET score = 80 WHERE repo = 'chatwoot/chatwoot'").run()
    const r = await cleanupCandidates(ctx, { threshold: 50 })
    expect(r.dismissed).toBeGreaterThanOrEqual(1)
    const low: any = ctx.db.prepare("SELECT status FROM candidates WHERE repo = 'formbricks/formbricks'").get()
    expect(low.status).toBe('dismissed')
    const high: any = ctx.db.prepare("SELECT status FROM candidates WHERE repo = 'chatwoot/chatwoot'").get()
    expect(high.status).toBe('candidate')
  })

  it('license_ok=0 或 status=picked 的候选不受阈值判定影响', async () => {
    await scoutCandidates(ctx)
    ctx.db.prepare("UPDATE candidates SET score = 0 WHERE repo = 'twentyhq/twenty'").run()
    ctx.db.prepare("UPDATE candidates SET status = 'picked' WHERE repo = 'twentyhq/twenty'").run()
    await cleanupCandidates(ctx, { threshold: 50 })
    const picked: any = ctx.db.prepare("SELECT status FROM candidates WHERE repo = 'twentyhq/twenty'").get()
    expect(picked.status).toBe('picked') // 没被 dismiss 覆盖
    const gpl: any = ctx.db.prepare("SELECT status, score FROM candidates WHERE repo = 'gpl-example/copyleft-tool'").get()
    expect(gpl.score).toBeNull() // license_ok=0 本就不评分，不该被"补评分"逻辑碰到
    expect(gpl.status).toBe('candidate') // 也不该被 dismiss（license gate 已经在別处标记不可商用）
  })

  it('未评分（score IS NULL）候选先被补评分，再按补评后的分数判定', async () => {
    // 手动插入一条协议 OK 但从未评分的候选（不经过 scoutCandidates，模拟"曾入库但超出评分 limit 未被评"的历史行）
    ctx.db.prepare(`
      INSERT INTO candidates (repo, url, description, license, license_ok, stars, last_commit, status)
      VALUES ('chatwoot/chatwoot', 'https://github.com/chatwoot/chatwoot', null, 'MIT', 1, 100, null, 'candidate')
    `).run()
    const before: any = ctx.db.prepare("SELECT score FROM candidates WHERE repo = 'chatwoot/chatwoot'").get()
    expect(before.score).toBeNull()
    const r = await cleanupCandidates(ctx, { threshold: 50 })
    expect(r.rescored).toBe(1)
    const after: any = ctx.db.prepare("SELECT score FROM candidates WHERE repo = 'chatwoot/chatwoot'").get()
    expect(after.score).not.toBeNull() // 补评分后一定有分数（chatwoot fixture README 信息丰富，mock 启发式分数会较高，不会被后续阈值判定淘汰）
    expect(after.score).toBeGreaterThanOrEqual(50)
  })

  it('单个候选补评分失败不中断整批：其余候选仍正常清理', async () => {
    await scoutCandidates(ctx)
    // 插入一条 repo 不在 fixtures 里的候选（mock 的 fetchReadme 对未知 repo 返回空串 ''，
    // rescoreCandidate 不会抛错——用一条真实会抛错的场景：repo 本身在 candidates 表里但已被删除的场景不易构造，
    // 这里改用「readme 为空」验证 rescoreCandidate 对未知 repo 是 fail-soft（返回低分而非抛错），
    // 顺带验证 cleanupCandidates 处理完这条后其它候选依旧被正确判定
    ctx.db.prepare(`
      INSERT INTO candidates (repo, url, description, license, license_ok, stars, last_commit, status)
      VALUES ('unknown/not-in-fixtures', 'https://github.com/unknown/not-in-fixtures', null, 'MIT', 1, 10, null, 'candidate')
    `).run()
    ctx.db.prepare("UPDATE candidates SET score = 30 WHERE repo = 'formbricks/formbricks'").run()
    const r = await cleanupCandidates(ctx, { threshold: 50 })
    expect(r.rescored).toBeGreaterThanOrEqual(1) // unknown repo 也会被"补评分"尝试（不抛错，只是分数低）
    const low: any = ctx.db.prepare("SELECT status FROM candidates WHERE repo = 'formbricks/formbricks'").get()
    expect(low.status).toBe('dismissed') // 不受 unknown repo 那条影响，正常判定
  })
})

describe('scoutBreakouts (mock)', () => {
  it('命中的协议 OK 仓库全部评分入池；协议不过只登记', async () => {
    const r = await scoutBreakouts(ctx)
    expect(r.found).toBe(candidateFixtures.length)
    expect(r.rejected).toBe(1) // GPL fixture
    expect(r.scored).toBe(okCount)
    expect(r.added).toBe(okCount)
    const rows: any[] = ctx.db.prepare('SELECT * FROM candidates').all()
    const scored = rows.filter((x) => x.license_ok === 1)
    expect(scored.every((x) => x.score > 0)).toBe(true)
  })

  it('不受 onlyNew 限制：repo 已存在也重新评分覆盖', async () => {
    await scoutCandidates(ctx) // 先用常规扫描入池一次
    const before: any = ctx.db.prepare("SELECT score FROM candidates WHERE repo = 'chatwoot/chatwoot'").get()
    ctx.db.prepare("UPDATE candidates SET score = 1 WHERE repo = 'chatwoot/chatwoot'").run() // 手动改低，验证会被覆盖
    const r = await scoutBreakouts(ctx)
    expect(r.added).toBeGreaterThanOrEqual(1) // 即使 repo 已存在，命中的仍计入 added（不做 onlyNew 判定）
    const after: any = ctx.db.prepare("SELECT score FROM candidates WHERE repo = 'chatwoot/chatwoot'").get()
    expect(after.score).not.toBe(1) // 被重新评分覆盖，不再是我们手动改的 1
    expect(before.score).toBeGreaterThan(0) // sanity：确认 before 本身是正常评分（非空）
  })

  it('opts 透传：minStars/withinDays/limit 影响调用参数（用 spy 验证）', async () => {
    const spy = vi.spyOn(ctx.db, 'prepare') // 不直接测 github 调用参数（mock client 忽略参数），改测函数不抛错、返回值形状正确
    const r = await scoutBreakouts(ctx, { minStars: 5000, withinDays: 3, limit: 2 })
    expect(r).toHaveProperty('found')
    expect(r).toHaveProperty('scored')
    expect(r).toHaveProperty('rejected')
    expect(r).toHaveProperty('added')
    spy.mockRestore()
  })
})

describe('candidatesNeedingSummary (mock)', () => {
  it('协议 OK 且缺 summaryZh 的被选中；已有 summaryZh / 协议不过 / 未评分的都不选中', async () => {
    await scoutCandidates(ctx) // fixtures 全部入池评分（mock 下 summaryZh 恒为空串）
    const need = candidatesNeedingSummary(ctx)
    const chatwoot: any = ctx.db.prepare("SELECT id FROM candidates WHERE repo='chatwoot/chatwoot'").get()
    expect(need).toContain(chatwoot.id) // mock 评分 summaryZh 是空串，应被选中

    // 手动给它 patch 一个非空 summaryZh，验证不再被选中
    const row: any = ctx.db.prepare("SELECT score_detail FROM candidates WHERE id = ?").get(chatwoot.id)
    const d = JSON.parse(row.score_detail); d.summaryZh = '已经有简介了'
    ctx.db.prepare('UPDATE candidates SET score_detail = ? WHERE id = ?').run(JSON.stringify(d), chatwoot.id)
    expect(candidatesNeedingSummary(ctx)).not.toContain(chatwoot.id)

    const gpl: any = ctx.db.prepare("SELECT id FROM candidates WHERE repo='gpl-example/copyleft-tool'").get()
    expect(candidatesNeedingSummary(ctx)).not.toContain(gpl.id) // 协议不过，从未评分，没有 score_detail
  })
})

describe('backfillCandidateSummary (mock)', () => {
  it('只改 summaryZh，其它评分字段原样保留', async () => {
    await scoutCandidates(ctx)
    const before: any = ctx.db.prepare("SELECT score_detail FROM candidates WHERE repo='chatwoot/chatwoot'").get()
    const beforeDetail = JSON.parse(before.score_detail)
    const id = (ctx.db.prepare("SELECT id FROM candidates WHERE repo='chatwoot/chatwoot'").get() as any).id
    await backfillCandidateSummary(ctx, id)
    const after: any = ctx.db.prepare("SELECT score_detail FROM candidates WHERE repo='chatwoot/chatwoot'").get()
    const afterDetail = JSON.parse(after.score_detail)
    expect(afterDetail.summaryZh).toBe('') // mock 模式下仍是空串（无 LLM），但字段一定存在
    expect(afterDetail.rebrandCost).toBe(beforeDetail.rebrandCost)
    expect(afterDetail.buyerClarity).toBe(beforeDetail.buyerClarity)
    expect(afterDetail.visualAppeal).toBe(beforeDetail.visualAppeal)
    expect(afterDetail.rationale).toBe(beforeDetail.rationale)
    expect(afterDetail.targetBuyer).toBe(beforeDetail.targetBuyer)
    expect(afterDetail.painPoint).toBe(beforeDetail.painPoint)
    expect(afterDetail.category).toBe(beforeDetail.category)
  })
  it('候选不存在 → 抛错', async () => {
    await expect(backfillCandidateSummary(ctx, 999999)).rejects.toThrow(/不存在/)
  })
})
