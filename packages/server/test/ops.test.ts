import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createLlmClient, loadConfig, openDb, type CoreCtx } from '@forgecast/core'
import { beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/app'
import { createTaskQueue } from '../src/tasks'

let ctx: CoreCtx
let app: ReturnType<typeof createApp>
beforeEach(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-ops-srv-'))
  const config = loadConfig(root, {})
  ctx = { db: openDb(config.paths.db), config, llm: createLlmClient(config.llm) }
  ctx.db.prepare("INSERT INTO projects (slug) VALUES ('demo')").run()
  ctx.db.prepare("INSERT INTO assets (project_id, type, hook, file_path, status) VALUES (1, 'copy', 'pain', 'demo/copy/a.md', 'approved')").run()
  app = createApp(ctx, createTaskQueue())
})
const J = (body: any) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

describe('ops API', () => {
  it('publish → 素材变 published', async () => {
    expect((await app.request('/api/assets/1/publish', J({ platform: 'xhs', url: 'u' }))).status).toBe(200)
    const a: any = ctx.db.prepare('SELECT * FROM assets WHERE id = 1').get()
    expect(a.status).toBe('published')
    expect(a.platform).toBe('xhs')
  })
  it('publish 未知素材 404', async () => {
    expect((await app.request('/api/assets/999/publish', J({ platform: 'xhs' }))).status).toBe(404)
  })
  it('perf 回填', async () => {
    expect((await app.request('/api/assets/1/perf', J({ views: 100, likes: 5, leads: 1 }))).status).toBe(200)
    const a: any = ctx.db.prepare('SELECT perf FROM assets WHERE id = 1').get()
    expect(JSON.parse(a.perf).views).toBe(100)
  })
  it('leads POST + GET', async () => {
    const { id } = await (await app.request('/api/leads', J({ assetId: 1, wechat: 'wx' }))).json() as any
    expect(id).toBeGreaterThan(0)
    const leads = await (await app.request('/api/leads')).json() as any[]
    expect(leads).toHaveLength(1)
    expect(leads[0].hook).toBe('pain')
  })
  it('leads 缺 assetId 400', async () => {
    expect((await app.request('/api/leads', J({}))).status).toBe(400)
  })
  it('calendar 与 report', async () => {
    const cal = await (await app.request('/api/calendar')).json() as any
    expect(cal).toHaveProperty('remainingToday')
    expect(cal.inventory.pain).toBe(1)
    const rep = await (await app.request('/api/report')).json() as any
    expect(rep).toHaveProperty('perHook')
  })
})
