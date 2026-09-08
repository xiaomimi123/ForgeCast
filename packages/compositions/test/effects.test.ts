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

/**
 * 特效库 Task 2：styleAt 参数化 + zoomIn/slideIn/blurIn。
 * 需求书：.superpowers/sdd/2026-09-08-effects-library/task-2-brief.md
 * 红线：既有六效果「不带参数」的输出与参数化前逐字相等，故下面把缺省值显式写死当锁。
 */
describe('styleAt 参数化：缺省值锁', () => {
  it('slideUp 不带参数仍是 40*(1-p)——中点 p=0.75 → y=10', () => {
    const fx: Effect[] = [{ type: 'slideUp', at: 0, duration: 0.4 }]
    near(styleAt(fx, 0, 5, 0, null).y, 40)
    near(styleAt(fx, 0, 5, 0.2, null).y, 10)      // 40*(1-0.75)
    near(styleAt(fx, 0, 5, 0.4, null).y, 0)
  })

  it('slideUp 读 params.distance，缺省 40', () => {
    const fx: Effect[] = [{ type: 'slideUp', at: 0, duration: 0.4, params: { distance: 100 } }]
    near(styleAt(fx, 0, 5, 0, null).y, 100)
    near(styleAt(fx, 0, 5, 0.4, null).y, 0)
  })

  it('params 值是字符串时退回缺省（num() 只认 number）', () => {
    const fx: Effect[] = [{ type: 'slideUp', at: 0, duration: 0.4, params: { distance: '100' } }]
    near(styleAt(fx, 0, 5, 0, null).y, 40)        // 不是 100，也不是 NaN
  })

  it('fadeIn 读 params.y，缺省 20', () => {
    const fx: Effect[] = [{ type: 'fadeIn', at: 0, duration: 0.4, params: { y: 60 } }]
    near(styleAt(fx, 0, 5, 0, null).y, 60)
  })
})

describe('zoomIn', () => {
  it('起点 scale=0.8（缺省）、终点 1，opacity 同步', () => {
    const fx: Effect[] = [{ type: 'zoomIn', at: 0, duration: 0.4 }]
    const a = styleAt(fx, 0, 5, 0, null)
    near(a.scale, 0.8); near(a.opacity, 0)
    const m = styleAt(fx, 0, 5, 0.2, null)       // p=0.75
    near(m.scale, 0.8 + 0.2 * 0.75); near(m.opacity, 0.75)
    const b = styleAt(fx, 0, 5, 0.4, null)
    near(b.scale, 1); near(b.opacity, 1); near(b.y, 0)
  })

  it('params.scale 覆盖起点', () => {
    const fx: Effect[] = [{ type: 'zoomIn', at: 0, duration: 0.4, params: { scale: 1.4 } }]
    near(styleAt(fx, 0, 5, 0, null).scale, 1.4)
    near(styleAt(fx, 0, 5, 0.4, null).scale, 1)
  })
})

describe('slideIn 四向符号', () => {
  const at = (direction: string, t: number) =>
    styleAt([{ type: 'slideIn', at: 0, duration: 0.4, params: { direction } }], 0, 5, t, null)

  it('up：从下方进场，y 为正', () => { const s = at('up', 0); near(s.y, 40); near(s.x ?? 0, 0) })
  it('down：从上方进场，y 为负', () => { const s = at('down', 0); near(s.y, -40); near(s.x ?? 0, 0) })
  it('left：从右侧进场，x 为正', () => { const s = at('left', 0); near(s.x ?? 0, 40); near(s.y, 0) })
  it('right：从左侧进场，x 为负', () => { const s = at('right', 0); near(s.x ?? 0, -40); near(s.y, 0) })

  it('缺省 direction 同 up、缺省 distance 40，p=1 时四向全归零', () => {
    near(styleAt([{ type: 'slideIn', at: 0, duration: 0.4 }], 0, 5, 0, null).y, 40)
    for (const d of ['up', 'down', 'left', 'right']) {
      const e = at(d, 0.4)
      near(e.y, 0); near(e.x ?? 0, 0); near(e.opacity, 1); near(e.scale, 1)
    }
  })

  it('params.distance 生效', () => {
    const s = styleAt([{ type: 'slideIn', at: 0, duration: 0.4, params: { direction: 'left', distance: 200 } }], 0, 5, 0, null)
    near(s.x ?? 0, 200)
  })
})

describe('blurIn', () => {
  it('起点 12px（缺省）、终点 0，opacity 同步', () => {
    const fx: Effect[] = [{ type: 'blurIn', at: 0, duration: 0.4 }]
    near(styleAt(fx, 0, 5, 0, null).blur ?? 0, 12)
    near(styleAt(fx, 0, 5, 0.2, null).blur ?? 0, 12 * 0.25)
    const b = styleAt(fx, 0, 5, 0.4, null)
    near(b.blur ?? 0, 0); near(b.opacity, 1)
  })

  it('params.blur 覆盖，且多条 blurIn 相加合成', () => {
    near(styleAt([{ type: 'blurIn', at: 0, duration: 0.4, params: { blur: 30 } }], 0, 5, 0, null).blur ?? 0, 30)
    const two: Effect[] = [
      { type: 'blurIn', at: 0, duration: 0.4, params: { blur: 5 } },
      { type: 'blurIn', at: 0, duration: 0.4, params: { blur: 7 } },
    ]
    near(styleAt(two, 0, 5, 0, null).blur ?? 0, 12)
  })
})

describe('新通道不干扰既有语义', () => {
  it('既有六效果不产出 x/blur（undefined 或 0）', () => {
    for (const type of ['fadeIn', 'slideUp', 'pulse', 'demote', 'exit', 'decode'] as const) {
      const s = styleAt([{ type, at: 0, duration: 0.4 }], 0, 5, 0.2, null)
      expect(s.x ?? 0).toBe(0)
      expect(s.blur ?? 0).toBe(0)
    }
  })

  it('exit 硬收尾把 opacity 归零，同层的 blurIn/slideIn 不改变这条', () => {
    const fx: Effect[] = [
      { type: 'blurIn', at: 0, duration: 0.4 },
      { type: 'slideIn', at: 0, duration: 0.4, params: { direction: 'left' } },
      { type: 'exit', duration: 0.5 },
    ]
    near(styleAt(fx, 2, 6, 8, null).opacity, 0)
    near(styleAt(fx, 2, 6, 9, null).opacity, 0)
  })
})
