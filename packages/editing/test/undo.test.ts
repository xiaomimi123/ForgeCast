import { describe, expect, it } from 'vitest'
import type { VideoSpec } from '@forgecast/studio'
import { init, push, redo, undo } from '../src/undo'
import { baseSpec, snapshot } from './fixtures'

const v = (n: number): VideoSpec => baseSpec({ videoId: `v${n}` })

describe('undo/redo 历史栈', () => {
  it('init 空 past/future', () => {
    const s = v(0)
    const h = init(s)
    expect(h).toEqual({ past: [], present: s, future: [] })
  })

  it('init→push×3→undo×2→redo→push：push 清空 future', () => {
    let h = init(v(0))
    h = push(h, v(1))
    h = push(h, v(2))
    h = push(h, v(3))
    expect(h.present.videoId).toBe('v3')
    expect(h.past.map((s) => s.videoId)).toEqual(['v0', 'v1', 'v2'])

    h = undo(h)
    h = undo(h)
    expect(h.present.videoId).toBe('v1')
    expect(h.future.map((s) => s.videoId)).toEqual(['v2', 'v3'])

    h = redo(h)
    expect(h.present.videoId).toBe('v2')
    expect(h.future.map((s) => s.videoId)).toEqual(['v3'])

    h = push(h, v(9))
    expect(h.present.videoId).toBe('v9')
    expect(h.future).toEqual([])
    expect(h.past.map((s) => s.videoId)).toEqual(['v0', 'v1', 'v2'])
  })

  it('push 超 cap 丢最旧', () => {
    let h = init(v(0))
    for (let i = 1; i <= 5; i++) h = push(h, v(i), 3)
    expect(h.past).toHaveLength(3)
    expect(h.past.map((s) => s.videoId)).toEqual(['v2', 'v3', 'v4'])
    expect(h.present.videoId).toBe('v5')
  })

  it('cap 默认 50', () => {
    let h = init(v(0))
    for (let i = 1; i <= 60; i++) h = push(h, v(i))
    expect(h.past).toHaveLength(50)
    expect(h.past[0].videoId).toBe('v10')
  })

  it('past 空时 undo 原样返回（不 throw）', () => {
    const h = init(v(0))
    expect(undo(h)).toBe(h)
  })

  it('future 空时 redo 原样返回', () => {
    const h = init(v(0))
    expect(redo(h)).toBe(h)
  })

  it('不可变：push/undo/redo 不改入参 history', () => {
    const h0 = init(v(0))
    const before = snapshot(h0)
    const h1 = push(h0, v(1))
    expect(h1).not.toBe(h0)
    expect(h0).toEqual(before)
    const h2 = undo(h1)
    expect(h1.past).toHaveLength(1)
    expect(h2.present.videoId).toBe('v0')
  })
})
