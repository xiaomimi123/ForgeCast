import fs from 'node:fs'
import type { CoreCtx } from './ctx'

/** workspace/ 下每个目录即一个项目：启动时 upsert（P1 约定，替代手动 pick 流程）。core 提供，server 与 CLI 共用。 */
export function syncWorkspaceProjects(ctx: CoreCtx): void {
  if (!fs.existsSync(ctx.config.paths.workspace)) return
  const dirs = fs.readdirSync(ctx.config.paths.workspace, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('_'))
  const ins = ctx.db.prepare('INSERT INTO projects (slug) VALUES (?) ON CONFLICT(slug) DO NOTHING')
  for (const d of dirs) ins.run(d.name)
}
