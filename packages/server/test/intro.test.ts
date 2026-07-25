import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadConfig, openDb, type CoreCtx } from '@forgecast/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../src/app'
import { createTaskQueue } from '../src/tasks'

function mkCtx(env: Record<string, string>, llm?: any): { ctx: CoreCtx; id: number } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-sintro-'))
  const config = loadConfig(root, env)
  // live 分支要读 templates/prompts/candidate-intro.md；tmpdir root 不带 templates，需指回仓库真实目录（同 assets.test.ts 惯例）
  config.paths.templates = path.resolve(__dirname, '../../../templates')
  const ctx: CoreCtx = { db: openDb(config.paths.db), config, llm: llm ?? { complete: async () => '' } }
  ctx.db.prepare("INSERT INTO candidates (repo,url,description,license_ok,status) VALUES ('a/adminlte','u','后台模板',1,'candidate')").run()
  const id = (ctx.db.prepare("SELECT id FROM candidates WHERE repo='a/adminlte'").get() as any).id
  return { ctx, id }
}
const GOOD = '```json\n{"summary":"AdminLTE 后台模板","features":["看板","权限","布局"],"targetUser":"中小团队","painPoint":"自研贵","rebrandIdea":"换 logo 卖"}\n```'
const H = { 'content-type': 'application/json' } // 带 body 的 POST 显式给 content-type，确保 c.req.json() 解析 force

describe('POST /api/candidates/:id/intro', () => {
  it('mock 模式 → {mode:mock} 且不写 intro_detail', async () => {
    const { ctx, id } = mkCtx({}) // mock
    const app = createApp(ctx, createTaskQueue())
    const r = await (await app.request(`/api/candidates/${id}/intro`, { method: 'POST', headers: H, body: '{}' })).json() as any
    expect(r.mode).toBe('mock')
    expect((ctx.db.prepare('SELECT intro_detail FROM candidates WHERE id=?').get(id) as any).intro_detail).toBeNull()
  })

  it('live 首次 → 生成、写库、返 cached:false', async () => {
    const llm = { complete: vi.fn(async () => GOOD) }
    const { ctx, id } = mkCtx({ FORGECAST_LLM_MODE: 'live', FORGECAST_LLM_KEY: 'k' }, llm)
    const app = createApp(ctx, createTaskQueue())
    const r = await (await app.request(`/api/candidates/${id}/intro`, { method: 'POST', headers: H, body: '{}' })).json() as any
    expect(r.mode).toBe('live'); expect(r.cached).toBe(false); expect(r.intro.summary).toBe('AdminLTE 后台模板')
    expect((ctx.db.prepare('SELECT intro_detail FROM candidates WHERE id=?').get(id) as any).intro_detail).toBeTruthy()
  })

  it('live 有缓存非 force → 返 cached:true 不再调 LLM', async () => {
    const llm = { complete: vi.fn(async () => GOOD) }
    const { ctx, id } = mkCtx({ FORGECAST_LLM_MODE: 'live', FORGECAST_LLM_KEY: 'k' }, llm)
    const app = createApp(ctx, createTaskQueue())
    await app.request(`/api/candidates/${id}/intro`, { method: 'POST', headers: H, body: '{}' }) // 生成一次
    const r = await (await app.request(`/api/candidates/${id}/intro`, { method: 'POST', headers: H, body: '{}' })).json() as any
    expect(r.cached).toBe(true)
    expect(llm.complete).toHaveBeenCalledOnce() // 第二次未再调
  })

  it('force → 即使有缓存也重生成', async () => {
    const llm = { complete: vi.fn(async () => GOOD) }
    const { ctx, id } = mkCtx({ FORGECAST_LLM_MODE: 'live', FORGECAST_LLM_KEY: 'k' }, llm)
    const app = createApp(ctx, createTaskQueue())
    await app.request(`/api/candidates/${id}/intro`, { method: 'POST', headers: H, body: '{}' })
    const r = await (await app.request(`/api/candidates/${id}/intro`, { method: 'POST', headers: H, body: JSON.stringify({ force: true }) })).json() as any
    expect(r.cached).toBe(false)
    expect(llm.complete).toHaveBeenCalledTimes(2)
  })

  it('未知 id → 404', async () => {
    const { ctx } = mkCtx({})
    const app = createApp(ctx, createTaskQueue())
    const res = await app.request('/api/candidates/99999/intro', { method: 'POST', headers: H, body: '{}' })
    expect(res.status).toBe(404)
  })
})

describe('GET /api/candidates 不返 intro_detail', () => {
  it('列表项无 intro_detail 字段', async () => {
    const { ctx, id } = mkCtx({ FORGECAST_LLM_MODE: 'live', FORGECAST_LLM_KEY: 'k' }, { complete: async () => GOOD })
    ctx.db.prepare('UPDATE candidates SET intro_detail = ? WHERE id = ?').run('{"summary":"x"}', id)
    const app = createApp(ctx, createTaskQueue())
    const rows = await (await app.request('/api/candidates')).json() as any[]
    expect(rows.length).toBeGreaterThan(0)
    expect('intro_detail' in rows[0]).toBe(false)
  })
})
