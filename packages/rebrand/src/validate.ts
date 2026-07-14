/** rebrand-plan.md 必含的 7 个二级段（按标题起始词判定） */
export const REQUIRED_SECTIONS = [
  '1. 品牌替换', '2. 删除项', '3. 中文化', '4. 本土化', '5. 部署', '6. 录屏', '7. 合规自检',
]

/** 返回缺失的段名（空数组=齐全） */
export function validateRebrand(md: string): string[] {
  const heads = md.split('\n').filter((l) => l.startsWith('## ')).map((l) => l.slice(3).trim())
  return REQUIRED_SECTIONS.filter((k) => !heads.some((h) => h.startsWith(k)))
}
