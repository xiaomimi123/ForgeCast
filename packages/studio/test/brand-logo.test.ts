import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { copyFixtures, createLlmClient, loadConfig, openDb, type CoreCtx } from '@forgecast/core'
import { beforeEach, describe, expect, it } from 'vitest'
import { generateVideo, injectBrandLogo } from '../src/generate'
import type { VideoSpec } from '../src/videospec'

const HAS_FFMPEG = (() => {
  try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true } catch { return false }
})()

let ctx: CoreCtx
let root: string
let hfDir: string

function baseSpec(): VideoSpec {
  return {
    version: 1, videoId: 'vid-1', slug: 'demo', template: 'flash', createdAt: '2026-09-10T00:00:00.000Z',
    semantic: { hook: null, sourceAssetId: null, sections: [] },
    canvas: { width: 1080, height: 1920 },
    durationSec: 12,
    layers: [
      { id: 'l-hook', kind: 'text', from: 'sec-hook', overridden: false, start: 0, duration: 12, track: 0, content: { kind: 'text', text: 'hi' }, style: {}, effects: [] },
      { id: 'l-cta', kind: 'text', from: 'sec-cta', overridden: false, start: 6, duration: 6, track: 3, content: { kind: 'text', text: 'cta' }, style: {}, effects: [] },
    ],
    audio: { narration: null, bgm: null, beatGrid: null, captionsEnabled: false },
    warnings: [],
  }
}

/** 往 assets 表塞一条 upload 图片素材，并在 workspace 里真落一份文件 */
function seedLogo(projectId: number, rel: string, bytes = 'LOGO'): number {
  const abs = path.join(ctx.config.paths.workspace, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, bytes)
  const info = ctx.db.prepare(
    "INSERT INTO assets (project_id, type, file_path, origin) VALUES (?, 'image', ?, 'upload')",
  ).run(projectId, rel)
  return Number(info.lastInsertRowid)
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-logo-'))
  const config = loadConfig(root, { FORGECAST_VIDEO_MODE: 'stub', FORGECAST_TTS_MODE: 'stub' })
  ctx = { db: openDb(config.paths.db), config, llm: createLlmClient(config.llm) }
  ctx.db.prepare("INSERT INTO projects (slug, brand_name) VALUES ('demo', '快客通')").run()
  ctx.db.prepare("INSERT INTO projects (slug, brand_name) VALUES ('other', '别家')").run()
  const copyDir = path.join(config.paths.workspace, 'demo/copy')
  fs.mkdirSync(copyDir, { recursive: true })
  fs.writeFileSync(path.join(copyDir, 'pain-1.md'), copyFixtures.pain)
  ctx.db.prepare("INSERT INTO assets (project_id, type, hook, file_path) VALUES (1, 'copy', 'pain', 'demo/copy/pain-1.md')").run()
  hfDir = path.join(config.paths.workspace, 'demo', 'hf', 'vid-1')
  fs.mkdirSync(path.join(hfDir, 'assets'), { recursive: true })
})

describe('injectBrandLogo', () => {
  it('kit 无 logoAssetId → 返回原 spec 引用，一个字节都不动（门禁）', () => {
    const spec = baseSpec()
    const warnings: string[] = []
    expect(injectBrandLogo(ctx, spec, { hfDir, projectId: 1, warnings })).toBe(spec)
    expect(warnings).toEqual([])
    expect(fs.existsSync(path.join(hfDir, 'assets', 'media'))).toBe(false)
  })

  it('有 logo → 拷进 assets/media/ 并追加 media-logo 层（几何按需求书）', () => {
    const id = seedLogo(1, 'demo/uploads/logo.png')
    const spec = baseSpec()
    const out = injectBrandLogo(ctx, spec, { hfDir, projectId: 1, logoAssetId: id, warnings: spec.warnings })
    expect(out).not.toBe(spec)
    expect(fs.readFileSync(path.join(hfDir, 'assets', 'media', 'logo.png'), 'utf8')).toBe('LOGO')
    const layer = out.layers.find((l) => l.id === 'media-logo')!
    expect(layer).toEqual({
      id: 'media-logo', kind: 'image', from: null, overridden: false,
      start: 0, duration: 12, track: 4,       // 现有最大 track 3 + 1
      content: { kind: 'image', src: 'assets/media/logo.png' },
      style: { x: 1080 - 240, y: 60, width: 180 },
      effects: [],
    })
    expect(out.layers).toHaveLength(3)
    expect(spec.layers).toHaveLength(2)      // 原 spec 不被 mutate
  })

  it('已有 media-logo → 跳过（幂等），不重复拷贝也不重复加层', () => {
    const id = seedLogo(1, 'demo/uploads/logo.png')
    const spec = baseSpec()
    const once = injectBrandLogo(ctx, spec, { hfDir, projectId: 1, logoAssetId: id, warnings: spec.warnings })
    const twice = injectBrandLogo(ctx, once, { hfDir, projectId: 1, logoAssetId: id, warnings: once.warnings })
    expect(twice).toBe(once)
    expect(fs.readdirSync(path.join(hfDir, 'assets', 'media'))).toEqual(['logo.png'])
  })

  it('素材行没了 / 文件没了 / 跨项目 → warning 不炸，spec 原样返回', () => {
    const spec = baseSpec()
    // 素材行不存在
    let warnings: string[] = []
    expect(injectBrandLogo(ctx, spec, { hfDir, projectId: 1, logoAssetId: 9999, warnings })).toBe(spec)
    expect(warnings).toHaveLength(1)
    // 跨项目
    const otherId = seedLogo(2, 'other/uploads/their.png')
    warnings = []
    expect(injectBrandLogo(ctx, spec, { hfDir, projectId: 1, logoAssetId: otherId, warnings })).toBe(spec)
    expect(warnings).toHaveLength(1)
    // 素材行在但磁盘文件没了
    const gone = seedLogo(1, 'demo/uploads/gone.png')
    fs.rmSync(path.join(ctx.config.paths.workspace, 'demo/uploads/gone.png'))
    warnings = []
    expect(injectBrandLogo(ctx, spec, { hfDir, projectId: 1, logoAssetId: gone, warnings })).toBe(spec)
    expect(warnings).toHaveLength(1)
    expect(fs.existsSync(path.join(hfDir, 'assets', 'media'))).toBe(false)
  })
})

