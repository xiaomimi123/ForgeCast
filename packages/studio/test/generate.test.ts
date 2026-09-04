import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { copyFixtures, createLlmClient, loadConfig, openDb, type CoreCtx } from '@forgecast/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as hyperframes from '../src/hyperframes'
import * as remotionRender from '../src/remotion-render'
import { generateVideo, writeSpecFiles } from '../src/generate'
import { mockCustomTemplateHtml } from '../src/fixtures/custom-template-fixture'

/** hf 目录改按 videoId 分目录（`workspace/<slug>/hf/<videoId>/`）——测试里大多数场景一次只生成
 *  一条视频，取该目录下唯一的子目录即可；需要区分多条视频时另行按 assetId 查 spec_path 反推。 */
function hfDirOf(workspace: string, slug: string): string {
  const hfRoot = path.join(workspace, slug, 'hf')
  const [videoId] = fs.readdirSync(hfRoot)
  return path.join(hfRoot, videoId)
}
function hfIndexHtml(workspace: string, slug: string): string {
  return fs.readFileSync(path.join(hfDirOf(workspace, slug), 'index.html'), 'utf8')
}

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
    const html = hfIndexHtml(fctx.config.paths.workspace, 'demo')
    expect(html).toContain('data-composition-id="main"')
    expect(html).toContain('快客通') // brandName 填入
    // 强拍标记必须被替换掉（无曲库时替换为空串，不残留）
    expect(html).not.toContain('<!--HF_ACCENTS-->')
    // flash 全套 fx：科技背景注入 + 文字带解码标记 + fx 标记消费干净
    expect(html).toContain('id="techbg"')
    // 新管线：cssClass（painT）挂在外层 clip 容器上，解码标记（tw）挂在内层可寻址子行上——
    // 两者不再合并在同一个 class 属性里（见 render-html.ts renderLayer/renderTextContent）。
    expect(html).toMatch(/class="[^"]*painT[^"]*"/)
    expect(html).toContain('id="flashHook-l0" class="tw"')
    // 分段按 buildFlashSections 动态铺满：CTA 必须跟着实际 duration 走，不再写死在 8-12s
    expect(html).toContain('id="flashCta"')
    expect(html).not.toMatch(/id="flashCta"[^>]*data-start="8"/)
    expect(html).not.toContain('<!--HF_BG-->'); expect(html).not.toContain('<!--HF_DECODE-->'); expect(html).not.toContain('<!--HF_FXCSS-->')
    expect(html).not.toContain('<!--HF_SECTIONS-->')
    const row: any = ctx.db.prepare('SELECT * FROM assets WHERE id = ?').get(out.assetId)
    expect(row.type).toBe('video')
    expect(row.file_path).toBe(out.filePath)
  })
  it('生成的 spec.semantic.sourceAssetId = 传入的文案 assetId（video→copy 链接，Task 3 聚合靠它）', async () => {
    const config = loadConfig(root, { FORGECAST_VIDEO_MODE: 'stub', FORGECAST_TTS_MODE: 'stub' })
    const fctx: CoreCtx = { db: ctx.db, config, llm: ctx.llm }
    const out = await generateVideo(fctx, { slug: 'demo', tpl: 'flash', assetId: 1 })
    const row: any = ctx.db.prepare('SELECT * FROM assets WHERE id = ?').get(out.assetId)
    const spec = JSON.parse(fs.readFileSync(path.join(fctx.config.paths.workspace, row.spec_path), 'utf8'))
    expect(spec.semantic.sourceAssetId).toBe(1)
  })
  it('tpl=flash + ratio=landscape 走横屏模板，画布 1920x1080', async () => {
    const config = loadConfig(root, { FORGECAST_VIDEO_MODE: 'stub', FORGECAST_TTS_MODE: 'stub' })
    const fctx: CoreCtx = { db: ctx.db, config, llm: ctx.llm }
    await generateVideo(fctx, { slug: 'demo', tpl: 'flash', ratio: 'landscape' })
    const html = hfIndexHtml(fctx.config.paths.workspace, 'demo')
    expect(html).toContain('data-width="1920"')
    expect(html).toContain('data-height="1080"')
  })
  it('tpl=flash 不传 ratio 默认竖屏，画布 1080x1920', async () => {
    const config = loadConfig(root, { FORGECAST_VIDEO_MODE: 'stub', FORGECAST_TTS_MODE: 'stub' })
    const fctx: CoreCtx = { db: ctx.db, config, llm: ctx.llm }
    await generateVideo(fctx, { slug: 'demo', tpl: 'flash' })
    const html = hfIndexHtml(fctx.config.paths.workspace, 'demo')
    expect(html).toContain('data-width="1080"')
    expect(html).toContain('data-height="1920"')
  })
  it('tpl=story 走 HyperFrames，产出气泡对话 + asset', async () => {
    const config = loadConfig(root, { FORGECAST_VIDEO_MODE: 'stub', FORGECAST_TTS_MODE: 'stub' })
    const sctx: CoreCtx = { db: ctx.db, config, llm: ctx.llm }
    const out = await generateVideo(sctx, { slug: 'demo', tpl: 'story', onProgress: () => {} })
    expect(out.filePath).toContain('story-')
    const html = hfIndexHtml(sctx.config.paths.workspace, 'demo')
    // 气泡：新管线把多轮对话揉进 storyChat 一个 layer（lower.ts 顶部注释），逐条渲成
    // "对方：xxx"/"我：xxx" 文本行（id="storyChat-lN"），不再是各自独立的 .bubble 元素。
    expect(html).toContain('id="storyChat-l0"')
    expect(html).toMatch(/对方|我：/)
    expect(html).toContain('<audio id="narration"')
    expect(html).not.toContain('<!--HF_SECTIONS-->')
    // story 特判：不加科技背景（保聊天真截图感），只结尾卖点/CTA 解码
    expect(html).not.toContain('id="techbg"')
    expect(html).toContain('id="storySell-l0" class="tw"')
    expect(html).not.toContain('<!--HF_DECODE-->') // 解码运行时已注入
  })
  it('tpl=story + ratio=landscape 走横屏模板，画布 1920x1080', async () => {
    const config = loadConfig(root, { FORGECAST_VIDEO_MODE: 'stub', FORGECAST_TTS_MODE: 'stub' })
    const sctx: CoreCtx = { db: ctx.db, config, llm: ctx.llm }
    await generateVideo(sctx, { slug: 'demo', tpl: 'story', ratio: 'landscape' })
    const html = hfIndexHtml(sctx.config.paths.workspace, 'demo')
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
    expect(fs.existsSync(path.join(hfDirOf(fctx.config.paths.workspace, 'demo'), 'index.html'))).toBe(true)
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
    const html = hfIndexHtml(fctx.config.paths.workspace, 'demo')
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
    const hfIndex = path.join(hfDirOf(hfCtx.config.paths.workspace, 'demo'), 'index.html')
    expect(fs.existsSync(hfIndex)).toBe(true)
    const html = fs.readFileSync(hfIndex, 'utf8')
    expect(html).toContain('data-composition-id="main"')
    // 音轨与字幕必须真注入产物（防 fillTemplate 把注释标记以外的 {{}} 吃掉的回归）
    expect(html).toContain('<audio id="narration"')
    expect(html).toContain('class="clip cap"') // 字幕默认烧进片（不做逐字解码，保持整齐）
    // changelog 全套 fx：科技背景 + 标题解码 + fx 标记消费干净
    expect(html).toContain('id="techbg"')
    expect(html).toContain('id="clTitle-l1" class="tw"') // title 行（clTitle 三行拼一层，见 lower.ts DECODE_LINE）
    expect(html).not.toContain('<!--HF_BG-->'); expect(html).not.toContain('<!--HF_DECODE-->')
    // 注释标记应已被替换掉，不残留
    expect(html).not.toContain('<!--HF_AUDIO-->')
    expect(html).not.toContain('<!--HF_CAPTIONS-->')
    expect(html).not.toContain('<!--HF_ACCENTS-->')
  })
  it('tpl=changelog：回归——CTA 必须跟着 duration 走，不再固定 6s 后一路静止到底', async () => {
    const config = loadConfig(root, { FORGECAST_VIDEO_MODE: 'stub', FORGECAST_TTS_MODE: 'stub' })
    const hfCtx: CoreCtx = { db: ctx.db, config, llm: ctx.llm }
    await generateVideo(hfCtx, { slug: 'demo', tpl: 'changelog' })
    const html = hfIndexHtml(hfCtx.config.paths.workspace, 'demo')
    expect(html).toContain('id="clCta"')
    expect(html).not.toMatch(/id="clCta"[^>]*data-start="6"/)
  })
  it('tpl=changelog + ratio=landscape 走横屏模板，画布 1920x1080', async () => {
    const config = loadConfig(root, { FORGECAST_VIDEO_MODE: 'stub', FORGECAST_TTS_MODE: 'stub' })
    const hfCtx: CoreCtx = { db: ctx.db, config, llm: ctx.llm }
    await generateVideo(hfCtx, { slug: 'demo', tpl: 'changelog', ratio: 'landscape' })
    const html = hfIndexHtml(hfCtx.config.paths.workspace, 'demo')
    expect(html).toContain('data-width="1920"')
    expect(html).toContain('data-height="1080"')
  })
  it('tpl=insight 走 HyperFrames stub，文案无数字句时兜底只出开场+结尾（不报错、无空卡片区）', async () => {
    // beforeEach 用的 pain fixture 口播稿逐句里没有「数字+%/万/亿/倍/折」，天然覆盖零命中兜底路径
    const config = loadConfig(root, { FORGECAST_VIDEO_MODE: 'stub', FORGECAST_TTS_MODE: 'stub' })
    const hfCtx: CoreCtx = { db: ctx.db, config, llm: ctx.llm }
    const r = await generateVideo(hfCtx, { slug: 'demo', tpl: 'insight', captions: true, onProgress: () => {} })
    expect(r.filePath).toContain('insight-')
    const html = hfIndexHtml(hfCtx.config.paths.workspace, 'demo')
    expect(html).toContain('data-composition-id="main"')
    expect(html).toContain('<audio id="narration"')
    expect(html).toContain('class="clip cap"')
    expect(html).toContain('id="insight-intro-l0" class="tw"') // 开场大字标题
    expect(html).toContain('id="insight-outro-l0" class="tw"') // 结尾 CTA
    expect(html).not.toContain('class="clip card"') // 无数字句 → 零命中兜底，不留空卡片区
    expect(html).not.toContain('<!--HF_SECTIONS-->')
    expect(html).not.toContain('<!--HF_ACCENTS-->')
  })
  it('tpl=insight + ratio=landscape 走横屏模板，画布 1920x1080', async () => {
    const config = loadConfig(root, { FORGECAST_VIDEO_MODE: 'stub', FORGECAST_TTS_MODE: 'stub' })
    const hfCtx: CoreCtx = { db: ctx.db, config, llm: ctx.llm }
    await generateVideo(hfCtx, { slug: 'demo', tpl: 'insight', ratio: 'landscape' })
    const html = hfIndexHtml(hfCtx.config.paths.workspace, 'demo')
    expect(html).toContain('data-width="1920"')
    expect(html).toContain('data-height="1080"')
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
    const html = hfIndexHtml(hfCtx.config.paths.workspace, 'stats')
    expect(html).toContain('class="clip card"')
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
    const html = hfIndexHtml(dctx.config.paths.workspace, 'demo')
    expect(html).toContain('class="phone"')       // 竖图手机外框
    expect(html).toContain('class="wideBg"')       // 横图虚化背景
    expect(html).toContain('<audio id="narration"')
    expect(html).toContain('id="techbg"')            // 科技背景已注入
    expect(html).not.toContain('<!--HF_SECTIONS-->')
    expect(html).not.toContain('<!--HF_ACCENTS-->')
    expect(html).not.toContain('<!--HF_BG-->')       // 背景标记消费干净
    expect(html).not.toContain('<!--HF_BGANIM-->')
    // 截图拷进 assets
    expect(fs.existsSync(path.join(hfDirOf(dctx.config.paths.workspace, 'demo'), 'assets', '01.png'))).toBe(true)
  })
  it('tpl=demo + ratio=landscape 走横屏模板，画布 1920x1080', async () => {
    const shotsDir = path.join(root, 'workspace/demo/shots')
    fs.mkdirSync(shotsDir, { recursive: true })
    fs.writeFileSync(path.join(shotsDir, '01.png'), pngOf(1080, 1920))
    const config = loadConfig(root, { FORGECAST_VIDEO_MODE: 'stub', FORGECAST_TTS_MODE: 'stub' })
    const dctx: CoreCtx = { db: ctx.db, config, llm: ctx.llm }
    await generateVideo(dctx, { slug: 'demo', tpl: 'demo', ratio: 'landscape' })
    const html = hfIndexHtml(dctx.config.paths.workspace, 'demo')
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
    const html = hfIndexHtml(dctx.config.paths.workspace, 'demo')
    // 方案 cuts：16 拍 ×0.5 = 8s、20 拍 = 10s
    expect(html).toMatch(/id="car0"[^>]*data-start="8/)
    expect(html).toMatch(/id="car1"[^>]*data-start="10/)
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
    const html = hfIndexHtml(cctx.config.paths.workspace, 'demo')
    expect(html).toContain('data-width="1080"')
    expect(html).not.toMatch(/\{\{seg\d_(start|dur|text)\}\}/)
    expect(html).toContain('data-start="0"')
    const row: any = ctx.db.prepare('SELECT * FROM assets WHERE id = ?').get(out.assetId)
    expect(row.type).toBe('video')
  })

  it('自定义模板也把 spec.semantic.sourceAssetId 接上传入的文案 assetId（与四固定模板同语义）', async () => {
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

    const out = await generateVideo(cctx, { slug: 'demo', tpl: `custom-${id}`, assetId: 1 })
    const row: any = cctx.db.prepare('SELECT * FROM assets WHERE id = ?').get(out.assetId)
    const spec = JSON.parse(fs.readFileSync(path.join(cctx.config.paths.workspace, row.spec_path), 'utf8'))
    expect(spec.semantic.sourceAssetId).toBe(1)
  })

  it('自定义模板 id 不存在 → 抛错', async () => {
    const config = loadConfig(root, { FORGECAST_VIDEO_MODE: 'stub', FORGECAST_TTS_MODE: 'stub' })
    const cctx: CoreCtx = { db: ctx.db, config, llm: ctx.llm }
    await expect(generateVideo(cctx, { slug: 'demo', tpl: 'custom-9999' })).rejects.toThrow('自定义模板不存在')
  })
})

