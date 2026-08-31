import type { Layer } from './videospec-types'

/** 原样迁自 hyperframes.ts DECODE_RUNTIME，改动会改变观感。 */
const POOL = '日月火水木金土山川云电系统数据端口零一二三ABCDEF0123456789#@%&*<>/|=+アイウエオカキクケコサシスセソ'
const K = 5
const GSTEP = 0.045

function mulberry32(a: number): () => number {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export type CharState = { kind: 'hidden' } | { kind: 'ghost'; glyph: string } | { kind: 'final' }

/** 第 charIndex 个字在 timeSec 时刻的状态。elemIndex 必须与原脚本的 `.tw` 文档顺序序号一致。 */
export function charStateAt(
  charIndex: number, charCount: number, elemIndex: number, clipStart: number, timeSec: number,
): CharState {
  const step = Math.min(0.055, 1.1 / Math.max(1, charCount))
  const t0 = clipStart + charIndex * step
  if (timeSec < t0) return { kind: 'hidden' }
  const rel = timeSec - t0
  if (rel >= K * GSTEP) return { kind: 'final' }
  const j = Math.floor(rel / GSTEP)
  const rnd = mulberry32(((elemIndex + 1) * 73856093) ^ ((charIndex + 1) * 19349663))
  let glyph = POOL[0]
  for (let n = 0; n <= j; n++) glyph = POOL[(rnd() * POOL.length) | 0]
  return { kind: 'ghost', glyph }
}

/** 哪些行要解码（迁自 render-html.ts renderTextContent 的落位规则）。 */
export function decodeTargets(layer: Layer): { all: boolean; lines: Set<number> } {
  const ds = layer.effects.filter((e) => e.type === 'decode')
  return {
    all: ds.some((e) => e.params?.line === undefined),
    lines: new Set(ds.map((e) => e.params?.line).filter((l): l is number => typeof l === 'number')),
  }
}
