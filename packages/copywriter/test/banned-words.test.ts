import { copyFixtures, HOOKS } from '@forgecast/core'
import { describe, expect, it } from 'vitest'
import { checkBannedWords } from '../src/banned-words'

describe('checkBannedWords', () => {
  it('命中违禁词返回词表', () => {
    expect(checkBannedWords('全网第一，保证赚钱，稳赚不亏')).toEqual(
      expect.arrayContaining(['第一', '保证赚钱', '稳赚']),
    )
  })
  it('干净文本返回空数组', () => {
    expect(checkBannedWords('一套系统扛住3个人的活')).toEqual([])
  })
  it('四个 fixture 不含违禁词（守住 mock 演示质量）', () => {
    for (const hook of HOOKS) expect(checkBannedWords(copyFixtures[hook]), hook).toEqual([])
  })
})
