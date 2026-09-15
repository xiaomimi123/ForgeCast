import type { ForgecastConfig } from '@forgecast/core'
import { candidateFixtures } from './fixtures/candidate-fixtures'
import type { RepoMeta, SearchOpts } from './types'

/** GitHub search API 限速：带 token 30 次/分 → 2s/次；没 token 10 次/分 → 6.5s/次。 */
const THROTTLE_WITH_TOKEN = 2000
const THROTTLE_NO_TOKEN = 6500
/** 被限流（403/429）后的退避重试间隔，用完还失败就跳过这个词。 */
const RETRY_BACKOFF_MS = [5000, 15000]
const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export interface GithubClient {
  searchRepos(topics: string[], opts: SearchOpts): Promise<RepoMeta[]>
  /** 按关键词全文搜（tailor 找轮子用）：失败抛错（调用方按能力项隔离失败），searchRepos 则是静默跳过 */
  searchByKeywords(keywords: string[], opts: { perPage: number }): Promise<RepoMeta[]>
  /** 爆款检测：按「创建时间 + 当前 star 数」筛新晋高星仓库，按 star 降序，单次查询不去重多请求 */
  searchBreakouts(opts: { minStars: number; createdAfter: string; perPage: number }): Promise<RepoMeta[]>
  fetchReadme(repo: string): Promise<string>
  fetchTree(repo: string): Promise<string[]>
}

/** 403（二级限流/额度耗尽）与 429（显式限流）都算限流。 */
function isRateLimited(status: number): boolean { return status === 403 || status === 429 }

