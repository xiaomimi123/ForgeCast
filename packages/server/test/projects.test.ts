import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createLlmClient, loadConfig, openDb, syncWorkspaceProjects, type CoreCtx } from '@forgecast/core'
import { beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/app'
import { createTaskQueue } from '../src/tasks'

let ctx: CoreCtx

beforeEach(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-srv-'))
  const config = loadConfig(root, {})
  fs.mkdirSync(path.join(root, 'workspace/demo-project'), { recursive: true })
  fs.writeFileSync(path.join(root, 'workspace/demo-project/analysis.md'), '# 分析')
  ctx = { db: openDb(config.paths.db), config, llm: createLlmClient(config.llm) }
})

describe('projects API', () => {
  it('syncWorkspaceProjects 把目录 upsert 成项目，幂等', () => {
    syncWorkspaceProjects(ctx)
    syncWorkspaceProjects(ctx)
    const rows = ctx.db.prepare('SELECT * FROM projects').all()
    expect(rows).toHaveLength(1)
    expect((rows[0] as any).slug).toBe('demo-project')
  })
  it('GET /api/projects 列表；GET 详情带 analysisMd；PATCH 可改字段', async () => {
    syncWorkspaceProjects(ctx)
    const app = createApp(ctx, createTaskQueue())
    const list = await (await app.request('/api/projects')).json() as any[]
    expect(list).toHaveLength(1)
    const detail = await (await app.request('/api/projects/demo-project')).json() as any
    expect(detail.analysisMd).toContain('# 分析')
    const patched = await app.request('/api/projects/demo-project', {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ brand_name: '快客通', price_deploy: 1999 }),
    })
    expect(patched.status).toBe(200)
    const after = await (await app.request('/api/projects/demo-project')).json() as any
    expect(after.brand_name).toBe('快客通')
    expect(after.price_deploy).toBe(1999)
  })
  it('未知项目 404', async () => {
    const app = createApp(ctx, createTaskQueue())
    expect((await app.request('/api/projects/nope')).status).toBe(404)
  })
  it('项目列表附 analysis_summary；没有 analysis.md 时为空串', async () => {
    ctx.db.prepare("INSERT INTO projects (slug, brand_name, stage) VALUES ('demo', '演示', 'analysis')").run()
    const app = createApp(ctx, createTaskQueue())
    const before = await (await app.request('/api/projects')).json() as any[]
    expect(before.find((p) => p.slug === 'demo').analysis_summary).toEqual({ targetBuyer: '', painPoint: '' })

    const dir = path.join(ctx.config.paths.workspace, 'demo')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'analysis.md'),
      '## 目标买家画像\n- 主攻：中小商家\n\n## 痛点清单\n1. 效率低\n', 'utf8')

    const after = await (await app.request('/api/projects')).json() as any[]
    expect(after.find((p) => p.slug === 'demo').analysis_summary).toEqual({
      targetBuyer: '主攻：中小商家', painPoint: '效率低',
    })
  })
  it('analysis.md 路径不可读（被换成目录，读会 EISDIR）时列表仍 200，该项目 analysis_summary 为空串', async () => {
    ctx.db.prepare("INSERT INTO projects (slug, brand_name, stage) VALUES ('broken', '演示', 'analysis')").run()
    const dir = path.join(ctx.config.paths.workspace, 'broken')
    // 把 analysis.md 建成目录而非文件，模拟权限异常/TOCTOU 等导致 readFileSync 抛错的场景
    fs.mkdirSync(path.join(dir, 'analysis.md'), { recursive: true })

    const app = createApp(ctx, createTaskQueue())
    const res = await app.request('/api/projects')
    expect(res.status).toBe(200)
    const list = await res.json() as any[]
    expect(list.find((p) => p.slug === 'broken').analysis_summary).toEqual({ targetBuyer: '', painPoint: '' })
  })
  it('PATCH stage 非法值 → 400，库里不写脏值；合法值可写入', async () => {
    ctx.db.prepare("INSERT INTO projects (slug, stage) VALUES ('demo', 'analysis')").run()
    const app = createApp(ctx, createTaskQueue())
    const bad = await app.request('/api/projects/demo', {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ stage: 'xxx' }),
    })
    expect(bad.status).toBe(400)
    expect((ctx.db.prepare("SELECT stage FROM projects WHERE slug = 'demo'").get() as any).stage).toBe('analysis')

    const ok = await app.request('/api/projects/demo', {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ stage: 'producing' }),
    })
    expect(ok.status).toBe(200)
    expect((ctx.db.prepare("SELECT stage FROM projects WHERE slug = 'demo'").get() as any).stage).toBe('producing')
  })
  it('列表/详情附真实产物计数 counts（文案/视频/已发布/询单）', async () => {
    ctx.db.prepare("INSERT INTO projects (slug) VALUES ('demo')").run()
    const c1 = ctx.db.prepare(
      "INSERT INTO assets (project_id, type, hook, file_path, status) VALUES (1, 'copy', 'pain', 'demo/copy/a.md', 'published')",
    ).run()
    ctx.db.prepare(
      "INSERT INTO assets (project_id, type, hook, file_path, status) VALUES (1, 'copy', 'pain', 'demo/copy/b.md', 'draft')",
    ).run()
    ctx.db.prepare(
      "INSERT INTO assets (project_id, type, hook, file_path, status) VALUES (1, 'video', 'pain', 'demo/videos/a.mp4', 'draft')",
    ).run()
    ctx.db.prepare('INSERT INTO leads (asset_id, wechat) VALUES (?, ?)').run(Number(c1.lastInsertRowid), 'wx1')

    const app = createApp(ctx, createTaskQueue())
    const list = await (await app.request('/api/projects')).json() as any[]
    expect(list.find((p) => p.slug === 'demo').counts).toEqual({ copies: 2, videos: 1, published: 1, leads: 1 })

    const detail = await (await app.request('/api/projects/demo')).json() as any
    // 详情接口不需要 counts（列表已够看板用），只断言不因 JOIN 报错
    expect(detail.slug).toBe('demo')
  })
  it('无任何素材的项目 counts 全 0（不报错）', async () => {
    ctx.db.prepare("INSERT INTO projects (slug) VALUES ('empty')").run()
    const app = createApp(ctx, createTaskQueue())
    const list = await (await app.request('/api/projects')).json() as any[]
    expect(list.find((p) => p.slug === 'empty').counts).toEqual({ copies: 0, videos: 0, published: 0, leads: 0 })
  })
  it('立项继承：列表/详情带出候选的 intro_detail/score_detail', async () => {
    ctx.db.prepare(
      "INSERT INTO candidates (repo, url, intro_detail, score_detail) VALUES ('a/b', 'u', ?, ?)",
    ).run(
      JSON.stringify({ summary: '一句话简介', features: ['f1'], targetUser: '中小商家', painPoint: '效率低', rebrandIdea: '换皮建议', generatedAt: '2026-01-01' }),
      JSON.stringify({ targetBuyer: '中小商家', painPoint: '效率低', category: '其它' }),
    )
    const candId = (ctx.db.prepare("SELECT id FROM candidates WHERE repo = 'a/b'").get() as any).id
    ctx.db.prepare('INSERT INTO projects (slug, candidate_id) VALUES (?, ?)').run('inherited', candId)

    const app = createApp(ctx, createTaskQueue())
    const list = await (await app.request('/api/projects')).json() as any[]
    const row = list.find((p) => p.slug === 'inherited')
    expect(JSON.parse(row.intro_detail).targetUser).toBe('中小商家')
    expect(JSON.parse(row.score_detail).painPoint).toBe('效率低')

    const detail = await (await app.request('/api/projects/inherited')).json() as any
    expect(JSON.parse(detail.intro_detail).summary).toBe('一句话简介')
  })
  it('未立项自候选（candidate_id 为空）时 intro_detail/score_detail 为 null', async () => {
    ctx.db.prepare("INSERT INTO projects (slug) VALUES ('nocand')").run()
    const app = createApp(ctx, createTaskQueue())
    const list = await (await app.request('/api/projects')).json() as any[]
    const row = list.find((p) => p.slug === 'nocand')
    expect(row.intro_detail).toBeNull()
    expect(row.score_detail).toBeNull()
  })
})