describe('出片管线注入 logo', () => {
  function specOf(slug: string): VideoSpec {
    const dir = path.join(ctx.config.paths.workspace, slug, 'specs')
    const f = fs.readdirSync(dir).find((n) => !n.endsWith('.orig.json'))!
    return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))
  }

  it('kit 有 logoAssetId → hf 管线成片 spec 里有 media-logo 层，文件进包', async () => {
    const id = seedLogo(1, 'demo/uploads/logo.png')
    ctx.db.prepare('UPDATE projects SET brand_kit = ? WHERE id = 1').run(JSON.stringify({ logoAssetId: id }))
    await generateVideo(ctx, { slug: 'demo', tpl: 'flash' })
    const spec = specOf('demo')
    const layer = spec.layers.find((l) => l.id === 'media-logo')
    expect(layer?.content).toEqual({ kind: 'image', src: 'assets/media/logo.png' })
    const hfRoot = path.join(ctx.config.paths.workspace, 'demo', 'hf')
    const [vid] = fs.readdirSync(hfRoot).filter((n) => n !== 'vid-1')
    expect(fs.existsSync(path.join(hfRoot, vid, 'assets', 'media', 'logo.png'))).toBe(true)
    // 渲进 index.html（图层真进了渲染，不只是躺在 spec 里）
    const indexHtml = fs.readFileSync(path.join(hfRoot, vid, 'index.html'), 'utf8')
    expect(indexHtml).toContain('assets/media/logo.png')
    // logo 只设了 width:180 → img 自适配成 width:100%;height:auto，非正方形 logo 也等比不变形
    expect(indexHtml).toContain('<img src="assets/media/logo.png" style="display:block;width:100%;height:auto;object-fit:contain"/>')
  })

  it('kit 无 logoAssetId → spec 里没有任何 media- 层（零变化门禁）', async () => {
    ctx.db.prepare('UPDATE projects SET brand_kit = ? WHERE id = 1').run(JSON.stringify({ primaryColor: '#112233' }))
    await generateVideo(ctx, { slug: 'demo', tpl: 'flash' })
    expect(specOf('demo').layers.some((l) => l.id.startsWith('media-'))).toBe(false)
  })

  it.skipIf(!HAS_FFMPEG)('talk 管线同样注入 media-logo', async () => {
    const id = seedLogo(1, 'demo/uploads/logo.png')
    ctx.db.prepare('UPDATE projects SET brand_kit = ? WHERE id = 1').run(JSON.stringify({ logoAssetId: id }))
    const upAbs = path.join(ctx.config.paths.workspace, 'demo', 'uploads', 'talk.mp4')
    fs.mkdirSync(path.dirname(upAbs), { recursive: true })
    execFileSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=10:duration=2', '-pix_fmt', 'yuv420p', upAbs], { stdio: 'ignore' })
    const info = ctx.db.prepare(
      "INSERT INTO assets (project_id, type, file_path, origin) VALUES (1, 'video', 'demo/uploads/talk.mp4', 'upload')",
    ).run()
    await generateVideo(ctx, { slug: 'demo', tpl: 'talk', uploadAssetId: Number(info.lastInsertRowid) })
    expect(specOf('demo').layers.some((l) => l.id === 'media-logo')).toBe(true)
  })
})
