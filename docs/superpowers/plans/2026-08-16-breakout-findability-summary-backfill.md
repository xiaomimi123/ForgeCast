# 爆款候选可见性 + 老候选中文简介补充 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 找爆款扫描完成后在日志区直接列出命中仓库名；新增一条独立轻量链路，给老候选（已评过三维分但缺中文简介）补上 `summaryZh`，不重跑三维打分。

**Architecture:** 两个互不依赖的小修复打包在一个计划里执行。问题1只改 `scoutBreakouts` 的返回值+路由日志，前端零改动。问题2照抄现有 `candidatesNeedingRescore`/`rescoreCandidate`/`POST /api/candidates/rescore-all` 三层结构（选取查询→单条动作→路由跑循环+记日志），新增一套平行的 `candidatesNeedingSummary`/`backfillCandidateSummary`/`POST /api/candidates/backfill-summary`。自底向上：先 `score.ts` 的 LLM 调用，再 `scout.ts` 的业务函数，再 `app.ts` 路由，最后前端按钮。

**Tech Stack:** TypeScript, Vitest（后端测试），Hono（server 路由），React + TanStack Query（前端，不加自动化测试）。

## Global Constraints

- **不修"今日入炉"角标的 UTC 时区判定 bug**——本次范围外。
- **不做候选池临时置顶**——命中仓库名只在扫描日志区域展示，不引入任何"本次会话高亮"的临时前端状态或数据库标记。
- **`generateSummaryZh` 是独立的轻量 LLM 调用**，不重跑三维打分（`rebrandCost`/`buyerClarity`/`visualAppeal`），不改动已有 `rationale`/`targetBuyer`/`painPoint`/`category`。mock 模式留空串，不编造翻译（跟 `heuristicScore` 的既有约定一致）。
- **不做批量回填的限流/并发控制**——跟现有 `rescore-all` 一样简单串行跑，单条失败 try/catch 不中断整批。
- `scoutBreakouts` 的 `hits` 只收协议 OK（`isLicenseOk` 为真）的命中项，条数等于 `added`。
- 参考 spec：`docs/superpowers/specs/2026-08-16-breakout-findability-summary-backfill-design.md`。

---

### Task 1: generateSummaryZh（轻量 LLM 调用）

**Files:**
- Modify: `packages/scout/src/score.ts`
- Test: `packages/scout/test/score.test.ts`

**Interfaces:**
- Produces: `generateSummaryZh(ctx: CoreCtx, repo: string, stars: number, readme: string): Promise<string>`——Task 2（`backfillCandidateSummary`）依赖此函数。

- [ ] **Step 1: 写失败测试**

在 `packages/scout/test/score.test.ts` 文件末尾（`describe('scoreCandidate live（假 LLM）', ...)` 块之后）新增，同时把顶部 import 改成加 `generateSummaryZh`（找到现有 `import { categorizeHeuristic, scoreCandidate } from '../src/score'` 那一行，改成 `import { categorizeHeuristic, generateSummaryZh, scoreCandidate } from '../src/score'`）：

```ts
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/scout && npx vitest run test/score.test.ts -t "generateSummaryZh"`
Expected: FAIL（`generateSummaryZh` 未从 `../src/score` 导出）

- [ ] **Step 3: 实现 `generateSummaryZh`**

在 `packages/scout/src/score.ts` 里，`scoreCandidate` 函数定义结束之后（`function heuristicScore(...)` 定义之前）插入：

```ts
/** 只生成中文简介，不重新跑三维打分——用于给老候选（评过分但缺 summaryZh）做轻量补充，
 *  不烧三维评分的 LLM 调用、不改动已有 rationale/targetBuyer/painPoint。 */
export async function generateSummaryZh(ctx: CoreCtx, repo: string, stars: number, readme: string): Promise<string> {
  if (ctx.config.llm.mode === 'mock') return ''
  const system = '你是开源项目介绍助手。只输出 JSON，不要多余文字。'
  const prompt = [
    `用一句话中文说明这个开源项目是做什么的（面向不了解这个项目的普通用户，说清楚核心功能）。`,
    `输出 JSON：{"summaryZh":"这个项目是做什么的，一句话，中文"}`,
    `项目：${repo}（stars: ${stars}）`,
    `README:\n${readme.slice(0, 3000)}`,
  ].join('\n')
  const raw = await ctx.llm.complete({ model: ctx.config.llm.models.analysis, system, prompt })
  const m = raw.match(/\{[\s\S]*\}/)
  if (!m) return ''
  try {
    const o = JSON.parse(m[0])
    return typeof o.summaryZh === 'string' ? o.summaryZh : ''
  } catch { return '' }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd packages/scout && npx vitest run test/score.test.ts`
