import { describe, expect, it } from 'vitest'
import { buildStoryProps } from '../src/props'

const doc = {
  titles: ['能做个客服系统吗', 't2', 't3'], xhsBody: 'b',
  douyinScript: '【0-3s 钩子】开场\n【52-60s CTA】评论区扣1',
  cover: { main: '主', sub: '一套系统扛三人份' }, comments: { questions: ['q1', 'q2'], replies: ['r1', 'r2', 'r3'] },
}
describe('buildStoryProps', () => {
  it('生成气泡/卖点/CTA/品牌', () => {
    const p = buildStoryProps(doc as any, '快客通')
    expect(p.bubbles.length).toBeGreaterThanOrEqual(2)
    expect(p.bubbles[0].text.length).toBeGreaterThan(0)
    expect(p.sellingPoint).toBe('一套系统扛三人份')
    expect(p.cta).toBe('评论区扣1')
    expect(p.brandName).toBe('快客通')
  })
})
