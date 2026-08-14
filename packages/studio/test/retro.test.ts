import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createLlmClient, loadConfig, openDb, type CoreCtx } from '@forgecast/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { generateRetro } from '../src/retro'

let ctx: CoreCtx
let root: string
const REVIEW = JSON.stringify({
  scores: { hook: 70, pacing: 65, fidelity: 75, cta: 60, overall: 68 },
  suggestions: ['前3秒直接抛痛点'], transcript: '接外包的兄弟这句话你熟不熟',
  metrics: { durationSec: 30, charCount: 12, charsPerSec: 0.4 }, reviewedAt: '2026-08-14T00:00:00Z',
})
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-retro-'))
  const config = loadConfig(root, {}) // llm mock
  ctx = { db: openDb(config.paths.db), config, llm: createLlmClient(config.llm) }
  ctx.db.prepare("INSERT INTO projects (slug) VALUES ('demo')").run()
  ctx.db.prepare("INSERT INTO assets (project_id, type, file_path, origin, review) VALUES (1, 'video', 'demo/uploads/a.mp4', 'upload', ?)").run(REVIEW)
})
const vid = () => (ctx.db.prepare("SELECT id FROM assets WHERE type='video'").get() as any).id

describe('generateRetro mock', () => {
  it('全链路：写 assets.retro、hadPerf=false（无 perf）、不调 ctx.llm', async () => {
    const spy = vi.spyOn(ctx.llm, 'complete')
    const r = await generateRetro(ctx, vid())
    expect(spy).not.toHaveBeenCalled()
    expect(r.verdict.length).toBeGreaterThan(0)
    expect(r.keep.length).toBeGreaterThan(0)
    expect(r.change.length).toBeGreaterThan(0)
    expect(r.focus.length).toBeGreaterThan(0)
    expect(r.hadPerf).toBe(false)
    const row: any = ctx.db.prepare('SELECT retro FROM assets WHERE id = ?').get(vid())
    expect(JSON.parse(row.retro).focus).toBe(r.focus)
  })
  it('有 perf → hadPerf=true', async () => {
    ctx.db.prepare("UPDATE assets SET perf = ? WHERE id = ?")
      .run(JSON.stringify({ views: 1200, likes: 40, leads: 2, recordedAt: '2026-08-14' }), vid())
    const r = await generateRetro(ctx, vid())
    expect(r.hadPerf).toBe(true)
  })
  it('无 review → 抛错提示先审片；素材不存在 → 抛错', async () => {
    ctx.db.prepare("INSERT INTO assets (project_id, type, file_path, origin) VALUES (1, 'video', 'demo/uploads/b.mp4', 'upload')").run()
    const noReview = (ctx.db.prepare("SELECT id FROM assets WHERE review IS NULL AND type='video'").get() as any).id
    await expect(generateRetro(ctx, noReview)).rejects.toThrow(/先审片/)
    await expect(generateRetro(ctx, 9999)).rejects.toThrow(/不存在/)
  })
})

describe('generateRetro live（假 LLM）', () => {
  function liveCtx(out: string): CoreCtx {
    const config = loadConfig(root, { FORGECAST_LLM_MODE: 'live', FORGECAST_LLM_KEY: 'k' })
    config.paths.templates = path.resolve(__dirname, '../../../templates')
    return { db: ctx.db, config, llm: { complete: vi.fn(async () => out) } as any }
  }
  it('合法输出 → 落库', async () => {
    const r = await generateRetro(liveCtx(JSON.stringify({ verdict: '钩子偏弱', keep: ['节奏'], change: ['前3秒'], focus: '改钩子' })), vid())
    expect(r.verdict).toBe('钩子偏弱')
  })
  it('缺 focus → 整批抛错不写列', async () => {
    await expect(generateRetro(liveCtx(JSON.stringify({ verdict: 'x', keep: ['a'], change: ['b'] })), vid())).rejects.toThrow(/非法/)
    const row: any = ctx.db.prepare('SELECT retro FROM assets WHERE id = ?').get(vid())
    expect(row.retro).toBeNull()
  })
})
