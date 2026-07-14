import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createLlmClient, loadConfig, openDb, type CoreCtx } from '@forgecast/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mockRebrand } from '../src/fixtures/rebrand-fixture'
import { rebrandPlan } from '../src/rebrand'

let ctx: CoreCtx
let root: string
function seed(slug: string, withAnalysis: boolean) {
  ctx.db.prepare('INSERT INTO projects (slug) VALUES (?)').run(slug)
  const dir = path.join(root, 'workspace', slug)
  fs.mkdirSync(path.join(dir, 'source'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'source', 'tree.txt'), 'src/\nDockerfile\nREADME.md')
  if (withAnalysis) fs.writeFileSync(path.join(dir, 'analysis.md'), '# demo 商业化分析\n## 换皮方向建议\n- 微信登录')
}
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-rb-'))
  const config = loadConfig(root, {})
  ctx = { db: openDb(config.paths.db), config, llm: createLlmClient(config.llm) }
})

describe('rebrandPlan mock', () => {
  it('有 analysis → 写出 7 段 rebrand-plan.md、slug 在标题、不调 ctx.llm', async () => {
    seed('chatwoot', true)
    const spy = vi.spyOn(ctx.llm, 'complete')
    const { path: rel } = await rebrandPlan(ctx, 'chatwoot')
    expect(rel).toBe(path.join('chatwoot', 'rebrand-plan.md'))
    const md = fs.readFileSync(path.join(ctx.config.paths.workspace, rel), 'utf8')
    expect(md).toMatch(/^# chatwoot 换皮改造清单/)
    expect(md).toContain('## 7. 合规自检')
    expect(spy).not.toHaveBeenCalled()
  })
  it('项目不存在 → 抛错', async () => {
    await expect(rebrandPlan(ctx, 'nope')).rejects.toThrow(/项目不存在/)
  })
  it('无 analysis.md → 抛错', async () => {
    seed('empty', false)
    await expect(rebrandPlan(ctx, 'empty')).rejects.toThrow(/analysis/)
  })
})

describe('rebrandPlan live', () => {
  it('调 LLM 合法 7 段 → 落盘；缺段 → 抛错不落盘', async () => {
    const config = loadConfig(root, { FORGECAST_LLM_MODE: 'live', FORGECAST_LLM_KEY: 'k' })
    config.paths.templates = path.resolve(__dirname, '../../../templates')
    const good = { complete: vi.fn(async () => mockRebrand('p', 'a', 't')) }
    const lctx: CoreCtx = { db: openDb(config.paths.db), config, llm: good as any }
    lctx.db.prepare("INSERT INTO projects (slug) VALUES ('p')").run()
    fs.mkdirSync(path.join(config.paths.workspace, 'p'), { recursive: true })
    fs.writeFileSync(path.join(config.paths.workspace, 'p', 'analysis.md'), 'a')
    await rebrandPlan(lctx, 'p')
    expect(good.complete).toHaveBeenCalledOnce()
    expect(fs.existsSync(path.join(config.paths.workspace, 'p', 'rebrand-plan.md'))).toBe(true)

    const bad = { complete: vi.fn(async () => '# x 换皮改造清单\n## 1. 品牌替换\n只有一段') }
    const bctx: CoreCtx = { db: openDb(config.paths.db), config, llm: bad as any }
    bctx.db.prepare("INSERT INTO projects (slug) VALUES ('bad')").run()
    fs.mkdirSync(path.join(config.paths.workspace, 'bad'), { recursive: true })
    fs.writeFileSync(path.join(config.paths.workspace, 'bad', 'analysis.md'), 'a')
    await expect(rebrandPlan(bctx, 'bad')).rejects.toThrow(/缺少段落/)
    expect(fs.existsSync(path.join(config.paths.workspace, 'bad', 'rebrand-plan.md'))).toBe(false)
  })
})
