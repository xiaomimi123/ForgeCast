import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'
import { createLlmClient, loadConfig, openDb, type CoreCtx } from '@forgecast/core'
import { beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/app'
import { createTaskQueue } from '../src/tasks'

let ctx: CoreCtx, app: ReturnType<typeof createApp>, root: string
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-del-'))
  const config = loadConfig(root, {})
  ctx = { db: openDb(config.paths.db), config, llm: createLlmClient(config.llm) }
  ctx.db.prepare("INSERT INTO projects (slug) VALUES ('demo')").run()
  app = createApp(ctx, createTaskQueue())
})
function addVideo(rel = 'demo/videos/x.mp4'): number {
  const abs = path.join(root, 'workspace', rel); fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, 'fake')
  return Number(ctx.db.prepare("INSERT INTO assets (project_id, type, hook, file_path, status) VALUES (1,'video','pain',?, 'draft')").run(rel).lastInsertRowid)
}

describe('DELETE /api/assets/:id', () => {
  it('存在 → 200 且行没了', async () => {
    const id = addVideo()
    expect((await app.request(`/api/assets/${id}`, { method: 'DELETE' })).status).toBe(200)
    expect(ctx.db.prepare('SELECT id FROM assets WHERE id = ?').get(id)).toBeUndefined()
  })
  it('不存在 → 404', async () => {
    expect((await app.request('/api/assets/99999', { method: 'DELETE' })).status).toBe(404)
  })
  it('有关联询单 → 409', async () => {
    const id = addVideo('demo/videos/y.mp4')
    ctx.db.prepare('INSERT INTO leads (asset_id, wechat) VALUES (?, ?)').run(id, 'wx1')
    expect((await app.request(`/api/assets/${id}`, { method: 'DELETE' })).status).toBe(409)
    expect(ctx.db.prepare('SELECT id FROM assets WHERE id = ?').get(id)).toBeDefined() // 没删
  })
})