describe('generateVideo VideoSpec 落盘 + hf 分目录（Task 5 管线接入）', () => {
  it('生成后落 VideoSpec 文件，且 assets.spec_path 指向它', async () => {
    const config = loadConfig(root, { FORGECAST_VIDEO_MODE: 'stub', FORGECAST_TTS_MODE: 'stub' })
    const fctx: CoreCtx = { db: ctx.db, config, llm: ctx.llm }
    const r = await generateVideo(fctx, { slug: 'demo', tpl: 'flash' })
    const row: any = ctx.db.prepare('SELECT spec_path FROM assets WHERE id = ?').get(r.assetId)
    expect(row.spec_path).toBeTruthy()
    const abs = path.join(fctx.config.paths.workspace, row.spec_path)
    expect(fs.existsSync(abs)).toBe(true)
    const spec = JSON.parse(fs.readFileSync(abs, 'utf8'))
    expect(spec.version).toBe(1)
    expect(spec.layers.length).toBeGreaterThan(0)
    expect(spec.canvas).toEqual({ width: 1080, height: 1920 })
  })

  // Task 10 修复轮 1：bgVariant 必须写进落盘的 spec，否则 Web 预览拿不到它 → 预览无科技背景、
  // 成片有，而实时预览正是子项目②的交付目标。且必须在**渲染之前**写好：`--bg=random` 时
  // resolveBgVariant 只解析一次，晚写就可能「传给渲染的值」≠「写进磁盘的值」。
  it('落盘的 spec 带 bgVariant，且与传给渲染的 inputProps 是同一个值', async () => {
    const config = loadConfig(root, { FORGECAST_VIDEO_MODE: 'stub', FORGECAST_TTS_MODE: 'stub' })
    const fctx: CoreCtx = { db: ctx.db, config, llm: ctx.llm }
    const specOf = async (opts: { tpl: string; bg?: string }) => {
      const r = await generateVideo(fctx, { slug: 'demo', ...opts } as any)
      const row: any = ctx.db.prepare('SELECT spec_path FROM assets WHERE id = ?').get(r.assetId)
      return JSON.parse(fs.readFileSync(path.join(fctx.config.paths.workspace, row.spec_path), 'utf8'))
    }
    expect((await specOf({ tpl: 'flash', bg: 'grid' })).bgVariant).toBe('grid')
    // story 不加科技背景 → 字段缺席（JSON 里 undefined 不落键），预览侧同样不画背景
    expect((await specOf({ tpl: 'story', bg: 'grid' })).bgVariant).toBeUndefined()
    // --bg=random：随机只发生一次，落盘的值必然是五个合法变体之一（不是 undefined、不是 'random'）
    expect(['grid', 'aurora', 'matrix', 'synth', 'mesh'])
      .toContain((await specOf({ tpl: 'flash', bg: 'random' })).bgVariant)
  })

  it('spec.bgVariant 在渲染之前就写好（renderRemotion 拿到的 spec 已带该字段）', async () => {
    const config = loadConfig(root, { FORGECAST_VIDEO_MODE: 'stub', FORGECAST_TTS_MODE: 'stub' })
    const fctx: CoreCtx = { db: ctx.db, config, llm: ctx.llm }
    // 落盘发生在渲染之后（renderAndRegister），所以「落盘时有」证明不了「渲染时有」——
    // 这里直接在 renderRemotion 的入口把 spec 拍下来。
    const seen: Array<string | undefined> = []
    const spy = vi.spyOn(remotionRender, 'renderRemotion').mockImplementation(async (spec: any, outAbs: string) => {
      seen.push(spec.bgVariant)
      fs.mkdirSync(path.dirname(outAbs), { recursive: true }); fs.writeFileSync(outAbs, 'stub')
    })
    try {
      await generateVideo(fctx, { slug: 'demo', tpl: 'flash', bg: 'grid' } as any)
    } finally { spy.mockRestore() }
    expect(seen).toEqual(['grid'])
  })

  it('hf 目录按 videoId 分开，不再互相覆盖', async () => {
    const config = loadConfig(root, { FORGECAST_VIDEO_MODE: 'stub', FORGECAST_TTS_MODE: 'stub' })
    const fctx: CoreCtx = { db: ctx.db, config, llm: ctx.llm }
    const a = await generateVideo(fctx, { slug: 'demo', tpl: 'flash' })
    const b = await generateVideo(fctx, { slug: 'demo', tpl: 'flash' })
    const specOf = (id: number) => (ctx.db.prepare('SELECT spec_path FROM assets WHERE id=?').get(id) as any).spec_path
    expect(specOf(a.assetId)).not.toBe(specOf(b.assetId))
    // 两条视频的 hf 目录都还在
    const dirs = fs.readdirSync(path.join(fctx.config.paths.workspace, 'demo', 'hf'))
    expect(dirs.length).toBeGreaterThanOrEqual(2)
  })

  it('TTS 降级时 warnings 落库（回归：原先硬编码 "[]"，信号只进内存日志）', async () => {
    const config = loadConfig(root, { FORGECAST_VIDEO_MODE: 'stub', FORGECAST_TTS_MODE: 'stub' })
    const fctx: CoreCtx = { db: ctx.db, config, llm: ctx.llm }
    // 触发方式：把 tts.mode 设成 live 但不给 key —— synthesizeVoice 的 degrade() 分支会命中，
    // 返回 degraded 原因并写静音占位 wav。
    const r = await generateVideo({ ...fctx, config: { ...fctx.config, tts: { ...fctx.config.tts, mode: 'live', apiKey: '' } } } as any, { slug: 'demo', tpl: 'flash' })
    const row: any = ctx.db.prepare('SELECT warnings FROM assets WHERE id = ?').get(r.assetId)
    const w = JSON.parse(row.warnings)
    expect(Array.isArray(w)).toBe(true)
    expect(w.length).toBeGreaterThan(0)
    expect(w.join(' ')).toMatch(/TTS|降级/)
  })

  it('生成落盘 spec 的同时写 orig 快照，且内容一致', async () => {
    const config = loadConfig(root, { FORGECAST_VIDEO_MODE: 'stub', FORGECAST_TTS_MODE: 'stub' })
    const fctx: CoreCtx = { db: ctx.db, config, llm: ctx.llm }
    const r = await generateVideo(fctx, { slug: 'demo', tpl: 'flash' })
    const row: any = ctx.db.prepare('SELECT spec_path FROM assets WHERE id = ?').get(r.assetId)
    const abs = path.join(fctx.config.paths.workspace, row.spec_path)
    const origAbs = abs.replace(/\.json$/, '.orig.json')
    expect(fs.existsSync(origAbs)).toBe(true)
    expect(JSON.parse(fs.readFileSync(origAbs, 'utf8'))).toEqual(JSON.parse(fs.readFileSync(abs, 'utf8')))
  })

  it('重复渲染不覆盖已有 orig（同 videoId 二次落盘，先手改 orig 再直调写盘逻辑）', async () => {
    // 注：不用 vi.spyOn(crypto, 'randomUUID') 模拟「同 videoId 重渲」——generate.ts 是具名导入
    // （`import { randomUUID } from 'node:crypto'`），spy 挂在模块导出对象上拦不住已绑定的引用，
    // 两次调用实际拿到两个不同的真随机 UUID，测试断言的其实是「没碰过的文件没变」，是假阳性。
    // 改为直接调用 renderAndRegister 落盘时用的同一个 writeSpecFiles，验证它本身「orig 已存在则
    // 不覆盖」这条守卫，不依赖能否伪造出两次相同 videoId 的真实渲染。
    const config = loadConfig(root, { FORGECAST_VIDEO_MODE: 'stub', FORGECAST_TTS_MODE: 'stub' })
    const fctx: CoreCtx = { db: ctx.db, config, llm: ctx.llm }
    const r = await generateVideo(fctx, { slug: 'demo', tpl: 'flash' })
    const row: any = ctx.db.prepare('SELECT spec_path FROM assets WHERE id = ?').get(r.assetId)
    const abs = path.join(fctx.config.paths.workspace, row.spec_path)
    const origAbs = abs.replace(/\.json$/, '.orig.json')
    expect(fs.existsSync(origAbs)).toBe(true)
    const firstSpec = JSON.parse(fs.readFileSync(abs, 'utf8'))
    // 手改 orig，模拟「已经保存过一次编辑历史」
    fs.writeFileSync(origAbs, JSON.stringify({ hand: 'edited' }))
    // 同一 videoId 再落一次盘（模拟对同一条视频重渲——调用点与 renderAndRegister 完全一致）
    writeSpecFiles(abs, { ...firstSpec, durationSec: 999 })
    // spec.json 应已被新一轮写盘覆盖，但 orig 不应被覆盖
    expect(JSON.parse(fs.readFileSync(abs, 'utf8')).durationSec).toBe(999)
    expect(JSON.parse(fs.readFileSync(origAbs, 'utf8'))).toEqual({ hand: 'edited' })
  })
})

