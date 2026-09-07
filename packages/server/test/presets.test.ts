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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-presets-'))
  const config = loadConfig(root, {})
  ctx = { db: openDb(config.paths.db), config, llm: createLlmClient(config.llm) }
  ctx.db.prepare("INSERT INTO projects (slug) VALUES ('demo')").run()
  app = createApp(ctx, createTaskQueue())
})

async function json(res: Response) { return res.json() as Promise<any> }

describe('风格预设 /api/style-presets', () => {
  it('建 → 列 → 删', async () => {
    const created = await json(await app.request('/api/style-presets', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'cta-red', layerKind: 'text', payload: { style: { color: '#ff0000' } } }),
    }))
    expect(typeof created.id).toBe('number')

    const list = await json(await app.request('/api/style-presets'))
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ id: created.id, name: 'cta-red', layerKind: 'text' })
    expect(list[0].payload).toEqual({ style: { color: '#ff0000' } })
    expect(typeof list[0].createdAt).toBe('string')

    const del = await app.request(`/api/style-presets/${created.id}`, { method: 'DELETE' })
    expect(del.status).toBe(200)
    expect(await json(await app.request('/api/style-presets'))).toHaveLength(0)
  })

  it('DELETE 不存在 → 404', async () => {
    const res = await app.request('/api/style-presets/999', { method: 'DELETE' })
    expect(res.status).toBe(404)
  })

  it('name 为空 → 400', async () => {
    const res = await app.request('/api/style-presets', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '', layerKind: 'text', payload: {} }),
    })
    expect(res.status).toBe(400)
  })

  it('重名 → 400', async () => {
    await app.request('/api/style-presets', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'dup', layerKind: 'text', payload: {} }),
    })
    const res = await app.request('/api/style-presets', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'dup', layerKind: 'image', payload: {} }),
    })
    expect(res.status).toBe(400)
  })

  it('layerKind 非四值之一 → 400', async () => {
    const res = await app.request('/api/style-presets', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'x', layerKind: 'video', payload: {} }),
    })
    expect(res.status).toBe(400)
  })

  it('payload 非对象 → 400', async () => {
    const res = await app.request('/api/style-presets', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'x', layerKind: 'text', payload: 'nope' }),
    })
    expect(res.status).toBe(400)
  })

  // body 是合法 JSON 的 `null`（不是解析失败）——.catch(() => ({})) 接不住，必须靠 `?? {}` 兜底，
  // 否则 body.name 在 null 上取值直接抛，500 而不是预期的 400。
  it('body 是 JSON null → 400（而非 500）', async () => {
    const res = await app.request('/api/style-presets', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: 'null',
    })
    expect(res.status).toBe(400)
  })

  it('body 是合法非 null 对象时不受 ?? {} 兜底影响，正常建成', async () => {
    const created = await json(await app.request('/api/style-presets', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'null-guard-ok', layerKind: 'text', payload: {} }),
    }))
    expect(typeof created.id).toBe('number')
  })
})

describe('版式模板 /api/layout-templates', () => {
  it('建 → 列 → 删', async () => {
    const created = await json(await app.request('/api/layout-templates', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'flash-classic', template: 'flash', payload: [{ role: 'hookT#0', style: {}, effects: [] }] }),
    }))
    expect(typeof created.id).toBe('number')

    const list = await json(await app.request('/api/layout-templates'))
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ id: created.id, name: 'flash-classic', template: 'flash', ratio: 'portrait' })
    expect(list[0].payload).toEqual([{ role: 'hookT#0', style: {}, effects: [] }])

    const del = await app.request(`/api/layout-templates/${created.id}`, { method: 'DELETE' })
    expect(del.status).toBe(200)
    expect(await json(await app.request('/api/layout-templates'))).toHaveLength(0)
  })

  it('DELETE 不存在 → 404', async () => {
    const res = await app.request('/api/layout-templates/999', { method: 'DELETE' })
    expect(res.status).toBe(404)
  })

  it('重名 → 400', async () => {
    await app.request('/api/layout-templates', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'dup', template: 'flash', payload: [] }),
    })
    const res = await app.request('/api/layout-templates', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'dup', template: 'story', payload: [] }),
    })
    expect(res.status).toBe(400)
  })

  it('template 非六值之一 → 400', async () => {
    const res = await app.request('/api/layout-templates', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'x', template: 'custom-1', payload: [] }),
    })
    expect(res.status).toBe(400)
  })

  it('畸形 payload（非数组）→ 400', async () => {
    const res = await app.request('/api/layout-templates', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'x', template: 'flash', payload: { not: 'array' } }),
    })
    expect(res.status).toBe(400)
  })

  it('ratio 可指定 landscape', async () => {
    const created = await json(await app.request('/api/layout-templates', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'flash-wide', template: 'flash', ratio: 'landscape', payload: [] }),
    }))
    const list = await json(await app.request('/api/layout-templates'))
    expect(list.find((r: any) => r.id === created.id).ratio).toBe('landscape')
  })

  // 同 style-presets：body 是合法 JSON 的 `null` 时 `.catch(() => ({}))` 接不住，须靠 `?? {}` 兜底。
  it('body 是 JSON null → 400（而非 500）', async () => {
    const res = await app.request('/api/layout-templates', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: 'null',
    })
    expect(res.status).toBe(400)
  })

  it('body 是合法非 null 对象时不受 ?? {} 兜底影响，正常建成', async () => {
    const created = await json(await app.request('/api/layout-templates', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'null-guard-ok', template: 'flash', payload: [] }),
    }))
    expect(typeof created.id).toBe('number')
  })
})

