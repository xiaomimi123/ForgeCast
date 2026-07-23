import { describe, expect, it } from 'vitest'
import { parseAnalysisSummary } from '../src/summary'

const FULL = `# demo 商业化分析

## 一句话：这是给谁的什么
给中小老板的工具

## 目标买家画像（主攻1个，备选2个）
- 主攻：需要该工具但没技术团队的中小商家（1-5人）
- 备选1：做外包接单的开发者

## 痛点清单（按付费意愿排序，每条注明"现状成本"）
1. 现在用通用工具凑合，效率低（现状成本：每天额外若干小时）
2. 商用 SaaS 年费高

## 风险
无
`

describe('parseAnalysisSummary', () => {
  it('取目标买家与痛点各首条，去掉列表符号', () => {
    const s = parseAnalysisSummary(FULL)
    expect(s.targetBuyer).toBe('主攻：需要该工具但没技术团队的中小商家（1-5人）')
    expect(s.painPoint).toBe('现在用通用工具凑合，效率低（现状成本：每天额外若干小时）')
  })

  it('缺段返回空串，不抛错', () => {
    const s = parseAnalysisSummary('# 标题\n\n## 风险\n无\n')
    expect(s).toEqual({ targetBuyer: '', painPoint: '' })
  })

  it('空输入返回空串', () => {
    expect(parseAnalysisSummary('')).toEqual({ targetBuyer: '', painPoint: '' })
  })
})
