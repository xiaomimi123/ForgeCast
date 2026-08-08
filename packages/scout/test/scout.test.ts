import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createLlmClient, loadConfig, openDb, type CoreCtx } from '@forgecast/core'
import { beforeEach, describe, expect, it } from 'vitest'
import { candidateFixtures } from '../src/fixtures/candidate-fixtures'
import { isLicenseOk } from '../src/license'
import { scoutCandidates } from '../src/scout'

let ctx: CoreCtx
beforeEach(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-scout-'))
  const config = loadConfig(root, {})
  ctx = { db: openDb(config.paths.db), config, llm: createLlmClient(config.llm) }
})

const okCount = candidateFixtures.filter((f) => isLicenseOk(f.license)).length

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