describe('generateVideo 品牌名落片（回归：这是第 4 次复发的同一类 bug——changelog→flash→story→' +
  'demo/insight，四轮各修一个实例；本轮改成一次性表驱动覆盖全部五个模板，防第 5 次复发）', () => {
  // beforeEach 已建 project demo(brand_name='快客通')。demo 模板额外要求 shots/ 目录非空，
  // 其余四个模板直接复用 beforeEach 的 pain-1.md 文案素材。
  const templates: Array<'flash' | 'story' | 'demo' | 'changelog' | 'insight'> = ['flash', 'story', 'demo', 'changelog', 'insight']
  it.each(templates)('tpl=%s 生成的 HTML 里必须能看到品牌名（结构指纹看不见文案内容，只有内容断言能防回归）', async (tpl) => {
    if (tpl === 'demo') {
      const shotsDir = path.join(root, 'workspace/demo/shots')
      fs.mkdirSync(shotsDir, { recursive: true })
      const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
      const ihdr = Buffer.alloc(25)
      ihdr.writeUInt32BE(13, 0); ihdr.write('IHDR', 4)
      ihdr.writeUInt32BE(1080, 8); ihdr.writeUInt32BE(1920, 12)
      fs.writeFileSync(path.join(shotsDir, '01.png'), Buffer.concat([sig, ihdr]))
    }
    const config = loadConfig(root, { FORGECAST_VIDEO_MODE: 'stub', FORGECAST_TTS_MODE: 'stub' })
    const tctx: CoreCtx = { db: ctx.db, config, llm: ctx.llm }
    await generateVideo(tctx, { slug: 'demo', tpl })
    const html = hfIndexHtml(tctx.config.paths.workspace, 'demo')
    expect(html).toContain('快客通')
  })
})

