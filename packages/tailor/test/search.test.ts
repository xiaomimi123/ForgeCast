import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createLlmClient, loadConfig, openDb, type CoreCtx } from '@forgecast/core'
import type { GithubClient } from '@forgecast/scout'
import { beforeEach, describe, expect, it } from 'vitest'
import { addCapability, addRequest, getRequestDetail } from '../src/requests'
import { searchWheels } from '../src/search'

let ctx: CoreCtx
beforeEach(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-search-'))
  const config = loadConfig(root, {})
  ctx = { db: openDb(config.paths.db), config, llm: createLlmClient(config.llm) }
})

function seed(): { id: number; capA: number; capB: number } {
  const { id } = addRequest(ctx, { title: 'A', rawNeed: 'n' })
  ctx.db.prepare("UPDATE tailor_requests SET status = 'decomposed' WHERE id = ?").run(id)
  const capA = addCapability(ctx, id, { name: '登录', keywords: ['oauth'] }).id
  const capB = addCapability(ctx, id, { name: '支付', keywords: ['payment'] }).id
  return { id, capA, capB }
}

describe('searchWheels', () => {
  it('mock github：全部能力写入轮子并评分，status→searched', async () => {
    const { id } = seed()
    const r = await searchWheels(ctx, id)
    expect(r.ok).toBe(2)
    expect(r.failed).toEqual([])
    const d = getRequestDetail(ctx, id)
    expect(d.request.status).toBe('searched')
    for (const c of d.capabilities) {
      expect(c.wheels.length).toBeGreaterThan(0)
      expect(c.wheels[0].score).toBeGreaterThanOrEqual(0)
      expect([0, 1]).toContain(c.wheels[0].license_ok)
    }
  })
  it('单项失败不阻塞其他：失败项记入 failed，成功项照常入库', async () => {
    const { id, capA } = seed()
    const gh: GithubClient = {
      searchRepos: async () => [],
      fetchReadme: async () => '',
      fetchTree: async () => [],
      searchByKeywords: async (keywords) => {
        if (keywords.includes('oauth')) throw new Error('HTTP 403（限流）')
        return [{ repo: 'a/pay', url: 'u', description: 'payment sdk', license: 'MIT', stars: 10, lastCommit: null, topics: [] }]
      },
    }
    const r = await searchWheels(ctx, id, { gh })
    expect(r.ok).toBe(1)
    expect(r.failed.length).toBe(1)
    expect(r.failed[0].capabilityId).toBe(capA)
    expect(r.failed[0].error).toMatch(/403/)
    const d = getRequestDetail(ctx, id)
    expect(d.request.status).toBe('searched') // 有成功项即推进
  })
  it('capabilityId 只重搜单项，且覆盖该项旧轮子', async () => {
    const { id, capB } = seed()
    await searchWheels(ctx, id)
    const before = getRequestDetail(ctx, id)
    const gh: GithubClient = {
      searchRepos: async () => [], fetchReadme: async () => '', fetchTree: async () => [],
      searchByKeywords: async () => [{ repo: 'new/only', url: 'u', description: null, license: 'MIT', stars: 1, lastCommit: null, topics: [] }],
    }
    await searchWheels(ctx, id, { capabilityId: capB, gh })
    const after = getRequestDetail(ctx, id)
    const bWheels = after.capabilities.find((c) => c.id === capB)!.wheels
    expect(bWheels.map((w) => w.repo)).toEqual(['new/only'])
    // 另一项没被动
    expect(after.capabilities[0].wheels.length).toBe(before.capabilities[0].wheels.length)
  })
  it('没有能力清单抛错；需求不存在抛错', async () => {
    const { id } = addRequest(ctx, { title: 'B', rawNeed: 'n' })
    await expect(searchWheels(ctx, id)).rejects.toThrow(/先拆解/)
    await expect(searchWheels(ctx, 999)).rejects.toThrow(/不存在/)
  })
})
