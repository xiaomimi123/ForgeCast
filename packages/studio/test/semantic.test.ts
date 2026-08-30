import { describe, expect, it } from 'vitest'
import { buildSemantic } from '../src/semantic'

const doc: any = {
  titles: ['标题一', '标题二'],
  cover: { main: '封面主', sub: '封面副' },
  xhsBody: '第一句痛点。第二句痛点。第三句痛点。',
  douyinScript: [
    '【0-3s 钩子】（画面：手机聊天记录）接外包的兄弟，这句话你熟不熟？',
    '【40-50s 报价】（画面：报价单特写）外面做要几万，我这套成本一顿火锅钱',
    '【52-60s CTA】（画面：手机弹出评论通知，光标闪烁）想要同款？评论区扣1，链接自己去接',
  ].join('\n'),
  comments: { questions: ['多久能做好'], replies: ['一天'] },
  hook: 'pain',
}

describe('buildSemantic 上屏文案清洗', () => {
  it('CTA 不得包含括号里的拍摄指示（回归：曾把「（画面：…）」当文案打上屏）', () => {
    const s = buildSemantic(doc, 'flash')
    const cta = s.sections.find((x) => x.role === 'cta')!.text!
    expect(cta).not.toContain('画面')
    expect(cta).not.toContain('（')
    expect(cta).toContain('评论区扣1')
  })

  it('报价锚点同样不得包含拍摄指示', () => {
    const s = buildSemantic(doc, 'demo')
    const stat = s.sections.find((x) => x.role === 'stat' || x.role === 'body')
    const all = JSON.stringify(s.sections)
    expect(all).not.toContain('（画面')
    void stat
  })

  it('语义层带稳定 section id，同输入两次结果一致', () => {
    const a = buildSemantic(doc, 'flash')
    const b = buildSemantic(doc, 'flash')
    expect(a).toEqual(b)
    expect(a.sections.every((x) => x.id && /^[a-z0-9-]+$/.test(x.id))).toBe(true)
  })
})

describe('中文数字识别（回归：中文口播曾渲出空片）', () => {
  it('「三到五天」「几万块」能被识别成数据卡', () => {
    const cues = [
      { start: 2, end: 6, text: '工期要三到五天，一单多烧人力' },
      { start: 8, end: 12, text: '外面报价几万块起' },
    ]
    const s = buildSemantic({ ...doc }, 'insight', { cues: cues as any })
    const stats = s.sections.filter((x) => x.role === 'stat')
    expect(stats.length).toBeGreaterThanOrEqual(2)
  })
  it('阿拉伯数字仍然识别（不得回归）', () => {
    const cues = [{ start: 2, end: 6, text: '返工率高达 30%' }]
    const s = buildSemantic({ ...doc }, 'insight', { cues: cues as any })
    expect(s.sections.filter((x) => x.role === 'stat').length).toBe(1)
  })
})
