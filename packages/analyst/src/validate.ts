/** analysis.md 必含的 7 个二级段（按标题起始词判定，允许后接副标题） */
export const REQUIRED_SECTIONS = [
  '一句话', '目标买家画像', '痛点清单', '换皮方向建议', '定价建议', '钩子匹配', '风险',
]

/** 返回缺失的段名（空数组=齐全）。下游按自由 markdown 消费，这里只校验段落存在性。 */
export function validateAnalysis(md: string): string[] {
  const heads = md.split('\n').filter((l) => l.startsWith('## ')).map((l) => l.slice(3).trim())
  return REQUIRED_SECTIONS.filter((k) => !heads.some((h) => h.startsWith(k)))
}
