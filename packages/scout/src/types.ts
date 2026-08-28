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
  rebrandCost: number // 0-30 换皮成本
  buyerClarity: number // 0-40 买家清晰度
  visualAppeal: number // 0-30 内容可视性
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

export interface SearchOpts { minStars: number; pushedAfter: string; perTopic: number }
