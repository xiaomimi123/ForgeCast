import { describe, expect, it } from 'vitest'
import { buildDemoProps } from '../src/props'

const doc = {
  titles: ['做电商还在手动回客户？', 't2', 't3'], xhsBody: '白天上班晚上回消息。微信旺旺来回切。漏一条就差评。',
  douyinScript: '【0-3s 钩子】开场\n【45-52s 报价锚点】外面几万我这一顿火锅钱\n【52-60s CTA】评论区扣1',
  cover: { main: '网店客服还在手动回？', sub: '一套系统扛三人份' }, comments: { questions: ['q1', 'q2'], replies: ['r1', 'r2', 'r3'] },
}
describe('buildDemoProps', () => {
  it('生成钩子/痛点/报价/CTA/品牌', () => {
    const p = buildDemoProps(doc as any, '快客通')
    expect(p.painTitle).toBe('网店客服还在手动回？')
    expect(Array.isArray(p.painPoints)).toBe(true)
    expect(p.painPoints.length).toBeGreaterThanOrEqual(1)
    expect(p.priceAnchor.length).toBeGreaterThan(0)
    expect(p.cta).toBe('评论区扣1')
    expect(p.brandName).toBe('快客通')
  })
})
