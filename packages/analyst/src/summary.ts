import { REQUIRED_SECTIONS } from './validate'

export interface AnalysisSummary { targetBuyer: string; painPoint: string }

// 复用 validate.ts 的标题字面量，避免同一批标题在包内出现第二份硬编码。
// 按名查找而非按下标解构：REQUIRED_SECTIONS 将来若增删段落，下标会静默错位且无人察觉
const pickHeading = (name: string): string => {
  const hit = REQUIRED_SECTIONS.find((s) => s === name)
  if (!hit) throw new Error(`REQUIRED_SECTIONS 缺少段落「${name}」，summary 解析与 validate 校验已不同步`)
  return hit
}
const TARGET_BUYER_HEADING = pickHeading('目标买家画像')
const PAIN_POINT_HEADING = pickHeading('痛点清单')

/**
 * 取某个 ## 标题下的首个非空正文行，去掉列表符号（- / 1. ）。找不到返回空串。
 * 标题匹配口径与 validate.ts 保持一致：剥掉 "## " 前缀及首尾空白后 startsWith(heading)，
 * 而非子串匹配——避免被"任何含该子串的二级标题"误命中。
 */
function firstItem(md: string, heading: string): string {
  const lines = md.split('\n')
  const start = lines.findIndex((l) => l.startsWith('## ') && l.slice(3).trim().startsWith(heading))
  if (start < 0) return ''
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]
    if (line.startsWith('## ')) break // 撞到下一段仍没内容
    const t = line.trim()
    if (t) return t.replace(/^[-*]\s*/, '').replace(/^\d+[.、]\s*/, '')
  }
  return ''
}

/**
 * 从 analysis.md 抽两条摘要给看板泳道卡片用。
 * analysis.md 由 M2 生成、结构已被 validateAnalysis 校验过；但这里对缺段一律 fail-soft ——
 * 立项后尚未跑分析是常态，不该让整个项目列表接口报错。
 */
export function parseAnalysisSummary(md: string): AnalysisSummary {
  if (!md) return { targetBuyer: '', painPoint: '' }
  return {
    targetBuyer: firstItem(md, TARGET_BUYER_HEADING),
    painPoint: firstItem(md, PAIN_POINT_HEADING),
  }
}
