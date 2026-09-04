import { describe, expect, it } from 'vitest'
import type { Layer, VideoSpec } from '@forgecast/studio'
import { addCaptionLayer, setVideoVolume, trimVideoLayer } from '../src/video-ops'
import { baseSpec, captionLayer, snapshot, textLayer } from './fixtures'

const videoLayer = (over: Partial<Layer> = {}): Layer => ({
  id: over.id ?? 'v', kind: 'video', from: null, overridden: over.overridden ?? false,
  start: over.start ?? 0, duration: over.duration ?? 12, track: over.track ?? 0,
  content: over.content ?? { kind: 'video', src: 'talk.mp4', muted: false },
  style: over.style ?? {}, effects: over.effects ?? [],
})

/** 口播底片 v[0,12) 在 track0，两条动效层：a[0,3) track1、b[8,3) track2（右缘 11）。 */
const talkSpec = (over: Partial<VideoSpec> = {}): VideoSpec =>
  baseSpec({
    durationSec: 12,
    layers: [
      videoLayer(),
      textLayer({ id: 'a', start: 0, duration: 3, track: 1 }),
      textLayer({ id: 'b', start: 8, duration: 3, track: 2 }),
    ],
    ...over,
  })

const layerOf = (spec: VideoSpec, id: string) => spec.layers.find((l) => l.id === id)!
const contentOf = (spec: VideoSpec, id: string) =>
  layerOf(spec, id).content as { kind: 'video'; src: string; muted: boolean; trimStart?: number; trimEnd?: number; volume?: number }

describe('trimVideoLayer — edge=start', () => {
  it('δ>0 多裁头：trimStart 加、duration 减、start 不动，durationSec 联动', () => {
    const spec = talkSpec()
    const before = snapshot(spec)
    const out = trimVideoLayer(spec, 'v', 'start', 1.5)
    expect(out).not.toBe(spec)
    expect(spec).toEqual(before)
    expect(contentOf(out, 'v').trimStart).toBe(1.5)
    expect(contentOf(out, 'v').trimEnd).toBe(12)
    expect(layerOf(out, 'v').start).toBe(0)
    expect(layerOf(out, 'v').duration).toBe(10.5)
    expect(layerOf(out, 'v').overridden).toBe(true)
    expect(out.durationSec).toBe(10.5)
  })

  it('δ<0 吐回来：trimStart 减、duration 加；trimStart 下限 0（吐超了钳住）', () => {
    const trimmed = trimVideoLayer(talkSpec(), 'v', 'start', 2)
    const out = trimVideoLayer(trimmed, 'v', 'start', -0.5)
    expect(contentOf(out, 'v').trimStart).toBe(1.5)
    expect(layerOf(out, 'v').duration).toBe(10.5)
    expect(out.durationSec).toBe(10.5)

    const back = trimVideoLayer(trimmed, 'v', 'start', -99)
    expect(contentOf(back, 'v').trimStart).toBe(0)
    expect(layerOf(back, 'v').duration).toBe(12)
    expect(back.durationSec).toBe(12)
  })

  it('裁到 <0.2 被钳住（duration 恰好 0.2）', () => {
    const out = trimVideoLayer(talkSpec(), 'v', 'start', 99)
    expect(layerOf(out, 'v').duration).toBe(0.2)
    expect(contentOf(out, 'v').trimStart).toBe(11.8)
    expect(out.durationSec).toBe(0.2)
  })
})

