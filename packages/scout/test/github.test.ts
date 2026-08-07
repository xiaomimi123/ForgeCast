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

  it('fetchReadme：raw 命中直接返回，不打 API', async () => {
    const fetchImpl = vi.fn(async () => new Response('# raw 内容'))
    const gh = createGithubClient(liveCfg, fetchImpl as any)
    expect(await gh.fetchReadme('acme/widget')).toBe('# raw 内容')
    expect(fetchImpl).toHaveBeenCalledOnce()
    expect(String(fetchImpl.mock.calls[0][0])).toContain('raw.githubusercontent.com')
  })

  it('fetchReadme：raw 抛错（主机不可达）→ 回退 api.github.com readme 端点，带 Bearer + raw Accept', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('raw.githubusercontent.com')) throw new TypeError('fetch failed')
      return new Response('# 真实 README 内容')
    })
    const gh = createGithubClient(liveCfg, fetchImpl as any)
    expect(await gh.fetchReadme('acme/widget')).toBe('# 真实 README 内容')
    const apiCall = fetchImpl.mock.calls.find((c: any) => String(c[0]).includes('api.github.com/repos/acme/widget/readme'))
    expect(apiCall, '应回退到 API readme 端点').toBeTruthy()
    expect((apiCall![1] as any).headers.authorization).toBe('Bearer t1')
    expect((apiCall![1] as any).headers.accept).toBe('application/vnd.github.raw')
  })

  it('fetchReadme：raw 非 200（404）也回退 API', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('raw.githubusercontent.com')) return new Response('Not Found', { status: 404 })
      return new Response('# API 拿到的 README')
    })
    const gh = createGithubClient(liveCfg, fetchImpl as any)
    expect(await gh.fetchReadme('acme/widget')).toBe('# API 拿到的 README')
  })

  it('fetchReadme：raw 与 API 都失败 → 返空串（不阻断上层）', async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError('fetch failed') })
    const gh = createGithubClient(liveCfg, fetchImpl as any)
    expect(await gh.fetchReadme('acme/widget')).toBe('')
  })
})

describe('searchByKeywords', () => {
  it('mock 返回 fixture，条数受 perPage 限制', async () => {
    const gh = createGithubClient({ mode: 'mock', token: '' })
    const r = await gh.searchByKeywords(['whatever'], { perPage: 2 })
    expect(r.length).toBe(2)
    expect(r[0].repo).toBeTruthy()
  })
  it('live 拼关键词 q 并映射字段', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      items: [{ full_name: 'a/b', html_url: 'u', description: 'd', license: { spdx_id: 'MIT' }, stargazers_count: 5, pushed_at: '2026-01-01T00:00:00Z', topics: [] }],
    })))
    const gh = createGithubClient({ mode: 'live', token: '' }, fetchImpl as any)
    const r = await gh.searchByKeywords(['wechat login', 'oauth'], { perPage: 8 })
    expect(String(fetchImpl.mock.calls[0][0])).toContain(encodeURIComponent('wechat login oauth'))
    expect(r[0]).toMatchObject({ repo: 'a/b', license: 'MIT', stars: 5 })
  })
  it('live 403 抛错（带限流提示）', async () => {
    const fetchImpl = vi.fn(async () => new Response('rate limited', { status: 403 }))
    const gh = createGithubClient({ mode: 'live', token: '' }, fetchImpl as any)
    await expect(gh.searchByKeywords(['x'], { perPage: 8 })).rejects.toThrow(/403/)
  })
  it('空 keywords 返回空数组且不发请求', async () => {
    const fetchImpl = vi.fn()
    const gh = createGithubClient({ mode: 'live', token: '' }, fetchImpl as any)
    expect(await gh.searchByKeywords([], { perPage: 8 })).toEqual([])
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
