import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createLlmClient, loadConfig, openDb, setSettings, type CoreCtx } from '@forgecast/core'
import { beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/app'
import { createTaskQueue } from '../src/tasks'

let ctx: CoreCtx
let app: ReturnType<typeof createApp>
let queue: ReturnType<typeof createTaskQueue>

beforeEach(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-extras-'))
  const config = loadConfig(root, {})
  ctx = { db: openDb(config.paths.db), config, llm: createLlmClient(config.llm) }
  queue = createTaskQueue()
  app = createApp(ctx, queue)
})

describe('favorite + auto-status (mock)', () => {
  it('favorite 切换与 404；列表返回 favorite 列', async () => {
    ctx.db.prepare("INSERT INTO candidates (repo, url, license_ok, status) VALUES ('a/b', 'u', 1, 'candidate')").run()
    expect((await app.request('/api/candidates/999/favorite', { method: 'POST', body: JSON.stringify({ favorite: true }) })).status).toBe(404)
    const res = await app.request('/api/candidates/1/favorite', { method: 'POST', body: JSON.stringify({ favorite: true }) })
    expect(res.status).toBe(200)
    let rows = await (await app.request('/api/candidates')).json() as any[]
    expect(rows[0].favorite).toBe(1)
    await app.request('/api/candidates/1/favorite', { method: 'POST', body: JSON.stringify({ favorite: false }) })
    rows = await (await app.request('/api/candidates')).json() as any[]
    expect(rows[0].favorite).toBe(0)
  })
  it('auto-status：默认值与写入后', async () => {
    let s = await (await app.request('/api/scout/auto-status')).json() as any
    expect(s).toEqual({ enabled: true, time: '08:00', lastRun: null, lastResult: null })
    setSettings(ctx.db, { auto_scout: 'off', auto_scout_time: '21:30', auto_scout_last_run: '2026-08-09', auto_scout_last_result: '{"at":"t","added":3}' })
    s = await (await app.request('/api/scout/auto-status')).json() as any
    expect(s.enabled).toBe(false)
    expect(s.time).toBe('21:30')
    expect(s.lastRun).toBe('2026-08-09')
    expect(s.lastResult).toEqual({ at: 't', added: 3 })
  })
  it('last_result 坏 JSON 兜底 null 不 500', async () => {
    setSettings(ctx.db, { auto_scout_last_result: 'not json' })
    const s = await (await app.request('/api/scout/auto-status')).json() as any
    expect(s.lastResult).toBeNull()
  })
})
