import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createLlmClient, loadConfig, openDb, type CoreCtx } from '@forgecast/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { analyzeProject } from '../src/analyze'
import { mockAnalysis } from '../src/fixtures/analysis-fixture'

let ctx: CoreCtx
let root: string
function seedProject(slug: string, withSource: boolean) {
  ctx.db.prepare('INSERT INTO projects (slug) VALUES (?)').run(slug)
  if (withSource) {
    const dir = path.join(root, 'workspace', slug, 'source')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'README.md'), '一个开源客服系统，React + Docker。')
    fs.writeFileSync(path.join(dir, 'tree.txt'), 'Dockerfile\nREADME.md')
  }
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-an-'))
  const config = loadConfig(root, {}) // llm mock
  ctx = { db: openDb(config.paths.db), config, llm: createLlmClient(config.llm) }
})

describe('analyzeProject mock', () => {
  it('有 source → 写出 7 段 analysis.md、slug 在标题、不调 ctx.llm', async () => {
    seedProject('chatwoot', true)
    const spy = vi.spyOn(ctx.llm, 'complete')
    const { path: rel } = await analyzeProject(ctx, 'chatwoot')
    expect(rel).toBe(path.join('chatwoot', 'analysis.md'))
    const abs = path.join(ctx.config.paths.workspace, rel)
    const md = fs.readFileSync(abs, 'utf8')
    expect(md).toMatch(/^# chatwoot 商业化分析/)
    expect(md).toContain('## 钩子匹配')
    expect(spy).not.toHaveBeenCalled()
    const row = ctx.db.prepare('SELECT stage FROM projects WHERE slug = ?').get('chatwoot') as any
    expect(row.stage).toBe('rebranding')
  })
  it('项目不存在 → 抛错', async () => {
    await expect(analyzeProject(ctx, 'nope')).rejects.toThrow(/项目不存在/)
  })
  it('无 source/README.md → 抛错', async () => {
    seedProject('empty', false)
    await expect(analyzeProject(ctx, 'empty')).rejects.toThrow(/source/)
  })
})

describe('analyzeProject live', () => {
  it('调 LLM 返回合法 7 段 → 落盘', async () => {
    const config = loadConfig(root, { FORGECAST_LLM_MODE: 'live', FORGECAST_LLM_KEY: 'k' })
    config.paths.templates = path.resolve(__dirname, '../../../templates')
    const llm = { complete: vi.fn(async () => mockAnalysis('proj', 'x')) }
    const lctx: CoreCtx = { db: openDb(config.paths.db), config, llm: llm as any }
    lctx.db.prepare('INSERT INTO projects (slug) VALUES (?)').run('proj')
    const dir = path.join(config.paths.workspace, 'proj', 'source')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'README.md'), 'readme')
    await analyzeProject(lctx, 'proj')
    expect(llm.complete).toHaveBeenCalledOnce()
    expect(fs.existsSync(path.join(config.paths.workspace, 'proj', 'analysis.md'))).toBe(true)
  })
  it('LLM 返回缺段 → 抛错且不落盘', async () => {
    const config = loadConfig(root, { FORGECAST_LLM_MODE: 'live', FORGECAST_LLM_KEY: 'k' })
    config.paths.templates = path.resolve(__dirname, '../../../templates')
    const llm = { complete: vi.fn(async () => '# x 商业化分析\n## 一句话\n只有一段') }
    const lctx: CoreCtx = { db: openDb(config.paths.db), config, llm: llm as any }
    lctx.db.prepare('INSERT INTO projects (slug) VALUES (?)').run('bad')
    const dir = path.join(config.paths.workspace, 'bad', 'source')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'README.md'), 'readme')
    await expect(analyzeProject(lctx, 'bad')).rejects.toThrow(/缺少段落/)
    expect(fs.existsSync(path.join(config.paths.workspace, 'bad', 'analysis.md'))).toBe(false)
  })
})
