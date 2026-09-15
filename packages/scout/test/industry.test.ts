import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createLlmClient, loadConfig, openDb, type CoreCtx } from '@forgecast/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { INDUSTRY_MOCK_KEYWORDS, businessProofHits, generateIndustryQueries, isTemplateRepo, queriesFor, type Industry } from '../src/industry'

let ctx: CoreCtx
beforeEach(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-industry-'))
  const config = loadConfig(root, {}) // llm mock + github mock
  ctx = { db: openDb(config.paths.db), config, llm: createLlmClient(config.llm) }
})

function liveCtx(complete: (args: any) => Promise<string>): CoreCtx {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-industry-live-'))
  const config = loadConfig(root, { FORGECAST_LLM_MODE: 'live', FORGECAST_LLM_KEY: 'k' })
  return { db: openDb(config.paths.db), config, llm: { complete: vi.fn(complete) } as any }
}

const industries = (c: CoreCtx): Industry[] =>
  c.db.prepare('SELECT id, name, note, enabled FROM industries ORDER BY sort_order').all() as Industry[]

describe('INDUSTRY_MOCK_KEYWORDS', () => {
  it('八个 seed 行业全覆盖，每组 12-20 个英文关键词且无重复', () => {
    const seeded = industries(ctx).map((i) => i.name)
    expect(seeded).toHaveLength(8)
    for (const name of seeded) {
      const kws = INDUSTRY_MOCK_KEYWORDS[name]
      expect(kws, `缺行业 mock 词表：${name}`).toBeDefined()
      expect(kws.length).toBeGreaterThanOrEqual(12)
      expect(kws.length).toBeLessThanOrEqual(20)
      expect(new Set(kws).size).toBe(kws.length)
      for (const k of kws) expect(k).toMatch(/^[a-z0-9-]+$/)
    }
  })
})

describe('generateIndustryQueries', () => {
  it('mock：走固定词表（不借道 ctx.llm），并写入 industry_queries 缓存', async () => {
    const ind = industries(ctx)[0]
    const spy = vi.spyOn(ctx.llm, 'complete')
    const kws = await generateIndustryQueries(ctx, ind)
    expect(kws).toEqual(INDUSTRY_MOCK_KEYWORDS[ind.name])
    expect(spy).not.toHaveBeenCalled()
    const row: any = ctx.db.prepare('SELECT * FROM industry_queries WHERE industry_id = ?').get(ind.id)
    expect(JSON.parse(row.keywords)).toEqual(kws)
    expect(row.model).toBe('mock')
    expect(row.generated_at).toBeTruthy()
  })

  it('mock：词表里没有的行业名（用户自建）→ 回落通用词表，不抛错', async () => {
    const info = ctx.db.prepare("INSERT INTO industries (name, note, enabled, sort_order) VALUES ('临时行业', null, 1, 99)").run()
    const kws = await generateIndustryQueries(ctx, { id: Number(info.lastInsertRowid), name: '临时行业', note: null, enabled: 1 })
    expect(kws.length).toBeGreaterThanOrEqual(12)
  })

  it('live：prompt 带行业名与 note，解析 LLM 返回的关键词数组并缓存', async () => {
    const lctx = liveCtx(async () => JSON.stringify({ keywords: ['lms', 'course-platform', 'quiz'] }))
    const ind = industries(lctx)[0]
    const kws = await generateIndustryQueries(lctx, ind)
    expect(kws).toEqual(['lms', 'course-platform', 'quiz'])
    const prompt = (lctx.llm.complete as any).mock.calls[0][0].prompt as string
    expect(prompt).toContain(ind.name)
    expect(prompt).toContain(ind.note!)
    const row: any = lctx.db.prepare('SELECT keywords FROM industry_queries WHERE industry_id = ?').get(ind.id)
    expect(JSON.parse(row.keywords)).toEqual(kws)
  })

  it('live：LLM 返回裸数组也能解析；上限 20 个', async () => {
    const many = Array.from({ length: 30 }, (_, i) => `kw-${i}`)
    const lctx = liveCtx(async () => JSON.stringify(many))
    const kws = await generateIndustryQueries(lctx, industries(lctx)[0])
    expect(kws).toHaveLength(20)
  })

  it('live：返回不是 JSON → 抛错（调用方按行业隔离失败）', async () => {
    const lctx = liveCtx(async () => '我不听我不听')
    await expect(generateIndustryQueries(lctx, industries(lctx)[0])).rejects.toThrow(/搜索词/)
  })
})

