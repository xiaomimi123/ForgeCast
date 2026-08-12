import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { alignCues } from '../src/asr'

describe('alignCues', () => {
  it('asrPython 为空串时直接返回 null，不 spawn', async () => {
    const run = vi.fn()
    const r = await alignCues('/fake.wav', ['第一句', '第二句'], '', { run })
    expect(run).not.toHaveBeenCalled()
    expect(r).toBeNull()
  })

  it('sentences 为空数组时直接返回 null，不 spawn', async () => {
    const run = vi.fn()
    const r = await alignCues('/fake.wav', [], '/fake/py', { run })
    expect(run).not.toHaveBeenCalled()
    expect(r).toBeNull()
  })

  it('脚本成功、句子数匹配 → 返回对齐结果', async () => {
    const run = vi.fn(async (args: string[]) => {
      const outPath = args[3]
      fs.writeFileSync(outPath, JSON.stringify({ ok: true, cues: [{ start: 0, end: 1.2 }, { start: 1.2, end: 2.5 }] }))
    })
    const r = await alignCues('/fake.wav', ['第一句', '第二句'], '/fake/py', { run })
    expect(run).toHaveBeenCalledOnce()
    expect(r).toEqual([{ start: 0, end: 1.2 }, { start: 1.2, end: 2.5 }])
  })

  it('脚本返回 ok:false → 返回 null', async () => {
    const run = vi.fn(async (args: string[]) => {
      fs.writeFileSync(args[3], JSON.stringify({ ok: false, reason: '字符匹配率过低' }))
    })
    const r = await alignCues('/fake.wav', ['第一句'], '/fake/py', { run })
    expect(r).toBeNull()
  })

  it('脚本返回的 cues 数量与句子数不符 → 返回 null（不信任部分对齐结果）', async () => {
    const run = vi.fn(async (args: string[]) => {
      fs.writeFileSync(args[3], JSON.stringify({ ok: true, cues: [{ start: 0, end: 1 }] }))
    })
    const r = await alignCues('/fake.wav', ['第一句', '第二句'], '/fake/py', { run })
    expect(r).toBeNull()
  })

  it('spawn 抛错（超时/崩溃）→ 返回 null，不向上抛异常', async () => {
    const run = vi.fn(async () => { throw new Error('asr_align 超时（180000ms）已终止') })
    const r = await alignCues('/fake.wav', ['第一句'], '/fake/py', { run })
    expect(r).toBeNull()
  })

  it('out.json 内容不是合法 JSON → 返回 null', async () => {
    const run = vi.fn(async (args: string[]) => { fs.writeFileSync(args[3], 'not json') })
    const r = await alignCues('/fake.wav', ['第一句'], '/fake/py', { run })
    expect(r).toBeNull()
  })

  it('把 sentences 写进临时 JSON 文件传给脚本', async () => {
    let sentencesFileContent = ''
    const run = vi.fn(async (args: string[]) => {
      sentencesFileContent = fs.readFileSync(args[2], 'utf8')
      fs.writeFileSync(args[3], JSON.stringify({ ok: true, cues: [{ start: 0, end: 1 }] }))
    })
    await alignCues('/fake.wav', ['第一句'], '/fake/py', { run })
    expect(JSON.parse(sentencesFileContent)).toEqual(['第一句'])
  })
})
