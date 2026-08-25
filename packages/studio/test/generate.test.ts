import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { copyFixtures, createLlmClient, loadConfig, openDb, type CoreCtx } from '@forgecast/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as hyperframes from '../src/hyperframes'
import { generateVideo } from '../src/generate'
import { mockCustomTemplateHtml } from '../src/fixtures/custom-template-fixture'

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
    // flash 全套 fx：科技背景注入 + 文字带解码标记 + fx 标记消费干净
    expect(html).toContain('id="techbg"')
    expect(html).toMatch(/class="[^"]*painT tw[^"]*"/)
    // 分段按 buildFlashSections 动态铺满：CTA 必须跟着实际 duration 走，不再写死在 8-12s
    expect(html).toContain('id="flashCta"')
    expect(html).not.toMatch(/id="flashCta"[^>]*data-start="8"/)
    expect(html).not.toContain('<!--HF_BG-->'); expect(html).not.toContain('<!--HF_DECODE-->'); expect(html).not.toContain('<!--HF_FXCSS-->')
    expect(html).not.toContain('<!--HF_SECTIONS-->')
    const row: any = ctx.db.prepare('SELECT * FROM assets WHERE id = ?').get(out.assetId)
    expect(row.type).toBe('video')
    expect(row.file_path).toBe(out.filePath)
  })
  it('tpl=flash + ratio=landscape 走横屏模板，画布 1920x1080', async () => {
    const config = loadConfig(root, { FORGECAST_VIDEO_MODE: 'stub', FORGECAST_TTS_MODE: 'stub' })
    const fctx: CoreCtx = { db: ctx.db, config, llm: ctx.llm }
    await generateVideo(fctx, { slug: 'demo', tpl: 'flash', ratio: 'landscape' })
    const html = fs.readFileSync(path.join(fctx.config.paths.workspace, 'demo', 'hf', 'index.html'), 'utf8')
    expect(html).toContain('data-width="1920"')
    expect(html).toContain('data-height="1080"')
  })
  it('tpl=flash 不传 ratio 默认竖屏，画布 1080x1920', async () => {
    const config = loadConfig(root, { FORGECAST_VIDEO_MODE: 'stub', FORGECAST_TTS_MODE: 'stub' })
    const fctx: CoreCtx = { db: ctx.db, config, llm: ctx.llm }
    await generateVideo(fctx, { slug: 'demo', tpl: 'flash' })
    const html = fs.readFileSync(path.join(fctx.config.paths.workspace, 'demo', 'hf', 'index.html'), 'utf8')
    expect(html).toContain('data-width="1080"')
    expect(html).toContain('data-height="1920"')
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
    // story 特判：不加科技背景（保聊天真截图感），只结尾卖点/CTA 解码
    expect(html).not.toContain('id="techbg"')
    expect(html).toContain('class="sell tw"')
    expect(html).not.toContain('<!--HF_DECODE-->') // 解码运行时已注入
  })
  it('tpl=story + ratio=landscape 走横屏模板，画布 1920x1080', async () => {
    const config = loadConfig(root, { FORGECAST_VIDEO_MODE: 'stub', FORGECAST_TTS_MODE: 'stub' })
    const sctx: CoreCtx = { db: ctx.db, config, llm: ctx.llm }
    await generateVideo(sctx, { slug: 'demo', tpl: 'story', ratio: 'landscape' })
    const html = fs.readFileSync(path.join(sctx.config.paths.workspace, 'demo', 'hf', 'index.html'), 'utf8')
    expect(html).toContain('data-width="1920"')
    expect(html).toContain('data-height="1080"')
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
  it('stub 模式即便配了 beatPython 且曲库有曲，也不跑节拍分析（不 spawn librosa）', async () => {
    // 曲库放一首"曲子"、配上 beatPython——开发机常见组合（导出了 FORGECAST_MELO_PYTHON）
    const bgmDir = path.join(root, 'templates/bgm')
    fs.mkdirSync(bgmDir, { recursive: true })
    fs.writeFileSync(path.join(bgmDir, 'tech.mp3'), 'fake')
    const config = loadConfig(root, { FORGECAST_VIDEO_MODE: 'stub', FORGECAST_TTS_MODE: 'stub', FORGECAST_BEAT_PYTHON: '/fake/py' })
    const fctx: CoreCtx = { db: ctx.db, config, llm: ctx.llm }
    const spy = vi.spyOn(hyperframes, 'analyzeBeats')
    await generateVideo(fctx, { slug: 'demo', tpl: 'flash' })
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })
  it('input.bgm="none" 覆盖 ctx.config.video.bgm：不选曲、不跑节拍分析', async () => {
    const bgmDir = path.join(root, 'templates/bgm')
    fs.mkdirSync(bgmDir, { recursive: true })
    fs.writeFileSync(path.join(bgmDir, 'tech.mp3'), 'fake')
    const config = loadConfig(root, { FORGECAST_VIDEO_MODE: 'stub', FORGECAST_TTS_MODE: 'stub', FORGECAST_BEAT_PYTHON: '/fake/py' })
    const fctx: CoreCtx = { db: ctx.db, config, llm: ctx.llm }
    const spy = vi.spyOn(hyperframes, 'analyzeBeats')
    await generateVideo(fctx, { slug: 'demo', tpl: 'flash', bgm: 'none' })
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })
  it('input.bg="none" 覆盖默认 grid：html 不含科技背景元素', async () => {
    const config = loadConfig(root, { FORGECAST_VIDEO_MODE: 'stub', FORGECAST_TTS_MODE: 'stub' })
    const fctx: CoreCtx = { db: ctx.db, config, llm: ctx.llm }
    await generateVideo(fctx, { slug: 'demo', tpl: 'flash', bg: 'none' })
    const html = fs.readFileSync(path.join(fctx.config.paths.workspace, 'demo', 'hf', 'index.html'), 'utf8')
    expect(html).not.toContain('id="techbg"')
  })
  it('override 参数不 mutate ctx.config.video（单例安全，不污染后续调用）', async () => {
    const config = loadConfig(root, { FORGECAST_VIDEO_MODE: 'stub', FORGECAST_TTS_MODE: 'stub' })
    const fctx: CoreCtx = { db: ctx.db, config, llm: ctx.llm }
    await generateVideo(fctx, { slug: 'demo', tpl: 'flash', bgm: 'none', bg: 'aurora', mood: 'tense', captions: true })
    expect(fctx.config.video.bgm).toBe('')
    expect(fctx.config.video.bg).toBe('grid')
    expect(fctx.config.video.mood).toBe('')
    expect(fctx.config.video.captions).toBe(false)
  })
  it('tpl=changelog 走 HyperFrames stub，产出 asset 行与 hf 项目', async () => {
    const config = loadConfig(root, { FORGECAST_VIDEO_MODE: 'stub', FORGECAST_TTS_MODE: 'stub' })
    const hfCtx: CoreCtx = { db: ctx.db, config, llm: ctx.llm }
    const r = await generateVideo(hfCtx, { slug: 'demo', tpl: 'changelog', captions: true, onProgress: () => {} })
    expect(r.filePath).toContain('changelog-')
    const hfIndex = path.join(hfCtx.config.paths.workspace, 'demo', 'hf', 'index.html')
    expect(fs.existsSync(hfIndex)).toBe(true)
    const html = fs.readFileSync(hfIndex, 'utf8')
    expect(html).toContain('data-composition-id="main"')
    // 音轨与字幕必须真注入产物（防 fillTemplate 把注释标记以外的 {{}} 吃掉的回归）
    expect(html).toContain('<audio id="narration"')
    expect(html).toContain('class="cap clip"') // 字幕默认烧进片（不做逐字解码，保持整齐）
    // changelog 全套 fx：科技背景 + 标题解码 + fx 标记消费干净
    expect(html).toContain('id="techbg"')
    expect(html).toContain('class="title tw"')
    expect(html).not.toContain('<!--HF_BG-->'); expect(html).not.toContain('<!--HF_DECODE-->')
    // 注释标记应已被替换掉，不残留
    expect(html).not.toContain('<!--HF_AUDIO-->')
    expect(html).not.toContain('<!--HF_CAPTIONS-->')
    expect(html).not.toContain('<!--HF_ACCENTS-->')
  })
  it('tpl=insight 走 HyperFrames stub，文案无数字句时兜底只出开场+结尾（不报错、无空卡片区）', async () => {
    // beforeEach 用的 pain fixture 口播稿逐句里没有「数字+%/万/亿/倍/折」，天然覆盖零命中兜底路径
    const config = loadConfig(root, { FORGECAST_VIDEO_MODE: 'stub', FORGECAST_TTS_MODE: 'stub' })
    const hfCtx: CoreCtx = { db: ctx.db, config, llm: ctx.llm }
    const r = await generateVideo(hfCtx, { slug: 'demo', tpl: 'insight', captions: true, onProgress: () => {} })
    expect(r.filePath).toContain('insight-')
    const html = fs.readFileSync(path.join(hfCtx.config.paths.workspace, 'demo', 'hf', 'index.html'), 'utf8')
    expect(html).toContain('data-composition-id="main"')
    expect(html).toContain('<audio id="narration"')
    expect(html).toContain('class="cap clip"')
    expect(html).toContain('class="painT tw"') // 开场大字标题
    expect(html).toContain('class="cta tw"') // 结尾 CTA
    expect(html).not.toContain('class="card"') // 无数字句 → 零命中兜底，不留空卡片区
    expect(html).not.toContain('<!--HF_SECTIONS-->')
    expect(html).not.toContain('<!--HF_ACCENTS-->')
  })
  it('tpl=insight 文案有数字句时按 cue 时机生成数据卡片，累加淡入', async () => {
    // 自建一条口播稿里带百分比数据的文案，验证卡片真的会生成、且挂了淡入 accent
    const doc = `## 标题\n1. 标题一\n\n## 小红书正文\n正文\n\n## 抖音口播脚本\n效率提升了50%，客户满意度也涨到80%。\n\n## 封面文案\n主标题：数据说话\n副标题：看得见的增长\n\n## 评论区运营\n### 预埋提问\n1. 真的假的\n### 回复话术\n1. 真的，数据都在后台可查`
    ctx.db.prepare("INSERT INTO projects (slug, brand_name) VALUES ('stats', '数据说话')").run()
    const copyDir = path.join(root, 'workspace/stats/copy')
    fs.mkdirSync(copyDir, { recursive: true })
    fs.writeFileSync(path.join(copyDir, 'pain-1.md'), doc)
    ctx.db.prepare("INSERT INTO assets (project_id, type, hook, file_path) VALUES ((SELECT id FROM projects WHERE slug='stats'), 'copy', 'pain', 'stats/copy/pain-1.md')").run()
    const config = loadConfig(root, { FORGECAST_VIDEO_MODE: 'stub', FORGECAST_TTS_MODE: 'stub' })
    const hfCtx: CoreCtx = { db: ctx.db, config, llm: ctx.llm }
    const r = await generateVideo(hfCtx, { slug: 'stats', tpl: 'insight', captions: true, onProgress: () => {} })
    expect(r.filePath).toContain('insight-')
    const html = fs.readFileSync(path.join(hfCtx.config.paths.workspace, 'stats', 'hf', 'index.html'), 'utf8')
    expect(html).toContain('class="card"')
    expect(html).toMatch(/50%|80%/)
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
    expect(html).toContain('id="techbg"')            // 科技背景已注入
    expect(html).not.toContain('<!--HF_SECTIONS-->')
    expect(html).not.toContain('<!--HF_ACCENTS-->')
    expect(html).not.toContain('<!--HF_BG-->')       // 背景标记消费干净
    expect(html).not.toContain('<!--HF_BGANIM-->')
    // 截图拷进 assets
    expect(fs.existsSync(path.join(dctx.config.paths.workspace, 'demo', 'hf', 'assets', '01.png'))).toBe(true)
  })
  it('tpl=demo + ratio=landscape 走横屏模板，画布 1920x1080', async () => {
    const shotsDir = path.join(root, 'workspace/demo/shots')
    fs.mkdirSync(shotsDir, { recursive: true })
    fs.writeFileSync(path.join(shotsDir, '01.png'), pngOf(1080, 1920))
    const config = loadConfig(root, { FORGECAST_VIDEO_MODE: 'stub', FORGECAST_TTS_MODE: 'stub' })
    const dctx: CoreCtx = { db: ctx.db, config, llm: ctx.llm }
    await generateVideo(dctx, { slug: 'demo', tpl: 'demo', ratio: 'landscape' })
    const html = fs.readFileSync(path.join(dctx.config.paths.workspace, 'demo', 'hf', 'index.html'), 'utf8')
    expect(html).toContain('data-width="1920"')
    expect(html).toContain('data-height="1080"')
  })
  it('有 cutplan.json：按方案渲染（钉曲 + 方案 cuts），不重跑选曲', async () => {
    const shotsDir = path.join(root, 'workspace/demo/shots')
    fs.mkdirSync(shotsDir, { recursive: true })
    fs.writeFileSync(path.join(shotsDir, '01.png'), pngOf(1080, 1920))
    fs.writeFileSync(path.join(shotsDir, '02.png'), pngOf(1080, 1920))
    // 曲库放一首 tense 曲 + 写方案钉住它
    const bgmDir = path.join(root, 'templates/bgm/tense'); fs.mkdirSync(bgmDir, { recursive: true })
    fs.writeFileSync(path.join(bgmDir, 'x.mp3'), 'fake')
    fs.writeFileSync(path.join(root, 'workspace/demo/cutplan.json'), JSON.stringify({
      bgm: 'tense/x.mp3', grid: { t0: 0, T: 0.5, bpm: 120, strongBeats: [], duration: 24 },
      cadence: 4, offsetSec: 0, cuts: [{ beat: 16, shot: 0 }, { beat: 20, shot: 1 }],
    }))
    const config = loadConfig(root, { FORGECAST_VIDEO_MODE: 'stub', FORGECAST_TTS_MODE: 'stub' })
    const dctx: CoreCtx = { db: ctx.db, config, llm: ctx.llm }
    const r = await generateVideo(dctx, { slug: 'demo', tpl: 'demo', onProgress: () => {} })
    expect(r.filePath).toContain('demo-')
    const html = fs.readFileSync(path.join(dctx.config.paths.workspace, 'demo', 'hf', 'index.html'), 'utf8')
    // 方案 cuts：16 拍 ×0.5 = 8s、20 拍 = 10s
    expect(html).toMatch(/id="car0" data-start="8/)
    expect(html).toMatch(/id="car1" data-start="10/)
  })
  it('cutplan.json 曲子不存在 → 降级自动（不崩）', async () => {
    const shotsDir = path.join(root, 'workspace/demo/shots'); fs.mkdirSync(shotsDir, { recursive: true })
    fs.writeFileSync(path.join(shotsDir, '01.png'), pngOf(1080, 1920))
    fs.writeFileSync(path.join(root, 'workspace/demo/cutplan.json'), JSON.stringify({
      bgm: 'tense/missing.mp3', grid: { t0: 0, T: 0.5, bpm: 120, strongBeats: [], duration: 24 }, cadence: 4, offsetSec: 0, cuts: [{ beat: 16, shot: 0 }],
    }))
    const config = loadConfig(root, { FORGECAST_VIDEO_MODE: 'stub', FORGECAST_TTS_MODE: 'stub' })
    const dctx: CoreCtx = { db: ctx.db, config, llm: ctx.llm }
    const r = await generateVideo(dctx, { slug: 'demo', tpl: 'demo', onProgress: () => {} })
    expect(r.filePath).toContain('demo-') // 仍出片
  })
})

describe('generateVideo 自定义模板（stub）', () => {
  it('tpl=custom-<id> 走自定义模板分支，按拆解节奏比例填满全部占位符', async () => {
    const config = loadConfig(root, { FORGECAST_VIDEO_MODE: 'stub', FORGECAST_TTS_MODE: 'stub' })
    const cctx: CoreCtx = { db: ctx.db, config, llm: ctx.llm }
    const pacing = { durationSec: 12, segments: [{ start: 0, end: 4 }, { start: 4, end: 8 }, { start: 8, end: 12 }] }
    const info = cctx.db.prepare(
      "INSERT INTO custom_templates (name, aspect_ratio, segment_count, segments_json) VALUES ('对标A', 'portrait', 3, ?)",
    ).run(JSON.stringify(pacing))
    const id = Number(info.lastInsertRowid)
    const htmlDir = path.join(cctx.config.paths.templates, 'hf', 'custom')
    fs.mkdirSync(htmlDir, { recursive: true })
    fs.writeFileSync(path.join(htmlDir, `${id}.html`), mockCustomTemplateHtml(3, 1080, 1920), 'utf8')

    const out = await generateVideo(cctx, { slug: 'demo', tpl: `custom-${id}` })
    expect(out.filePath).toMatch(new RegExp(`demo/videos/custom-${id}-.*\\.mp4$`))
    const html = fs.readFileSync(path.join(cctx.config.paths.workspace, 'demo', 'hf', 'index.html'), 'utf8')
    expect(html).toContain('data-width="1080"')
    expect(html).not.toMatch(/\{\{seg\d_(start|dur|text)\}\}/)
    expect(html).toContain('data-start="0"')
    const row: any = ctx.db.prepare('SELECT * FROM assets WHERE id = ?').get(out.assetId)
    expect(row.type).toBe('video')
  })

  it('自定义模板 id 不存在 → 抛错', async () => {
    const config = loadConfig(root, { FORGECAST_VIDEO_MODE: 'stub', FORGECAST_TTS_MODE: 'stub' })
    const cctx: CoreCtx = { db: ctx.db, config, llm: ctx.llm }
    await expect(generateVideo(cctx, { slug: 'demo', tpl: 'custom-9999' })).rejects.toThrow('自定义模板不存在')
  })
})
