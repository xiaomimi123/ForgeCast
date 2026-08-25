import fs from 'node:fs'
import path from 'node:path'

/** 换皮执行 agent 的最终结构化结果（真实实现来自 claude --json-schema 输出，mock 版本手写固定值）。 */
export interface AgentResult { status: 'done' | 'blocked'; summary: string; changedFiles: string[] }

/** mock clone：不发真实网络请求，落一个占位 package.json + README.md 模拟"已 clone"。 */
export async function mockClone(_url: string, dir: string): Promise<void> {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'original-project', scripts: { build: 'echo ok' } }, null, 2),
    'utf8',
  )
  fs.writeFileSync(path.join(dir, 'README.md'), '# original-project\n', 'utf8')
}

/** mock agent：不调真实 claude，直接把 package.json.name 改成 rebranded 模拟品牌替换。 */
export async function mockRunAgent(_prompt: string, cwd: string): Promise<AgentResult> {
  const pkgPath = path.join(cwd, 'package.json')
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
  pkg.name = 'rebranded'
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2), 'utf8')
  return { status: 'done', summary: '已完成品牌替换/删除项/中文化（mock）', changedFiles: ['package.json'] }
}

/** mock build：固定通过，不真的跑 npm/pnpm。 */
export async function mockRunBuild(_cwd: string): Promise<{ ok: boolean; output: string }> {
  return { ok: true, output: 'mock build ok' }
}
