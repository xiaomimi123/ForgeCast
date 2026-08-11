# 候选详情 / 产品说明书（B）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 看板候选卡片加「详情 / 产品说明书」：点按钮弹窗，LLM 读 README 生成结构化深度介绍（简介/功能/目标用户/痛点/换皮卖点），按需生成、DB 缓存复用。

**Architecture:** scout 包新增纯 helper（`heuristicIntro`/`parseIntroJson`/`validateIntro`）+ 生成函数 `generateCandidateIntro`（镜像 `rescoreCandidate`：读候选→mock 走 heuristic / live 抓 README+LLM→校验）。server 加 `POST /api/candidates/:id/intro`（mock 早返回、缓存命中秒回、否则生成写 `intro_detail` 列）。前端弹窗组件按需请求 + 分节渲染 + 重新生成。

**Tech Stack:** TypeScript, pnpm monorepo, better-sqlite3, Hono, vitest, React + @tanstack/react-query, Vite。

## Global Constraints

- Node **22.23.1**（better-sqlite3 ABI）；测试用 `corepack pnpm --filter <pkg> test`（先 `nvm use 22.23.1`）。
- 每个 LLM 能力**必须按 `ctx.config.llm.mode` 分支并自带 mock**，mock 分支**绝不调用 `ctx.llm`**。
- live 生成复用模型名 `ctx.config.llm.models.analysis`，**不新增 config 字段**。
- `intro_detail` 是候选表新列（`TEXT`，存 JSON），迁移用 `ensureColumn`（兼容旧库）。
- 生成失败（抓 README / LLM / 校验）→ 抛错，**不写入脏缓存**；server 该路由返 500。
- 候选列表接口 `GET /api/candidates` **不得返回 `intro_detail`**（payload 精简）。
- `IntroDetail` 字段固定：`summary: string`、`features: string[]`、`targetUser: string`、`painPoint: string`、`rebrandIdea: string`、`generatedAt: string`。
- `generatedAt` 在生成函数内用 `new Date().toISOString()` 填（server 运行时 Date 可用）。

---

## File Structure

- `packages/scout/src/intro.ts`（新）— `IntroDetail` 类型 + `heuristicIntro` + `parseIntroJson` + `validateIntro` + `generateCandidateIntro`。
- `packages/scout/src/index.ts`（改）— 追加 `export * from './intro'`。
- `packages/scout/test/intro.test.ts`（新）— 纯 helper + 生成函数分支测试。
- `templates/prompts/candidate-intro.md`（新）— live 生成的 prompt 模板。
- `packages/core/src/db.ts`（改）— 加 `ensureColumn(db, 'candidates', 'intro_detail', 'TEXT')`。
- `packages/server/src/app.ts`（改）— 新路由 `POST /api/candidates/:id/intro` + 列表 SELECT 改显式列。
- `packages/server/test/intro.test.ts`（新）— 路由行为测试。
- `apps/web/src/api.ts`（改）— `IntroDetail` / `IntroResponse` 类型。
- `apps/web/src/pages/board/CandidateCard.tsx`（改）— 「详情」按钮 + `onOpenDetail` prop；`export` `parseDetail`/`Bar`/`DIMS` 供弹窗复用。
- `apps/web/src/pages/board/CandidateDetailModal.tsx`（新）— 弹窗组件。
- `apps/web/src/pages/BoardPage.tsx`（改）— `detailOf` 状态 + 渲染弹窗 + 传 `onOpenDetail`。

---

## Task 1: scout 纯 helper（类型 + heuristicIntro + parseIntroJson + validateIntro）

**Files:**
- Create: `packages/scout/src/intro.ts`
- Modify: `packages/scout/src/index.ts`
- Test: `packages/scout/test/intro.test.ts`

**Interfaces:**
- Consumes: `RepoMeta` from `./types`（`{ repo, url, description, license, stars, lastCommit, topics }`）。
- Produces:
  - `interface IntroDetail { summary: string; features: string[]; targetUser: string; painPoint: string; rebrandIdea: string; generatedAt: string }`
  - `heuristicIntro(meta: RepoMeta, readme: string): IntroDetail`
  - `parseIntroJson(raw: string): IntroDetail`（剥 ```json 围栏后 JSON.parse；缺字段按空串/空数组兜底；malformed 让 JSON.parse 抛）
  - `validateIntro(d: IntroDetail): string[]`（返回问题字段名数组，空=通过）

- [ ] **Step 1: 写失败测试** — `packages/scout/test/intro.test.ts`

```ts
import { describe, expect, it } from 'vitest'
import { heuristicIntro, parseIntroJson, validateIntro, type IntroDetail } from '../src/intro'

