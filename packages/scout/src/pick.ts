import fs from 'node:fs'
import path from 'node:path'
import type { CoreCtx } from '@forgecast/core'
import { createGithubClient } from './github'

/** 立项：candidate → project + workspace/<slug>/source/{README.md,tree.txt}，状态置 picked */
export async function pickCandidate(ctx: CoreCtx, repo: string): Promise<{ slug: string; projectId: number }> {
  const cand: any = ctx.db.prepare('SELECT * FROM candidates WHERE repo = ?').get(repo)
  if (!cand) throw new Error(`候选不存在: ${repo}（先 scout 或 --add）`)
  if (cand.license_ok !== 1) throw new Error(`该候选协议不可商用，拒绝立项: ${repo}`)
  if (cand.status === 'picked') throw new Error(`该候选已立项，勿重复: ${repo}`)

  const slug = uniqueSlug(ctx, deriveSlug(repo))

  // 先抓取源 README/目录树、先落盘——任何失败都在 DB 变更之前，不留半态
  const gh = createGithubClient(ctx.config.github)
  const [readme, tree] = await Promise.all([gh.fetchReadme(repo), gh.fetchTree(repo)])
  const srcDir = path.join(ctx.config.paths.workspace, slug, 'source')
  fs.mkdirSync(srcDir, { recursive: true })
  fs.writeFileSync(path.join(srcDir, 'README.md'), readme, 'utf8')
  fs.writeFileSync(path.join(srcDir, 'tree.txt'), tree.join('\n'), 'utf8')

  // DB 变更放最后，且原子：建 project + 置 candidate 为 picked
  const projectId = ctx.db.transaction(() => {
    const info = ctx.db.prepare('INSERT INTO projects (slug, candidate_id) VALUES (?, ?)').run(slug, cand.id)
    ctx.db.prepare("UPDATE candidates SET status = 'picked' WHERE id = ?").run(cand.id)
    return Number(info.lastInsertRowid)
  })()

  return { slug, projectId }
}

/** repo 名派生 slug：owner/My-App → my-app（小写、非字母数字段转 -、去首尾 -） */
function deriveSlug(repo: string): string {
  const name = repo.split('/').pop() ?? repo
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'project'
}

/** 撞名加 -2/-3… 后缀直到不冲突 */
function uniqueSlug(ctx: CoreCtx, base: string): string {
  const exists = (s: string) => !!ctx.db.prepare('SELECT 1 FROM projects WHERE slug = ?').get(s)
  if (!exists(base)) return base
  for (let i = 2; ; i++) {
    const s = `${base}-${i}`
    if (!exists(s)) return s
  }
}
