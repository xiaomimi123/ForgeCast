import { describe, expect, it } from 'vitest'
import { analyzeBenchmark, MAX_SEGMENTS, MIN_SEGMENTS } from '../src/benchmark'

describe('analyzeBenchmark', () => {
  it('正常场景：切镜时间点转成连续分段', async () => {
    const p = await analyzeBenchmark('/fake.mp4', {
      probe: async () => 12,
      detect: async () => [3, 6, 9],
    })
    expect(p.durationSec).toBe(12)
    expect(p.segments).toEqual([
      { start: 0, end: 3 }, { start: 3, end: 6 }, { start: 6, end: 9 }, { start: 9, end: 12 },
    ])
  })

  it('检测不到切镜（单镜头到底）→ 回退默认三段均分', async () => {
    const p = await analyzeBenchmark('/fake.mp4', { probe: async () => 9, detect: async () => [] })
    expect(p.segments).toHaveLength(3)
    expect(p.segments[0]).toEqual({ start: 0, end: 3 })
    expect(p.segments[2]).toEqual({ start: 6, end: 9 })
  })

  it('切镜过密（超过 MAX_SEGMENTS）→ 均匀抽样裁剪', async () => {
    const cuts = Array.from({ length: 20 }, (_, i) => i + 1) // 20 个切点，21 段
    const p = await analyzeBenchmark('/fake.mp4', { probe: async () => 21, detect: async () => cuts })
    expect(p.segments).toHaveLength(MAX_SEGMENTS)
    expect(p.segments[0].start).toBe(0)
    expect(p.segments.at(-1)!.end).toBe(21)
  })

  it('探测/ffprobe 失败（probe 返 null）→ fail-soft 回退默认时长三段，不抛错', async () => {
    const p = await analyzeBenchmark('/fake.mp4', { probe: async () => null, detect: async () => [] })
    expect(p.durationSec).toBe(15)
    expect(p.segments).toHaveLength(3)
  })

  it('detect 抛错也不冒泡（deps 假实现模拟 ffmpeg 崩溃）', async () => {
    const p = await analyzeBenchmark('/fake.mp4', {
      probe: async () => 10,
      detect: async () => { throw new Error('ffmpeg crashed') },
    })
    expect(p.segments.length).toBeGreaterThanOrEqual(MIN_SEGMENTS)
  })

  it('probe 抛错也不冒泡（deps 假实现模拟 ffprobe 崩溃）→ fail-soft 回退默认时长三段', async () => {
    const p = await analyzeBenchmark('/fake.mp4', {
      probe: async () => { throw new Error('ffprobe crashed') },
      detect: async () => [],
    })
    expect(p.durationSec).toBe(15)
    expect(p.segments).toHaveLength(3)
  })
})
