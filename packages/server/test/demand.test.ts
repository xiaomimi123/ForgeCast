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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-demand-route-'))
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

describe('/api/demand', () => {
  it('import 缺参 → 400；正常导入 → 列表可见', async () => {
    expect((await app.request('/api/demand/import', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(400)
    const r = await (await app.request('/api/demand/import', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'douyin_hot', signals: [{ title: '信号1', heat: 5 }] }),
    })).json() as any
    expect(r).toEqual({ imported: 1, updated: 0 })
    const list = await (await app.request('/api/demand/signals')).json() as any[]
    expect(list).toHaveLength(1)
    expect(list[0].title).toBe('信号1')
  })
  it('PATCH 状态：star 生效；不存在 id → 404', async () => {
    await app.request('/api/demand/import', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'xhs', signals: [{ title: 'x' }] }),
    })
    const [s] = await (await app.request('/api/demand/signals')).json() as any[]
    const ok = await app.request(`/api/demand/signals/${s.id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'starred' }),
    })
    expect(ok.status).toBe(200)
    const starred = await (await app.request('/api/demand/signals?status=starred')).json() as any[]
    expect(starred).toHaveLength(1)
    expect((await app.request('/api/demand/signals/9999', {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'starred' }),
    })).status).toBe(404)
  })
  it('request-collect 打标记 → collect-status 可见；import 后清除', async () => {
    await app.request('/api/demand/request-collect', { method: 'POST' })
    let st = await (await app.request('/api/demand/collect-status')).json() as any
    expect(st.requestedAt).toBeTruthy()
    await app.request('/api/demand/import', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'github_trending', signals: [{ title: 'r/x' }] }),
    })
    st = await (await app.request('/api/demand/collect-status')).json() as any
    expect(st.requestedAt).toBeNull()
    expect(st.lastCollectedAt).toBeTruthy()
  })
  it('extract 任务（mock）→ kind/opportunity 被填', async () => {
    await app.request('/api/demand/import', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'xhs', signals: [{ title: '待分类' }] }),
    })
    const { taskId } = await (await app.request('/api/demand/extract', { method: 'POST' })).json() as any
    await runTask(taskId)
    const [s] = await (await app.request('/api/demand/signals')).json() as any[]
    expect(s.kind).toBeTruthy()
    expect(s.opportunity).toBeTruthy()
  })
})
