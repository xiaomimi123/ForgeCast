import { isLicenseOk, type RepoMeta } from '@forgecast/scout'

export interface WheelScoreDetail {
  activity: number   // 0-30 活跃度（last commit 距今）
  popularity: number // 0-25 stars 档位
  license: number    // 0-15 协议（白名单/其他/无）
  relevance: number  // 0-30 关键词命中 repo 名+描述的比例
  rationale: string
}

/** 纯规则打分（量大不烧 LLM：能力数 × 8 轮子）。协议非白名单不打 0——定制场景内部部署可谈，风险在方案书里点名。 */
export function wheelScore(meta: RepoMeta, keywords: string[]): { score: number; detail: WheelScoreDetail } {
  const days = meta.lastCommit ? (Date.now() - new Date(meta.lastCommit).getTime()) / 86400000 : Infinity
  const activity = days < 90 ? 30 : days < 365 ? 20 : days < 730 ? 10 : 0
  const popularity = meta.stars >= 10000 ? 25 : meta.stars >= 1000 ? 20 : meta.stars >= 100 ? 12 : meta.stars > 0 ? 5 : 0
  const license = isLicenseOk(meta.license) ? 15 : meta.license ? 5 : 0
  const hay = `${meta.repo} ${meta.description ?? ''}`.toLowerCase()
  const hits = keywords.filter((k) => k && hay.includes(k.toLowerCase())).length
  const relevance = keywords.length ? Math.round((hits / keywords.length) * 30) : 0
  const score = activity + popularity + license + relevance
  return { score, detail: { activity, popularity, license, relevance, rationale: `活跃${activity}+热度${popularity}+协议${license}+命中${relevance}` } }
}
