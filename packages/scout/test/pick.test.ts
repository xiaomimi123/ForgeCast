import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createLlmClient, loadConfig, openDb, type CoreCtx } from '@forgecast/core'
import { beforeEach, describe, expect, it } from 'vitest'
import { deleteProject, pickCandidate } from '../src/pick'
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

describe('deleteProject', () => {
  it('删项目 + 素材 + workspace 目录，候选状态重置为 candidate（可重新立项）', async () => {
    const { slug } = await pickCandidate(ctx, 'chatwoot/chatwoot')
    const wsDir = path.join(ctx.config.paths.workspace, slug)
    expect(fs.existsSync(wsDir)).toBe(true)

    deleteProject(ctx, slug)

    expect(ctx.db.prepare('SELECT id FROM projects WHERE slug = ?').get(slug)).toBeUndefined()
    expect(fs.existsSync(wsDir)).toBe(false)
    const cand: any = ctx.db.prepare("SELECT status FROM candidates WHERE repo = 'chatwoot/chatwoot'").get()
    expect(cand.status).toBe('candidate')

    // 重新立项同一个 repo 应该成功
    const again = await pickCandidate(ctx, 'chatwoot/chatwoot')
    expect(again.slug).toBe('chatwoot')
  })
  it('连带删除项目下的素材', async () => {
    const { slug, projectId } = await pickCandidate(ctx, 'chatwoot/chatwoot')
    const info = ctx.db.prepare(
      "INSERT INTO assets (project_id, type, hook, file_path, status) VALUES (?, 'copy', 'pain', 'x.md', 'draft')",
    ).run(projectId)
    const assetId = Number(info.lastInsertRowid)

    deleteProject(ctx, slug)

    expect(ctx.db.prepare('SELECT id FROM assets WHERE id = ?').get(assetId)).toBeUndefined()
  })
  it('素材有关联询单则拒绝删除，项目/素材/询单都不动', async () => {
    const { slug, projectId } = await pickCandidate(ctx, 'chatwoot/chatwoot')
    const info = ctx.db.prepare(
      "INSERT INTO assets (project_id, type, hook, file_path, status) VALUES (?, 'copy', 'pain', 'x.md', 'published')",
    ).run(projectId)
    const assetId = Number(info.lastInsertRowid)
    ctx.db.prepare('INSERT INTO leads (asset_id, wechat) VALUES (?, ?)').run(assetId, 'wx1')

    expect(() => deleteProject(ctx, slug)).toThrow(/询单/)
    expect(ctx.db.prepare('SELECT id FROM projects WHERE slug = ?').get(slug)).toBeDefined()
    expect(ctx.db.prepare('SELECT id FROM assets WHERE id = ?').get(assetId)).toBeDefined()
  })
  it('项目不存在 → 抛错', () => {
    expect(() => deleteProject(ctx, 'nope')).toThrow(/项目不存在/)
  })
  it('没有关联候选的手建项目（candidate_id 为空）也能正常删除', () => {
    ctx.db.prepare("INSERT INTO projects (slug) VALUES ('manual')").run()
    expect(() => deleteProject(ctx, 'manual')).not.toThrow()
    expect(ctx.db.prepare("SELECT id FROM projects WHERE slug = 'manual'").get()).toBeUndefined()
  })
})
