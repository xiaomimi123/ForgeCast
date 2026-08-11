import { describe, expect, it } from 'vitest'
import { mockScreenHtml } from '../src/fixtures/screens-fixture'

describe('mockScreenHtml', () => {
  it('三种类型都返回完整自包含 HTML，含品牌名', () => {
    for (const type of ['dashboard', 'list', 'detail'] as const) {
      const html = mockScreenHtml(type, '快客通')
      expect(html.toLowerCase()).toContain('<html')
      expect(html.toLowerCase()).toContain('</html>')
      expect(html).toContain('快客通')
      expect(html).not.toContain('<link') // 不引用外部资源
      expect(html).not.toContain('<script src')
    }
  })
  it('三种类型内容互不相同', () => {
    const a = mockScreenHtml('dashboard', 'X')
    const b = mockScreenHtml('list', 'X')
    const c = mockScreenHtml('detail', 'X')
    expect(a).not.toBe(b)
    expect(b).not.toBe(c)
  })
})
