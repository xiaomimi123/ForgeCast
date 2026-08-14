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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-shoot-'))
  const config = loadConfig(root, {})
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
  for (let i = 0; i < 200; i++) {
    await wait(20)
    const s = queue.get(taskId)!.status
    if (s === 'done') return
    if (s === 'failed') throw new Error(queue.get(taskId)!.events.at(-1)!.message)
  }
  throw new Error('任务超时')
}

function fakeVideoForm(name: string): FormData {
  const fd = new FormData()
  fd.append('file', new File(['FAKE_MP4_BYTES'], name, { type: 'video/mp4' }))
  return fd
}

describe('拍摄脚本/成片上传/审片', () => {
  it('POST script → 任务完成 → type=script 素材落库', async () => {
    const { taskId } = await (await app.request('/api/projects/demo/script', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    })).json() as any
    await runTask(taskId)
    const rows = ctx.db.prepare("SELECT * FROM assets WHERE type='script'").all() as any[]
    expect(rows).toHaveLength(1)
    expect(fs.existsSync(path.join(ctx.config.paths.workspace, rows[0].file_path))).toBe(true)
  })
  it('upload-video：缺 file 400、坏扩展名 400、mp4 成功 → origin=upload 素材+文件落盘', async () => {
    expect((await app.request('/api/projects/demo/upload-video', { method: 'POST', body: new FormData() })).status).toBe(400)
    const bad = new FormData()
    bad.append('file', new File(['x'], 'x.txt'))
    expect((await app.request('/api/projects/demo/upload-video', { method: 'POST', body: bad })).status).toBe(400)
    const r = await (await app.request('/api/projects/demo/upload-video', { method: 'POST', body: fakeVideoForm('take1.mp4') })).json() as any
    expect(r.ok).toBe(true)
    const row: any = ctx.db.prepare('SELECT * FROM assets WHERE id = ?').get(r.assetId)
    expect(row.type).toBe('video')
    expect(row.origin).toBe('upload')
    expect(fs.existsSync(path.join(ctx.config.paths.workspace, row.file_path))).toBe(true)
  })
  it('未知项目上传 → 404', async () => {
    expect((await app.request('/api/projects/nope/upload-video', { method: 'POST', body: fakeVideoForm('a.mp4') })).status).toBe(404)
  })
  it('review 任务：garbage mp4 → ffmpeg 失败走降级审（degraded）仍写 review', async () => {
    const up = await (await app.request('/api/projects/demo/upload-video', { method: 'POST', body: fakeVideoForm('take2.mp4') })).json() as any
    const { taskId } = await (await app.request(`/api/assets/${up.assetId}/review`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    })).json() as any
    await runTask(taskId)
    const row: any = ctx.db.prepare('SELECT review FROM assets WHERE id = ?').get(up.assetId)
    const report = JSON.parse(row.review)
    expect(report.scores.overall).toBeGreaterThan(0)
    expect(report.degraded).toMatch(/未转写/)
  })
  it('review 不存在的素材 → 任务失败', async () => {
    const { taskId } = await (await app.request('/api/assets/9999/review', { method: 'POST', body: '{}' })).json() as any
    await expect(runTask(taskId)).rejects.toThrow(/不存在/)
  })
  it('retro 任务：先审片再复盘 → assets.retro 写入（mock）', async () => {
    const up = await (await app.request('/api/projects/demo/upload-video', { method: 'POST', body: fakeVideoForm('take3.mp4') })).json() as any
    const rv = await (await app.request(`/api/assets/${up.assetId}/review`, { method: 'POST', body: '{}' })).json() as any
    await runTask(rv.taskId)
    const { taskId } = await (await app.request(`/api/assets/${up.assetId}/retro`, { method: 'POST' })).json() as any
    await runTask(taskId)
    const row: any = ctx.db.prepare('SELECT retro FROM assets WHERE id = ?').get(up.assetId)
    expect(JSON.parse(row.retro).focus.length).toBeGreaterThan(0)
  })
  it('未审片直接复盘 → 任务失败', async () => {
    const up = await (await app.request('/api/projects/demo/upload-video', { method: 'POST', body: fakeVideoForm('take4.mp4') })).json() as any
    const { taskId } = await (await app.request(`/api/assets/${up.assetId}/retro`, { method: 'POST' })).json() as any
    await expect(runTask(taskId)).rejects.toThrow(/先审片/)
  })
})
