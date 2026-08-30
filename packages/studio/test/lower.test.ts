import { describe, expect, it } from 'vitest'
import { lower } from '../src/lower'

const base = {
  videoId: 'v1', slug: 's', canvas: { width: 1080, height: 1920 },
  durationSec: 30, cues: [{ start: 2, end: 6, text: 'a' }],
  audio: { narration: null, bgm: null, beatGrid: null, captionsEnabled: false },
}
const sem = (sections: any[]) => ({ hook: 'pain', sourceAssetId: null, sections })

describe('lower 通用不变量（五个模板都必须满足）', () => {
  for (const template of ['flash', 'story', 'demo', 'changelog', 'insight']) {
    it(`${template}: 同 track 上的图层不得时间重叠`, () => {
      const spec = lower(sem([
        { id: 'hook', role: 'hook', text: '钩子' },
        { id: 'cta', role: 'cta', text: '行动' },
      ]), { ...base, template } as any)
      const byTrack = new Map<number, Array<{ s: number; e: number }>>()
      for (const l of spec.layers) {
        const arr = byTrack.get(l.track) ?? []
        arr.push({ s: l.start, e: l.start + l.duration })
        byTrack.set(l.track, arr)
      }
      for (const arr of byTrack.values()) {
        arr.sort((a, b) => a.s - b.s)
        for (let i = 1; i < arr.length; i++) expect(arr[i].s).toBeGreaterThanOrEqual(arr[i - 1].e - 1e-6)
      }
    })

    it(`${template}: 每个图层都有稳定非空 id，且两次 lower 结果一致`, () => {
      const s1 = lower(sem([{ id: 'hook', role: 'hook', text: 'x' }]), { ...base, template } as any)
      const s2 = lower(sem([{ id: 'hook', role: 'hook', text: 'x' }]), { ...base, template } as any)
      expect(s1.layers.map((l) => l.id)).toEqual(s2.layers.map((l) => l.id))
      expect(s1.layers.every((l) => l.id.length > 0)).toBe(true)
    })

    it(`${template}: 图层不超出片长`, () => {
      const spec = lower(sem([{ id: 'hook', role: 'hook', text: 'x' }]), { ...base, template } as any)
      for (const l of spec.layers) expect(l.start + l.duration).toBeLessThanOrEqual(base.durationSec + 1e-6)
    })

    it(`${template}: 每个来自 section 的图层都带 from 且 overridden=false`, () => {
      const spec = lower(sem([{ id: 'hook', role: 'hook', text: 'x' }]), { ...base, template } as any)
      const fromSection = spec.layers.filter((l) => l.kind !== 'caption')
      expect(fromSection.every((l) => l.from !== null && l.overridden === false)).toBe(true)
    })
  }
})

describe('lower：字幕图层', () => {
  it('captionsEnabled=true 时 cues 生成 kind=caption/from=null/track=9 的图层', () => {
    const spec = lower(sem([{ id: 'pain', role: 'pain', text: 'x' }, { id: 'cta', role: 'cta', text: 'y' }]), {
      ...base, template: 'flash',
      audio: { narration: null, bgm: null, beatGrid: null, captionsEnabled: true },
    } as any)
    const caps = spec.layers.filter((l) => l.kind === 'caption')
    expect(caps.length).toBe(base.cues.length)
    for (const c of caps) {
      expect(c.from).toBeNull()
      expect(c.track).toBe(9)
    }
  })

  it('captionsEnabled=false 时不生成字幕图层', () => {
    const spec = lower(sem([{ id: 'pain', role: 'pain', text: 'x' }]), { ...base, template: 'flash' } as any)
    expect(spec.layers.some((l) => l.kind === 'caption')).toBe(false)
  })
})

