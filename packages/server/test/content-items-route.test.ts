import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createLlmClient, loadConfig, openDb, syncWorkspaceProjects, type CoreCtx } from '@forgecast/core'
import { describe, expect, it } from 'vitest'
import { createApp } from '../src/app'
import { createTaskQueue } from '../src/tasks'

// 真装配：workspace 里落真 copy.md / cover.png / spec.json，走真实的 abs()/readTitle/readSpec/statVersion 注入。
// P0 终审 M-5 点名：这三处真实注入此前零覆盖——13 包全绿的情况下 abs() 或 JSON.parse 改坏都测不出来。
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-ci-route-'))
  const config = loadConfig(root, {})
  fs.mkdirSync(path.join(root, 'workspace/s1/copy'), { recursive: true })
  fs.mkdirSync(path.join(root, 'workspace/s1/covers'), { recursive: true })
  fs.mkdirSync(path.join(root, 'workspace/s1/specs'), { recursive: true })
  const ctx: CoreCtx = { db: openDb(config.paths.db), config, llm: createLlmClient(config.llm) }
  syncWorkspaceProjects(ctx)
  return { root, config, ctx }
}

function project(ctx: CoreCtx, slug: string) {
  return ctx.db.prepare('SELECT id FROM projects WHERE slug = ?').get(slug) as any
}

function insertAsset(ctx: CoreCtx, projectId: number, row: { type: string; hook: string; file_path: string; spec_path?: string | null }) {
  const info = ctx.db.prepare(
    "INSERT INTO assets (project_id, type, hook, file_path, status, warnings, spec_path) VALUES (?, ?, ?, ?, 'draft', '[]', ?)",
  ).run(projectId, row.type, row.hook, row.file_path, row.spec_path ?? null)
  return info.lastInsertRowid as number
}

describe('GET /api/projects/:slug/content-items —— 真装配', () => {
  it('真文件装配：cover.url 带 ?v=、render 关联、标题来自 md 首行', async () => {
    const { root, ctx } = setup()
    fs.writeFileSync(path.join(root, 'workspace/s1/copy/pain-t-1-ab.md'), '# 真标题\n正文')
    fs.writeFileSync(path.join(root, 'workspace/s1/covers/pain-t-1-ab.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))

    const p = project(ctx, 's1')
    const copyId = insertAsset(ctx, p.id, { type: 'copy', hook: 'pain', file_path: 's1/copy/pain-t-1-ab.md' })
    insertAsset(ctx, p.id, { type: 'cover', hook: 'pain', file_path: 's1/covers/pain-t-1-ab.png' })

    fs.writeFileSync(path.join(root, 'workspace/s1/specs/v1.json'), JSON.stringify({ semantic: { sourceAssetId: copyId } }))
    insertAsset(ctx, p.id, { type: 'video', hook: 'pain', file_path: 's1/videos/v1.mp4', spec_path: 's1/specs/v1.json' })
    // origin 列不在 insertAsset 白名单里，直接补上，确保它被视为 rendered（走队列聚合），而非 upload（归片库）
    ctx.db.prepare("UPDATE assets SET origin = 'rendered' WHERE project_id = ? AND type = 'video'").run(p.id)

    const app = createApp(ctx, createTaskQueue())
    const res = await app.request('/api/projects/s1/content-items')
    expect(res.status).toBe(200)
    const [item] = await res.json() as any[]
    expect(item.title).toBe('真标题')
    expect(item.cover.url).toMatch(/^\/files\/s1\/covers\/pain-t-1-ab\.png\?v=\d+(\.\d+)?$/)
    expect(item.render.version).toBe(1)
    expect(item.status).toBe('review')
  })

  it('spec.json 是坏 JSON → 不炸、video 不关联（fail-soft 走真实 catch）', async () => {
    const { root, ctx } = setup()
    fs.writeFileSync(path.join(root, 'workspace/s1/copy/pain-t-1-ab.md'), '# 真标题\n正文')
    fs.writeFileSync(path.join(root, 'workspace/s1/covers/pain-t-1-ab.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))

    const p = project(ctx, 's1')
    insertAsset(ctx, p.id, { type: 'copy', hook: 'pain', file_path: 's1/copy/pain-t-1-ab.md' })
    insertAsset(ctx, p.id, { type: 'cover', hook: 'pain', file_path: 's1/covers/pain-t-1-ab.png' })

    fs.writeFileSync(path.join(root, 'workspace/s1/specs/v1.json'), 'not json')
    insertAsset(ctx, p.id, { type: 'video', hook: 'pain', file_path: 's1/videos/v1.mp4', spec_path: 's1/specs/v1.json' })
    ctx.db.prepare("UPDATE assets SET origin = 'rendered' WHERE project_id = ? AND type = 'video'").run(p.id)

    const app = createApp(ctx, createTaskQueue())
    const res = await app.request('/api/projects/s1/content-items')
    expect(res.status).toBe(200)
    const [item] = await res.json() as any[]
    expect(item.status).toBe('script_ready')
  })
})
