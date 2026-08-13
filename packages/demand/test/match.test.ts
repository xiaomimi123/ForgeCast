import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createLlmClient, loadConfig, openDb, type CoreCtx } from '@forgecast/core'
import type { GithubClient, RepoMeta } from '@forgecast/scout'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { listMatches, matchSignal } from '../src/match'
import { importSignals, listSignals } from '../src/signals'

let ctx: CoreCtx
let root: string
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-dmatch-'))
  const config = loadConfig(root, {}) // llm mock
  ctx = { db: openDb(config.paths.db), config, llm: createLlmClient(config.llm) }
  importSignals(ctx, { source: 'douyin_hot', signals: [{ title: '用AI给朋友做专属小游戏', summary: 'AI 定制小游戏送礼', heat: 9 }] })
})

function meta(repo: string, stars: number, daysAgo = 10): RepoMeta {
  return {
    repo, url: `https://github.com/${repo}`, description: `${repo} game generator`,
    license: 'MIT', stars, lastCommit: new Date(Date.now() - daysAgo * 86400000).toISOString(), topics: [],
  }
}
function fakeGh(repos: RepoMeta[]): GithubClient {
  return {
    searchRepos: async () => [], searchByKeywords: async () => repos,
    fetchReadme: async () => '', fetchTree: async () => [],
  }
}
/** 每次调用 searchByKeywords 依次消费一个行为（Error 则抛出，否则返回该数组），最后一个行为重复用于多余调用 */
function sequentialGh(behaviors: Array<RepoMeta[] | Error>): GithubClient {
  let call = 0
  return {
    searchRepos: async () => [],
    searchByKeywords: async () => {
      const b = behaviors[Math.min(call, behaviors.length - 1)]
      call++
      if (b instanceof Error) throw b
      return b
    },
    fetchReadme: async () => '', fetchTree: async () => [],
  }
}
function sigId(): number { return listSignals(ctx)[0].id }
/** 导入一条能被 mock 切词切出 ≥2 个关键词的信号（多空格标题），返回其 id */
function multiKeywordSigId(): number {
  const title = 'AI 定制 小游戏 生成器'
  importSignals(ctx, { source: 'douyin_hot', signals: [{ title, heat: 5 }] })
  return listSignals(ctx).find((s) => s.title === title)!.id
}

describe('matchSignal mock', () => {
  it('全流程：搜 8 个取 top5、按 score 降序落库、status→matched、不调 ctx.llm', async () => {
    const repos = Array.from({ length: 8 }, (_, i) => meta(`o/r${i}`, (i + 1) * 500))
    const spy = vi.spyOn(ctx.llm, 'complete')
    const r = await matchSignal(ctx, sigId(), { gh: fakeGh(repos) })
    expect(r.matched).toBe(5)
    expect(spy).not.toHaveBeenCalled()
    const rows = listMatches(ctx, sigId())
    expect(rows).toHaveLength(5)
    expect(rows[0].score).toBeGreaterThanOrEqual(rows[4].score)
    expect(rows[0].biz_plan.length).toBeGreaterThan(0)
    expect(['shop', 'custom', 'both']).toContain(rows[0].biz_mode)
    expect(listSignals(ctx)[0].status).toBe('matched')
  })
  it('搜索 0 结果：不写表、status 不变、matched=0', async () => {
    const r = await matchSignal(ctx, sigId(), { gh: fakeGh([]) })
    expect(r.matched).toBe(0)
    expect(listMatches(ctx, sigId())).toHaveLength(0)
    expect(listSignals(ctx)[0].status).toBe('new')
  })
  it('重复匹配删旧插新', async () => {
    await matchSignal(ctx, sigId(), { gh: fakeGh([meta('a/x', 100)]) })
    await matchSignal(ctx, sigId(), { gh: fakeGh([meta('b/y', 200)]) })
    const rows = listMatches(ctx, sigId())
    expect(rows).toHaveLength(1)
    expect(rows[0].repo).toBe('b/y')
  })
  it('信号不存在抛错', async () => {
    await expect(matchSignal(ctx, 9999, { gh: fakeGh([]) })).rejects.toThrow(/不存在/)
  })
  it('逐关键词搜索：单个关键词失败被隔离，其余关键词成功仍能匹配', async () => {
    const gh = sequentialGh([new Error('限流'), [meta('a/x', 100)], [meta('b/y', 200)]])
    const r = await matchSignal(ctx, multiKeywordSigId(), { gh })
    expect(r.matched).toBeGreaterThan(0)
  })
  it('所有关键词搜索都失败：抛错、不写表、status 不变', async () => {
    const gh = sequentialGh([new Error('限流'), new Error('超时'), new Error('网络错误')])
    const id = multiKeywordSigId()
    await expect(matchSignal(ctx, id, { gh })).rejects.toThrow(/GitHub 搜索失败/)
    expect(listMatches(ctx, id)).toHaveLength(0)
    expect(listSignals(ctx).find((s) => s.id === id)!.status).toBe('new')
  })
})

describe('matchSignal live（假 LLM）', () => {
  it('LLM#2 输出非法 bizMode → 整批抛错、表无脏数据、status 不变', async () => {
    const config = loadConfig(root, { FORGECAST_LLM_MODE: 'live', FORGECAST_LLM_KEY: 'k' })
    config.paths.templates = path.resolve(__dirname, '../../../templates')
    const complete = vi.fn()
      .mockResolvedValueOnce(JSON.stringify({ keywords: ['game', 'generator'] }))
      .mockResolvedValueOnce(JSON.stringify([{ repo: 'a/x', bizMode: 'bogus', bizPlan: 'x' }]))
    const lctx: CoreCtx = { db: ctx.db, config, llm: { complete } as any }
    await expect(matchSignal(lctx, sigId(), { gh: fakeGh([meta('a/x', 100)]) })).rejects.toThrow(/非法/)
    expect(listMatches(ctx, sigId())).toHaveLength(0)
    expect(listSignals(ctx)[0].status).toBe('new')
  })
  it('LLM 合法输出 → 正常落库', async () => {
    const config = loadConfig(root, { FORGECAST_LLM_MODE: 'live', FORGECAST_LLM_KEY: 'k' })
    config.paths.templates = path.resolve(__dirname, '../../../templates')
    const complete = vi.fn()
      .mockResolvedValueOnce(JSON.stringify({ keywords: ['game'] }))
      .mockResolvedValueOnce(JSON.stringify([{ repo: 'a/x', bizMode: 'custom', bizPlan: '接单定制小游戏交付' }]))
    const lctx: CoreCtx = { db: ctx.db, config, llm: { complete } as any }
    const r = await matchSignal(lctx, sigId(), { gh: fakeGh([meta('a/x', 100)]) })
    expect(r.matched).toBe(1)
    expect(listMatches(ctx, sigId())[0].biz_mode).toBe('custom')
  })
})
