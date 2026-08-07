# 定制项目板块（tailor）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增定制项目板块：客户需求（手动录入/询单转入）→ LLM 拆能力清单（可编辑）→ 逐能力 GitHub 搜轮子 + 规则评分 → 人工决策选型 → 生成拼装方案书 `workspace/tailor/<id>/proposal.md`。

**Architecture:** 新包 `packages/tailor`（依赖 core + scout），三张新 SQLite 表（tailor_requests / tailor_capabilities / tailor_wheels），scout 的 GithubClient 加 `searchByKeywords`，server 加 `/api/tailor` 系列路由（长任务走现有 TaskQueue+SSE），web 加 TailorPage 列表 + TailorDetailPage 详情。两个新 LLM capability（拆解/方案书）各带自己的 mock——绝不走 ctx.llm 的文案 fixture。

**Tech Stack:** 全部现有：TypeScript + better-sqlite3 + Hono + vitest + React + react-query + react-markdown。无新第三方依赖。

**Spec:** `docs/superpowers/specs/2026-08-08-tailor-blocks-design.md` §2-§4
**前置:** 界面重组计划（`2026-08-08-blocks-ui-reorg.md`）已执行完——`/tailor` 路由与 TailorPage 占位壳已存在。

## Global Constraints

- **mock 红线**：每个 LLM capability 必须自带 mock 分支（`ctx.config.llm.mode === 'mock'` 时走确定性启发式函数），绝不在 mock 模式调 `ctx.llm.complete`（它返回文案 fixture，会产出垃圾数据）。GitHub 同理走 `cfg.mode === 'mock'` fixture。
- 状态机：`draft → decomposed → searched → proposed`；未拆解不能搜轮子（400），有 pending 决策不能出方案书（400）。
- 每个后端任务 TDD：先写失败测试再实现；测试命令 `pnpm --filter @forgecast/<pkg> test`。
- web 无单测：验证 = `pnpm --filter web exec tsc --noEmit` + `pnpm --filter web build`。
- 代码注释中文、说明约束而非复述代码，跟随各文件现有风格。
- commit message 末尾带 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`。

---

### Task 1: 数据库三张 tailor 表

**Files:**
- Modify: `packages/core/src/db.ts`（`db.exec` 的建表 SQL 串里追加三张表）
- Test: `packages/core/test/db.test.ts`（追加用例）

**Interfaces:**
- Produces: 表 `tailor_requests(id, title, raw_need, lead_id, status default 'draft', proposal_path, created_at)`、`tailor_capabilities(id, request_id, name, detail, keywords, decision default 'pending', chosen_repo, sort)`、`tailor_wheels(id, capability_id, repo, url, license, license_ok, stars, last_commit, description, score, score_detail)`。后续所有任务依赖这些列名。

- [ ] **Step 1: 写失败测试（追加到 db.test.ts）**

```ts
it('tailor 三表存在且可重开（幂等）', () => {
  // 沿用本文件现有的临时目录 openDb 方式建 db
  for (const t of ['tailor_requests', 'tailor_capabilities', 'tailor_wheels']) {
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t)
    expect(row, t).toBeTruthy()
  }
  const r = db.prepare("INSERT INTO tailor_requests (title, raw_need) VALUES ('t','n')").run()
  expect(db.prepare('SELECT status FROM tailor_requests WHERE id=?').get(r.lastInsertRowid)).toEqual({ status: 'draft' })
})
```
（打开方式、临时目录、重开断言照抄该文件现有用例的写法。）

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @forgecast/core test`
Expected: FAIL（表不存在）

- [ ] **Step 3: 实现——db.ts 建表 SQL 追加**

在 `CREATE TABLE IF NOT EXISTS settings` 之前追加：

```sql
CREATE TABLE IF NOT EXISTS tailor_requests (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  raw_need TEXT NOT NULL,
  lead_id INTEGER REFERENCES leads(id),
  status TEXT DEFAULT 'draft',
  proposal_path TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS tailor_capabilities (
  id INTEGER PRIMARY KEY,
  request_id INTEGER REFERENCES tailor_requests(id),
  name TEXT NOT NULL,
  detail TEXT,
  keywords TEXT,
  decision TEXT DEFAULT 'pending',
  chosen_repo TEXT,
  sort INTEGER
);
CREATE TABLE IF NOT EXISTS tailor_wheels (
  id INTEGER PRIMARY KEY,
  capability_id INTEGER REFERENCES tailor_capabilities(id),
  repo TEXT NOT NULL, url TEXT NOT NULL,
  license TEXT, license_ok INTEGER,
  stars INTEGER, last_commit TEXT, description TEXT,
  score REAL, score_detail TEXT
);
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @forgecast/core test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/db.ts packages/core/test/db.test.ts
git commit -m "feat(core): tailor 三表(需求/能力清单/轮子候选)"
```

---

### Task 2: GithubClient.searchByKeywords

**Files:**
- Modify: `packages/scout/src/github.ts`
- Test: `packages/scout/test/github.test.ts`（追加 describe）

**Interfaces:**
- Produces: `GithubClient` 接口新增 `searchByKeywords(keywords: string[], opts: { perPage: number }): Promise<RepoMeta[]>`。mock 返回 candidateFixtures 前 perPage 条；live 关键词拼一个 q 全文搜、**失败抛错**（与 searchRepos 的单 topic 静默跳过不同——tailor 需要按能力项隔离失败并展示原因）。

- [ ] **Step 1: 写失败测试**

```ts
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @forgecast/scout test`
Expected: FAIL（searchByKeywords 不存在，TS 编译错也算失败）

- [ ] **Step 3: 实现**

接口加一行：

```ts
export interface GithubClient {
  searchRepos(topics: string[], opts: SearchOpts): Promise<RepoMeta[]>
  /** 按关键词全文搜（tailor 找轮子用）：失败抛错（调用方按能力项隔离失败），searchRepos 则是静默跳过 */
  searchByKeywords(keywords: string[], opts: { perPage: number }): Promise<RepoMeta[]>
  fetchReadme(repo: string): Promise<string>
  fetchTree(repo: string): Promise<string[]>
}
```

mock 分支加：

```ts
async searchByKeywords(_keywords, opts) {
  return candidateFixtures.slice(0, opts.perPage).map((f) => ({
    repo: f.repo, url: f.url, description: f.description, license: f.license,
    stars: f.stars, lastCommit: f.lastCommit, topics: f.topics,
  }))
},
```

live 分支加：

```ts
async searchByKeywords(keywords, opts) {
  const q = keywords.filter(Boolean).join(' ')
  if (!q) return []
  const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=stars&per_page=${opts.perPage}`
  const res = await fetchImpl(url, { headers })
  if (!res.ok) {
    const hint = res.status === 403 || res.status === 429 ? '（GitHub 搜索限流：配 token 或稍后重搜）' : ''
    throw new Error(`GitHub 搜索失败 HTTP ${res.status}${hint}`)
  }
  const data: any = await res.json()
  return (data.items ?? []).map((it: any) => ({
    repo: it.full_name, url: it.html_url, description: it.description ?? null,
    license: it.license?.spdx_id ?? null,
    stars: it.stargazers_count ?? 0, lastCommit: it.pushed_at ?? null, topics: it.topics ?? [],
  }))
},
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @forgecast/scout test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/scout/src/github.ts packages/scout/test/github.test.ts
git commit -m "feat(scout): GithubClient.searchByKeywords 关键词搜轮子"
```

---

### Task 3: packages/tailor 脚手架 + types + requests CRUD

**Files:**
- Create: `packages/tailor/package.json`、`packages/tailor/tsconfig.json`、`packages/tailor/src/index.ts`、`packages/tailor/src/types.ts`、`packages/tailor/src/requests.ts`
- Test: `packages/tailor/test/requests.test.ts`

**Interfaces:**
- Consumes: Task 1 的三张表；`CoreCtx`（`@forgecast/core`）
- Produces（后续任务与 server/CLI 全靠这些签名）:
  - `addRequest(ctx, {title, rawNeed, leadId?}): {id: number}`
  - `listRequests(ctx): TailorRequest[]`
  - `getRequestDetail(ctx, id): TailorRequestDetail`（不存在抛错）
  - `addCapability(ctx, requestId, {name, detail?, keywords}): {id: number}`
  - `updateCapability(ctx, capId, patch: CapabilityPatch): void`
  - `deleteCapability(ctx, capId): void`
  - `requestFromLead(ctx, leadId): {id: number}`
  - `parseKeywordsCol(raw: string | null): string[]`
  - 类型 `TailorRequest / TailorWheel / TailorCapabilityView / TailorRequestDetail / DecomposedCapability / CapabilityPatch / TailorStatus / CapabilityDecision`

- [ ] **Step 1: 脚手架**

`packages/tailor/package.json`（照抄 analyst 的样式）：

```json
{
  "name": "@forgecast/tailor",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "scripts": { "test": "vitest run --passWithNoTests" },
  "dependencies": {
    "@forgecast/core": "workspace:*",
    "@forgecast/scout": "workspace:*"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.11",
    "@types/node": "^20.11.0",
    "vitest": "^2.1.0"
  }
}
```

`packages/tailor/tsconfig.json`：

```json
{ "extends": "../../tsconfig.base.json", "include": ["src", "test"] }
```

`packages/tailor/src/index.ts`：

```ts
// @forgecast/tailor — 定制项目板块：需求拆解 → GitHub 找轮子 → 拼装方案书
export * from './types'
export * from './requests'
```

（decompose/score/search/proposal 的 export 行由各自任务追加。）

`packages/tailor/src/types.ts`：

```ts
export type TailorStatus = 'draft' | 'decomposed' | 'searched' | 'proposed'
export type CapabilityDecision = 'pending' | 'wheel' | 'self_build' | 'dropped'

export interface TailorRequest {
  id: number; title: string; raw_need: string; lead_id: number | null
  status: TailorStatus; proposal_path: string | null; created_at: string
}
export interface TailorWheel {
  id: number; capability_id: number; repo: string; url: string
  license: string | null; license_ok: number
  stars: number; last_commit: string | null; description: string | null
  score: number; score_detail: string
}
/** 能力项视图：keywords 已从 JSON 列解出，wheels 按分数倒序 */
export interface TailorCapabilityView {
  id: number; request_id: number; name: string; detail: string | null
  keywords: string[]; decision: CapabilityDecision; chosen_repo: string | null
  sort: number; wheels: TailorWheel[]
}
export interface TailorRequestDetail { request: TailorRequest; capabilities: TailorCapabilityView[] }
/** LLM/启发式拆解的单项产出 */
export interface DecomposedCapability { name: string; detail: string; keywords: string[] }
```

然后 `pnpm install`（让 workspace 认识新包）。

- [ ] **Step 2: 写失败测试 requests.test.ts**

```ts
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createLlmClient, loadConfig, openDb, type CoreCtx } from '@forgecast/core'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  addCapability, addRequest, deleteCapability, getRequestDetail,
  listRequests, requestFromLead, updateCapability,
} from '../src/requests'

