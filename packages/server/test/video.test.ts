import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { copyFixtures, createLlmClient, loadConfig, openDb, type CoreCtx } from '@forgecast/core'
import { beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/app'
import { createTaskQueue } from '../src/tasks'

let ctx: CoreCtx
let app: ReturnType<typeof createApp>
let queue: ReturnType<typeof createTaskQueue>
function wait(ms: number) { return new Promise((r) => setTimeout(r, ms)) }

beforeEach(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-vsrv-'))
  const config = loadConfig(root, { FORGECAST_VIDEO_MODE: 'stub' })
  ctx = { db: openDb(config.paths.db), config, llm: createLlmClient(config.llm) }
  ctx.db.prepare("INSERT INTO projects (slug) VALUES ('demo')").run()
  const copyDir = path.join(root, 'workspace/demo/copy')
  fs.mkdirSync(copyDir, { recursive: true })
  fs.writeFileSync(path.join(copyDir, 'pain-1.md'), copyFixtures.pain)
  ctx.db.prepare("INSERT INTO assets (project_id, type, hook, file_path) VALUES (1, 'copy', 'pain', 'demo/copy/pain-1.md')").run()
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

describe('video API (stub)', () => {
  it('POST video → 任务完成 → assets 出现 video 素材', async () => {
    const { taskId } = await (await app.request('/api/projects/demo/video', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    })).json() as any
    await runTask(taskId)
    const assets = await (await app.request('/api/projects/demo/assets')).json() as any[]
    expect(assets.some((a) => a.type === 'video')).toBe(true)
  })
  it('POST video {tpl:story} → 任务完成 → video 素材', async () => {
    const { taskId } = await (await app.request('/api/projects/demo/video', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tpl: 'story' }),
    })).json() as any
    await runTask(taskId)
    const assets = await (await app.request('/api/projects/demo/assets')).json() as any[]
    expect(assets.some((a) => a.type === 'video')).toBe(true)
  })
  it('POST video {tpl:demo} → 任务完成 → video 素材', async () => {
    const { taskId } = await (await app.request('/api/projects/demo/video', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tpl: 'demo' }),
    })).json() as any
    await runTask(taskId)
    const assets = await (await app.request('/api/projects/demo/assets')).json() as any[]
    expect(assets.some((a) => a.type === 'video')).toBe(true)
  })
  it('未知项目 → 404', async () => {
    expect((await app.request('/api/projects/nope/video', { method: 'POST' })).status).toBe(404)
  })
})
