import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createLlmClient, loadConfig, openDb, type CoreCtx } from '@forgecast/core'
import { beforeEach, describe, expect, it } from 'vitest'
import { addRepo, scoutCandidates } from '../src/scout'

let ctx: CoreCtx
beforeEach(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-scout-'))
  const config = loadConfig(root, {}) // github mock + llm mock
  ctx = { db: openDb(config.paths.db), config, llm: createLlmClient(config.llm) }
})

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
