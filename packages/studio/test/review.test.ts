import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { copyFixtures, createLlmClient, loadConfig, openDb, type CoreCtx } from '@forgecast/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { reviewVideo, type ReviewDeps } from '../src/review'

let ctx: CoreCtx
let root: string
const okDeps: ReviewDeps = {
  probe: async () => 30,
  runFfmpeg: async () => {},
  runTranscribe: async (args) => {
    fs.writeFileSync(args[2], JSON.stringify({
      ok: true, text: '接外包的兄弟这句话你熟不熟每个项目都从零搭', segments: [
        { start: 0.2, end: 2.5, text: '接外包的兄弟这句话你熟不熟' },
        { start: 3.0, end: 6.0, text: '每个项目都从零搭' },
      ],
    }))
  },
}
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-review-'))
  const config = loadConfig(root, { FORGECAST_ASR_PYTHON: '/fake/python' }) // llm mock；asrPython 配上让转写走 deps 替身
  ctx = { db: openDb(config.paths.db), config, llm: createLlmClient(config.llm) }
  ctx.db.prepare("INSERT INTO projects (slug) VALUES ('demo')").run()
  const copyDir = path.join(root, 'workspace/demo/copy')
  fs.mkdirSync(copyDir, { recursive: true })
  fs.writeFileSync(path.join(copyDir, 'pain-1.md'), copyFixtures.pain)
  ctx.db.prepare("INSERT INTO assets (project_id, type, hook, file_path) VALUES (1, 'copy', 'pain', 'demo/copy/pain-1.md')").run()
  const upDir = path.join(root, 'workspace/demo/uploads')
  fs.mkdirSync(upDir, { recursive: true })
  fs.writeFileSync(path.join(upDir, 'take1.mp4'), 'FAKE_MP4')
  ctx.db.prepare("INSERT INTO assets (project_id, type, file_path, origin) VALUES (1, 'video', 'demo/uploads/take1.mp4', 'upload')").run()
})
const videoId = () => (ctx.db.prepare("SELECT id FROM assets WHERE type='video'").get() as any).id

describe('reviewVideo mock', () => {
  it('全链路：转写成功 → 报告含 transcript/metrics、写 assets.review、不调 ctx.llm', async () => {
    const spy = vi.spyOn(ctx.llm, 'complete')
    const r = await reviewVideo(ctx, videoId(), { deps: okDeps })
    expect(spy).not.toHaveBeenCalled()
    expect(r.scores.overall).toBeGreaterThan(0)
    expect(r.suggestions.length).toBeGreaterThan(0)
    expect(r.transcript).toContain('接外包')
    expect(r.metrics.durationSec).toBe(30)
    expect(r.metrics.charsPerSec).toBeGreaterThan(0)
    expect(r.degraded).toBeUndefined()
    const row: any = ctx.db.prepare('SELECT review FROM assets WHERE id = ?').get(videoId())
    expect(JSON.parse(row.review).scores.overall).toBe(r.scores.overall)
  })
  it('转写失败 → degraded 降级但仍出报告', async () => {
    const r = await reviewVideo(ctx, videoId(), { deps: { ...okDeps, runTranscribe: async () => { throw new Error('boom') } } })
    expect(r.degraded).toMatch(/未转写/)
    expect(r.transcript).toBeUndefined()
    expect(r.scores.overall).toBeGreaterThan(0)
  })
  it('对照基准回落链：无 script 时用最新 copy 口播稿（scriptAssetId 字段缺省）', async () => {
    const r = await reviewVideo(ctx, videoId(), { deps: okDeps })
    expect(r.scriptAssetId).toBeUndefined()
  })
  it('有 script 素材时自动选中并记 scriptAssetId', async () => {
    const sDir = path.join(root, 'workspace/demo/scripts')
    fs.mkdirSync(sDir, { recursive: true })
    fs.writeFileSync(path.join(sDir, 's1.md'), '# 拍摄脚本')
    ctx.db.prepare("INSERT INTO assets (project_id, type, file_path) VALUES (1, 'script', 'demo/scripts/s1.md')").run()
    const r = await reviewVideo(ctx, videoId(), { deps: okDeps })
    expect(r.scriptAssetId).toBeTypeOf('number')
  })
  it('素材不存在/指定脚本不存在 → 抛错', async () => {
    await expect(reviewVideo(ctx, 9999, { deps: okDeps })).rejects.toThrow(/不存在/)
    await expect(reviewVideo(ctx, videoId(), { scriptAssetId: 9999, deps: okDeps })).rejects.toThrow(/不存在/)
  })
})

describe('reviewVideo live（假 LLM）', () => {
  it('LLM 输出非法（分数越界）→ 抛错且不写 review 列', async () => {
    const config = loadConfig(root, { FORGECAST_LLM_MODE: 'live', FORGECAST_LLM_KEY: 'k', FORGECAST_ASR_PYTHON: '/fake/python' })
    config.paths.templates = path.resolve(__dirname, '../../../templates')
    const lctx: CoreCtx = { db: ctx.db, config, llm: { complete: vi.fn(async () => JSON.stringify({ scores: { hook: 150, pacing: 1, fidelity: 1, cta: 1, overall: 1 }, suggestions: ['x'] })) } as any }
    await expect(reviewVideo(lctx, videoId(), { deps: okDeps })).rejects.toThrow(/非法/)
    const row: any = ctx.db.prepare('SELECT review FROM assets WHERE id = ?').get(videoId())
    expect(row.review).toBeNull()
  })
})
