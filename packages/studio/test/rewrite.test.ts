import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createLlmClient, loadConfig, openDb, type CoreCtx } from '@forgecast/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RewriteUnsupportedError, rewriteSection, stripCodeFence } from '../src/rewrite'
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

/** 同 section 的非 text 图层（caption），用来证明「恰好一层 text 图层」判定不误把它算进去。 */
const captionLayer = (over: Partial<Layer> = {}): Layer => ({
  id: over.id ?? 'l-caption', kind: 'caption', from: over.from ?? 'sec-hook', overridden: over.overridden ?? false,
  start: over.start ?? 0, duration: over.duration ?? 3, track: over.track ?? 2,
  content: over.content ?? { kind: 'caption', text: '字幕' }, style: over.style ?? {}, effects: over.effects ?? [],
})

const baseSpec = (over: Partial<VideoSpec> = {}): VideoSpec => ({
  version: 1, videoId: 'deadbeef01', slug: 's1', template: 'flash', createdAt: '',
  semantic: {
    hook: null, sourceAssetId: null,
    sections: [{ id: 'sec-hook', role: 'hook', text: '原文案' }, { id: 'sec-other', role: 'body', text: '别的段' }],
  },
  canvas: { width: 1080, height: 1920 }, durationSec: 12,
  // 3 层：目标层 + 同 section 的非 text 图层（caption） + from 指向别的 section 的图层
  layers: [textLayer(), captionLayer(), textLayer({ id: 'l-other', from: 'sec-other', start: 5, duration: 4, track: 3, content: { kind: 'text', text: '别的图层文案' } })],
  audio: { narration: null, bgm: null, beatGrid: null, captionsEnabled: false }, warnings: [],
  ...over,
})

describe('rewriteSection mock', () => {
  it('text 段重写返回确定性变体，图层 text 同步、时间轴一字不动，其他图层完全不受影响', async () => {
    const spec = baseSpec()
    const { spec: out, newText } = await rewriteSection(ctx, spec, 'sec-hook')
    expect(newText).toBe('原文案（重写版）')
    expect(out.semantic.sections[0].text).toBe('原文案（重写版）')
    const target = out.layers.find((l) => l.id === 'l-hook')!
    expect(target.content).toEqual({ kind: 'text', text: '原文案（重写版）' })
    expect(target.start).toBe(spec.layers[0].start)
    expect(target.duration).toBe(spec.layers[0].duration)
    expect(target.track).toBe(spec.layers[0].track)
    // 关键不变量：非目标图层（同 section 的 caption 图层、from 指向别的 section 的图层）逐个全等，不被误动
    const otherCaption = out.layers.find((l) => l.id === 'l-caption')!
    expect(otherCaption).toEqual(spec.layers.find((l) => l.id === 'l-caption'))
    const otherLayer = out.layers.find((l) => l.id === 'l-other')!
    expect(otherLayer).toEqual(spec.layers.find((l) => l.id === 'l-other'))
    // 别的 section 的文本也没被误改
    expect(out.semantic.sections[1].text).toBe('别的段')
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

describe('stripCodeFence', () => {
  it('剥掉首尾 markdown 代码围栏', () => {
    expect(stripCodeFence('```\n重写后的文案\n```')).toBe('重写后的文案')
    expect(stripCodeFence('```markdown\n重写后的文案\n```')).toBe('重写后的文案')
  })

  it('不带围栏的文本原样返回（仅 trim）', () => {
    expect(stripCodeFence('  重写后的文案  ')).toBe('重写后的文案')
  })
})
