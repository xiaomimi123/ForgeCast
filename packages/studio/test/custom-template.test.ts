import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createLlmClient, loadConfig, openDb, type CoreCtx } from '@forgecast/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mockCustomTemplateHtml } from '../src/fixtures/custom-template-fixture'
import {
  ASPECT_DIMENSIONS, bucketCuesBySegments, computeSegmentWindows, createCustomTemplate,
  customTemplateHtmlPath, generateCustomTemplate, validateCustomTemplateHtml,
} from '../src/custom-template'
import type { Pacing } from '../src/benchmark'

let ctx: CoreCtx
let root: string
const PACING: Pacing = { durationSec: 12, segments: [{ start: 0, end: 4 }, { start: 4, end: 8 }, { start: 8, end: 12 }] }

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-custom-tpl-'))
  const config = loadConfig(root, {})
  ctx = { db: openDb(config.paths.db), config, llm: createLlmClient(config.llm) }
})

describe('validateCustomTemplateHtml', () => {
  it('mock fixture 满足全部占位符契约', () => {
    const html = mockCustomTemplateHtml(3, 1080, 1920)
    expect(validateCustomTemplateHtml(html, 3, 1080, 1920)).toEqual([])
  })
  it('缺 seg1_text 占位符 → 报错列表非空', () => {
    const html = mockCustomTemplateHtml(3, 1080, 1920).replace('{{seg1_text}}', '写死文字')
    const errors = validateCustomTemplateHtml(html, 3, 1080, 1920)
    expect(errors.some((e) => e.includes('seg1_text'))).toBe(true)
  })
  it('data-width 不匹配 → 报错', () => {
    const html = mockCustomTemplateHtml(3, 1080, 1920)
    expect(validateCustomTemplateHtml(html, 3, 1920, 1080).some((e) => e.includes('data-width'))).toBe(true)
  })
})

describe('computeSegmentWindows / bucketCuesBySegments', () => {
  it('按比例把拆解节奏映射到目标时长', () => {
    const windows = computeSegmentWindows(PACING.segments, PACING.durationSec, 6)
    expect(windows).toEqual([{ start: 0, end: 2 }, { start: 2, end: 4 }, { start: 4, end: 6 }])
  })
  it('末段严格对齐目标时长（消除浮点误差）', () => {
    const windows = computeSegmentWindows(PACING.segments, PACING.durationSec, 7)
    expect(windows.at(-1)!.end).toBe(7)
  })
  it('segments 为空数组 → 抛错（而非静默返回 [] 或 TypeError）', () => {
    expect(() => computeSegmentWindows([], PACING.durationSec, 6)).toThrow(/segments/)
  })
  it('cue 按时间点落进对应窗口', () => {
    const cues = [{ start: 0.5, end: 1.5, text: 'A' }, { start: 4.2, end: 5, text: 'B' }]
    const windows = [{ start: 0, end: 2 }, { start: 2, end: 4 }, { start: 4, end: 6 }]
    const texts = bucketCuesBySegments(cues, windows)
    expect(texts[0]).toBe('A')
    expect(texts[2]).toBe('B')
  })
  it('窗口没分到 cue 时回退用邻近 cue 文本，不留空串', () => {
    const cues = [{ start: 0.5, end: 1.5, text: '仅这一句' }]
    const windows = [{ start: 0, end: 2 }, { start: 2, end: 4 }]
    const texts = bucketCuesBySegments(cues, windows)
    expect(texts[1]).not.toBe('')
  })
})

describe('generateCustomTemplate mock', () => {
  it('mock 模式返回合法模板，不调用 ctx.llm，不做 hyperframes check', async () => {
    const spy = vi.spyOn(ctx.llm, 'complete')
    const checkSpy = vi.fn(async () => true)
    const r = await generateCustomTemplate(ctx, { pacing: PACING, aspectRatio: 'portrait' }, { checkComposition: checkSpy })
    expect(spy).not.toHaveBeenCalled()
    expect(checkSpy).not.toHaveBeenCalled()
    expect(r.segmentCount).toBe(3)
    expect(validateCustomTemplateHtml(r.html, 3, 1080, 1920)).toEqual([])
  })
})

describe('generateCustomTemplate live（假 LLM）', () => {
  function liveCtx(complete: (...args: any[]) => Promise<string>): CoreCtx {
    const config = loadConfig(fs.mkdtempSync(path.join(os.tmpdir(), 'fc-custom-tpl-live-')), { FORGECAST_LLM_MODE: 'live', FORGECAST_LLM_KEY: 'k' })
    // live 模式要读 templates/prompts/custom-template.md，临时目录里没有，指回仓库真实 templates/
    // （沿用 packages/copywriter/test/script.test.ts 的既有做法）
    config.paths.templates = path.resolve(__dirname, '../../../templates')
    return { db: openDb(config.paths.db), config, llm: { complete: vi.fn(complete) } as any }
  }

  it('首次产出缺占位符 → 重试一次，第二次合法则成功', async () => {
    let call = 0
    const lctx = liveCtx(async () => {
      call += 1
      return call === 1
        ? mockCustomTemplateHtml(3, 1080, 1920).replace('{{seg2_text}}', '写死')
        : mockCustomTemplateHtml(3, 1080, 1920)
    })
    const r = await generateCustomTemplate(lctx, { pacing: PACING, aspectRatio: 'portrait' }, { checkComposition: async () => true })
    expect(call).toBe(2)
    expect(validateCustomTemplateHtml(r.html, 3, 1080, 1920)).toEqual([])
  })

  it('两次都缺占位符 → 抛错，不返回', async () => {
    const lctx = liveCtx(async () => mockCustomTemplateHtml(3, 1080, 1920).replace('{{seg0_start}}', '0'))
    await expect(generateCustomTemplate(lctx, { pacing: PACING, aspectRatio: 'portrait' }, { checkComposition: async () => true }))
      .rejects.toThrow(/校验失败/)
    expect((lctx.llm.complete as any)).toHaveBeenCalledTimes(2)
  })

  it('占位符合法但 hyperframes check 未通过 → 重试一次仍失败则抛错', async () => {
    const lctx = liveCtx(async () => mockCustomTemplateHtml(2, 1920, 1080))
    let checks = 0
    await expect(generateCustomTemplate(
      lctx, { pacing: { durationSec: 8, segments: [{ start: 0, end: 4 }, { start: 4, end: 8 }] }, aspectRatio: 'landscape' },
      { checkComposition: async () => { checks += 1; return false } },
    )).rejects.toThrow(/hyperframes check/)
    expect(checks).toBe(2)
  })
})

describe('createCustomTemplate', () => {
  it('拆解→生成→落库+写模板文件，全链路（mock LLM + 假 probe/detect）', async () => {
    ctx.db.prepare('DELETE FROM custom_templates').run() // 表存在即可，无需预置数据
    const info = await createCustomTemplate(ctx, {
      name: '对标X', aspectRatio: 'portrait', benchmarkAbsPath: '/fake.mp4', benchmarkRelPath: '_templates/x/benchmark.mp4',
    })
    expect(info.name).toBe('对标X')
    const row: any = ctx.db.prepare('SELECT * FROM custom_templates WHERE id = ?').get(info.id)
    expect(row.aspect_ratio).toBe('portrait')
    expect(fs.existsSync(customTemplateHtmlPath(ctx, info.id))).toBe(true)
  })
})
