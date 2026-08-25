import { describe, expect, it } from 'vitest'
import { buildChangelogProps, buildFlashProps, buildInsightSlots, buildStoryProps } from '../src/props'

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
  it('CTA 段里画面/台词分行时，取台词那句而不是画面那句（回归：曾错把画面指示当CTA文案）', () => {
    const script = '【0-3s 钩子】开场\n【52-60s CTA】\n画面：回到本人，搞怪敬礼。\n台词：需要的评论区扣1，模板选型和换皮避坑清单，直接安排给你。'
    const p = buildFlashProps({ ...doc, douyinScript: script } as any)
    expect(p.cta).toBe('需要的评论区扣1，模板选型和换皮避坑清单，直接安排给你。')
    expect(p.cta).not.toContain('画面：')
  })
})

describe('buildStoryProps（回归：气泡此前只有3条写死对话，长视频后段没内容——用预埋提问/回复话术真实延展对话）', () => {
  it('用 comments.questions/replies 插入真实问答对，不再是通用填充句', () => {
    const s = buildStoryProps(doc as any, '快客通')
    const texts = s.bubbles.map((b) => b.text)
    expect(texts).toContain('q1')
    expect(texts).toContain('r1')
  })
  it('开头钩子和结尾"太好了"两句保留，问答对插在中间', () => {
    const s = buildStoryProps(doc as any, '快客通')
    expect(s.bubbles[0]).toEqual({ who: 'them', text: 't1' })
    expect(s.bubbles.at(-1)).toEqual({ who: 'them', text: '太好了，等你消息' })
  })
  it('questions 比 replies 多时，没有对应回复的问题不插入（防止孤问）', () => {
    const s = buildStoryProps({ ...doc, comments: { questions: ['q1', 'q2', 'q3'], replies: ['r1'] } } as any)
    const texts = s.bubbles.map((b) => b.text)
    expect(texts).toContain('q1')
    expect(texts).not.toContain('q2')
    expect(texts).not.toContain('q3')
  })
  it('回归：问答对超过1组时只取1组，防止气泡数太多溢出画布（真渲验证过：横屏高度只有1080px，2组问答=7条气泡都会顶出画面顶/底部）', () => {
    const manyQA = { questions: ['q1', 'q2', 'q3'], replies: ['r1', 'r2', 'r3'] }
    const s = buildStoryProps({ ...doc, comments: manyQA } as any)
    const texts = s.bubbles.map((b) => b.text)
    expect(texts).toContain('q1')
    expect(texts).toContain('r1')
    expect(texts).not.toContain('q2')
    expect(texts).not.toContain('r2')
    expect(s.bubbles.length).toBeLessThanOrEqual(5) // 开头2 + 最多1组问答(2) + 结尾1
  })
  it('无问答对时兜底成原有三句对话', () => {
    const s = buildStoryProps({ ...doc, comments: { questions: [], replies: [] } } as any)
    expect(s.bubbles).toEqual([
      { who: 'them', text: 't1' },
      { who: 'me', text: '可以，等我一天' },
      { who: 'them', text: '太好了，等你消息' },
    ])
  })
})

describe('buildInsightSlots', () => {
  it('取封面主标题与 CTA，不含 sellingPoint（卡片数据不在这里处理）', () => {
    const s = buildInsightSlots(doc as any, '快客通')
    expect(s.painTitle).toBe('网店客服还在手动回？')
    expect(s.cta).toBe('评论区扣1领文档')
    expect(s.brandName).toBe('快客通')
    expect((s as any).sellingPoint).toBeUndefined()
  })
  it('无 cover.main 时回落 titles[0]', () => {
    const s = buildInsightSlots({ ...doc, cover: { main: '', sub: '' } } as any)
    expect(s.painTitle).toBe('t1')
  })
  it('无 CTA 段时兜底非空', () => {
    const s = buildInsightSlots({ ...doc, douyinScript: '没有那段' } as any)
    expect(s.cta.length).toBeGreaterThan(0)
  })
})

describe('buildChangelogProps', () => {
  it('产出 title/sellingPoint/cta/brandName 全为字符串', () => {
    const doc = {
      titles: ['看板改版'], xhsBody: '正文', douyinScript: '【52-60s CTA】评论区扣1',
      cover: { main: '看板改版', sub: '候选卡片' }, comments: { questions: [], replies: [] },
    } as any
    const p = buildChangelogProps(doc, '内容工厂')
    expect(typeof p.title).toBe('string')
    expect(p.title.length).toBeGreaterThan(0)
    expect(p.brandName).toBe('内容工厂')
  })
})
