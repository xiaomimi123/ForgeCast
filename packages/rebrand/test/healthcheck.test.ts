import { describe, expect, it, vi } from 'vitest'
import { waitForPort } from '../src/healthcheck'

describe('waitForPort', () => {
  it('第一次就连上 → true，只调用一次', async () => {
    const fetchImpl = vi.fn(async () => new Response())
    const ok = await waitForPort(3000, { timeoutMs: 5000, fetchImpl: fetchImpl as any })
    expect(ok).toBe(true)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(fetchImpl).toHaveBeenCalledWith('http://127.0.0.1:3000', expect.anything())
  })
  it('一直连不上 → 超时后 false，期间重试了不止一次', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('ECONNREFUSED') })
    const ok = await waitForPort(3000, { timeoutMs: 300, intervalMs: 100, fetchImpl: fetchImpl as any })
    expect(ok).toBe(false)
    expect(fetchImpl.mock.calls.length).toBeGreaterThan(1)
  })
  it('前几次失败、之后连上 → true', async () => {
    let calls = 0
    const fetchImpl = vi.fn(async () => { calls++; if (calls < 3) throw new Error('refused'); return new Response() })
    const ok = await waitForPort(3000, { timeoutMs: 2000, intervalMs: 50, fetchImpl: fetchImpl as any })
    expect(ok).toBe(true)
    expect(calls).toBe(3)
  })
})
