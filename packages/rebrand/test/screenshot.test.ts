import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { captureScreenshot } from '../src/screenshot'

describe('captureScreenshot（真实 Playwright）', () => {
  it('对本地 HTTP 服务截图，产出非空 PNG 文件', async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<h1>hi</h1>')
    })
    await new Promise<void>((resolve) => server.listen(0, resolve))
    const port = (server.address() as { port: number }).port
    const outPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fc-shot-')), 'shot.png')
    try {
      const ok = await captureScreenshot(port, outPath)
      expect(ok).toBe(true)
      expect(fs.existsSync(outPath)).toBe(true)
      expect(fs.statSync(outPath).size).toBeGreaterThan(0)
    } finally {
      server.close()
    }
  }, 20000)

  it('端口没有服务监听 → 返回 false，不抛错', async () => {
    const outPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fc-shot-')), 'shot.png')
    const ok = await captureScreenshot(59999, outPath)
    expect(ok).toBe(false)
  }, 20000)
})
