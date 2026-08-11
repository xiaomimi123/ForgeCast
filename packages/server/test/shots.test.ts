import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createLlmClient, loadConfig, openDb, type CoreCtx } from '@forgecast/core'
import { beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/app'
import { createTaskQueue } from '../src/tasks'

let ctx: CoreCtx
let app: ReturnType<typeof createApp>
beforeEach(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-shots-'))
  const config = loadConfig(root, {})
  ctx = { db: openDb(config.paths.db), config, llm: createLlmClient(config.llm) }
  ctx.db.prepare("INSERT INTO projects (slug) VALUES ('demo')").run()
  app = createApp(ctx, createTaskQueue())
})

describe('shots 上传与列表', () => {
  it('上传 png → 200，列表里能看到；按文件名排序', async () => {
    const fd1 = new FormData()
    fd1.append('file', new File(['fake'], '02.png', { type: 'image/png' }))
    expect((await app.request('/api/projects/demo/shots', { method: 'POST', body: fd1 })).status).toBe(200)
    const fd2 = new FormData()
    fd2.append('file', new File(['fake'], '01.png', { type: 'image/png' }))
    expect((await app.request('/api/projects/demo/shots', { method: 'POST', body: fd2 })).status).toBe(200)
    const { files } = await (await app.request('/api/projects/demo/shots')).json() as any
    expect(files).toEqual(['01.png', '02.png'])
  })
  it('非法扩展名 → 400，不落盘', async () => {
    const fd = new FormData()
    fd.append('file', new File(['fake'], 'evil.exe', { type: 'application/octet-stream' }))
    const res = await app.request('/api/projects/demo/shots', { method: 'POST', body: fd })
    expect(res.status).toBe(400)
    const { files } = await (await app.request('/api/projects/demo/shots')).json() as any
    expect(files).toEqual([])
  })
  it('项目不存在 → 404', async () => {
    const fd = new FormData()
    fd.append('file', new File(['fake'], 'a.png', { type: 'image/png' }))
    expect((await app.request('/api/projects/nope/shots', { method: 'POST', body: fd })).status).toBe(404)
  })
  it('没上传过 → 列表为空数组', async () => {
    const { files } = await (await app.request('/api/projects/demo/shots')).json() as any
    expect(files).toEqual([])
  })
})
