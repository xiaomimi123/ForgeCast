import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createLlmClient, loadConfig, openDb, type CoreCtx } from '@forgecast/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { scoreCandidate } from '../src/score'

let ctx: CoreCtx
let root: string
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-score-'))
  const config = loadConfig(root, {}) // llm mock
  ctx = { db: openDb(config.paths.db), config, llm: createLlmClient(config.llm) }
})

function ctxWith(env: Record<string, string> = {}): CoreCtx {
  const config = loadConfig('/tmp/fc-score', env)
  return { db: openDb(config.paths.db), config, llm: createLlmClient(config.llm) }
}
const meta = { repo: 'a/b', url: 'u', license: 'MIT', stars: 100, lastCommit: null, topics: ['crm'], description: null }

describe('scoreCandidate mock', () => {
  it('确定性启发式：三维在各自上限内、合成可加、techStack 有值', async () => {
    const ctx = ctxWith({}) // llm mock
    const d = await scoreCandidate(ctx, meta, 'React + Node + Docker 的 CRM，含 dashboard、screenshot 与 demo。'.repeat(3))
    expect(d.rebrandCost).toBeGreaterThan(0)
    expect(d.rebrandCost).toBeLessThanOrEqual(30)
    expect(d.buyerClarity).toBeLessThanOrEqual(40)
    expect(d.visualAppeal).toBeLessThanOrEqual(30)
    expect(d.techStack).toContain('react')
    expect(d.techStack).toContain('docker')
  })
  it('信息稀少的 README 分数更低', async () => {
    const ctx = ctxWith({})
    const rich = await scoreCandidate(ctx, meta, 'React Node Docker CRM dashboard screenshot demo'.repeat(5))
    const poor = await scoreCandidate(ctx, meta, 'cli tool')
    const sum = (x: any) => x.rebrandCost + x.buyerClarity + x.visualAppeal
    expect(sum(rich)).toBeGreaterThan(sum(poor))
  })
})

describe('scoreCandidate live', () => {
  it('调 LLM 并解析 JSON 评分', async () => {
    const config = loadConfig('/tmp/fc-score2', { FORGECAST_LLM_MODE: 'live', FORGECAST_LLM_KEY: 'k' })
    const llm = { complete: vi.fn(async () => '```json\n{"rebrandCost":24,"buyerClarity":34,"visualAppeal":21,"techStack":["react"],"rationale":"ok"}\n```') }
    const ctx: CoreCtx = { db: openDb(config.paths.db), config, llm: llm as any }
    const d = await scoreCandidate(ctx, meta, 'readme')
    expect(d).toEqual({ rebrandCost: 24, buyerClarity: 34, visualAppeal: 21, techStack: ['react'], rationale: 'ok', targetBuyer: '', painPoint: '' })
    expect(llm.complete).toHaveBeenCalledOnce()
  })
})

describe('targetBuyer / painPoint', () => {
  it('mock 模式两字段为空串，不编造', async () => {
    const meta = { repo: 'a/b', url: 'u', description: 'd', license: 'MIT', stars: 100, lastCommit: null, topics: [] }
    const d = await scoreCandidate(ctx, meta, 'react docker dashboard screenshot crm')
    expect(d.targetBuyer).toBe('')
    expect(d.painPoint).toBe('')
  })

  it('live 模式从 LLM JSON 解析出两字段', async () => {
    const llm = {
      complete: async () => JSON.stringify({
        rebrandCost: 20, buyerClarity: 30, visualAppeal: 20, techStack: ['react'],
        rationale: '理由', targetBuyer: '做外贸的中小电商老板', painPoint: '客户散在多个入口，漏回消息',
      }),
    }
    const config = loadConfig(root, { FORGECAST_LLM_MODE: 'live', FORGECAST_LLM_KEY: 'k' })
    const lctx: CoreCtx = { db: openDb(config.paths.db), config, llm: llm as any }
    const meta = { repo: 'a/b', url: 'u', description: 'd', license: 'MIT', stars: 100, lastCommit: null, topics: [] }
    const d = await scoreCandidate(lctx, meta, 'readme')
    expect(d.targetBuyer).toBe('做外贸的中小电商老板')
    expect(d.painPoint).toBe('客户散在多个入口，漏回消息')
  })

  it('LLM 漏返这两个字段时按空串处理，不抛错', async () => {
    const llm = { complete: async () => JSON.stringify({ rebrandCost: 10, buyerClarity: 10, visualAppeal: 10 }) }
    const config = loadConfig(root, { FORGECAST_LLM_MODE: 'live', FORGECAST_LLM_KEY: 'k' })
    const lctx: CoreCtx = { db: openDb(config.paths.db), config, llm: llm as any }
    const meta = { repo: 'a/b', url: 'u', description: 'd', license: 'MIT', stars: 100, lastCommit: null, topics: [] }
    const d = await scoreCandidate(lctx, meta, 'readme')
    expect(d.targetBuyer).toBe('')
    expect(d.painPoint).toBe('')
  })
})
