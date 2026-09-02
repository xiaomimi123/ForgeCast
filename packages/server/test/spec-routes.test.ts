import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'
import { createLlmClient, loadConfig, openDb, type CoreCtx } from '@forgecast/core'
import { beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/app'
import { createTaskQueue } from '../src/tasks'

let ctx: CoreCtx, app: ReturnType<typeof createApp>, root: string

const layer = (over: Partial<{ id: string; start: number; duration: number; track: number }> = {}) => ({
  id: over.id ?? 'l1', kind: 'text', from: null, overridden: false,
  start: over.start ?? 0, duration: over.duration ?? 3, track: over.track ?? 1,
  content: { kind: 'text', text: 'hi' }, style: {}, effects: [],
})

const validSpec = (videoId = 'deadbeef01') => ({
  version: 1, videoId, slug: 's1', template: 'flash', createdAt: '',
  semantic: { hook: null, sourceAssetId: null, sections: [] },
  canvas: { width: 1080, height: 1920 }, durationSec: 12,
  layers: [layer()],
  audio: { narration: null, bgm: null, beatGrid: null, captionsEnabled: false }, warnings: [],
})

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-spec-'))
  const config = loadConfig(root, { FORGECAST_VIDEO_MODE: 'stub' })
  ctx = { db: openDb(config.paths.db), config, llm: createLlmClient(config.llm) }
  ctx.db.prepare("INSERT INTO projects (slug) VALUES ('s1')").run()
  app = createApp(ctx, createTaskQueue())
})

function specPath(videoId: string) {
  return path.join(root, 'workspace/s1/specs', `${videoId}.json`)
}
function origPath(videoId: string) {
  return path.join(root, 'workspace/s1/specs', `${videoId}.orig.json`)
}

describe('spec 读写端点', () => {
  it('GET 不存在 → 404', async () => {
    const res = await app.request('/api/projects/s1/specs/deadbeef01')
    expect(res.status).toBe(404)
  })

  it('GET 读盘上 spec', async () => {
    fs.mkdirSync(path.dirname(specPath('deadbeef01')), { recursive: true })
    fs.writeFileSync(specPath('deadbeef01'), JSON.stringify(validSpec()))
    const res = await app.request('/api/projects/s1/specs/deadbeef01')
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.videoId).toBe('deadbeef01')
  })

  it('PUT 合法 spec → 200 且文件内容更新', async () => {
    fs.mkdirSync(path.dirname(specPath('deadbeef01')), { recursive: true })
    fs.writeFileSync(specPath('deadbeef01'), JSON.stringify(validSpec()))
    const updated = { ...validSpec(), durationSec: 20 }
    const res = await app.request('/api/projects/s1/specs/deadbeef01', {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(updated),
    })
    expect(res.status).toBe(200)
    expect((await res.json() as any).ok).toBe(true)
    const onDisk = JSON.parse(fs.readFileSync(specPath('deadbeef01'), 'utf8'))
    expect(onDisk.durationSec).toBe(20)
  })

  it('PUT 同 track 重叠 → 400 提到 track', async () => {
    const bad = { ...validSpec(), layers: [layer({ id: 'l1', start: 0, duration: 5, track: 1 }), layer({ id: 'l2', start: 3, duration: 5, track: 1 })] }
    const res = await app.request('/api/projects/s1/specs/deadbeef01', {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(bad),
    })
    expect(res.status).toBe(400)
    const body = await res.json() as any
    expect(body.error).toMatch(/track/)
  })

  it('PUT version !== 1 → 400', async () => {
    const bad = { ...validSpec(), version: 2 }
    const res = await app.request('/api/projects/s1/specs/deadbeef01', {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(bad),
    })
    expect(res.status).toBe(400)
  })

  it('PUT layers 缺字段 → 400', async () => {
    const bad = { ...validSpec(), layers: [{ id: 'l1', kind: 'text' }] }
    const res = await app.request('/api/projects/s1/specs/deadbeef01', {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(bad),
    })
    expect(res.status).toBe(400)
  })

  it('PUT start<0 或 duration<=0 → 400', async () => {
    const bad1 = { ...validSpec(), layers: [layer({ start: -1 })] }
    expect((await app.request('/api/projects/s1/specs/deadbeef01', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(bad1) })).status).toBe(400)
    const bad2 = { ...validSpec(), layers: [layer({ duration: 0 })] }
    expect((await app.request('/api/projects/s1/specs/deadbeef01', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(bad2) })).status).toBe(400)
  })

  it('videoId 带 ../ 编码 → 400，不触盘', async () => {
    const res = await app.request('/api/projects/s1/specs/' + encodeURIComponent('../x'))
    expect(res.status).toBe(400)
    // 不触盘：不应该在 workspace 之外产生任何文件（无法穷举，退化为确认没有抛出 500 / 未创建 s1 目录之外的东西）
    expect(fs.existsSync(path.join(root, 'workspace/x.json'))).toBe(false)
  })

  it('PUT 的 videoId 与路径不一致 → 400', async () => {
    const mismatched = validSpec('other-id')
    const res = await app.request('/api/projects/s1/specs/deadbeef01', {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(mismatched),
    })
    expect(res.status).toBe(400)
  })
})

describe('reset 端点', () => {
  it('有 orig → 还原并返回', async () => {
    fs.mkdirSync(path.dirname(specPath('deadbeef01')), { recursive: true })
    const orig = validSpec()
    fs.writeFileSync(origPath('deadbeef01'), JSON.stringify(orig))
    fs.writeFileSync(specPath('deadbeef01'), JSON.stringify({ ...orig, durationSec: 999 }))
    const res = await app.request('/api/projects/s1/specs/deadbeef01/reset', { method: 'POST' })
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.durationSec).toBe(12)
    const onDisk = JSON.parse(fs.readFileSync(specPath('deadbeef01'), 'utf8'))
    expect(onDisk.durationSec).toBe(12)
  })

  it('无 orig → 404 带说明', async () => {
    fs.mkdirSync(path.dirname(specPath('deadbeef01')), { recursive: true })
    fs.writeFileSync(specPath('deadbeef01'), JSON.stringify(validSpec()))
    const res = await app.request('/api/projects/s1/specs/deadbeef01/reset', { method: 'POST' })
    expect(res.status).toBe(404)
    const body = await res.json() as any
    expect(body.error).toMatch(/无生成快照/)
  })
})
