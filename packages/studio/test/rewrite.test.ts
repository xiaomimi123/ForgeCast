import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createLlmClient, loadConfig, openDb, type CoreCtx } from '@forgecast/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RewriteUnsupportedError, rewriteSection } from '../src/rewrite'
import type { Layer, VideoSpec } from '../src/videospec'

let ctx: CoreCtx
let root: string

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-rewrite-'))
  const config = loadConfig(root) // llm mock 默认
  ctx = { db: openDb(config.paths.db), config, llm: createLlmClient(config.llm) }
})

const textLayer = (over: Partial<Layer> = {}): Layer => ({
  id: over.id ?? 'l-hook', kind: 'text', from: over.from ?? 'sec-hook', overridden: over.overridden ?? false,
  start: over.start ?? 0, duration: over.duration ?? 3, track: over.track ?? 1,
  content: over.content ?? { kind: 'text', text: '原文案' }, style: over.style ?? {}, effects: over.effects ?? [],
})

const baseSpec = (over: Partial<VideoSpec> = {}): VideoSpec => ({
  version: 1, videoId: 'deadbeef01', slug: 's1', template: 'flash', createdAt: '',
  semantic: { hook: null, sourceAssetId: null, sections: [{ id: 'sec-hook', role: 'hook', text: '原文案' }] },
  canvas: { width: 1080, height: 1920 }, durationSec: 12,
  layers: [textLayer()],
  audio: { narration: null, bgm: null, beatGrid: null, captionsEnabled: false }, warnings: [],
  ...over,
})

describe('rewriteSection mock', () => {
  it('text 段重写返回确定性变体，图层 text 同步、时间轴一字不动', async () => {
    const spec = baseSpec()
    const { spec: out, newText } = await rewriteSection(ctx, spec, 'sec-hook')
    expect(newText).toBe('原文案（重写版）')
    expect(out.semantic.sections[0].text).toBe('原文案（重写版）')
    expect(out.layers[0].content).toEqual({ kind: 'text', text: '原文案（重写版）' })
    // 时间轴一字不动
    for (let i = 0; i < spec.layers.length; i++) {
      expect(out.layers[i].start).toBe(spec.layers[i].start)
      expect(out.layers[i].duration).toBe(spec.layers[i].duration)
      expect(out.layers[i].track).toBe(spec.layers[i].track)
    }
  })

  it('mock 不借道 ctx.llm（spy ctx.llm.complete 零调用）', async () => {
    const spy = vi.spyOn(ctx.llm, 'complete')
    await rewriteSection(ctx, baseSpec(), 'sec-hook')
    expect(spy).not.toHaveBeenCalled()
  })

  it('dialogue/stat/shots 段 → RewriteUnsupportedError', async () => {
    const dialogueSpec = baseSpec({
      semantic: { hook: null, sourceAssetId: null, sections: [{ id: 'sec-d', role: 'body', dialogue: [{ who: 'them', text: 'hi' }] }] },
      layers: [textLayer({ from: 'sec-d' })],
    })
    await expect(rewriteSection(ctx, dialogueSpec, 'sec-d')).rejects.toThrow(RewriteUnsupportedError)

    const statSpec = baseSpec({
      semantic: { hook: null, sourceAssetId: null, sections: [{ id: 'sec-s', role: 'stat', stat: { value: '10x', label: 'x' } }] },
      layers: [textLayer({ from: 'sec-s' })],
    })
    await expect(rewriteSection(ctx, statSpec, 'sec-s')).rejects.toThrow(RewriteUnsupportedError)

    const shotsSpec = baseSpec({
      semantic: { hook: null, sourceAssetId: null, sections: [{ id: 'sec-sh', role: 'demo', shots: ['a.png'] }] },
      layers: [textLayer({ from: 'sec-sh' })],
    })
    await expect(rewriteSection(ctx, shotsSpec, 'sec-sh')).rejects.toThrow(RewriteUnsupportedError)
  })

  it('from 该段的文本图层不止一层 → RewriteUnsupportedError', async () => {
    const spec = baseSpec({
      layers: [textLayer({ id: 'l1', from: 'sec-hook' }), textLayer({ id: 'l2', from: 'sec-hook' })],
    })
    await expect(rewriteSection(ctx, spec, 'sec-hook')).rejects.toThrow(RewriteUnsupportedError)
  })

  it('warnings 追加旁白不一致提示，不堆叠', async () => {
    const spec = baseSpec()
    const { spec: out } = await rewriteSection(ctx, spec, 'sec-hook')
    const expected = '「sec-hook」已重写，旁白仍为旧文案，语音与画面文案可能不一致'
    expect(out.warnings.filter((w) => w === expected)).toHaveLength(1)
    // 再重写一次不堆叠
    const { spec: out2 } = await rewriteSection(ctx, out, 'sec-hook')
    expect(out2.warnings.filter((w) => w === expected)).toHaveLength(1)
  })

  it('overridden 图层的标志位不被清掉', async () => {
    const spec = baseSpec({ layers: [textLayer({ overridden: true })] })
    const { spec: out } = await rewriteSection(ctx, spec, 'sec-hook')
    expect(out.layers[0].overridden).toBe(true)
  })
})
