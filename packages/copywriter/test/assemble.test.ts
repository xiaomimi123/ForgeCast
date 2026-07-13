import { describe, expect, it } from 'vitest'
import { assemblePrompt } from '../src/assemble'

const base = {
  hook: 'pain' as const,
  hookTemplate: '钩子模板内容',
  formatSpec: '格式规范内容',
  knowledgeMd: '知识包内容',
  atoms: [{ id: 1, topic: 'hook', content: '原子一' }],
  analysis: '分析报告内容',
}

describe('assemblePrompt', () => {
  it('prompt 首行是钩子标记，且按 §5.6 顺序拼装', () => {
    const { system, prompt } = assemblePrompt(base)
    expect(prompt.startsWith('【钩子类型】pain')).toBe(true)
    expect(system).toContain('知识包内容')
    const order = ['钩子模板内容', '格式规范内容', '原子一', '分析报告内容']
    let last = -1
    for (const s of order) {
      const idx = prompt.indexOf(s)
      expect(idx, s).toBeGreaterThan(last)
      last = idx
    }
  })
  it('feedback 存在时追加在末尾', () => {
    const { prompt } = assemblePrompt({ ...base, feedback: '语气再口语一点' })
    expect(prompt).toContain('【用户修改意见，必须遵守】')
    expect(prompt.indexOf('语气再口语') > prompt.indexOf('分析报告内容')).toBe(true)
  })
})
