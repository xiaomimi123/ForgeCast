import { describe, expect, it } from 'vitest'
import { mockAnalysis } from '../src/fixtures/analysis-fixture'
import { validateAnalysis } from '../src/validate'

describe('validateAnalysis', () => {
  it('完整 7 段返回空数组', () => {
    expect(validateAnalysis(mockAnalysis('demo', 'some readme'))).toEqual([])
  })
  it('缺段时列出缺失段名', () => {
    const md = mockAnalysis('demo', 'x').replace('## 定价建议', '## 别的段')
    expect(validateAnalysis(md)).toContain('定价建议')
  })
})

describe('mockAnalysis', () => {
  it('H1 含 slug、含 7 个二级段', () => {
    const md = mockAnalysis('chatwoot', 'readme first line\nmore')
    expect(md).toMatch(/^# chatwoot 商业化分析/)
    for (const s of ['一句话', '目标买家画像', '痛点清单', '换皮方向建议', '定价建议', '钩子匹配', '风险']) {
      expect(md, s).toContain(`## ${s}`)
    }
  })
})