const meta = { repo: 'a/adminlte', url: 'u', description: '后台管理模板', license: 'MIT', stars: 40000, lastCommit: null, topics: [] }

describe('heuristicIntro', () => {
  it('结构合法：features≥3、五个文本字段非空、含 generatedAt', () => {
    const d = heuristicIntro(meta, 'React admin dashboard template')
    expect(d.features.length).toBeGreaterThanOrEqual(3)
    expect(d.summary.trim()).not.toBe('')
    expect(d.targetUser.trim()).not.toBe('')
    expect(d.painPoint.trim()).not.toBe('')
    expect(d.rebrandIdea.trim()).not.toBe('')
    expect(typeof d.generatedAt).toBe('string')
    expect(validateIntro(d)).toEqual([])
  })
})

describe('parseIntroJson', () => {
  it('解析带 ```json 围栏的合法 JSON', () => {
    const raw = '```json\n{"summary":"s","features":["f1","f2","f3"],"targetUser":"t","painPoint":"p","rebrandIdea":"r"}\n```'
    const d = parseIntroJson(raw)
    expect(d.summary).toBe('s')
    expect(d.features).toEqual(['f1', 'f2', 'f3'])
    expect(d.rebrandIdea).toBe('r')
    expect(validateIntro(d)).toEqual([])
  })
  it('缺字段按空兜底，交给 validateIntro 判失败', () => {
    const d = parseIntroJson('{"summary":"s"}')
    expect(d.features).toEqual([])
    expect(validateIntro(d).sort()).toEqual(['features', 'painPoint', 'rebrandIdea', 'targetUser'])
  })
  it('malformed JSON 抛错', () => {
    expect(() => parseIntroJson('not json at all')).toThrow()
  })
})

