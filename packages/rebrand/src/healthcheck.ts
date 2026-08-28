/** 探测 http://127.0.0.1:<port>，成功=拿到任意 HTTP 响应（不要求 200——很多脚手架首页会 30x/404，
 *  能连上说明服务确实起来了）。轮询直到超时，给服务一点启动缓冲时间。 */
export async function waitForPort(
  port: number,
  opts: { timeoutMs: number; intervalMs?: number; fetchImpl?: typeof fetch },
): Promise<boolean> {
  const interval = opts.intervalMs ?? 1000
  const fetchFn = opts.fetchImpl ?? fetch
  const deadline = Date.now() + opts.timeoutMs
  while (Date.now() < deadline) {
    try {
      await fetchFn(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(2000) })
      return true
    } catch {
      // 连不上，继续轮询
    }
    await new Promise((r) => setTimeout(r, interval))
  }
  return false
}
