export interface AnalysisSummary { targetBuyer: string; painPoint: string }

/** 取某个 ## 标题下的首个非空正文行，去掉列表符号（- / 1. ）。找不到返回空串 */
function firstItem(md: string, heading: string): string {
  const lines = md.split('\n')
  const start = lines.findIndex((l) => l.startsWith('## ') && l.includes(heading))
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
    targetBuyer: firstItem(md, '目标买家画像'),
    painPoint: firstItem(md, '痛点清单'),
  }
}
