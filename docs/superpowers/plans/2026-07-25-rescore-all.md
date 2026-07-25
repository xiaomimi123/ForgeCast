# 全部重新评分 实施计划（看板改进 A）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 看板加「全部重新评分」按钮，后台把还没真评过的候选批量用 LLM 真评分，带进度、fail-soft、开始前确认。

**Architecture:** scout 加纯查询 `candidatesNeedingRescore`（找 targetBuyer 为空的候选）→ server `POST /api/candidates/rescore-all` 排队任务遍历调 `rescoreCandidate`（mock 早返回、逐个 fail-soft、进度日志）→ web 看板加按钮（confirm + 订阅进度 + 刷新）。

**Tech Stack:** TypeScript + pnpm monorepo + vitest + Hono(server) + React/react-query(web)。

## Global Constraints

- 只评"未真评过"：`score_detail.targetBuyer` 为空（空串/缺字段/JSON 坏/NULL 都算需评）。
- mock 模式：任务不遍历，只 log 提示切 live。
- 顺序跑（不并发，避免 DeepSeek 限流）；单候选失败 → log ⚠ + 跳过 + 继续（fail-soft）。
- 复用已有 `rescoreCandidate(ctx, id): Promise<void>`（scout）与任务队列 `queue.enqueue((log)=>Promise)`。
- 前端开始前 `window.confirm`；进度复用看板现有 logs UI；完成 invalidate `['candidates']`。
- 中文注释、中文提交、严格 TDD、Node22（`nvm use 22.23.1`，pnpm 用 `corepack pnpm`）。

---

### Task 1: scout.candidatesNeedingRescore（纯查询助手）

**Files:**
- Modify: `packages/scout/src/scout.ts`
- Test: `packages/scout/test/scout.test.ts`

**Interfaces:**
- Consumes: 无
- Produces: `candidatesNeedingRescore(ctx: CoreCtx): number[]`——返回 `score_detail.targetBuyer` 为空的候选 id 列表。

- [ ] **Step 1: 写失败测试**

追加到 `packages/scout/test/scout.test.ts`（导入处补 `candidatesNeedingRescore`）：

```typescript
describe('candidatesNeedingRescore', () => {
  it('只返回 targetBuyer 为空/缺/坏JSON/NULL 的候选 id', () => {
    const ins = ctx.db.prepare("INSERT INTO candidates (repo,url,license_ok,score,score_detail,status) VALUES (?,?,1,50,?, 'candidate')")
    ins.run('a/done', 'u1', JSON.stringify({ rebrandCost: 10, targetBuyer: '律所老板' })) // 已真评
    ins.run('a/empty', 'u2', JSON.stringify({ rebrandCost: 10, targetBuyer: '' }))          // 空串→需评
    ins.run('a/missing', 'u3', JSON.stringify({ rebrandCost: 10 }))                          // 缺字段→需评
    ins.run('a/bad', 'u4', '{坏json')                                                        // 坏JSON→需评
    ins.run('a/null', 'u5', null)                                                            // NULL→需评
    const need = candidatesNeedingRescore(ctx)
    const repos = need.map((id) => (ctx.db.prepare('SELECT repo FROM candidates WHERE id=?').get(id) as any).repo).sort()
    expect(repos).toEqual(['a/bad', 'a/empty', 'a/missing', 'a/null']) // 不含 a/done
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `corepack pnpm --filter @forgecast/scout test scout`
Expected: FAIL —— `candidatesNeedingRescore` 未导出。

- [ ] **Step 3: 实现**

`packages/scout/src/scout.ts` 加（放在 `rescoreCandidate` 附近；`CoreCtx` 已 import）：

```typescript
/** 返回"还没真评过"的候选 id：score_detail 里 targetBuyer 为空（空串/缺字段/坏JSON/NULL 都算需评）。 */
export function candidatesNeedingRescore(ctx: CoreCtx): number[] {
  const rows = ctx.db.prepare('SELECT id, score_detail FROM candidates').all() as Array<{ id: number; score_detail: string | null }>
  return rows.filter((r) => {
    if (!r.score_detail) return true
    try { return !(JSON.parse(r.score_detail) as any)?.targetBuyer } catch { return true }
  }).map((r) => r.id)
}
```

（`export * from './scout'` 已在 `packages/scout/src/index.ts`，自动导出。）

- [ ] **Step 4: 跑测试 + tsc**

Run: `corepack pnpm --filter @forgecast/scout test scout`、`npx tsc -p packages/scout/tsconfig.json --noEmit`
Expected: 全绿、tsc 无输出。

- [ ] **Step 5: 提交**

```bash
git add packages/scout
git commit -m "feat(scout): candidatesNeedingRescore 找未真评的候选"
```

---

### Task 2: 后端 POST /api/candidates/rescore-all

**Files:**
- Modify: `packages/server/src/app.ts`
- Test: `packages/server/test/rescore-all.test.ts`（新建）

**Interfaces:**
- Consumes: `candidatesNeedingRescore`(Task1)、`rescoreCandidate`（scout，已有）、`queue.enqueue`
- Produces: REST `POST /api/candidates/rescore-all` → `{ taskId }`

- [ ] **Step 1: 写失败测试**

新建 `packages/server/test/rescore-all.test.ts`（仿 video.test.ts 的 runTask 轮询）：

```typescript
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'
import { createLlmClient, loadConfig, openDb, type CoreCtx } from '@forgecast/core'
import { beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/app'
import { createTaskQueue } from '../src/tasks'

let ctx: CoreCtx, app: ReturnType<typeof createApp>, queue: ReturnType<typeof createTaskQueue>
function wait(ms: number) { return new Promise((r) => setTimeout(r, ms)) }
beforeEach(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-rsa-'))
  const config = loadConfig(root, {}) // llm mock
  ctx = { db: openDb(config.paths.db), config, llm: createLlmClient(config.llm) }
  queue = createTaskQueue()
  app = createApp(ctx, queue)
})
async function runTask(taskId: string) {
  for (let i = 0; i < 100; i++) { await wait(20); const s = queue.get(taskId)!.status; if (s === 'done' || s === 'failed') return }
}

