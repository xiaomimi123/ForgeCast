import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createLlmClient, loadConfig, openDb, type CoreCtx } from '@forgecast/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { categorizeHeuristic, generateSummaryZh, scoreCandidate } from '../src/score'

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
  it('mock 下 summaryZh 留空串（无 LLM，不编造翻译）', async () => {
    const ctx = ctxWith({})
    const d = await scoreCandidate(ctx, meta, 'React + Node + Docker 的 CRM，含 dashboard、screenshot 与 demo。'.repeat(3))
    expect(d.summaryZh).toBe('')
  })
  it('信息稀少的 README 分数更低', async () => {
    const ctx = ctxWith({})
    const rich = await scoreCandidate(ctx, meta, 'React Node Docker CRM dashboard screenshot demo'.repeat(5))
    const poor = await scoreCandidate(ctx, meta, 'cli tool')
    const sum = (x: any) => x.rebrandCost + x.buyerClarity + x.visualAppeal
    expect(sum(rich)).toBeGreaterThan(sum(poor))
  })
})

describe('scoreCandidate mock 分轨', () => {
  it('有明确垂直场景关键词（crm等）→ track=profit，带 gapScore/threshold/exitRoutes，不带 traffic 字段', async () => {
    const ctx = ctxWith({})
    const d = await scoreCandidate(ctx, meta, 'React Node Docker CRM dashboard screenshot demo'.repeat(3))
    expect(d.track).toBe('profit')
    expect(d.gapScore).toBeGreaterThan(0)
    expect(d.gapScore).toBeLessThanOrEqual(100)
    expect(d.threshold).toBeGreaterThan(0)
    expect(d.threshold).toBeLessThanOrEqual(100)
    expect(d.exitRoutes).toEqual(['托管'])
    expect(d.emotionScore).toBeUndefined()
    expect(d.wowScore).toBeUndefined()
  })
  it('无垂直场景关键词 → track=traffic，带 emotionScore/wowScore，不带 profit 字段', async () => {
    const ctx = ctxWith({})
    const d = await scoreCandidate(ctx, meta, 'a cli tool for terminal theming with cool demo screenshot')
    expect(d.track).toBe('traffic')
    expect(d.emotionScore).toBeGreaterThanOrEqual(0)
    expect(d.emotionScore).toBeLessThanOrEqual(100)
    expect(d.wowScore).toBeGreaterThanOrEqual(0)
    expect(d.gapScore).toBeUndefined()
    expect(d.exitRoutes).toBeUndefined()
  })
})

describe('scoreCandidate live 分轨', () => {
  it('LLM 返回 track=profit + gapScore/threshold/exitRoutes → 解析并夹取上限，exitRoutes 过滤非法值', async () => {
    const config = loadConfig('/tmp/fc-score-dual1', { FORGECAST_LLM_MODE: 'live', FORGECAST_LLM_KEY: 'k' })
    const llm = { complete: vi.fn(async () => JSON.stringify({
      rebrandCost: 20, buyerClarity: 30, visualAppeal: 20, techStack: [], rationale: 'ok',
      track: 'profit', gapScore: 150, threshold: 80, exitRoutes: ['托管', '定制', '瞎编'],
    })) }
    const ctx: CoreCtx = { db: openDb(config.paths.db), config, llm: llm as any }
    const d = await scoreCandidate(ctx, meta, 'readme')
    expect(d.track).toBe('profit')
    expect(d.gapScore).toBe(100)
    expect(d.threshold).toBe(80)
    expect(d.exitRoutes).toEqual(['托管', '定制'])
    expect(d.emotionScore).toBeUndefined()
  })
  it('LLM 返回 track=traffic + emotionScore/wowScore → 解析', async () => {
    const config = loadConfig('/tmp/fc-score-dual2', { FORGECAST_LLM_MODE: 'live', FORGECAST_LLM_KEY: 'k' })
    const llm = { complete: vi.fn(async () => JSON.stringify({
      rebrandCost: 10, buyerClarity: 10, visualAppeal: 25, techStack: [], rationale: 'ok',
      track: 'traffic', emotionScore: 90, wowScore: 95,
    })) }
    const ctx: CoreCtx = { db: openDb(config.paths.db), config, llm: llm as any }
    const d = await scoreCandidate(ctx, meta, 'readme')
    expect(d.track).toBe('traffic')
    expect(d.emotionScore).toBe(90)
    expect(d.wowScore).toBe(95)
    expect(d.gapScore).toBeUndefined()
  })
  it('LLM 返回非法 track 值 → 分轨相关字段全部 undefined', async () => {
    const config = loadConfig('/tmp/fc-score-dual3', { FORGECAST_LLM_MODE: 'live', FORGECAST_LLM_KEY: 'k' })
    const llm = { complete: vi.fn(async () => JSON.stringify({
      rebrandCost: 10, buyerClarity: 10, visualAppeal: 10, techStack: [], rationale: 'ok',
      track: 'nonsense',
    })) }
    const ctx: CoreCtx = { db: openDb(config.paths.db), config, llm: llm as any }
    const d = await scoreCandidate(ctx, meta, 'readme')
    expect(d.track).toBeUndefined()
    expect(d.gapScore).toBeUndefined()
    expect(d.emotionScore).toBeUndefined()
  })
})

