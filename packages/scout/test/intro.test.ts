import { describe, expect, it } from 'vitest'
import { heuristicIntro, parseIntroJson, validateIntro, type IntroDetail } from '../src/intro'

const meta = { repo: 'a/adminlte', url: 'u', description: '后台管理模板', license: 'MIT', stars: 40000, lastCommit: null, topics: [] }

describe('heuristicIntro', () => {
  it('结构合法：features≥3、五个文本字段非空、含 generatedAt', () => {
    const d = heuristicIntro(meta, 'React admin dashboard template')
    expect(d.features.length).toBeGreaterThanOrEqual(3)
    expect(d.summary.trim()).not.toBe('')
    expect(d.targetUser.trim()).not.toBe('')
    expect(d.painPoint.trim()).not.toBe('')
    expect(d.rebrandIdea.trim()).not.toBe('')
    expect(typeof d.generatedAt).toBe('string')
    expect(validateIntro(d)).toEqual([])
  })
})

describe('parseIntroJson', () => {
  it('解析带 ```json 围栏的合法 JSON', () => {
    const raw = '```json\n{"summary":"s","features":["f1","f2","f3"],"targetUser":"t","painPoint":"p","rebrandIdea":"r"}\n```'
    const d = parseIntroJson(raw)
    expect(d.summary).toBe('s')
    expect(d.features).toEqual(['f1', 'f2', 'f3'])
    expect(d.rebrandIdea).toBe('r')
    expect(validateIntro(d)).toEqual([])
  })
  it('缺字段按空兜底，交给 validateIntro 判失败', () => {
    const d = parseIntroJson('{"summary":"s"}')
    expect(d.features).toEqual([])
    expect(validateIntro(d).sort()).toEqual(['features', 'painPoint', 'rebrandIdea', 'targetUser'])
  })
  it('malformed JSON 抛错', () => {
    expect(() => parseIntroJson('not json at all')).toThrow()
  })
})

describe('validateIntro', () => {
  it('features 少于 3 条判 features 不合格', () => {
    const d: IntroDetail = { summary: 's', features: ['a', 'b'], targetUser: 't', painPoint: 'p', rebrandIdea: 'r', generatedAt: '' }
    expect(validateIntro(d)).toEqual(['features'])
  })
  it('空串字段被列出', () => {
    const d: IntroDetail = { summary: '', features: ['a', 'b', 'c'], targetUser: '  ', painPoint: 'p', rebrandIdea: 'r', generatedAt: '' }
    expect(validateIntro(d).sort()).toEqual(['summary', 'targetUser'])
  })
})
