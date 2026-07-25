import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'
import { createLlmClient, loadConfig, openDb, type CoreCtx } from '@forgecast/core'
import { beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/app'
import { createTaskQueue } from '../src/tasks'

let ctx: CoreCtx, app: ReturnType<typeof createApp>, queue: ReturnType<typeof createTaskQueue>
function wait(ms: number) { return new Promise((r) => setTimeout(r, ms)) }
beforeEach(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-rsa-'))
  const config = loadConfig(root, {}) // llm mock
  ctx = { db: openDb(config.paths.db), config, llm: createLlmClient(config.llm) }
  queue = createTaskQueue()
  app = createApp(ctx, queue)
})
async function runTask(taskId: string) {
  for (let i = 0; i < 100; i++) { await wait(20); const s = queue.get(taskId)!.status; if (s === 'done' || s === 'failed') return }
}

describe('POST /api/candidates/rescore-all', () => {
  it('mock 模式：返 taskId，任务只提示、不评分（候选 score_detail 不变）', async () => {
    ctx.db.prepare("INSERT INTO candidates (repo,url,license_ok,score,score_detail,status) VALUES ('a/b','u',1,50,?, 'candidate')")
      .run(JSON.stringify({ rebrandCost: 10 })) // 无 targetBuyer = 需评
    const { taskId } = await (await app.request('/api/candidates/rescore-all', { method: 'POST' })).json() as any
    expect(taskId).toBeTruthy()
    await runTask(taskId)
    // 候选未被评（仍无 targetBuyer）
    const sd = (ctx.db.prepare("SELECT score_detail FROM candidates WHERE repo='a/b'").get() as any).score_detail
    expect(JSON.parse(sd).targetBuyer).toBeUndefined()
    // 任务日志含 mock 提示
    const msgs = queue.get(taskId)!.events.map((e) => e.message).join(' ')
    expect(msgs).toMatch(/mock/i)
  })
})
