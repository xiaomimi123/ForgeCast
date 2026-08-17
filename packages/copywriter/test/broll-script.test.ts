import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createLlmClient, loadConfig, openDb, type CoreCtx } from '@forgecast/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { generateProductIntroScript } from '../src/broll-script'

let ctx: CoreCtx
let root: string
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-broll-script-'))
  const config = loadConfig(root, {}) // llm mock
  ctx = { db: openDb(config.paths.db), config, llm: createLlmClient(config.llm) }
  ctx.db.prepare("INSERT INTO projects (slug, brand_name) VALUES ('demo', '快客通')").run()
})

function writeAnalysis(content = '## 谁掏钱\n中小老板\n\n## 痛点\n效率低') {
  const dir = path.join(root, 'workspace/demo')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'analysis.md'), content, 'utf8')
}

describe('generateProductIntroScript mock', () => {
  it('走固定 fixture，不调 ctx.llm，写文件+登记 assets 行', async () => {
    writeAnalysis()
    const spy = vi.spyOn(ctx.llm, 'complete')
    const r = await generateProductIntroScript(ctx, { slug: 'demo' })
    expect(spy).not.toHaveBeenCalled()
    expect(r.filePath).toBe('demo/broll/script.md')
    const md = fs.readFileSync(path.join(ctx.config.paths.workspace, r.filePath), 'utf8')
    expect(md).toContain('产品介绍解说词')
    const row: any = ctx.db.prepare('SELECT * FROM assets WHERE id = ?').get(r.assetId)
    expect(row.type).toBe('broll_script')
    expect(row.hook).toBeNull()
    expect(row.file_path).toBe('demo/broll/script.md')
  })
  it('项目不存在 → 抛错', async () => {
    await expect(generateProductIntroScript(ctx, { slug: 'nope' })).rejects.toThrow(/项目不存在/)
  })
  it('缺少 analysis.md → 抛错，提示先跑 analyze', async () => {
    await expect(generateProductIntroScript(ctx, { slug: 'demo' })).rejects.toThrow(/analysis\.md/)
  })
})

describe('generateProductIntroScript live（假 LLM）', () => {
  it('输出过短 → 抛错不落盘', async () => {
    writeAnalysis()
    const config = loadConfig(root, { FORGECAST_LLM_MODE: 'live', FORGECAST_LLM_KEY: 'k' })
    config.paths.templates = path.resolve(__dirname, '../../../templates')
    const lctx: CoreCtx = { db: ctx.db, config, llm: { complete: vi.fn(async () => '太短') } as any }
    await expect(generateProductIntroScript(lctx, { slug: 'demo' })).rejects.toThrow(/过短/)
    expect(ctx.db.prepare("SELECT COUNT(*) n FROM assets WHERE type='broll_script'").get()).toEqual({ n: 0 })
  })
  it('live 模式正常生成时，prompt 里注入 analysis.md 全文', async () => {
    writeAnalysis('## 谁掏钱\n特定测试标记ABC123')
    const config = loadConfig(root, { FORGECAST_LLM_MODE: 'live', FORGECAST_LLM_KEY: 'k' })
    config.paths.templates = path.resolve(__dirname, '../../../templates')
    const complete = vi.fn(async () => '# 产品介绍解说词\n' + 'x'.repeat(120))
    const lctx: CoreCtx = { db: ctx.db, config, llm: { complete } as any }
    await generateProductIntroScript(lctx, { slug: 'demo' })
    expect(complete.mock.calls[0][0].prompt).toContain('特定测试标记ABC123')
  })
})
