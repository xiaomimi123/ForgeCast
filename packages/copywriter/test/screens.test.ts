import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createLlmClient, loadConfig, openDb, type CoreCtx } from '@forgecast/core'
import { beforeEach, describe, expect, it } from 'vitest'
import { buildScreenContext, generateDemoScreens, validateScreenHtml } from '../src/screens'

describe('validateScreenHtml', () => {
  it('含完整 <html>...</html> 且非空 → true', () => {
    expect(validateScreenHtml('<html><body>x</body></html>')).toBe(true)
    expect(validateScreenHtml('<!doctype html>\n<HTML><BODY>x</BODY></HTML>')).toBe(true) // 大小写不敏感
  })
  it('缺 </html>、或过短、或空 → false', () => {
    expect(validateScreenHtml('<html><body>x</body>')).toBe(false)
    expect(validateScreenHtml('hi')).toBe(false)
    expect(validateScreenHtml('')).toBe(false)
  })
})

let ctx: CoreCtx
let root: string
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-screens-'))
  const config = loadConfig(root, {}) // mock 模式
  ctx = { db: openDb(config.paths.db), config, llm: createLlmClient(config.llm) }
})

describe('buildScreenContext', () => {
  it('有 analysis.md → 取其目标买家画像/痛点清单首行', () => {
    ctx.db.prepare("INSERT INTO projects (slug, brand_name) VALUES ('demo', '快客通')").run()
    const dir = path.join(root, 'workspace/demo')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'analysis.md'), '## 目标买家画像\n- 主攻：中小商家\n\n## 痛点清单\n1. 回消息熬夜\n')
    const sctx = buildScreenContext(ctx, 'demo')
    expect(sctx.brandName).toBe('快客通')
    expect(sctx.targetUser).toBe('主攻：中小商家')
    expect(sctx.painPoint).toBe('回消息熬夜')
  })
  it('没有 analysis.md、有候选 intro_detail → 回退到 intro_detail', () => {
    ctx.db.prepare(
      "INSERT INTO candidates (repo, url, intro_detail) VALUES ('a/b', 'u', ?)",
    ).run(JSON.stringify({ targetUser: '连锁门店店长', painPoint: '库存对不上账', features: [], summary: '', rebrandIdea: '', generatedAt: '' }))
    const candId = (ctx.db.prepare("SELECT id FROM candidates WHERE repo='a/b'").get() as any).id
    ctx.db.prepare('INSERT INTO projects (slug, candidate_id) VALUES (?, ?)').run('demo2', candId)
    const sctx = buildScreenContext(ctx, 'demo2')
    expect(sctx.targetUser).toBe('连锁门店店长')
    expect(sctx.painPoint).toBe('库存对不上账')
  })
  it('都没有 → 通用兜底文案，不抛错；brand_name 为空则回退 slug', () => {
    ctx.db.prepare("INSERT INTO projects (slug) VALUES ('demo3')").run()
    const sctx = buildScreenContext(ctx, 'demo3')
    expect(sctx.brandName).toBe('demo3')
    expect(sctx.targetUser).not.toBe('')
    expect(sctx.painPoint).not.toBe('')
  })
})

describe('generateDemoScreens (mock 模式，真实 Playwright 渲染)', () => {
  it('产出 3 个固定文件名的 PNG，ok=3 failed=0', async () => {
    ctx.db.prepare("INSERT INTO projects (slug, brand_name) VALUES ('demo', '快客通')").run()
    const result = await generateDemoScreens(ctx, 'demo')
    expect(result.ok.sort()).toEqual(['ai-01-dashboard.png', 'ai-02-list.png', 'ai-03-detail.png'])
    expect(result.failed).toEqual([])
    const shotsDir = path.join(ctx.config.paths.workspace, 'demo', 'shots')
    for (const f of result.ok) expect(fs.existsSync(path.join(shotsDir, f))).toBe(true)
  }, 20000)
  it('重新生成会覆盖同名文件（不累加）', async () => {
    ctx.db.prepare("INSERT INTO projects (slug, brand_name) VALUES ('demo', '快客通')").run()
    await generateDemoScreens(ctx, 'demo')
    const shotsDir = path.join(ctx.config.paths.workspace, 'demo', 'shots')
    const before = fs.readdirSync(shotsDir).sort()
    await generateDemoScreens(ctx, 'demo')
    const after = fs.readdirSync(shotsDir).sort()
    expect(after).toEqual(before) // 文件名集合不变，说明是覆盖不是新增
  }, 30000)
  it('项目不存在 → 抛错', async () => {
    await expect(generateDemoScreens(ctx, 'nope')).rejects.toThrow(/项目不存在/)
  })
  it('进度回调收到三张的完成消息', async () => {
    ctx.db.prepare("INSERT INTO projects (slug, brand_name) VALUES ('demo', '快客通')").run()
    const logs: string[] = []
    await generateDemoScreens(ctx, 'demo', { onProgress: (m) => logs.push(m) })
    expect(logs.some((l) => l.includes('仪表盘'))).toBe(true)
    expect(logs.some((l) => l.includes('列表'))).toBe(true)
    expect(logs.some((l) => l.includes('详情'))).toBe(true)
  }, 20000)
})
