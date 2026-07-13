import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createLlmClient, loadConfig, openDb, syncWorkspaceProjects, type CoreCtx } from '@forgecast/core'
import { beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/app'
import { createTaskQueue } from '../src/tasks'

let ctx: CoreCtx
let app: ReturnType<typeof createApp>
let queue: ReturnType<typeof createTaskQueue>

function wait(ms: number) { return new Promise((r) => setTimeout(r, ms)) }

beforeEach(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-a-'))
  const config = loadConfig(root, {})
  config.paths.templates = path.resolve(__dirname, '../../../templates')
  fs.mkdirSync(path.join(root, 'workspace/demo-project'), { recursive: true })
  fs.writeFileSync(path.join(root, 'workspace/demo-project/analysis.md'), '# 分析\n## 痛点清单\n- 熬夜回消息')
  ctx = { db: openDb(config.paths.db), config, llm: createLlmClient(config.llm) }
  syncWorkspaceProjects(ctx)
  queue = createTaskQueue()
  app = createApp(ctx, queue)
})

async function generateOne(): Promise<any> {
  const res = await app.request('/api/projects/demo-project/copy', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hook: 'pain', n: 1, renderCovers: false }),
  })
  expect(res.status).toBe(200)
  const { taskId } = await res.json() as any
  for (let i = 0; i < 100; i++) {
    await wait(30)
    const s = queue.get(taskId)!.status
    if (s === 'done') return
    if (s === 'failed') throw new Error(queue.get(taskId)!.events.at(-1)!.message)
  }
  throw new Error('任务超时')
}

describe('copy 生成 + assets API', () => {
  it('POST copy → 任务完成 → assets 可查、内容可读可改、可审核', async () => {
    await generateOne()
    const assets = await (await app.request('/api/projects/demo-project/assets')).json() as any[]
    expect(assets.length).toBeGreaterThanOrEqual(1)
    const copy = assets.find((a) => a.type === 'copy')!

    const got = await (await app.request(`/api/assets/${copy.id}/content`)).json() as any
    expect(got.content).toContain('## 小红书正文')

    const newContent = got.content.replace('## 小红书正文', '## 小红书正文\n（人工改过）')
    const put = await app.request(`/api/assets/${copy.id}/content`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: newContent }),
    })
    expect(put.status).toBe(200)
    const abs = path.join(ctx.config.paths.workspace, copy.file_path)
    expect(fs.readFileSync(abs, 'utf8')).toContain('（人工改过）')

    const patched = await app.request(`/api/assets/${copy.id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'approved' }),
    })
    expect(patched.status).toBe(200)
    const after = await (await app.request('/api/projects/demo-project/assets')).json() as any[]
    expect(after.find((a) => a.id === copy.id).status).toBe('approved')
  })
  it('n=0 被夹取为 1，不产出空任务', async () => {
    const res = await app.request('/api/projects/demo-project/copy', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hook: 'pain', n: 0, renderCovers: false }),
    })
    expect(res.status).toBe(200)
    const { taskId } = await res.json() as any
    for (let i = 0; i < 100; i++) {
      await wait(30)
      const s = queue.get(taskId)!.status
      if (s === 'done') break
      if (s === 'failed') throw new Error(queue.get(taskId)!.events.at(-1)!.message)
      if (i === 99) throw new Error('任务超时')
    }
    const assets = await (await app.request('/api/projects/demo-project/assets')).json() as any[]
    const copies = assets.filter((a) => a.type === 'copy')
    expect(copies.length).toBeGreaterThanOrEqual(1)
  })
  it('非法 status 拒绝', async () => {
    await generateOne()
    const assets = await (await app.request('/api/projects/demo-project/assets')).json() as any[]
    const res = await app.request(`/api/assets/${assets[0].id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'hacked' }),
    })
    expect(res.status).toBe(400)
  })
  it('raw 上传与列表', async () => {
    const fd = new FormData()
    fd.append('file', new File(['fake-video'], 'demo.mp4', { type: 'video/mp4' }))
    const up = await app.request('/api/projects/demo-project/raw', { method: 'POST', body: fd })
    expect(up.status).toBe(200)
    const { files } = await (await app.request('/api/projects/demo-project/raw')).json() as any
    expect(files).toContain('demo.mp4')
  })
  it('/files/* 提供 workspace 文件且防路径穿越', async () => {
    await generateOne()
    const assets = await (await app.request('/api/projects/demo-project/assets')).json() as any[]
    const copy = assets.find((a) => a.type === 'copy')!
    const ok = await app.request(`/files/${copy.file_path}`)
    expect(ok.status).toBe(200)
    const evil = await app.request('/files/../package.json')
    expect(evil.status).toBe(404)
  })
})