Expected: PASS（全部用例）

- [ ] **Step 5: Commit**

```bash
cd "/Users/lizhishaoniange/Documents/开源变现内容工厂"
git add packages/scout/src/score.ts packages/scout/test/score.test.ts
git commit -m "feat(scout): 新增 generateSummaryZh 轻量中文简介生成"
```

---

### Task 2: candidatesNeedingSummary + backfillCandidateSummary

**Files:**
- Modify: `packages/scout/src/scout.ts`
- Test: `packages/scout/test/scout.test.ts`

**Interfaces:**
- Consumes: `generateSummaryZh(ctx, repo, stars, readme): Promise<string>`（Task 1 产出）；`createGithubClient(ctx.config.github)`（已有导入）。
- Produces: `candidatesNeedingSummary(ctx: CoreCtx): number[]`、`backfillCandidateSummary(ctx: CoreCtx, id: number): Promise<void>`——Task 4（server 路由）依赖这两个函数。

- [ ] **Step 1: 写失败测试**

在 `packages/scout/test/scout.test.ts` 文件末尾新增，同时把顶部 import 改成加 `backfillCandidateSummary`、`candidatesNeedingSummary`：

```ts
import { addRepo, backfillCandidateSummary, backfillCategories, candidatesNeedingRescore, candidatesNeedingSummary, cleanupCandidates, scoutBreakouts, scoutCandidates } from '../src/scout'
```

```ts
describe('candidatesNeedingSummary (mock)', () => {
  it('协议 OK 且缺 summaryZh 的被选中；已有 summaryZh / 协议不过 / 未评分的都不选中', async () => {
    await scoutCandidates(ctx) // fixtures 全部入池评分（mock 下 summaryZh 恒为空串）
    const need = candidatesNeedingSummary(ctx)
    const chatwoot: any = ctx.db.prepare("SELECT id FROM candidates WHERE repo='chatwoot/chatwoot'").get()
    expect(need).toContain(chatwoot.id) // mock 评分 summaryZh 是空串，应被选中

    // 手动给它 patch 一个非空 summaryZh，验证不再被选中
    const row: any = ctx.db.prepare("SELECT score_detail FROM candidates WHERE id = ?").get(chatwoot.id)
    const d = JSON.parse(row.score_detail); d.summaryZh = '已经有简介了'
    ctx.db.prepare('UPDATE candidates SET score_detail = ? WHERE id = ?').run(JSON.stringify(d), chatwoot.id)
    expect(candidatesNeedingSummary(ctx)).not.toContain(chatwoot.id)

    const gpl: any = ctx.db.prepare("SELECT id FROM candidates WHERE repo='gpl-example/copyleft-tool'").get()
    expect(candidatesNeedingSummary(ctx)).not.toContain(gpl.id) // 协议不过，从未评分，没有 score_detail
  })
})

describe('backfillCandidateSummary (mock)', () => {
  it('只改 summaryZh，其它评分字段原样保留', async () => {
    await scoutCandidates(ctx)
    const before: any = ctx.db.prepare("SELECT score_detail FROM candidates WHERE repo='chatwoot/chatwoot'").get()
    const beforeDetail = JSON.parse(before.score_detail)
    const id = (ctx.db.prepare("SELECT id FROM candidates WHERE repo='chatwoot/chatwoot'").get() as any).id
    await backfillCandidateSummary(ctx, id)
    const after: any = ctx.db.prepare("SELECT score_detail FROM candidates WHERE repo='chatwoot/chatwoot'").get()
    const afterDetail = JSON.parse(after.score_detail)
    expect(afterDetail.summaryZh).toBe('') // mock 模式下仍是空串（无 LLM），但字段一定存在
    expect(afterDetail.rebrandCost).toBe(beforeDetail.rebrandCost)
    expect(afterDetail.buyerClarity).toBe(beforeDetail.buyerClarity)
    expect(afterDetail.visualAppeal).toBe(beforeDetail.visualAppeal)
    expect(afterDetail.rationale).toBe(beforeDetail.rationale)
    expect(afterDetail.targetBuyer).toBe(beforeDetail.targetBuyer)
    expect(afterDetail.painPoint).toBe(beforeDetail.painPoint)
    expect(afterDetail.category).toBe(beforeDetail.category)
  })
  it('候选不存在 → 抛错', async () => {
    await expect(backfillCandidateSummary(ctx, 999999)).rejects.toThrow(/不存在/)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/scout && npx vitest run test/scout.test.ts -t "candidatesNeedingSummary|backfillCandidateSummary"`
