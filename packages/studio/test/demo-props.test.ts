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
    // 断言实际内容而非仅数量：buildDemoProps 靠固定 section id（pain-1）从 buildSemantic
    // 的输出里取痛点，push 顺序一旦变了、pain-1 指向别的非空字符串数组会静默通过——
    // 具体内容才是这个断言真正要守住的东西（doc.xhsBody 按 。！？\n 切句，取前 3 句）
    expect(p.painPoints).toEqual(['白天上班晚上回消息', '微信旺旺来回切', '漏一条就差评'])
    expect(p.priceAnchor.length).toBeGreaterThan(0)
    expect(p.cta).toBe('评论区扣1')
    expect(p.brandName).toBe('快客通')
  })
  it('回归：报价段里画面/台词分行时取台词那句而不是画面指示（同 flash CTA 曾踩过的坑，真渲验证过 buildDemoProps 这份独立正则没跟着一起改）', () => {
    const script = '【0-3s 钩子】开场\n【45-52s 报价锚点】\n画面：对比图：左边旧方案，右边新方案。\n台词：外面做要几万，我这套成本一顿火锅钱。\n【52-60s CTA】评论区扣1'
    const p = buildDemoProps({ ...doc, douyinScript: script } as any)
    expect(p.priceAnchor).toBe('外面做要几万，我这套成本一顿火锅钱。')
    expect(p.priceAnchor).not.toContain('画面：')
  })
})
