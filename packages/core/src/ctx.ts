import type Database from 'better-sqlite3'
import { loadConfig, type ForgecastConfig } from './config'
import { openDb } from './db'
import { createLlmClient, type LlmClient } from './llm'
import { applyStoredSettings, normalizeModes } from './settings'

export interface CoreCtx {
  db: Database.Database
  config: ForgecastConfig
  llm: LlmClient
}

/** CLI 与 server 共用的上下文工厂。config 优先级：settings 表(设置页) > env > 默认 */
export function createCtx(root?: string, env?: NodeJS.ProcessEnv): CoreCtx {
  const config = loadConfig(root, env)
  const db = openDb(config.paths.db)
  applyStoredSettings(config, db)
  normalizeModes(config)
  const llm = createLlmClient(config.llm)
  return { db, config, llm }
}

/** 设置变更后就地刷新：从 env+默认重算并叠加 settings，重建 ctx.llm（mock/live 在创建时决定） */
export function refreshCtx(ctx: CoreCtx): void {
  const fresh = loadConfig(ctx.config.root)
  applyStoredSettings(fresh, ctx.db)
  normalizeModes(fresh)
  Object.assign(ctx.config.llm, fresh.llm)
  Object.assign(ctx.config.tts, fresh.tts)
  Object.assign(ctx.config.github, fresh.github)
  ctx.llm = createLlmClient(ctx.config.llm)
}