let ctx: CoreCtx
beforeEach(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-tailor-'))
  const config = loadConfig(root, {})
  ctx = { db: openDb(config.paths.db), config, llm: createLlmClient(config.llm) }
})

describe('requests CRUD', () => {
  it('addRequest 落库 status=draft，listRequests 倒序', () => {
    const a = addRequest(ctx, { title: 'A', rawNeed: '需求A' })
    addRequest(ctx, { title: 'B', rawNeed: '需求B' })
    const rows = listRequests(ctx)
    expect(rows.length).toBe(2)
    expect(rows[0].title).toBe('B')
    expect(rows[1].id).toBe(a.id)
    expect(rows[1].status).toBe('draft')
  })
  it('title/rawNeed 为空抛错', () => {
    expect(() => addRequest(ctx, { title: ' ', rawNeed: 'x' })).toThrow()
    expect(() => addRequest(ctx, { title: 'x', rawNeed: '' })).toThrow()
  })
  it('getRequestDetail 不存在抛错；能力项带解析后的 keywords 与轮子(按分倒序)', () => {
    expect(() => getRequestDetail(ctx, 999)).toThrow(/不存在/)
    const { id } = addRequest(ctx, { title: 'A', rawNeed: 'n' })
    const cap = addCapability(ctx, id, { name: '登录', keywords: ['oauth', 'login'] })
    ctx.db.prepare("INSERT INTO tailor_wheels (capability_id, repo, url, score, score_detail, license_ok, stars) VALUES (?, 'a/lo', 'u', 40, '{}', 1, 10), (?, 'b/hi', 'u', 80, '{}', 1, 10)")
      .run(cap.id, cap.id)
    const d = getRequestDetail(ctx, id)
    expect(d.capabilities[0].keywords).toEqual(['oauth', 'login'])
    expect(d.capabilities[0].wheels.map((w) => w.repo)).toEqual(['b/hi', 'a/lo'])
  })
  it('updateCapability: decision=wheel 无 chosenRepo 抛错；带上则写入', () => {
    const { id } = addRequest(ctx, { title: 'A', rawNeed: 'n' })
    const cap = addCapability(ctx, id, { name: '登录', keywords: ['oauth'] })
    expect(() => updateCapability(ctx, cap.id, { decision: 'wheel' })).toThrow(/chosenRepo/)
    updateCapability(ctx, cap.id, { decision: 'wheel', chosenRepo: 'a/b' })
    const d = getRequestDetail(ctx, id)
    expect(d.capabilities[0].decision).toBe('wheel')
    expect(d.capabilities[0].chosen_repo).toBe('a/b')
  })
  it('deleteCapability 连带删轮子', () => {
    const { id } = addRequest(ctx, { title: 'A', rawNeed: 'n' })
    const cap = addCapability(ctx, id, { name: 'x', keywords: ['k'] })
    ctx.db.prepare("INSERT INTO tailor_wheels (capability_id, repo, url, score, score_detail) VALUES (?, 'a/b', 'u', 1, '{}')").run(cap.id)
    deleteCapability(ctx, cap.id)
    expect(getRequestDetail(ctx, id).capabilities.length).toBe(0)
    expect((ctx.db.prepare('SELECT COUNT(*) AS n FROM tailor_wheels').get() as any).n).toBe(0)
  })
})

describe('requestFromLead', () => {
  it('intent 为空抛错、不存在抛错、正常转入带 lead_id', () => {
    expect(() => requestFromLead(ctx, 999)).toThrow(/不存在/)
    ctx.db.prepare("INSERT INTO leads (wechat, intent) VALUES ('wx1', '')").run()
    ctx.db.prepare("INSERT INTO leads (wechat, intent) VALUES ('wx2', '想做个宠物店小程序')").run()
    expect(() => requestFromLead(ctx, 1)).toThrow(/intent/)
    const { id } = requestFromLead(ctx, 2)
    const d = getRequestDetail(ctx, id)
    expect(d.request.lead_id).toBe(2)
    expect(d.request.raw_need).toBe('想做个宠物店小程序')
  })
})
```

- [ ] **Step 3: 跑测试确认失败**

Run: `pnpm --filter @forgecast/tailor test`
Expected: FAIL（requests.ts 不存在）

- [ ] **Step 4: 实现 requests.ts**

```ts
import type { CoreCtx } from '@forgecast/core'
import type { CapabilityDecision, TailorCapabilityView, TailorRequest, TailorRequestDetail, TailorWheel } from './types'

/** keywords 列存 JSON 数组；坏数据兜底空数组，不让单行脏数据炸整个接口 */
export function parseKeywordsCol(raw: string | null): string[] {
  try {
    const v = JSON.parse(raw ?? '[]')
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch { return [] }
}

export function addRequest(ctx: CoreCtx, input: { title: string; rawNeed: string; leadId?: number }): { id: number } {
  const title = input.title.trim()
  const rawNeed = input.rawNeed.trim()
  if (!title || !rawNeed) throw new Error('title 与 rawNeed 必填')
  const r = ctx.db.prepare('INSERT INTO tailor_requests (title, raw_need, lead_id) VALUES (?, ?, ?)')
    .run(title, rawNeed, input.leadId ?? null)
  return { id: Number(r.lastInsertRowid) }
}

export function listRequests(ctx: CoreCtx): TailorRequest[] {
  return ctx.db.prepare('SELECT * FROM tailor_requests ORDER BY id DESC').all() as TailorRequest[]
}

export function getRequestDetail(ctx: CoreCtx, id: number): TailorRequestDetail {
  const request = ctx.db.prepare('SELECT * FROM tailor_requests WHERE id = ?').get(id) as TailorRequest | undefined
  if (!request) throw new Error(`定制需求不存在: ${id}`)
  const caps = ctx.db.prepare('SELECT * FROM tailor_capabilities WHERE request_id = ? ORDER BY sort, id').all(id) as any[]
  const capabilities: TailorCapabilityView[] = caps.map((c) => ({
    ...c,
    keywords: parseKeywordsCol(c.keywords),
    wheels: ctx.db.prepare('SELECT * FROM tailor_wheels WHERE capability_id = ? ORDER BY score DESC, id').all(c.id) as TailorWheel[],
  }))
  return { request, capabilities }
}

export function addCapability(ctx: CoreCtx, requestId: number, input: { name: string; detail?: string; keywords: string[] }): { id: number } {
  if (!ctx.db.prepare('SELECT id FROM tailor_requests WHERE id = ?').get(requestId)) throw new Error(`定制需求不存在: ${requestId}`)
  if (!input.name.trim()) throw new Error('name 必填')
  const max = (ctx.db.prepare('SELECT MAX(sort) AS m FROM tailor_capabilities WHERE request_id = ?').get(requestId) as any).m ?? 0
  const r = ctx.db.prepare('INSERT INTO tailor_capabilities (request_id, name, detail, keywords, sort) VALUES (?, ?, ?, ?, ?)')
    .run(requestId, input.name.trim(), input.detail ?? null, JSON.stringify(input.keywords), max + 1)
  return { id: Number(r.lastInsertRowid) }
}

export type CapabilityPatch = Partial<{
  name: string; detail: string; keywords: string[]
  decision: CapabilityDecision; chosenRepo: string | null
}>

export function updateCapability(ctx: CoreCtx, capId: number, patch: CapabilityPatch): void {
  const row = ctx.db.prepare('SELECT * FROM tailor_capabilities WHERE id = ?').get(capId) as { chosen_repo: string | null } | undefined
  if (!row) throw new Error(`能力项不存在: ${capId}`)
  if (patch.decision === 'wheel' && !(patch.chosenRepo ?? row.chosen_repo)) throw new Error('decision=wheel 必须带 chosenRepo')
  const sets: string[] = []
  const vals: unknown[] = []
  if (patch.name !== undefined) { sets.push('name = ?'); vals.push(patch.name) }
  if (patch.detail !== undefined) { sets.push('detail = ?'); vals.push(patch.detail) }
  if (patch.keywords !== undefined) { sets.push('keywords = ?'); vals.push(JSON.stringify(patch.keywords)) }
  if (patch.decision !== undefined) { sets.push('decision = ?'); vals.push(patch.decision) }
  if (patch.chosenRepo !== undefined) { sets.push('chosen_repo = ?'); vals.push(patch.chosenRepo) }
  if (!sets.length) return
  ctx.db.prepare(`UPDATE tailor_capabilities SET ${sets.join(', ')} WHERE id = ?`).run(...vals, capId)
}

export function deleteCapability(ctx: CoreCtx, capId: number): void {
  ctx.db.prepare('DELETE FROM tailor_wheels WHERE capability_id = ?').run(capId)
  ctx.db.prepare('DELETE FROM tailor_capabilities WHERE id = ?').run(capId)
}

/** 询单一键转定制需求：intent 即原始需求文本；空 intent 让用户手动录入而不是造一条空需求 */
export function requestFromLead(ctx: CoreCtx, leadId: number): { id: number } {
  const lead = ctx.db.prepare('SELECT * FROM leads WHERE id = ?').get(leadId) as { wechat: string | null; intent: string | null } | undefined
  if (!lead) throw new Error(`询单不存在: ${leadId}`)
  const rawNeed = (lead.intent ?? '').trim()
  if (!rawNeed) throw new Error('该询单没有意向描述(intent)，请到定制板块手动录入需求')
  return addRequest(ctx, { title: `询单#${leadId} ${lead.wechat ?? ''}`.trim(), rawNeed, leadId })
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm --filter @forgecast/tailor test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/tailor pnpm-lock.yaml
git commit -m "feat(tailor): 包脚手架 + 定制需求/能力清单 CRUD + 询单转入"
```

---

### Task 4: 需求拆解 decompose（LLM capability + mock）

**Files:**
- Create: `packages/tailor/src/decompose.ts`、`templates/prompts/tailor-decompose.md`
- Modify: `packages/tailor/src/index.ts`（加 `export * from './decompose'`）
- Test: `packages/tailor/test/decompose.test.ts`

**Interfaces:**
- Consumes: Task 3 的表数据与 `DecomposedCapability` 类型
- Produces:
  - `heuristicDecompose(rawNeed: string): DecomposedCapability[]`
  - `parseDecomposeJson(raw: string): DecomposedCapability[]`（malformed 抛）
  - `validateDecompose(caps: DecomposedCapability[]): string[]`（空数组=通过）
  - `decomposeRequest(ctx, requestId, opts?: {onProgress?: (m: string) => void}): Promise<{count: number}>`

- [ ] **Step 1: 写失败测试 decompose.test.ts**

```ts
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createLlmClient, loadConfig, openDb, type CoreCtx } from '@forgecast/core'
import { beforeEach, describe, expect, it } from 'vitest'
import { decomposeRequest, heuristicDecompose, parseDecomposeJson, validateDecompose } from '../src/decompose'
import { addRequest, getRequestDetail } from '../src/requests'

let ctx: CoreCtx
beforeEach(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-decomp-'))
  const config = loadConfig(root, {})
  ctx = { db: openDb(config.paths.db), config, llm: createLlmClient(config.llm) }
})

