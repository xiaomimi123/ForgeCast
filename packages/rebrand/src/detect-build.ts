import fs from 'node:fs'
import path from 'node:path'
import { spawnCapture } from './spawn-capture'

const BUILD_TIMEOUT_MS = 300_000

/** 检测项目自带的 build/typecheck/lint 脚本并跑；找不到可跑脚本返回 null（外层调用方视为"跳过验证"）。 */
export async function detectAndRunBuild(
  cwd: string,
  opts: { run?: typeof spawnCapture } = {},
): Promise<{ ok: boolean; output: string } | null> {
  const run = opts.run ?? spawnCapture
  const pkgPath = path.join(cwd, 'package.json')
  if (!fs.existsSync(pkgPath)) return null

  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
  const script = ['build', 'typecheck', 'lint'].find((s) => pkg.scripts?.[s])
  if (!script) return null

  const pm = fs.existsSync(path.join(cwd, 'pnpm-lock.yaml')) ? 'pnpm'
    : fs.existsSync(path.join(cwd, 'yarn.lock')) ? 'yarn'
    : 'npm'

  if (!fs.existsSync(path.join(cwd, 'node_modules'))) {
    await run(pm, ['install'], { cwd, timeoutMs: BUILD_TIMEOUT_MS, label: `${pm} install` })
  }

  const { code, stdout, stderr } = await run(pm, ['run', script], { cwd, timeoutMs: BUILD_TIMEOUT_MS, label: `${pm} run ${script}` })
  return { ok: code === 0, output: (stdout + stderr).slice(0, 4000) }
}
