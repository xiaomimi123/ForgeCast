import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createLlmClient, loadConfig, openDb, type CoreCtx } from '@forgecast/core'
import { beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/app'
import { createTaskQueue } from '../src/tasks'

let ctx: CoreCtx
let app: ReturnType<typeof createApp>
let root: string
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-bgm-'))
  const config = loadConfig(root, {})
  ctx = { db: openDb(config.paths.db), config, llm: createLlmClient(config.llm) }
  app = createApp(ctx, createTaskQueue())
})

describe('GET /api/bgm', () => {
  it('曲库目录不存在 → root/byMood 都为空，不报错', async () => {
    const res = await app.request('/api/bgm')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ root: [], byMood: {} })
  })
  it('有根目录曲子 + 情绪子目录曲子 → 分别列出，非音频文件被过滤', async () => {
    const bgmDir = path.join(root, 'templates/bgm')
    fs.mkdirSync(bgmDir, { recursive: true })
    fs.writeFileSync(path.join(bgmDir, 'a.mp3'), 'fake')
    fs.writeFileSync(path.join(bgmDir, 'README.md'), 'not audio')
    const tenseDir = path.join(bgmDir, 'tense')
    fs.mkdirSync(tenseDir, { recursive: true })
    fs.writeFileSync(path.join(tenseDir, 'b.wav'), 'fake')
    const res = await app.request('/api/bgm')
    const body = await res.json() as any
    expect(body.root).toEqual(['a.mp3'])
    expect(body.byMood).toEqual({ tense: ['b.wav'] })
  })
})
