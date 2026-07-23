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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-cand-'))
  const config = loadConfig(root, {})
  ctx = { db: openDb(config.paths.db), config, llm: createLlmClient(config.llm) }
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

describe('candidates API (mock)', () => {
  it('POST /api/scout → 候选入池 → GET 排序返回 → pick 立项出现在 projects', async () => {
    const { taskId } = await (await app.request('/api/scout', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    })).json() as any
    await runTask(taskId)

    const list = await (await app.request('/api/candidates')).json() as any[]
    expect(list.length).toBeGreaterThanOrEqual(4)
    expect(list[0].license_ok).toBe(1) // 可商用者排前

    const picked = await app.request('/api/candidates/pick', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo: 'chatwoot/chatwoot' }),
    })
    expect(picked.status).toBe(200)
    const { slug } = await picked.json() as any
    expect(slug).toBe('chatwoot')
    const projects = await (await app.request('/api/projects')).json() as any[]
    expect(projects.some((p) => p.slug === 'chatwoot')).toBe(true)
  })
  it('pick 缺 repo → 400；协议不过 → 400', async () => {
    const noRepo = await app.request('/api/candidates/pick', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    })
    expect(noRepo.status).toBe(400)
    // 先入池，再 pick GPL
    const { taskId } = await (await app.request('/api/scout', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    })).json() as any
    await runTask(taskId)
    const gpl = await app.request('/api/candidates/pick', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo: 'gpl-example/copyleft-tool' }),
    })
    expect(gpl.status).toBe(400)
  })
})

describe('rescore', () => {
  it('重新评分改写 score_detail 且幂等；模式随响应返回', async () => {
    const { taskId } = await (await app.request('/api/candidates/add', {
      method: 'POST', body: JSON.stringify({ url: 'https://github.com/chatwoot/chatwoot' }),
    })).json() as any
    await runTask(taskId)
    const row: any = ctx.db.prepare('SELECT id, score_detail FROM candidates WHERE repo = ?').get('chatwoot/chatwoot')

    const r = await app.request(`/api/candidates/${row.id}/rescore`, { method: 'POST' })
    expect(r.status).toBe(200)
    const body = await r.json() as any
    expect(body.ok).toBe(true)
    expect(body.mode).toBe('mock')

    const after: any = ctx.db.prepare('SELECT score_detail FROM candidates WHERE id = ?').get(row.id)
    expect(JSON.parse(after.score_detail).targetBuyer).toBe('') // mock 不编造
    expect(after.score_detail).toBe(row.score_detail) // mock 确定性评分 → 幂等
  })

  it('候选不存在返回 404', async () => {
    const r = await app.request('/api/candidates/9999/rescore', { method: 'POST' })
    expect(r.status).toBe(404)
  })
})
