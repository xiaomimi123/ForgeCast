import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { copyFixtures, createLlmClient, loadConfig, openDb, type CoreCtx } from '@forgecast/core'
import { beforeEach, describe, expect, it } from 'vitest'
import { generateVideo } from '../src/generate'

let ctx: CoreCtx
let root: string
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-vid-'))
  const config = loadConfig(root, { FORGECAST_VIDEO_MODE: 'stub' })
  ctx = { db: openDb(config.paths.db), config, llm: createLlmClient(config.llm) }
  ctx.db.prepare("INSERT INTO projects (slug, brand_name) VALUES ('demo', '快客通')").run()
  const copyDir = path.join(root, 'workspace/demo/copy')
  fs.mkdirSync(copyDir, { recursive: true })
  fs.writeFileSync(path.join(copyDir, 'pain-1.md'), copyFixtures.pain)
  ctx.db.prepare("INSERT INTO assets (project_id, type, hook, file_path) VALUES (1, 'copy', 'pain', 'demo/copy/pain-1.md')").run()
})

describe('generateVideo (stub)', () => {
  it('tpl=flash 走 HyperFrames，产出 hf 项目 + 占位 mp4 + 登记 video 素材', async () => {
    const config = loadConfig(root, { FORGECAST_VIDEO_MODE: 'stub', FORGECAST_TTS_MODE: 'stub' })
    const fctx: CoreCtx = { db: ctx.db, config, llm: ctx.llm }
    const out = await generateVideo(fctx, { slug: 'demo', tpl: 'flash' })
    expect(out.filePath).toMatch(/demo\/videos\/flash-.*\.mp4$/)
    const abs = path.join(fctx.config.paths.workspace, out.filePath)
    expect(fs.existsSync(abs)).toBe(true)
    const html = fs.readFileSync(path.join(fctx.config.paths.workspace, 'demo', 'hf', 'index.html'), 'utf8')
    expect(html).toContain('data-composition-id="main"')
    expect(html).toContain('快客通') // brandName 填入
    // 强拍标记必须被替换掉（无曲库时替换为空串，不残留）
    expect(html).not.toContain('<!--HF_ACCENTS-->')
    const row: any = ctx.db.prepare('SELECT * FROM assets WHERE id = ?').get(out.assetId)
    expect(row.type).toBe('video')
    expect(row.file_path).toBe(out.filePath)
  })
  it('tpl=story 走 HyperFrames，产出气泡对话 + asset', async () => {
    const config = loadConfig(root, { FORGECAST_VIDEO_MODE: 'stub', FORGECAST_TTS_MODE: 'stub' })
    const sctx: CoreCtx = { db: ctx.db, config, llm: ctx.llm }
    const out = await generateVideo(sctx, { slug: 'demo', tpl: 'story', onProgress: () => {} })
    expect(out.filePath).toContain('story-')
    const html = fs.readFileSync(path.join(sctx.config.paths.workspace, 'demo', 'hf', 'index.html'), 'utf8')
    expect(html).toContain('class="bubble') // 气泡
    expect(html).toContain('<audio id="narration"')
    expect(html).not.toContain('<!--HF_SECTIONS-->')
  })
  it('无 copy 素材 → 抛错', async () => {
    ctx.db.prepare("INSERT INTO projects (slug) VALUES ('empty')").run()
    await expect(generateVideo(ctx, { slug: 'empty' })).rejects.toThrow(/文案/)
  })
  it('assetId 属于别的项目时不被误用（按 project_id 限定）', async () => {
    // beforeEach 已建 project demo(id=1) + 一条 copy(id=1) 属 demo
    ctx.db.prepare("INSERT INTO projects (slug) VALUES ('other')").run() // id=2
    await expect(generateVideo(ctx, { slug: 'other', assetId: 1 })).rejects.toThrow(/文案/)
  })
  it('无 BGM 曲库时正常出片（不加 BGM 不报错）', async () => {
    const config = loadConfig(root, { FORGECAST_VIDEO_MODE: 'stub', FORGECAST_TTS_MODE: 'stub' })
    const fctx: CoreCtx = { db: ctx.db, config, llm: ctx.llm }
    const out = await generateVideo(fctx, { slug: 'demo', tpl: 'flash', onProgress: () => {} })
    expect(out.filePath).toContain('flash-')
    // hf 项目仍产出，无 BGM 分支不抛错
    expect(fs.existsSync(path.join(fctx.config.paths.workspace, 'demo', 'hf', 'index.html'))).toBe(true)
  })
  it('tpl=changelog 走 HyperFrames stub，产出 asset 行与 hf 项目', async () => {
    const config = loadConfig(root, { FORGECAST_VIDEO_MODE: 'stub', FORGECAST_TTS_MODE: 'stub' })
    const hfCtx: CoreCtx = { db: ctx.db, config, llm: ctx.llm }
    const r = await generateVideo(hfCtx, { slug: 'demo', tpl: 'changelog', onProgress: () => {} })
    expect(r.filePath).toContain('changelog-')
    const hfIndex = path.join(hfCtx.config.paths.workspace, 'demo', 'hf', 'index.html')
    expect(fs.existsSync(hfIndex)).toBe(true)
    const html = fs.readFileSync(hfIndex, 'utf8')
    expect(html).toContain('data-composition-id="main"')
    // 音轨与字幕必须真注入产物（防 fillTemplate 把注释标记以外的 {{}} 吃掉的回归）
    expect(html).toContain('<audio id="narration"')
    expect(html).toContain('class="cap clip"')
    // 注释标记应已被替换掉，不残留
    expect(html).not.toContain('<!--HF_AUDIO-->')
    expect(html).not.toContain('<!--HF_CAPTIONS-->')
    expect(html).not.toContain('<!--HF_ACCENTS-->')
  })
})

