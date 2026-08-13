import type { DemandSignal } from '../signals'

export interface MatchPlanDraft { repo: string; bizMode: 'shop' | 'custom' | 'both'; bizPlan: string }

/** mock 关键词：title+opportunity 简单切词取前 3，切不出则兜底固定词。绝不调用 ctx.llm（仓库铁律）。 */
export function mockMatchKeywords(signal: Pick<DemandSignal, 'title' | 'opportunity'>): string[] {
  const words = `${signal.title} ${signal.opportunity ?? ''}`
    .split(/[\s，。、：:；;（）()/|·]+/).map((w) => w.trim()).filter((w) => w.length >= 2)
  return words.length ? words.slice(0, 3) : ['open', 'source']
}

/** mock 商业模式建议：每个 repo 固定 both + 占位话术。 */
export function mockMatchPlans(repos: string[]): MatchPlanDraft[] {
  return repos.map((repo) => ({
    repo, bizMode: 'both' as const,
    bizPlan: '可开店卖标准化交付，也可私域接单做定制（mock 示例）',
  }))
}
