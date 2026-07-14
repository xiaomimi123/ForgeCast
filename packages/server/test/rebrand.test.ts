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

beforeEach(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-rb-srv-'))
  const config = loadConfig(root, {})
  ctx = { db: openDb(config.paths.db), config, llm: createLlmClient(config.llm) }
  ctx.db.prepare("INSERT INTO projects (slug) VALUES ('demo')").run()
  fs.mkdirSync(path.join(root, 'workspace/demo'), { recursive: true })
  fs.writeFileSync(path.join(root, 'workspace/demo/analysis.md'), '# demo 商业化分析')
  queue = createTaskQueue()
  app = createApp(ctx, queue)
})
async function runTask(taskId: string) {
  for (let i = 0; i < 100; i++) {
    await wait(20)
    const s = queue.get(taskId)!.status
    if (s === 'done') return
    if (s === 'failed') throw new Error(queue.get(taskId)!.events.at(-1)!.message)
  }
  throw new Error('任务超时')
}

describe('rebrand API (mock)', () => {
  it('POST rebrand → 任务完成 → rebrand-plan.md 落盘', async () => {
    const { taskId } = await (await app.request('/api/projects/demo/rebrand', { method: 'POST' })).json() as any
    await runTask(taskId)
    expect(fs.existsSync(path.join(ctx.config.paths.workspace, 'demo', 'rebrand-plan.md'))).toBe(true)
  })
  it('未知项目 → 404', async () => {
    expect((await app.request('/api/projects/nope/rebrand', { method: 'POST' })).status).toBe(404)
  })
})
