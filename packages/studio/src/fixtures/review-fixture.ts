export interface ReviewScores { hook: number; pacing: number; fidelity: number; cta: number; overall: number }
export interface ReviewDraft { scores: ReviewScores; suggestions: string[] }

/** mock 审片：固定分数与建议。绝不调用 ctx.llm（仓库铁律）。 */
export function mockReviewReport(): ReviewDraft {
  return {
    scores: { hook: 70, pacing: 65, fidelity: 75, cta: 60, overall: 68 },
    suggestions: [
      '前3秒直接抛出痛点钩子，别先自我介绍',
      '结尾 CTA 停顿一拍再说，给观众反应时间（mock 示例）',
    ],
  }
}
