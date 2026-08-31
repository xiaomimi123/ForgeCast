import { describe, expect, it } from 'vitest'
import { styleAt } from '../src/effects'
import type { Effect } from '../src/videospec-types'

const near = (a: number, b: number) => expect(Math.abs(a - b)).toBeLessThan(1e-6)

describe('styleAt', () => {
  it('fadeIn：起点全透明、终点不透明且位移归零', () => {
    const fx: Effect[] = [{ type: 'fadeIn', at: 0, duration: 0.4 }]
    const a = styleAt(fx, 2, 5, 2, null)
    near(a.opacity, 0); near(a.y, 20)
    const b = styleAt(fx, 2, 5, 2.4, null)
    near(b.opacity, 1); near(b.y, 0)
  })

  it('fadeIn 用 power1.out 缓动，不是线性', () => {
    const fx: Effect[] = [{ type: 'fadeIn', at: 0, duration: 0.4 }]
    // 半程线性会是 0.5；power1.out 是 1-(1-.5)^2 = 0.75
    near(styleAt(fx, 0, 5, 0.2, null).opacity, 0.75)
  })

  it('fadeIn 带 params.scale 走缩放而非位移', () => {
    const fx: Effect[] = [{ type: 'fadeIn', at: 0, duration: 0.4, params: { scale: 0.9 } }]
    const a = styleAt(fx, 0, 5, 0, null)
    near(a.scale, 0.9); near(a.y, 0)
    near(styleAt(fx, 0, 5, 0.4, null).scale, 1)
  })

  it('demote 动完保持终值（0.55 / 0.78），不回弹', () => {
    const fx: Effect[] = [{ type: 'demote', at: 1, duration: 0.5 }]
    const end = styleAt(fx, 0, 10, 1.5, null)
    near(end.opacity, 0.55); near(end.scale, 0.78)
    const later = styleAt(fx, 0, 10, 8, null)
    near(later.opacity, 0.55); near(later.scale, 0.78)
  })

  it('exit 在 clip 结束时刻硬收尾为全透明', () => {
    const fx: Effect[] = [{ type: 'exit', duration: 0.5 }]
    // layerStart=2 duration=6 → clipEnd=8，exitAt=7.5
    near(styleAt(fx, 2, 6, 7.4, null).opacity, 1)
    near(styleAt(fx, 2, 6, 8, null).opacity, 0)
    near(styleAt(fx, 2, 6, 9, null).opacity, 0)
  })

  it('pulse：0.08s 到 1.06，再 0.12s 回 1.0，之后保持 1', () => {
    const fx: Effect[] = [{ type: 'pulse', at: 0 }]
    near(styleAt(fx, 0, 5, 0.08, null).scale, 1.06)
    near(styleAt(fx, 0, 5, 0.2, null).scale, 1)
    near(styleAt(fx, 0, 5, 3, null).scale, 1)
  })

  it('params.line 决定 effect 打在哪一行；不匹配的行拿到中性值', () => {
    const fx: Effect[] = [{ type: 'slideUp', at: 0, duration: 0.5, params: { line: 1 } }]
    near(styleAt(fx, 0, 5, 0, 1).opacity, 0)      // 第 1 行受影响
    near(styleAt(fx, 0, 5, 0, 0).opacity, 1)      // 第 0 行不受影响
    near(styleAt(fx, 0, 5, 0, null).opacity, 1)   // clip 本身不受影响
  })

  it('decode 不影响样式（它落成 .tw 类由 Text 处理）', () => {
    const s = styleAt([{ type: 'decode' }], 0, 5, 1, null)
    near(s.opacity, 1); near(s.scale, 1); near(s.y, 0)
  })
})
