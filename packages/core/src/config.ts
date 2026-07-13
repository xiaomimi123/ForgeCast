import path from 'node:path'

export type LlmMode = 'mock' | 'live'

export interface ForgecastConfig {
  root: string
  llm: {
    mode: LlmMode
    baseURL: string
    apiKey: string
    models: { analysis: string; copy: string; scoring: string }
  }
  paths: { workspace: string; db: string; templates: string }
}

export function loadConfig(root: string = process.cwd(), env: NodeJS.ProcessEnv = process.env): ForgecastConfig {
  const mode: LlmMode = env.FORGECAST_LLM_MODE === 'live' ? 'live' : 'mock'
  if (mode === 'live' && !env.FORGECAST_LLM_KEY) {
    throw new Error('FORGECAST_LLM_MODE=live 时必须设置 FORGECAST_LLM_KEY（.env）')
  }
  return {
    root,
    llm: {
      mode,
      baseURL: env.FORGECAST_LLM_BASE_URL ?? 'https://aitoken.homes/v1',
      apiKey: env.FORGECAST_LLM_KEY ?? '',
      models: {
        analysis: env.FORGECAST_MODEL_ANALYSIS ?? 'claude-sonnet-5',
        copy: env.FORGECAST_MODEL_COPY ?? 'claude-sonnet-5',
        scoring: env.FORGECAST_MODEL_SCORING ?? 'claude-haiku-4-5',
      },
    },
    paths: {
      workspace: path.join(root, 'workspace'),
      db: path.join(root, 'db', 'forgecast.db'),
      templates: path.join(root, 'templates'),
    },
  }
}
