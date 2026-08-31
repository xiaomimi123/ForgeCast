import type { Effect } from './videospec-types'

export interface FrameStyle { opacity: number; y: number; scale: number }

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
  const out: FrameStyle = { opacity: 1, y: 0, scale: 1 }
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
        else out.y += (typeof e.params?.y === 'number' ? e.params.y : 20) * (1 - p)
        break
      }
      case 'slideUp':
        out.opacity *= p
        out.y += 40 * (1 - p)
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
