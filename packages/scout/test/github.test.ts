import { describe, expect, it, vi } from 'vitest'
import { candidateFixtures } from '../src/fixtures/candidate-fixtures'
import { createGithubClient } from '../src/github'

const mockCfg = { mode: 'mock' as const, token: '' }
const liveCfg = { mode: 'live' as const, token: 't1' }

describe('fixtures', () => {
  it('至少 4 个，含一个协议不可商用的（触发 gate）', () => {
    expect(candidateFixtures.length).toBeGreaterThanOrEqual(4)
    expect(candidateFixtures.some((f) => f.license === 'GPL-3.0')).toBe(true)
    for (const f of candidateFixtures) {
      expect(f.repo, 'repo 含 owner/name').toContain('/')
      expect(f.readme.length, `${f.repo} readme`).toBeGreaterThan(20)
      expect(Array.isArray(f.tree)).toBe(true)
    }
  })
})

describe('createGithubClient mock', () => {
  it('searchRepos 返回 fixture 元数据；fetchReadme/fetchTree 取 fixture', async () => {
    const gh = createGithubClient(mockCfg)
    const repos = await gh.searchRepos(['crm'], { minStars: 300, pushedAfter: '2020-01-01', perTopic: 20 })
    expect(repos.length).toBe(candidateFixtures.length)
    const first = candidateFixtures[0]
    expect(await gh.fetchReadme(first.repo)).toBe(first.readme)
    expect(await gh.fetchTree(first.repo)).toEqual(first.tree)
  })
})

describe('createGithubClient live', () => {
  it('searchRepos 拼对 URL 与鉴权头并解析', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      items: [{
        full_name: 'acme/widget', html_url: 'https://github.com/acme/widget', description: '一个示例仓库',
        license: { spdx_id: 'MIT' }, stargazers_count: 500, pushed_at: '2025-01-01T00:00:00Z', topics: ['crm'],
      }],
    })))
    const gh = createGithubClient(liveCfg, fetchImpl as any)
    const repos = await gh.searchRepos(['crm'], { minStars: 300, pushedAfter: '2024-01-01', perTopic: 20 })
    expect(repos[0]).toEqual({
      repo: 'acme/widget', url: 'https://github.com/acme/widget', description: '一个示例仓库',
      license: 'MIT', stars: 500, lastCommit: '2025-01-01T00:00:00Z', topics: ['crm'],
    })
    const [url, init] = fetchImpl.mock.calls[0] as any
    expect(url).toContain('https://api.github.com/search/repositories?q=')
    expect(url).toContain('topic%3Acrm')
    expect(init.headers.authorization).toBe('Bearer t1')
  })
})
