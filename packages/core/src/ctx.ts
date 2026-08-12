import path from 'node:path'
import type Database from 'better-sqlite3'
import { loadConfig, type ForgecastConfig } from './config'
import { openDb } from './db'
import { createLlmClient, type LlmClient } from './llm'
import { applyStoredSettings, normalizeModes } from './settings'

export interface CoreCtx {
  db: Database.Database
  config: ForgecastConfig
  llm: LlmClient
  /** 本次 config 解析时发生的模式降级说明（live 缺 key 等），供 CLI/接口提示。测试里手搓 ctx 可省略 */
  modeNotes?: string[]
}

/** 把仓库根目录的 .env 灌进 process.env（已存在的真实环境变量优先，不覆盖）。测试从不调用 createCtx，不受影响。 */
function loadRootEnvFile(root?: string): void {
  const envRoot = root ?? process.env.INIT_CWD ?? process.cwd()
  try {
    process.loadEnvFile(path.join(envRoot, '.env'))
  } catch {
    // .env 不存在（如容器里直接注入环境变量）——忽略
  }
}

/** CLI 与 server 共用的上下文工厂。config 优先级：settings 表(设置页) > env > 默认 */
export function createCtx(root?: string, env?: NodeJS.ProcessEnv): CoreCtx {
  if (!env) loadRootEnvFile(root)
  const config = loadConfig(root, env)
  const db = openDb(config.paths.db)
  applyStoredSettings(config, db)
  const modeNotes = normalizeModes(config)
  const llm = createLlmClient(config.llm)
  return { db, config, llm, modeNotes }
}

/** 设置变更后就地刷新：从 env+默认重算并叠加 settings，重建 ctx.llm（mock/live 在创建时决定） */
export function refreshCtx(ctx: CoreCtx): void {
  const fresh = loadConfig(ctx.config.root)
  applyStoredSettings(fresh, ctx.db)
  ctx.modeNotes = normalizeModes(fresh)
  Object.assign(ctx.config.llm, fresh.llm)
  Object.assign(ctx.config.tts, fresh.tts)
  Object.assign(ctx.config.github, fresh.github)
  ctx.llm = createLlmClient(ctx.config.llm)
}
