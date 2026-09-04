import { describe, expect, it } from 'vitest'
import type { Layer, VideoSpec } from '@forgecast/studio'
import { addCaptionLayer, removeCaptionLayer, setVideoVolume, trimVideoLayer } from '../src/video-ops'
import { baseSpec, captionLayer, snapshot, textLayer } from './fixtures'

const videoLayer = (over: Partial<Layer> = {}): Layer => ({
  id: over.id ?? 'v', kind: 'video', from: null, overridden: over.overridden ?? false,
  start: over.start ?? 0, duration: over.duration ?? 12, track: over.track ?? 0,
  content: over.content ?? { kind: 'video', src: 'talk.mp4', muted: false },
  style: over.style ?? {}, effects: over.effects ?? [],
})

/**
 * 口播底片 v[0,12) 在 track0；动效层复刻 lowerTalk 的真实结构——hook/card/cta **同在 track 1**，
 * 比例照抄 `[0,.15D) / [.15D,.85D) / [.85D,D)`：a=hook[0,1.8)、b=card[1.8,10.2)、c=cta[10.2,12)。
 * 「同一轨」是关键：早期 fixture 把它们摊在 track1/track2 上，于是逐层独立钳回的重叠缺陷永远照不出来。
 */
const talkSpec = (over: Partial<VideoSpec> = {}): VideoSpec =>
  baseSpec({
    durationSec: 12,
    layers: [
      videoLayer(),
      textLayer({ id: 'a', start: 0, duration: 1.8, track: 1 }),
      textLayer({ id: 'b', start: 1.8, duration: 8.4, track: 1 }),
      textLayer({ id: 'c', start: 10.2, duration: 1.8, track: 1 }),
    ],
    ...over,
  })

const round1 = (n: number) => Math.round(n * 10) / 10

/**
 * 同 track 不重叠是 spec 硬规则（server 的 validateSpecPut 会 400，用户一按 ⌘S 就被拒）。
 * editing 不 import server：这里按同一口径（同 track 排序后相邻比较）自查。
 */
const expectNoOverlap = (s: VideoSpec) => {
  const byTrack = new Map<number, VideoSpec['layers']>()
  for (const l of s.layers) byTrack.set(l.track, [...(byTrack.get(l.track) ?? []), l])
  for (const [track, ls] of byTrack) {
    const sorted = [...ls].sort((a, b) => a.start - b.start)
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1]
      const overlap = round1(prev.start + prev.duration) > sorted[i].start
      expect(overlap ? `track${track} 重叠：${prev.id} × ${sorted[i].id}` : 'ok').toBe('ok')
    }
  }
}

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

/** 吐尾不能超过片源物理长度：trimEnd 越过源视频末尾时 Remotion 会定格/报错，
 *  钳制必须在纯函数里（Inspector 的数字输入绕得过任何只做在 UI 上的钳）。 */
describe('trimVideoLayer — edge=end 的片源长度钳制（sourceDurationSec）', () => {
  /** 片源 15s，已裁成 v[0,12)（头裁 1、尾裁 2）：还能往后吐 2s。 */
  const srcSpec = (over: Partial<VideoSpec> = {}): VideoSpec =>
    talkSpec({
      layers: [
        videoLayer({ content: { kind: 'video', src: 'talk.mp4', muted: false, trimStart: 1, trimEnd: 13, sourceDurationSec: 15 } }),
        textLayer({ id: 'a', start: 0, duration: 1.8, track: 1 }),
        textLayer({ id: 'b', start: 1.8, duration: 8.4, track: 1 }),
        textLayer({ id: 'c', start: 10.2, duration: 1.8, track: 1 }),
      ],
      ...over,
    })

  it('吐回量不超过剩余片源：δ=-5 只吐 2，trimEnd 停在 sourceDurationSec', () => {
    const out = trimVideoLayer(srcSpec(), 'v', 'end', -5)
    expect(layerOf(out, 'v').duration).toBe(14)
    expect(out.durationSec).toBe(14)
    expect(contentOf(out, 'v').trimStart).toBe(1)
    expect(contentOf(out, 'v').trimEnd).toBe(15)
    // 返回值一致性：trimEnd - trimStart 恒等于新 duration，durationSec 与之联动
    expect(contentOf(out, 'v').trimEnd! - contentOf(out, 'v').trimStart!).toBe(layerOf(out, 'v').duration)
  })

  it('吐到片源末尾后再吐是无操作（δ 钳成 0 → 同一引用）', () => {
    const full = trimVideoLayer(srcSpec(), 'v', 'end', -2)
    expect(contentOf(full, 'v').trimEnd).toBe(15)
    expect(trimVideoLayer(full, 'v', 'end', -0.5)).toBe(full)
  })

  it('未越界的吐回照常生效（钳制只砍超出的那部分）', () => {
    const out = trimVideoLayer(srcSpec(), 'v', 'end', -1)
    expect(layerOf(out, 'v').duration).toBe(13)
    expect(contentOf(out, 'v').trimEnd).toBe(14)
  })

  it('钳制只管吐尾：δ>0 的多裁不受 sourceDurationSec 影响', () => {
    const out = trimVideoLayer(srcSpec(), 'v', 'end', 2)
    expect(layerOf(out, 'v').duration).toBe(10)
    expect(contentOf(out, 'v').trimEnd).toBe(11)
  })

  it('钳制不越界到 edge=start：吐头仍只受 trimStart 限制', () => {
    const out = trimVideoLayer(srcSpec(), 'v', 'start', -5)
    expect(contentOf(out, 'v').trimStart).toBe(0)
    expect(layerOf(out, 'v').duration).toBe(13)
  })

  it('无 sourceDurationSec（老 spec）→ 行为完全不变，仍可无限吐', () => {
    const cut = trimVideoLayer(talkSpec(), 'v', 'end', 3)
    const out = trimVideoLayer(cut, 'v', 'end', -50)
    expect(layerOf(out, 'v').duration).toBe(59)
    expect(contentOf(out, 'v').trimEnd).toBe(59)
  })
})

