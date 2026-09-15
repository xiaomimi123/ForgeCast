import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createLlmClient, loadConfig, openDb, type CoreCtx } from '@forgecast/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { INDUSTRY_MOCK_KEYWORDS, businessProofHits, generateIndustryQueries, isTemplateRepo, queriesFor, type Industry } from '../src/industry'
import { businessDepthFloor } from '../src/score'

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
    expect(isTemplateRepo('acme/ui-component-library', 'buttons of all kinds', 'buttons and inputs')).toBe(true)
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

  // M2 实测回归：learning|theme|example|demo|tutorial 作用在 description 上是误伤放大器。
  it('description 只认强脚手架词：moodle（描述含 learning platform）不被挡', () => {
    const desc = 'Moodle - the world\'s open source learning platform'
    const readme = 'Moodle is a learning platform designed to provide educators and learners with a single robust system.'
    expect(isTemplateRepo('moodle/moodle', desc, readme)).toBe(false)
    // README 里有 course/student 实证时更不可能被挡
    expect(isTemplateRepo('moodle/moodle', desc, `${readme} Manage courses, enrolment and student grades.`)).toBe(false)
  })

  it('description 里的 example/demo/tutorial 不再株连正经产品', () => {
    expect(isTemplateRepo('appsmithorg/appsmith', 'Build internal tools, see the live demo', '')).toBe(false)
    expect(isTemplateRepo('acme/erp', 'ERP with tutorial included', '')).toBe(false)
    // 但描述里写 starter/boilerplate/template 仍照排
    expect(isTemplateRepo('acme/erp', 'A SaaS starter for ERP', 'nothing real here')).toBe(true)
  })

  // M3 实测回归：业务实证词表原本只有 order|customer|invoice|role|permission|workflow，
  // spec §2.2 点名的"学员/库存/工单"全缺，教育/健康/本地生活三个 seed 行业的头部项目被门槛误杀。
  it('业务实证词覆盖 seed 行业实体：openedx（course/student）、openemr（patient/appointment）', () => {
    const edx = 'The Open edX platform. Manage courses, enrollment, student progress and grading.'
    expect(businessProofHits(edx).proof).toBe(true)
    const emr = 'OpenEMR is a medical practice management software: patient demographics, appointment scheduling, billing.'
    expect(businessProofHits(emr).proof).toBe(true)
    const pos = '门店 POS：inventory 盘点、会员 member 积分、工单 ticket 流转'
    expect(businessProofHits(pos).proof).toBe(true)
  })

  it('M3：业务实证要求两个互不相同的词——单个 permission/workflow/ecommerce 一律不算', () => {
    expect(businessProofHits('Solid workflow to make your code healthy').proof).toBe(false)
    expect(businessProofHits('- Permission Authentication\n  - Page permission').proof).toBe(false)
    expect(businessProofHits('a headless ecommerce template').proof).toBe(false)
    expect(businessProofHits('role based permission control').proof).toBe(true) // role + permission
  })

  // 变异钉子①：硬排反证 1 个词 / 深度实证 2 个词的**不对称**是刻意的。
  // 把 isTemplateRepo 里的 `=== 0` 改成 `< 2`（抹平不对称）时这条必须红。
  it('M3 不对称：单个业务词足以让模板硬排放行，但不足以过业务含量门槛', () => {
    const readme = 'A dashboard starter. Features: order list page. Nothing else.'
    // 硬排放行（1 个词即可反证）——错杀的代价是连记录都不留
    expect(isTemplateRepo('acme/admin-starter', 'A dashboard starter', readme)).toBe(false)
    // 但业务含量门槛不放行（要 2 个互不相同的词）——真正的过滤在这一道
    expect(businessProofHits(readme).proof).toBe(false)
    const { dataModel } = businessProofHits(readme)
    expect(Math.min(30, 6 + 0 + (dataModel ? 5 : 0))).toBeLessThan(businessDepthFloor({ businessDepth: 30 }))
  })

  // 变异钉子②：README 里的 URL 必须被剥掉才判词。
  // 把 stripUrls 改成恒等函数时这条必须红——徽章里的 workflows 与文档链接里的 patient
  // 会凑够两个词，把一个纯皮肤仓库判成业务系统（openemr/ant-design-pro 正是靠 badge 蒙混过关的）。
  it('M3：URL 里的词一律不算（CI 徽章的 workflows、链接路径里的业务词都不算）', () => {
    const urlOnly = '[![CI](https://github.com/acme/x/actions/workflows/ci.yml/badge.svg)](https://github.com/acme/x/actions/workflows/ci.yml)\n'
      + 'See https://acme.com/docs/patient-appointments for details.\n'
      + 'A pretty terminal skin with nice colors.'
    expect(businessProofHits(urlOnly).proof).toBe(false)
    // 同样两个词写在正文里就算数
    expect(businessProofHits('A skin. Manages patient appointments.').proof).toBe(true)
  })

  it('补词后 SaaS starter 仍拿不到业务实证（payment/subscription 刻意不收词）', () => {
    expect(businessProofHits(REAL_STARTER_README).proof).toBe(false)
    expect(businessProofHits('Stripe payments and subscriptions included').proof).toBe(false)
  })

  it('vue-element-admin 照旧：README 有 role/permission 实证 → 不排（补词没让它更容易或更难过）', () => {
    const readme = 'vue-element-admin is a dashboard. It talks to a REST api and supports role based permission control.'
    expect(isTemplateRepo('PanJiaChen/vue-element-admin', 'A magical vue admin-ui', readme)).toBe(false)
    // 真实仓库的描述是 "A vue admin template based on vue and element-ui"——template 在两张表里都有，
    // 命中后仍靠 README 里的 role/permission 反证放行。结论与改表前一致：它属于"该挡没挡"的既有缺口。
    expect(isTemplateRepo('PanJiaChen/vue-element-admin', 'A vue admin template based on element-ui', readme)).toBe(false)
    expect(isTemplateRepo('PanJiaChen/vue-element-admin', 'A vue admin template based on element-ui', 'just a skin')).toBe(true)
  })

  it('大小写不敏感', () => {
    expect(isTemplateRepo('Acme/Awesome-List', 'Curated', 'nothing here')).toBe(true)
  })
})

