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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-tailor-'))
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

describe('tailor API (mock)', () => {
  it('POST /api/tailor 缺参 400；正常创建后 GET 列表/详情', async () => {
    let res = await app.request('/api/tailor', { method: 'POST', body: JSON.stringify({ title: 'x' }) })
    expect(res.status).toBe(400)
    res = await app.request('/api/tailor', { method: 'POST', body: JSON.stringify({ title: '宠物店小程序', rawNeed: '要登录。要支付' }) })
    const { id } = await res.json() as any
    expect((await (await app.request('/api/tailor')).json() as any[]).length).toBe(1)
    const detail = await (await app.request(`/api/tailor/${id}`)).json() as any
    expect(detail.request.status).toBe('draft')
    expect((await app.request('/api/tailor/999')).status).toBe(404)
  })
  it('状态机：draft 搜轮子 400；拆解后可搜；有 pending 出方案书 400', async () => {
    const { id } = await (await app.request('/api/tailor', { method: 'POST', body: JSON.stringify({ title: 't', rawNeed: '要有登录功能。要有支付功能' }) })).json() as any
    expect((await app.request(`/api/tailor/${id}/search`, { method: 'POST', body: '{}' })).status).toBe(400)
    expect((await app.request(`/api/tailor/${id}/proposal`, { method: 'POST' })).status).toBe(400) // 没能力清单
    const { taskId } = await (await app.request(`/api/tailor/${id}/decompose`, { method: 'POST' })).json() as any
    await runTask(taskId)
    const d1 = await (await app.request(`/api/tailor/${id}`)).json() as any
    expect(d1.request.status).toBe('decomposed')
    expect(d1.capabilities.length).toBeGreaterThanOrEqual(2)
    expect((await app.request(`/api/tailor/${id}/proposal`, { method: 'POST' })).status).toBe(400) // 全 pending
    const { taskId: t2 } = await (await app.request(`/api/tailor/${id}/search`, { method: 'POST', body: '{}' })).json() as any
    await runTask(t2)
    const d2 = await (await app.request(`/api/tailor/${id}`)).json() as any
    expect(d2.request.status).toBe('searched')
    expect(d2.capabilities[0].wheels.length).toBeGreaterThan(0)
  })
  it('决策 PATCH + 方案书全流程', async () => {
    const { id } = await (await app.request('/api/tailor', { method: 'POST', body: JSON.stringify({ title: 't', rawNeed: '要有登录功能。要有支付功能' }) })).json() as any
    await runTask((await (await app.request(`/api/tailor/${id}/decompose`, { method: 'POST' })).json() as any).taskId)
    await runTask((await (await app.request(`/api/tailor/${id}/search`, { method: 'POST', body: '{}' })).json() as any).taskId)
    const d = await (await app.request(`/api/tailor/${id}`)).json() as any
    const [a, b] = d.capabilities
    // 非法 decision / wheel 缺 chosenRepo
    expect((await app.request(`/api/tailor/capabilities/${a.id}`, { method: 'PATCH', body: JSON.stringify({ decision: 'nope' }) })).status).toBe(400)
    expect((await app.request(`/api/tailor/capabilities/${a.id}`, { method: 'PATCH', body: JSON.stringify({ decision: 'wheel' }) })).status).toBe(400)
    expect((await app.request(`/api/tailor/capabilities/${a.id}`, { method: 'PATCH', body: JSON.stringify({ decision: 'wheel', chosenRepo: a.wheels[0].repo }) })).status).toBe(200)
    expect((await app.request(`/api/tailor/capabilities/${b.id}`, { method: 'PATCH', body: JSON.stringify({ decision: 'self_build' }) })).status).toBe(200)
    await runTask((await (await app.request(`/api/tailor/${id}/proposal`, { method: 'POST' })).json() as any).taskId)
    const md = (await (await app.request(`/api/tailor/${id}/proposal`)).json() as any).md
    expect(md).toContain('拼装方案书')
  })
  it('能力项增删 + 询单转入', async () => {
    const { id } = await (await app.request('/api/tailor', { method: 'POST', body: JSON.stringify({ title: 't', rawNeed: 'n' }) })).json() as any
    const cap = await (await app.request(`/api/tailor/${id}/capabilities`, { method: 'POST', body: JSON.stringify({ name: '登录', keywords: ['oauth'] }) })).json() as any
    expect((await app.request(`/api/tailor/capabilities/${cap.id}`, { method: 'DELETE' })).status).toBe(200)
    // 询单：无 intent 400；有 intent 转入成功
    ctx.db.prepare("INSERT INTO leads (wechat, intent) VALUES ('wx1', '')").run()
    ctx.db.prepare("INSERT INTO leads (wechat, intent) VALUES ('wx2', '想做个小程序')").run()
    expect((await app.request('/api/leads/1/to-tailor', { method: 'POST' })).status).toBe(400)
    expect((await app.request('/api/leads/999/to-tailor', { method: 'POST' })).status).toBe(404)
    const r = await (await app.request('/api/leads/2/to-tailor', { method: 'POST' })).json() as any
    const detail = await (await app.request(`/api/tailor/${r.id}`)).json() as any
    expect(detail.request.lead_id).toBe(2)
  })
})
