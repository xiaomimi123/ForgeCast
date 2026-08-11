import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createLlmClient, loadConfig, openDb, syncWorkspaceProjects, type CoreCtx } from '@forgecast/core'
import { beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/app'
import { createTaskQueue } from '../src/tasks'

let ctx: CoreCtx
let app: ReturnType<typeof createApp>
let queue: ReturnType<typeof createTaskQueue>

function wait(ms: number) { return new Promise((r) => setTimeout(r, ms)) }

beforeEach(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-cover-regen-'))
  const config = loadConfig(root, {})
  config.paths.templates = path.resolve(__dirname, '../../../templates')
  fs.mkdirSync(path.join(root, 'workspace/demo-project'), { recursive: true })
  fs.writeFileSync(path.join(root, 'workspace/demo-project/analysis.md'), '# 分析\n## 痛点清单\n- 熬夜回消息')
  ctx = { db: openDb(config.paths.db), config, llm: createLlmClient(config.llm) }
  syncWorkspaceProjects(ctx)
  queue = createTaskQueue()
  app = createApp(ctx, queue)
})

async function runTask(taskId: string) {
  for (let i = 0; i < 200; i++) {
    await wait(50)
    const t = queue.get(taskId)!
    if (t.status === 'done') return
    if (t.status === 'failed') throw new Error(t.events.at(-1)!.message)
  }
  throw new Error('任务超时')
}

async function generateOne(): Promise<any> {
  const res = await app.request('/api/projects/demo-project/copy', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hook: 'pain', n: 1, renderCovers: false }),
  })
  const { taskId } = await res.json() as any
  for (let i = 0; i < 100; i++) {
    await wait(30)
    const assets = await (await app.request('/api/projects/demo-project/assets')).json() as any[]
    const copy = assets.find((a) => a.type === 'copy')
    if (copy) return copy
  }
  throw new Error('生成超时')
}

describe('POST /api/assets/:id/cover', () => {
  it('id 不存在 → 404', async () => {
    expect((await app.request('/api/assets/999999/cover', { method: 'POST' })).status).toBe(404)
  })
  it('id 指向非 copy 类型素材 → 404', async () => {
    const info = ctx.db.prepare(
      "INSERT INTO assets (project_id, type, hook, file_path, warnings) VALUES (1, 'video', 'pain', 'x.mp4', '[]')",
    ).run()
    expect((await app.request(`/api/assets/${info.lastInsertRowid}/cover`, { method: 'POST' })).status).toBe(404)
  })
  it('id 是真实 copy 素材 → 真渲染出一张新 cover 素材（走真 Playwright，环境已装 chromium）', async () => {
    const copy = await generateOne()
    const res = await app.request(`/api/assets/${copy.id}/cover`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ template: 'contrast' }),
    })
    expect(res.status).toBe(200)
    const { taskId } = await res.json() as any
    await runTask(taskId)
    const assets = await (await app.request('/api/projects/demo-project/assets')).json() as any[]
    const cover = assets.find((a) => a.type === 'cover')
    expect(cover).toBeDefined()
    expect(fs.existsSync(path.join(ctx.config.paths.workspace, cover.file_path))).toBe(true)
  }, 20000)
})
