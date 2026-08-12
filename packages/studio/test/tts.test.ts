import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createLlmClient, loadConfig, openDb, type CoreCtx } from '@forgecast/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanNarrationText, synthesizeVoice } from '../src/tts'

let ctx: CoreCtx
let root: string
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-tts-'))
  const config = loadConfig(root, {}) // tts stub
  ctx = { db: openDb(config.paths.db), config, llm: createLlmClient(config.llm) }
})

describe('synthesizeVoice stub', () => {
  it('切句成字幕、写占位 wav、不发网络', async () => {
    const out = path.join(root, 'workspace/demo/videos/a.wav')
    const fetchSpy = vi.fn()
    const r = await synthesizeVoice(ctx, '第一句话。第二句更长一些的话！第三句', out, { fetchImpl: fetchSpy })
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(r.cues.length).toBe(3)
    expect(r.cues[0].start).toBe(0)
    expect(r.cues[1].start).toBeCloseTo(r.cues[0].end, 5)
    expect(r.cues[0].end).toBeGreaterThan(r.cues[0].start)
    expect(fs.existsSync(out)).toBe(true)
    expect(fs.statSync(out).size).toBeGreaterThan(0)
    expect(r.audioRel).toBe(path.join('demo', 'videos', 'a.wav'))
  })
})

/** live 上下文：把 env 直接喂给 loadConfig，避免依赖进程环境 */
function liveCtx(env: Record<string, string>): CoreCtx {
  const config = loadConfig(root, {
    FORGECAST_TTS_MODE: 'live',
    FORGECAST_TTS_KEY: 'sk-test',
    FORGECAST_TTS_MODEL: 'tts-1',
    ...env,
  })
  return { db: ctx.db, config, llm: createLlmClient(config.llm) }
}

describe('synthesizeVoice live', () => {
  it('成功时写入返回的音频字节，且请求 wav 格式', async () => {
    const out = path.join(root, 'workspace/demo/videos/live-ok.wav')
    const fetchSpy = vi.fn(async () => new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 }))
    const r = await synthesizeVoice(liveCtx({}), '一句话。', out, { fetchImpl: fetchSpy })
    expect(r.degraded).toBeUndefined()
    expect(fs.readFileSync(out)).toEqual(Buffer.from([1, 2, 3, 4]))
    const body = JSON.parse((fetchSpy.mock.calls[0] as any)[1].body)
    expect(body.response_format).toBe('wav')
    expect(body.model).toBe('tts-1')
  })

  it('HTTP 错误时回落占位音轨并带出原因，不抛异常', async () => {
    const out = path.join(root, 'workspace/demo/videos/live-500.wav')
    const fetchSpy = vi.fn(async () => new Response('upstream boom', { status: 500 }))
    const r = await synthesizeVoice(liveCtx({}), '一句话。', out, { fetchImpl: fetchSpy })
    expect(r.degraded).toContain('500')
    expect(r.degraded).toContain('upstream boom')
    expect(fs.existsSync(out)).toBe(true)
    expect(r.cues.length).toBe(1)
  })

  it('空音频响应算降级，不当成功', async () => {
    const out = path.join(root, 'workspace/demo/videos/live-empty.wav')
    const fetchSpy = vi.fn(async () => new Response(new Uint8Array([]), { status: 200 }))
    const r = await synthesizeVoice(liveCtx({}), '一句话。', out, { fetchImpl: fetchSpy })
    expect(r.degraded).toContain('空音频')
  })

  it('缺 key / 缺模型名时不发请求，直接说明缺什么', async () => {
    const fetchSpy = vi.fn()
    const noKey = await synthesizeVoice(
      liveCtx({ FORGECAST_TTS_KEY: '' }), '一句话。',
      path.join(root, 'workspace/demo/videos/nokey.wav'), { fetchImpl: fetchSpy },
    )
    const noModel = await synthesizeVoice(
      liveCtx({ FORGECAST_TTS_MODEL: '' }), '一句话。',
      path.join(root, 'workspace/demo/videos/nomodel.wav'), { fetchImpl: fetchSpy },
    )
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(noKey.degraded).toContain('FORGECAST_TTS_KEY')
    expect(noModel.degraded).toContain('FORGECAST_TTS_MODEL')
  })
})

