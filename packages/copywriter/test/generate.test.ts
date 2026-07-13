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
})
