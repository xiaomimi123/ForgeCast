import type Database from 'better-sqlite3'
import type { ForgecastConfig } from './config'

// PUT 白名单：只有这些 key 可写入 settings 表（防止任意键注入）
export const SETTING_KEYS = [
  'llm_mode', 'llm_key', 'llm_base_url', 'model_analysis', 'model_copy', 'model_scoring',
  'tts_mode', 'tts_key', 'tts_model', 'tts_base_url', 'tts_voice',
  'github_mode', 'github_token',
] as const
export type SettingKey = (typeof SETTING_KEYS)[number]

const isKey = (k: string): k is SettingKey => (SETTING_KEYS as readonly string[]).includes(k)

export function getAllSettings(db: Database.Database): Partial<Record<SettingKey, string>> {
  const rows = db.prepare('SELECT key, value FROM settings').all() as Array<{ key: string; value: string }>
  const out: Partial<Record<SettingKey, string>> = {}
  for (const r of rows) if (isKey(r.key)) out[r.key] = r.value
  return out
}

/** 幂等 upsert；仅白名单 key、跳过 undefined（空串合法：表示清空该项） */
export function setSettings(db: Database.Database, kv: Partial<Record<SettingKey, string>>): void {
  const ins = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
  const tx = db.transaction(() => {
    for (const [k, v] of Object.entries(kv)) {
      if (!isKey(k) || v === undefined) continue
      ins.run(k, v)
    }
  })
  tx()
}

/** 把 settings 表非空值覆盖到 config（优先级 stored > env > 默认） */
export function applyStoredSettings(config: ForgecastConfig, db: Database.Database): void {
  const s = getAllSettings(db)
  const put = (v: string | undefined, apply: (val: string) => void) => { if (v && v.trim()) apply(v.trim()) }
  put(s.llm_mode, (v) => { if (v === 'live' || v === 'mock') config.llm.mode = v })
  put(s.llm_key, (v) => { config.llm.apiKey = v })
  put(s.llm_base_url, (v) => { config.llm.baseURL = v })
  put(s.model_analysis, (v) => { config.llm.models.analysis = v })
  put(s.model_copy, (v) => { config.llm.models.copy = v })
  put(s.model_scoring, (v) => { config.llm.models.scoring = v })
  put(s.tts_mode, (v) => { if (v === 'live' || v === 'stub' || v === 'kokoro') config.tts.mode = v })
  put(s.tts_key, (v) => { config.tts.apiKey = v })
  put(s.tts_model, (v) => { config.tts.model = v })
  put(s.tts_voice, (v) => { config.tts.voice = v })
  put(s.tts_base_url, (v) => { config.tts.baseURL = v })
  put(s.github_mode, (v) => { if (v === 'live' || v === 'mock') config.github.mode = v })
  put(s.github_token, (v) => { config.github.token = v })
}

/**
 * live 缺 key 优雅降级为 mock/stub，避免真调用崩。
 * 返回降级说明——静默降级会让人以为在跑 live，实际拿到的是 fixture 文案。
 */
export function normalizeModes(config: ForgecastConfig): string[] {
  const notes: string[] = []
  if (config.llm.mode === 'live' && !config.llm.apiKey) {
    config.llm.mode = 'mock'
    notes.push('LLM 设为 live 但缺 key，已降级 mock（文案来自 fixture，不是真生成）')
  }
  if (config.tts.mode === 'live' && !config.tts.apiKey) {
    config.tts.mode = 'stub'
    notes.push('TTS 设为 live 但缺 key，已降级 stub（占位静音音轨）')
  }
  return notes
}

/** key 打码：空→''；否则 '••••'+后4位 */
export function maskKey(v: string | undefined): string {
  if (!v) return ''
  return v.length <= 4 ? '••••' : `••••${v.slice(-4)}`
}