/** GitHub 客户端：mock 返回 fixture（离线），live 走官方 API（token 可选） */
export function createGithubClient(cfg: ForgecastConfig['github'], fetchImpl: typeof fetch = fetch): GithubClient {
  if (cfg.mode === 'mock') {
    const byRepo = new Map(candidateFixtures.map((f) => [f.repo, f]))
    return {
      async searchRepos() {
        return candidateFixtures.map((f) => ({
          repo: f.repo, url: f.url, description: f.description, license: f.license,
          stars: f.stars, lastCommit: f.lastCommit, topics: f.topics,
        }))
      },
      async searchByKeywords(_keywords, opts) {
        return candidateFixtures.slice(0, opts.perPage).map((f) => ({
          repo: f.repo, url: f.url, description: f.description, license: f.license,
          stars: f.stars, lastCommit: f.lastCommit, topics: f.topics,
        }))
      },
      async searchBreakouts(opts) {
        return candidateFixtures.slice(0, opts.perPage).map((f) => ({
          repo: f.repo, url: f.url, description: f.description, license: f.license,
          stars: f.stars, lastCommit: f.lastCommit, topics: f.topics,
        }))
      },
      async fetchReadme(repo) { return byRepo.get(repo)?.readme ?? '' },
      async fetchTree(repo) { return byRepo.get(repo)?.tree ?? [] },
    }
  }

  const headers: Record<string, string> = { accept: 'application/vnd.github+json' }
  if (cfg.token) headers.authorization = `Bearer ${cfg.token}`

  return {
    async searchRepos(topics, opts) {
      // 一词一次 search 请求，GitHub 限速 30 次/分（带 token）。不节流的话
      // 8 行业 × 十几个词一轮就打爆限额，后面的词全静默 0 命中——日志还会把它报成"词太偏"，
      // 用户于是反复重生成搜索词，越修越错。所以：请求间节流 + 429/403 退避重试 + 结局回调。
      const sleep = opts.sleep ?? defaultSleep
      const throttleMs = opts.throttleMs ?? (cfg.token ? THROTTLE_WITH_TOKEN : THROTTLE_NO_TOKEN)
      const note = opts.onNote ?? (() => {})
      const seen = new Map<string, RepoMeta>()
      for (const [i, topic] of topics.entries()) {
        if (i > 0 && throttleMs > 0) await sleep(throttleMs)
        const q = `topic:${topic} stars:>${opts.minStars} pushed:>${opts.pushedAfter}`
        const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=stars&per_page=${opts.perTopic}`
        let res = await fetchImpl(url, { headers })
        for (let attempt = 0; !res.ok && isRateLimited(res.status) && attempt < RETRY_BACKOFF_MS.length; attempt++) {
          await sleep(RETRY_BACKOFF_MS[attempt])
          res = await fetchImpl(url, { headers })
        }
        if (!res.ok) {
          // 限流与真失败要分开报：前者说明"没搜成"，后者才是"词/请求有问题"
          note({ topic, kind: isRateLimited(res.status) ? 'rate-limited' : 'error', status: res.status })
          continue // 单个 topic 失败不影响其他
        }
        const data: any = await res.json()
        const items = data.items ?? []
        for (const it of items) {
          seen.set(it.full_name, {
            repo: it.full_name, url: it.html_url, description: it.description ?? null,
            license: it.license?.spdx_id ?? null,
            stars: it.stargazers_count ?? 0, lastCommit: it.pushed_at ?? null, topics: it.topics ?? [],
          })
        }
        note({ topic, kind: 'ok', count: items.length })
      }
      return [...seen.values()]
    },
    async searchByKeywords(keywords, opts) {
      const q = keywords.filter(Boolean).join(' ')
      if (!q) return []
      const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=stars&per_page=${opts.perPage}`
      const res = await fetchImpl(url, { headers })
      if (!res.ok) {
        const hint = res.status === 403 || res.status === 429 ? '（GitHub 搜索限流：配 token 或稍后重搜）' : ''
        throw new Error(`GitHub 搜索失败 HTTP ${res.status}${hint}`)
      }
      const data: any = await res.json()
      return (data.items ?? []).map((it: any) => ({
        repo: it.full_name, url: it.html_url, description: it.description ?? null,
        license: it.license?.spdx_id ?? null,
        stars: it.stargazers_count ?? 0, lastCommit: it.pushed_at ?? null, topics: it.topics ?? [],
      }))
    },
    async searchBreakouts(opts) {
      const q = `stars:>=${opts.minStars} created:>${opts.createdAfter}`
      const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=stars&per_page=${opts.perPage}`
      const res = await fetchImpl(url, { headers })
      if (!res.ok) {
        const hint = res.status === 403 || res.status === 429 ? '（GitHub 搜索限流：配 token 或稍后重搜）' : ''
        throw new Error(`GitHub 搜索失败 HTTP ${res.status}${hint}`)
      }
      const data: any = await res.json()
      return (data.items ?? []).map((it: any) => ({
        repo: it.full_name, url: it.html_url, description: it.description ?? null,
        license: it.license?.spdx_id ?? null,
        stars: it.stargazers_count ?? 0, lastCommit: it.pushed_at ?? null, topics: it.topics ?? [],
      }))
    },
    async fetchReadme(repo) {
      // 先试 raw（快、免鉴权、无 API 限额）；网络失败或非 200 → 回退 GitHub API readme 端点。
      // raw.githubusercontent.com 在受限网络（如国内）常不可达而抛 "fetch failed"，
      // 而 api.github.com（带 token）更稳、限额更高；两者都拿不到 → 返空串，不阻断上层。
      try {
        const res = await fetchImpl(`https://raw.githubusercontent.com/${repo}/HEAD/README.md`)
        if (res.ok) return await res.text()
      } catch { /* raw 主机不可达 → 落到 API 回退 */ }
      try {
        const res = await fetchImpl(`https://api.github.com/repos/${repo}/readme`, {
          headers: { ...headers, accept: 'application/vnd.github.raw' },
        })
        if (res.ok) return await res.text()
      } catch { /* API 也失败 → 返空串 */ }
      return ''
    },
    async fetchTree(repo) {
      const res = await fetchImpl(`https://api.github.com/repos/${repo}/git/trees/HEAD?recursive=1`, { headers })
      if (!res.ok) return []
      const data: any = await res.json()
      return (data.tree ?? []).map((t: any) => t.path as string)
    },
  }
}
