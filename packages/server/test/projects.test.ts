import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createLlmClient, loadConfig, openDb, syncWorkspaceProjects, type CoreCtx } from '@forgecast/core'
import { beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/app'
import { createTaskQueue } from '../src/tasks'

let ctx: CoreCtx

beforeEach(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-srv-'))
  const config = loadConfig(root, {})
  fs.mkdirSync(path.join(root, 'workspace/demo-project'), { recursive: true })
  fs.writeFileSync(path.join(root, 'workspace/demo-project/analysis.md'), '# 分析')
  ctx = { db: openDb(config.paths.db), config, llm: createLlmClient(config.llm) }
})

describe('projects API', () => {
  it('syncWorkspaceProjects 把目录 upsert 成项目，幂等', () => {
    syncWorkspaceProjects(ctx)
    syncWorkspaceProjects(ctx)
    const rows = ctx.db.prepare('SELECT * FROM projects').all()
    expect(rows).toHaveLength(1)
    expect((rows[0] as any).slug).toBe('demo-project')
  })
  it('GET /api/projects 列表；GET 详情带 analysisMd；PATCH 可改字段', async () => {
    syncWorkspaceProjects(ctx)
    const app = createApp(ctx, createTaskQueue())
    const list = await (await app.request('/api/projects')).json() as any[]
    expect(list).toHaveLength(1)
    const detail = await (await app.request('/api/projects/demo-project')).json() as any
    expect(detail.analysisMd).toContain('# 分析')
    const patched = await app.request('/api/projects/demo-project', {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ brand_name: '快客通', price_deploy: 1999 }),
    })
    expect(patched.status).toBe(200)
    const after = await (await app.request('/api/projects/demo-project')).json() as any
    expect(after.brand_name).toBe('快客通')
    expect(after.price_deploy).toBe(1999)
  })
  it('未知项目 404', async () => {
    const app = createApp(ctx, createTaskQueue())
    expect((await app.request('/api/projects/nope')).status).toBe(404)
  })
})
