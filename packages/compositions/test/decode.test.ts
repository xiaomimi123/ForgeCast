import { describe, expect, it } from 'vitest'
import { charStateAt, decodeTargets } from '../src/decode'
import type { Layer } from '../src/videospec-types'

const L = (effects: Layer['effects']): Layer => ({
  id: 'x', kind: 'text', from: null, overridden: false, start: 0, duration: 5, track: 1,
  content: { kind: 'text', text: 'a\nb' }, style: {}, effects,
})

describe('decodeTargets', () => {
  it('无 params.line 的 decode → 整层每行都解码', () => {
    const t = decodeTargets(L([{ type: 'decode' }]))
    expect(t.all).toBe(true)
  })
  it('带 params.line → 只有指定行解码', () => {
    const t = decodeTargets(L([{ type: 'decode', params: { line: 1 } }]))
    expect(t.all).toBe(false)
    expect([...t.lines]).toEqual([1])
  })
  it('没有 decode effect → 都不解码', () => {
    const t = decodeTargets(L([{ type: 'fadeIn' }]))
    expect(t.all).toBe(false)
    expect(t.lines.size).toBe(0)
  })
})

/** 收集某参数下完整的 5 个鬼影序列（每个窗口取一个采样点），用于比较整段序列而非单个字符——
 * 单字符比较在 ~80 字符池下约 1/80 概率随机碰撞相同，会让测试偶发失败。 */
function ghostSequence(charIndex: number, charCount: number, elemIndex: number, clipStart: number, t0: number): string[] {
  const seq: string[] = []
  for (let j = 0; j < 5; j++) {
    const st = charStateAt(charIndex, charCount, elemIndex, clipStart, t0 + j * 0.045 + 0.001)
    seq.push(st.kind === 'ghost' ? st.glyph : '')
  }
  return seq
}

describe('charStateAt', () => {
  it('字符起点之前不显示', () => {
    expect(charStateAt(0, 4, 0, 2, 1.9).kind).toBe('hidden')
  })
  it('起点后先走 5 个鬼影，每个 0.045s', () => {
    const a = charStateAt(0, 4, 0, 2, 2.0)
    const b = charStateAt(0, 4, 0, 2, 2.05)
    expect(a.kind).toBe('ghost')
    expect(b.kind).toBe('ghost')
    // 不直接比较单个鬼影字符（~1/80 概率随机碰撞会导致偶发失败），改为取整段 5 鬼影
    // 序列，断言它并非全同一字符——这仍然验证"鬼影会推进变化"，碰撞概率降到 ~80^-4。
    const seq = ghostSequence(0, 4, 0, 2, 2)
    expect(new Set(seq).size).toBeGreaterThan(1)
  })
  it('t0 + 5*0.045 = 0.225s 后锁定为真字', () => {
    expect(charStateAt(0, 4, 0, 2, 2 + 0.225).kind).toBe('final')
    expect(charStateAt(0, 4, 0, 2, 9).kind).toBe('final')
  })
  it('字间步长 = min(0.055, 1.1/字数)：长文本更快', () => {
    // 40 字 → 1.1/40 = 0.0275；第 2 字起点 = 0 + 2*0.0275 = 0.055
    expect(charStateAt(2, 40, 0, 0, 0.054).kind).toBe('hidden')
    expect(charStateAt(2, 40, 0, 0, 0.056).kind).not.toBe('hidden')
  })
  it('确定性：同参数两次调用得到同一鬼影字符', () => {
    const a = charStateAt(3, 10, 2, 0, 0.02 + 3 * 0.055)
    const b = charStateAt(3, 10, 2, 0, 0.02 + 3 * 0.055)
    expect(a).toEqual(b)
  })
  it('elemIndex 不同 → 鬼影序列不同（种子含元素序号）', () => {
    // 比较整段 5 鬼影序列而非单个字符（见 ghostSequence 注释）。
    const seqA = ghostSequence(0, 5, 0, 0, 0)
    const seqB = ghostSequence(0, 5, 1, 0, 0)
    expect(seqA).not.toEqual(seqB)
  })
})