describe('generateVideo demo (HyperFrames stub)', () => {
  function pngOf(w: number, h: number): Buffer {
    const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
    const ihdr = Buffer.alloc(25)
    ihdr.writeUInt32BE(13, 0); ihdr.write('IHDR', 4)
    ihdr.writeUInt32BE(w, 8); ihdr.writeUInt32BE(h, 12)
    return Buffer.concat([sig, ihdr])
  }
  it('无 shots/ 目录时报错', async () => {
    const config = loadConfig(root, { FORGECAST_VIDEO_MODE: 'stub', FORGECAST_TTS_MODE: 'stub' })
    const dctx: CoreCtx = { db: ctx.db, config, llm: ctx.llm }
    await expect(generateVideo(dctx, { slug: 'demo', tpl: 'demo' })).rejects.toThrow(/产品截图/)
  })
  it('有竖图时产出手机外框 + asset，横图走 wide 回落', async () => {
    const shotsDir = path.join(root, 'workspace/demo/shots')
    fs.mkdirSync(shotsDir, { recursive: true })
    fs.writeFileSync(path.join(shotsDir, '01.png'), pngOf(1080, 1920)) // 竖
    fs.writeFileSync(path.join(shotsDir, '02.png'), pngOf(1920, 1080)) // 横
    const config = loadConfig(root, { FORGECAST_VIDEO_MODE: 'stub', FORGECAST_TTS_MODE: 'stub' })
    const dctx: CoreCtx = { db: ctx.db, config, llm: ctx.llm }
    const r = await generateVideo(dctx, { slug: 'demo', tpl: 'demo', onProgress: () => {} })
    expect(r.filePath).toContain('demo-')
    const html = fs.readFileSync(path.join(dctx.config.paths.workspace, 'demo', 'hf', 'index.html'), 'utf8')
    expect(html).toContain('class="phone"')       // 竖图手机外框
    expect(html).toContain('class="wideBg"')       // 横图虚化背景
    expect(html).toContain('<audio id="narration"')
    expect(html).not.toContain('<!--HF_SECTIONS-->')
    expect(html).not.toContain('<!--HF_ACCENTS-->')
    // 截图拷进 assets
    expect(fs.existsSync(path.join(dctx.config.paths.workspace, 'demo', 'hf', 'assets', '01.png'))).toBe(true)
  })
})
