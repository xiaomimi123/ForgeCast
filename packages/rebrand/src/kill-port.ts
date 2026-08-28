import { spawnCapture } from './spawn-capture'

/** 按端口强杀占用进程（macOS/Linux：lsof -ti:<port> | xargs kill -9）。找不到占用进程视为已经退出，不算失败。 */
export async function killByPort(port: number): Promise<void> {
  const { code, stdout } = await spawnCapture('lsof', ['-ti', `:${port}`], { timeoutMs: 5000, label: 'lsof' })
  if (code !== 0 || !stdout.trim()) return
  const pids = stdout.trim().split('\n')
  await spawnCapture('kill', ['-9', ...pids], { timeoutMs: 5000, label: 'kill' })
}
