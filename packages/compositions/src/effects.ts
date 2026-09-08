import type { Effect } from './videospec-types'

/** x/blur 是 Task 2 新增的通道（slideIn 横向位移、blurIn 模糊），缺省不产出——
 *  消费方（LayerView）对 undefined/0 一律不写内联，见该文件「恒等 transform」教训。 */
export interface FrameStyle { opacity: number; y: number; scale: number; x?: number; blur?: number }

/** params 是 Record<string, number | string>，非数值一律退回缺省。 */
const num = (v: number | string | undefined, dflt: number) => (typeof v === 'number' ? v : dflt)
const clamp01 = (v: number) => Math.min(1, Math.max(0, v))
/** GSAP 默认缓动是 power1.out；线性会让运动手感明显不同，故必须保留。 */
const easeOutQuad = (p: number) => 1 - (1 - p) * (1 - p)

/**
 * 求 `timeSec` 时刻某个目标（clip 本身 line=null，或第 N 行）的叠加样式。
 * 数值逐个迁自 render-html.ts effectToAccentLine 编译出的 GSAP 行，不得改动。
 * 只读 layerStart/layerDuration，不计算它们（全局约束：时间只存在于 spec.layers）。
 */
export function styleAt(
  effects: Effect[], layerStart: number, layerDuration: number, timeSec: number, line: number | null,
): FrameStyle {
  const out: FrameStyle = { opacity: 1, y: 0, scale: 1, x: 0, blur: 0 }
  for (const e of effects) {
    if ((e.params?.line ?? null) !== line) continue
    const t0 = layerStart + (e.at ?? 0)
    const d = e.duration ?? 0.3
    const p = easeOutQuad(clamp01(d > 0 ? (timeSec - t0) / d : 1))
    switch (e.type) {
      case 'fadeIn': {
        const s = e.params?.scale
        out.opacity *= p
        if (typeof s === 'number') out.scale *= s + (1 - s) * p
        else out.y += num(e.params?.y, 20) * (1 - p)
        break
      }
      case 'slideUp':
        out.opacity *= p
        out.y += num(e.params?.distance, 40) * (1 - p)
        break
      case 'zoomIn': {
        const s0 = num(e.params?.scale, 0.8)
        out.opacity *= p
        out.scale *= s0 + (1 - s0) * p
        break
      }
      case 'slideIn': {
        const dist = num(e.params?.distance, 40) * (1 - p)
        const dir = typeof e.params?.direction === 'string' ? e.params.direction : 'up'
        out.opacity *= p
        // 符号约定：direction 指「往哪个方向进场」，起点在其反侧。
        if (dir === 'down') out.y -= dist
        else if (dir === 'left') out.x = (out.x ?? 0) + dist
        else if (dir === 'right') out.x = (out.x ?? 0) - dist
        else out.y += dist
        break
      }
      case 'blurIn':
        out.opacity *= p
        out.blur = (out.blur ?? 0) + num(e.params?.blur, 12) * (1 - p)
        break
      case 'demote':
        out.opacity *= 1 - 0.45 * p
        out.scale *= 1 - 0.22 * p
        break
      case 'pulse': {
        const rel = timeSec - t0
        if (rel >= 0 && rel < 0.08) out.scale *= 1 + 0.06 * easeOutQuad(rel / 0.08)
        else if (rel >= 0.08 && rel < 0.2) out.scale *= 1.06 - 0.06 * easeOutQuad((rel - 0.08) / 0.12)
        break
      }
      case 'exit': {
        const clipEnd = layerStart + layerDuration
        if (timeSec >= clipEnd) { out.opacity = 0; break }   // tl.set 硬收尾
        const q = easeOutQuad(clamp01(d > 0 ? (timeSec - (clipEnd - d)) / d : 0))
        out.opacity *= 1 - q
        out.scale *= 1 - 0.15 * q
        break
      }
      case 'decode':
        break   // 落成 .tw 类，见 Text.tsx
    }
  }
  return out
}