/**
 * talk（口播合成）管线：与五模板的 renderHfPipeline 平行的独立分支——
 * 不跑 TTS、不产 index.html（templates/hf/ 没有 talk 模板文件）、口播底片走软链零拷贝。
 *
 * 素材策略：用 ffmpeg 现合一段 2s 小 mp4，ffprobe 真跑（时长断言直接与测试内自己 probe 的值对齐，
 * 不写死 2.0——容器格式的实际时长可能带零头）。ffmpeg 不在时整组跳过，不假红。
 */
const HAS_FFMPEG = (() => {
  try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); execFileSync('ffprobe', ['-version'], { stdio: 'ignore' }); return true } catch { return false }
})()
function probeSec(abs: string): number {
  return Number.parseFloat(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', abs], { encoding: 'utf8' }).trim())
}
/** 2s 测试片源只合成一次（整个文件共用），各用例拷进自己的 workspace——每例都跑一次 ffmpeg
 *  会显著拖慢并发下的整套测试（曾把邻居用例挤到超时）。 */
let sampleMp4 = ''
function sampleSource(): string {
  if (!sampleMp4) {
    sampleMp4 = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fc-talk-src-')), 'src.mp4')
    execFileSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=10:duration=2', '-pix_fmt', 'yuv420p', sampleMp4], { stdio: 'ignore' })
  }
  return sampleMp4
}
/** 造一段 2s 测试片源，登记成 origin='upload' 的 video 素材，返回 { assetId, abs }。 */
function makeUpload(workspace: string, name = 'talk.mp4'): { assetId: number; abs: string } {
  const dir = path.join(workspace, 'demo', 'uploads')
  fs.mkdirSync(dir, { recursive: true })
  const abs = path.join(dir, name)
  fs.copyFileSync(sampleSource(), abs)
  const info = ctx.db.prepare(
    "INSERT INTO assets (project_id, type, hook, file_path, warnings, origin) VALUES (1, 'video', NULL, ?, '[]', 'upload')",
  ).run(path.join('demo', 'uploads', name))
  return { assetId: Number(info.lastInsertRowid), abs }
}

describe.skipIf(!HAS_FFMPEG)('generateVideo tpl=talk（口播合成，stub）', () => {
  function talkCtx(): CoreCtx {
    const config = loadConfig(root, { FORGECAST_VIDEO_MODE: 'stub', FORGECAST_TTS_MODE: 'stub' })
    return { db: ctx.db, config, llm: ctx.llm }
  }

  it('全链路：软链指向上传片源 / 不产 index.html / durationSec=ffprobe 值 / 无旁白无字幕', async () => {
    const tctx = talkCtx()
    const { assetId: upId, abs: srcAbs } = makeUpload(tctx.config.paths.workspace)
    const out = await generateVideo(tctx, { slug: 'demo', tpl: 'talk', assetId: 1, uploadAssetId: upId })

    const hfDir = hfDirOf(tctx.config.paths.workspace, 'demo')
    const link = path.join(hfDir, 'assets', 'talk-source.mp4')
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true)
    expect(fs.realpathSync(fs.readlinkSync(link))).toBe(fs.realpathSync(srcAbs))
    // 不产 index.html：talk 没有 HyperFrames 模板文件，走 HTML 那条路只会炸
    expect(fs.existsSync(path.join(hfDir, 'index.html'))).toBe(false)

    const row: any = ctx.db.prepare('SELECT * FROM assets WHERE id = ?').get(out.assetId)
    const spec = JSON.parse(fs.readFileSync(path.join(tctx.config.paths.workspace, row.spec_path), 'utf8'))
    expect(spec.template).toBe('talk')
    expect(spec.durationSec).toBeCloseTo(probeSec(srcAbs), 3)
    expect(spec.audio.narration).toBe(null)
    expect(spec.audio.captionsEnabled).toBe(false)
    expect(spec.layers.some((l: any) => l.kind === 'caption')).toBe(false)
    expect(spec.semantic.sourceAssetId).toBe(1)
    expect(spec.semantic.sections.some((s: any) => s.id === 'sec-video')).toBe(true)
    // orig 快照
    const origAbs = path.join(tctx.config.paths.workspace, row.spec_path).replace(/\.json$/, '.orig.json')
    expect(fs.existsSync(origAbs)).toBe(true)
    // bgVariant 默认 none（未显式 --bg 时不加科技背景）
    expect(spec.bgVariant).toBeUndefined()
  })

  it('视频层：src 指向软链、sourceDurationSec 与 trimEnd 落 ffprobe 值', async () => {
    const tctx = talkCtx()
    const { assetId: upId, abs: srcAbs } = makeUpload(tctx.config.paths.workspace)
    const out = await generateVideo(tctx, { slug: 'demo', tpl: 'talk', uploadAssetId: upId })
    const row: any = ctx.db.prepare('SELECT * FROM assets WHERE id = ?').get(out.assetId)
    const spec = JSON.parse(fs.readFileSync(path.join(tctx.config.paths.workspace, row.spec_path), 'utf8'))
    const v = spec.layers.find((l: any) => l.kind === 'video')
    expect(v.content.src).toBe('assets/talk-source.mp4')
    expect(v.from).toBe('sec-video')
    const dur = probeSec(srcAbs)
    expect(v.content.sourceDurationSec).toBeCloseTo(dur, 3)
    expect(v.content.trimEnd).toBeCloseTo(dur, 3)
  })

  it('软链失败（FS 不支持）→ 回落真拷贝 + warning，不让渲染整条失败', async () => {
    const tctx = talkCtx()
    const { assetId: upId, abs: srcAbs } = makeUpload(tctx.config.paths.workspace)
    const real = fs.symlinkSync
    const spy = vi.spyOn(fs, 'symlinkSync').mockImplementation(((t: any, p: any, ty: any) => {
      if (String(p).endsWith('talk-source.mp4')) throw Object.assign(new Error('EPERM'), { code: 'EPERM' })
      return real(t, p, ty)
    }) as any)
    try {
      const out = await generateVideo(tctx, { slug: 'demo', tpl: 'talk', uploadAssetId: upId })
      const copied = path.join(hfDirOf(tctx.config.paths.workspace, 'demo'), 'assets', 'talk-source.mp4')
      expect(fs.lstatSync(copied).isSymbolicLink()).toBe(false)
      expect(fs.readFileSync(copied).length).toBe(fs.readFileSync(srcAbs).length)
      const row: any = ctx.db.prepare('SELECT * FROM assets WHERE id = ?').get(out.assetId)
      expect(JSON.parse(row.warnings)).toContain('文件系统不支持软链，已复制口播素材')
    } finally { spy.mockRestore() }
  })

  it('显式 --bg 时才加科技背景（talk 默认 none）', async () => {
    const tctx = talkCtx()
    const { assetId: upId } = makeUpload(tctx.config.paths.workspace)
    const out = await generateVideo(tctx, { slug: 'demo', tpl: 'talk', uploadAssetId: upId, bg: 'aurora' })
    const row: any = ctx.db.prepare('SELECT * FROM assets WHERE id = ?').get(out.assetId)
    const spec = JSON.parse(fs.readFileSync(path.join(tctx.config.paths.workspace, row.spec_path), 'utf8'))
    expect(spec.bgVariant).toBe('aurora')
  })

  it('缺 uploadAssetId → 抛错', async () => {
    await expect(generateVideo(talkCtx(), { slug: 'demo', tpl: 'talk' })).rejects.toThrow(/口播素材/)
  })

  it('uploadAssetId 指向非上传素材（rendered 成片 / 文案）→ 抛错', async () => {
    const tctx = talkCtx()
    const bad = ctx.db.prepare(
      "INSERT INTO assets (project_id, type, hook, file_path, warnings, origin) VALUES (1, 'video', NULL, 'demo/videos/x.mp4', '[]', 'rendered')",
    ).run()
    await expect(generateVideo(tctx, { slug: 'demo', tpl: 'talk', uploadAssetId: Number(bad.lastInsertRowid) }))
      .rejects.toThrow(/口播素材/)
    await expect(generateVideo(tctx, { slug: 'demo', tpl: 'talk', uploadAssetId: 1 })).rejects.toThrow(/口播素材/)
  })

  it('片源文件丢失（素材行在但文件没了）→ 抛「无法读取口播素材时长」', async () => {
    const tctx = talkCtx()
    const { assetId: upId, abs } = makeUpload(tctx.config.paths.workspace)
    fs.rmSync(abs)
    await expect(generateVideo(tctx, { slug: 'demo', tpl: 'talk', uploadAssetId: upId }))
      .rejects.toThrow(/无法读取口播素材时长/)
  })
})