describe('scoreCandidate live', () => {
  it('调 LLM 并解析 JSON 评分', async () => {
    const config = loadConfig('/tmp/fc-score2', { FORGECAST_LLM_MODE: 'live', FORGECAST_LLM_KEY: 'k' })
    const llm = { complete: vi.fn(async () => '```json\n{"rebrandCost":24,"buyerClarity":34,"visualAppeal":21,"techStack":["react"],"rationale":"ok"}\n```') }
    const ctx: CoreCtx = { db: openDb(config.paths.db), config, llm: llm as any }
    const d = await scoreCandidate(ctx, meta, 'readme')
    // LLM 未返回 category，且启发式在 'a/b'/'readme'/['react'] 中也无命中 → 兜底"其它"
    expect(d).toEqual({ rebrandCost: 24, buyerClarity: 34, visualAppeal: 21, techStack: ['react'], rationale: 'ok', targetBuyer: '', painPoint: '', summaryZh: '', category: '其它' })
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

describe('categorizeHeuristic 领域分类', () => {
  it('关键词→领域；无命中→其它；领域优先于 AI', () => {
    expect(categorizeHeuristic('foo/chatwoot', 'live chat helpdesk support', [])).toBe('客服/IM')
    expect(categorizeHeuristic('foo/x', 'invoice billing accounting', [])).toBe('财务/发票')
    expect(categorizeHeuristic('foo/x', 'admin dashboard analytics', [])).toBe('仪表盘/BI')
    expect(categorizeHeuristic('foo/x', 'llm agent assistant rag', [])).toBe('AI助手/Agent')
    expect(categorizeHeuristic('foo/x', 'just some random utility', [])).toBe('其它')
    expect(categorizeHeuristic('foo/x', 'ai powered crm for sales', [])).toBe('CRM/销售') // 领域先于 AI
  })
})

describe('scoreCandidate category（mock 走启发式）', () => {
  it('mock 评分产出启发式 category', async () => {
    const d = await scoreCandidate(ctx, { repo: 'x/chat', url: 'u', description: null, license: 'MIT', stars: 1, lastCommit: '2026-01-01', topics: [] }, 'live chat helpdesk')
    expect(d.category).toBe('客服/IM')
  })
})

describe('scoreCandidate live（假 LLM）', () => {
  it('summaryZh 缺失/非字符串时按空串兜底', async () => {
    const config = loadConfig('/tmp/fc-score-live', { FORGECAST_LLM_MODE: 'live', FORGECAST_LLM_KEY: 'k' })
    const lctx: CoreCtx = {
      db: openDb(config.paths.db), config,
      llm: { complete: vi.fn(async () => JSON.stringify({
        rebrandCost: 20, buyerClarity: 30, visualAppeal: 20, techStack: ['react'],
        rationale: 'r', targetBuyer: 't', painPoint: 'p', category: 'CRM/销售',
        // summaryZh 缺失
      })) } as any,
    }
    const d = await scoreCandidate(lctx, meta, 'readme')
    expect(d.summaryZh).toBe('')
  })
  it('summaryZh 是字符串时原样透传', async () => {
    const config = loadConfig('/tmp/fc-score-live2', { FORGECAST_LLM_MODE: 'live', FORGECAST_LLM_KEY: 'k' })
    const lctx: CoreCtx = {
      db: openDb(config.paths.db), config,
      llm: { complete: vi.fn(async () => JSON.stringify({
        rebrandCost: 20, buyerClarity: 30, visualAppeal: 20, techStack: ['react'],
        rationale: 'r', targetBuyer: 't', painPoint: 'p', summaryZh: '开源客服平台', category: 'CRM/销售',
      })) } as any,
    }
    const d = await scoreCandidate(lctx, meta, 'readme')
    expect(d.summaryZh).toBe('开源客服平台')
  })
})

describe('generateSummaryZh', () => {
  it('mock 模式留空串，不编造翻译', async () => {
    const ctx = ctxWith({}) // llm mock
    const s = await generateSummaryZh(ctx, 'acme/widget', 100, 'React + Node 的示例项目')
    expect(s).toBe('')
  })
  it('live 模式：正常解析 summaryZh', async () => {
    const config = loadConfig('/tmp/fc-summary-live', { FORGECAST_LLM_MODE: 'live', FORGECAST_LLM_KEY: 'k' })
    const lctx: CoreCtx = {
      db: openDb(config.paths.db), config,
      llm: { complete: vi.fn(async () => JSON.stringify({ summaryZh: '一个开源客服平台' })) } as any,
    }
    const s = await generateSummaryZh(lctx, 'acme/widget', 100, 'readme 内容')
    expect(s).toBe('一个开源客服平台')
  })
  it('live 模式：summaryZh 缺失/非字符串/坏 JSON 都兜底空串（不抛错）', async () => {
    const config = loadConfig('/tmp/fc-summary-live2', { FORGECAST_LLM_MODE: 'live', FORGECAST_LLM_KEY: 'k' })
    const missing: CoreCtx = {
      db: openDb(config.paths.db), config,
      llm: { complete: vi.fn(async () => JSON.stringify({})) } as any,
    }
    expect(await generateSummaryZh(missing, 'acme/widget', 100, 'r')).toBe('')
    const badJson: CoreCtx = {
      db: openDb(config.paths.db), config,
      llm: { complete: vi.fn(async () => '不是 JSON 的纯文本') } as any,
    }
    expect(await generateSummaryZh(badJson, 'acme/widget', 100, 'r')).toBe('')
  })
})

describe('自定义权重', () => {
  it('mock 模式：heuristicScore 封顶值跟着自定义 weights 变', async () => {
    const config = loadConfig('/tmp/fc-score-weights', {})
    config.scout.weights = { rebrandCost: 5, buyerClarity: 5, visualAppeal: 5 }
    const wctx: CoreCtx = { db: openDb(config.paths.db), config, llm: createLlmClient(config.llm) }
    const d = await scoreCandidate(wctx, meta, 'React + Node + Docker 的 CRM，含 dashboard、screenshot 与 demo。'.repeat(3))
    expect(d.rebrandCost).toBeLessThanOrEqual(5)
    expect(d.buyerClarity).toBeLessThanOrEqual(5)
    expect(d.visualAppeal).toBeLessThanOrEqual(5)
  })
  it('live 模式：parseScoreJson 按自定义 weights 夹取，而非硬编码 30/40/30', async () => {
    const config = loadConfig('/tmp/fc-score-weights-live', { FORGECAST_LLM_MODE: 'live', FORGECAST_LLM_KEY: 'k' })
    config.scout.weights = { rebrandCost: 5, buyerClarity: 5, visualAppeal: 5 }
    const llm = { complete: vi.fn(async () => JSON.stringify({
      rebrandCost: 20, buyerClarity: 20, visualAppeal: 20, techStack: [], rationale: 'r',
    })) }
    const lctx: CoreCtx = { db: openDb(config.paths.db), config, llm: llm as any }
    const d = await scoreCandidate(lctx, meta, 'readme')
    expect(d.rebrandCost).toBe(5) // LLM 返回20，但自定义上限5，夹到5
    expect(d.buyerClarity).toBe(5)
    expect(d.visualAppeal).toBe(5)
  })
  it('live 模式：prompt 文案里的维度上限数字跟着自定义 weights 变', async () => {
    const config = loadConfig('/tmp/fc-score-weights-prompt', { FORGECAST_LLM_MODE: 'live', FORGECAST_LLM_KEY: 'k' })
    config.scout.weights = { rebrandCost: 15, buyerClarity: 25, visualAppeal: 35 }
    const llm = { complete: vi.fn(async () => JSON.stringify({ rebrandCost: 1, buyerClarity: 1, visualAppeal: 1, techStack: [], rationale: 'r' })) }
    const lctx: CoreCtx = { db: openDb(config.paths.db), config, llm: llm as any }
    await scoreCandidate(lctx, meta, 'readme')
    const prompt = llm.complete.mock.calls[0][0].prompt as string
    expect(prompt).toContain('0-15')
    expect(prompt).toContain('0-25')
    expect(prompt).toContain('0-35')
  })
  it('默认权重（30/40/30）时行为跟改动前完全一致', async () => {
    const config = loadConfig('/tmp/fc-score-weights-default', {})
    const wctx: CoreCtx = { db: openDb(config.paths.db), config, llm: createLlmClient(config.llm) }
    const d = await scoreCandidate(wctx, meta, 'React + Node + Docker 的 CRM，含 dashboard、screenshot 与 demo。'.repeat(3))
    expect(d.rebrandCost).toBeLessThanOrEqual(30)
    expect(d.buyerClarity).toBeLessThanOrEqual(40)
    expect(d.visualAppeal).toBeLessThanOrEqual(30)
  })
})
