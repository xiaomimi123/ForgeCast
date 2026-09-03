import { describe, expect, it } from 'vitest'
import type { VideoSpec } from '@forgecast/studio'
import type { ShotView } from '../src/shots'
import { addManualBeat, allBeats, layoutRow, moveShotBy, removeManualBeat, snapToBeats } from '../src/timeline'
import { baseSpec, snapshot, textLayer } from './fixtures'

/** layoutRow 只用得到 ShotView 里跟布局有关的几个字段，role/text/rewritable 随便填。 */
const shot = (over: Partial<ShotView>): ShotView => ({
  sectionId: 'sec', role: 'body', text: '', layerIds: [], rewritable: false,
  startSec: 0, endSec: 0,
  ...over,
})

describe('layoutRow', () => {
  it('三段重叠链（0-4/2-4.5/4-8, duration 8）权重和=80，重叠段被裁到不越邻居', () => {
    const shots = [
      shot({ sectionId: 'a', startSec: 0, endSec: 4 }),
      shot({ sectionId: 'b', startSec: 2, endSec: 4.5 }),
      shot({ sectionId: 'c', startSec: 4, endSec: 8 }),
    ]
    const cells = layoutRow(shots, 8)
    expect(cells).toEqual([
      { kind: 'clip', key: 'a', weight: 20, shot: shots[0] },
      { kind: 'clip', key: 'b', weight: 20, shot: shots[1] },
      { kind: 'clip', key: 'c', weight: 40, shot: shots[2] },
    ])
    const total = cells.reduce((s, c) => s + c.weight, 0)
    expect(total).toBe(80) // duration(8) × 10
  })

  it('有空隙时补 gap 单元，权重同口径累加仍等于 duration×10', () => {
    const shots = [shot({ sectionId: 'a', startSec: 1, endSec: 3 })]
    const cells = layoutRow(shots, 5)
    expect(cells).toEqual([
      { kind: 'gap', key: 'gap-a', weight: 10 },
      { kind: 'clip', key: 'a', weight: 20, shot: shots[0] },
      { kind: 'gap', key: 'gap-tail', weight: 20 },
    ])
    expect(cells.reduce((s, c) => s + c.weight, 0)).toBe(50)
  })
})

describe('moveShotBy', () => {
  /** 同 section 两层同 track、首尾相接：l1[0,2) l2[2,4)，无其它邻居，durationSec 足够大。 */
  const twoLayerSpec = (): VideoSpec =>
    baseSpec({
      durationSec: 20,
      layers: [
        textLayer({ id: 'l1', from: 'sec-hook', start: 0, duration: 2, track: 1 }),
        textLayer({ id: 'l2', from: 'sec-hook', start: 2, duration: 2, track: 1 }),
      ],
    })
  const twoLayerShot: ShotView = { sectionId: 'sec-hook', role: 'hook', text: '', rewritable: false, layerIds: ['l1', 'l2'], startSec: 0, endSec: 4 }

  it('双层同轨右移不互钳：组内相对偏移（间隔 2s）保持', () => {
    const out = moveShotBy(twoLayerSpec(), twoLayerShot, 3)
    const l1 = out.layers.find((l) => l.id === 'l1')!
    const l2 = out.layers.find((l) => l.id === 'l2')!
    expect(l1.start).toBe(3)
    expect(l2.start).toBe(5)
    expect(l2.start - l1.start).toBe(2)
  })

  it('双层同轨左移同样不互钳', () => {
    const base = twoLayerSpec()
    // 先把两层挪到 [5,7) [7,9) 再左移，验证左移顺序（先移最左层）也不自锁
    const shifted: VideoSpec = { ...base, layers: base.layers.map((l) => (l.id === 'l1' ? { ...l, start: 5 } : l.id === 'l2' ? { ...l, start: 7 } : l)) }
    const out = moveShotBy(shifted, twoLayerShot, -3)
    const l1 = out.layers.find((l) => l.id === 'l1')!
    const l2 = out.layers.find((l) => l.id === 'l2')!
    expect(l1.start).toBe(2)
    expect(l2.start).toBe(4)
  })

  it('撞邻钳制：外部邻居挡住时整组退到最小 effective 位移，相对偏移仍保持', () => {
    const spec: VideoSpec = {
      ...baseSpec({ durationSec: 20 }),
      layers: [
        textLayer({ id: 'l1', from: 'sec-hook', start: 0, duration: 2, track: 1 }),
        textLayer({ id: 'l2', from: 'sec-hook', start: 2, duration: 2, track: 1 }),
        // 外部邻居（不属于该 shot）挡在 track 1 的 7 秒处
        textLayer({ id: 'blocker', from: null, start: 7, duration: 1, track: 1 }),
      ],
    }
    // 想右移 10，但 l2 撞邻居只能走到 5（7-2），effective 被压到 3
    const out = moveShotBy(spec, twoLayerShot, 10)
    const l1 = out.layers.find((l) => l.id === 'l1')!
    const l2 = out.layers.find((l) => l.id === 'l2')!
    expect(l2.start).toBe(5)
    expect(l1.start).toBe(3)
    expect(l2.start - l1.start).toBe(2) // 组内相对偏移没被撞散
  })
})

