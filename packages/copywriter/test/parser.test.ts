import { copyFixtures, HOOKS } from '@forgecast/core'
import { describe, expect, it } from 'vitest'
import { parseCopyOutput } from '../src/parser'

describe('parseCopyOutput', () => {
  it('四个 fixture 全部可解析且字段完整', () => {
    for (const hook of HOOKS) {
      const doc = parseCopyOutput(copyFixtures[hook])
      expect(doc.titles, hook).toHaveLength(3)
      expect(doc.xhsBody.length, hook).toBeGreaterThan(50)
      expect(doc.douyinScript, hook).toContain('CTA')
      expect(doc.cover.main, hook).toBeTruthy()
      expect(doc.cover.sub, hook).toBeTruthy()
      expect(doc.comments.questions, hook).toHaveLength(2)
      expect(doc.comments.replies, hook).toHaveLength(3)
    }
  })
  it('缺段落时抛错并指明缺哪段', () => {
    expect(() => parseCopyOutput('## 标题\n1. a\n2. b\n3. c')).toThrow(/小红书正文/)
  })
})
