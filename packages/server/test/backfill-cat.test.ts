import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'
import { createLlmClient, loadConfig, openDb, type CoreCtx } from '@forgecast/core'
import { beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/app'
import { createTaskQueue } from '../src/tasks'

let ctx: CoreCtx, app: ReturnType<typeof createApp>
beforeEach(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-bfc-'))
  ctx = { db: openDb(loadConfig(root, {}).paths.db), config: loadConfig(root, {}), llm: createLlmClient(loadConfig(root, {}).llm) }
  ctx.db.prepare("INSERT INTO candidates (repo,url,description,license_ok,score,score_detail,status) VALUES ('a/chat','u','live chat helpdesk',1,50,?, 'candidate')")
    .run(JSON.stringify({ rebrandCost: 10, techStack: [] })) // 缺 category
  app = createApp(ctx, createTaskQueue())
})

describe('POST /api/candidates/backfill-categories', () => {
  it('回填缺分类候选 → 返 {updated} 且 category 写入', async () => {
    const r = await (await app.request('/api/candidates/backfill-categories', { method: 'POST' })).json() as any
    expect(r.updated).toBe(1)
    const cat = JSON.parse((ctx.db.prepare("SELECT score_detail FROM candidates WHERE repo='a/chat'").get() as any).score_detail).category
    expect(cat).toBe('客服/IM')
  })
})
