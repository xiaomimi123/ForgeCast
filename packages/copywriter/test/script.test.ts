import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { copyFixtures, createLlmClient, loadConfig, openDb, type CoreCtx } from '@forgecast/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { generateShootScript } from '../src/script'

let ctx: CoreCtx
let root: string
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-script-'))
  const config = loadConfig(root, {}) // llm mock
  ctx = { db: openDb(config.paths.db), config, llm: createLlmClient(config.llm) }
  ctx.db.prepare("INSERT INTO projects (slug, brand_name) VALUES ('demo', '快客通')").run()
  const copyDir = path.join(root, 'workspace/demo/copy')
  fs.mkdirSync(copyDir, { recursive: true })
  fs.writeFileSync(path.join(copyDir, 'pain-1.md'), copyFixtures.pain)
  ctx.db.prepare("INSERT INTO assets (project_id, type, hook, file_path) VALUES (1, 'copy', 'pain', 'demo/copy/pain-1.md')").run()
})

describe('generateShootScript mock', () => {
  it('从最新 copy 生成脚本文件+asset 行（type=script、hook 继承），不调 ctx.llm', async () => {
    const spy = vi.spyOn(ctx.llm, 'complete')
    const r = await generateShootScript(ctx, { slug: 'demo' })
    expect(spy).not.toHaveBeenCalled()
    expect(r.filePath).toMatch(/^demo\/scripts\/pain-.*\.md$/)
    const md = fs.readFileSync(path.join(ctx.config.paths.workspace, r.filePath), 'utf8')
    expect(md).toContain('拍摄脚本')
    expect(md).toContain('【0-3s 钩子】') // 口播稿原文段落搬进骨架
    const row: any = ctx.db.prepare('SELECT * FROM assets WHERE id = ?').get(r.assetId)
    expect(row.type).toBe('script')
    expect(row.hook).toBe('pain')
  })
  it('assetId 指定的 copy 不存在/不属于该项目 → 抛错', async () => {
    await expect(generateShootScript(ctx, { slug: 'demo', assetId: 999 })).rejects.toThrow(/文案/)
  })
  it('项目没有 copy → 抛错', async () => {
    ctx.db.prepare("INSERT INTO projects (slug) VALUES ('empty')").run()
    await expect(generateShootScript(ctx, { slug: 'empty' })).rejects.toThrow(/文案/)
  })
})

describe('generateShootScript live（假 LLM）', () => {
  it('输出过短 → 抛错不落盘', async () => {
    const config = loadConfig(root, { FORGECAST_LLM_MODE: 'live', FORGECAST_LLM_KEY: 'k' })
    config.paths.templates = path.resolve(__dirname, '../../../templates')
    const lctx: CoreCtx = { db: ctx.db, config, llm: { complete: vi.fn(async () => '太短') } as any }
    await expect(generateShootScript(lctx, { slug: 'demo' })).rejects.toThrow(/过短/)
    expect(ctx.db.prepare("SELECT COUNT(*) n FROM assets WHERE type='script'").get()).toEqual({ n: 0 })
  })
  it('mode 缺省 screen：prompt 注入「仅录屏+口播」硬约束；mode=live 注入实拍约束', async () => {
    const config = loadConfig(root, { FORGECAST_LLM_MODE: 'live', FORGECAST_LLM_KEY: 'k' })
    config.paths.templates = path.resolve(__dirname, '../../../templates')
    const complete = vi.fn(async () => '# 拍摄脚本\n' + 'x'.repeat(120))
    const lctx: CoreCtx = { db: ctx.db, config, llm: { complete } as any }
    await generateShootScript(lctx, { slug: 'demo' })
    expect(complete.mock.calls[0][0].prompt).toContain('仅有「录屏 + 口播配音」')
    expect(complete.mock.calls[0][0].prompt).toContain('不得出现真人出镜')
    await generateShootScript(lctx, { slug: 'demo', mode: 'live' })
    expect(complete.mock.calls[1][0].prompt).toContain('可真人出镜实拍')
  })
  it('非法 mode → 抛错', async () => {
    await expect(generateShootScript(ctx, { slug: 'demo', mode: 'bogus' as any })).rejects.toThrow(/非法拍摄条件/)
  })
  it('项目有带 retro 的成片 → 拍摄脚本 prompt 注入复盘块', async () => {
    ctx.db.prepare("INSERT INTO assets (project_id, type, file_path, origin, retro) VALUES (1, 'video', 'demo/uploads/a.mp4', 'upload', ?)")
      .run(JSON.stringify({ verdict: 'v', keep: ['k1'], change: ['c1'], focus: '改钩子', generatedAt: 'x', hadPerf: false }))
    const config = loadConfig(root, { FORGECAST_LLM_MODE: 'live', FORGECAST_LLM_KEY: 'k' })
    config.paths.templates = path.resolve(__dirname, '../../../templates')
    const complete = vi.fn(async () => '# 拍摄脚本\n' + 'x'.repeat(120))
    const lctx: CoreCtx = { db: ctx.db, config, llm: { complete } as any }
    await generateShootScript(lctx, { slug: 'demo' })
    expect(complete.mock.calls[0][0].prompt).toContain('【上一条复盘')
  })
})