Expected: FAIL（两个函数未从 `../src/scout` 导出）

- [ ] **Step 3: 实现两个函数**

在 `packages/scout/src/scout.ts` 里，`rescoreCandidate` 函数定义结束之后（`/** 候选池低分自动淘汰...` 那段注释、也就是 `cleanupCandidates` 定义之前）插入：

```ts
/** 返回"协议 OK 且 score_detail 里没有 summaryZh"的候选 id 列表，跟 candidatesNeedingRescore 同风格。 */
export function candidatesNeedingSummary(ctx: CoreCtx): number[] {
  const rows = ctx.db.prepare(
    "SELECT id, score_detail FROM candidates WHERE license_ok = 1 AND score_detail IS NOT NULL",
  ).all() as Array<{ id: number; score_detail: string }>
  return rows.filter((r) => {
    try { return !(JSON.parse(r.score_detail) as any)?.summaryZh } catch { return true }
  }).map((r) => r.id)
}

/** 给单个候选补 summaryZh：重抓 README→生成→patch 回 score_detail，不动其它字段。 */
export async function backfillCandidateSummary(ctx: CoreCtx, id: number): Promise<void> {
  const row = ctx.db.prepare('SELECT repo, stars, score_detail FROM candidates WHERE id = ?').get(id) as any
  if (!row) throw new Error(`候选不存在: ${id}`)
  const gh = createGithubClient(ctx.config.github)
  const readme = await gh.fetchReadme(row.repo)
  const summaryZh = await generateSummaryZh(ctx, row.repo, row.stars, readme)
  const d = JSON.parse(row.score_detail)
  d.summaryZh = summaryZh
  ctx.db.prepare('UPDATE candidates SET score_detail = ? WHERE id = ?').run(JSON.stringify(d), id)
}
```

顶部 import 改成加 `generateSummaryZh`（找到现有 `import { ... } from './score'` 那一行，把 `generateSummaryZh` 加进去；若 `scout.ts` 当前是从 `./score` 单独 import 多个具名导出，按字母序插入）。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd packages/scout && npx vitest run test/scout.test.ts`
Expected: PASS（全部用例）

- [ ] **Step 5: Commit**

```bash
cd "/Users/lizhishaoniange/Documents/开源变现内容工厂"
git add packages/scout/src/scout.ts packages/scout/test/scout.test.ts
git commit -m "feat(scout): 新增 candidatesNeedingSummary/backfillCandidateSummary"
```

---

### Task 3: scoutBreakouts 返回 hits 列表

**Files:**
- Modify: `packages/scout/src/scout.ts`
- Test: `packages/scout/test/scout.test.ts`

**Interfaces:**
- Produces: `scoutBreakouts` 返回类型扩展为 `{ found, scored, rejected, added, hits: Array<{ repo: string; url: string }> }`——Task 4（server 路由）依赖 `hits` 字段。

- [ ] **Step 1: 写失败测试**

在 `packages/scout/test/scout.test.ts` 里找到现有 `describe('scoutBreakouts (mock)', ...)` 块，在其内部新增一条 `it`：

```ts
  it('hits 只含协议 OK 的命中项，条数等于 added', async () => {
    const r = await scoutBreakouts(ctx)
    expect(r.hits.length).toBe(r.added)
    expect(r.hits.every((h) => typeof h.repo === 'string' && typeof h.url === 'string')).toBe(true)
    const gplHit = r.hits.find((h) => h.repo === 'gpl-example/copyleft-tool')
    expect(gplHit).toBeUndefined() // 协议不过的不该出现在 hits 里
  })
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/scout && npx vitest run test/scout.test.ts -t "hits 只含协议 OK"`
Expected: FAIL（`r.hits` 是 `undefined`，`.length` 报错或断言失败）

- [ ] **Step 3: 改 `scoutBreakouts` 实现**

`packages/scout/src/scout.ts` 里的 `scoutBreakouts` 函数：

```ts
/** 爆款检测：按「创建时间 ≤ withinDays 天 且 star ≥ minStars」筛新晋高星仓库，走现有换皮/评分流程入池。
 *  手动偶发触发，不做 onlyNew 限制——命中的协议 OK 仓库每次都重新评分覆盖。 */
