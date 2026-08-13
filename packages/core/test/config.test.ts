import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config'

describe('loadConfig', () => {
  it('默认 mock 模式，无 key 不报错', () => {
    const cfg = loadConfig('/tmp/x', {})
    expect(cfg.llm.mode).toBe('mock')
    expect(cfg.paths.workspace).toBe('/tmp/x/workspace')
    expect(cfg.paths.db).toBe('/tmp/x/db/forgecast.db')
    expect(cfg.paths.templates).toBe('/tmp/x/templates')
  })
  it('live 模式无 key 不抛错（改由 createCtx 的 normalizeModes 降级；key 可来自设置页）', () => {
    const cfg = loadConfig('/tmp/x', { FORGECAST_LLM_MODE: 'live' })
    expect(cfg.llm.mode).toBe('live')
    expect(cfg.llm.apiKey).toBe('')
  })
  it('空串模型名/baseURL（.env 留空）回落默认，不被空覆盖', () => {
    const cfg = loadConfig('/tmp/x', { FORGECAST_MODEL_ANALYSIS: '', FORGECAST_MODEL_COPY: '', FORGECAST_LLM_BASE_URL: '' })
    expect(cfg.llm.models.analysis).toBe('claude-sonnet-5')
    expect(cfg.llm.models.copy).toBe('claude-sonnet-5')
    expect(cfg.llm.baseURL).toBe('https://aitoken.homes/v1')
  })
  it('live 模式读取 key 与模型名', () => {
    const cfg = loadConfig('/tmp/x', {
      FORGECAST_LLM_MODE: 'live', FORGECAST_LLM_KEY: 'sk-1', FORGECAST_MODEL_COPY: 'm-copy',
    })
    expect(cfg.llm.mode).toBe('live')
    expect(cfg.llm.apiKey).toBe('sk-1')
    expect(cfg.llm.models.copy).toBe('m-copy')
  })
  it('未传 root 时用 INIT_CWD 兜底（修 pnpm --filter 切 cwd 的坑）', () => {
    const cfg = loadConfig(undefined, { INIT_CWD: '/repo' })
    expect(cfg.root).toBe('/repo')
    expect(cfg.paths.workspace).toBe('/repo/workspace')
    expect(cfg.paths.db).toBe('/repo/db/forgecast.db')
  })
  it('github 默认 mock，可读 token', () => {
    expect(loadConfig('/tmp/x', {}).github).toEqual({ mode: 'mock', token: '' })
    const cfg = loadConfig('/tmp/x', { FORGECAST_GITHUB_MODE: 'live', FORGECAST_GITHUB_TOKEN: 'ghp_1' })
    expect(cfg.github).toEqual({ mode: 'live', token: 'ghp_1' })
  })
  it('video 默认 render，可设 stub', () => {
    expect(loadConfig('/tmp/x', {}).video).toEqual({ mode: 'render', bgm: '', beatPython: '', captions: false, bg: 'grid', mood: '' })
    expect(loadConfig('/tmp/x', { FORGECAST_VIDEO_MODE: 'stub' }).video).toEqual({ mode: 'stub', bgm: '', beatPython: '', captions: false, bg: 'grid', mood: '' })
    expect(loadConfig('/tmp/x', { FORGECAST_CAPTIONS: 'on' }).video.captions).toBe(true)
    expect(loadConfig('/tmp/x', { FORGECAST_BG: 'synth' }).video.bg).toBe('synth')
    expect(loadConfig('/tmp/x', { FORGECAST_MOOD: 'tense' }).video.mood).toBe('tense')
  })
  it('tts 可设 stub，可设 live', () => {
    expect(loadConfig('/tmp/x', { FORGECAST_TTS_MODE: 'stub' }).tts).toEqual({ mode: 'stub', baseURL: 'https://aitoken.homes/v1', apiKey: '', model: '', voice: '', meloPython: '', cosyHome: '', asrPython: '' })
    const cfg = loadConfig('/tmp/x', { FORGECAST_TTS_MODE: 'live', FORGECAST_TTS_KEY: 'k', FORGECAST_TTS_MODEL: 'm', FORGECAST_TTS_VOICE: 'v' })
    expect(cfg.tts).toEqual({ mode: 'live', baseURL: 'https://aitoken.homes/v1', apiKey: 'k', model: 'm', voice: 'v', meloPython: '', cosyHome: '', asrPython: '' })
  })
  it('FORGECAST_TTS_MODE=kokoro 被识别', () => {
    const c = loadConfig('/tmp/x', { FORGECAST_TTS_MODE: 'kokoro' })
    expect(c.tts.mode).toBe('kokoro')
  })
  it('kokoro 是默认 TTS 模式（未设时）', () => {
    const c = loadConfig('/tmp/x', {})
    expect(c.tts.mode).toBe('kokoro')
  })
  it('video 配置含 bgm 与 beatPython（beatPython 默认回落 melo）', () => {
    const c = loadConfig('/tmp/x', { FORGECAST_MELO_PYTHON: '/venv/melo/py' })
    expect(c.video.bgm).toBe('')
    expect(c.video.beatPython).toBe('/venv/melo/py')
    const c2 = loadConfig('/tmp/x', { FORGECAST_BGM: 'none', FORGECAST_BEAT_PYTHON: '/venv/beat/py' })
    expect(c2.video.bgm).toBe('none')
    expect(c2.video.beatPython).toBe('/venv/beat/py')
  })
  it('asrPython 可显式设置，未设时回落 meloPython，都不设为空串', () => {
    const explicit = loadConfig('/tmp/x', { FORGECAST_ASR_PYTHON: '/venv/asr/py', FORGECAST_MELO_PYTHON: '/venv/melo/py' })
    expect(explicit.tts.asrPython).toBe('/venv/asr/py')
    const fallback = loadConfig('/tmp/x', { FORGECAST_MELO_PYTHON: '/venv/melo/py' })
    expect(fallback.tts.asrPython).toBe('/venv/melo/py')
    const empty = loadConfig('/tmp/x', {})
    expect(empty.tts.asrPython).toBe('')
  })
})