describe('queriesFor', () => {
  it('有缓存直接读，不重新生成', async () => {
    const lctx = liveCtx(async () => JSON.stringify(['a', 'b']))
    const ind = industries(lctx)[0]
    await queriesFor(lctx, ind) // 第一次生成
    const again = await queriesFor(lctx, ind) // 第二次走缓存
    expect(again).toEqual(['a', 'b'])
    expect((lctx.llm.complete as any).mock.calls).toHaveLength(1)
  })
  it('无缓存 → 生成并落缓存', async () => {
    const ind = industries(ctx)[0]
    const kws = await queriesFor(ctx, ind)
    expect(kws).toEqual(INDUSTRY_MOCK_KEYWORDS[ind.name])
    const row: any = ctx.db.prepare('SELECT keywords FROM industry_queries WHERE industry_id = ?').get(ind.id)
    expect(row).toBeTruthy()
  })
})

describe('isTemplateRepo', () => {
  it('名字/描述命中排除词且 README 无业务实证 → 排', () => {
    expect(isTemplateRepo('vuejs/awesome-vue', 'A curated list of things', '收集了很多链接')).toBe(true)
    expect(isTemplateRepo('acme/next-boilerplate', null, 'just a starter')).toBe(true)
    expect(isTemplateRepo('acme/ui', 'a component-library of buttons', 'buttons and inputs')).toBe(true)
  })

  it('名字带 admin 但 README 有业务实证（role + permission）→ 不排', () => {
    const readme = 'vue-element-admin is a dashboard. It talks to a REST api and supports role based permission control.'
    expect(isTemplateRepo('PanJiaChen/vue-element-admin', 'A magical vue admin-ui', readme)).toBe(false)
  })

  // 审查实测：无词边界时 `Author` 命中 auth、`rapid`/`capital` 命中 api，
  // 这条真实感 starter README 会被判成"有业务实证"而放行，且业务含量拿满分——功能等于没开。
  const REAL_STARTER_README = 'Ship your SaaS in a weekend. Authentication with NextAuth, Stripe payments, '
    + 'Prisma ORM, Tailwind UI, dark mode, rapid prototyping, capital-efficient. Author: acme. Deploy to Vercel in one click.'

  it('真实感 SaaS starter（Authentication/Prisma/Author/rapid/capital 全齐）→ 照排不误', () => {
    expect(isTemplateRepo('acme/nextjs-saas-starter', 'A production-ready SaaS starter template', REAL_STARTER_README)).toBe(true)
  })

  it('同一条 README 的业务含量不满分：只有数据层词、没有业务实体词', () => {
    const { proof, dataModel } = businessProofHits(REAL_STARTER_README)
    expect(proof).toBe(false)    // 没有 order/customer/invoice/role/permission/workflow
    expect(dataModel).toBe(true) // Prisma 确实是数据层
  })

  it('词边界：Author 不算 auth、rapid/capital 不算 api', () => {
    expect(businessProofHits('Author: acme. rapid prototyping, capital efficient.')).toEqual({ proof: false, dataModel: false })
    expect(businessProofHits('exposes a REST api').dataModel).toBe(true)
  })

  it('owner 段不参与模板判定（回归：gpl-example/* 这类正经仓库被 owner 里的 example 株连）', () => {
    expect(isTemplateRepo('gpl-example/copyleft-tool', '开源库存管理工具', 'A copyleft inventory tool.')).toBe(false)
    expect(isTemplateRepo('demo-org/crm-server', 'CRM 服务端', '')).toBe(false)
    expect(isTemplateRepo('acme/crm-demo', 'CRM 演示', '')).toBe(true) // name 段命中仍照排
  })

  it('没命中排除词的普通仓库一律不排（README 是什么都无所谓）', () => {
    expect(isTemplateRepo('chatwoot/chatwoot', '开源多渠道在线客服平台', '')).toBe(false)
  })

  it('大小写不敏感', () => {
    expect(isTemplateRepo('Acme/Awesome-List', 'Curated', 'nothing here')).toBe(true)
  })
})