describe('allBeats', () => {
  it('三态齐出：strong 原样、网格外推出的非 strong 位置→derived、manualBeats→manual', () => {
    const grid = { t0: 0, T: 2, bpm: 120, strongBeats: [0, 4], manualBeats: [5] }
    const beats = allBeats(grid, 6)
    expect(beats).toEqual([
      { t: 0, kind: 'strong' },
      { t: 2, kind: 'derived' },
      { t: 4, kind: 'strong' },
      { t: 5, kind: 'manual' },
      { t: 6, kind: 'derived' },
    ])
  })

  it('同 t（±0.01s）去重，优先级 manual > strong > derived', () => {
    const grid = { t0: 0, T: 2, bpm: 120, strongBeats: [], manualBeats: [2.005] }
    const beats = allBeats(grid, 4)
    // 网格外推出 0/2/4 全是 derived，manual@2.005 与 derived@2 距离 0.005<=0.01，manual 胜出
    expect(beats).toEqual([
      { t: 0, kind: 'derived' },
      { t: 2.005, kind: 'manual' },
      { t: 4, kind: 'derived' },
    ])
  })

  it('T<=0 时只出 manual，跳过网格外推', () => {
    const grid = { t0: 5, T: 0, bpm: 0, strongBeats: [], manualBeats: [1, 2] }
    expect(allBeats(grid, 10)).toEqual([
      { t: 1, kind: 'manual' },
      { t: 2, kind: 'manual' },
    ])
  })

  it('越界（<0 或 >durationSec）剔除', () => {
    const grid = { t0: 0, T: 1, bpm: 60, strongBeats: [-1, 3], manualBeats: [5] }
    // strongBeats 的 -1/3 越界剔除；manualBeats 的 5 越界剔除；网格外推 0/1/2 全落在界内且都不是 derived 之外的 strong（因为界内没有匹配的 strongBeats）
    expect(allBeats(grid, 2)).toEqual([
      { t: 0, kind: 'derived' },
      { t: 1, kind: 'derived' },
      { t: 2, kind: 'derived' },
    ])
  })

  it('grid 为 null → 空数组', () => {
    expect(allBeats(null, 10)).toEqual([])
  })
})

describe('addManualBeat / removeManualBeat', () => {
  it('不可变：返回新对象，原 spec 不变', () => {
    const spec = baseSpec({ durationSec: 10 })
    const before = snapshot(spec)
    const out = addManualBeat(spec, 2)
    expect(out).not.toBe(spec)
    expect(spec).toEqual(before)
  })

  it('beatGrid 为 null 时建 {t0:0,T:0,bpm:0,strongBeats:[],manualBeats:[t]} 形状', () => {
    const out = addManualBeat(baseSpec({ durationSec: 10 }), 2)
    expect(out.audio.beatGrid).toEqual({ t0: 0, T: 0, bpm: 0, strongBeats: [], manualBeats: [2] })
  })

  it('幂等：重复 t（±0.01s）不重复添加', () => {
    const spec = addManualBeat(baseSpec({ durationSec: 10 }), 2)
    const out = addManualBeat(spec, 2.005)
    expect((out.audio.beatGrid as { manualBeats: number[] }).manualBeats).toEqual([2])
  })

  it('超出 ±0.01s 的新点正常追加', () => {
    const spec = addManualBeat(baseSpec({ durationSec: 10 }), 2)
    const out = addManualBeat(spec, 2.02)
    expect((out.audio.beatGrid as { manualBeats: number[] }).manualBeats).toEqual([2, 2.02])
  })

  it('removeManualBeat 按 ±0.01s 匹配删除，其余点保留', () => {
    const spec = addManualBeat(addManualBeat(baseSpec({ durationSec: 10 }), 2), 5)
    const out = removeManualBeat(spec, 2.005)
    expect((out.audio.beatGrid as { manualBeats: number[] }).manualBeats).toEqual([5])
  })

  it('removeManualBeat 没匹配到时原样返回（同引用）', () => {
    const spec = addManualBeat(baseSpec({ durationSec: 10 }), 2)
    const out = removeManualBeat(spec, 10)
    expect(out).toBe(spec)
  })
})

describe('snapToBeats', () => {
  it('吸最近的拍点', () => {
    expect(snapToBeats([1, 5, 9], 4.6, 1)).toBe(5)
  })

  it('阈值恰等也吸（round3 比较避免浮点误判）', () => {
    expect(snapToBeats([2], 2.08, 0.08)).toBe(2)
  })

  it('阈值外原值返回', () => {
    expect(snapToBeats([2], 2.2, 0.1)).toBe(2.2)
  })

  it('空数组原值返回', () => {
    expect(snapToBeats([], 3.3, 1)).toBe(3.3)
  })
})
