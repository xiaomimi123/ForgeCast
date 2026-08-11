import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createLlmClient, loadConfig, openDb, type CoreCtx } from '@forgecast/core'
import { beforeEach, describe, expect, it } from 'vitest'
import { buildCoverHtml, imageToDataUri, pickRawShot, regenerateCover } from '../src/cover'
import { generateCopy } from '../src/generate'

const tplDir = path.resolve(__dirname, '../../../templates/covers')
// 最小合法 1×1 PNG
const PNG1x1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64')

describe('buildCoverHtml', () => {
  it('填槽并转义 HTML', () => {
    const tpl = fs.readFileSync(path.join(tplDir, 'bigtext.html'), 'utf8')
    const html = buildCoverHtml(tpl, { main: '网店客服<还>在手动回?', sub: '一套系统 & 三人份' })
    expect(html).toContain('网店客服&lt;还&gt;在手动回?')
    expect(html).toContain('一套系统 &amp; 三人份')
    expect(html).not.toContain('{{main}}')
    expect(html).not.toContain('{{sub}}')
  })
  it('三套模板都有两个槽位', () => {
    for (const f of ['bigtext.html', 'annotate.html', 'contrast.html']) {
      const tpl = fs.readFileSync(path.join(tplDir, f), 'utf8')
      expect(tpl, f).toContain('{{main}}')
      expect(tpl, f).toContain('{{sub}}')
    }
  })
  it('annotate 有截图槽 {{shot}}，填入 shot', () => {
    const tpl = fs.readFileSync(path.join(tplDir, 'annotate.html'), 'utf8')
    expect(tpl).toContain('{{shot}}')
    const html = buildCoverHtml(tpl, { main: 'M', sub: 'S', shot: 'data:image/png;base64,AAA' })
    expect(html).toContain('data:image/png;base64,AAA')
    expect(html).not.toContain('{{shot}}')
  })
  it('无 shot 时 {{shot}} 置空、不残留占位', () => {
    const html = buildCoverHtml('<i>{{shot}}</i>', { main: 'M', sub: 'S' })
    expect(html).toBe('<i></i>')
  })
})

describe('pickRawShot', () => {
  function mkRaw(files: string[]): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-raw-'))
    for (const f of files) fs.writeFileSync(path.join(dir, f), 'x')
    return dir
  }
  it('图片优先于视频', () => {
    const dir = mkRaw(['b.mp4', 'a.png'])
    expect(pickRawShot(dir)).toEqual({ kind: 'image', path: path.join(dir, 'a.png') })
  })
  it('无图片时取视频', () => {
    const dir = mkRaw(['clip.mov', 'notes.txt'])
    expect(pickRawShot(dir)).toEqual({ kind: 'video', path: path.join(dir, 'clip.mov') })
  })
  it('无可用素材/目录不存在 → null', () => {
    expect(pickRawShot(mkRaw(['readme.txt']))).toBeNull()
    expect(pickRawShot('/no/such/dir')).toBeNull()
  })
})

describe('imageToDataUri', () => {
  it('按扩展名给 mime + base64', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-img-'))
    const p = path.join(dir, 'x.png')
    fs.writeFileSync(p, PNG1x1)
    const uri = imageToDataUri(p)
    expect(uri.startsWith('data:image/png;base64,')).toBe(true)
    expect(uri).toContain(PNG1x1.toString('base64'))
  })
})

// regenerateCover 的错误路径不需要真的起 Playwright（都在 renderCover 调用之前就抛错），
// 和仓库现有约定一致（generateCopy 测试全部 renderCovers:false，不在单测里真渲染）。
describe('regenerateCover（错误路径，不触发真实 Playwright 渲染）', () => {
  let ctx: CoreCtx
  let copyAssetId: number
  beforeEach(async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-regen-cover-'))
    const config = loadConfig(root, {})
    config.paths.templates = path.resolve(__dirname, '../../../templates')
    const db = openDb(config.paths.db)
    db.prepare("INSERT INTO projects (slug, target_buyer) VALUES ('demo-project', '中小电商卖家')").run()
    fs.mkdirSync(path.join(root, 'workspace/demo-project'), { recursive: true })
    fs.writeFileSync(path.join(root, 'workspace/demo-project/analysis.md'), '# 快客通 商业化分析\n## 痛点清单\n- 回消息熬夜')
    ctx = { db, config, llm: createLlmClient(config.llm) }
    const out = await generateCopy(ctx, { slug: 'demo-project', hook: 'pain', n: 1, renderCovers: false })
    copyAssetId = out.find((a) => a.type === 'copy')!.assetId
  })
  it('文案素材不存在 → 抛错', async () => {
    await expect(regenerateCover(ctx, 999999)).rejects.toThrow(/文案素材不存在/)
  })
  it('id 指向的是非 copy 类型素材 → 按不存在处理（SELECT 已按 type=copy 过滤）', async () => {
    const info = ctx.db.prepare(
      "INSERT INTO assets (project_id, type, hook, file_path, warnings) VALUES (1, 'video', 'pain', 'x.mp4', '[]')",
    ).run()
    await expect(regenerateCover(ctx, Number(info.lastInsertRowid))).rejects.toThrow(/文案素材不存在/)
  })
  it('opts.shot 指定的 raw 文件不存在 → 抛错', async () => {
    await expect(regenerateCover(ctx, copyAssetId, { shot: 'nope.png' })).rejects.toThrow(/raw 文件不存在/)
  })
  it('opts.shot 指定不支持的扩展名 → 抛错', async () => {
    const rawDir = path.join(ctx.config.paths.workspace, 'demo-project', 'raw')
    fs.mkdirSync(rawDir, { recursive: true })
    fs.writeFileSync(path.join(rawDir, 'weird.txt'), 'x')
    await expect(regenerateCover(ctx, copyAssetId, { shot: 'weird.txt' })).rejects.toThrow(/不支持的文件类型/)
  })
})
