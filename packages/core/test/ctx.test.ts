import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { createCtx } from '../src/ctx'

describe('createCtx .env 加载', () => {
  const original = process.env.FORGECAST_BEAT_PYTHON

  beforeEach(() => {
    delete process.env.FORGECAST_BEAT_PYTHON
  })

  afterAll(() => {
    if (original === undefined) delete process.env.FORGECAST_BEAT_PYTHON
    else process.env.FORGECAST_BEAT_PYTHON = original
  })

  it('不传 env 时自动读根目录 .env（真实环境变量已存在时不覆盖）', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-ctx-'))
    fs.writeFileSync(path.join(root, '.env'), 'FORGECAST_BEAT_PYTHON=/from/dotenv\n')
    const ctx = createCtx(root)
    expect(ctx.config.video.beatPython).toBe('/from/dotenv')
  })

  it('已存在的真实环境变量优先于 .env 文件', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-ctx-'))
    fs.writeFileSync(path.join(root, '.env'), 'FORGECAST_BEAT_PYTHON=/from/dotenv\n')
    process.env.FORGECAST_BEAT_PYTHON = '/from/shell'
    const ctx = createCtx(root)
    expect(ctx.config.video.beatPython).toBe('/from/shell')
  })

  it('显式传 env 时不读 .env 文件', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-ctx-'))
    fs.writeFileSync(path.join(root, '.env'), 'FORGECAST_BEAT_PYTHON=/from/dotenv\n')
    const ctx = createCtx(root, {})
    expect(ctx.config.video.beatPython).toBe('')
  })

  it('.env 不存在时不报错', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-ctx-'))
    expect(() => createCtx(root)).not.toThrow()
  })
})