describe('品牌 kit /api/projects/:slug/brand-kit', () => {
  it('GET 无值 → {}', async () => {
    const res = await app.request('/api/projects/demo/brand-kit')
    expect(res.status).toBe(200)
    expect(await json(res)).toEqual({})
  })

  it('GET 项目不存在 → 404', async () => {
    const res = await app.request('/api/projects/nope/brand-kit')
    expect(res.status).toBe(404)
  })

  it('PUT 合法值 → 200，回读一致', async () => {
    const kit = { primaryColor: '#112233', accentColor: '#aabbcc', titleScale: 1.2, ctaText: '立即体验' }
    const put = await app.request('/api/projects/demo/brand-kit', {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(kit),
    })
    expect(put.status).toBe(200)
    const get = await app.request('/api/projects/demo/brand-kit')
    expect(await json(get)).toEqual(kit)
  })

  it('PUT 部分字段也合法', async () => {
    const res = await app.request('/api/projects/demo/brand-kit', {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ titleScale: 1 }),
    })
    expect(res.status).toBe(200)
  })

  it('PUT 色值越界 → 400', async () => {
    const res = await app.request('/api/projects/demo/brand-kit', {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ primaryColor: 'red' }),
    })
    expect(res.status).toBe(400)
  })

  it('PUT titleScale 越界（>2）→ 400', async () => {
    const res = await app.request('/api/projects/demo/brand-kit', {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ titleScale: 3 }),
    })
    expect(res.status).toBe(400)
  })

  it('PUT titleScale 越界（<0.5）→ 400', async () => {
    const res = await app.request('/api/projects/demo/brand-kit', {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ titleScale: 0.4 }),
    })
    expect(res.status).toBe(400)
  })

  it('PUT ctaText 超过 60 字符 → 400', async () => {
    const res = await app.request('/api/projects/demo/brand-kit', {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ctaText: 'x'.repeat(61) }),
    })
    expect(res.status).toBe(400)
  })

  it('PUT 未知键 → 400', async () => {
    const res = await app.request('/api/projects/demo/brand-kit', {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ foo: 'bar' }),
    })
    expect(res.status).toBe(400)
  })

  it('PUT 项目不存在 → 404', async () => {
    const res = await app.request('/api/projects/nope/brand-kit', {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
    })
    expect(res.status).toBe(404)
  })
})

describe('POST /api/projects/:slug/video body.layoutTemplateId', () => {
  it('非 number → 400', async () => {
    const res = await app.request('/api/projects/demo/video', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ layoutTemplateId: 'nope' }),
    })
    expect(res.status).toBe(400)
  })

  it('查无 → 404', async () => {
    const res = await app.request('/api/projects/demo/video', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ layoutTemplateId: 999 }),
    })
    expect(res.status).toBe(404)
  })

  it('模板不匹配当前出片 tpl → 400', async () => {
    const created = await json(await app.request('/api/layout-templates', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'story-tpl', template: 'story', payload: [] }),
    }))
    // 默认出片 tpl 是 flash（不传 tpl），版式模板套的是 story，不匹配
    const res = await app.request('/api/projects/demo/video', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ layoutTemplateId: created.id }),
    })
    expect(res.status).toBe(400)
  })

  it('版式画幅是 landscape，出片 ratio 缺省 portrait → 400', async () => {
    const created = await json(await app.request('/api/layout-templates', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'flash-landscape-tpl', template: 'flash', ratio: 'landscape', payload: [] }),
    }))
    // tpl 缺省回落 flash（与模板一致），ratio 缺省回落 portrait，与版式的 landscape 不匹配
    const res = await app.request('/api/projects/demo/video', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ layoutTemplateId: created.id }),
    })
    expect(res.status).toBe(400)
  })

  it('版式画幅与出片 ratio 都是 landscape → 通过画幅校验（不再 400）', async () => {
    const created = await json(await app.request('/api/layout-templates', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'flash-landscape-tpl-2', template: 'flash', ratio: 'landscape', payload: [] }),
    }))
    const res = await app.request('/api/projects/demo/video', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ layoutTemplateId: created.id, ratio: 'landscape' }),
    })
    expect(res.status).not.toBe(400)
  })
})