describe('POST /api/candidates/rescore-all', () => {
  it('mock 模式：返 taskId，任务只提示、不评分（候选 score_detail 不变）', async () => {
    ctx.db.prepare("INSERT INTO candidates (repo,url,license_ok,score,score_detail,status) VALUES ('a/b','u',1,50,?, 'candidate')")
      .run(JSON.stringify({ rebrandCost: 10 })) // 无 targetBuyer = 需评
    const { taskId } = await (await app.request('/api/candidates/rescore-all', { method: 'POST' })).json() as any
    expect(taskId).toBeTruthy()
    await runTask(taskId)
    // 候选未被评（仍无 targetBuyer）
    const sd = (ctx.db.prepare("SELECT score_detail FROM candidates WHERE repo='a/b'").get() as any).score_detail
    expect(JSON.parse(sd).targetBuyer).toBeUndefined()
    // 任务日志含 mock 提示
    const msgs = queue.get(taskId)!.events.map((e) => e.message).join(' ')
    expect(msgs).toMatch(/mock/i)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `corepack pnpm --filter @forgecast/server test rescore-all`
Expected: FAIL —— 路由不存在（404/405）。

- [ ] **Step 3: 实现路由**

`packages/server/src/app.ts`：line 9 的 `import { ... } from '@forgecast/scout'` 追加 `candidatesNeedingRescore`。在 `app.post('/api/candidates/:id/rescore'` 路由**之前**（即候选相关路由区）加：

```typescript
  app.post('/api/candidates/rescore-all', (c) => {
    const taskId = queue.enqueue(async (log) => {
      if (ctx.config.llm.mode === 'mock') { log('⚠ 当前为 mock 模式，真评分不生效；请先到「设置」把大模型切 live 并填 key'); return }
      const need = candidatesNeedingRescore(ctx)
      if (!need.length) { log('无需评分：候选都已真评过'); return }
      log(`共 ${need.length} 个候选需真评分，开始…`)
      let ok = 0, fail = 0
      for (const [i, id] of need.entries()) {
        const repo = (ctx.db.prepare('SELECT repo FROM candidates WHERE id = ?').get(id) as any)?.repo ?? id
        log(`评分中 ${i + 1}/${need.length}：${repo}`)
        try { await rescoreCandidate(ctx, id); ok++ } catch (e) { fail++; log(`⚠ ${repo} 评分失败：${e instanceof Error ? e.message : String(e)}`) }
      }
      log(`完成：真评 ${ok} 个，失败跳过 ${fail} 个`)
    })
    return c.json({ taskId })
  })
```

- [ ] **Step 4: 跑测试 + tsc + 全量 server 不回归**

Run: `corepack pnpm --filter @forgecast/server test rescore-all`、`corepack pnpm --filter @forgecast/server test`、`npx tsc -p packages/server/tsconfig.json --noEmit`
Expected: 全绿、tsc 无输出。

- [ ] **Step 5: 提交**

```bash
git add packages/server
git commit -m "feat(server): POST /api/candidates/rescore-all 批量真评分（mock提示/fail-soft/进度）"
```

---

### Task 3: Web 看板「全部重新评分」按钮

**Files:**
- Modify: `apps/web/src/pages/BoardPage.tsx`
- 手动浏览器走查（主控里程碑）

**Interfaces:**
- Consumes: REST `POST /api/candidates/rescore-all`（Task2）；`subscribeTask`（已有）
- Produces: 无

- [ ] **Step 1: 加 rescoreAll 函数 + 按钮**

`apps/web/src/pages/BoardPage.tsx`：
1. 组件内加状态 + 函数（`scout()`/`scanning`/`logs`/`logRef`/`qc` 已有；`CandidateCard` 里的 `parseDetail` 是私有的，这里直接用 `score_detail` 判 targetBuyer）：

```tsx
  const [rescoringAll, setRescoringAll] = useState(false)
  async function rescoreAll() {
    if (rescoringAll || scanning) return
    // 估算未评数：score_detail 里没有非空 targetBuyer 的
    const n = (candidates.data ?? []).filter((c) => {
      try { return !(c.score_detail && (JSON.parse(c.score_detail) as any)?.targetBuyer) } catch { return true }
    }).length
    if (n === 0) { alert('候选都已真评过，无需批量评分'); return }
    if (!window.confirm(`将对 ${n} 个未评候选真评分，消耗 key 额度、耗时较长（每个几秒），继续？`)) return
    setRescoringAll(true); setLogs([])
    try {
      const { taskId } = await api<{ taskId: string }>('/api/candidates/rescore-all', { method: 'POST' })
      subscribeTask(taskId, (e) => {
        setLogs((l) => [...l, e.message]); logRef.current?.scrollTo({ top: 999999 })
        if (e.type === 'done' || e.type === 'error') { setRescoringAll(false); qc.invalidateQueries({ queryKey: ['candidates'] }) }
      })
    } catch (err) { setLogs((l) => [...l, `❌ ${err instanceof Error ? err.message : String(err)}`]); setRescoringAll(false) }
  }
```

2. 在「抓取候选」按钮旁加「全部重新评分」按钮（同一 flex 行内，`共 N 个候选` span 之前或之后）：

```tsx
        <button className="rounded border px-4 py-2 text-sm disabled:opacity-50" disabled={scanning || rescoringAll} onClick={rescoreAll}>
          {rescoringAll ? '评分中…' : '全部重新评分'}
        </button>
```

（注：`Candidate` 类型需有 `score_detail` 字段——它来自 `/api/candidates` 返回，`apps/web/src/api.ts` 的 `Candidate` 应已含；若 TS 报缺字段，在 `Candidate` interface 补 `score_detail: string | null`。）

- [ ] **Step 2: 构建校验**

Run: `corepack pnpm --filter web build`
Expected: 构建成功、无 TS 报错。

- [ ] **Step 3: 提交**

```bash
git add apps/web
git commit -m "feat(web): 看板「全部重新评分」按钮（确认+进度+刷新）"
```

- [ ] **Step 4: 手动浏览器走查（主控里程碑）**

主控起 dev（Node22，LLM 已配 live DeepSeek）：看板点「全部重新评分」→ 确认弹窗 → 进度日志"评分中 i/N"滚动 → 完成后候选分数/痛点更新、按新分重排；mock 模式点则日志提示切 live。可只放少量候选或中途观察（真评耗时）。

---

## 完成标准
- `candidatesNeedingRescore` + rescore-all 路由有测试全绿；tsc 干净；全量 server 不回归。
- web 构建过；看板「全部重新评分」确认后跑批量、进度可见、完成刷新。
- mock 模式点则提示切 live、不空跑。

## 已知非纯代码成本
- Task3 Step4 主控真跑需 live DeepSeek（耗时、耗额度）；批量真遍历/fail-soft 靠此里程碑验证。
