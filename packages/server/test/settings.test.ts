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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-set-'))
  const config = loadConfig(root, {})
  ctx = { db: openDb(config.paths.db), config, llm: createLlmClient(config.llm) }
  app = createApp(ctx, createTaskQueue())
})

const J = (body: unknown) => ({ method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

describe('settings API', () => {
  it('GET 默认：无 key、mock 模式', async () => {
    const v = await (await app.request('/api/settings')).json() as any
    expect(v.llm.key_set).toBe(false)
    expect(v.llm.mode).toBe('mock')
    expect(v.llm).not.toHaveProperty('key') // 绝不回明文
  })

  it('PUT 存 key/模型/模式 → GET 打码回显，key 不外泄', async () => {
    await app.request('/api/settings', J({ llm_key: 'sk-secret-9999', llm_mode: 'live', model_copy: 'my-model' }))
    const v = await (await app.request('/api/settings')).json() as any
    expect(v.llm.key_set).toBe(true)
    expect(v.llm.key_masked).toBe('••••9999')
    expect(v.llm.mode).toBe('live')
    expect(v.llm.models.copy).toBe('my-model')
    expect(JSON.stringify(v)).not.toContain('sk-secret-9999') // 明文不出现
  })

  it('PUT 空 key = 保持原值（不清空）', async () => {
    await app.request('/api/settings', J({ llm_key: 'sk-keepme-1234' }))
    await app.request('/api/settings', J({ llm_key: '', model_copy: 'x' })) // 空 key + 改模型
    const v = await (await app.request('/api/settings')).json() as any
    expect(v.llm.key_set).toBe(true)
    expect(v.llm.key_masked).toBe('••••1234')
    expect(v.llm.models.copy).toBe('x')
  })

  it('PUT 后 refreshCtx 生效：填 live key 后 ctx.llm 切到 live（不再是 mock fixture）', async () => {
    await app.request('/api/settings', J({ llm_key: 'sk-live-0000', llm_mode: 'live', llm_base_url: 'http://127.0.0.1:9/v1' }))
    expect(ctx.config.llm.mode).toBe('live')
    expect(ctx.config.llm.apiKey).toBe('sk-live-0000')
  })

  it('GET 报告 effective 模式：env 配置的 live+key 不被误显示为 mock', async () => {
    ctx.config.llm.mode = 'live'; ctx.config.llm.apiKey = 'env-key-1234' // 模拟经 env 配置、未走 UI
    const v = await (await app.request('/api/settings')).json() as any
    expect(v.llm.mode).toBe('live')
    expect(v.llm.key_masked).toBe('••••1234')
  })

  it('PUT 纯空白 key = 保持原值（不被空格误抹）', async () => {
    await app.request('/api/settings', J({ llm_key: 'sk-keep-5678' }))
    await app.request('/api/settings', J({ llm_key: '   ' }))
    const v = await (await app.request('/api/settings')).json() as any
    expect(v.llm.key_set).toBe(true)
    expect(v.llm.key_masked).toBe('••••5678')
  })

  it('test-llm：mock 模式返回未发起真实请求', async () => {
    const r = await (await app.request('/api/settings/test-llm', { method: 'POST' })).json() as any
    expect(r.ok).toBe(false)
    expect(r.message).toContain('mock')
  })
})
