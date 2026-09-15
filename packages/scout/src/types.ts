export interface RepoMeta {
  repo: string // owner/name
  url: string
  description: string | null // GitHub 仓库简介，一句话
  license: string | null // SPDX id
  stars: number
  lastCommit: string | null
  topics: string[]
}

export interface CandidateFixture extends RepoMeta {
  readme: string
  tree: string[]
}

export type Track = 'profit' | 'traffic'

export interface ScoreDetail {
  rebrandCost: number // 0-20 换皮成本
  buyerClarity: number // 0-30 买家清晰度
  visualAppeal: number // 0-20 内容可视性
  businessDepth: number // 0-30 业务含量：有没有订单/客户实体、数据库模型、角色权限（低于 12 直接不入库）
  businessDepthReason: string // 业务含量的判定理由，一句话
  techStack: string[]
  rationale: string
  targetBuyer: string // 什么老板会掏钱，一句话；mock 下为空串（不编造）
  painPoint: string // 解决的行业痛点，一句话；mock 下为空串
  summaryZh: string // 这个项目是做什么的，一句话中文说明；mock 下为空串（不编造翻译）
  category: string // 领域标签，取自 CATEGORIES
  // 分轨（可选，缺失=老候选未分轨）
  track?: Track
  gapScore?: number // profit 专属：差价分 0-100
  threshold?: number // profit 专属：安装/使用门槛 0-100
  exitRoutes?: string[] // profit 专属：交付方式，['托管','定制','一键包'] 子集
  emotionScore?: number // traffic 专属：情绪值 0-100
  wowScore?: number // traffic 专属：爽感 0-100
}

export interface SearchOpts {
  minStars: number
  pushedAfter: string
  perTopic: number
  /** 两次搜索请求之间的间隔（毫秒）。GitHub search API 限速 30 次/分（带 token），默认按此节流。 */
  throttleMs?: number
  /** 逐词搜索的结果回调：调用方靠它区分"限流跳过"与"真 0 命中"。 */
  onNote?: (note: SearchNote) => void
  /** 睡眠实现（测试注入，免得真等）。 */
  sleep?: (ms: number) => Promise<void>
}

/** 单个关键词的搜索结局：ok=拿到结果（count 可能是 0），rate-limited=被限流且重试后仍失败，error=其它 HTTP 错。 */
export interface SearchNote { topic: string; kind: 'ok' | 'rate-limited' | 'error'; status?: number; count?: number }
