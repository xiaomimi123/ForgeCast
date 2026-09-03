import { describe, expect, it } from 'vitest'
import { paramsDiff } from '../src/params'
import { baseSpec } from './fixtures'

const saved = baseSpec({
  bgVariant: 'grid',
  audio: { narration: null, bgm: { src: 'bgm/a.mp3', mood: 'calm' }, beatGrid: null, captionsEnabled: true },
})

describe('paramsDiff', () => {
  it('两项都改 → 两条差异，按 bgVariant/bgmSrc 顺序', () => {
    expect(paramsDiff(saved, { bgVariant: 'wave', bgmSrc: 'bgm/b.mp3' })).toEqual([
      { key: 'bgVariant', from: 'grid', to: 'wave' },
      { key: 'bgmSrc', from: 'bgm/a.mp3', to: 'bgm/b.mp3' },
    ])
  })

  it('值相同不算差异', () => {
    expect(paramsDiff(saved, { bgVariant: 'grid', bgmSrc: 'bgm/a.mp3' })).toEqual([])
  })

  it('draft 未提及的键跳过（undefined = 没编辑过）', () => {
    expect(paramsDiff(saved, { bgmSrc: 'bgm/b.mp3' })).toEqual([{ key: 'bgmSrc', from: 'bgm/a.mp3', to: 'bgm/b.mp3' }])
    expect(paramsDiff(saved, {})).toEqual([])
  })

  it('bgmSrc 置 null（去掉 BGM）算一条差异', () => {
    expect(paramsDiff(saved, { bgmSrc: null })).toEqual([{ key: 'bgmSrc', from: 'bgm/a.mp3', to: null }])
  })

  it('saved 无 bgm / 无 bgVariant 时 from 为 null / undefined', () => {
    const bare = baseSpec()
    expect(paramsDiff(bare, { bgmSrc: 'bgm/b.mp3' })).toEqual([
      { key: 'bgmSrc', from: null, to: 'bgm/b.mp3' },
    ])
    expect(paramsDiff(bare, { bgVariant: 'grid' })).toEqual([{ key: 'bgVariant', from: undefined, to: 'grid' }])
  })

  it('只比 §10 可改集两项：spec 其他字段（含 mood）变化不产生差异', () => {
    const other = baseSpec({ bgVariant: 'grid', durationSec: 99, audio: saved.audio })
    expect(paramsDiff(other, { bgVariant: 'grid', bgmSrc: 'bgm/a.mp3' })).toEqual([])
  })
})
