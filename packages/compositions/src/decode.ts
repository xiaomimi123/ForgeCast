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

/**
 * 逐字解码的字间步长（秒）：字越多步子越小，整行铺完不超过 1.1s。
 * **单一出处**——Text.tsx（空格字符的出现时刻）与内容断言门禁都从这里取，不各自抄一份常量：
 * 抄三份的话，将来正当地调解码节奏就得三处同步改，漏一处 = 门禁假红（自伤）。
 */
export function stepFor(charCount: number): number {
  return Math.min(0.055, 1.1 / Math.max(1, charCount))
}

/**
 * 一行 charCount 个字**全部锁定为最终字形**所需的时长（相对该图层 start 的秒数）。
 * = 最后一个字的 t0（(n-1)·step）+ 鬼影阶段时长（K·GSTEP）。
 *
 * 内容断言门禁靠它挑比对时刻：解码中的字符会同时渲出真字（.fin）与鬼影字（.gh），
 * 两者在 textContent 里交错，早于这个时刻做字面比对就会被鬼影污染成假红。
 */
export function lockTimeFor(charCount: number): number {
  return (Math.max(1, charCount) - 1) * stepFor(charCount) + K * GSTEP
}

/** 第 charIndex 个字在 timeSec 时刻的状态。elemIndex 必须与原脚本的 `.tw` 文档顺序序号一致。 */
export function charStateAt(
  charIndex: number, charCount: number, elemIndex: number, clipStart: number, timeSec: number,
): CharState {
  const step = stepFor(charCount)
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
