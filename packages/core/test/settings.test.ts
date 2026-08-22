import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config'
import { openDb } from '../src/db'
import { applyStoredSettings, getAllSettings, maskKey, normalizeModes, setSettings } from '../src/settings'

let db: ReturnType<typeof openDb>
let root: string
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-set-'))
  db = openDb(path.join(root, 'db', 't.db'))
})

describe('setSettings / getAllSettings', () => {
  it('往返读写；白名单外的 key 被忽略', () => {
    setSettings(db, { llm_key: 'sk-123', model_copy: 'gpt-x', evil: 'x' } as any)
    const s = getAllSettings(db)
    expect(s.llm_key).toBe('sk-123')
    expect(s.model_copy).toBe('gpt-x')
    expect((s as any).evil).toBeUndefined()
  })
  it('upsert 幂等，覆盖旧值', () => {
    setSettings(db, { llm_key: 'a' })
    setSettings(db, { llm_key: 'b' })
    expect(getAllSettings(db).llm_key).toBe('b')
    expect((db.prepare('SELECT COUNT(*) c FROM settings').get() as any).c).toBe(1)
  })
  it('auto_scout 系列 key 在白名单内可往返', () => {
    setSettings(db, { auto_scout: 'off', auto_scout_time: '09:30', auto_scout_last_run: '2026-08-09', auto_scout_last_result: '{"added":3}' })
    const s = getAllSettings(db)
    expect(s.auto_scout).toBe('off')
    expect(s.auto_scout_time).toBe('09:30')
    expect(s.auto_scout_last_run).toBe('2026-08-09')
    expect(s.auto_scout_last_result).toBe('{"added":3}')
  })
})

describe('applyStoredSettings', () => {
  it('stored 非空覆盖 env/默认', () => {
    const config = loadConfig(root, { FORGECAST_LLM_KEY: 'env-key' })
    setSettings(db, { llm_key: 'ui-key', llm_mode: 'live', model_copy: 'my-model', tts_key: 'tk', tts_mode: 'live', github_token: 'gh' })
    applyStoredSettings(config, db)
    expect(config.llm.apiKey).toBe('ui-key') // stored 覆盖 env
    expect(config.llm.mode).toBe('live')
    expect(config.llm.models.copy).toBe('my-model')
    expect(config.tts.apiKey).toBe('tk')
    expect(config.github.token).toBe('gh')
  })
  it('stored 空则保留 env 值', () => {
    const config = loadConfig(root, { FORGECAST_LLM_KEY: 'env-key' })
    setSettings(db, { llm_key: '   ' }) // 空白视为未设
    applyStoredSettings(config, db)
    expect(config.llm.apiKey).toBe('env-key')
  })
  it('tts_mode 支持 kokoro（白名单需含新模式，否则 Web 设置页存不了）', () => {
    const config = loadConfig(root, {})
    setSettings(db, { tts_mode: 'kokoro' })
    applyStoredSettings(config, db)
    expect(config.tts.mode).toBe('kokoro')
  })
  it('scout_weight_* 非空数字覆盖默认权重', () => {
    const config = loadConfig(root, {})
    expect(config.scout.weights).toEqual({ rebrandCost: 30, buyerClarity: 40, visualAppeal: 30 })
    setSettings(db, { scout_weight_rebrand: '20', scout_weight_buyer: '50', scout_weight_visual: '15' })
    applyStoredSettings(config, db)
    expect(config.scout.weights).toEqual({ rebrandCost: 20, buyerClarity: 50, visualAppeal: 15 })
  })
  it('scout_weight_* 非法值（NaN/负数/空白）不覆盖，保留默认', () => {
    const config = loadConfig(root, {})
    setSettings(db, { scout_weight_rebrand: 'abc', scout_weight_buyer: '-5', scout_weight_visual: '   ' })
    applyStoredSettings(config, db)
    expect(config.scout.weights).toEqual({ rebrandCost: 30, buyerClarity: 40, visualAppeal: 30 })
  })
})

describe('normalizeModes', () => {
  it('live 缺 key 降级', () => {
    const config = loadConfig(root, {})
    config.llm.mode = 'live'; config.llm.apiKey = ''
    config.tts.mode = 'live'; config.tts.apiKey = ''
    const notes = normalizeModes(config)
    expect(config.llm.mode).toBe('mock')
    expect(config.tts.mode).toBe('stub')
    // 降级必须可见：只改模式不出声，会让 live 跑成 fixture 而无人察觉
    expect(notes).toHaveLength(2)
    expect(notes.join()).toContain('LLM')
    expect(notes.join()).toContain('TTS')
  })
  it('live 有 key 不动', () => {
    const config = loadConfig(root, {})
    config.llm.mode = 'live'; config.llm.apiKey = 'k'
    expect(normalizeModes(config)).toEqual([])
    expect(config.llm.mode).toBe('live')
  })
  it('kokoro 模式不被 normalizeModes 降级', () => {
    const config = loadConfig(root, {})
    config.tts.mode = 'kokoro'; config.tts.apiKey = ''
    normalizeModes(config)
    expect(config.tts.mode).toBe('kokoro')
  })
})

describe('maskKey', () => {
  it('打码只留后4位；空→空', () => {
    expect(maskKey('sk-abcd1234')).toBe('••••1234')
    expect(maskKey('')).toBe('')
    expect(maskKey(undefined)).toBe('')
    expect(maskKey('ab')).toBe('••••')
  })
})
