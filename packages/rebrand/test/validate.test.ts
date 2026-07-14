import { describe, expect, it } from 'vitest'
import { mockRebrand } from '../src/fixtures/rebrand-fixture'
import { validateRebrand } from '../src/validate'

describe('validateRebrand', () => {
  it('完整 7 段返回空数组', () => {
    expect(validateRebrand(mockRebrand('demo', 'analysis', 'tree'))).toEqual([])
  })
  it('缺段时列出缺失段名', () => {
    const md = mockRebrand('demo', 'a', 't').replace('## 5. 部署', '## 5. 别的')
    expect(validateRebrand(md)).toContain('5. 部署')
  })
})

describe('mockRebrand', () => {
  it('H1 含 slug、含 7 个二级段', () => {
    const md = mockRebrand('chatwoot', 'analysis', 'src/\nDockerfile')
    expect(md).toMatch(/^# chatwoot 换皮改造清单/)
    for (const s of ['1. 品牌替换', '2. 删除项', '3. 中文化', '4. 本土化', '5. 部署', '6. 录屏', '7. 合规自检']) {
      expect(md, s).toContain(`## ${s}`)
    }
  })
})
