export interface Project {
  id: number; slug: string; candidate_id: number | null
  brand_name: string | null; target_buyer: string | null
  demo_url: string | null; price_deploy: number | null; price_custom: number | null
  stage: string; analysisMd?: string; rebrandMd?: string
  analysis_summary?: { targetBuyer: string; painPoint: string }
  /** 立项时继承自候选（candidate_id 为空或候选未生成过说明书/评分时为 null），JSON 字符串需自行解析 */
  intro_detail: string | null
  score_detail: string | null
  /** 泳道卡片用的真实产物计数；GET /api/projects/:slug 详情接口不带 */
  counts?: { copies: number; videos: number; published: number; leads: number }
}
export interface Asset {
  id: number; project_id: number; type: 'copy' | 'cover' | 'video' | 'script'; hook: string | null
  file_path: string; status: 'draft' | 'approved' | 'published'; warnings: string | null
  published_at: string | null; platform: string | null; published_url: string | null
  /** JSON 字符串 {views,likes,leads,recordedAt}，自行解析 */
  perf: string | null
  /** 视频来源：rendered 模板渲染 / upload 用户上传成片（非 video 类型恒为默认 rendered） */
  origin: 'rendered' | 'upload'
  /** JSON 字符串审片报告 {scores,suggestions,transcript?,metrics,degraded?,reviewedAt}，自行解析 */
  review: string | null
  /** JSON 字符串复盘 {verdict,keep,change,focus,generatedAt,hadPerf}，自行解析 */
  retro: string | null
}
/** GET /api/bgm：曲库列表，根目录 + 情绪子目录（tense/upbeat/tech/warm，存在才有 key） */
export interface BgmList { root: string[]; byMood: Record<string, string[]> }
/** 需求信号（demand_signals 行）。evidence 是 JSON 串自行解析 */
export interface DemandSignal {
  id: number; source: string; kind: 'traffic' | 'emotional' | 'supply' | null
  title: string; summary: string | null; evidence: string | null; heat: number | null
  opportunity: string | null; status: 'new' | 'starred' | 'dismissed' | 'matched'
  captured_at: string | null; created_at: string
}
export interface DemandCollectStatus { requestedAt: string | null; lastCollectedAt: string | null }
/** 需求×项目匹配结果（demand_matches 行）。score_detail 是 JSON 串自行解析 */
export interface DemandMatch {
  id: number; signal_id: number; repo: string; url: string; description: string | null
  license: string | null; license_ok: number; stars: number; last_commit: string | null
  score: number; score_detail: string; biz_mode: 'shop' | 'custom' | 'both'; biz_plan: string
  created_at: string
}
export interface TaskEvent { ts: number; type: 'log' | 'done' | 'error'; message: string }
export interface IntroDetail {
  summary: string; features: string[]; targetUser: string
  painPoint: string; rebrandIdea: string; generatedAt: string
}
export type IntroResponse = { mode: 'mock' } | { mode: 'live'; cached: boolean; intro: IntroDetail }

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  // 默认 content-type，但允许调用方经 init.headers 覆盖（原写法 ...init 会整体丢掉默认头）
  const res = await fetch(path, { ...init, headers: { 'content-type': 'application/json', ...init?.headers } })
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`)
  return res.json() as Promise<T>
}

/** 订阅任务 SSE；done/error 后自动关闭。返回手动关闭函数。 */
export function subscribeTask(taskId: string, onEvent: (e: TaskEvent) => void): () => void {
  const es = new EventSource(`/api/tasks/${taskId}/events`)
  let closed = false
  const close = () => { closed = true; es.close() }
  es.onmessage = (m) => {
    const e = JSON.parse(m.data) as TaskEvent
    onEvent(e)
    if (e.type === 'done' || e.type === 'error') close()
  }
  // 连接中断：补发一个终止 error 事件，让调用方复位按钮（否则会卡在"生成中"）；closed 守卫避免 done 后重复触发
  es.onerror = () => {
    if (closed) return
    onEvent({ ts: Date.now(), type: 'error', message: '连接中断' })
    close()
  }
  return close
}

export interface Candidate {
  id: number; repo: string; url: string; description: string | null
  license: string | null; license_ok: number
  stars: number; tech_stack: string | null; score: number | null; score_detail: string | null; status: string
  favorite: number; last_commit: string | null; created_at: string
}
export interface AutoScoutStatus {
  enabled: boolean; time: string
  lastRun: string | null
  lastResult: { at: string; found?: number; scored?: number; rejected?: number; added?: number; error?: string } | null
}
export interface CalendarView {
  date: string; publishedToday: number; remainingToday: number
  inventory: Record<string, number>; cooldown: Record<string, number>
  mix: { demo: number; income: number; process: number; targetDemo: number; targetIncome: number; targetProcess: number }
  suggestions: Array<{ hook: string; assetId: number; reason: string }>
  gaps: string[]
}
export interface WeeklyReport {
  since: string; perHook: Record<string, { published: number; leads: number }>
  totals: { published: number; leads: number }
}
export interface Lead {
  id: number; asset_id: number; wechat: string | null; intent: string | null
  status: string; created_at: string; hook: string | null; slug: string | null
}
export interface SettingsView {
  llm: { mode: 'live' | 'mock'; key_set: boolean; key_masked: string; base_url: string; models: { analysis: string; copy: string; scoring: string } }
  tts: { mode: 'live' | 'stub' | 'kokoro'; key_set: boolean; key_masked: string; base_url: string; model: string; voice: string; melo_python: string; cosy_home: string }
  github: { mode: 'live' | 'mock'; token_set: boolean; token_masked: string }
  scout: { weights: { rebrandCost: number; buyerClarity: number; visualAppeal: number } }
  /** 选了 live 却缺 key 时的降级说明（服务端会把模式改回 mock/stub） */
  mode_notes: string[]
}
export interface TailorRequest {
  id: number; title: string; raw_need: string; lead_id: number | null
  status: 'draft' | 'decomposed' | 'searched' | 'proposed'
  proposal_path: string | null; created_at: string
}
export interface TailorWheel {
  id: number; capability_id: number; repo: string; url: string
  license: string | null; license_ok: number
  stars: number; last_commit: string | null; description: string | null
  score: number; score_detail: string
}
export interface TailorCapability {
  id: number; request_id: number; name: string; detail: string | null
  keywords: string[]; decision: 'pending' | 'wheel' | 'self_build' | 'dropped'
  chosen_repo: string | null; sort: number; wheels: TailorWheel[]
}
export interface TailorDetail { request: TailorRequest; capabilities: TailorCapability[] }
export interface TopicSource {
  id: number; platform: 'douyin' | 'xiaohongshu'; handle: string
  display_name: string | null; follower_count: number | null; note: string | null; created_at: string
  scrape_requested_at: string | null; last_scraped_at: string | null
}
export interface TopicPattern {
  id: number; hook_type: 'pain' | 'sideline' | 'infogap' | 'story'
  title_patterns: string; emotion_type: string; topic_clusters: string
  recommended_topics: string; sample_note_ids: string; created_at: string
}
