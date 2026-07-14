import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createLlmClient, loadConfig, openDb, type CoreCtx } from '@forgecast/core'
import { beforeEach, describe, expect, it } from 'vitest'
import { generateCopy } from '../src/generate'

let ctx: CoreCtx
let root: string

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-gen-'))
  const config = loadConfig(root, {}) // mock 模式
  // 测试用真实模板目录：模板资产在仓库根 templates/（与 loadConfig 的 <root>/templates 一致），
  // 从本测试文件 packages/copywriter/test/ 上溯三级即仓库根
  config.paths.templates = path.resolve(__dirname, '../../../templates')
  const db = openDb(config.paths.db)
  db.prepare("INSERT INTO projects (slug, target_buyer) VALUES ('demo-project', '中小电商卖家')").run()
  fs.mkdirSync(path.join(root, 'workspace/demo-project'), { recursive: true })
  fs.writeFileSync(path.join(root, 'workspace/demo-project/analysis.md'), '# 快客通 商业化分析\n## 痛点清单\n- 回消息熬夜')
  ctx = { db, config, llm: createLlmClient(config.llm) }
})

describe('generateCopy', () => {
  it('mock 模式产出 n 篇文案：落盘 + assets 登记 + 进度回调', async () => {
    const logs: string[] = []
    const out = await generateCopy(ctx, { slug: 'demo-project', hook: 'pain', n: 2, renderCovers: false, onProgress: (m) => logs.push(m) })
    const copies = out.filter((a) => a.type === 'copy')
    expect(copies).toHaveLength(2)
    for (const a of copies) {
      const abs = path.join(ctx.config.paths.workspace, a.filePath)
      expect(fs.existsSync(abs)).toBe(true)
      expect(fs.readFileSync(abs, 'utf8')).toContain('## 小红书正文')
      const row: any = ctx.db.prepare('SELECT * FROM assets WHERE id = ?').get(a.assetId)
      expect(row.type).toBe('copy')
      expect(row.hook).toBe('pain')
      expect(row.status).toBe('draft')
    }
    expect(logs.some((l) => l.includes('生成'))).toBe(true)
  })
  it('项目不存在时抛错', async () => {
    await expect(generateCopy(ctx, { slug: 'nope', hook: 'pain' })).rejects.toThrow(/项目不存在/)
  })
  it('缺 analysis.md 时抛错', async () => {
    ctx.db.prepare("INSERT INTO projects (slug) VALUES ('empty')").run()
    await expect(generateCopy(ctx, { slug: 'empty', hook: 'pain' })).rejects.toThrow(/analysis\.md/)
  })
  it('已 sync（有原子）时用检索原子、system 不再塞整包知识 dump', async () => {
    ctx.db.prepare("INSERT INTO knowledge_atoms (source, topic, content) VALUES ('dbskill','钩子','痛点要写现状成本，三选一量化')").run()
    let capturedSystem = ''
    let capturedPrompt = ''
    const real = ctx.llm.complete.bind(ctx.llm)
    ctx.llm.complete = async (req) => { capturedSystem = req.system ?? ''; capturedPrompt = req.prompt ?? ''; return real(req) }
    await generateCopy(ctx, { slug: 'demo-project', hook: 'pain', n: 1, renderCovers: false })
    // 整包 dump（templates/knowledge/hooks-basics.md）里的句子不应进 system
    expect(capturedSystem).not.toContain('前3秒决定完播')
    // 检索到的原子进入 prompt 的【方法论要点】
    expect(capturedPrompt).toContain('痛点要写现状成本')
  })
  it('未 sync（无原子）时回落整包知识 dump 进 system', async () => {
    let capturedSystem = ''
    const real = ctx.llm.complete.bind(ctx.llm)
    ctx.llm.complete = async (req) => { capturedSystem = req.system ?? ''; return real(req) }
    await generateCopy(ctx, { slug: 'demo-project', hook: 'pain', n: 1, renderCovers: false })
    expect(capturedSystem).toContain('前3秒决定完播')
  })
  it('同秒内连续两次生成不覆盖：文件名互异，两份文件都存在且内容都在', async () => {
    const out1 = await generateCopy(ctx, { slug: 'demo-project', hook: 'pain', n: 1, renderCovers: false })
    const out2 = await generateCopy(ctx, { slug: 'demo-project', hook: 'pain', n: 1, renderCovers: false })
    const path1 = out1[0].filePath
    const path2 = out2[0].filePath
    expect(path1).not.toBe(path2)
    const abs1 = path.join(ctx.config.paths.workspace, path1)
    const abs2 = path.join(ctx.config.paths.workspace, path2)
    expect(fs.existsSync(abs1)).toBe(true)
    expect(fs.existsSync(abs2)).toBe(true)
    expect(fs.readFileSync(abs1, 'utf8')).toContain('## 小红书正文')
    expect(fs.readFileSync(abs2, 'utf8')).toContain('## 小红书正文')
  })
})
