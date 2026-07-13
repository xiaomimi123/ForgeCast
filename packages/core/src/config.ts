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

export function loadConfig(root?: string, env: NodeJS.ProcessEnv = process.env): ForgecastConfig {
  // root 未显式传入时优先用 env.INIT_CWD（pnpm/npm 会把它设为命令发起目录，即仓库根）兜底，
  // 而不是直接用 process.cwd()：`pnpm --filter <pkg> dev/test` 会把子进程 cwd 切到该包目录下，
  // 若用 process.cwd() 会导致 db/workspace 被建在 packages/server 之类的子目录里。
  const resolvedRoot = root ?? env.INIT_CWD ?? process.cwd()
  const mode: LlmMode = env.FORGECAST_LLM_MODE === 'live' ? 'live' : 'mock'
  if (mode === 'live' && !env.FORGECAST_LLM_KEY) {
    throw new Error('FORGECAST_LLM_MODE=live 时必须设置 FORGECAST_LLM_KEY（.env）')
  }
  return {
    root: resolvedRoot,
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
      workspace: path.join(resolvedRoot, 'workspace'),
      db: path.join(resolvedRoot, 'db', 'forgecast.db'),
      templates: path.join(resolvedRoot, 'templates'),
    },
  }
}
