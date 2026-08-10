import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'
import { createLlmClient, loadConfig, openDb, type CoreCtx } from '@forgecast/core'
import { beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/app'
import { createTaskQueue } from '../src/tasks'

let ctx: CoreCtx, app: ReturnType<typeof createApp>, root: string
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-delproj-'))
  const config = loadConfig(root, {})
  ctx = { db: openDb(config.paths.db), config, llm: createLlmClient(config.llm) }
  app = createApp(ctx, createTaskQueue())
})

describe('DELETE /api/projects/:slug', () => {
  it('存在（有关联候选）→ 200，项目行没了，候选状态重置为 candidate', async () => {
    ctx.db.prepare("INSERT INTO candidates (repo, url, license_ok, status) VALUES ('a/b', 'u', 1, 'picked')").run()
    const candId = (ctx.db.prepare("SELECT id FROM candidates WHERE repo = 'a/b'").get() as any).id
    ctx.db.prepare('INSERT INTO projects (slug, candidate_id) VALUES (?, ?)').run('demo', candId)
    const dir = path.join(root, 'workspace', 'demo')
    fs.mkdirSync(dir, { recursive: true })

    const res = await app.request('/api/projects/demo', { method: 'DELETE' })
    expect(res.status).toBe(200)
    expect(ctx.db.prepare("SELECT id FROM projects WHERE slug = 'demo'").get()).toBeUndefined()
    expect((ctx.db.prepare("SELECT status FROM candidates WHERE id = ?").get(candId) as any).status).toBe('candidate')
    expect(fs.existsSync(dir)).toBe(false)
  })
  it('不存在 → 404', async () => {
    expect((await app.request('/api/projects/nope', { method: 'DELETE' })).status).toBe(404)
  })
  it('素材有关联询单 → 409，项目/素材/询单都不动', async () => {
    ctx.db.prepare("INSERT INTO projects (slug) VALUES ('demo')").run()
    const info = ctx.db.prepare(
      "INSERT INTO assets (project_id, type, hook, file_path, status) VALUES (1, 'copy', 'pain', 'x.md', 'published')",
    ).run()
    const assetId = Number(info.lastInsertRowid)
    ctx.db.prepare('INSERT INTO leads (asset_id, wechat) VALUES (?, ?)').run(assetId, 'wx1')

    const res = await app.request('/api/projects/demo', { method: 'DELETE' })
    expect(res.status).toBe(409)
    expect(ctx.db.prepare("SELECT id FROM projects WHERE slug = 'demo'").get()).toBeDefined()
    expect(ctx.db.prepare('SELECT id FROM assets WHERE id = ?').get(assetId)).toBeDefined()
  })
})
