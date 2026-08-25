import { describe, expect, it } from 'vitest'
import { spawnCapture } from '../src/spawn-capture'

describe('spawnCapture', () => {
  it('退出码 0：resolve 完整 stdout', async () => {
    const r = await spawnCapture('node', ['-e', 'console.log("hello")'], { timeoutMs: 5000, label: 'test' })
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('hello')
  })
  it('非 0 退出码：仍 resolve（不 reject），code/stderr 如实返回', async () => {
    const r = await spawnCapture('node', ['-e', 'console.error("boom"); process.exit(2)'], { timeoutMs: 5000, label: 'test' })
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('boom')
  })
  it('超时：kill 进程并 reject', async () => {
    await expect(
      spawnCapture('node', ['-e', 'setTimeout(() => {}, 10000)'], { timeoutMs: 200, label: 'slow' }),
    ).rejects.toThrow(/slow.*超时/)
  })
  it('命令不存在：reject', async () => {
    await expect(
      spawnCapture('__forgecast_no_such_cmd__', [], { timeoutMs: 2000, label: 'missing' }),
    ).rejects.toThrow()
  })
})
