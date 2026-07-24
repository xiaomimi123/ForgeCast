import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'
import { createLlmClient, loadConfig, openDb, type CoreCtx } from '@forgecast/core'
import { beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/app'
import { createTaskQueue } from '../src/tasks'

let ctx: CoreCtx, app: ReturnType<typeof createApp>, root: string
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-cp-'))
  const config = loadConfig(root, { FORGECAST_VIDEO_MODE: 'stub', FORGECAST_BEAT_PYTHON: '/fake/py' })
  ctx = { db: openDb(config.paths.db), config, llm: createLlmClient(config.llm) }
  ctx.db.prepare("INSERT INTO projects (slug) VALUES ('demo')").run()
  fs.mkdirSync(path.join(root, 'workspace/demo/shots'), { recursive: true })
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]); const ihdr = Buffer.alloc(25)
  ihdr.writeUInt32BE(13, 0); ihdr.write('IHDR', 4); ihdr.writeUInt32BE(1080, 8); ihdr.writeUInt32BE(1920, 12)
  fs.writeFileSync(path.join(root, 'workspace/demo/shots/01.png'), Buffer.concat([sig, ihdr]))
  fs.mkdirSync(path.join(root, 'templates/bgm/tense'), { recursive: true })
  fs.writeFileSync(path.join(root, 'templates/bgm/tense/x.mp3'), 'fake')
  app = createApp(ctx, createTaskQueue())
})

describe('cutplan API', () => {
  it('GET 无方案 → null', async () => {
    expect(await (await app.request('/api/projects/demo/cutplan')).json()).toBeNull()
  })
  it('PUT 存盘 → GET 读回 → DELETE 删', async () => {
    const plan = { bgm: 'tense/x.mp3', grid: { t0: 0, T: 0.5, bpm: 120, strongBeats: [], duration: 24 }, cadence: 4, offsetSec: 0, cuts: [{ beat: 12, shot: 0 }] }
    expect((await app.request('/api/projects/demo/cutplan', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ plan }) })).status).toBe(200)
    const got = await (await app.request('/api/projects/demo/cutplan')).json() as any
    expect(got.cadence).toBe(4)
    expect(got.cuts[0].beat).toBe(12)
    expect((await app.request('/api/projects/demo/cutplan', { method: 'DELETE' })).status).toBe(200)
    expect(await (await app.request('/api/projects/demo/cutplan')).json()).toBeNull()
  })
  it('PUT 非法方案 → 400', async () => {
    expect((await app.request('/api/projects/demo/cutplan', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ plan: { bgm: 'x' } }) })).status).toBe(400)
  })
  it('PUT plan.bgm 路径穿越 → 400', async () => {
    const plan = { bgm: '../../../etc/hosts', grid: { t0: 0, T: 0.5, bpm: 120, strongBeats: [], duration: 24 }, cadence: 4, offsetSec: 0, cuts: [] }
    expect((await app.request('/api/projects/demo/cutplan', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ plan }) })).status).toBe(400)
  })
  it('analyze 无 beatPython → 400', async () => {
    ctx.config.video.beatPython = ''
    expect((await app.request('/api/projects/demo/cutplan/analyze', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(400)
  })
  it('analyze 无 shots → 400（beatPython 有，但无截图）', async () => {
    fs.rmSync(path.join(root, 'workspace/demo/shots'), { recursive: true })
    const res = await app.request('/api/projects/demo/cutplan/analyze', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    expect(res.status).toBe(400) // 顺序：beatPython 通过 → readShots 空 → 400；未触达 analyzeBeats，不 spawn
  })
  it('未知项目 → 404', async () => {
    expect((await app.request('/api/projects/nope/cutplan')).status).toBe(404)
  })
})