describe('trimVideoLayer — edge=end', () => {
  it('δ>0 多裁尾：duration 减、trimStart 不动、trimEnd = trimStart + 新 duration', () => {
    const out = trimVideoLayer(talkSpec(), 'v', 'end', 2)
    expect(layerOf(out, 'v').duration).toBe(10)
    expect(contentOf(out, 'v').trimStart).toBe(0)
    expect(contentOf(out, 'v').trimEnd).toBe(10)
    expect(out.durationSec).toBe(10)
  })

  it('已裁头时 trimEnd 随 trimStart 平移', () => {
    const head = trimVideoLayer(talkSpec(), 'v', 'start', 1)
    const out = trimVideoLayer(head, 'v', 'end', 2)
    expect(contentOf(out, 'v').trimStart).toBe(1)
    expect(layerOf(out, 'v').duration).toBe(9)
    expect(contentOf(out, 'v').trimEnd).toBe(10)
    expect(out.durationSec).toBe(9)
  })

  it('δ<0 吐回尾巴：duration 加', () => {
    const cut = trimVideoLayer(talkSpec(), 'v', 'end', 3)
    const out = trimVideoLayer(cut, 'v', 'end', -1)
    expect(layerOf(out, 'v').duration).toBe(10)
    expect(out.durationSec).toBe(10)
  })

  it('裁到 <0.2 被钳住', () => {
    const out = trimVideoLayer(talkSpec(), 'v', 'end', 100)
    expect(layerOf(out, 'v').duration).toBe(0.2)
    expect(out.durationSec).toBe(0.2)
  })
})

describe('trimVideoLayer — 越界图层钳回', () => {
  it('duration 超界的截短（start 仍在界内）', () => {
    // 裁到 10：b[8,3) 右缘 11 越界 → duration 截到 2
    const spec = talkSpec()
    const out = trimVideoLayer(spec, 'v', 'end', 2)
    expect(layerOf(out, 'b').start).toBe(8)
    expect(layerOf(out, 'b').duration).toBe(2)
    expect(layerOf(out, 'b').overridden).toBe(true)
    // 没越界的层保持原引用（前端 memo 依赖）
    expect(layerOf(out, 'a')).toBe(layerOf(spec, 'a'))
    expect(layerOf(out, 'a').overridden).toBe(false)
  })

  it('start 超界的贴末尾（保时长，整体左移）', () => {
    // 裁到 8.1：b 的 start=8 只剩 0.1 < 0.2 → 贴末尾 start = 8.1-3 = 5.1，duration 保 3
    const out = trimVideoLayer(talkSpec(), 'v', 'end', 3.9)
    expect(out.durationSec).toBe(8.1)
    expect(layerOf(out, 'b').start).toBe(5.1)
    expect(layerOf(out, 'b').duration).toBe(3)
  })

  it('完全放不下的钳到 0.2 贴末尾——不删层', () => {
    // 裁到 1：b 时长 3 > 1，放不下 → start=0.8 duration=0.2；层数不变
    const out = trimVideoLayer(talkSpec(), 'v', 'end', 11)
    expect(out.durationSec).toBe(1)
    expect(out.layers).toHaveLength(3)
    expect(layerOf(out, 'b').start).toBe(0.8)
    expect(layerOf(out, 'b').duration).toBe(0.2)
    // a[0,3) 的 start 仍在界内 → 走截短分支，压到 [0,1)
    expect(layerOf(out, 'a').start).toBe(0)
    expect(layerOf(out, 'a').duration).toBe(1)
  })
})

describe('trimVideoLayer — 边界与不变量', () => {
  it('非 video 图层 throw', () => {
    expect(() => trimVideoLayer(talkSpec(), 'a', 'start', 1)).toThrow()
  })

  it('不存在的图层 throw', () => {
    expect(() => trimVideoLayer(talkSpec(), 'nope', 'start', 1)).toThrow()
  })

  it('δ=0 / 钳成 0 的无操作返回同一引用', () => {
    const spec = talkSpec()
    expect(trimVideoLayer(spec, 'v', 'start', 0)).toBe(spec)
    // trimStart 已是 0，再吐回去是无操作
    expect(trimVideoLayer(spec, 'v', 'start', -1)).toBe(spec)
    const min = trimVideoLayer(spec, 'v', 'end', 99)
    expect(trimVideoLayer(min, 'v', 'end', 5)).toBe(min)
  })

  it('浮点用 round3', () => {
    const out = trimVideoLayer(talkSpec(), 'v', 'end', 0.1 + 0.2)
    expect(layerOf(out, 'v').duration).toBe(11.7)
    expect(out.durationSec).toBe(11.7)
  })
})

