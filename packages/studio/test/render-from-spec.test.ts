import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { copyFixtures, createLlmClient, loadConfig, openDb, type CoreCtx } from '@forgecast/core'
import { beforeEach, describe, expect, it } from 'vitest'
import { generateVideo, renderFromSpec } from '../src/generate'
import type { VideoSpec } from '../src/videospec'

/** 剪辑台「渲成片」：渲**当前编辑态的 spec**，不重跑文案/TTS/lower（那会覆盖手工改动）。 */
let ctx: CoreCtx
let root: string

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-rfs-'))
  const config = loadConfig(root, { FORGECAST_VIDEO_MODE: 'stub', FORGECAST_TTS_MODE: 'stub' })
  ctx = { db: openDb(config.paths.db), config, llm: createLlmClient(config.llm) }
  ctx.db.prepare("INSERT INTO projects (slug, brand_name) VALUES ('demo', '快客通')").run()
  const copyDir = path.join(root, 'workspace/demo/copy')
  fs.mkdirSync(copyDir, { recursive: true })
  fs.writeFileSync(path.join(copyDir, 'pain-1.md'), copyFixtures.pain)
  ctx.db.prepare("INSERT INTO assets (project_id, type, hook, file_path) VALUES (1, 'copy', 'pain', 'demo/copy/pain-1.md')").run()
})

/** 先跑一次正常生成，拿到一条真实的 spec + hf 素材目录，作为「剪辑台已有稿」。 */
async function seed(): Promise<{ assetId: number; videoId: string; specAbs: string }> {
  const out = await generateVideo(ctx, { slug: 'demo', tpl: 'flash', assetId: 1 })
  const row: any = ctx.db.prepare('SELECT * FROM assets WHERE id = ?').get(out.assetId)
  const specAbs = path.join(ctx.config.paths.workspace, row.spec_path)
  const spec: VideoSpec = JSON.parse(fs.readFileSync(specAbs, 'utf8'))
  return { assetId: out.assetId, videoId: spec.videoId, specAbs }
}
const readSpec = (p: string): VideoSpec => JSON.parse(fs.readFileSync(p, 'utf8'))
const writeSpec = (p: string, s: VideoSpec) => fs.writeFileSync(p, JSON.stringify(s, null, 2), 'utf8')

describe('renderFromSpec (stub)', () => {
  it('从既有 spec 渲出占位 mp4 并登记新 asset 行（不覆盖旧行）', async () => {
    const { assetId, videoId } = await seed()
    const before = ctx.db.prepare("SELECT COUNT(*) c FROM assets WHERE type = 'video'").get() as any
    const out = await renderFromSpec(ctx, 'demo', videoId, () => {})
    expect(out.assetId).not.toBe(assetId)
    const after = ctx.db.prepare("SELECT COUNT(*) c FROM assets WHERE type = 'video'").get() as any
    expect(after.c).toBe(before.c + 1)
    expect(fs.existsSync(path.join(ctx.config.paths.workspace, out.filePath))).toBe(true)
    const row: any = ctx.db.prepare('SELECT * FROM assets WHERE id = ?').get(out.assetId)
    expect(row.spec_path).toBe(path.join('demo', 'specs', `${videoId}.json`))
  })

  it('渲的是当前编辑态：手工改过的文字进成片对应的 spec，orig 不动', async () => {
    const { videoId, specAbs } = await seed()
    const spec = readSpec(specAbs)
    const first = spec.layers.find((l) => l.content.kind === 'text')!
    ;(first.content as any).text = '手工改过的钩子'
    first.overridden = true
    writeSpec(specAbs, spec)
    await renderFromSpec(ctx, 'demo', videoId, () => {})
    const after = readSpec(specAbs)
    expect((after.layers.find((l) => l.id === first.id)!.content as any).text).toBe('手工改过的钩子')
    const orig = readSpec(specAbs.replace(/\.json$/, '.orig.json'))
    expect((orig.layers.find((l) => l.id === first.id)!.content as any).text).not.toBe('手工改过的钩子')
  })

  it('spec 不存在 → 抛错消息含 videoId', async () => {
    await expect(renderFromSpec(ctx, 'demo', 'no-such-id', () => {})).rejects.toThrow(/no-such-id/)
  })

  it('hfDir 缺失 → 抛「素材目录」', async () => {
    const { videoId } = await seed()
    fs.rmSync(path.join(ctx.config.paths.workspace, 'demo', 'hf', videoId), { recursive: true, force: true })
    await expect(renderFromSpec(ctx, 'demo', videoId, () => {})).rejects.toThrow(/素材目录/)
  })

  it('bgm.src 指向不存在文件 → 不炸，warnings 追加缺失说明', async () => {
    const { videoId, specAbs } = await seed()
    const spec = readSpec(specAbs)
    spec.audio.bgm = { src: path.join(root, 'nope', 'gone.mp3'), mood: null }
    writeSpec(specAbs, spec)
    const out = await renderFromSpec(ctx, 'demo', videoId, () => {})
    const row: any = ctx.db.prepare('SELECT * FROM assets WHERE id = ?').get(out.assetId)
    expect(JSON.parse(row.warnings)).toContain('BGM 文件缺失，本次无背景乐')
    expect(readSpec(specAbs).warnings).toContain('BGM 文件缺失，本次无背景乐')
  })

  it('渲染后 spec.semantic.sourceAssetId 原样保留（新 asset 仍关联同一文案）', async () => {
    const { videoId, specAbs } = await seed()
    expect(readSpec(specAbs).semantic.sourceAssetId).toBe(1)
    await renderFromSpec(ctx, 'demo', videoId, () => {})
    expect(readSpec(specAbs).semantic.sourceAssetId).toBe(1)
  })
})
