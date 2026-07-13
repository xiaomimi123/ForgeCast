import { describe, expect, it } from 'vitest'
import { buildFlashProps } from '../src/props'

const doc = {
  titles: ['t1', 't2', 't3'],
  xhsBody: 'body',
  douyinScript: '【0-3s 钩子】开场\n【52-60s CTA】评论区扣1领文档',
  cover: { main: '网店客服还在手动回？', sub: '一套系统扛住3个人的活' },
  comments: { questions: ['q1', 'q2'], replies: ['r1', 'r2', 'r3'] },
}

describe('buildFlashProps', () => {
  it('取封面主/副标题与 CTA', () => {
    const p = buildFlashProps(doc as any, '快客通')
    expect(p.painTitle).toBe('网店客服还在手动回？')
    expect(p.sellingPoint).toBe('一套系统扛住3个人的活')
    expect(p.cta).toBe('评论区扣1领文档')
    expect(p.brandName).toBe('快客通')
  })
  it('无 CTA 段时兜底非空', () => {
    const p = buildFlashProps({ ...doc, douyinScript: '没有那段' } as any)
    expect(p.cta.length).toBeGreaterThan(0)
    expect(p.brandName).toBe('forgecast')
  })
})
