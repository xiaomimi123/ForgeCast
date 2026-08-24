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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-templates-'))
  const config = loadConfig(root, {})
  ctx = { db: openDb(config.paths.db), config, llm: createLlmClient(config.llm) }
  queue = createTaskQueue()
  app = createApp(ctx, queue)
})

async function runTask(taskId: string) {
  for (let i = 0; i < 300; i++) {
    await wait(20)
    const s = queue.get(taskId)!.status
    if (s === 'done') return
    if (s === 'failed') throw new Error(queue.get(taskId)!.events.at(-1)!.message)
  }
  throw new Error('任务超时')
}

function fakeForm(fields: Record<string, string>): FormData {
  const fd = new FormData()
  fd.append('file', new File(['FAKE_MP4_BYTES'], 'benchmark.mp4', { type: 'video/mp4' }))
  for (const [k, v] of Object.entries(fields)) fd.append(k, v)
  return fd
}

describe('模板库路由', () => {
  it('POST /api/templates：缺 file 400', async () => {
    expect((await app.request('/api/templates', { method: 'POST', body: new FormData() })).status).toBe(400)
  })
  it('POST /api/templates：缺 aspectRatio 400', async () => {
    const fd = new FormData()
    fd.append('file', new File(['x'], 'a.mp4', { type: 'video/mp4' }))
    fd.append('name', 't1')
    expect((await app.request('/api/templates', { method: 'POST', body: fd })).status).toBe(400)
  })
  it('POST /api/templates：缺 name 400', async () => {
    expect((await app.request('/api/templates', { method: 'POST', body: fakeForm({ aspectRatio: 'portrait' }) })).status).toBe(400)
  })
  it('坏扩展名 400', async () => {
    const fd = new FormData()
    fd.append('file', new File(['x'], 'a.txt', { type: 'text/plain' }))
    fd.append('aspectRatio', 'portrait')
    fd.append('name', 't1')
    expect((await app.request('/api/templates', { method: 'POST', body: fd })).status).toBe(400)
  })
  it('全链路：上传 → 任务完成 → 落库 + 模板文件写盘（garbage mp4 走 fail-soft 拆解回退）', async () => {
    const { taskId } = await (await app.request('/api/templates', {
      method: 'POST', body: fakeForm({ aspectRatio: 'portrait', name: '对标A' }),
    })).json() as any
    await runTask(taskId)
    const row: any = ctx.db.prepare('SELECT * FROM custom_templates').get()
    expect(row.name).toBe('对标A')
    expect(row.aspect_ratio).toBe('portrait')
    const htmlPath = path.join(ctx.config.paths.templates, 'hf', 'custom', `${row.id}.html`)
    expect(fs.existsSync(htmlPath)).toBe(true)
  })
  it('GET /api/templates：列出已创建模板', async () => {
    const { taskId } = await (await app.request('/api/templates', {
      method: 'POST', body: fakeForm({ aspectRatio: 'landscape', name: '对标B', styleNote: '搞笑' }),
    })).json() as any
    await runTask(taskId)
    const list = await (await app.request('/api/templates')).json() as any[]
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ name: '对标B', aspect_ratio: 'landscape', style_note: '搞笑' })
  })
  it('DELETE /api/templates/:id：删行+删模板文件', async () => {
    const { taskId } = await (await app.request('/api/templates', {
      method: 'POST', body: fakeForm({ aspectRatio: 'portrait', name: '对标C' }),
    })).json() as any
    await runTask(taskId)
    const row: any = ctx.db.prepare('SELECT * FROM custom_templates').get()
    const htmlPath = path.join(ctx.config.paths.templates, 'hf', 'custom', `${row.id}.html`)
    expect((await app.request(`/api/templates/${row.id}`, { method: 'DELETE' })).status).toBe(200)
    expect(ctx.db.prepare('SELECT * FROM custom_templates').get()).toBeUndefined()
    expect(fs.existsSync(htmlPath)).toBe(false)
  })
  it('DELETE 不存在的 id → 404', async () => {
    expect((await app.request('/api/templates/9999', { method: 'DELETE' })).status).toBe(404)
  })
})