describe('heuristicDecompose', () => {
  it('按句切分出多项，每项 name/keywords 非空', () => {
    const caps = heuristicDecompose('要有微信扫码登录。要能在线预约排队。要有会员储值卡')
    expect(caps.length).toBe(3)
    for (const c of caps) {
      expect(c.name.trim()).not.toBe('')
      expect(c.keywords.length).toBeGreaterThanOrEqual(1)
    }
    expect(validateDecompose(caps)).toEqual([])
  })
  it('极短输入也兜底出 1 项', () => {
    const caps = heuristicDecompose('小程序')
    expect(caps.length).toBe(1)
    expect(validateDecompose(caps)).toEqual([])
  })
})

describe('parseDecomposeJson / validateDecompose', () => {
  it('剥 ```json 围栏解析', () => {
    const raw = '```json\n[{"name":"登录","detail":"d","keywords":["oauth"]}]\n```'
    expect(parseDecomposeJson(raw)).toEqual([{ name: '登录', detail: 'd', keywords: ['oauth'] }])
  })
  it('非数组/malformed 抛错', () => {
    expect(() => parseDecomposeJson('{"name":"x"}')).toThrow()
    expect(() => parseDecomposeJson('not json')).toThrow()
  })
  it('validate: 空清单/缺 name/缺 keywords 被点名', () => {
    expect(validateDecompose([])).toContain('能力项为空')
    expect(validateDecompose([{ name: '', detail: '', keywords: ['k'] }])[0]).toMatch(/name/)
    expect(validateDecompose([{ name: 'x', detail: '', keywords: [] }])[0]).toMatch(/keywords/)
  })
})