export async function scoutBreakouts(
  ctx: CoreCtx,
  opts: { minStars?: number; withinDays?: number; limit?: number } = {},
): Promise<{ found: number; scored: number; rejected: number; added: number; hits: Array<{ repo: string; url: string }> }> {
  const gh = createGithubClient(ctx.config.github)
  const minStars = opts.minStars ?? 2000
  const withinDays = opts.withinDays ?? 7
  const limit = opts.limit ?? 30
  const createdAfter = new Date(Date.now() - withinDays * 864e5).toISOString().slice(0, 10)
  const found = await gh.searchBreakouts({ minStars, createdAfter, perPage: limit })

  let scored = 0
  let rejected = 0
  let added = 0
  const hits: Array<{ repo: string; url: string }> = []
  for (const m of found) {
    const ok = isLicenseOk(m.license)
    await ingest(ctx, gh, m, ok)
    if (ok) { scored++; added++; hits.push({ repo: m.repo, url: m.url }) }
    else rejected++
  }
  return { found: found.length, scored, rejected, added, hits }
}
```

（只有函数签名的返回类型、新增的 `hits` 数组声明和 push、以及最终 `return` 语句变了，中间的 `gh.searchBreakouts`/循环主体逻辑不变。）

- [ ] **Step 4: 跑测试确认通过**

Run: `cd packages/scout && npx vitest run test/scout.test.ts`
Expected: PASS（全部用例）

- [ ] **Step 5: Commit**

```bash
cd "/Users/lizhishaoniange/Documents/开源变现内容工厂"
git add packages/scout/src/scout.ts packages/scout/test/scout.test.ts
git commit -m "feat(scout): scoutBreakouts 返回命中仓库列表 hits"
```

---

### Task 4: server 路由（列出命中仓库名 + 补中文简介接口）

**Files:**
- Modify: `packages/server/src/app.ts`
- Test: `packages/server/test/scout-extras.test.ts`（补 hits 日志断言）
- Create: `packages/server/test/backfill-summary.test.ts`

**Interfaces:**
- Consumes: `scoutBreakouts` 返回值新增 `hits` 字段（Task 3 产出）；`candidatesNeedingSummary(ctx)`、`backfillCandidateSummary(ctx, id)`（Task 2 产出，需要从 `@forgecast/scout` 导入）。
- Produces: `POST /api/candidates/backfill-summary` 路由，返回 `{taskId}`——Task 5（前端）依赖此路由。

- [ ] **Step 1: 写失败测试——breakouts 日志含命中仓库名**

在 `packages/server/test/scout-extras.test.ts` 里找到 `describe('POST /api/scout/breakouts (mock)', ...)` 块（若这个 describe 不在这个文件里，用 `grep -rn "scout/breakouts" packages/server/test/*.test.ts` 找到它实际所在的文件，在那个文件里加），在现有"返回 taskId；任务完成后候选入库"用例之后新增一条：

```ts
  it('任务日志包含命中仓库名', async () => {
    const { taskId } = await (await app.request('/api/scout/breakouts', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    })).json() as any
    await runTask(taskId)
    const msgs = queue.get(taskId)!.events.map((e) => e.message).join('\n')
    expect(msgs).toMatch(/🔥/) // 至少一条命中仓库名日志（mock fixtures 里协议 OK 的会全部命中）
  })
```

- [ ] **Step 2: 写失败测试——backfill-summary 路由**

新建文件 `packages/server/test/backfill-summary.test.ts`（照抄 `packages/server/test/rescore-all.test.ts` 的结构）：

```ts
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'
import { createLlmClient, loadConfig, openDb, type CoreCtx } from '@forgecast/core'
import { beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/app'
import { createTaskQueue } from '../src/tasks'

let ctx: CoreCtx, app: ReturnType<typeof createApp>, queue: ReturnType<typeof createTaskQueue>
function wait(ms: number) { return new Promise((r) => setTimeout(r, ms)) }
beforeEach(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-bfs-'))
  const config = loadConfig(root, {}) // llm mock
  ctx = { db: openDb(config.paths.db), config, llm: createLlmClient(config.llm) }
  queue = createTaskQueue()
  app = createApp(ctx, queue)
})
async function runTask(taskId: string) {
  for (let i = 0; i < 100; i++) { await wait(20); const s = queue.get(taskId)!.status; if (s === 'done' || s === 'failed') return }
}

describe('POST /api/candidates/backfill-summary', () => {
  it('mock 模式：返 taskId，任务只提示、不生成（score_detail 除 summaryZh 外不变）', async () => {
    ctx.db.prepare("INSERT INTO candidates (repo,url,license_ok,score,score_detail,status) VALUES ('a/b','u',1,50,?, 'candidate')")
      .run(JSON.stringify({ rebrandCost: 10, targetBuyer: '已评过' })) // 无 summaryZh = 需补
    const { taskId } = await (await app.request('/api/candidates/backfill-summary', { method: 'POST' })).json() as any
    expect(taskId).toBeTruthy()
    await runTask(taskId)
    const msgs = queue.get(taskId)!.events.map((e) => e.message).join(' ')
    expect(msgs).toMatch(/mock/i)
  })
  it('无需补充时提示并结束', async () => {
    ctx.db.prepare("INSERT INTO candidates (repo,url,license_ok,score,score_detail,status) VALUES ('a/b','u',1,50,?, 'candidate')")
      .run(JSON.stringify({ rebrandCost: 10, summaryZh: '已经有了' }))
    const { taskId } = await (await app.request('/api/candidates/backfill-summary', { method: 'POST' })).json() as any
    await runTask(taskId)
    const msgs = queue.get(taskId)!.events.map((e) => e.message).join(' ')
    expect(msgs).toMatch(/无需补充/)
  })
})
```

- [ ] **Step 3: 跑测试确认失败**

Run: `cd packages/server && npx vitest run test/scout-extras.test.ts test/backfill-summary.test.ts`
Expected: FAIL（`/api/candidates/backfill-summary` 404；breakouts 日志断言里没有 `🔥`）

- [ ] **Step 4: 改路由**

`packages/server/src/app.ts` 顶部 import（第 9 行）加上 `backfillCandidateSummary`、`candidatesNeedingSummary`（按字母序插入到现有 `import { addRepo, backfillCategories, candidatesNeedingRescore, deleteProject, generateCandidateIntro, pickCandidate, rescoreCandidate, scoutBreakouts, scoutCandidates } from '@forgecast/scout'` 这一行里）。

`app.post('/api/scout/breakouts', ...)` 路由（约第 397 行）里的 `.then((r) => {...})` 回调，从：

```ts
    }).then((r) => { log(`发现 ${r.found} 个爆款候选，评分 ${r.scored}，协议不过 ${r.rejected}`); return r }))
```

改成：

```ts
    }).then((r) => {
      log(`发现 ${r.found} 个爆款候选，评分 ${r.scored}，协议不过 ${r.rejected}`)
      for (const h of r.hits) log(`  🔥 ${h.repo}`)
      return r
    }))
```

在 `app.post('/api/candidates/rescore-all', ...)` 路由结束的 `})` 之后紧接着加：

```ts
  app.post('/api/candidates/backfill-summary', (c) => {
    const taskId = queue.enqueue(async (log) => {
      if (ctx.config.llm.mode === 'mock') { log('⚠ 当前为 mock 模式，中文简介不会真生成；请先到「设置」把大模型切 live 并填 key'); return }
      const need = candidatesNeedingSummary(ctx)
      if (!need.length) { log('无需补充：候选都已有中文简介'); return }
      log(`共 ${need.length} 个候选需补中文简介，开始…`)
      let ok = 0, fail = 0
      for (const [i, id] of need.entries()) {
        const repo = (ctx.db.prepare('SELECT repo FROM candidates WHERE id = ?').get(id) as any)?.repo ?? id
        log(`生成中 ${i + 1}/${need.length}：${repo}`)
        try { await backfillCandidateSummary(ctx, id); ok++ } catch (e) { fail++; log(`⚠ ${repo} 生成失败：${e instanceof Error ? e.message : String(e)}`) }
      }
      log(`完成：补充 ${ok} 个，失败跳过 ${fail} 个`)
    })
    return c.json({ taskId })
  })
```

- [ ] **Step 5: 跑测试确认通过**

Run: `cd packages/server && npx vitest run test/scout-extras.test.ts test/backfill-summary.test.ts`
Expected: PASS（全部用例）

- [ ] **Step 6: Commit**

```bash
cd "/Users/lizhishaoniange/Documents/开源变现内容工厂"
git add packages/server/src/app.ts packages/server/test/scout-extras.test.ts packages/server/test/backfill-summary.test.ts
git commit -m "feat(server): 爆款日志列命中仓库名 + 新增 POST /api/candidates/backfill-summary"
```

---

### Task 5: ScoutPage "补中文简介" 按钮

**Files:**
- Modify: `apps/web/src/pages/ScoutPage.tsx`

**Interfaces:**
- Consumes: `POST /api/candidates/backfill-summary`（Task 4 产出的路由，返回 `{taskId}`）；`subscribeTask`（已从 `../api` 导入）。

- [ ] **Step 1: 加 `backfillingSummary` 状态与函数**

在现有 `rescoreAll()` 函数定义结束之后（`catOf`/`backfillCats` 定义之前），新增，结构照抄 `rescoreAll()`（去掉它的 `window.confirm` 弹窗和候选数统计，因为这个操作成本更轻——单次轻量 LLM 调用，不用像"全部重新评分"那样弹确认框）：

```ts
  const [backfillingSummary, setBackfillingSummary] = useState(false)
  async function backfillSummary() {
    if (backfillingSummary || scanning || scanningBreakouts || rescoringAll) return
    setBackfillingSummary(true); setLogs([])
    try {
      const { taskId } = await api<{ taskId: string }>('/api/candidates/backfill-summary', { method: 'POST' })
      subscribeTask(taskId, (e) => {
        setLogs((l) => [...l, e.message]); logRef.current?.scrollTo({ top: 999999 })
        if (e.type === 'done' || e.type === 'error') { setBackfillingSummary(false); qc.invalidateQueries({ queryKey: ['candidates'] }) }
      })
    } catch (err) { setLogs((l) => [...l, `❌ ${err instanceof Error ? err.message : String(err)}`]); setBackfillingSummary(false) }
  }
```

- [ ] **Step 2: 加按钮 + 更新所有按钮的 disabled 条件**

在按钮组里，把现有四个按钮（"抓取候选"、"🔥 找爆款"、"全部重新评分"、"分类回填"）的 `disabled` 属性，从 `disabled={scanning || scanningBreakouts || rescoringAll}` 全部改成 `disabled={scanning || scanningBreakouts || rescoringAll || backfillingSummary}`，并且在"分类回填"按钮之后新增一个"补中文简介"按钮：

```tsx
        <button className="btn-ink px-4 py-2 text-sm disabled:opacity-50" disabled={scanning || scanningBreakouts || rescoringAll || backfillingSummary} onClick={backfillSummary}>
          {backfillingSummary ? '生成中…' : '补中文简介'}
        </button>
```

（四个原有按钮 + 这个新按钮，一共五个按钮的 `disabled` 都要是同一个完整表达式 `scanning || scanningBreakouts || rescoringAll || backfillingSummary`——这是吸取上一轮"抓取候选"漏加 `scanningBreakouts` 导致并发扫描漏洞的教训，这次一次性全部串进去，不要遗漏任何一个。）

- [ ] **Step 3: 类型检查**

Run: `cd "/Users/lizhishaoniange/Documents/开源变现内容工厂" && pnpm --filter web exec tsc --noEmit`
Expected: 无新增类型错误

- [ ] **Step 4: 浏览器人工走查**

1. `export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH"`
2. 确认 dev server 是最新代码（若之前启动的进程较旧，参照本仓库已知的"tsx 无 watch 模式不会热更新"问题，需要重启 `pnpm dev`/`npx tsx cli.ts dev` 进程）
3. 浏览器打开找项目页，点"🔥 找爆款"，确认扫描完成后日志区域除了汇总行之外，还能看到 `🔥 <repo名>` 逐行列出
4. 点"补中文简介"，确认：mock 模式下日志提示"当前为 mock 模式…"；若当前是 live 模式（本仓库设置页里配了真 key），确认日志显示进度、完成后有候选卡片描述变成中文
5. 确认五个按钮在任一操作进行中都正确禁用，不能同时触发多个任务

- [ ] **Step 5: Commit**

```bash
cd "/Users/lizhishaoniange/Documents/开源变现内容工厂"
git add apps/web/src/pages/ScoutPage.tsx
git commit -m "feat(web): 找项目页加「补中文简介」按钮，五按钮并发状态统一"
```

---

## 验证（全部任务完成后）

1. `export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH"`
2. `pnpm test` 全仓回归（重点看 `@forgecast/scout`、`@forgecast/server`）
3. `pnpm --filter web exec tsc --noEmit` + `pnpm --filter web build`
4. 浏览器端到端：重启 dev server（本仓库无 watch 模式，必须重启才能生效）→ 找项目页 → "🔥 找爆款"看日志列仓库名 → "补中文简介"看候选卡片补上中文
