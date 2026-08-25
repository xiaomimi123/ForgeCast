import path from 'node:path'

export type LlmMode = 'mock' | 'live'
export type GithubMode = 'mock' | 'live'
export type VideoMode = 'render' | 'stub'
export type RebrandExecMode = 'mock' | 'live'
export type TtsMode = 'stub' | 'live' | 'kokoro' | 'melo' | 'cosy'

export interface ForgecastConfig {
  root: string
  llm: {
    mode: LlmMode
    baseURL: string
    apiKey: string
    models: { analysis: string; copy: string; scoring: string }
  }
  github: { mode: GithubMode; token: string }
  scout: { weights: { rebrandCost: number; buyerClarity: number; visualAppeal: number } }
  video: { mode: VideoMode; bgm: string; beatPython: string; captions: boolean; bg: string; mood: string }
  rebrandExec: { mode: RebrandExecMode }
  tts: { mode: TtsMode; baseURL: string; apiKey: string; model: string; voice: string; meloPython: string; cosyHome: string; asrPython: string }
  paths: { workspace: string; db: string; templates: string }
}

export function loadConfig(root?: string, env: NodeJS.ProcessEnv = process.env): ForgecastConfig {
  // 未传 root 时用 INIT_CWD 兜底（pnpm --filter 会把子进程 cwd 切到包目录）
  const resolvedRoot = root ?? env.INIT_CWD ?? process.cwd()
  // live 但缺 key 不再直接 throw——key 可由设置页(settings 表)提供，createCtx 中 normalizeModes 会对仍缺 key 的 live 降级
  const mode: LlmMode = env.FORGECAST_LLM_MODE === 'live' ? 'live' : 'mock'
  const githubMode: GithubMode = env.FORGECAST_GITHUB_MODE === 'live' ? 'live' : 'mock'
  const videoMode: VideoMode = env.FORGECAST_VIDEO_MODE === 'stub' ? 'stub' : 'render'
  const rebrandExecMode: RebrandExecMode = env.FORGECAST_REBRAND_EXEC_MODE === 'live' ? 'live' : 'mock'
  return {
    root: resolvedRoot,
    // baseURL/模型名用 || 回落：空串（.env 里留空的变量）也走默认，而非把默认覆盖成空
    llm: {
      mode,
      baseURL: env.FORGECAST_LLM_BASE_URL || 'https://aitoken.homes/v1',
      apiKey: env.FORGECAST_LLM_KEY ?? '',
      models: {
        analysis: env.FORGECAST_MODEL_ANALYSIS || 'claude-sonnet-5',
        copy: env.FORGECAST_MODEL_COPY || 'claude-sonnet-5',
        scoring: env.FORGECAST_MODEL_SCORING || 'claude-haiku-4-5',
      },
    },
    github: { mode: githubMode, token: env.FORGECAST_GITHUB_TOKEN ?? '' },
    scout: { weights: { rebrandCost: 30, buyerClarity: 40, visualAppeal: 30 } },
    video: {
      mode: videoMode,
      bgm: env.FORGECAST_BGM ?? '',
      beatPython: env.FORGECAST_BEAT_PYTHON || env.FORGECAST_MELO_PYTHON || '',
      // 烧进视频的旁白字幕：默认关（模板大字标题已承担主要信息，底部逐句字幕刷屏影响观感）；on/1/true 开
      captions: /^(on|1|true)$/i.test(env.FORGECAST_CAPTIONS ?? ''),
      // 科技感背景变体：grid(赛博网格)/aurora(极光)/matrix(数据雨)/synth(合成波)/mesh(深空)，默认 grid
      bg: env.FORGECAST_BG || 'grid',
      // 情绪键（tense/upbeat/tech/warm）：空=按 hook 自动映射；显式指定则覆盖
      mood: env.FORGECAST_MOOD || '',
    },
    rebrandExec: { mode: rebrandExecMode },
    tts: {
      // 默认 kokoro（离线中文配音）；显式指定 live/stub 时按指定走
      mode: env.FORGECAST_TTS_MODE === 'live' ? 'live'
        : env.FORGECAST_TTS_MODE === 'stub' ? 'stub'
        : env.FORGECAST_TTS_MODE === 'melo' ? 'melo'
        : env.FORGECAST_TTS_MODE === 'cosy' ? 'cosy'
        : 'kokoro',
      baseURL: env.FORGECAST_TTS_BASE_URL || 'https://aitoken.homes/v1',
      apiKey: env.FORGECAST_TTS_KEY ?? '',
      model: env.FORGECAST_TTS_MODEL ?? '',
      voice: env.FORGECAST_TTS_VOICE ?? '',
      meloPython: env.FORGECAST_MELO_PYTHON ?? '',
      cosyHome: env.FORGECAST_COSY_HOME ?? '',
      // 字幕对齐用 ASR 的 venv；缺省回落 meloPython（跟 video.beatPython 同样的回落写法）
      asrPython: env.FORGECAST_ASR_PYTHON || env.FORGECAST_MELO_PYTHON || '',
    },
    paths: {
      workspace: path.join(resolvedRoot, 'workspace'),
      db: path.join(resolvedRoot, 'db', 'forgecast.db'),
      templates: path.join(resolvedRoot, 'templates'),
    },
  }
}