describe('addCaptionLayer', () => {
  it('沿用既有 caption 层的 track，id 唯一且不冲突', () => {
    const spec = baseSpec({
      durationSec: 12,
      layers: [videoLayer(), captionLayer({ id: 'cap-manual-1', start: 0, duration: 1, track: 7 })],
    })
    const before = snapshot(spec)
    const out = addCaptionLayer(spec, 5, '手动字幕')
    expect(spec).toEqual(before)
    expect(out.layers).toHaveLength(3)
    const added = out.layers[out.layers.length - 1]
    expect(added.id).toBe('cap-manual-2')
    expect(added.track).toBe(7)
    expect(added.kind).toBe('caption')
    expect(added.from).toBeNull()
    expect(added.overridden).toBe(true)
    expect(added.start).toBe(5)
    expect(added.duration).toBe(2.5)
    expect(added.content).toEqual({ kind: 'caption', text: '手动字幕' })
    expect(added.style).toEqual({ cssClass: 'cap' })
    expect(added.effects).toEqual([])
  })

  it('无既有 caption 层时取 max(track)+1', () => {
    const spec = baseSpec({ durationSec: 12, layers: [videoLayer({ track: 0 }), textLayer({ id: 'a', track: 4 })] })
    const out = addCaptionLayer(spec, 1, 'x')
    expect(out.layers[out.layers.length - 1].track).toBe(5)
  })

  it('同轨重叠时向后顺延起点', () => {
    const spec = baseSpec({
      durationSec: 20,
      layers: [videoLayer({ duration: 20 }), captionLayer({ id: 'c1', start: 4, duration: 3, track: 2 })],
    })
    const out = addCaptionLayer(spec, 5, 'x')
    const added = out.layers[out.layers.length - 1]
    expect(added.start).toBe(7)
    expect(added.duration).toBe(2.5)
  })

  it('连续两条邻居时继续顺延', () => {
    const spec = baseSpec({
      durationSec: 20,
      layers: [
        videoLayer({ duration: 20 }),
        captionLayer({ id: 'c1', start: 4, duration: 3, track: 2 }),
        captionLayer({ id: 'c2', start: 7, duration: 2, track: 2 }),
      ],
    })
    const added = addCaptionLayer(spec, 5, 'x').layers.slice(-1)[0]
    expect(added.start).toBe(9)
  })

  it('tSec 钳到 [0, durationSec-0.5]，末尾自动缩短', () => {
    const spec = baseSpec({ durationSec: 12, layers: [videoLayer()] })
    expect(addCaptionLayer(spec, -5, 'x').layers.slice(-1)[0].start).toBe(0)
    const tail = addCaptionLayer(spec, 99, 'x').layers.slice(-1)[0]
    expect(tail.start).toBe(11.5)
    expect(tail.duration).toBe(0.5)
  })

  it('顺延到末尾放不下时贴末尾缩短，最少 0.5s', () => {
    const spec = baseSpec({
      durationSec: 12,
      layers: [videoLayer(), captionLayer({ id: 'c1', start: 8, duration: 3.8, track: 2 })],
    })
    const added = addCaptionLayer(spec, 9, 'x').layers.slice(-1)[0]
    expect(added.start).toBe(11.5)
    expect(added.duration).toBe(0.5)
  })
})

describe('setVideoVolume', () => {
  it('设置音量并置 overridden，原 spec 不变', () => {
    const spec = talkSpec()
    const before = snapshot(spec)
    const out = setVideoVolume(spec, 'v', 0.4)
    expect(spec).toEqual(before)
    expect(contentOf(out, 'v').volume).toBe(0.4)
    expect(contentOf(out, 'v').src).toBe('talk.mp4')
    expect(layerOf(out, 'v').overridden).toBe(true)
  })

  it('clamp 到 0..1', () => {
    expect(contentOf(setVideoVolume(talkSpec(), 'v', 5), 'v').volume).toBe(1)
    expect(contentOf(setVideoVolume(talkSpec(), 'v', -3), 'v').volume).toBe(0)
  })

  it('非 video 图层 throw', () => {
    expect(() => setVideoVolume(talkSpec(), 'a', 0.5)).toThrow()
  })
})
