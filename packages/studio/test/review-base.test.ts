import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { extractAudioWav, probeDuration, transcribeAudio } from '../src/review'

describe('transcribeAudio（fail-soft）', () => {
  it('asrPython 为空 → null 不 spawn', async () => {
    expect(await transcribeAudio('/tmp/x.wav', '')).toBeNull()
  })
  it('脚本输出合法 → 解析返回 text+segments', async () => {
    const r = await transcribeAudio('/tmp/x.wav', '/fake/python', {
      runTranscribe: async (args) => {
        fs.writeFileSync(args[2], JSON.stringify({ ok: true, text: '你好世界', segments: [{ start: 0, end: 1.2, text: '你好世界' }] }))
      },
    })
    expect(r).toEqual({ text: '你好世界', segments: [{ start: 0, end: 1.2, text: '你好世界' }] })
  })
  it('脚本报 ok:false / 进程崩溃 → null', async () => {
    const r1 = await transcribeAudio('/tmp/x.wav', '/fake/python', {
      runTranscribe: async (args) => { fs.writeFileSync(args[2], JSON.stringify({ ok: false, reason: '静音' })) },
    })
    expect(r1).toBeNull()
    const r2 = await transcribeAudio('/tmp/x.wav', '/fake/python', {
      runTranscribe: async () => { throw new Error('boom') },
    })
    expect(r2).toBeNull()
  })
})

describe('extractAudioWav', () => {
  it('组装 ffmpeg 参数：-vn -ar 16000 -ac 1', async () => {
    let seen: string[] = []
    await extractAudioWav('/a/in.mp4', '/a/out.wav', { runFfmpeg: async (args) => { seen = args } })
    expect(seen).toEqual(['-y', '-i', '/a/in.mp4', '-vn', '-ar', '16000', '-ac', '1', '/a/out.wav'])
  })
})

describe('probeDuration（fail-soft）', () => {
  it('文件不存在 → null 不抛', async () => {
    expect(await probeDuration(path.join(os.tmpdir(), 'fc-nope-does-not-exist.mp4'))).toBeNull()
  })
})
