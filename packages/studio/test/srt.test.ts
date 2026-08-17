import { describe, expect, it } from 'vitest'
import { cuesToSrt } from '../src/srt'

describe('cuesToSrt', () => {
  it('空数组返回空串', () => {
    expect(cuesToSrt([])).toBe('')
  })
  it('单条 cue：序号1，时间戳补零+逗号分隔毫秒', () => {
    const srt = cuesToSrt([{ start: 0, end: 3000, text: '你好世界' }])
    expect(srt).toBe('1\n00:00:00,000 --> 00:00:03,000\n你好世界\n')
  })
  it('多条 cue：序号递增，块间空行分隔', () => {
    const srt = cuesToSrt([
      { start: 0, end: 1500, text: '第一句' },
      { start: 1500, end: 4200, text: '第二句' },
    ])
    expect(srt).toBe(
      '1\n00:00:00,000 --> 00:00:01,500\n第一句\n\n2\n00:00:01,500 --> 00:00:04,200\n第二句\n',
    )
  })
  it('超过一分钟的时间戳正确进位到分钟/小时', () => {
    const srt = cuesToSrt([{ start: 65000, end: 3665500, text: '跨小时' }])
    expect(srt).toBe('1\n00:01:05,000 --> 01:01:05,500\n跨小时\n')
  })
  it('文本含换行时原样保留在字幕块里', () => {
    const srt = cuesToSrt([{ start: 0, end: 2000, text: '第一行\n第二行' }])
    expect(srt).toBe('1\n00:00:00,000 --> 00:00:02,000\n第一行\n第二行\n')
  })
})
