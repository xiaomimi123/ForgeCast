import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createLlmClient, loadConfig, openDb, syncWorkspaceProjects, type CoreCtx } from '@forgecast/core'
import { describe, expect, it } from 'vitest'
import { createApp } from '../src/app'
import { buildContentItems } from '../src/content-items'
import { createTaskQueue } from '../src/tasks'

const copy = (id: number, fp = `s1/copy/pain-t-1-ab.md`) =>
  ({ id, type: 'copy', hook: 'pain', file_path: fp, status: 'draft', warnings: '[]' }) as never
const cover = (id: number, fp = `s1/covers/pain-t-1-ab.png`) =>
  ({ id, type: 'cover', hook: 'pain', file_path: fp, status: 'draft', warnings: '[]' }) as never
const video = (id: number, status = 'draft', specPath: string | null = `s1/specs/v${id}.json`) =>
  ({ id, type: 'video', origin: 'rendered', hook: 'pain', file_path: `s1/videos/v${id}.mp4`, status, warnings: '[]', spec_path: specPath }) as never
const linkSpec = (copyId: number) => () => ({ semantic: { sourceAssetId: copyId } })
const base = { readTitle: () => '标题一句话', slug: 's1', tasks: [] as never[] }

// 表驱动：〔场景 → 期望状态〕，正是仓库翻过四次车的那类映射，一张表收口
const CASES: Array<[string, Parameters<typeof buildContentItems>[0], string]> = [
  ['无 video', { ...base, assets: [copy(1)], readSpec: () => null }, 'script_ready'],
  ['渲染任务在跑', { ...base, assets: [copy(1)], readSpec: () => null,
    tasks: [{ id: 't', status: 'running', events: [{ ts: 1, type: 'log', message: '渲染 68%' }], meta: { kind: 'video', slug: 's1', sourceAssetId: 1 } } as never] }, 'rendering'],
  ['任务失败且无更新视频', { ...base, assets: [copy(1)], readSpec: () => null,
    tasks: [{ id: 't', status: 'failed', events: [{ ts: 1, type: 'error', message: '渲染崩了' }], meta: { kind: 'video', slug: 's1', sourceAssetId: 1 } } as never] }, 'failed'],
  ['video draft', { ...base, assets: [copy(1), video(9)], readSpec: linkSpec(1) }, 'review'],
  ['video approved', { ...base, assets: [copy(1), video(9, 'approved')], readSpec: linkSpec(1) }, 'approved'],
  ['失败后又渲成了新视频→按新视频算', { ...base, assets: [copy(1), video(9)], readSpec: linkSpec(1),
    tasks: [{ id: 't', status: 'failed', events: [], meta: { kind: 'video', slug: 's1', sourceAssetId: 1 } } as never] }, 'review'],
]
describe('状态派生（表驱动）', () => {
  it.each(CASES)('%s → %s', (_n, input, want) => {
    expect(buildContentItems(input)[0].status).toBe(want)
  })
})

describe('聚合', () => {
  it('cover 按同词干文件名关联', () => {
    const [item] = buildContentItems({ ...base, assets: [copy(1), cover(2)], readSpec: () => null })
    expect(item.cover?.assetId).toBe(2)
    expect(item.cover?.url).toBe('/files/s1/covers/pain-t-1-ab.png')
  })
  it('多条 video 取最新为 render，version=条数', () => {
    const [item] = buildContentItems({ ...base, assets: [copy(1), video(9), video(11)], readSpec: linkSpec(1) })
    expect(item.render?.assetId).toBe(11)
    expect(item.render?.version).toBe(2)
  })
  it('spec_path 为 null / readSpec 抛错 的 video 不关联也不炸', () => {
    const boom = () => { throw new Error('bad json') }
    const [item] = buildContentItems({ ...base, assets: [copy(1), video(9, 'draft', null), video(10)], readSpec: boom })
    expect(item.status).toBe('script_ready')
  })
  it('rendering 时 progress 取最后一个百分比', () => {
    const [item] = buildContentItems({ ...base, assets: [copy(1)], readSpec: () => null,
      tasks: [{ id: 't', status: 'running', events: [
        { ts: 1, type: 'log', message: '渲染 12%' }, { ts: 2, type: 'log', message: '渲染 68%' },
      ], meta: { kind: 'video', slug: 's1', sourceAssetId: 1 } } as never] })
    expect(item.progress).toBe(68)
  })
  it('upload 来源的 video 不进队列聚合（归成片库）', () => {
    const up = { ...video(9), origin: 'upload' } as never
    const [item] = buildContentItems({ ...base, assets: [copy(1), up], readSpec: linkSpec(1) })
    expect(item.status).toBe('script_ready')
  })
  it('seq 按 copy id 升序编号', () => {
    const items = buildContentItems({ ...base, assets: [copy(5), copy(3)], readSpec: () => null })
    expect(items.map((i) => [i.id, i.seq])).toEqual([[3, 1], [5, 2]])
  })
  it('failed 带上任务最后一条 error 消息', () => {
    const [item] = buildContentItems({ ...base, assets: [copy(1)], readSpec: () => null,
      tasks: [{ id: 't', status: 'failed', events: [{ ts: 1, type: 'error', message: '渲染崩了' }], meta: { kind: 'video', slug: 's1', sourceAssetId: 1 } } as never] })
    expect(item.error).toBe('渲染崩了')
  })
  it('title 读不到时回落文件名', () => {
    const [item] = buildContentItems({ ...base, readTitle: () => null, assets: [copy(1)], readSpec: () => null })
    expect(item.title).toBe('pain-t-1-ab.md')
  })
})

// —— 路由级：仿既有 assets 路由测试的建库方式 ——
describe('GET /api/projects/:slug/content-items', () => {
  it('返回一条 script_ready，标题取文案首行；未知项目 404', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-ci-'))
    const config = loadConfig(root, {})
    fs.mkdirSync(path.join(root, 'workspace/demo-project/copy'), { recursive: true })
    fs.writeFileSync(path.join(root, 'workspace/demo-project/copy/pain-t-1-ab.md'), '# 一句话标题\n正文')
    const ctx: CoreCtx = { db: openDb(config.paths.db), config, llm: createLlmClient(config.llm) }
    syncWorkspaceProjects(ctx)
    const project: any = ctx.db.prepare('SELECT id FROM projects WHERE slug = ?').get('demo-project')
    ctx.db.prepare("INSERT INTO assets (project_id, type, hook, file_path, warnings) VALUES (?, 'copy', 'pain', ?, '[]')")
      .run(project.id, 'demo-project/copy/pain-t-1-ab.md')
    const app = createApp(ctx, createTaskQueue())

    const items = await (await app.request('/api/projects/demo-project/content-items')).json() as any[]
    expect(items).toHaveLength(1)
    expect(items[0].status).toBe('script_ready')
    expect(items[0].seq).toBe(1)
    expect(items[0].title).toBe('一句话标题')
    expect((await app.request('/api/projects/nope/content-items')).status).toBe(404)
  })
})
