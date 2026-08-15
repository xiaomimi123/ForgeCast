import type { ForgecastConfig } from '@forgecast/core'
import { candidateFixtures } from './fixtures/candidate-fixtures'
import type { RepoMeta, SearchOpts } from './types'

export interface GithubClient {
  searchRepos(topics: string[], opts: SearchOpts): Promise<RepoMeta[]>
  /** 按关键词全文搜（tailor 找轮子用）：失败抛错（调用方按能力项隔离失败），searchRepos 则是静默跳过 */
  searchByKeywords(keywords: string[], opts: { perPage: number }): Promise<RepoMeta[]>
  /** 爆款检测：按「创建时间 + 当前 star 数」筛新晋高星仓库，按 star 降序，单次查询不去重多请求 */
  searchBreakouts(opts: { minStars: number; createdAfter: string; perPage: number }): Promise<RepoMeta[]>
  fetchReadme(repo: string): Promise<string>
  fetchTree(repo: string): Promise<string[]>
}

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
      const seen = new Map<string, RepoMeta>()
      for (const topic of topics) {
        const q = `topic:${topic} stars:>${opts.minStars} pushed:>${opts.pushedAfter}`
        const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=stars&per_page=${opts.perTopic}`
        const res = await fetchImpl(url, { headers })
        if (!res.ok) continue // 单个 topic 失败不影响其他（限速等）
        const data: any = await res.json()
        for (const it of data.items ?? []) {
          seen.set(it.full_name, {
            repo: it.full_name, url: it.html_url, description: it.description ?? null,
            license: it.license?.spdx_id ?? null,
            stars: it.stargazers_count ?? 0, lastCommit: it.pushed_at ?? null, topics: it.topics ?? [],
          })
        }
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
