import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createLlmClient, loadConfig, openDb, type CoreCtx } from '@forgecast/core'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  addCapability, addRequest, deleteCapability, getRequestDetail,
  listRequests, requestFromLead, updateCapability,
} from '../src/requests'

let ctx: CoreCtx
beforeEach(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-tailor-'))
  const config = loadConfig(root, {})
  ctx = { db: openDb(config.paths.db), config, llm: createLlmClient(config.llm) }
})

describe('requests CRUD', () => {
  it('addRequest 落库 status=draft，listRequests 倒序', () => {
    const a = addRequest(ctx, { title: 'A', rawNeed: '需求A' })
    addRequest(ctx, { title: 'B', rawNeed: '需求B' })
    const rows = listRequests(ctx)
    expect(rows.length).toBe(2)
    expect(rows[0].title).toBe('B')
    expect(rows[1].id).toBe(a.id)
    expect(rows[1].status).toBe('draft')
  })
  it('title/rawNeed 为空抛错', () => {
    expect(() => addRequest(ctx, { title: ' ', rawNeed: 'x' })).toThrow()
    expect(() => addRequest(ctx, { title: 'x', rawNeed: '' })).toThrow()
  })
  it('getRequestDetail 不存在抛错；能力项带解析后的 keywords 与轮子(按分倒序)', () => {
    expect(() => getRequestDetail(ctx, 999)).toThrow(/不存在/)
    const { id } = addRequest(ctx, { title: 'A', rawNeed: 'n' })
    const cap = addCapability(ctx, id, { name: '登录', keywords: ['oauth', 'login'] })
    ctx.db.prepare("INSERT INTO tailor_wheels (capability_id, repo, url, score, score_detail, license_ok, stars) VALUES (?, 'a/lo', 'u', 40, '{}', 1, 10), (?, 'b/hi', 'u', 80, '{}', 1, 10)")
      .run(cap.id, cap.id)
    const d = getRequestDetail(ctx, id)
    expect(d.capabilities[0].keywords).toEqual(['oauth', 'login'])
    expect(d.capabilities[0].wheels.map((w) => w.repo)).toEqual(['b/hi', 'a/lo'])
  })
  it('updateCapability: decision=wheel 无 chosenRepo 抛错；带上则写入', () => {
    const { id } = addRequest(ctx, { title: 'A', rawNeed: 'n' })
    const cap = addCapability(ctx, id, { name: '登录', keywords: ['oauth'] })
    expect(() => updateCapability(ctx, cap.id, { decision: 'wheel' })).toThrow(/chosenRepo/)
    updateCapability(ctx, cap.id, { decision: 'wheel', chosenRepo: 'a/b' })
    const d = getRequestDetail(ctx, id)
    expect(d.capabilities[0].decision).toBe('wheel')
    expect(d.capabilities[0].chosen_repo).toBe('a/b')
  })
  it('deleteCapability 连带删轮子', () => {
    const { id } = addRequest(ctx, { title: 'A', rawNeed: 'n' })
    const cap = addCapability(ctx, id, { name: 'x', keywords: ['k'] })
    ctx.db.prepare("INSERT INTO tailor_wheels (capability_id, repo, url, score, score_detail) VALUES (?, 'a/b', 'u', 1, '{}')").run(cap.id)
    deleteCapability(ctx, cap.id)
    expect(getRequestDetail(ctx, id).capabilities.length).toBe(0)
    expect((ctx.db.prepare('SELECT COUNT(*) AS n FROM tailor_wheels').get() as any).n).toBe(0)
  })
})

describe('requestFromLead', () => {
  it('intent 为空抛错、不存在抛错、正常转入带 lead_id', () => {
    expect(() => requestFromLead(ctx, 999)).toThrow(/不存在/)
    ctx.db.prepare("INSERT INTO leads (wechat, intent) VALUES ('wx1', '')").run()
    ctx.db.prepare("INSERT INTO leads (wechat, intent) VALUES ('wx2', '想做个宠物店小程序')").run()
    expect(() => requestFromLead(ctx, 1)).toThrow(/intent/)
    const { id } = requestFromLead(ctx, 2)
    const d = getRequestDetail(ctx, id)
    expect(d.request.lead_id).toBe(2)
    expect(d.request.raw_need).toBe('想做个宠物店小程序')
  })
})
