export interface DemandExtractDraft { id: number; kind: 'traffic' | 'emotional' | 'supply'; opportunity: string }

const KINDS = ['traffic', 'emotional', 'supply'] as const

/** mock 固定分类：按序循环 kind，opportunity 固定话术。绝不调用 ctx.llm（仓库铁律）。 */
export function mockDemandExtract(ids: number[]): DemandExtractDraft[] {
  return ids.map((id, i) => ({
    id,
    kind: KINDS[i % KINDS.length],
    opportunity: '可承接：围绕该信号做轻资产定制交付（mock 示例）',
  }))
}