describe('trimVideoLayer — 越界图层钳回', () => {
  it('duration 超界的截短（start 仍在界内）', () => {
    // 裁到 10：c=cta[10.2,12) 右缘越界 → 保时长贴末尾到 [8.2,10)，
    // 于是 b=card[1.8,10.2) 也得让位，截到右缘 8.2（同轨不能压着 cta）
    const spec = talkSpec()
    const out = trimVideoLayer(spec, 'v', 'end', 2)
    expect(layerOf(out, 'c').start).toBe(8.2)
    expect(layerOf(out, 'c').duration).toBe(1.8)
    expect(layerOf(out, 'b').start).toBe(1.8)
    expect(layerOf(out, 'b').duration).toBe(6.4)
    expect(layerOf(out, 'b').overridden).toBe(true)
    // 没被挤到的层保持原引用（前端 memo 依赖）
    expect(layerOf(out, 'a')).toBe(layerOf(spec, 'a'))
    expect(layerOf(out, 'a').overridden).toBe(false)
    expectNoOverlap(out)
  })

  it('start 超界的贴末尾（保时长，整体左移）', () => {
    // 裁到 8.1：c 的 start=10.2 已在界外 → 贴末尾 start = 8.1-1.8 = 6.3，duration 保 1.8
    const out = trimVideoLayer(talkSpec(), 'v', 'end', 3.9)
    expect(out.durationSec).toBe(8.1)
    expect(layerOf(out, 'c').start).toBe(6.3)
    expect(layerOf(out, 'c').duration).toBe(1.8)
    expect(layerOf(out, 'b').duration).toBe(4.5)   // card 让位到 [1.8,6.3)
    expectNoOverlap(out)
  })

  it('完全放不下时挤成最短——仍不删层、仍不重叠', () => {
    // 裁到 1：track1 三层各要 0.2，左移带地板（左边层数 × 0.2）→ a[0,.2) b[.2,.2) c[.4,.6)。
    const out = trimVideoLayer(talkSpec(), 'v', 'end', 11)
    expect(out.durationSec).toBe(1)
    expect(out.layers).toHaveLength(4)
    expect(layerOf(out, 'a').start).toBe(0)
    expect(layerOf(out, 'a').duration).toBe(0.2)
    expect(layerOf(out, 'b').start).toBe(0.2)
    expect(layerOf(out, 'b').duration).toBe(0.2)
    expect(layerOf(out, 'c').start).toBe(0.4)
    expect(layerOf(out, 'c').duration).toBe(0.6)
    expectNoOverlap(out)
  })

  it('trim 后同轨仍无重叠（全量 δ 扫描；同轨邻居不能被逐层独立钳出重叠）', () => {
    // 真实 lowerTalk 把 hook/card/cta 全放 track 1。逐层独立钳回时，card 只被截短、
    // cta 却「保时长左移」，两者必然叠在一起 → server validateSpecPut 400 → ⌘S 与渲成片全挂。
    const spec = talkSpec()
    // δ 上界留到 durationSec ≥ 0.6：track1 有 3 层、每层最短 0.2，再短就是物理上放不下
    // （不删层的铁律下无解），不属于本不变量的辖区。
    for (let d = 0; d <= 11.4; d = round1(d + 0.1)) {
      const out = trimVideoLayer(spec, 'v', 'end', d)
      expectNoOverlap(out)
      expect(out.layers).toHaveLength(spec.layers.length)
      // 裁头同样联动 durationSec，一并扫
      expectNoOverlap(trimVideoLayer(spec, 'v', 'start', d))
    }
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

  it('顺延到末尾放不下时不加层，返回同一引用（严格不重叠）', () => {
    const spec = baseSpec({
      durationSec: 12,
      layers: [videoLayer(), captionLayer({ id: 'c1', start: 8, duration: 3.8, track: 2 })],
    })
    const out = addCaptionLayer(spec, 9, 'x')
    // 贴末尾缩短会与 c1 重叠，而同 track 不重叠是硬规则（server validateSpecPut 会 400）
    expect(out).toBe(spec)
    expect(out.layers).toHaveLength(2)
  })

  it('末尾剩余不足 0.5s 时不加层', () => {
    const spec = baseSpec({ durationSec: 0.4, layers: [videoLayer({ duration: 0.4 })] })
    expect(addCaptionLayer(spec, 0, 'x')).toBe(spec)
  })

  it('末尾剩余介于 0.5 与 2.5 之间时缩短到剩余长度', () => {
    const spec = baseSpec({
      durationSec: 12,
      layers: [videoLayer(), captionLayer({ id: 'c1', start: 8, duration: 2, track: 2 })],
    })
    const added = addCaptionLayer(spec, 9, 'x').layers.slice(-1)[0]
    expect(added.start).toBe(10)
    expect(added.duration).toBe(2)
  })

  it('加完的 spec 同轨仍无重叠（复刻 validateSpecPut 的重叠检查）', () => {
    const base = baseSpec({
      durationSec: 12,
      layers: [
        videoLayer(),
        captionLayer({ id: 'c1', start: 1, duration: 2, track: 2 }),
        captionLayer({ id: 'c2', start: 4, duration: 2, track: 2 }),
        captionLayer({ id: 'c3', start: 8, duration: 3.8, track: 2 }),
      ],
    })
    // 全时间轴扫一遍插入点：无论加成还是没加成，结果都必须无重叠
    for (let t = -1; t <= 13; t = round1(t + 0.25)) {
      const out = addCaptionLayer(base, t, `t=${t}`)
      expectNoOverlap(out)
      expect(out.layers.length).toBeLessThanOrEqual(base.layers.length + 1)
    }
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

describe('removeCaptionLayer', () => {
  const withManual = (over: Partial<Layer> = {}) => baseSpec({
    durationSec: 12,
    layers: [
      videoLayer(),
      captionLayer({ id: 'cap0', from: null, start: 0, duration: 2, track: 9 }),
      captionLayer({ id: 'cap-manual-1', from: null, start: 4, duration: 2.5, track: 2, ...over }),
    ],
  })

  it('删掉那一层，层数 -1，其余图层保持原引用，入参不被改', () => {
    const spec = withManual()
    const before = snapshot(spec)
    const out = removeCaptionLayer(spec, 'cap-manual-1')
    expect(spec).toEqual(before)
    expect(out.layers).toHaveLength(2)
    expect(out.layers.map((l) => l.id)).toEqual(['v', 'cap0'])
    expect(out.layers[0]).toBe(spec.layers[0])
    expect(out.layers[1]).toBe(spec.layers[1])
    // durationSec 不动：删一条字幕不改片长
    expect(out.durationSec).toBe(spec.durationSec)
  })

  it('undo 语境：删除返回的是新对象，旧引用仍是删除前那份（可整份回退）', () => {
    const spec = withManual()
    const out = removeCaptionLayer(spec, 'cap-manual-1')
    expect(out).not.toBe(spec)
    expect(spec.layers).toHaveLength(3)
    expect(spec.layers.some((l) => l.id === 'cap-manual-1')).toBe(true)
  })

  it('非手动字幕（TTS 的 cap0）throw——它与旁白一一对应，不该被清空文本顺手删掉', () => {
    const spec = withManual()
    expect(() => removeCaptionLayer(spec, 'cap0')).toThrow(/不是手动字幕/)
    expect(spec.layers).toHaveLength(3)
  })

  it('前缀对但不是字幕层 / 不存在的 id 都 throw', () => {
    const notCaption = baseSpec({
      durationSec: 12,
      layers: [videoLayer(), textLayer({ id: 'cap-manual-1', track: 5 })],
    })
    expect(() => removeCaptionLayer(notCaption, 'cap-manual-1')).toThrow(/不是字幕层/)
    expect(() => removeCaptionLayer(withManual(), 'cap-manual-9')).toThrow(/不存在/)
  })
})
