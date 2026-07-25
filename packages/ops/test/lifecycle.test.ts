import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createLlmClient, loadConfig, openDb, type CoreCtx } from '@forgecast/core'
import { beforeEach, describe, expect, it } from 'vitest'
import { addLead, approveAsset, deleteAsset, listLeads, publishAsset, recordPerf, registerClip } from '../src/lifecycle'

let ctx: CoreCtx
beforeEach(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-ops-'))
  const config = loadConfig(root, {})
  ctx = { db: openDb(config.paths.db), config, llm: createLlmClient(config.llm) }
  ctx.db.prepare("INSERT INTO projects (slug) VALUES ('demo')").run()
  ctx.db.prepare("INSERT INTO assets (project_id, type, hook, file_path, status) VALUES (1, 'copy', 'pain', 'demo/copy/a.md', 'approved')").run()
})

describe('publishAsset', () => {
  it('回填 status/published_at/platform/published_url', () => {
    publishAsset(ctx, 1, { platform: 'xhs', url: 'https://xhs/x' })
    const a: any = ctx.db.prepare('SELECT * FROM assets WHERE id = 1').get()
    expect(a.status).toBe('published')
    expect(a.published_at).toBeTruthy()
    expect(a.platform).toBe('xhs')
    expect(a.published_url).toBe('https://xhs/x')
  })
  it('素材不存在抛错', () => {
    expect(() => publishAsset(ctx, 999, { platform: 'xhs' })).toThrow(/素材不存在/)
  })
})

describe('registerClip', () => {
  it('登记 process video 素材(draft)', () => {
    const { id } = registerClip(ctx, { slug: 'demo', file: 'demo/raw/clip.mp4' })
    const a: any = ctx.db.prepare('SELECT * FROM assets WHERE id = ?').get(id)
    expect(a.type).toBe('video')
    expect(a.hook).toBe('process')
    expect(a.status).toBe('draft')
    expect(a.file_path).toBe('demo/raw/clip.mp4')
  })
  it('项目不存在抛错', () => {
    expect(() => registerClip(ctx, { slug: 'nope', file: 'x' })).toThrow(/项目不存在/)
  })
})

describe('approveAsset', () => {
  it('draft → approved', () => {
    ctx.db.prepare("INSERT INTO assets (project_id, type, hook, file_path, status) VALUES (1, 'copy', 'pain', 'demo/copy/b.md', 'draft')").run()
    approveAsset(ctx, 2)
    const a: any = ctx.db.prepare('SELECT status FROM assets WHERE id = 2').get()
    expect(a.status).toBe('approved')
  })
  it('不回退已发布', () => {
    publishAsset(ctx, 1, { platform: 'xhs' })
    approveAsset(ctx, 1)
    const a: any = ctx.db.prepare('SELECT status FROM assets WHERE id = 1').get()
    expect(a.status).toBe('published')
  })
  it('素材不存在抛错', () => {
    expect(() => approveAsset(ctx, 999)).toThrow(/素材不存在/)
  })
})

describe('recordPerf', () => {
  it('写 perf JSON', () => {
    recordPerf(ctx, 1, { views: 1000, likes: 50, leads: 3 })
    const a: any = ctx.db.prepare('SELECT perf FROM assets WHERE id = 1').get()
    const p = JSON.parse(a.perf)
    expect(p.views).toBe(1000)
    expect(p.leads).toBe(3)
  })
})

describe('addLead / listLeads', () => {
  it('登记询单并列出（带来源素材 hook）', () => {
    const { id } = addLead(ctx, { assetId: 1, wechat: 'wx123', intent: '想部署' })
    expect(id).toBeGreaterThan(0)
    const leads = listLeads(ctx)
    expect(leads).toHaveLength(1)
    expect(leads[0].wechat).toBe('wx123')
    expect(leads[0].hook).toBe('pain')
    expect(leads[0].slug).toBe('demo')
  })
  it('素材不存在抛错', () => {
    expect(() => addLead(ctx, { assetId: 999 })).toThrow(/素材不存在/)
  })
})

describe('deleteAsset', () => {
  it('删 DB 行 + 磁盘文件', () => {
    // 建一个 video 素材 + 真文件
    const rel = 'demo/videos/x.mp4'
    const abs = path.join(ctx.config.paths.workspace, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, 'fake')
    const info = ctx.db.prepare("INSERT INTO assets (project_id, type, hook, file_path, status) VALUES (1,'video','pain',?, 'draft')").run(rel)
    const id = Number(info.lastInsertRowid)
    deleteAsset(ctx, id)
    expect(ctx.db.prepare('SELECT id FROM assets WHERE id = ?').get(id)).toBeUndefined() // 行没了
    expect(fs.existsSync(abs)).toBe(false)                                                // 文件没了
  })
  it('文件已不在仍删行不崩', () => {
    const info = ctx.db.prepare("INSERT INTO assets (project_id, type, hook, file_path, status) VALUES (1,'video','pain','demo/videos/gone.mp4','draft')").run()
    const id = Number(info.lastInsertRowid)
    expect(() => deleteAsset(ctx, id)).not.toThrow()
    expect(ctx.db.prepare('SELECT id FROM assets WHERE id = ?').get(id)).toBeUndefined()
  })
  it('有关联询单 → 抛错，行与文件都不动', () => {
    const rel = 'demo/videos/y.mp4'; const abs = path.join(ctx.config.paths.workspace, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, 'fake')
    const info = ctx.db.prepare("INSERT INTO assets (project_id, type, hook, file_path, status) VALUES (1,'video','pain',?, 'draft')").run(rel)
    const id = Number(info.lastInsertRowid)
    ctx.db.prepare('INSERT INTO leads (asset_id, wechat) VALUES (?, ?)').run(id, 'wx1')
    expect(() => deleteAsset(ctx, id)).toThrow(/询单/)
    expect(ctx.db.prepare('SELECT id FROM assets WHERE id = ?').get(id)).toBeDefined() // 行还在
    expect(fs.existsSync(abs)).toBe(true)                                              // 文件还在
  })
  it('不存在的 id → 抛错', () => {
    expect(() => deleteAsset(ctx, 99999)).toThrow(/不存在/)
  })
})
