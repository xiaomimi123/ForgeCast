import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createLlmClient, loadConfig, openDb, type CoreCtx } from '@forgecast/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { synthesizeVoice } from '../src/tts'

let ctx: CoreCtx
let root: string
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-tts-'))
  const config = loadConfig(root, {}) // tts stub
  ctx = { db: openDb(config.paths.db), config, llm: createLlmClient(config.llm) }
})

describe('synthesizeVoice stub', () => {
  it('切句成字幕、写占位 wav、不发网络', async () => {
    const out = path.join(root, 'workspace/demo/videos/a.wav')
    const fetchSpy = vi.fn()
    const r = await synthesizeVoice(ctx, '第一句话。第二句更长一些的话！第三句', out, fetchSpy as any)
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(r.cues.length).toBe(3)
    expect(r.cues[0].start).toBe(0)
    expect(r.cues[1].start).toBeCloseTo(r.cues[0].end, 5)
    expect(r.cues[0].end).toBeGreaterThan(r.cues[0].start)
    expect(fs.existsSync(out)).toBe(true)
    expect(fs.statSync(out).size).toBeGreaterThan(0)
    expect(r.audioRel).toBe(path.join('demo', 'videos', 'a.wav'))
  })
})
