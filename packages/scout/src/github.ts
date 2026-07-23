import type { ForgecastConfig } from '@forgecast/core'
import { candidateFixtures } from './fixtures/candidate-fixtures'
import type { RepoMeta, SearchOpts } from './types'

export interface GithubClient {
  searchRepos(topics: string[], opts: SearchOpts): Promise<RepoMeta[]>
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
    async fetchReadme(repo) {
      const res = await fetchImpl(`https://raw.githubusercontent.com/${repo}/HEAD/README.md`)
      return res.ok ? await res.text() : ''
    },
    async fetchTree(repo) {
      const res = await fetchImpl(`https://api.github.com/repos/${repo}/git/trees/HEAD?recursive=1`, { headers })
      if (!res.ok) return []
      const data: any = await res.json()
      return (data.tree ?? []).map((t: any) => t.path as string)
    },
  }
}
