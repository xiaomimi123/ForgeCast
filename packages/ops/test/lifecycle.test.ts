import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createLlmClient, loadConfig, openDb, type CoreCtx } from '@forgecast/core'
import { beforeEach, describe, expect, it } from 'vitest'
import { addLead, approveAsset, listLeads, publishAsset, recordPerf } from '../src/lifecycle'

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
