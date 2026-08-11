import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createLlmClient, loadConfig, openDb, type CoreCtx } from '@forgecast/core'
import { beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/app'
import { createTaskQueue } from '../src/tasks'

let ctx: CoreCtx
let app: ReturnType<typeof createApp>
let queue: ReturnType<typeof createTaskQueue>

function wait(ms: number) { return new Promise((r) => setTimeout(r, ms)) }
async function runTask(taskId: string) {
  for (let i = 0; i < 200; i++) {
    await wait(50)
    const t = queue.get(taskId)!
    if (t.status === 'done') return
    if (t.status === 'failed') throw new Error(t.events.at(-1)!.message)
  }
  throw new Error('任务超时')
}

beforeEach(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-screens-srv-'))
  const config = loadConfig(root, {})
  ctx = { db: openDb(config.paths.db), config, llm: createLlmClient(config.llm) }
  ctx.db.prepare("INSERT INTO projects (slug, brand_name) VALUES ('demo', '快客通')").run()
  queue = createTaskQueue()
  app = createApp(ctx, queue)
})

describe('POST /api/projects/:slug/screens', () => {
  it('未知项目 → 404', async () => {
    expect((await app.request('/api/projects/nope/screens', { method: 'POST' })).status).toBe(404)
  })
  it('真实项目 → 200 + taskId，任务完成后 shots/ 出现 3 个文件', async () => {
    const res = await app.request('/api/projects/demo/screens', { method: 'POST' })
    expect(res.status).toBe(200)
    const { taskId } = await res.json() as any
    await runTask(taskId)
    const { files } = await (await app.request('/api/projects/demo/shots')).json() as any
    expect(files.sort()).toEqual(['ai-01-dashboard.png', 'ai-02-list.png', 'ai-03-detail.png'])
  }, 20000)
})
