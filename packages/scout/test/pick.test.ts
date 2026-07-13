import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createLlmClient, loadConfig, openDb, type CoreCtx } from '@forgecast/core'
import { beforeEach, describe, expect, it } from 'vitest'
import { pickCandidate } from '../src/pick'
import { scoutCandidates } from '../src/scout'

let ctx: CoreCtx
beforeEach(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-pick-'))
  const config = loadConfig(root, {})
  ctx = { db: openDb(config.paths.db), config, llm: createLlmClient(config.llm) }
  await scoutCandidates(ctx) // 先入池
})

describe('pickCandidate (mock)', () => {
  it('立项：建 project + source/ 落 README 与 tree，状态 picked', async () => {
    const { slug, projectId } = await pickCandidate(ctx, 'chatwoot/chatwoot')
    expect(slug).toBe('chatwoot')
    const proj: any = ctx.db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId)
    expect(proj.slug).toBe('chatwoot')
    const cand: any = ctx.db.prepare("SELECT * FROM candidates WHERE repo = 'chatwoot/chatwoot'").get()
    expect(cand.status).toBe('picked')
    expect(proj.candidate_id).toBe(cand.id)
    const src = path.join(ctx.config.paths.workspace, slug, 'source')
    expect(fs.readFileSync(path.join(src, 'README.md'), 'utf8')).toContain('Chatwoot')
    expect(fs.readFileSync(path.join(src, 'tree.txt'), 'utf8')).toContain('Dockerfile')
  })
  it('撞名 slug 自动加后缀', async () => {
    ctx.db.prepare("INSERT INTO projects (slug) VALUES ('chatwoot')").run()
    const { slug } = await pickCandidate(ctx, 'chatwoot/chatwoot')
    expect(slug).toBe('chatwoot-2')
  })
  it('立项协议不过的候选 → 抛错', async () => {
    await expect(pickCandidate(ctx, 'gpl-example/copyleft-tool')).rejects.toThrow(/协议/)
  })
  it('不存在的候选 → 抛错', async () => {
    await expect(pickCandidate(ctx, 'no/such')).rejects.toThrow(/候选不存在/)
  })
  it('已 picked 的候选不可重复立项', async () => {
    await pickCandidate(ctx, 'chatwoot/chatwoot')
    await expect(pickCandidate(ctx, 'chatwoot/chatwoot')).rejects.toThrow(/已立项/)
  })
})
