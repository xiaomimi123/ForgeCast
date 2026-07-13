import path from 'node:path'

export type LlmMode = 'mock' | 'live'
export type GithubMode = 'mock' | 'live'

export interface ForgecastConfig {
  root: string
  llm: {
    mode: LlmMode
    baseURL: string
    apiKey: string
    models: { analysis: string; copy: string; scoring: string }
  }
  github: { mode: GithubMode; token: string }
  paths: { workspace: string; db: string; templates: string }
}

export function loadConfig(root?: string, env: NodeJS.ProcessEnv = process.env): ForgecastConfig {
  // 未传 root 时用 INIT_CWD 兜底（pnpm --filter 会把子进程 cwd 切到包目录）
  const resolvedRoot = root ?? env.INIT_CWD ?? process.cwd()
  const mode: LlmMode = env.FORGECAST_LLM_MODE === 'live' ? 'live' : 'mock'
  if (mode === 'live' && !env.FORGECAST_LLM_KEY) {
    throw new Error('FORGECAST_LLM_MODE=live 时必须设置 FORGECAST_LLM_KEY（.env）')
  }
  const githubMode: GithubMode = env.FORGECAST_GITHUB_MODE === 'live' ? 'live' : 'mock'
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
    github: {
      mode: githubMode,
      token: env.FORGECAST_GITHUB_TOKEN ?? '',
    },
    paths: {
      workspace: path.join(resolvedRoot, 'workspace'),
      db: path.join(resolvedRoot, 'db', 'forgecast.db'),
      templates: path.join(resolvedRoot, 'templates'),
    },
  }
}