describe('synthesizeVoice kokoro', () => {
  it('kokoro 模式调 runKokoro 写 wav，成功不降级', async () => {
    const out = path.join(root, 'workspace/demo/videos/k.wav')
    const config = loadConfig(root, { FORGECAST_TTS_MODE: 'kokoro' })
    const kctx: CoreCtx = { db: ctx.db, config, llm: ctx.llm }
    const runKokoro = vi.fn(async (_text: string, outPath: string) => {
      fs.mkdirSync(path.dirname(outPath), { recursive: true })
      fs.writeFileSync(outPath, Buffer.from([1, 2, 3, 4]))
    })
    const r = await synthesizeVoice(kctx, '一句话。', out, { runKokoro })
    expect(runKokoro).toHaveBeenCalledOnce()
    expect(r.degraded).toBeUndefined()
    expect(fs.readFileSync(out).length).toBe(4)
    expect(r.cues.length).toBe(1)
  })

  it('kokoro 失败时降级占位并带原因', async () => {
    const out = path.join(root, 'workspace/demo/videos/kf.wav')
    const config = loadConfig(root, { FORGECAST_TTS_MODE: 'kokoro' })
    const kctx: CoreCtx = { db: ctx.db, config, llm: ctx.llm }
    const runKokoro = vi.fn(async () => { throw new Error('kokoro-onnx 未安装') })
    const r = await synthesizeVoice(kctx, '一句话。', out, { runKokoro })
    expect(r.degraded).toContain('kokoro-onnx 未安装')
    expect(fs.existsSync(out)).toBe(true) // 占位 wav
  })
})

describe('cleanNarrationText', () => {
  it('去掉【节奏标记】与（画面指示）括号，保留正文', () => {
    const raw = '【0-3s 钩子】（大字弹出）开网店的谁没熬过夜。【3-8s 痛点】漏回一条差评就来'
    const out = cleanNarrationText(raw)
    expect(out).not.toContain('【')
    expect(out).not.toContain('（')
    expect(out).toContain('开网店的谁没熬过夜')
    expect(out).toContain('漏回一条差评就来')
  })
  it('半角括号也去掉', () => {
    expect(cleanNarrationText('正文(旁白)结尾')).toBe('正文结尾')
  })
  it('整行"画面：xxx"是镜头指示，整行丢弃，不进旁白/字幕', () => {
    const raw = '【0-3s 钩子】\n画面：手机聊天记录，甲方发来一句话\n台词：接外包的兄弟，这句话你熟不熟？'
    const out = cleanNarrationText(raw)
    expect(out).not.toContain('画面')
    expect(out).not.toContain('手机聊天记录')
    expect(out).toContain('接外包的兄弟，这句话你熟不熟？')
  })
  it('"台词：xxx"只剥标签前缀，保留台词原文', () => {
    expect(cleanNarrationText('台词：这是台词内容')).toBe('这是台词内容')
  })
  it('半角冒号形式"画面:"/"台词:"同样处理', () => {
    const raw = '画面:一段画面描述\n台词:一句台词'
    const out = cleanNarrationText(raw)
    expect(out).not.toContain('画面')
    expect(out).not.toContain('一段画面描述')
    expect(out).toBe('一句台词')
  })
})

describe('synthesizeVoice melo', () => {
  it('melo 模式调 runMelo 写 wav，成功不降级', async () => {
    const out = path.join(root, 'workspace/demo/videos/m.wav')
    const config = loadConfig(root, { FORGECAST_TTS_MODE: 'melo', FORGECAST_MELO_PYTHON: '/fake/py' })
    const mctx: CoreCtx = { db: ctx.db, config, llm: ctx.llm }
    const runMelo = vi.fn(async (_t: string, o: string) => { fs.mkdirSync(path.dirname(o), { recursive: true }); fs.writeFileSync(o, Buffer.from([1, 2, 3, 4])) })
    const r = await synthesizeVoice(mctx, '一句话。', out, { runMelo })
    expect(runMelo).toHaveBeenCalledOnce()
    expect(r.degraded).toBeUndefined()
    expect(fs.readFileSync(out).length).toBe(4)
  })
  it('melo 缺 FORGECAST_MELO_PYTHON 时降级并说明', async () => {
    const out = path.join(root, 'workspace/demo/videos/m2.wav')
    const config = loadConfig(root, { FORGECAST_TTS_MODE: 'melo' })
    const mctx: CoreCtx = { db: ctx.db, config, llm: ctx.llm }
    const runMelo = vi.fn()
    const r = await synthesizeVoice(mctx, '一句话。', out, { runMelo })
    expect(runMelo).not.toHaveBeenCalled()
    expect(r.degraded).toContain('FORGECAST_MELO_PYTHON')
  })
  it('melo 失败降级带原因', async () => {
    const out = path.join(root, 'workspace/demo/videos/m3.wav')
    const config = loadConfig(root, { FORGECAST_TTS_MODE: 'melo', FORGECAST_MELO_PYTHON: '/fake/py' })
    const mctx: CoreCtx = { db: ctx.db, config, llm: ctx.llm }
    const runMelo = vi.fn(async () => { throw new Error('venv 不存在') })
    const r = await synthesizeVoice(mctx, '一句话。', out, { runMelo })
    expect(r.degraded).toContain('venv 不存在')
    expect(fs.existsSync(out)).toBe(true)
  })
})

