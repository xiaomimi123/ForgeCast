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
  it('live 模式无 key 抛错', () => {
    expect(() => loadConfig('/tmp/x', { FORGECAST_LLM_MODE: 'live' })).toThrow(/FORGECAST_LLM_KEY/)
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
})
