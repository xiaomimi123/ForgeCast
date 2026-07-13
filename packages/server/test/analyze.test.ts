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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-anlz-'))
  const config = loadConfig(root, {})
  ctx = { db: openDb(config.paths.db), config, llm: createLlmClient(config.llm) }
  ctx.db.prepare('INSERT INTO projects (slug) VALUES (?)').run('demo')
  const dir = path.join(root, 'workspace/demo/source')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'README.md'), '开源客服系统，React + Docker')
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

describe('analyze API (mock)', () => {
  it('POST analyze → 任务完成 → GET 项目详情含 analysisMd', async () => {
    const { taskId } = await (await app.request('/api/projects/demo/analyze', { method: 'POST' })).json() as any
    await runTask(taskId)
    const detail = await (await app.request('/api/projects/demo')).json() as any
    expect(detail.analysisMd).toContain('## 钩子匹配')
    expect(detail.analysisMd).toMatch(/# demo 商业化分析/)
  })
  it('未知项目 → 404', async () => {
    expect((await app.request('/api/projects/nope/analyze', { method: 'POST' })).status).toBe(404)
  })
})