describe('decomposeRequest', () => {
  it('mock 模式落库、status→decomposed', async () => {
    const { id } = addRequest(ctx, { title: 'A', rawNeed: '要有微信扫码登录。要能在线预约排队' })
    const r = await decomposeRequest(ctx, id)
    expect(r.count).toBeGreaterThanOrEqual(2)
    const d = getRequestDetail(ctx, id)
    expect(d.request.status).toBe('decomposed')
    expect(d.capabilities.length).toBe(r.count)
  })
  it('重拆清掉旧能力项与旧轮子', async () => {
    const { id } = addRequest(ctx, { title: 'A', rawNeed: '要有登录功能。要有支付功能' })
    await decomposeRequest(ctx, id)
    const capId = getRequestDetail(ctx, id).capabilities[0].id
    ctx.db.prepare("INSERT INTO tailor_wheels (capability_id, repo, url, score, score_detail) VALUES (?, 'a/b', 'u', 1, '{}')").run(capId)
    await decomposeRequest(ctx, id)
    expect((ctx.db.prepare('SELECT COUNT(*) AS n FROM tailor_wheels').get() as any).n).toBe(0)
  })
  it('live 首次返回坏 JSON 会重试一次', async () => {
    const { id } = addRequest(ctx, { title: 'A', rawNeed: 'x需求x' })
    fs.mkdirSync(path.join(ctx.config.paths.templates, 'prompts'), { recursive: true })
    fs.writeFileSync(path.join(ctx.config.paths.templates, 'prompts', 'tailor-decompose.md'), 'tpl')
    ctx.config.llm.mode = 'live'
    let calls = 0
    ctx.llm = { complete: async () => (++calls === 1 ? 'oops not json' : '[{"name":"登录","detail":"d","keywords":["oauth"]}]') }
    const r = await decomposeRequest(ctx, id)
    expect(calls).toBe(2)
    expect(r.count).toBe(1)
  })
  it('需求不存在抛错', async () => {
    await expect(decomposeRequest(ctx, 999)).rejects.toThrow(/不存在/)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @forgecast/tailor test`
Expected: FAIL

- [ ] **Step 3: 实现 decompose.ts + 提示词模板**

`packages/tailor/src/decompose.ts`：

```ts
import fs from 'node:fs'
import path from 'node:path'
import type { CoreCtx } from '@forgecast/core'
import type { DecomposedCapability, TailorRequest } from './types'

/** mock：按行/句确定性切分出能力项占位（离线可测；绝不走 ctx.llm——它返回的是文案 fixture） */
export function heuristicDecompose(rawNeed: string): DecomposedCapability[] {
  const lines = rawNeed.split(/[\n。；;]/).map((s) => s.trim()).filter((s) => s.length >= 4).slice(0, 8)
  const caps = lines.map((line) => ({
    name: line.slice(0, 20),
    detail: `${line}（占位拆解——配好 live 大模型后可生成完整能力说明）`,
    keywords: [line.slice(0, 12)],
  }))
  if (caps.length) return caps
  return [{ name: '核心功能', detail: `${rawNeed.slice(0, 100)}（占位拆解）`, keywords: [rawNeed.slice(0, 12) || '待补充'] }]
}

/** 剥 ```json 围栏 → JSON.parse（malformed/非数组抛）→ 字段类型兜底 */
export function parseDecomposeJson(raw: string): DecomposedCapability[] {
  const cleaned = raw.trim().replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/```\s*$/, '').trim()
  const arr = JSON.parse(cleaned)
  if (!Array.isArray(arr)) throw new Error('拆解结果不是 JSON 数组')
  return arr.map((o: any) => ({
    name: typeof o?.name === 'string' ? o.name : '',
    detail: typeof o?.detail === 'string' ? o.detail : '',
    keywords: Array.isArray(o?.keywords) ? o.keywords.filter((x: unknown): x is string => typeof x === 'string' && !!x.trim()) : [],
  }))
}

/** 返回不合格原因（空数组=通过）：至少 1 项；每项 name 非空 + keywords ≥1 */
export function validateDecompose(caps: DecomposedCapability[]): string[] {
  const bad: string[] = []
  if (!caps.length) bad.push('能力项为空')
  caps.forEach((c, i) => {
    if (!c.name.trim()) bad.push(`第${i + 1}项缺 name`)
    if (!c.keywords.length) bad.push(`第${i + 1}项缺 keywords`)
  })
  return bad
}

/** 拆解需求：覆盖写入能力清单（连带清旧轮子；是否重拆的确认由调用方 UI 负责），status → decomposed。live 解析失败重试一次。 */
export async function decomposeRequest(ctx: CoreCtx, requestId: number, opts: { onProgress?: (m: string) => void } = {}): Promise<{ count: number }> {
  const log = opts.onProgress ?? (() => {})
  const req = ctx.db.prepare('SELECT * FROM tailor_requests WHERE id = ?').get(requestId) as TailorRequest | undefined
  if (!req) throw new Error(`定制需求不存在: ${requestId}`)

  let caps: DecomposedCapability[]
  if (ctx.config.llm.mode === 'mock') {
    log('mock 模式：启发式拆解（配好 live 大模型可得完整拆解）')
    caps = heuristicDecompose(req.raw_need)
  } else {
    const tpl = fs.readFileSync(path.join(ctx.config.paths.templates, 'prompts', 'tailor-decompose.md'), 'utf8')
    const system = '你是软件项目架构师，只输出 JSON 数组，不要多余文字。'
    const prompt = `${tpl}\n\n---\n\n客户需求：\n${req.raw_need}`
    let parsed: DecomposedCapability[] | null = null
    let lastErr: unknown
    for (let attempt = 0; attempt <= 1 && !parsed; attempt++) {
      try {
        parsed = parseDecomposeJson(await ctx.llm.complete({ model: ctx.config.llm.models.analysis, system, prompt }))
      } catch (err) {
        lastErr = err
        if (attempt === 0) log('拆解 JSON 解析失败，重试一次…')
      }
    }
    if (!parsed) throw lastErr
    caps = parsed
  }

  const bad = validateDecompose(caps)
  if (bad.length) throw new Error(`拆解结果不合格: ${bad.join('、')}`)

  ctx.db.transaction(() => {
    ctx.db.prepare('DELETE FROM tailor_wheels WHERE capability_id IN (SELECT id FROM tailor_capabilities WHERE request_id = ?)').run(requestId)
    ctx.db.prepare('DELETE FROM tailor_capabilities WHERE request_id = ?').run(requestId)
    const ins = ctx.db.prepare('INSERT INTO tailor_capabilities (request_id, name, detail, keywords, sort) VALUES (?, ?, ?, ?, ?)')
    caps.forEach((c, i) => ins.run(requestId, c.name.trim(), c.detail, JSON.stringify(c.keywords), i + 1))
    ctx.db.prepare("UPDATE tailor_requests SET status = 'decomposed' WHERE id = ?").run(requestId)
  })()
  log(`拆解出 ${caps.length} 项能力`)
  return { count: caps.length }
}
```

`templates/prompts/tailor-decompose.md`：

```markdown
把客户需求拆解成 3-8 个可独立选型的技术能力项。每项能力应该能在 GitHub 上搜到现成开源实现（轮子）——拆的粒度以"一个成熟开源库/服务能覆盖一项"为准，不要拆到函数级，也不要粗到整个系统一项。

输出 JSON 数组，每项字段：
- name: 能力名，≤20 字，如「微信扫码登录」
- detail: 这项能力具体要做什么、验收标准，一句话
- keywords: 2-4 个 GitHub 搜索关键词，用英文（英文搜索效果远好于中文），如 ["wechat login", "oauth"]

只输出 JSON 数组，不要任何其他文字。
```

`index.ts` 追加 `export * from './decompose'`。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @forgecast/tailor test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/tailor/src templates/prompts/tailor-decompose.md packages/tailor/test/decompose.test.ts
git commit -m "feat(tailor): 需求拆解 decompose(LLM capability + 启发式 mock)"
```

---

### Task 5: 轮子规则评分 score

**Files:**
- Create: `packages/tailor/src/score.ts`
- Modify: `packages/tailor/src/index.ts`（加 `export * from './score'`）
- Test: `packages/tailor/test/score.test.ts`

**Interfaces:**
- Consumes: `RepoMeta`、`isLicenseOk`（均从 `@forgecast/scout` 导入）
- Produces: `wheelScore(meta: RepoMeta, keywords: string[]): { score: number; detail: WheelScoreDetail }`；`WheelScoreDetail = { activity: number; popularity: number; license: number; relevance: number; rationale: string }`。总分 0-100 = 活跃度 0-30 + 热度 0-25 + 协议 0-15 + 命中度 0-30。

- [ ] **Step 1: 写失败测试 score.test.ts**

```ts
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @forgecast/tailor test`
Expected: FAIL

- [ ] **Step 3: 实现 score.ts**

```ts
import { isLicenseOk, type RepoMeta } from '@forgecast/scout'

export interface WheelScoreDetail {
  activity: number   // 0-30 活跃度（last commit 距今）
  popularity: number // 0-25 stars 档位
  license: number    // 0-15 协议（白名单/其他/无）
  relevance: number  // 0-30 关键词命中 repo 名+描述的比例
  rationale: string
}

/** 纯规则打分（量大不烧 LLM：能力数 × 8 轮子）。协议非白名单不打 0——定制场景内部部署可谈，风险在方案书里点名。 */
export function wheelScore(meta: RepoMeta, keywords: string[]): { score: number; detail: WheelScoreDetail } {
  const days = meta.lastCommit ? (Date.now() - new Date(meta.lastCommit).getTime()) / 86400000 : Infinity
  const activity = days < 90 ? 30 : days < 365 ? 20 : days < 730 ? 10 : 0
  const popularity = meta.stars >= 10000 ? 25 : meta.stars >= 1000 ? 20 : meta.stars >= 100 ? 12 : meta.stars > 0 ? 5 : 0
  const license = isLicenseOk(meta.license) ? 15 : meta.license ? 5 : 0
  const hay = `${meta.repo} ${meta.description ?? ''}`.toLowerCase()
  const hits = keywords.filter((k) => k && hay.includes(k.toLowerCase())).length
  const relevance = keywords.length ? Math.round((hits / keywords.length) * 30) : 0
  const score = activity + popularity + license + relevance
  return { score, detail: { activity, popularity, license, relevance, rationale: `活跃${activity}+热度${popularity}+协议${license}+命中${relevance}` } }
}
```

`index.ts` 追加 `export * from './score'`。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @forgecast/tailor test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/tailor/src packages/tailor/test/score.test.ts
git commit -m "feat(tailor): 轮子四维规则评分(活跃/热度/协议/命中)"
```

---

### Task 6: 轮子搜索 search（逐能力、失败隔离）

**Files:**
- Create: `packages/tailor/src/search.ts`
- Modify: `packages/tailor/src/index.ts`（加 `export * from './search'`）
- Test: `packages/tailor/test/search.test.ts`

**Interfaces:**
- Consumes: Task 2 `searchByKeywords`、Task 3 CRUD/`parseKeywordsCol`、Task 5 `wheelScore`、`createGithubClient`/`isLicenseOk`/`GithubClient`（`@forgecast/scout`）
- Produces: `searchWheels(ctx, requestId, opts?: { capabilityId?: number; onProgress?: (m: string) => void; gh?: GithubClient }): Promise<SearchResult>`；`SearchResult = { ok: number; failed: Array<{ capabilityId: number; name: string; error: string }> }`。`opts.gh` 仅测试注入用。

- [ ] **Step 1: 写失败测试 search.test.ts**

```ts
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @forgecast/tailor test`
Expected: FAIL

- [ ] **Step 3: 实现 search.ts**

```ts
import type { CoreCtx } from '@forgecast/core'
import { createGithubClient, isLicenseOk, type GithubClient } from '@forgecast/scout'
import { parseKeywordsCol } from './requests'
import { wheelScore } from './score'

export interface SearchResult { ok: number; failed: Array<{ capabilityId: number; name: string; error: string }> }

/** 逐能力搜轮子并评分入库：单项失败不阻塞其他（failed 记原因，可单独重搜）；有成功项则 status → searched */
export async function searchWheels(ctx: CoreCtx, requestId: number, opts: { capabilityId?: number; onProgress?: (m: string) => void; gh?: GithubClient } = {}): Promise<SearchResult> {
  const log = opts.onProgress ?? (() => {})
  if (!ctx.db.prepare('SELECT id FROM tailor_requests WHERE id = ?').get(requestId)) throw new Error(`定制需求不存在: ${requestId}`)
  const caps = (opts.capabilityId
    ? ctx.db.prepare('SELECT * FROM tailor_capabilities WHERE id = ? AND request_id = ?').all(opts.capabilityId, requestId)
    : ctx.db.prepare('SELECT * FROM tailor_capabilities WHERE request_id = ? ORDER BY sort, id').all(requestId)
  ) as Array<{ id: number; name: string; keywords: string | null }>
  if (!caps.length) throw new Error('该需求还没有能力清单，先拆解需求')

  const gh = opts.gh ?? createGithubClient(ctx.config.github)
  const result: SearchResult = { ok: 0, failed: [] }
  for (const cap of caps) {
    const keywords = parseKeywordsCol(cap.keywords)
    try {
      const repos = await gh.searchByKeywords(keywords, { perPage: 8 })
      ctx.db.transaction(() => {
        ctx.db.prepare('DELETE FROM tailor_wheels WHERE capability_id = ?').run(cap.id)
        const ins = ctx.db.prepare('INSERT INTO tailor_wheels (capability_id, repo, url, license, license_ok, stars, last_commit, description, score, score_detail) VALUES (?,?,?,?,?,?,?,?,?,?)')
        for (const m of repos) {
          const { score, detail } = wheelScore(m, keywords)
          ins.run(cap.id, m.repo, m.url, m.license, isLicenseOk(m.license) ? 1 : 0, m.stars, m.lastCommit, m.description, score, JSON.stringify(detail))
        }
      })()
      result.ok++
      log(`✔ ${cap.name}: ${repos.length} 个候选轮子`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      result.failed.push({ capabilityId: cap.id, name: cap.name, error: msg })
      log(`✖ ${cap.name}: ${msg}`)
    }
    // live 限速间隔：未鉴权的 GitHub 搜索 API 每分钟 10 次，连续打必 429
    if (ctx.config.github.mode === 'live') await new Promise((r) => setTimeout(r, 800))
  }
  if (result.ok > 0) ctx.db.prepare("UPDATE tailor_requests SET status = 'searched' WHERE id = ?").run(requestId)
  return result
}
```

`index.ts` 追加 `export * from './search'`。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @forgecast/tailor test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/tailor/src packages/tailor/test/search.test.ts
git commit -m "feat(tailor): 逐能力搜轮子(失败隔离/单项重搜/协议标记/评分入库)"
```

---

### Task 7: 方案书生成 proposal（LLM capability + mock）

**Files:**
- Create: `packages/tailor/src/proposal.ts`、`templates/prompts/tailor-proposal.md`
- Modify: `packages/tailor/src/index.ts`（加 `export * from './proposal'`）
- Test: `packages/tailor/test/proposal.test.ts`

**Interfaces:**
- Consumes: Task 3 `getRequestDetail`
- Produces: `renderProposalMock(detail: TailorRequestDetail): string`；`generateProposal(ctx, requestId, opts?: {onProgress?: (m: string) => void}): Promise<{ path: string }>`（path 为相对 workspace 的 `tailor/<id>/proposal.md`）

- [ ] **Step 1: 写失败测试 proposal.test.ts**

```ts
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createLlmClient, loadConfig, openDb, type CoreCtx } from '@forgecast/core'
import { beforeEach, describe, expect, it } from 'vitest'
import { generateProposal, renderProposalMock } from '../src/proposal'
import { addCapability, addRequest, getRequestDetail, updateCapability } from '../src/requests'

let ctx: CoreCtx
beforeEach(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-prop-'))
  const config = loadConfig(root, {})
  ctx = { db: openDb(config.paths.db), config, llm: createLlmClient(config.llm) }
})

function seedDecided(): number {
  const { id } = addRequest(ctx, { title: '宠物店小程序', rawNeed: '要登录和支付' })
  const a = addCapability(ctx, id, { name: '登录', keywords: ['oauth'] }).id
  const b = addCapability(ctx, id, { name: '支付', keywords: ['payment'] }).id
  ctx.db.prepare("INSERT INTO tailor_wheels (capability_id, repo, url, license, license_ok, stars, score, score_detail) VALUES (?, 'a/login', 'http://u', 'MIT', 1, 100, 80, '{}')").run(a)
  updateCapability(ctx, a, { decision: 'wheel', chosenRepo: 'a/login' })
  updateCapability(ctx, b, { decision: 'self_build' })
  return id
}

describe('renderProposalMock', () => {
  it('含标题/选型总表/选中轮子链接；dropped 项不进表', () => {
    const id = seedDecided()
    const c = addCapability(ctx, id, { name: '弃项', keywords: ['x'] }).id
    updateCapability(ctx, c, { decision: 'dropped' })
    const md = renderProposalMock(getRequestDetail(ctx, id))
    expect(md).toContain('拼装方案书')
    expect(md).toContain('选型总表')
    expect(md).toContain('[a/login](http://u)')
    expect(md).not.toContain('弃项')
  })
})

describe('generateProposal', () => {
  it('有 pending 决策抛错；没能力清单抛错', async () => {
    const { id } = addRequest(ctx, { title: 'x', rawNeed: 'n' })
    await expect(generateProposal(ctx, id)).rejects.toThrow(/先拆解/)
    addCapability(ctx, id, { name: 'a', keywords: ['k'] })
    await expect(generateProposal(ctx, id)).rejects.toThrow(/未决策/)
  })
  it('mock 写文件、status→proposed、proposal_path 回填', async () => {
    const id = seedDecided()
    const { path: rel } = await generateProposal(ctx, id)
    expect(rel).toBe(path.join('tailor', String(id), 'proposal.md'))
    const abs = path.join(ctx.config.paths.workspace, rel)
    expect(fs.readFileSync(abs, 'utf8')).toContain('拼装方案书')
    const d = getRequestDetail(ctx, id)
    expect(d.request.status).toBe('proposed')
    expect(d.request.proposal_path).toBe(rel)
  })
  it('live 内容过短重试一次，仍短则抛', async () => {
    const id = seedDecided()
    fs.mkdirSync(path.join(ctx.config.paths.templates, 'prompts'), { recursive: true })
    fs.writeFileSync(path.join(ctx.config.paths.templates, 'prompts', 'tailor-proposal.md'), 'tpl')
    ctx.config.llm.mode = 'live'
    let calls = 0
    ctx.llm = { complete: async () => { calls++; return '太短' } }
    await expect(generateProposal(ctx, id)).rejects.toThrow(/过短/)
    expect(calls).toBe(2)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @forgecast/tailor test`
Expected: FAIL

- [ ] **Step 3: 实现 proposal.ts + 提示词模板**

`packages/tailor/src/proposal.ts`：

```ts
import fs from 'node:fs'
import path from 'node:path'
import type { CoreCtx } from '@forgecast/core'
import { getRequestDetail } from './requests'
import type { TailorRequestDetail } from './types'

const DECISION_LABEL: Record<string, string> = { wheel: '用轮子', self_build: '自研', dropped: '不做' }

/** mock：从已决策数据确定性渲染方案书骨架（占位提示 live；绝不走 ctx.llm） */
export function renderProposalMock(detail: TailorRequestDetail): string {
  const { request, capabilities } = detail
  const shown = capabilities.filter((c) => c.decision !== 'dropped')
  const rows = shown.map((c) => {
    const wheel = c.decision === 'wheel' ? c.wheels.find((w) => w.repo === c.chosen_repo) : undefined
    return `| ${c.name} | ${DECISION_LABEL[c.decision] ?? c.decision} | ${wheel ? `[${wheel.repo}](${wheel.url})` : '—'} | ${wheel?.license ?? '—'} | ${wheel?.stars ?? '—'} |`
  })
  const gplRisk = shown.some((c) => c.decision === 'wheel' && c.wheels.find((w) => w.repo === c.chosen_repo)?.license_ok === 0)
  return [
    `# ${request.title} 拼装方案书`,
    `> 占位方案书——配好 live 大模型后可生成完整工作量估计 / 风险 / 报价。`,
    `## 需求概述`, request.raw_need,
    `## 选型总表`, ['| 能力 | 决策 | 轮子 | 协议 | stars |', '|---|---|---|---|---|', ...rows].join('\n'),
    `## 胶水层工作量`, '待 live 大模型生成',
    `## 风险`, gplRisk ? '⚠ 选型含协议非白名单轮子（GPL 系等）：仅限客户内部部署场景，交付前需与客户确认分发边界' : '待 live 大模型生成',
    `## 报价参考`, '待 live 大模型生成',
  ].join('\n\n')
}

/** 生成方案书：决策未完成(有 pending)抛错；写 workspace/tailor/<id>/proposal.md；status → proposed。live 内容过短重试一次。 */
export async function generateProposal(ctx: CoreCtx, requestId: number, opts: { onProgress?: (m: string) => void } = {}): Promise<{ path: string }> {
  const log = opts.onProgress ?? (() => {})
  const detail = getRequestDetail(ctx, requestId) // 不存在则抛
  if (!detail.capabilities.length) throw new Error('没有能力清单，先拆解需求')
  const pending = detail.capabilities.filter((c) => c.decision === 'pending')
  if (pending.length) throw new Error(`还有 ${pending.length} 项能力未决策（选轮子/自研/不做），决策完才能出方案书`)

  let md: string
  if (ctx.config.llm.mode === 'mock') {
    log('mock 模式：生成占位方案书')
    md = renderProposalMock(detail)
  } else {
    const tpl = fs.readFileSync(path.join(ctx.config.paths.templates, 'prompts', 'tailor-proposal.md'), 'utf8')
    const system = '你是软件外包项目的技术负责人，输出 Markdown 方案书，不要输出方案书以外的内容。'
    const capsJson = JSON.stringify(detail.capabilities.map((c) => ({
      name: c.name, detail: c.detail, decision: c.decision,
      wheel: c.decision === 'wheel' ? (c.wheels.find((w) => w.repo === c.chosen_repo) ?? null) : null,
    })), null, 2)
    const prompt = `${tpl}\n\n---\n\n客户需求：\n${detail.request.raw_need}\n\n能力清单与选型（JSON）：\n${capsJson}`
    let out: string | null = null
    let lastErr: unknown = new Error('方案书生成内容过短')
    for (let attempt = 0; attempt <= 1 && !out; attempt++) {
      try {
        const t = await ctx.llm.complete({ model: ctx.config.llm.models.analysis, system, prompt })
        if (t.trim().length >= 200) out = t
        else if (attempt === 0) log('方案书内容过短，重试一次…')
      } catch (err) {
        lastErr = err
        if (attempt === 0) log('方案书生成失败，重试一次…')
      }
    }
    if (!out) throw lastErr
    md = out
  }

  const rel = path.join('tailor', String(requestId), 'proposal.md')
  const abs = path.join(ctx.config.paths.workspace, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, md)
  ctx.db.prepare("UPDATE tailor_requests SET status = 'proposed', proposal_path = ? WHERE id = ?").run(rel, requestId)
  log(`方案书完成: workspace/${rel}`)
  return { path: rel }
}
```

`templates/prompts/tailor-proposal.md`：

```markdown
基于客户需求与已选型的能力清单，写一份客户/开发者两用的拼装方案书（Markdown）。结构固定：

# <项目名> 拼装方案书
## 需求概述（2-3 句，说人话）
## 选型总表（Markdown 表格：能力 | 决策 | 轮子(repo 链接) | 协议 | stars | 一句话选型理由）
## 胶水层工作量（逐能力：拿轮子拼装/改造具体要做什么，各估人天，最后合计）
## 风险（协议风险：逐条点名 GPL 系轮子的使用边界；维护风险：点名超过 1 年未更新的轮子；集成风险）
## 报价参考（按合计人天 × 市场日价区间，给低/中/高三档，注明仅供参考）
## 自研项清单（decision=self_build 的能力：为何没有合适轮子、自研要点）

要求：金额与人天必须给出具体数字区间；不要空话；轮子信息严格用输入 JSON 里的数据，不得编造 repo。
```

`index.ts` 追加 `export * from './proposal'`。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @forgecast/tailor test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/tailor/src templates/prompts/tailor-proposal.md packages/tailor/test/proposal.test.ts
git commit -m "feat(tailor): 拼装方案书生成(决策门禁 + LLM capability + mock 渲染)"
```

---

### Task 8: server API 路由

**Files:**
- Modify: `packages/server/src/app.ts`（文件尾部 return app 之前追加 tailor 路由段）、`packages/server/package.json`（dependencies 加 `"@forgecast/tailor": "workspace:*"`，然后 `pnpm install`）
- Test: `packages/server/test/tailor.test.ts`

**Interfaces:**
- Consumes: Task 3-7 的全部导出；现有 `queue.enqueue` / `readFileSafe` / SSE 机制
- Produces（web 端按这些约定调用）:
  - `GET /api/tailor` → `TailorRequest[]`
  - `POST /api/tailor {title, rawNeed}` → `{id}`（缺参 400）
  - `GET /api/tailor/:id` → `TailorRequestDetail`（404）
  - `POST /api/tailor/:id/decompose` → `{taskId}`
  - `POST /api/tailor/:id/search {capabilityId?}` → `{taskId}`（status=draft 时 400）
  - `POST /api/tailor/:id/proposal` → `{taskId}`（无能力清单/有 pending 时 400）
  - `GET /api/tailor/:id/proposal` → `{md}`（未生成 404）
  - `POST /api/tailor/:id/capabilities {name, detail?, keywords}` → `{id}`
  - `PATCH /api/tailor/capabilities/:capId {name?/detail?/keywords?/decision?/chosenRepo?}` → `{ok}`（非法 decision 或缺 chosenRepo 400，不存在 404）
  - `DELETE /api/tailor/capabilities/:capId` → `{ok}`
  - `POST /api/leads/:id/to-tailor` → `{id}`（无 intent 400，不存在 404）

- [ ] **Step 1: 写失败测试 tailor.test.ts**

harness（beforeEach 建临时 ctx/queue/app、`runTask` 轮询任务完成）照抄 `packages/server/test/candidates.test.ts` 顶部的写法。用例：

```ts
describe('tailor API (mock)', () => {
  it('POST /api/tailor 缺参 400；正常创建后 GET 列表/详情', async () => {
    let res = await app.request('/api/tailor', { method: 'POST', body: JSON.stringify({ title: 'x' }) })
    expect(res.status).toBe(400)
    res = await app.request('/api/tailor', { method: 'POST', body: JSON.stringify({ title: '宠物店小程序', rawNeed: '要登录。要支付' }) })
    const { id } = await res.json() as any
    expect((await (await app.request('/api/tailor')).json() as any[]).length).toBe(1)
    const detail = await (await app.request(`/api/tailor/${id}`)).json() as any
    expect(detail.request.status).toBe('draft')
    expect((await app.request('/api/tailor/999')).status).toBe(404)
  })
  it('状态机：draft 搜轮子 400；拆解后可搜；有 pending 出方案书 400', async () => {
    const { id } = await (await app.request('/api/tailor', { method: 'POST', body: JSON.stringify({ title: 't', rawNeed: '要有登录功能。要有支付功能' }) })).json() as any
    expect((await app.request(`/api/tailor/${id}/search`, { method: 'POST', body: '{}' })).status).toBe(400)
    expect((await app.request(`/api/tailor/${id}/proposal`, { method: 'POST' })).status).toBe(400) // 没能力清单
    const { taskId } = await (await app.request(`/api/tailor/${id}/decompose`, { method: 'POST' })).json() as any
    await runTask(taskId)
    const d1 = await (await app.request(`/api/tailor/${id}`)).json() as any
    expect(d1.request.status).toBe('decomposed')
    expect(d1.capabilities.length).toBeGreaterThanOrEqual(2)
    expect((await app.request(`/api/tailor/${id}/proposal`, { method: 'POST' })).status).toBe(400) // 全 pending
    const { taskId: t2 } = await (await app.request(`/api/tailor/${id}/search`, { method: 'POST', body: '{}' })).json() as any
    await runTask(t2)
    const d2 = await (await app.request(`/api/tailor/${id}`)).json() as any
    expect(d2.request.status).toBe('searched')
    expect(d2.capabilities[0].wheels.length).toBeGreaterThan(0)
  })
  it('决策 PATCH + 方案书全流程', async () => {
    const { id } = await (await app.request('/api/tailor', { method: 'POST', body: JSON.stringify({ title: 't', rawNeed: '要有登录功能。要有支付功能' }) })).json() as any
    await runTask((await (await app.request(`/api/tailor/${id}/decompose`, { method: 'POST' })).json() as any).taskId)
    await runTask((await (await app.request(`/api/tailor/${id}/search`, { method: 'POST', body: '{}' })).json() as any).taskId)
    const d = await (await app.request(`/api/tailor/${id}`)).json() as any
    const [a, b] = d.capabilities
    // 非法 decision / wheel 缺 chosenRepo
    expect((await app.request(`/api/tailor/capabilities/${a.id}`, { method: 'PATCH', body: JSON.stringify({ decision: 'nope' }) })).status).toBe(400)
    expect((await app.request(`/api/tailor/capabilities/${a.id}`, { method: 'PATCH', body: JSON.stringify({ decision: 'wheel' }) })).status).toBe(400)
    expect((await app.request(`/api/tailor/capabilities/${a.id}`, { method: 'PATCH', body: JSON.stringify({ decision: 'wheel', chosenRepo: a.wheels[0].repo }) })).status).toBe(200)
    expect((await app.request(`/api/tailor/capabilities/${b.id}`, { method: 'PATCH', body: JSON.stringify({ decision: 'self_build' }) })).status).toBe(200)
    await runTask((await (await app.request(`/api/tailor/${id}/proposal`, { method: 'POST' })).json() as any).taskId)
    const md = (await (await app.request(`/api/tailor/${id}/proposal`)).json() as any).md
    expect(md).toContain('拼装方案书')
  })
  it('能力项增删 + 询单转入', async () => {
    const { id } = await (await app.request('/api/tailor', { method: 'POST', body: JSON.stringify({ title: 't', rawNeed: 'n' }) })).json() as any
    const cap = await (await app.request(`/api/tailor/${id}/capabilities`, { method: 'POST', body: JSON.stringify({ name: '登录', keywords: ['oauth'] }) })).json() as any
    expect((await app.request(`/api/tailor/capabilities/${cap.id}`, { method: 'DELETE' })).status).toBe(200)
    // 询单：无 intent 400；有 intent 转入成功
    ctx.db.prepare("INSERT INTO leads (wechat, intent) VALUES ('wx1', '')").run()
    ctx.db.prepare("INSERT INTO leads (wechat, intent) VALUES ('wx2', '想做个小程序')").run()
    expect((await app.request('/api/leads/1/to-tailor', { method: 'POST' })).status).toBe(400)
    expect((await app.request('/api/leads/999/to-tailor', { method: 'POST' })).status).toBe(404)
    const r = await (await app.request('/api/leads/2/to-tailor', { method: 'POST' })).json() as any
    const detail = await (await app.request(`/api/tailor/${r.id}`)).json() as any
    expect(detail.request.lead_id).toBe(2)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @forgecast/server test`
Expected: FAIL（路由 404）

- [ ] **Step 3: 实现——server package.json 加依赖、app.ts 加路由**

`packages/server/package.json` dependencies 加 `"@forgecast/tailor": "workspace:*"` → `pnpm install`。

app.ts 顶部 import：

```ts
import {
  addCapability, addRequest, decomposeRequest, deleteCapability, generateProposal,
  getRequestDetail, listRequests, requestFromLead, searchWheels, updateCapability,
} from '@forgecast/tailor'
```

`return app` 之前追加路由段：

```ts
  // —— 定制项目板块（tailor）——
  const tailorExists = (id: number) => !!ctx.db.prepare('SELECT id FROM tailor_requests WHERE id = ?').get(id)
  const DECISIONS = ['pending', 'wheel', 'self_build', 'dropped']

  app.get('/api/tailor', (c) => c.json(listRequests(ctx)))
  app.post('/api/tailor', async (c) => {
    const body = await c.req.json().catch(() => ({}))
    if (typeof body.title !== 'string' || !body.title.trim()) return c.json({ error: '缺少 title' }, 400)
    if (typeof body.rawNeed !== 'string' || !body.rawNeed.trim()) return c.json({ error: '缺少 rawNeed' }, 400)
    return c.json(addRequest(ctx, { title: body.title, rawNeed: body.rawNeed }))
  })
  app.get('/api/tailor/:id', (c) => {
    const id = Number(c.req.param('id'))
    if (!tailorExists(id)) return c.json({ error: '需求不存在' }, 404)
    return c.json(getRequestDetail(ctx, id))
  })
  app.post('/api/tailor/:id/decompose', (c) => {
    const id = Number(c.req.param('id'))
    if (!tailorExists(id)) return c.json({ error: '需求不存在' }, 404)
    return c.json({ taskId: queue.enqueue((log) => decomposeRequest(ctx, id, { onProgress: log })) })
  })
  app.post('/api/tailor/:id/search', async (c) => {
    const id = Number(c.req.param('id'))
    if (!tailorExists(id)) return c.json({ error: '需求不存在' }, 404)
    const st = (ctx.db.prepare('SELECT status FROM tailor_requests WHERE id = ?').get(id) as any).status
    if (st === 'draft') return c.json({ error: '先拆解需求再搜轮子' }, 400)
    const body = await c.req.json().catch(() => ({}))
    const capabilityId = typeof body.capabilityId === 'number' ? body.capabilityId : undefined
    return c.json({ taskId: queue.enqueue((log) => searchWheels(ctx, id, { capabilityId, onProgress: log })) })
  })
  app.post('/api/tailor/:id/proposal', (c) => {
    const id = Number(c.req.param('id'))
    if (!tailorExists(id)) return c.json({ error: '需求不存在' }, 404)
    // 决策门禁在路由层同步拦（同样的检查 generateProposal 内部还有一道，双保险）——用户要的是 400 而不是任务失败
    const total = (ctx.db.prepare('SELECT COUNT(*) AS n FROM tailor_capabilities WHERE request_id = ?').get(id) as any).n
    if (!total) return c.json({ error: '没有能力清单，先拆解需求' }, 400)
    const pending = (ctx.db.prepare("SELECT COUNT(*) AS n FROM tailor_capabilities WHERE request_id = ? AND decision = 'pending'").get(id) as any).n
    if (pending) return c.json({ error: `还有 ${pending} 项能力未决策，决策完才能出方案书` }, 400)
    return c.json({ taskId: queue.enqueue((log) => generateProposal(ctx, id, { onProgress: log })) })
  })
  app.get('/api/tailor/:id/proposal', (c) => {
    const id = Number(c.req.param('id'))
    const row = ctx.db.prepare('SELECT proposal_path FROM tailor_requests WHERE id = ?').get(id) as { proposal_path: string | null } | undefined
    if (!row) return c.json({ error: '需求不存在' }, 404)
    if (!row.proposal_path) return c.json({ error: '方案书未生成' }, 404)
    return c.json({ md: readFileSafe(path.join(ctx.config.paths.workspace, row.proposal_path)) })
  })
  app.post('/api/tailor/:id/capabilities', async (c) => {
    const id = Number(c.req.param('id'))
    if (!tailorExists(id)) return c.json({ error: '需求不存在' }, 404)
    const body = await c.req.json().catch(() => ({}))
    if (typeof body.name !== 'string' || !body.name.trim()) return c.json({ error: '缺少 name' }, 400)
    const keywords = Array.isArray(body.keywords) ? body.keywords.filter((x: unknown): x is string => typeof x === 'string') : []
    return c.json(addCapability(ctx, id, { name: body.name, detail: body.detail, keywords }))
  })
  app.patch('/api/tailor/capabilities/:capId', async (c) => {
    const capId = Number(c.req.param('capId'))
    const body = await c.req.json().catch(() => ({}))
    if (body.decision !== undefined && !DECISIONS.includes(body.decision)) return c.json({ error: `decision 须为 ${DECISIONS.join('/')}` }, 400)
    try {
      updateCapability(ctx, capId, body)
      return c.json({ ok: true })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return c.json({ error: msg }, msg.includes('不存在') ? 404 : 400)
    }
  })
  app.delete('/api/tailor/capabilities/:capId', (c) => {
    deleteCapability(ctx, Number(c.req.param('capId')))
    return c.json({ ok: true })
  })
  app.post('/api/leads/:id/to-tailor', (c) => {
    try {
      return c.json(requestFromLead(ctx, Number(c.req.param('id'))))
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return c.json({ error: msg }, msg.includes('不存在') ? 404 : 400)
    }
  })
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @forgecast/server test`
Expected: PASS（含既有用例回归）

- [ ] **Step 5: Commit**

```bash
git add packages/server pnpm-lock.yaml
git commit -m "feat(server): /api/tailor 路由(CRUD/三动作/状态机拦截/询单转入)"
```

---

### Task 9: CLI tailor 子命令

**Files:**
- Modify: `cli.ts`（switch 里加 `case 'tailor'`；顶部 import 加 `@forgecast/tailor`）

**Interfaces:**
- Consumes: Task 3-7 导出
- Produces: `forgecast tailor add "<需求>" [--title=..]` / `tailor list` / `tailor decompose <id>` / `tailor search <id> [--cap=<capId>]` / `tailor proposal <id>`

- [ ] **Step 1: 实现**

顶部 import：

```ts
import { addRequest, decomposeRequest, generateProposal, listRequests, searchWheels } from '@forgecast/tailor'
```

switch 追加（写在 `case 'knowledge'` 附近，风格一致）：

```ts
    case 'tailor': {
      const sub = rest[0]
      const usage = '用法: forgecast tailor add "<客户需求>" [--title=<标题>] | list | decompose <id> | search <id> [--cap=<capId>] | proposal <id>'
      const ctx = ctxWithNotes()
      if (sub === 'add') {
        const need = rest[1]
        if (!need || need.startsWith('--')) { console.error(usage); process.exit(1) }
        const { id } = addRequest(ctx, { title: arg('title') ?? need.slice(0, 20), rawNeed: need })
        console.log(`已录入定制需求 #${id}（接着 forgecast tailor decompose ${id}）`)
      } else if (sub === 'list') {
        console.log('id  状态         标题')
        for (const r of listRequests(ctx)) console.log(`${String(r.id).padStart(2)}  ${r.status.padEnd(10)}  ${r.title}`)
      } else if (sub === 'decompose' || sub === 'search' || sub === 'proposal') {
        const id = Number(rest[1])
        if (!id) { console.error(usage); process.exit(1) }
        if (sub === 'decompose') {
          const { count } = await decomposeRequest(ctx, id, { onProgress: (m) => console.log(`  ${m}`) })
          console.log(`拆解完成：${count} 项能力（编辑确认后 forgecast tailor search ${id}）`)
        } else if (sub === 'search') {
          const cap = arg('cap') ? Number(arg('cap')) : undefined
          const r = await searchWheels(ctx, id, { capabilityId: cap, onProgress: (m) => console.log(`  ${m}`) })
          console.log(`搜索完成：成功 ${r.ok} 项，失败 ${r.failed.length} 项${r.failed.length ? '（可 --cap=<id> 单项重搜）' : ''}`)
        } else {
          const { path: rel } = await generateProposal(ctx, id, { onProgress: (m) => console.log(`  ${m}`) })
          console.log(`方案书完成: workspace/${rel}`)
        }
      } else {
        console.error(usage)
        process.exit(1)
      }
      break
    }
```

- [ ] **Step 2: 冒烟验证（mock 全链路，免 key）**

```bash
pnpm exec tsx cli.ts tailor add "要有微信扫码登录。要能在线预约排队" --title=冒烟测试
pnpm exec tsx cli.ts tailor list
pnpm exec tsx cli.ts tailor decompose 1
pnpm exec tsx cli.ts tailor search 1
pnpm exec tsx cli.ts tailor proposal 1   # 预期报错：还有 N 项能力未决策 —— 这是状态机在工作，属正常
```

Expected: 前四条正常输出；proposal 因未决策报错（决策操作在 Web 上做，CLI 不做决策交互）。
验证后清理冒烟数据：`sqlite3 db/forgecast.db "DELETE FROM tailor_wheels; DELETE FROM tailor_capabilities; DELETE FROM tailor_requests;"`（若本地 db 尚不存在则跳过整个冒烟步骤）。

- [ ] **Step 3: Commit**

```bash
git add cli.ts
git commit -m "feat(cli): forgecast tailor 子命令(add/list/decompose/search/proposal)"
```

---

### Task 10: web api 类型 + TailorPage 列表页（替换占位壳）

**Files:**
- Modify: `apps/web/src/api.ts`（追加类型）、`apps/web/src/pages/TailorPage.tsx`（整文件替换）、`apps/web/src/App.tsx`（加 `/tailor/:id` 路由，Task 11 的组件先建空壳）
- Create: `apps/web/src/pages/TailorDetailPage.tsx`（本任务只建最小壳，Task 11 填完整）

**Interfaces:**
- Consumes: Task 8 的 API 约定
- Produces: `api.ts` 新类型 `TailorRequest / TailorWheel / TailorCapability / TailorDetail`（字段与 server 返回一致，Task 11/12 依赖）

- [ ] **Step 1: api.ts 追加类型**

```ts
export interface TailorRequest {
  id: number; title: string; raw_need: string; lead_id: number | null
  status: 'draft' | 'decomposed' | 'searched' | 'proposed'
  proposal_path: string | null; created_at: string
}
export interface TailorWheel {
  id: number; capability_id: number; repo: string; url: string
  license: string | null; license_ok: number
  stars: number; last_commit: string | null; description: string | null
  score: number; score_detail: string
}
export interface TailorCapability {
  id: number; request_id: number; name: string; detail: string | null
  keywords: string[]; decision: 'pending' | 'wheel' | 'self_build' | 'dropped'
  chosen_repo: string | null; sort: number; wheels: TailorWheel[]
}
export interface TailorDetail { request: TailorRequest; capabilities: TailorCapability[] }
```

- [ ] **Step 2: TailorPage.tsx 整文件替换**

```tsx
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, type TailorRequest } from '../api'

const STATUS_LABEL: Record<TailorRequest['status'], string> = {
  draft: '待拆解', decomposed: '已拆解', searched: '已搜轮子', proposed: '已出方案',
}

export default function TailorPage() {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const list = useQuery({ queryKey: ['tailor'], queryFn: () => api<TailorRequest[]>('/api/tailor') })
  const [form, setForm] = useState({ title: '', rawNeed: '' })
  const create = useMutation({
    mutationFn: () => api<{ id: number }>('/api/tailor', { method: 'POST', body: JSON.stringify(form) }),
    onSuccess: (r) => { qc.invalidateQueries({ queryKey: ['tailor'] }); navigate(`/tailor/${r.id}`) },
    onError: (e) => alert(`录入失败: ${e instanceof Error ? e.message : String(e)}`),
  })
  const inp = 'rounded border px-2 py-1 text-sm w-full'
  return (
    <div className="grid grid-cols-[1fr_360px] gap-6">
      <div className="space-y-3">
        {list.data?.map((r) => (
          <div key={r.id} onClick={() => navigate(`/tailor/${r.id}`)}
            className="cursor-pointer rounded-lg border bg-white p-4 hover:border-blue-400">
            <div className="flex items-center justify-between">
              <div className="font-medium">#{r.id} {r.title}</div>
              <span className="rounded-full border px-2 py-0.5 text-xs text-neutral-500">{STATUS_LABEL[r.status]}</span>
            </div>
            <div className="mt-1 line-clamp-2 text-sm text-neutral-500">{r.raw_need}</div>
            <div className="mt-1 text-xs text-neutral-400">{r.created_at}{r.lead_id ? ` · 来自询单#${r.lead_id}` : ''}</div>
          </div>
        ))}
        {list.data?.length === 0 && (
          <div className="rounded-lg border p-6 text-center text-neutral-400">
            暂无定制需求：右侧录入，或在「分发营销 → 数据复盘」把询单一键转过来
          </div>
        )}
      </div>
      <div className="self-start space-y-2 rounded-lg border bg-white p-4">
        <div className="font-semibold">录入客户需求</div>
        <input className={inp} placeholder="标题（如：宠物店会员小程序）" value={form.title}
          onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))} />
        <textarea className={`${inp} h-40`} placeholder="粘贴客户原始需求描述…" value={form.rawNeed}
          onChange={(e) => setForm((f) => ({ ...f, rawNeed: e.target.value }))} />
        <button className="w-full rounded bg-blue-600 py-1.5 text-sm text-white disabled:opacity-50"
          disabled={create.isPending || !form.title.trim() || !form.rawNeed.trim()} onClick={() => create.mutate()}>
          {create.isPending ? '录入中…' : '录入需求'}
        </button>
      </div>
    </div>
  )
}
```

- [ ] **Step 3: TailorDetailPage 最小壳 + App.tsx 路由**

`TailorDetailPage.tsx` 壳（Task 11 整体替换）：

```tsx
import { useParams } from 'react-router-dom'

export default function TailorDetailPage() {
  const { id } = useParams()
  return <div className="text-neutral-400">定制需求 #{id} 详情（下一任务实现）</div>
}
```

App.tsx：import `TailorDetailPage`，`/tailor` 路由后加一行

```tsx
<Route path="/tailor/:id" element={<TailorDetailPage />} />
```

- [ ] **Step 4: 类型检查 + 构建**

Run: `pnpm --filter web exec tsc --noEmit && pnpm --filter web build`
Expected: 均通过

- [ ] **Step 5: Commit**

```bash
git add apps/web/src
git commit -m "feat(web): 定制板块列表页(需求卡片+录入表单)替换占位壳"
```

---

### Task 11: TailorDetailPage 详情页（分步流程）

**Files:**
- Modify: `apps/web/src/pages/TailorDetailPage.tsx`（整文件替换）

**Interfaces:**
- Consumes: Task 8 API + Task 10 类型 + 现有 `subscribeTask`
- Produces: 完整详情页——原始需求卡 + 三动作按钮（状态驱动禁用）+ SSE 日志 + 能力清单卡（决策/增删）+ 轮子候选（单选、协议不合规折叠）+ 方案书 markdown 预览

- [ ] **Step 1: 整文件替换**

```tsx
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import ReactMarkdown from 'react-markdown'
import { useParams } from 'react-router-dom'
import { api, subscribeTask, type TailorCapability, type TailorDetail } from '../api'

export default function TailorDetailPage() {
  const { id } = useParams()
  const qc = useQueryClient()
  const detail = useQuery({ queryKey: ['tailor', id], queryFn: () => api<TailorDetail>(`/api/tailor/${id}`) })
  const proposal = useQuery({
    queryKey: ['tailor-proposal', id],
    queryFn: () => api<{ md: string }>(`/api/tailor/${id}/proposal`),
    enabled: detail.data?.request.status === 'proposed',
    retry: false,
  })
  const [logs, setLogs] = useState<string[]>([])
  const [running, setRunning] = useState<'decompose' | 'search' | 'proposal' | null>(null)

  async function runAction(action: 'decompose' | 'search' | 'proposal') {
    if (running) return
    if (action === 'decompose' && (detail.data?.capabilities.length ?? 0) > 0
      && !window.confirm('重新拆解会清掉现有能力清单和已搜的轮子，继续？')) return
    setRunning(action); setLogs([])
    try {
      const { taskId } = await api<{ taskId: string }>(`/api/tailor/${id}/${action}`, { method: 'POST', body: '{}' })
      subscribeTask(taskId, (e) => {
        setLogs((l) => [...l, e.message])
        if (e.type === 'done' || e.type === 'error') {
          setRunning(null)
          qc.invalidateQueries({ queryKey: ['tailor', id] })
          qc.invalidateQueries({ queryKey: ['tailor-proposal', id] })
        }
      })
    } catch (err) { alert(err instanceof Error ? err.message : String(err)); setRunning(null) }
  }

  async function patchCap(capId: number, patch: Record<string, unknown>) {
    try {
      await api(`/api/tailor/capabilities/${capId}`, { method: 'PATCH', body: JSON.stringify(patch) })
      qc.invalidateQueries({ queryKey: ['tailor', id] })
    } catch (e) { alert(e instanceof Error ? e.message : String(e)) }
  }
  async function removeCap(capId: number) {
    if (!window.confirm('删除该能力项及其轮子候选？')) return
    await api(`/api/tailor/capabilities/${capId}`, { method: 'DELETE' })
    qc.invalidateQueries({ queryKey: ['tailor', id] })
  }
  const [newCap, setNewCap] = useState({ name: '', keywords: '' })
  async function addCap() {
    if (!newCap.name.trim()) return
    try {
      await api(`/api/tailor/${id}/capabilities`, {
        method: 'POST',
        body: JSON.stringify({ name: newCap.name, keywords: newCap.keywords.split(/[,，]/).map((s) => s.trim()).filter(Boolean) }),
      })
      setNewCap({ name: '', keywords: '' })
      qc.invalidateQueries({ queryKey: ['tailor', id] })
    } catch (e) { alert(e instanceof Error ? e.message : String(e)) }
  }

  const d = detail.data
  if (!d) return <div className="text-neutral-400">{detail.isError ? '需求不存在' : '加载中…'}</div>
  const caps = d.capabilities
  const pendingCount = caps.filter((c) => c.decision === 'pending').length
  const btn = 'rounded bg-blue-600 px-4 py-2 text-sm text-white disabled:opacity-50'
  return (
    <div className="space-y-4">
      <div className="rounded-lg border bg-white p-4">
        <div className="flex items-center justify-between">
          <div className="font-semibold">#{d.request.id} {d.request.title}</div>
          <span className="text-xs text-neutral-500">{d.request.status}</span>
        </div>
        <div className="mt-2 whitespace-pre-wrap text-sm text-neutral-600">{d.request.raw_need}</div>
        <div className="mt-3 flex gap-2">
          <button className={btn} disabled={!!running} onClick={() => runAction('decompose')}>
            {running === 'decompose' ? '拆解中…' : caps.length ? '重新拆解' : '拆解需求'}
          </button>
          <button className={btn} disabled={!!running || d.request.status === 'draft'} onClick={() => runAction('search')}>
            {running === 'search' ? '搜索中…' : '搜轮子'}
          </button>
          <button className={btn} disabled={!!running || !caps.length || pendingCount > 0}
            title={pendingCount ? `还有 ${pendingCount} 项未决策` : ''} onClick={() => runAction('proposal')}>
            {running === 'proposal' ? '生成中…' : '生成方案书'}
          </button>
          {pendingCount > 0 && caps.length > 0 && <span className="self-center text-xs text-neutral-400">每项能力选「轮子/自研/不做」后才能出方案书</span>}
        </div>
      </div>
      {logs.length > 0 && (
        <div className="max-h-32 space-y-1 overflow-y-auto rounded-lg border bg-neutral-900 p-3 font-mono text-xs text-green-400">
          {logs.map((l, i) => <div key={i}>{l}</div>)}
        </div>
      )}
      {caps.map((c) => <CapabilityCard key={c.id} cap={c} onPatch={patchCap} onRemove={removeCap} />)}
      {caps.length > 0 && (
        <div className="flex gap-2">
          <input className="rounded border px-2 py-1 text-sm" placeholder="能力名" value={newCap.name}
            onChange={(e) => setNewCap((s) => ({ ...s, name: e.target.value }))} />
          <input className="w-64 rounded border px-2 py-1 text-sm" placeholder="GitHub 搜索关键词，逗号分隔" value={newCap.keywords}
            onChange={(e) => setNewCap((s) => ({ ...s, keywords: e.target.value }))} />
          <button className="rounded border px-3 py-1 text-sm" onClick={addCap}>+ 加能力项</button>
        </div>
      )}
      {proposal.data?.md && (
        <div className="rounded-lg border bg-white p-6 text-sm leading-relaxed [&_h1]:text-lg [&_h1]:font-bold [&_h2]:mt-4 [&_h2]:font-semibold [&_table]:my-2 [&_td]:border [&_td]:px-2 [&_th]:border [&_th]:px-2">
          <ReactMarkdown>{proposal.data.md}</ReactMarkdown>
        </div>
      )}
    </div>
  )
}

function CapabilityCard({ cap, onPatch, onRemove }: {
  cap: TailorCapability
  onPatch: (capId: number, patch: Record<string, unknown>) => void
  onRemove: (capId: number) => void
}) {
  const okWheels = cap.wheels.filter((w) => w.license_ok === 1)
  const badWheels = cap.wheels.filter((w) => w.license_ok !== 1)
  const badge = cap.decision === 'wheel' ? `✔ ${cap.chosen_repo}`
    : cap.decision === 'self_build' ? '自研' : cap.decision === 'dropped' ? '不做' : '待决策'
  return (
    <div className={`rounded-lg border bg-white p-4 ${cap.decision === 'dropped' ? 'opacity-50' : ''}`}>
      <div className="flex items-center justify-between">
        <div className="font-medium">
          {cap.name}
          <span className="ml-2 rounded-full border px-2 py-0.5 text-xs text-neutral-500">{badge}</span>
        </div>
        <div className="flex gap-2 text-xs">
          <button className="rounded border px-2 py-1" onClick={() => onPatch(cap.id, { decision: 'self_build' })}>标自研</button>
          <button className="rounded border px-2 py-1" onClick={() => onPatch(cap.id, { decision: 'dropped' })}>不做</button>
          <button className="rounded border px-2 py-1 text-red-500" onClick={() => onRemove(cap.id)}>删除</button>
        </div>
      </div>
      {cap.detail && <div className="mt-1 text-sm text-neutral-500">{cap.detail}</div>}
      <div className="mt-1 text-xs text-neutral-400">关键词: {cap.keywords.join(', ') || '—'}</div>
      {okWheels.length > 0 && (
        <div className="mt-2 grid gap-2 md:grid-cols-2">
          {okWheels.map((w) => (
            <label key={w.id} className={`flex cursor-pointer items-start gap-2 rounded border p-2 text-sm ${cap.decision === 'wheel' && cap.chosen_repo === w.repo ? 'border-blue-500 bg-blue-50' : ''}`}>
              <input type="radio" className="mt-1" checked={cap.decision === 'wheel' && cap.chosen_repo === w.repo}
                onChange={() => onPatch(cap.id, { decision: 'wheel', chosenRepo: w.repo })} />
              <span>
                <a className="font-medium text-blue-600" href={w.url} target="_blank" rel="noreferrer"
                  onClick={(e) => e.stopPropagation()}>{w.repo}</a>
                <span className="ml-2 text-xs text-neutral-400">{w.score} 分 · ⭐{w.stars} · {w.license ?? '无协议'}</span>
                {w.description && <span className="block text-xs text-neutral-500">{w.description}</span>}
              </span>
            </label>
          ))}
        </div>
      )}
      {badWheels.length > 0 && (
        <details className="mt-2 text-xs text-neutral-500">
          <summary className="cursor-pointer">另有 {badWheels.length} 个协议非白名单轮子（GPL 系等，仅客户内部部署可考虑）</summary>
          <div className="mt-1 space-y-1">
            {badWheels.map((w) => (
              <label key={w.id} className="flex items-center gap-2">
                <input type="radio" checked={cap.decision === 'wheel' && cap.chosen_repo === w.repo}
                  onChange={() => onPatch(cap.id, { decision: 'wheel', chosenRepo: w.repo })} />
                <a className="text-neutral-600" href={w.url} target="_blank" rel="noreferrer">{w.repo}</a>
                <span>⚠ {w.license ?? '无协议'} · {w.score} 分</span>
              </label>
            ))}
          </div>
        </details>
      )}
    </div>
  )
}
```

- [ ] **Step 2: 类型检查 + 构建**

Run: `pnpm --filter web exec tsc --noEmit && pnpm --filter web build`
Expected: 均通过

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/pages/TailorDetailPage.tsx
git commit -m "feat(web): 定制需求详情页(拆解/搜轮子/决策/方案书全流程)"
```

---

### Task 12: 询单转定制入口 + 端到端验收 + 文档

**Files:**
- Modify: `apps/web/src/pages/ReviewPage.tsx`（询单行加「转定制」按钮）、`README.md`、`开源变现内容工厂-开发文档.md`

**Interfaces:**
- Consumes: `POST /api/leads/:id/to-tailor`（Task 8）

- [ ] **Step 1: ReviewPage 加转定制按钮**

顶部 import 加 `import { useNavigate } from 'react-router-dom'`；组件内加：

```tsx
const navigate = useNavigate()
async function toTailor(leadId: number) {
  try {
    const r = await api<{ id: number }>(`/api/leads/${leadId}/to-tailor`, { method: 'POST', body: '{}' })
    navigate(`/tailor/${r.id}`)
  } catch (e) { alert(`转入失败: ${e instanceof Error ? e.message : String(e)}`) }
}
```

询单列表 `<li>` 行尾（`{l.created_at}` 之后）加：

```tsx
<button className="ml-2 rounded border px-2 py-0.5 text-xs" onClick={() => toTailor(l.id)}>转定制</button>
```

- [ ] **Step 2: 类型检查 + 构建 + 全仓测试**

Run: `pnpm --filter web exec tsc --noEmit && pnpm --filter web build && pnpm test`
Expected: 全部通过

- [ ] **Step 3: 端到端手工验收（mock 全链路，免 key）**

Run: `pnpm dev`，打开 http://localhost:5173/tailor 依次确认：
1. 录入需求「要有微信扫码登录。要能在线预约排队」→ 跳详情
2. 「拆解需求」→ SSE 日志滚动 → 出 2 项能力（带 mock 占位说明）
3. 编辑：+ 加能力项「会员储值」、删掉一项、确认关键词显示
4. 「搜轮子」→ 每项能力出候选轮子卡（fixture 数据、有分数、协议不合规折叠在 details）
5. 逐项决策：一项选轮子、一项标自研 → 「生成方案书」按钮解禁
6. 「生成方案书」→ 页面底部渲染方案书 markdown（选型总表含所选轮子链接）
7. 「重新拆解」→ 弹确认框，确认后能力清单被重置
8. 数据复盘页登记一条带意向的询单 → 点「转定制」→ 跳到新定制需求详情，标题带「询单#」
9. `workspace/tailor/<id>/proposal.md` 文件存在

- [ ] **Step 4: 文档更新**

1. `README.md`：
   - CLI 段追加一行：`forgecast tailor add|list|decompose|search|proposal   # 定制项目：需求拆解→GitHub 找轮子→拼装方案书`
   - 目录结构段 `packages/` 列表加 `packages/tailor 定制项目板块`；workspace 约定加 `workspace/tailor/<id>/` 定制方案书
2. `开源变现内容工厂-开发文档.md`：§9 之后新增一节「M8 — 定制项目板块（tailor）」，写明：目的（询单→接单闭环、避免重复造轮子）、三表结构、状态机 `draft→decomposed→searched→proposed`、两个 LLM capability 及其 mock 策略、评分公式（活跃 30+热度 25+协议 15+命中 30）、指回 spec 路径。

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/pages/ReviewPage.tsx README.md 开源变现内容工厂-开发文档.md
git commit -m "feat(web): 询单一键转定制 + tailor 板块文档(M8)"
```
