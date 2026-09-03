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

  it('只比可改集范围内字段：spec 无关字段（durationSec）变化不产生差异', () => {
    const other = baseSpec({ bgVariant: 'grid', durationSec: 99, audio: saved.audio })
    expect(paramsDiff(other, { bgVariant: 'grid', bgmSrc: 'bgm/a.mp3' })).toEqual([])
  })

  it('mood 改动产生一条差异（P2 接入按情绪自动选曲后放开）', () => {
    expect(paramsDiff(saved, { mood: 'upbeat' })).toEqual([{ key: 'mood', from: 'calm', to: 'upbeat' }])
  })

  it('mood 未提及则跳过；saved 无 bgm 时 mood 的 from 为 null', () => {
    expect(paramsDiff(saved, {})).toEqual([])
    const bare = baseSpec()
    expect(paramsDiff(bare, { mood: 'tense' })).toEqual([{ key: 'mood', from: null, to: 'tense' }])
  })

  it('三项都改 → 三条差异，按 bgVariant/bgmSrc/mood 顺序', () => {
    expect(paramsDiff(saved, { bgVariant: 'wave', bgmSrc: 'bgm/b.mp3', mood: 'upbeat' })).toEqual([
      { key: 'bgVariant', from: 'grid', to: 'wave' },
      { key: 'bgmSrc', from: 'bgm/a.mp3', to: 'bgm/b.mp3' },
      { key: 'mood', from: 'calm', to: 'upbeat' },
    ])
  })

  // I2：mood 下拉「自动」选项值是 ''，saved 侧没有 mood 时是 null——语义相同，不归一的话
  // 「选情绪又选回自动」圆点清不掉，点重渲还会以空 mood 打 pick-bgm 静默换曲重析。
  it("mood 草稿为 ''（选回自动）与 saved 无 mood（null）不算改动", () => {
    const bare = baseSpec()
    expect(paramsDiff(bare, { mood: '' })).toEqual([])
  })

  it("mood 草稿为 ''、saved 有 mood 时仍算改动（回到自动 ≠ 保持原情绪）", () => {
    expect(paramsDiff(saved, { mood: '' })).toEqual([{ key: 'mood', from: 'calm', to: null }])
  })

  // I2：saved 侧 bgmSrc 落盘是绝对路径，draft.bgmSrc 是曲库相对名——调用方（InspectorPane）
  // 用 relOfBgmSrc 把 saved 反解成相对名后传作第三个参数，「选中当前正在用的那首」不再算改动。
  it('bgmSrc：saved 归一到相对名后与「选回当前同一首」不算改动', () => {
    expect(paramsDiff(saved, { bgmSrc: 'bgm/a.mp3' }, 'bgm/a.mp3')).toEqual([])
  })

  it('bgmSrc：不传第三个参数时退回未归一的 saved.audio.bgm.src（旧调用点行为不变）', () => {
    expect(paramsDiff(saved, { bgmSrc: 'bgm/a.mp3' })).toEqual([])
  })
})
