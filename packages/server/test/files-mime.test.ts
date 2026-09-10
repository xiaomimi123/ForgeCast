import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createLlmClient, loadConfig, openDb, type CoreCtx } from '@forgecast/core'
import { beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/app'
import { createTaskQueue } from '../src/tasks'

let ctx: CoreCtx
let app: ReturnType<typeof createApp>
beforeEach(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-files-'))
  const config = loadConfig(root, {})
  ctx = { db: openDb(config.paths.db), config, llm: createLlmClient(config.llm) }
  app = createApp(ctx, createTaskQueue())
})

describe('GET /files/* 的 content-type', () => {
  it('html/js/otf/wav 各返回正确 MIME，而非 octet-stream', async () => {
    const dir = path.join(ctx.config.paths.workspace, 'p1', 'hf')
    fs.mkdirSync(path.join(dir, 'assets', 'fonts'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><html></html>')
    fs.writeFileSync(path.join(dir, 'gsap.min.js'), '/*js*/')
    fs.writeFileSync(path.join(dir, 'assets', 'fonts', 'F.otf'), Buffer.from([0, 1]))
    fs.writeFileSync(path.join(dir, 'assets', 'n.wav'), Buffer.from([0, 1]))

    const ct = async (p: string) => (await app.request(`/files/${p}`)).headers.get('content-type')
    expect(await ct('p1/hf/index.html')).toMatch(/^text\/html/)
    expect(await ct('p1/hf/gsap.min.js')).toMatch(/javascript/)
    expect(await ct('p1/hf/assets/fonts/F.otf')).toMatch(/font/)
    expect(await ct('p1/hf/assets/n.wav')).toMatch(/audio/)
  })

  it('svg 返回 image/svg+xml 并带 CSP sandbox（可执行文档，禁脚本）', async () => {
    const dir = path.join(ctx.config.paths.workspace, 'p1', 'uploads')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'x.svg'), '<svg xmlns="http://www.w3.org/2000/svg"></svg>')
    const res = await app.request('/files/p1/uploads/x.svg')
    expect(res.headers.get('content-type')).toBe('image/svg+xml')
    expect(res.headers.get('content-security-policy')).toBe('sandbox')
  })

  it('非 svg 不加 CSP 头（不误伤 hf 产物页的脚本）', async () => {
    const dir = path.join(ctx.config.paths.workspace, 'p1', 'uploads')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'a.png'), Buffer.from([0, 1]))
    const res = await app.request('/files/p1/uploads/a.png')
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(res.headers.get('content-security-policy')).toBeNull()
  })

  it('路径穿越仍被拒（回归：不得因加 MIME 放宽边界校验）', async () => {
    const res = await app.request('/files/../package.json')
    expect(res.status).toBe(404)
  })
})
