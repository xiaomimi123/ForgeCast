import type Database from 'better-sqlite3'
import { loadConfig, type ForgecastConfig } from './config'
import { openDb } from './db'
import { createLlmClient, type LlmClient } from './llm'

export interface CoreCtx {
  db: Database.Database
  config: ForgecastConfig
  llm: LlmClient
}

/** CLI 与 server 共用的上下文工厂 */
export function createCtx(root?: string, env?: NodeJS.ProcessEnv): CoreCtx {
  const config = loadConfig(root, env)
  const db = openDb(config.paths.db)
  const llm = createLlmClient(config.llm)
  return { db, config, llm }
}