describe('lower：insight 三条硬约束行为', () => {
  const cues = [
    { start: 2, end: 5, text: '返工率高达 30%' },
    { start: 4, end: 7, text: '多花 3 个工作日' },
    { start: 6, end: 9, text: '工期要 2-4周' },
    { start: 25, end: 28, text: '外面报价 5 万起' },
  ]
  const sections = [
    { id: 'pain', role: 'pain', text: '标题' },
    { id: 'cta', role: 'cta', text: '行动' },
  ]

  it('同组卡片各占独立 track（2+idx），允许时间重叠（累加共存）', () => {
    const spec = lower(sem(sections), { ...base, template: 'insight', durationSec: 30, cues } as any)
    const cards = spec.layers.filter((l) => l.id.startsWith('insCard0_'))
    expect(cards.length).toBe(3) // 前三条 cue 间隔 <=12s，归为一组（第4条相隔太远另开组，但超出组容量前已用掉配额）
    const tracks = cards.map((c) => c.track).sort()
    expect(tracks).toEqual([2, 3, 4])
    // 至少有一对卡片在时间上重叠（accumulate 语义，不能被"修复"成不重叠）
    const overlap = cards.some((a) => cards.some((b) => a !== b && a.start < b.start + b.duration && b.start < a.start + a.duration))
    expect(overlap).toBe(true)
  })

  it('组内最后一张卡不设驻留上限，持续到 sceneEnd（不被硬编码 8s 截断）', () => {
    // 单卡组：card.start=25，距 outroStart(=durationSec-3=27) 只有 2s < 8s cap，不足以验证 cap 是否生效
    // 用稀疏组：group0 的最后一张卡到 group1 开始前的 sceneEnd 应撑满，而非固定 8s
    const sparseCues = [
      { start: 2, end: 5, text: '返工率高达 30%' },
      { start: 20, end: 23, text: '外面报价 5 万起' },
    ]
    const spec = lower(sem(sections), { ...base, template: 'insight', durationSec: 30, cues: sparseCues } as any)
    const card0 = spec.layers.find((l) => l.id === 'insCard0_0')!
    // group0 只有一张卡（与 group1 间隔 18s > 12s 强制分组），是本组最后一张 → 撑到下一组开始(20)
    expect(card0.duration).toBeCloseTo(20 - 2, 5)
    expect(card0.duration).toBeGreaterThan(8) // 明确不是硬编码 8s 上限
  })

  it('hero（demote 效果）跟随"当前是否独播"而非组内下标：接力式独播不产生降级效果', () => {
    // 两张卡在同一组但时间不重叠（接力）：第二张进场时第一张已播完，不应触发 demote
    const relayCues = [
      { start: 2, end: 5, text: '返工率高达 30%' },
      { start: 10, end: 13, text: '工期要 2-4周' },
    ]
    const spec = lower(sem(sections), { ...base, template: 'insight', durationSec: 30, cues: relayCues } as any)
    const allDemotes = spec.layers.flatMap((l) => l.effects.filter((e) => e.type === 'demote'))
    expect(allDemotes.length).toBe(0)

    // 真重叠场景：两张卡间隔小于第一张的驻留时长，第二张进场时第一张仍在播 → 触发 demote
    const overlapCues = [
      { start: 2, end: 5, text: '返工率高达 30%' },
      { start: 4, end: 7, text: '工期要 2-4周' },
    ]
    const spec2 = lower(sem(sections), { ...base, template: 'insight', durationSec: 30, cues: overlapCues } as any)
    const demotes2 = spec2.layers.flatMap((l) => l.effects.filter((e) => e.type === 'demote'))
    expect(demotes2.length).toBeGreaterThan(0)
  })

  it('组内最多 3 张卡（超出的第 4 条另起新组）', () => {
    const denseCues = [
      { start: 1, end: 2, text: '30%' },
      { start: 2, end: 3, text: '3天' },
      { start: 3, end: 4, text: '5万' },
      { start: 4, end: 5, text: '2倍' },
    ]
    const spec = lower(sem(sections), { ...base, template: 'insight', durationSec: 30, cues: denseCues } as any)
    const group0 = spec.layers.filter((l) => l.id.startsWith('insCard0_'))
    const group1 = spec.layers.filter((l) => l.id.startsWith('insCard1_'))
    expect(group0.length).toBe(3)
    expect(group1.length).toBe(1)
  })

  it('insCard{gi}_{idx} id 命名模式保留', () => {
    const spec = lower(sem(sections), { ...base, template: 'insight', durationSec: 30, cues } as any)
    const ids = spec.layers.filter((l) => l.id.includes('insCard')).map((l) => l.id)
    expect(ids).toContain('insCard0_0')
    expect(ids).toContain('insCard0_1')
  })
})

