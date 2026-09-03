import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { copyFixtures, createLlmClient, loadConfig, openDb, type CoreCtx } from '@forgecast/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as remotionRender from '../src/remotion-render'
import { generateVideo, rebuildAudioMix, renderFromSpec } from '../src/generate'
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

/** AudioMix 不落 spec、stub 模式又不跑 mixAudio——四个字段写错在端到端测试里是**静默**的
 *  （评审变异实测：同时把 sfxPath 置 null、durationSec 置 0、去掉 bgVariant，端到端 6/6 仍全绿）。
 *  故对纯函数逐字段断言，把重建规则钉死。 */
describe('rebuildAudioMix（重建规则逐字段钉死）', () => {
  const baseSpec = (over: Record<string, unknown> = {}): VideoSpec => ({
    version: 1, videoId: 'v1', slug: 'demo', template: 'flash', createdAt: '',
    semantic: { hook: null, sourceAssetId: null, sections: [] },
    canvas: { width: 1080, height: 1920 }, durationSec: 17,
    layers: [],
    audio: { narration: null, bgm: null, beatGrid: null, captionsEnabled: false },
    warnings: [],
    ...over,
  } as VideoSpec)

  /** 摆一个带 bgm/sfx 的假 templates 目录，返回 { templatesDir, bgmAbs, sfxAbs }。 */
  function seedTemplates(): { templatesDir: string; bgmAbs: string; sfxAbs: string } {
    const templatesDir = path.join(root, 'tpl-fixture')
    fs.mkdirSync(path.join(templatesDir, 'bgm'), { recursive: true })
    fs.mkdirSync(path.join(templatesDir, 'sfx'), { recursive: true })
    const bgmAbs = path.join(templatesDir, 'bgm', 'a.mp3')
    const sfxAbs = path.join(templatesDir, 'sfx', 'hit.mp3')
    fs.writeFileSync(bgmAbs, 'x'); fs.writeFileSync(sfxAbs, 'x')
    return { templatesDir, bgmAbs, sfxAbs }
  }

  it('四个字段：bgmPath 原样 / sfxPath 来自 templates/sfx / strongBeats 同源 / durationSec = spec.durationSec', () => {
    const { templatesDir, bgmAbs, sfxAbs } = seedTemplates()
    const spec = baseSpec({
      audio: {
        narration: null, bgm: { src: bgmAbs, mood: 'tech' },
        beatGrid: { t0: 0.5, T: 0.5, bpm: 120, strongBeats: [1, 2, 3] }, captionsEnabled: true,
      },
    })
    const { audioMix, missing } = rebuildAudioMix(spec, templatesDir)
    expect(missing).toBe(false)
    expect(audioMix).toEqual({ bgmPath: bgmAbs, sfxPath: sfxAbs, strongBeats: [1, 2, 3], durationSec: 17 })
  })

  it('无 beatGrid → strongBeats 退化为空数组（不是 undefined，mixAudio 要数组）', () => {
    const { templatesDir, bgmAbs } = seedTemplates()
    const spec = baseSpec({ audio: { narration: null, bgm: { src: bgmAbs, mood: null }, beatGrid: null, captionsEnabled: false } })
    expect(rebuildAudioMix(spec, templatesDir).audioMix!.strongBeats).toEqual([])
  })

  it('spec 本就无 BGM → undefined 且 missing=false（不该报「文件缺失」）', () => {
    const { templatesDir } = seedTemplates()
    expect(rebuildAudioMix(baseSpec(), templatesDir)).toEqual({ audioMix: undefined, missing: false })
  })

  it('bgm.src 文件不在 → undefined 且 missing=true（调用方据此 fail-soft）', () => {
    const { templatesDir } = seedTemplates()
    const spec = baseSpec({ audio: { narration: null, bgm: { src: path.join(root, 'gone.mp3'), mood: null }, beatGrid: null, captionsEnabled: false } })
    expect(rebuildAudioMix(spec, templatesDir)).toEqual({ audioMix: undefined, missing: true })
  })
})

describe('renderFromSpec 的透传与继承', () => {
  it('bgVariant 从 spec 透传进 renderRemotion（丢了会让重渲版背景与首渲版不一致）', async () => {
    const { videoId, specAbs } = await seed()
    const spec = readSpec(specAbs)
    spec.bgVariant = 'grid'
    writeSpec(specAbs, spec)
    const spy = vi.spyOn(remotionRender, 'renderRemotion').mockImplementation(async (_s: any, outAbs: string) => {
      fs.mkdirSync(path.dirname(outAbs), { recursive: true }); fs.writeFileSync(outAbs, 'stub')
    })
    try {
      await renderFromSpec(ctx, 'demo', videoId, () => {})
      expect(spy).toHaveBeenCalledTimes(1)
      const [passedSpec, , opts] = spy.mock.calls[0] as any[]
      expect(opts.bgVariant).toBe('grid')
      expect(opts.publicDir).toBe(path.join(ctx.config.paths.workspace, 'demo', 'hf', videoId))
      expect(passedSpec.videoId).toBe(videoId)
    } finally { spy.mockRestore() }
  })

  it('spec.semantic.hook 为 null → 按 sourceAssetId 回查文案行的 hook 落新行（不退化成 NULL）', async () => {
    const { videoId, specAbs } = await seed()
    const spec = readSpec(specAbs)
    expect(spec.semantic.hook).toBeNull()   // 现状：buildSemantic 取不到 hook
    expect(spec.semantic.sourceAssetId).toBe(1)
    writeSpec(specAbs, spec)
    const out = await renderFromSpec(ctx, 'demo', videoId, () => {})
    const row: any = ctx.db.prepare('SELECT * FROM assets WHERE id = ?').get(out.assetId)
    expect(row.hook).toBe('pain')
    expect(out.filePath).toMatch(/flash-pain-/)
  })

  it('上一轮的渲染期 warnings 不跟着新行堆叠（含变量的混音失败消息也清得掉）', async () => {
    const { videoId, specAbs } = await seed()
    const spec = readSpec(specAbs)
    spec.warnings = ['TTS 降级：接口超时', 'BGM 混音失败，保留无背景乐版本：ffmpeg exit 1', 'BGM 文件缺失，本次无背景乐']
    writeSpec(specAbs, spec)
    const out = await renderFromSpec(ctx, 'demo', videoId, () => {})
    const row: any = ctx.db.prepare('SELECT * FROM assets WHERE id = ?').get(out.assetId)
    const warnings = JSON.parse(row.warnings)
    expect(warnings).toEqual(['TTS 降级：接口超时'])   // 生成期的保留，渲染期的清掉
    expect(readSpec(specAbs).warnings).toEqual(['TTS 降级：接口超时'])
  })
})
