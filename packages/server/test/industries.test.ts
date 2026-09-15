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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-industries-'))
  const config = loadConfig(root, {})
  ctx = { db: openDb(config.paths.db), config, llm: createLlmClient(config.llm) }
  ctx.db.prepare("INSERT INTO projects (slug) VALUES ('demo')").run()
  app = createApp(ctx, createTaskQueue())
})

async function json(res: Response) { return res.json() as Promise<any> }

describe('行业 CRUD /api/industries', () => {
  it('GET 返回 seed 行业，keywordCount/generatedAt 无缓存时为 0/null', async () => {
    const list = await json(await app.request('/api/industries'))
    expect(list.length).toBeGreaterThan(0)
    const first = list[0]
    expect(first).toHaveProperty('id')
    expect(first).toHaveProperty('name')
    expect(first).toHaveProperty('note')
    expect(first).toHaveProperty('enabled')
    expect(first).toHaveProperty('sortOrder')
    expect(first.keywordCount).toBe(0)
    expect(first.generatedAt).toBeNull()
  })

  it('建 → 列 → 改 → 删', async () => {
    const created = await json(await app.request('/api/industries', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '宠物行业', note: '宠物店老板要管预约洗美、疫苗跟进' }),
    }))
    expect(typeof created.id).toBe('number')

    const list = await json(await app.request('/api/industries'))
    const found = list.find((r: any) => r.id === created.id)
    expect(found).toMatchObject({ name: '宠物行业', note: '宠物店老板要管预约洗美、疫苗跟进', enabled: true })

    const patched = await app.request(`/api/industries/${created.id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '宠物服务', enabled: false, sortOrder: 5 }),
    })
    expect(patched.status).toBe(200)
    const list2 = await json(await app.request('/api/industries'))
    const found2 = list2.find((r: any) => r.id === created.id)
    expect(found2).toMatchObject({ name: '宠物服务', enabled: false, sortOrder: 5 })

    const del = await app.request(`/api/industries/${created.id}`, { method: 'DELETE' })
    expect(del.status).toBe(200)
    const list3 = await json(await app.request('/api/industries'))
    expect(list3.find((r: any) => r.id === created.id)).toBeUndefined()
  })

  it('POST name 为空 → 400', async () => {
    const res = await app.request('/api/industries', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '' }),
    })
    expect(res.status).toBe(400)
  })

  it('POST 重名 → 400', async () => {
    const res = await app.request('/api/industries', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '资讯媒体' }),
    })
    expect(res.status).toBe(400)
  })

  it('PATCH 改名重名 → 400', async () => {
    const created = await json(await app.request('/api/industries', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '宠物行业2' }),
    }))
    const res = await app.request(`/api/industries/${created.id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '资讯媒体' }),
    })
    expect(res.status).toBe(400)
  })

  it('PATCH 不存在 → 404', async () => {
    const res = await app.request('/api/industries/999999', {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ note: 'x' }),
    })
    expect(res.status).toBe(404)
  })

  it('DELETE 不存在 → 404', async () => {
    const res = await app.request('/api/industries/999999', { method: 'DELETE' })
    expect(res.status).toBe(404)
  })

  it('删行业后 industry_queries 缓存行也没了（路由显式删，不依赖外键级联）', async () => {
    const created = await json(await app.request('/api/industries', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '资讯媒体2' }),
    }))
    const gen = await json(await app.request(`/api/industries/${created.id}/queries`, { method: 'POST' }))
    expect(Array.isArray(gen.keywords)).toBe(true)
    expect(gen.keywords.length).toBeGreaterThan(0)
    // 缓存已写入
    expect(ctx.db.prepare('SELECT * FROM industry_queries WHERE industry_id = ?').get(created.id)).toBeTruthy()

    await app.request(`/api/industries/${created.id}`, { method: 'DELETE' })
    expect(ctx.db.prepare('SELECT * FROM industry_queries WHERE industry_id = ?').get(created.id)).toBeUndefined()
  })

  it('POST /:id/queries 不存在 → 404', async () => {
    const res = await app.request('/api/industries/999999/queries', { method: 'POST' })
    expect(res.status).toBe(404)
  })

  it('POST /:id/queries 重新生成后 GET 列表 keywordCount/generatedAt 有值', async () => {
    const list0 = await json(await app.request('/api/industries'))
    const target = list0[0]
    await app.request(`/api/industries/${target.id}/queries`, { method: 'POST' })
    const list1 = await json(await app.request('/api/industries'))
    const found = list1.find((r: any) => r.id === target.id)
    expect(found.keywordCount).toBeGreaterThan(0)
    expect(typeof found.generatedAt).toBe('string')
  })
})

describe('选品触发 /api/scout 按行业', () => {
  it('industryIds 非数组 → 400', async () => {
    const res = await app.request('/api/scout', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ industryIds: 'nope' }),
    })
    expect(res.status).toBe(400)
  })

  it('industryIds 含非数字 → 400', async () => {
    const res = await app.request('/api/scout', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ industryIds: [1, 'x'] }),
    })
    expect(res.status).toBe(400)
  })

  it('industryIds 合法数字数组 → 200，返回 taskId', async () => {
    const res = await app.request('/api/scout', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ industryIds: [1, 2], limit: 1 }),
    })
    expect(res.status).toBe(200)
    const body = await json(res)
    expect(typeof body.taskId).toBe('string')
  })

  it('空 industryIds 数组 → 200（等价于全部启用行业）', async () => {
    const res = await app.request('/api/scout', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ industryIds: [], limit: 1 }),
    })
    expect(res.status).toBe(200)
  })
})