describe('lower：story/demo 节拍吸附与 demo cutplan', () => {
  it('story 传 beatGrid 时段落起点吸附到拍点，且保持顺序不倒序', () => {
    const beatGrid = { t0: 0, T: 2, bpm: 30, beats: [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30], strongBeats: [], duration: 30 }
    const spec = lower(sem([{ id: 'body', role: 'body', text: '卖点' }, { id: 'cta', role: 'cta', text: '行动' }]), {
      ...base, template: 'story', durationSec: 30, beatGrid,
    } as any)
    // snapStarts 的契约是"吸附到最近拍，但不早于前一段结束"——不是每个 start 都严格落在拍点上
    // （前一段结束可能落在两拍中间）。这里断言：起点严格递增（不倒序），且第一段(0)恰好落在拍点。
    const starts = spec.layers.map((l) => l.start).sort((a, b) => a - b)
    for (let i = 1; i < starts.length; i++) expect(starts[i]).toBeGreaterThanOrEqual(starts[i - 1])
    expect(starts[0] % 2).toBeCloseTo(0, 5)
  })

  it('demo 提供 plan 时按 planCutTimes 生成轮播图层，落在轮播窗口内', () => {
    const shots = [
      { rel: 's1.jpg', orientation: 'portrait' as const },
      { rel: 's2.jpg', orientation: 'landscape' as const },
    ]
    const plan = { grid: { t0: 0, T: 1 }, offsetSec: 0, cuts: [{ beat: 8, shot: 0 }, { beat: 14, shot: 1 }] }
    const spec = lower(sem([{ id: 'pain', role: 'pain', text: '标题' }, { id: 'cta', role: 'cta', text: '行动' }]), {
      ...base, template: 'demo', durationSec: 30, shots, plan,
    } as any)
    const images = spec.layers.filter((l) => l.kind === 'image')
    expect(images.length).toBe(2)
    for (const img of images) { expect(img.start).toBeGreaterThanOrEqual(6); expect(img.start).toBeLessThan(24) }
  })

  it('demo 未提供 plan 但有 beatGrid 时用 autoCutPlan 兜底生成轮播', () => {
    const shots = [
      { rel: 's1.jpg', orientation: 'portrait' as const },
      { rel: 's2.jpg', orientation: 'landscape' as const },
    ]
    const beatGrid = { t0: 0, T: 2, bpm: 30, beats: [], strongBeats: [], duration: 40 }
    const spec = lower(sem([{ id: 'pain', role: 'pain', text: '标题' }, { id: 'cta', role: 'cta', text: '行动' }]), {
      ...base, template: 'demo', durationSec: 40, shots, beatGrid,
    } as any)
    const images = spec.layers.filter((l) => l.kind === 'image')
    expect(images.length).toBeGreaterThan(0)
  })
})

describe('lower：props.ts 依赖的 section id 查找路径不受影响', () => {
  it('demo 按 pain-1/body-1 取 painPoints/priceAnchor', () => {
    const sections = [
      { id: 'pain', role: 'pain', text: '标题' },
      { id: 'body', role: 'body', text: '卖点' },
      { id: 'pain-1', role: 'pain', items: ['痛点一', '痛点二'] },
      { id: 'body-1', role: 'body', text: '报价锚点' },
      { id: 'cta', role: 'cta', text: '行动' },
    ]
    const spec = lower(sem(sections), { ...base, template: 'demo', durationSec: 30 } as any)
    const pain = spec.layers.find((l) => l.id === 'demo-pain')!
    const price = spec.layers.find((l) => l.id === 'demo-price')!
    expect((pain.content as any).text).toContain('痛点一')
    expect((price.content as any).text).toBe('报价锚点')
  })
})
