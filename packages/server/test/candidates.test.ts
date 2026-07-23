import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createLlmClient, loadConfig, openDb, type CoreCtx } from '@forgecast/core'
import { rescoreCandidate } from '@forgecast/scout'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../src/app'
import { createTaskQueue } from '../src/tasks'

// 只包一层 spy，行为不变：验证「候选不存在」时路由层是否真的调用了 rescoreCandidate，
// 而不是靠它抛出的错误文案反推状态码（app.ts 现在应在调用前就先查存在性并短路）。
vi.mock('@forgecast/scout', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@forgecast/scout')>()
  return { ...actual, rescoreCandidate: vi.fn(actual.rescoreCandidate) }
})

let ctx: CoreCtx
let app: ReturnType<typeof createApp>
let queue: ReturnType<typeof createTaskQueue>
function wait(ms: number) { return new Promise((r) => setTimeout(r, ms)) }

beforeEach(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-cand-'))
  const config = loadConfig(root, {})
  ctx = { db: openDb(config.paths.db), config, llm: createLlmClient(config.llm) }
  queue = createTaskQueue()
  app = createApp(ctx, queue)
})

async function runTask(taskId: string) {
  for (let i = 0; i < 100; i++) {
    await wait(20)
    const s = queue.get(taskId)!.status
    if (s === 'done') return
    if (s === 'failed') throw new Error(queue.get(taskId)!.events.at(-1)!.message)
  }
  throw new Error('任务超时')
}

describe('candidates API (mock)', () => {
  it('POST /api/scout → 候选入池 → GET 排序返回 → pick 立项出现在 projects', async () => {
    const { taskId } = await (await app.request('/api/scout', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    })).json() as any
    await runTask(taskId)

    const list = await (await app.request('/api/candidates')).json() as any[]
    expect(list.length).toBeGreaterThanOrEqual(4)
    expect(list[0].license_ok).toBe(1) // 可商用者排前

    const picked = await app.request('/api/candidates/pick', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo: 'chatwoot/chatwoot' }),
    })
    expect(picked.status).toBe(200)
    const { slug } = await picked.json() as any
    expect(slug).toBe('chatwoot')
    const projects = await (await app.request('/api/projects')).json() as any[]
    expect(projects.some((p) => p.slug === 'chatwoot')).toBe(true)
  })
  it('pick 缺 repo → 400；协议不过 → 400', async () => {
    const noRepo = await app.request('/api/candidates/pick', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    })
    expect(noRepo.status).toBe(400)
    // 先入池，再 pick GPL
    const { taskId } = await (await app.request('/api/scout', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    })).json() as any
    await runTask(taskId)
    const gpl = await app.request('/api/candidates/pick', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo: 'gpl-example/copyleft-tool' }),
    })
    expect(gpl.status).toBe(400)
  })
})

describe('rescore', () => {
  it('重新评分改写 score_detail 且幂等；模式随响应返回', async () => {
    const { taskId } = await (await app.request('/api/candidates/add', {
      method: 'POST', body: JSON.stringify({ url: 'https://github.com/chatwoot/chatwoot' }),
    })).json() as any
    await runTask(taskId)
    const row: any = ctx.db.prepare('SELECT id, score_detail FROM candidates WHERE repo = ?').get('chatwoot/chatwoot')

    const r = await app.request(`/api/candidates/${row.id}/rescore`, { method: 'POST' })
    expect(r.status).toBe(200)
    const body = await r.json() as any
    expect(body.ok).toBe(true)
    expect(body.mode).toBe('mock')

    const after: any = ctx.db.prepare('SELECT score_detail FROM candidates WHERE id = ?').get(row.id)
    expect(JSON.parse(after.score_detail).targetBuyer).toBe('') // mock 不编造
    expect(after.score_detail).toBe(row.score_detail) // mock 确定性评分 → 幂等
  })

  it('候选不存在返回 404', async () => {
    const r = await app.request('/api/candidates/9999/rescore', { method: 'POST' })
    expect(r.status).toBe(404)
  })

  it('候选不存在 → 404 由路由层存在性检查给出，不经过 rescoreCandidate（不依赖其抛错文案）', async () => {
    const callsBefore = vi.mocked(rescoreCandidate).mock.calls.length
    const countBefore = (ctx.db.prepare('SELECT COUNT(*) as n FROM candidates').get() as any).n

    const r = await app.request('/api/candidates/9999/rescore', { method: 'POST' })

    expect(r.status).toBe(404)
    // 核心断言：rescoreCandidate 根本没被调用 —— 404 是路由层短路给出的，
    // 与 rescoreCandidate 内部错误消息的具体措辞无关（改措辞不会让这个 404 失效）
    expect(vi.mocked(rescoreCandidate).mock.calls.length).toBe(callsBefore)
    const countAfter = (ctx.db.prepare('SELECT COUNT(*) as n FROM candidates').get() as any).n
    expect(countAfter).toBe(countBefore) // 没有产生任何 candidates 行变化
  })
})
