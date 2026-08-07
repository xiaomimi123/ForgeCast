import type { CoreCtx } from '@forgecast/core'
import { createGithubClient, isLicenseOk, type GithubClient } from '@forgecast/scout'
import { parseKeywordsCol } from './requests'
import { wheelScore } from './score'

export interface SearchResult { ok: number; failed: Array<{ capabilityId: number; name: string; error: string }> }

/** 逐能力搜轮子并评分入库：单项失败不阻塞其他（failed 记原因，可单独重搜）；有成功项则 status → searched */
export async function searchWheels(ctx: CoreCtx, requestId: number, opts: { capabilityId?: number; onProgress?: (m: string) => void; gh?: GithubClient } = {}): Promise<SearchResult> {
  const log = opts.onProgress ?? (() => {})
  if (!ctx.db.prepare('SELECT id FROM tailor_requests WHERE id = ?').get(requestId)) throw new Error(`定制需求不存在: ${requestId}`)
  const caps = (opts.capabilityId
    ? ctx.db.prepare('SELECT * FROM tailor_capabilities WHERE id = ? AND request_id = ?').all(opts.capabilityId, requestId)
    : ctx.db.prepare('SELECT * FROM tailor_capabilities WHERE request_id = ? ORDER BY sort, id').all(requestId)
  ) as Array<{ id: number; name: string; keywords: string | null }>
  if (!caps.length) throw new Error('该需求还没有能力清单，先拆解需求')

  const gh = opts.gh ?? createGithubClient(ctx.config.github)
  const result: SearchResult = { ok: 0, failed: [] }
  for (const cap of caps) {
    const keywords = parseKeywordsCol(cap.keywords)
    try {
      const repos = await gh.searchByKeywords(keywords, { perPage: 8 })
      ctx.db.transaction(() => {
        ctx.db.prepare('DELETE FROM tailor_wheels WHERE capability_id = ?').run(cap.id)
        const ins = ctx.db.prepare('INSERT INTO tailor_wheels (capability_id, repo, url, license, license_ok, stars, last_commit, description, score, score_detail) VALUES (?,?,?,?,?,?,?,?,?,?)')
        for (const m of repos) {
          const { score, detail } = wheelScore(m, keywords)
          ins.run(cap.id, m.repo, m.url, m.license, isLicenseOk(m.license) ? 1 : 0, m.stars, m.lastCommit, m.description, score, JSON.stringify(detail))
        }
      })()
      result.ok++
      log(`✔ ${cap.name}: ${repos.length} 个候选轮子`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      result.failed.push({ capabilityId: cap.id, name: cap.name, error: msg })
      log(`✖ ${cap.name}: ${msg}`)
    }
    // live 限速间隔：未鉴权的 GitHub 搜索 API 每分钟 10 次，连续打必 429
    if (ctx.config.github.mode === 'live') await new Promise((r) => setTimeout(r, 800))
  }
  if (result.ok > 0) ctx.db.prepare("UPDATE tailor_requests SET status = 'searched' WHERE id = ?").run(requestId)
  return result
}
