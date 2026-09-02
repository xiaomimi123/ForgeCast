import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createLlmClient, loadConfig, openDb, syncWorkspaceProjects, type CoreCtx } from '@forgecast/core'
import { beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/app'
import { createTaskQueue } from '../src/tasks'

let ctx: CoreCtx
let app: ReturnType<typeof createApp>
let queue: ReturnType<typeof createTaskQueue>

function wait(ms: number) { return new Promise((r) => setTimeout(r, ms)) }

beforeEach(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-cover-regen-'))
  const config = loadConfig(root, {})
  config.paths.templates = path.resolve(__dirname, '../../../templates')
  fs.mkdirSync(path.join(root, 'workspace/demo-project'), { recursive: true })
  fs.writeFileSync(path.join(root, 'workspace/demo-project/analysis.md'), '# 分析\n## 痛点清单\n- 熬夜回消息')
  ctx = { db: openDb(config.paths.db), config, llm: createLlmClient(config.llm) }
  syncWorkspaceProjects(ctx)
  queue = createTaskQueue()
  app = createApp(ctx, queue)
})

async function runTask(taskId: string) {
  for (let i = 0; i < 200; i++) {
    await wait(50)
    const t = queue.get(taskId)!
    if (t.status === 'done') return
    if (t.status === 'failed') throw new Error(t.events.at(-1)!.message)
  }
  throw new Error('任务超时')
}

async function generateOne(): Promise<any> {
  const res = await app.request('/api/projects/demo-project/copy', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hook: 'pain', n: 1, renderCovers: false }),
  })
  const { taskId } = await res.json() as any
  for (let i = 0; i < 100; i++) {
    await wait(30)
    const assets = await (await app.request('/api/projects/demo-project/assets')).json() as any[]
    const copy = assets.find((a) => a.type === 'copy')
    if (copy) return copy
  }
  throw new Error('生成超时')
}

/** 发一次重生封面并等任务跑完 */
async function regen(copyId: number, template = 'contrast') {
  const res = await app.request(`/api/assets/${copyId}/cover`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ template }),
  })
  expect(res.status).toBe(200)
  await runTask(((await res.json()) as any).taskId)
}

async function coverRows(): Promise<any[]> {
  const assets = await (await app.request('/api/projects/demo-project/assets')).json() as any[]
  return assets.filter((a) => a.type === 'cover')
}

describe('POST /api/assets/:id/cover', () => {
  it('id 不存在 → 404', async () => {
    expect((await app.request('/api/assets/999999/cover', { method: 'POST' })).status).toBe(404)
  })
  it('id 指向非 copy 类型素材 → 404', async () => {
    const info = ctx.db.prepare(
      "INSERT INTO assets (project_id, type, hook, file_path, warnings) VALUES (1, 'video', 'pain', 'x.mp4', '[]')",
    ).run()
    expect((await app.request(`/api/assets/${info.lastInsertRowid}/cover`, { method: 'POST' })).status).toBe(404)
  })
  it('id 是真实 copy 素材 → 真渲染出封面，文件走 copy 同词干（走真 Playwright，环境已装 chromium）', async () => {
    const copy = await generateOne()
    await regen(copy.id)
    const covers = await coverRows()
    expect(covers).toHaveLength(1)
    // 词干必须与 copy 一致：内容工位聚合（content-items.ts）就是靠它把封面挂到这条内容上
    const stem = (p: string) => p.split('/').pop()!.replace(/\.[^.]+$/, '')
    expect(stem(covers[0].file_path)).toBe(stem(copy.file_path))
    expect(fs.existsSync(path.join(ctx.config.paths.workspace, covers[0].file_path))).toBe(true)
  }, 20000)
  it('重复重生 → 覆盖同一文件、同一行，不再堆新 cover 行', async () => {
    const copy = await generateOne()
    await regen(copy.id)
    const first = (await coverRows())[0]
    const abs = path.join(ctx.config.paths.workspace, first.file_path)
    const before = fs.statSync(abs).mtimeMs
    await wait(20)
    await regen(copy.id, 'bigtext')
    const after = await coverRows()
    expect(after).toHaveLength(1)
    expect(after[0].id).toBe(first.id)
    expect(after[0].file_path).toBe(first.file_path)
    // 文件是就地覆盖的：路径不变但 mtime 前进（前端靠 content-items 的 ?v=<mtime> 破缓存）
    expect(fs.statSync(abs).mtimeMs).toBeGreaterThan(before)
  }, 40000)
})