describe('validateIntro', () => {
  it('features 少于 3 条判 features 不合格', () => {
    const d: IntroDetail = { summary: 's', features: ['a', 'b'], targetUser: 't', painPoint: 'p', rebrandIdea: 'r', generatedAt: '' }
    expect(validateIntro(d)).toEqual(['features'])
  })
  it('空串字段被列出', () => {
    const d: IntroDetail = { summary: '', features: ['a', 'b', 'c'], targetUser: '  ', painPoint: 'p', rebrandIdea: 'r', generatedAt: '' }
    expect(validateIntro(d).sort()).toEqual(['summary', 'targetUser'])
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `corepack pnpm --filter @forgecast/scout test intro`
Expected: FAIL（`Cannot find module '../src/intro'`）

- [ ] **Step 3: 实现 `packages/scout/src/intro.ts`（本 Task 只加纯 helper，`generateCandidateIntro` 在 Task 2）**

```ts
import type { RepoMeta } from './types'

export interface IntroDetail {
  summary: string
  features: string[]
  targetUser: string
  painPoint: string
  rebrandIdea: string
  generatedAt: string
}

/** mock：从 meta/README 确定性拼出占位介绍（离线、可测；绝不走 ctx.llm）。features 恒 3 条保证结构合法。 */
export function heuristicIntro(meta: RepoMeta, readme: string): IntroDetail {
  const name = meta.repo.split('/')[1] ?? meta.repo
  const desc = (meta.description || readme.replace(/\s+/g, ' ').trim().slice(0, 120) || name).trim()
  return {
    summary: `${name}：${desc}。（占位内容——配好 live 大模型后可生成完整产品介绍）`,
    features: ['核心功能待 live 大模型生成', '功能清单待 live 大模型生成', '更多功能待 live 大模型生成'],
    targetUser: '目标用户画像待 live 大模型生成',
    painPoint: '行业痛点待 live 大模型生成',
    rebrandIdea: '换皮改造 / 变现卖点建议待 live 大模型生成',
    generatedAt: new Date().toISOString(),
  }
}

/** 剥 ```json 围栏 → JSON.parse（malformed 直接抛）→ 字段类型兜底。generatedAt 现填。 */
export function parseIntroJson(raw: string): IntroDetail {
  const cleaned = raw.trim().replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/```\s*$/, '').trim()
  const o = JSON.parse(cleaned)
  return {
    summary: typeof o.summary === 'string' ? o.summary : '',
    features: Array.isArray(o.features) ? o.features.filter((x: unknown): x is string => typeof x === 'string') : [],
    targetUser: typeof o.targetUser === 'string' ? o.targetUser : '',
    painPoint: typeof o.painPoint === 'string' ? o.painPoint : '',
    rebrandIdea: typeof o.rebrandIdea === 'string' ? o.rebrandIdea : '',
    generatedAt: new Date().toISOString(),
  }
}

/** 返回不合格字段名（空数组=通过）：五个文本字段非空 + features 至少 3 条非空。 */
export function validateIntro(d: IntroDetail): string[] {
  const bad: string[] = []
  if (!d.summary.trim()) bad.push('summary')
  if (!d.targetUser.trim()) bad.push('targetUser')
  if (!d.painPoint.trim()) bad.push('painPoint')
  if (!d.rebrandIdea.trim()) bad.push('rebrandIdea')
  if (!Array.isArray(d.features) || d.features.filter((x) => x.trim()).length < 3) bad.push('features')
  return bad
}
```

- [ ] **Step 4: 追加 index 导出** — `packages/scout/src/index.ts` 末尾加：

```ts
export * from './intro'
```

- [ ] **Step 5: 跑测试确认通过**

Run: `corepack pnpm --filter @forgecast/scout test intro`
Expected: PASS（7 个用例全绿）

- [ ] **Step 6: 提交**

```bash
git add packages/scout/src/intro.ts packages/scout/src/index.ts packages/scout/test/intro.test.ts
git commit -m "feat(scout): 候选详情纯 helper heuristicIntro/parseIntroJson/validateIntro"
```

---

## Task 2: scout `generateCandidateIntro` + prompt 模板

**Files:**
- Modify: `packages/scout/src/intro.ts`（追加 `generateCandidateIntro`）
- Create: `templates/prompts/candidate-intro.md`
- Test: `packages/scout/test/intro.test.ts`（追加 describe）

**Interfaces:**
- Consumes: `CoreCtx` from `@forgecast/core`；`createGithubClient` from `./github`（`gh.fetchReadme(repo): Promise<string>`）；本文件的 `heuristicIntro`/`parseIntroJson`/`validateIntro`/`IntroDetail`。ctx 含 `ctx.config.llm.mode`（'mock'|'live'）、`ctx.config.llm.models.analysis`、`ctx.config.paths.templates`、`ctx.config.github`、`ctx.llm.complete({model,system,prompt})`、`ctx.db`。
- Produces: `generateCandidateIntro(ctx: CoreCtx, id: number): Promise<IntroDetail>`（候选不存在 throw；mock→heuristicIntro；live→抓 README+LLM+parse；校验不过 throw）。

- [ ] **Step 1: 写失败测试** — 追加到 `packages/scout/test/intro.test.ts`

```ts
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createLlmClient, loadConfig, openDb, type CoreCtx } from '@forgecast/core'
import { vi } from 'vitest'
import { generateCandidateIntro } from '../src/intro'

function seedCandidate(ctx: CoreCtx) {
  ctx.db.prepare("INSERT INTO candidates (repo,url,description,license_ok,status) VALUES ('a/adminlte','u','后台模板',1,'candidate')")
    .run()
  return (ctx.db.prepare("SELECT id FROM candidates WHERE repo='a/adminlte'").get() as any).id as number
}

describe('generateCandidateIntro', () => {
  it('mock 模式走 heuristicIntro，结构合法', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-intro-'))
    const config = loadConfig(root, {}) // mock
    const ctx: CoreCtx = { db: openDb(config.paths.db), config, llm: createLlmClient(config.llm) }
    const id = seedCandidate(ctx)
    const d = await generateCandidateIntro(ctx, id)
    expect(validateIntro(d)).toEqual([])
    expect(d.features.length).toBeGreaterThanOrEqual(3)
  })

  it('live 模式调 LLM 解析 JSON 并通过校验', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-intro2-'))
    const config = loadConfig(root, { FORGECAST_LLM_MODE: 'live', FORGECAST_LLM_KEY: 'k' })
    const llm = { complete: vi.fn(async () => '```json\n{"summary":"AdminLTE 是后台模板","features":["数据看板","权限管理","响应式布局"],"targetUser":"中小团队后台","painPoint":"自研后台成本高","rebrandIdea":"换 logo 卖给行业客户"}\n```') }
    const ctx: CoreCtx = { db: openDb(config.paths.db), config, llm: llm as any }
    const id = seedCandidate(ctx)
    const d = await generateCandidateIntro(ctx, id)
    expect(d.summary).toBe('AdminLTE 是后台模板')
    expect(d.features).toHaveLength(3)
    expect(llm.complete).toHaveBeenCalledOnce()
    expect(validateIntro(d)).toEqual([])
  })

  it('live LLM 返回缺字段 → 校验抛错（不返脏数据）', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-intro3-'))
    const config = loadConfig(root, { FORGECAST_LLM_MODE: 'live', FORGECAST_LLM_KEY: 'k' })
    const llm = { complete: vi.fn(async () => '{"summary":"只有简介"}') }
    const ctx: CoreCtx = { db: openDb(config.paths.db), config, llm: llm as any }
    const id = seedCandidate(ctx)
    await expect(generateCandidateIntro(ctx, id)).rejects.toThrow(/缺字段/)
  })

  it('候选不存在 → 抛错', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-intro4-'))
    const config = loadConfig(root, {})
    const ctx: CoreCtx = { db: openDb(config.paths.db), config, llm: createLlmClient(config.llm) }
    await expect(generateCandidateIntro(ctx, 999)).rejects.toThrow(/候选不存在/)
  })
})
```

> 注：`loadConfig(root, {})` 无 GitHub token → `createGithubClient` 返回 mock（`fetchReadme` 对未知 repo 返空串），live 用例的 README 内容不影响（llm 被 mock）。`ctx.config.paths.templates` 指向仓库 `templates/`，模板文件在 Step 3 落盘。

- [ ] **Step 2: 跑测试确认失败**

Run: `corepack pnpm --filter @forgecast/scout test intro`
Expected: FAIL（`generateCandidateIntro` 未导出）

- [ ] **Step 3: 建 prompt 模板** — `templates/prompts/candidate-intro.md`

```markdown
你是开源项目产品分析专家。基于下面的项目信息，产出一份面向"想把它换皮成中国中小老板付费产品"的产品说明书。

严格只输出如下 JSON（不要多余文字、不要 markdown 说明）：
{
  "summary": "一段话产品介绍，2-4 句，说清它是什么、解决什么",
  "features": ["核心功能名 + 一句作用", "…3 到 8 条…"],
  "targetUser": "目标用户画像，一到两句（行业 + 规模 + 使用场景）",
  "painPoint": "它解决的行业痛点，一到两句，点明现状成本",
  "rebrandIdea": "换皮改造 / 变现卖点建议，一到两句"
}

要求：features 为字符串数组，3 到 8 条；所有字段用中文；不得编造项目没有的功能。
```

- [ ] **Step 4: 实现 `generateCandidateIntro`（追加到 `packages/scout/src/intro.ts`）**

在文件顶部补 import：

```ts
import fs from 'node:fs'
import path from 'node:path'
import type { CoreCtx } from '@forgecast/core'
import { createGithubClient } from './github'
```

在文件末尾追加：

```ts
/** 生成候选详情：读候选元数据 → mock 走 heuristicIntro / live 抓 README+LLM → 校验。候选不存在或校验不过则抛。 */
export async function generateCandidateIntro(ctx: CoreCtx, id: number): Promise<IntroDetail> {
  const row = ctx.db.prepare(
    'SELECT repo, url, description, license, stars, last_commit FROM candidates WHERE id = ?',
  ).get(id) as { repo: string; url: string; description: string | null; license: string | null; stars: number | null; last_commit: string | null } | undefined
  if (!row) throw new Error(`候选不存在: ${id}`)
  const meta: RepoMeta = {
    repo: row.repo, url: row.url, description: row.description,
    license: row.license, stars: row.stars ?? 0, lastCommit: row.last_commit, topics: [],
  }
  const gh = createGithubClient(ctx.config.github)
  const readme = await gh.fetchReadme(row.repo)

  let intro: IntroDetail
  if (ctx.config.llm.mode === 'mock') {
    intro = heuristicIntro(meta, readme)
  } else {
    const tpl = fs.readFileSync(path.join(ctx.config.paths.templates, 'prompts', 'candidate-intro.md'), 'utf8')
    const system = '你是开源项目产品分析专家，只输出给定 JSON 结构，不要多余文字。'
    const prompt = [
      tpl,
      `项目：${meta.repo}（stars: ${meta.stars}）`,
      `GitHub 简介：${meta.description ?? ''}`,
      `README：\n${readme.slice(0, 8000)}`,
    ].join('\n\n---\n\n')
    intro = parseIntroJson(await ctx.llm.complete({ model: ctx.config.llm.models.analysis, system, prompt }))
  }
  const bad = validateIntro(intro)
  if (bad.length) throw new Error(`详情生成结果缺字段: ${bad.join('、')}`)
  return intro
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `corepack pnpm --filter @forgecast/scout test intro`
Expected: PASS（含新增 4 个 generateCandidateIntro 用例）

- [ ] **Step 6: 提交**

```bash
git add packages/scout/src/intro.ts packages/scout/test/intro.test.ts templates/prompts/candidate-intro.md
git commit -m "feat(scout): generateCandidateIntro 读 README→LLM 生成详情 + prompt 模板"
```

---

## Task 3: DB 迁移 + server 详情路由 + 列表去 intro_detail

**Files:**
- Modify: `packages/core/src/db.ts`（加迁移列）
- Modify: `packages/server/src/app.ts`（新路由 + 列表 SELECT）
- Test: `packages/server/test/intro.test.ts`

**Interfaces:**
- Consumes: `generateCandidateIntro` from `@forgecast/scout`。
- Produces: `POST /api/candidates/:id/intro`，请求体 `{ force?: boolean }`，响应 `{ mode: 'mock' }` 或 `{ mode: 'live', cached: boolean, intro: IntroDetail }`（错误 `{ error }` + 404/500）。

- [ ] **Step 1: 写失败测试** — `packages/server/test/intro.test.ts`

```ts
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'
import { loadConfig, openDb, type CoreCtx } from '@forgecast/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../src/app'
import { createTaskQueue } from '../src/tasks'

function mkCtx(env: Record<string, string>, llm?: any): { ctx: CoreCtx; id: number } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-sintro-'))
  const config = loadConfig(root, env)
  const ctx: CoreCtx = { db: openDb(config.paths.db), config, llm: llm ?? { complete: async () => '' } }
  ctx.db.prepare("INSERT INTO candidates (repo,url,description,license_ok,status) VALUES ('a/adminlte','u','后台模板',1,'candidate')").run()
  const id = (ctx.db.prepare("SELECT id FROM candidates WHERE repo='a/adminlte'").get() as any).id
  return { ctx, id }
}
const GOOD = '```json\n{"summary":"AdminLTE 后台模板","features":["看板","权限","布局"],"targetUser":"中小团队","painPoint":"自研贵","rebrandIdea":"换 logo 卖"}\n```'
const H = { 'content-type': 'application/json' } // 带 body 的 POST 显式给 content-type，确保 c.req.json() 解析 force

describe('POST /api/candidates/:id/intro', () => {
  it('mock 模式 → {mode:mock} 且不写 intro_detail', async () => {
    const { ctx, id } = mkCtx({}) // mock
    const app = createApp(ctx, createTaskQueue())
    const r = await (await app.request(`/api/candidates/${id}/intro`, { method: 'POST', headers: H, body: '{}' })).json() as any
    expect(r.mode).toBe('mock')
    expect((ctx.db.prepare('SELECT intro_detail FROM candidates WHERE id=?').get(id) as any).intro_detail).toBeNull()
  })

  it('live 首次 → 生成、写库、返 cached:false', async () => {
    const llm = { complete: vi.fn(async () => GOOD) }
    const { ctx, id } = mkCtx({ FORGECAST_LLM_MODE: 'live', FORGECAST_LLM_KEY: 'k' }, llm)
    const app = createApp(ctx, createTaskQueue())
    const r = await (await app.request(`/api/candidates/${id}/intro`, { method: 'POST', headers: H, body: '{}' })).json() as any
    expect(r.mode).toBe('live'); expect(r.cached).toBe(false); expect(r.intro.summary).toBe('AdminLTE 后台模板')
    expect((ctx.db.prepare('SELECT intro_detail FROM candidates WHERE id=?').get(id) as any).intro_detail).toBeTruthy()
  })

  it('live 有缓存非 force → 返 cached:true 不再调 LLM', async () => {
    const llm = { complete: vi.fn(async () => GOOD) }
    const { ctx, id } = mkCtx({ FORGECAST_LLM_MODE: 'live', FORGECAST_LLM_KEY: 'k' }, llm)
    const app = createApp(ctx, createTaskQueue())
    await app.request(`/api/candidates/${id}/intro`, { method: 'POST', headers: H, body: '{}' }) // 生成一次
    const r = await (await app.request(`/api/candidates/${id}/intro`, { method: 'POST', headers: H, body: '{}' })).json() as any
    expect(r.cached).toBe(true)
    expect(llm.complete).toHaveBeenCalledOnce() // 第二次未再调
  })

  it('force → 即使有缓存也重生成', async () => {
    const llm = { complete: vi.fn(async () => GOOD) }
    const { ctx, id } = mkCtx({ FORGECAST_LLM_MODE: 'live', FORGECAST_LLM_KEY: 'k' }, llm)
    const app = createApp(ctx, createTaskQueue())
    await app.request(`/api/candidates/${id}/intro`, { method: 'POST', headers: H, body: '{}' })
    const r = await (await app.request(`/api/candidates/${id}/intro`, { method: 'POST', headers: H, body: JSON.stringify({ force: true }) })).json() as any
    expect(r.cached).toBe(false)
    expect(llm.complete).toHaveBeenCalledTimes(2)
  })

  it('未知 id → 404', async () => {
    const { ctx } = mkCtx({})
    const app = createApp(ctx, createTaskQueue())
    const res = await app.request('/api/candidates/99999/intro', { method: 'POST', headers: H, body: '{}' })
    expect(res.status).toBe(404)
  })
})

describe('GET /api/candidates 不返 intro_detail', () => {
  it('列表项无 intro_detail 字段', async () => {
    const { ctx, id } = mkCtx({ FORGECAST_LLM_MODE: 'live', FORGECAST_LLM_KEY: 'k' }, { complete: async () => GOOD })
    ctx.db.prepare('UPDATE candidates SET intro_detail = ? WHERE id = ?').run('{"summary":"x"}', id)
    const app = createApp(ctx, createTaskQueue())
    const rows = await (await app.request('/api/candidates')).json() as any[]
    expect(rows.length).toBeGreaterThan(0)
    expect('intro_detail' in rows[0]).toBe(false)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `corepack pnpm --filter @forgecast/server test intro`
Expected: FAIL（路由不存在 → 404/无 mode；列表仍含 intro_detail）

- [ ] **Step 3: 加 DB 迁移列** — `packages/core/src/db.ts`，在 `ensureColumn(db, 'candidates', 'description', 'TEXT')` 下一行加：

```ts
  // 迁移：候选详情/产品说明书缓存列（新库已含，此为兼容旧库）
  ensureColumn(db, 'candidates', 'intro_detail', 'TEXT')
```

- [ ] **Step 4: 列表 SELECT 改显式列（去 intro_detail）** — `packages/server/src/app.ts` 的 `GET /api/candidates`：

```ts
  app.get('/api/candidates', (c) => {
    return c.json(ctx.db.prepare(
      'SELECT id, repo, url, license, license_ok, stars, last_commit, tech_stack, description, score, score_detail, status, created_at FROM candidates ORDER BY license_ok DESC, (score IS NULL), score DESC',
    ).all())
  })
```

- [ ] **Step 5: 加详情路由** — `packages/server/src/app.ts`，在 `app.post('/api/candidates/:id/rescore', …)` 之后加：

```ts
  app.post('/api/candidates/:id/intro', async (c) => {
    const id = Number(c.req.param('id'))
    if (!Number.isInteger(id)) return c.json({ error: '非法 id' }, 400)
    const row = ctx.db.prepare('SELECT intro_detail FROM candidates WHERE id = ?').get(id) as { intro_detail: string | null } | undefined
    if (!row) return c.json({ error: '候选不存在' }, 404)
    // mock 模式不生成（详情需 live 大模型），前端据此提示切 live
    if (ctx.config.llm.mode === 'mock') return c.json({ mode: 'mock' })
    const { force } = await c.req.json().catch(() => ({}))
    if (row.intro_detail && !force) {
      try { return c.json({ mode: 'live', cached: true, intro: JSON.parse(row.intro_detail) }) } catch { /* 坏缓存 → 落到重生成 */ }
    }
    try {
      const intro = await generateCandidateIntro(ctx, id)
      ctx.db.prepare('UPDATE candidates SET intro_detail = ? WHERE id = ?').run(JSON.stringify(intro), id)
      return c.json({ mode: 'live', cached: false, intro })
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500)
    }
  })
```

补 import：`packages/server/src/app.ts` 顶部的 scout import 追加 `generateCandidateIntro`：

```ts
import { addRepo, backfillCategories, candidatesNeedingRescore, generateCandidateIntro, pickCandidate, rescoreCandidate, scoutCandidates } from '@forgecast/scout'
```

- [ ] **Step 6: 跑测试确认通过**

Run: `corepack pnpm --filter @forgecast/server test intro`
Expected: PASS（6 个用例全绿）

- [ ] **Step 7: 跑 server + scout 全量确认无回归**

Run: `corepack pnpm --filter @forgecast/server test && corepack pnpm --filter @forgecast/scout test`
Expected: PASS（全绿）

- [ ] **Step 8: 提交**

```bash
git add packages/core/src/db.ts packages/server/src/app.ts packages/server/test/intro.test.ts
git commit -m "feat(server): POST /api/candidates/:id/intro 详情生成缓存 + 迁移 intro_detail 列 + 列表精简"
```

---

## Task 4: 前端弹窗（详情按钮 + Modal + BoardPage 接线）

**Files:**
- Modify: `apps/web/src/api.ts`
- Modify: `apps/web/src/pages/board/CandidateCard.tsx`
- Create: `apps/web/src/pages/board/CandidateDetailModal.tsx`
- Modify: `apps/web/src/pages/BoardPage.tsx`

**Interfaces:**
- Consumes: `api<T>(path, init)` from `../../api`；`Candidate` 类型；后端 `POST /api/candidates/:id/intro` 契约。
- Produces:
  - `api.ts`：`interface IntroDetail { summary; features: string[]; targetUser; painPoint; rebrandIdea; generatedAt }`；`type IntroResponse = { mode: 'mock' } | { mode: 'live'; cached: boolean; intro: IntroDetail }`
  - `CandidateCard` 新 prop `onOpenDetail: (c: Candidate) => void`；导出 `parseDetail`、`Bar`、`DIMS` 供弹窗复用。
  - `CandidateDetailModal` 默认导出组件 `{ candidate: Candidate; onClose: () => void }`。

> 前端无单测（同 A/C 惯例，靠主控里程碑真跑）。本 Task 的验证 = `web build` 通过 + Step 5 浏览器走查。

- [ ] **Step 1: api.ts 加类型** — `apps/web/src/api.ts`，在 `TaskEvent` 定义附近加：

```ts
export interface IntroDetail {
  summary: string; features: string[]; targetUser: string
  painPoint: string; rebrandIdea: string; generatedAt: string
}
export type IntroResponse = { mode: 'mock' } | { mode: 'live'; cached: boolean; intro: IntroDetail }
```

- [ ] **Step 2: CandidateCard 加详情按钮并导出复用件** — `apps/web/src/pages/board/CandidateCard.tsx`

将 `const DIMS`、`function parseDetail`、`function Bar` 的声明前加 `export`（改为 `export const DIMS`、`export function parseDetail`、`export function Bar`；`Detail` 接口也加 `export`）。给组件 props 增加 `onOpenDetail`，并在底部按钮行加「详情」按钮：

props 签名改为：

```tsx
export default function CandidateCard({ c, rank, onPick, onRescore, onOpenDetail, picking, rescoring }: {
  c: Candidate; rank: number
  onPick: (repo: string) => void; onRescore: (id: number) => void; onOpenDetail: (c: Candidate) => void
  picking: boolean; rescoring: boolean
}) {
```

底部按钮行（`重新评分` 按钮之后）加：

```tsx
        <button className="rounded border px-2 py-1 text-xs text-blue-600 disabled:opacity-50"
          onClick={() => onOpenDetail(c)}>详情</button>
```

- [ ] **Step 3: 建弹窗组件** — `apps/web/src/pages/board/CandidateDetailModal.tsx`

```tsx
import { useEffect, useState } from 'react'
import { api, type Candidate, type IntroResponse } from '../../api'
import { Bar, DIMS, parseDetail } from './CandidateCard'

export default function CandidateDetailModal({ candidate, onClose }: { candidate: Candidate; onClose: () => void }) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [res, setRes] = useState<IntroResponse | null>(null)
  const d = parseDetail(candidate.score_detail)

  async function load(force: boolean) {
    setLoading(true); setError(null); setRes(null)
    try {
      const r = await api<IntroResponse>(`/api/candidates/${candidate.id}/intro`, {
        method: 'POST', body: JSON.stringify({ force }),
      })
      setRes(r)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setLoading(false) }
  }

  useEffect(() => { load(false) /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [candidate.id])
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [onClose])

  const intro = res && res.mode === 'live' ? res.intro : null

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4" onClick={onClose}>
      <div className="mt-8 w-full max-w-2xl rounded-lg bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-baseline gap-2 border-b pb-2">
          <a className="font-semibold text-blue-600" href={candidate.url} target="_blank" rel="noreferrer">{candidate.repo}</a>
          <span className="rounded bg-green-50 px-1.5 py-0.5 text-xs text-green-700">{candidate.license ?? '—'}</span>
          {d?.category && d.category !== '其它' && (
            <span className="rounded bg-indigo-50 px-1.5 py-0.5 text-xs text-indigo-700">{d.category}</span>
          )}
          <button className="ml-auto text-neutral-400 hover:text-neutral-700" onClick={onClose}>✕</button>
        </div>

        {loading && <div className="py-10 text-center text-sm text-neutral-400">生成中…（读 README + 大模型，约数秒）</div>}

        {!loading && error && (
          <div className="py-8 text-center">
            <div className="text-sm text-red-600">生成失败：{error}</div>
            <button className="mt-3 rounded border px-3 py-1 text-sm" onClick={() => load(false)}>重试</button>
          </div>
        )}

        {!loading && res?.mode === 'mock' && (
          <div className="py-8 text-center text-sm text-neutral-500">
            详细介绍需 live 大模型生成。请先到「设置」把大模型切到 live 并填 key。
          </div>
        )}

        {!loading && intro && (
          <div className="space-y-4 py-3 text-sm">
            <section>
              <h3 className="mb-1 font-medium text-neutral-800">产品简介</h3>
              <p className="text-neutral-600">{intro.summary}</p>
            </section>
            <section>
              <h3 className="mb-1 font-medium text-neutral-800">核心功能</h3>
              <ul className="list-disc space-y-0.5 pl-5 text-neutral-600">
                {intro.features.map((f, i) => <li key={i}>{f}</li>)}
              </ul>
            </section>
            <section>
              <h3 className="mb-1 font-medium text-neutral-800">目标用户</h3>
              <p className="text-neutral-600">{intro.targetUser}</p>
            </section>
            <section>
              <h3 className="mb-1 font-medium text-neutral-800">行业痛点</h3>
              <p className="text-neutral-600">{intro.painPoint}</p>
            </section>
            <section>
              <h3 className="mb-1 font-medium text-neutral-800">换皮卖点</h3>
              <p className="text-neutral-600">{intro.rebrandIdea}</p>
            </section>
            {d && (
              <section className="border-t pt-3">
                <h3 className="mb-1 font-medium text-neutral-800">评分</h3>
                <div className="space-y-1">
                  {DIMS.map((dim) => <Bar key={dim.key} label={dim.label} value={d[dim.key]} max={dim.max} />)}
                </div>
                {d.rationale && <p className="mt-1 text-xs text-neutral-500">💡 {d.rationale}</p>}
              </section>
            )}
            <div className="flex items-center gap-3 border-t pt-2 text-xs text-neutral-400">
              <span>生成于 {new Date(intro.generatedAt).toLocaleString()}{res.cached ? '（缓存）' : ''}</span>
              <button className="ml-auto rounded border px-2 py-1 text-neutral-600" onClick={() => load(true)}>重新生成</button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
```

- [ ] **Step 4: BoardPage 接线** — `apps/web/src/pages/BoardPage.tsx`

顶部 import 加：

```tsx
import CandidateDetailModal from './board/CandidateDetailModal'
```

在 `const [cat, setCat] = useState<string | null>(null)` 附近加：

```tsx
  const [detailOf, setDetailOf] = useState<Candidate | null>(null)
```

给网格里的 `CandidateCard` 传 `onOpenDetail`：

```tsx
          <CandidateCard key={c.id} c={c} rank={i + 1}
            onPick={(repo) => pick.mutate(repo)} onRescore={(id) => rescore.mutate(id)}
            onOpenDetail={setDetailOf}
            picking={pickingRepos.has(c.repo)} rescoring={rescoringIds.has(c.id)} />
```

在最外层 `</div>` 之前（`StageLanes` 之后）加：

```tsx
      {detailOf && <CandidateDetailModal candidate={detailOf} onClose={() => setDetailOf(null)} />}
```

- [ ] **Step 5: 构建确认 + 浏览器走查里程碑**

Run: `corepack pnpm --filter web build`
Expected: 构建通过（无 TS 报错）。

主控里程碑（在合并前由控制器执行，需 live DeepSeek）：看板点某卡片「详情」→ 弹窗「生成中」→ 生成 5 段（简介/功能/目标用户/痛点/换皮卖点）+ 评分区 → 点「重新生成」覆盖 → 关弹窗；把 LLM 切回 mock 点详情 → 显示「需 live」提示。

- [ ] **Step 6: 提交**

```bash
git add apps/web/src/api.ts apps/web/src/pages/board/CandidateCard.tsx apps/web/src/pages/board/CandidateDetailModal.tsx apps/web/src/pages/BoardPage.tsx
git commit -m "feat(web): 候选详情弹窗（产品说明书）+ 卡片详情按钮 + 重新生成"
```

---

## 收尾

- 全量测试：`corepack pnpm --filter @forgecast/scout test && corepack pnpm --filter @forgecast/server test && corepack pnpm --filter web build`。
- README 维护：本功能为看板 UI 增强 + 内部接口，无新 CLI / 环境变量；README 现无 Web 功能清单章节，**无需改动**（同 C）。设计已在 `docs/superpowers/specs/`。
- 整分支 review → 合并到 main。