// ——— 审查实跑口径的回归钉子 ———
// 下面 8 个仓库的 description / README 片段都摘自真实 GitHub 数据（2026-09 抓取），
// 前 5 个是真业务系统（必须进池），后 3 个是模板/脚手架类（必须被挡）。
// 片段刻意保留 CI 徽章 URL 与功能清单——正是它们制造了旧口径的误判。
const REAL: Array<{ repo: string; desc: string; readme: string; pass: boolean }> = [
  {
    repo: 'moodle/moodle', pass: true,
    desc: "Moodle - the world's open source learning platform",
    readme: "Moodle is the World's Open Source Learning Platform. Moodle is designed to allow educators, administrators and learners to create personalised learning environments with a single robust, secure and integrated system.",
  },
  {
    repo: 'openedx/edx-platform', pass: true,
    desc: 'The Open edX LMS & Studio, powering education sites around the world!',
    readme: 'image:: https://github.com/openedx/edx-platform/actions/workflows/unit-tests.yml/badge.svg\nThe Open edX LMS. Create a MySQL user with write permissions, and configure Django. Learners use the Learning MFE in order to navigate the UI.',
  },
  {
    repo: 'openemr/openemr', pass: true,
    desc: 'The most popular open source electronic health records and medical practice management solution.',
    readme: '[![Syntax Status](https://github.com/openemr/openemr/actions/workflows/syntax.yml/badge.svg)]\nOpenEMR is a Free and Open Source electronic health records and medical practice management application. It features fully integrated electronic health records, practice management, scheduling, electronic billing. A community of developers, medical providers and educators.',
  },
  {
    repo: 'chatwoot/chatwoot', pass: true,
    desc: 'Open-source live-chat, email support, omni-channel desk.',
    readme: 'Chatwoot is the modern, open-source customer support platform. It centralizes all customer conversations into one inbox, handles common queries, reduces agent workload, and supports ticket workflows with a REST api.',
  },
  {
    repo: 'twentyhq/twenty', pass: true,
    desc: 'The open alternative to Salesforce, designed for AI.',
    readme: 'Twenty gives you the building blocks of a modern CRM (objects, views, workflows, and agents) and lets you extend them.',
  },
  {
    repo: 'PanJiaChen/vue-element-admin', pass: false,
    desc: ':tada: A magical vue admin',
    readme: '## Features\n```\n- Login / Logout\n- Permission Authentication\n  - Page permission\n  - Directive permission\n```\nIt talks to a mock api and uses element-ui.',
  },
  {
    repo: 'ant-design/ant-design-pro', pass: false,
    desc: 'Use Ant Design like a Pro!',
    readme: '[![CI](https://github.com/ant-design/ant-design-pro/actions/workflows/ci.yml/badge.svg)]\n- Built-in i18n solution\n- **Best Practices**: Solid workflow to make your code healthy\n- Mock api and TypeScript.',
  },
  {
    repo: 'vercel/commerce', pass: false,
    desc: 'Next.js Commerce',
    readme: 'A high-performance, server-rendered Next.js App Router ecommerce application. This template uses React Server Components, Server Actions and Suspense. Use Next.js Commerce as your headless Shopify storefront on Vercel.',
  },
]

describe('真实仓库判定（拿真实 desc/README 片段实跑 isTemplateRepo + 业务含量门槛）', () => {
  const floor = businessDepthFloor({ businessDepth: 30 })
  for (const r of REAL) {
    it(`${r.repo} → ${r.pass ? '进池' : '挡掉'}`, () => {
      const tpl = isTemplateRepo(r.repo, r.desc, r.readme)
      const { proof, dataModel } = businessProofHits(r.readme)
      const depth = Math.min(30, 6 + (proof ? 19 : 0) + (dataModel ? 5 : 0))
      expect(!tpl && depth >= floor, `${r.repo}: template=${tpl} depth=${depth}`).toBe(r.pass)
    })
  }
})
