import type { RepoMeta } from '@forgecast/scout'
import { describe, expect, it } from 'vitest'
import { wheelScore } from '../src/score'

const base: RepoMeta = { repo: 'acme/wechat-login', url: 'u', description: 'WeChat OAuth login SDK', license: 'MIT', stars: 5000, lastCommit: null, topics: [] }
const daysAgo = (n: number) => new Date(Date.now() - n * 86400000).toISOString()

describe('wheelScore', () => {
  it('活跃度档位: <90天30 / <365天20 / <730天10 / 更久或未知0', () => {
    expect(wheelScore({ ...base, lastCommit: daysAgo(30) }, []).detail.activity).toBe(30)
    expect(wheelScore({ ...base, lastCommit: daysAgo(200) }, []).detail.activity).toBe(20)
    expect(wheelScore({ ...base, lastCommit: daysAgo(500) }, []).detail.activity).toBe(10)
    expect(wheelScore({ ...base, lastCommit: daysAgo(1000) }, []).detail.activity).toBe(0)
    expect(wheelScore({ ...base, lastCommit: null }, []).detail.activity).toBe(0)
  })
  it('热度档位: ≥10000→25 / ≥1000→20 / ≥100→12 / >0→5 / 0→0', () => {
    expect(wheelScore({ ...base, stars: 20000 }, []).detail.popularity).toBe(25)
    expect(wheelScore({ ...base, stars: 5000 }, []).detail.popularity).toBe(20)
    expect(wheelScore({ ...base, stars: 100 }, []).detail.popularity).toBe(12)
    expect(wheelScore({ ...base, stars: 1 }, []).detail.popularity).toBe(5)
    expect(wheelScore({ ...base, stars: 0 }, []).detail.popularity).toBe(0)
  })
  it('协议: 白名单15 / 非白名单但有协议5 / 无协议0', () => {
    expect(wheelScore({ ...base, license: 'MIT' }, []).detail.license).toBe(15)
    expect(wheelScore({ ...base, license: 'GPL-3.0' }, []).detail.license).toBe(5)
    expect(wheelScore({ ...base, license: null }, []).detail.license).toBe(0)
  })
  it('命中度: 关键词命中 repo 名/描述的比例 ×30，大小写不敏感；无关键词=0', () => {
    expect(wheelScore(base, ['wechat', 'oauth']).detail.relevance).toBe(30)
    expect(wheelScore(base, ['wechat', 'kubernetes']).detail.relevance).toBe(15)
    expect(wheelScore(base, []).detail.relevance).toBe(0)
  })
  it('总分=四项之和且 detail 带 rationale', () => {
    const r = wheelScore({ ...base, lastCommit: daysAgo(30) }, ['wechat'])
    const d = r.detail
    expect(r.score).toBe(d.activity + d.popularity + d.license + d.relevance)
    expect(d.rationale).toBeTruthy()
  })
})
