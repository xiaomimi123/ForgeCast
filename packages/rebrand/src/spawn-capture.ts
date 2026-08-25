import { spawn } from 'node:child_process'

/** 带超时的 spawn，完整捕获 stdout/stderr，非 0 退出码不 reject（调用方自己判断 code）。 */
export function spawnCapture(
  cmd: string,
  args: string[],
  opts: { cwd?: string; timeoutMs: number; label: string },
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      settled = true
      p.kill('SIGKILL')
      reject(new Error(`${opts.label} 超时（${opts.timeoutMs}ms）已终止`))
    }, opts.timeoutMs)
    p.stdout.on('data', (d) => { stdout += d.toString() })
    p.stderr.on('data', (d) => { stderr += d.toString() })
    p.on('error', (e) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(e)
    })
    p.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code: code ?? -1, stdout, stderr })
    })
  })
}
