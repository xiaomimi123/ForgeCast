import type { CoreCtx } from '@forgecast/core'
import { createGithubClient, type GithubClient } from './github'
import { isLicenseOk } from './license'
import { scoreCandidate } from './score'
import type { RepoMeta } from './types'

export const DEFAULT_TOPICS = [
  'crm', 'e-commerce', 'live-chat', 'booking', 'invoice', 'inventory', 'form-builder',
  'dashboard', 'chatbot', 'link-in-bio', 'scheduling', 'pos', 'wiki', 'survey',
]

const UPSERT = `INSERT INTO candidates (repo, url, description, license, license_ok, stars, last_commit, tech_stack, score, score_detail, status)
VALUES (@repo, @url, @description, @license, @license_ok, @stars, @last_commit, @tech_stack, @score, @score_detail, 'candidate')
ON CONFLICT(repo) DO UPDATE SET url=excluded.url, description=excluded.description, license=excluded.license, license_ok=excluded.license_ok,
  stars=excluded.stars, last_commit=excluded.last_commit, tech_stack=excluded.tech_stack,
  score=excluded.score, score_detail=excluded.score_detail`

/** 抓 README + 评分（仅协议过关者）后 upsert 入池；rejected 者不评分只登记 */
async function ingest(ctx: CoreCtx, gh: GithubClient, meta: RepoMeta, scoreIt: boolean): Promise<void> {
  const ok = isLicenseOk(meta.license)
  let score: number | null = null
  let scoreDetail: string | null = null
  let techStack: string | null = null
  if (ok && scoreIt) {
    const readme = await gh.fetchReadme(meta.repo)
    const d = await scoreCandidate(ctx, meta, readme)
    score = d.rebrandCost + d.buyerClarity + d.visualAppeal
    techStack = JSON.stringify(d.techStack)
    scoreDetail = JSON.stringify({
      rebrandCost: d.rebrandCost, buyerClarity: d.buyerClarity, visualAppeal: d.visualAppeal,
      rationale: d.rationale, targetBuyer: d.targetBuyer, painPoint: d.painPoint,
    })
  }
  ctx.db.prepare(UPSERT).run({
    repo: meta.repo, url: meta.url, description: meta.description, license: meta.license, license_ok: ok ? 1 : 0,
    stars: meta.stars, last_commit: meta.lastCommit, tech_stack: techStack, score, score_detail: scoreDetail,
  })
}

/** 搜索 topic 白名单 → 去重 → 协议 gate → 过关者按 star 取 Top-limit 抓 README 评分 → 入池 */
export async function scoutCandidates(
  ctx: CoreCtx,
  opts: { topics?: string[]; limit?: number; pushedAfter?: string } = {},
): Promise<{ found: number; scored: number; rejected: number }> {
  const gh = createGithubClient(ctx.config.github)
  const topics = opts.topics ?? DEFAULT_TOPICS
  const limit = opts.limit ?? 30
  const pushedAfter = opts.pushedAfter ?? new Date(Date.now() - 183 * 864e5).toISOString().slice(0, 10)
  const found = await gh.searchRepos(topics, { minStars: 300, pushedAfter, perTopic: 20 })

  const passing = found.filter((m) => isLicenseOk(m.license)).sort((a, b) => b.stars - a.stars)
  const toScore = new Set(passing.slice(0, limit).map((m) => m.repo))
  let scored = 0
  let rejected = 0
  for (const m of found) {
    const willScore = toScore.has(m.repo)
    await ingest(ctx, gh, m, willScore)
    if (!isLicenseOk(m.license)) rejected++
    else if (willScore) scored++
  }
  return { found: found.length, scored, rejected }
}

/** 手动投喂单个 repo（URL 或 owner/name）：抓元数据+评分入池 */
export async function addRepo(ctx: CoreCtx, repoUrl: string): Promise<void> {
  const repo = normalizeRepo(repoUrl)
  const gh = createGithubClient(ctx.config.github)
  // mock 下 searchRepos 即 fixtures，从中取该 repo；live 下用一次 search 兜底元数据
  const all = await gh.searchRepos([], { minStars: 0, pushedAfter: '1970-01-01', perTopic: 1 })
  const meta = all.find((m) => m.repo === repo)
    ?? { repo, url: `https://github.com/${repo}`, description: null, license: null, stars: 0, lastCommit: null, topics: [] }
  await ingest(ctx, gh, meta, true)
}

function normalizeRepo(input: string): string {
  const m = input.match(/github\.com\/([^/]+\/[^/#?]+)/)
  return (m ? m[1] : input).replace(/\.git$/, '').replace(/\/$/, '')
}