describe('synthesizeVoice cosy', () => {
  it('cosy 模式调 runCosy 写 wav，成功不降级', async () => {
    const out = path.join(root, 'workspace/demo/videos/c.wav')
    const config = loadConfig(root, { FORGECAST_TTS_MODE: 'cosy', FORGECAST_COSY_HOME: '/fake/cosy' })
    const cctx: CoreCtx = { db: ctx.db, config, llm: ctx.llm }
    const runCosy = vi.fn(async (_t: string, o: string) => { fs.mkdirSync(path.dirname(o), { recursive: true }); fs.writeFileSync(o, Buffer.from([1, 2, 3, 4])) })
    const r = await synthesizeVoice(cctx, '一句话。', out, { runCosy })
    expect(runCosy).toHaveBeenCalledOnce()
    expect(r.degraded).toBeUndefined()
  })
  it('cosy 缺 FORGECAST_COSY_HOME 降级', async () => {
    const out = path.join(root, 'workspace/demo/videos/c2.wav')
    const config = loadConfig(root, { FORGECAST_TTS_MODE: 'cosy' })
    const cctx: CoreCtx = { db: ctx.db, config, llm: ctx.llm }
    const runCosy = vi.fn()
    const r = await synthesizeVoice(cctx, '一句话。', out, { runCosy })
    expect(runCosy).not.toHaveBeenCalled()
    expect(r.degraded).toContain('FORGECAST_COSY_HOME')
  })
})

describe('synthesizeVoice ASR 对齐', () => {
  it('kokoro 成功后 ASR 对齐成功 → cues 用对齐结果而非估算值', async () => {
    const out = path.join(root, 'workspace/demo/videos/asr-ok.wav')
    const config = loadConfig(root, { FORGECAST_TTS_MODE: 'kokoro' })
    const kctx: CoreCtx = { db: ctx.db, config, llm: ctx.llm }
    const runKokoro = vi.fn(async (_text: string, outPath: string) => {
      fs.mkdirSync(path.dirname(outPath), { recursive: true })
      fs.writeFileSync(outPath, Buffer.from([1, 2, 3, 4]))
    })
    const alignCuesMock = vi.fn(async () => [{ start: 0.5, end: 1.9 }])
    const r = await synthesizeVoice(kctx, '一句话。', out, { runKokoro, alignCues: alignCuesMock })
    expect(alignCuesMock).toHaveBeenCalledWith(out, ['一句话'], '')
    expect(r.cues).toEqual([{ start: 0.5, end: 1.9, text: '一句话' }])
  })

  it('kokoro 成功但 ASR 对齐失败(返回 null) → cues 仍是原来的估算值（回归）', async () => {
    const out = path.join(root, 'workspace/demo/videos/asr-fail.wav')
    const config = loadConfig(root, { FORGECAST_TTS_MODE: 'kokoro' })
    const kctx: CoreCtx = { db: ctx.db, config, llm: ctx.llm }
    const runKokoro = vi.fn(async (_text: string, outPath: string) => {
      fs.mkdirSync(path.dirname(outPath), { recursive: true })
      fs.writeFileSync(outPath, Buffer.from([1, 2, 3, 4]))
    })
    const alignCuesMock = vi.fn(async () => null)
    const r = await synthesizeVoice(kctx, '一句话。', out, { runKokoro, alignCues: alignCuesMock })
    expect(alignCuesMock).toHaveBeenCalledOnce()
    expect(r.cues.length).toBe(1)
    expect(r.cues[0].text).toBe('一句话')
    expect(r.cues[0].start).toBe(0) // 原有估算逻辑：首句从 0 开始
  })

  it('stub 模式不调用 alignCues（没有真实音频可对齐）', async () => {
    // 注意：外层 beforeEach 的 ctx 用 loadConfig(root, {}) 建，TTS 默认模式是 kokoro 不是
    // stub（config.ts 未设 FORGECAST_TTS_MODE 时回落 'kokoro'）——这里必须显式建一个
    // stub 模式的 ctx，不能直接用外层 ctx，否则会真的尝试 spawn kokoro。
    const out = path.join(root, 'workspace/demo/videos/asr-stub.wav')
    const config = loadConfig(root, { FORGECAST_TTS_MODE: 'stub' })
    const stubCtx: CoreCtx = { db: ctx.db, config, llm: ctx.llm }
    const alignCuesMock = vi.fn(async () => [{ start: 0, end: 1 }])
    const r = await synthesizeVoice(stubCtx, '一句话。', out, { alignCues: alignCuesMock })
    expect(alignCuesMock).not.toHaveBeenCalled()
    expect(r.cues[0].text).toBe('一句话')
  })

  it('TTS 本身失败(降级 stub) → 不调用 alignCues', async () => {
    const out = path.join(root, 'workspace/demo/videos/asr-degrade.wav')
    const config = loadConfig(root, { FORGECAST_TTS_MODE: 'kokoro' })
    const kctx: CoreCtx = { db: ctx.db, config, llm: ctx.llm }
    const runKokoro = vi.fn(async () => { throw new Error('kokoro-onnx 未安装') })
    const alignCuesMock = vi.fn(async () => [{ start: 0, end: 1 }])
    const r = await synthesizeVoice(kctx, '一句话。', out, { runKokoro, alignCues: alignCuesMock })
    expect(alignCuesMock).not.toHaveBeenCalled()
    expect(r.degraded).toContain('kokoro-onnx 未安装')
  })
})
