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

export interface ScoreDetail {
  rebrandCost: number // 0-30 换皮成本
  buyerClarity: number // 0-40 买家清晰度
  visualAppeal: number // 0-30 内容可视性
  techStack: string[]
  rationale: string
}

export interface SearchOpts { minStars: number; pushedAfter: string; perTopic: number }
