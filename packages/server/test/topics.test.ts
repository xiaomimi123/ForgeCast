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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-topics-route-'))
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

describe('/api/topics/sources', () => {
  it('GET 空列表；POST 新增；PUT 更新；DELETE 删除', async () => {
    expect(await (await app.request('/api/topics/sources')).json()).toEqual([])
    const created = await (await app.request('/api/topics/sources', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ platform: 'douyin', handle: 'a', followerCount: 100 }),
    })).json() as any
    expect(created.id).toBeTypeOf('number')
    const list = await (await app.request('/api/topics/sources')).json() as any[]
    expect(list.length).toBe(1)
    expect(list[0].follower_count).toBe(100)

    const putRes = await app.request(`/api/topics/sources/${created.id}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ followerCount: 200 }),
    })
    expect(putRes.status).toBe(200)
    const list2 = await (await app.request('/api/topics/sources')).json() as any[]
    expect(list2[0].follower_count).toBe(200)

    const delRes = await app.request(`/api/topics/sources/${created.id}`, { method: 'DELETE' })
    expect(delRes.status).toBe(200)
    expect(await (await app.request('/api/topics/sources')).json()).toEqual([])
  })
  it('POST platform 非法 → 400', async () => {
    const res = await app.request('/api/topics/sources', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ platform: 'x', handle: 'a' }),
    })
    expect(res.status).toBe(400)
  })
  it('PUT 不存在的账号 → 404', async () => {
    const res = await app.request('/api/topics/sources/999', {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ note: 'x' }),
    })
    expect(res.status).toBe(404)
  })
  it('POST .../:id/request-scrape 设置待抓取标记；不存在账号 → 404', async () => {
    const created = await (await app.request('/api/topics/sources', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ platform: 'douyin', handle: 'g' }),
    })).json() as any
    const res = await app.request(`/api/topics/sources/${created.id}/request-scrape`, { method: 'POST' })
    expect(res.status).toBe(200)
    const list = await (await app.request('/api/topics/sources')).json() as any[]
    expect(list[0].scrape_requested_at).not.toBeNull()

    const res404 = await app.request('/api/topics/sources/999/request-scrape', { method: 'POST' })
    expect(res404.status).toBe(404)
  })
})

describe('/api/topics/patterns + extract', () => {
  it('GET 支持 hook 过滤；POST extract 走任务队列，mock 模式无笔记时新增 0 条', async () => {
    const res = await app.request('/api/topics/extract', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    })
    const { taskId } = await res.json() as any
    await runTask(taskId)
    const patterns = await (await app.request('/api/topics/patterns')).json() as any[]
    expect(patterns).toEqual([])
    const filtered = await (await app.request('/api/topics/patterns?hook=pain')).json() as any[]
    expect(filtered).toEqual([])
  })
})
