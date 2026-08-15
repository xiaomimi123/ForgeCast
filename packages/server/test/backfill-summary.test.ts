import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'
import { createLlmClient, loadConfig, openDb, type CoreCtx } from '@forgecast/core'
import { beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/app'
import { createTaskQueue } from '../src/tasks'

let ctx: CoreCtx, app: ReturnType<typeof createApp>, queue: ReturnType<typeof createTaskQueue>
function wait(ms: number) { return new Promise((r) => setTimeout(r, ms)) }
beforeEach(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-bfs-'))
  const config = loadConfig(root, {}) // llm mock
  ctx = { db: openDb(config.paths.db), config, llm: createLlmClient(config.llm) }
  queue = createTaskQueue()
  app = createApp(ctx, queue)
})
async function runTask(taskId: string) {
  for (let i = 0; i < 100; i++) { await wait(20); const s = queue.get(taskId)!.status; if (s === 'done' || s === 'failed') return }
}

describe('POST /api/candidates/backfill-summary', () => {
  it('mock 模式：返 taskId，任务只提示、不生成（score_detail 除 summaryZh 外不变）', async () => {
    ctx.db.prepare("INSERT INTO candidates (repo,url,license_ok,score,score_detail,status) VALUES ('a/b','u',1,50,?, 'candidate')")
      .run(JSON.stringify({ rebrandCost: 10, targetBuyer: '已评过' })) // 无 summaryZh = 需补
    const { taskId } = await (await app.request('/api/candidates/backfill-summary', { method: 'POST' })).json() as any
    expect(taskId).toBeTruthy()
    await runTask(taskId)
    const msgs = queue.get(taskId)!.events.map((e) => e.message).join(' ')
    expect(msgs).toMatch(/mock/i)
  })
  it('无需补充时提示并结束', async () => {
    ctx.db.prepare("INSERT INTO candidates (repo,url,license_ok,score,score_detail,status) VALUES ('a/b','u',1,50,?, 'candidate')")
      .run(JSON.stringify({ rebrandCost: 10, summaryZh: '已经有了' }))
    const { taskId } = await (await app.request('/api/candidates/backfill-summary', { method: 'POST' })).json() as any
    await runTask(taskId)
    const msgs = queue.get(taskId)!.events.map((e) => e.message).join(' ')
    expect(msgs).toMatch(/无需补充/)
  })
})
