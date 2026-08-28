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
let root: string
function wait(ms: number) { return new Promise((r) => setTimeout(r, ms)) }

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-rbx-srv-'))
  const config = loadConfig(root, {})
  ctx = { db: openDb(config.paths.db), config, llm: createLlmClient(config.llm) }
  const info = ctx.db.prepare(
    "INSERT INTO candidates (repo, url, license_ok) VALUES ('o/demo', 'https://github.com/o/demo', 1)",
  ).run()
  ctx.db.prepare('INSERT INTO projects (slug, candidate_id) VALUES (?, ?)').run('demo', Number(info.lastInsertRowid))
  fs.mkdirSync(path.join(root, 'workspace/demo'), { recursive: true })
  fs.writeFileSync(path.join(root, 'workspace/demo/rebrand-plan.md'), '# demo 换皮改造清单\n## 1. 品牌替换\n- x')
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

describe('rebrand-exec API (mock)', () => {
  it('POST rebrand-exec → 任务完成 → projects.rebrand_exec_result 写入 done 状态', async () => {
    const { taskId } = await (await app.request('/api/projects/demo/rebrand-exec', { method: 'POST' })).json() as any
    await runTask(taskId)
    const row: any = ctx.db.prepare("SELECT rebrand_exec_result FROM projects WHERE slug = 'demo'").get()
    expect(row.rebrand_exec_result).toBeTruthy()
    const result = JSON.parse(row.rebrand_exec_result)
    expect(result.status).toBe('done')
    expect(result.reportPath).toBe(path.join('demo', 'rebrand-exec-report.md'))
  })
  it('未知项目 → 404', async () => {
    expect((await app.request('/api/projects/nope/rebrand-exec', { method: 'POST' })).status).toBe(404)
  })
})
