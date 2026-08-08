# 找项目板块升级 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 找项目板块加收藏、每日自动抓取（server 内置调度、只评新 repo）、每日新增视图、右侧抽屉详情、四列卡片布局。

**Architecture:** candidates 加 `favorite` 列 + settings 四个 auto_scout key；scout 加 `onlyNew` 模式（已有候选只刷元数据保留评分）；server 新 scheduler.ts（每分钟判定 + 启动补跑）+ favorite/auto-status 路由；web 重写 CandidateCard（四列）、CandidateDetailModal 改造成 CandidateDrawer、ScoutPage 三 tab 重构。

**Tech Stack:** 全部现有：TypeScript + better-sqlite3 + Hono + vitest + React + react-query。无新依赖。

**Spec:** `docs/superpowers/specs/2026-08-09-scout-board-upgrade-design.md`

## Global Constraints

- **Node 22**：本仓 better-sqlite3 按 Node 22 编译（.nvmrc=22）。跑任何 pnpm 命令前先 `export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH"`（worktree 新装依赖也用它）。
- **server 路由位置红线**：新路由必须注册在 app.ts 的 webDist 静态托管块（`app.get('/*', ...)`）**之前**——Hono 按注册顺序派发，注册在兜底之后生产环境会被遮蔽（此坑已发生过一次，有回归测试 `packages/server/test/tailor.test.ts` 为证）。
- 每个后端任务 TDD：先写失败测试再实现；web 无单测（tsc --noEmit + vite build 验证）。
- 不改评分规则本身（协议白名单/三维评分维持现状）。
- 中文 UI 文案；注释风格跟随现有文件。
- commit message 末尾带 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`。

---

### Task 1: core — favorite 列 + settings 新 key

**Files:**
- Modify: `packages/core/src/db.ts`（文件尾 ensureColumn 区）、`packages/core/src/settings.ts`（SETTING_KEYS）
- Test: `packages/core/test/db.test.ts`、`packages/core/test/settings.test.ts`（各追加用例）

**Interfaces:**
- Produces: `candidates.favorite INTEGER DEFAULT 0` 列；SETTING_KEYS 新增 `'auto_scout' | 'auto_scout_time' | 'auto_scout_last_run' | 'auto_scout_last_result'`（getAllSettings/setSettings 自动支持，server 的 PUT /api/settings 白名单循环自动放行）

- [ ] **Step 1: 写失败测试**

db.test.ts 追加（打开 db 的方式照抄本文件现有用例）：

```ts
it('candidates.favorite 列存在且默认 0', () => {
  db.prepare("INSERT INTO candidates (repo, url) VALUES ('a/b', 'u')").run()
  const row = db.prepare("SELECT favorite FROM candidates WHERE repo = 'a/b'").get() as any
  expect(row.favorite).toBe(0)
})
```

settings.test.ts 追加（写法照抄本文件现有往返用例）：

```ts
it('auto_scout 系列 key 在白名单内可往返', () => {
  setSettings(db, { auto_scout: 'off', auto_scout_time: '09:30', auto_scout_last_run: '2026-08-09', auto_scout_last_result: '{"added":3}' })
  const s = getAllSettings(db)
  expect(s.auto_scout).toBe('off')
  expect(s.auto_scout_time).toBe('09:30')
  expect(s.auto_scout_last_run).toBe('2026-08-09')
  expect(s.auto_scout_last_result).toBe('{"added":3}')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @forgecast/core test`
Expected: FAIL（favorite 列不存在；auto_scout 不在白名单被跳过）

- [ ] **Step 3: 实现**

db.ts 文件尾 ensureColumn 区追加：

```ts
  // 迁移：候选收藏标记（scout UPSERT 不含此列，每日自动抓取不会覆盖收藏）
  ensureColumn(db, 'candidates', 'favorite', 'INTEGER DEFAULT 0')
```

settings.ts 的 SETTING_KEYS 追加一行：

```ts
  'auto_scout', 'auto_scout_time', 'auto_scout_last_run', 'auto_scout_last_result',
```

（applyStoredSettings 不用动——这四个 key 不是 config 字段，由 scheduler/路由直接读写。）

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @forgecast/core test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src packages/core/test
git commit -m "feat(core): candidates.favorite 列 + auto_scout settings key"
```

---

### Task 2: scout — onlyNew 模式 + added 统计

**Files:**
- Modify: `packages/scout/src/scout.ts`
- Test: `packages/scout/test/scout.test.ts`（新文件）

**Interfaces:**
- Consumes: Task 1 的 favorite 列（不直接用，但 UPSERT 不碰它）
- Produces: `scoutCandidates(ctx, opts)` 的 `opts` 增加 `onlyNew?: boolean`；返回值增加 `added: number`（= 本次运行前库里不存在、且协议可商用的新入库 repo 数）。onlyNew 时已存在的 repo 只刷新元数据（url/description/license/license_ok/stars/last_commit），`score/score_detail/tech_stack/favorite/status` 全部保持旧值。

- [ ] **Step 1: 写失败测试 scout.test.ts**

```ts
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createLlmClient, loadConfig, openDb, type CoreCtx } from '@forgecast/core'
import { beforeEach, describe, expect, it } from 'vitest'
import { candidateFixtures } from '../src/fixtures/candidate-fixtures'
import { isLicenseOk } from '../src/license'
import { scoutCandidates } from '../src/scout'

let ctx: CoreCtx
beforeEach(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-scout-'))
  const config = loadConfig(root, {})
  ctx = { db: openDb(config.paths.db), config, llm: createLlmClient(config.llm) }
})

const okCount = candidateFixtures.filter((f) => isLicenseOk(f.license)).length

describe('scoutCandidates onlyNew', () => {
  it('已存在候选：保留评分/收藏只刷元数据；新候选照常评分；added 只数新入库的可商用项', async () => {
    const first = candidateFixtures.find((f) => isLicenseOk(f.license))!
    ctx.db.prepare(
      "INSERT INTO candidates (repo, url, license, license_ok, stars, score, score_detail, favorite, status) VALUES (?, ?, ?, 1, 1, 99, '{\"targetBuyer\":\"真评\"}', 1, 'candidate')",
    ).run(first.repo, first.url, first.license)
    const r = await scoutCandidates(ctx, { onlyNew: true })
    const row = ctx.db.prepare('SELECT stars, score, score_detail, favorite FROM candidates WHERE repo = ?').get(first.repo) as any
    expect(row.score).toBe(99)                                     // 评分未被洗
    expect(JSON.parse(row.score_detail).targetBuyer).toBe('真评')
    expect(row.favorite).toBe(1)                                   // 收藏未被洗
    expect(row.stars).toBe(first.stars)                            // 元数据已刷新（seed 时是 1）
    expect(r.added).toBe(okCount - 1)                              // 排除已存在的 first
    // 新入库的可商用候选都评了分
    const fresh = ctx.db.prepare('SELECT score FROM candidates WHERE repo != ? AND license_ok = 1').all(first.repo) as any[]
    expect(fresh.length).toBe(okCount - 1)
    for (const f of fresh) expect(f.score).not.toBeNull()
  })
  it('全新库跑 onlyNew：全部视为新项，added = 可商用 fixture 数', async () => {
    const r = await scoutCandidates(ctx, { onlyNew: true })
    expect(r.added).toBe(okCount)
  })
  it('非 onlyNew 行为不变，也返回 added', async () => {
    await scoutCandidates(ctx, {})
    const r2 = await scoutCandidates(ctx, {})   // 第二次全是已存在
    expect(r2.added).toBe(0)
    expect(r2.found).toBe(candidateFixtures.length)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @forgecast/scout test`
Expected: FAIL（onlyNew/added 不存在——TS 编译错或断言失败）

- [ ] **Step 3: 实现**

scout.ts：UPSERT 常量旁加元数据-only 变体：

```ts
// onlyNew 模式下已存在候选只刷元数据：score/score_detail/tech_stack/favorite/status 保持旧值
// （保护 live 真评分不被 mock 启发式洗掉，也不重复烧 LLM 额度）
const UPSERT_META = `INSERT INTO candidates (repo, url, description, license, license_ok, stars, last_commit, status)
VALUES (@repo, @url, @description, @license, @license_ok, @stars, @last_commit, 'candidate')
ON CONFLICT(repo) DO UPDATE SET url=excluded.url, description=excluded.description, license=excluded.license, license_ok=excluded.license_ok,
  stars=excluded.stars, last_commit=excluded.last_commit`
```

`scoutCandidates` 整体替换为：

```ts
/** 搜索 topic 白名单 → 去重 → 协议 gate → 过关者按 star 取 Top-limit 抓 README 评分 → 入池。
 *  onlyNew：已存在的 repo 只刷元数据（不评分不覆盖旧评分），只有新 repo 进入评分池。 */
export async function scoutCandidates(
  ctx: CoreCtx,
  opts: { topics?: string[]; limit?: number; pushedAfter?: string; onlyNew?: boolean } = {},
): Promise<{ found: number; scored: number; rejected: number; added: number }> {
  const gh = createGithubClient(ctx.config.github)
  const topics = opts.topics ?? DEFAULT_TOPICS
  const limit = opts.limit ?? 30
  const pushedAfter = opts.pushedAfter ?? new Date(Date.now() - 183 * 864e5).toISOString().slice(0, 10)
  const found = await gh.searchRepos(topics, { minStars: 300, pushedAfter, perTopic: 20 })

  const existing = new Set(
    (ctx.db.prepare('SELECT repo FROM candidates').all() as Array<{ repo: string }>).map((r) => r.repo),
  )
  const isNew = (m: RepoMeta) => !existing.has(m.repo)
  const scorePool = found
    .filter((m) => isLicenseOk(m.license) && (!opts.onlyNew || isNew(m)))
    .sort((a, b) => b.stars - a.stars)
  const toScore = new Set(scorePool.slice(0, limit).map((m) => m.repo))

  let scored = 0
  let rejected = 0
  let added = 0
  for (const m of found) {
    const ok = isLicenseOk(m.license)
    if (opts.onlyNew && !isNew(m)) {
      ctx.db.prepare(UPSERT_META).run({
        repo: m.repo, url: m.url, description: m.description, license: m.license,
        license_ok: ok ? 1 : 0, stars: m.stars, last_commit: m.lastCommit,
      })
    } else {
      const willScore = toScore.has(m.repo)
      await ingest(ctx, gh, m, willScore)
      if (willScore) scored++
      if (isNew(m) && ok) added++
    }
    if (!ok) rejected++
  }
  return { found: found.length, scored, rejected, added }
}
```

- [ ] **Step 4: 跑测试确认通过（全包，防回归）**

Run: `pnpm --filter @forgecast/scout test`
Expected: PASS（含既有用例）

- [ ] **Step 5: Commit**

```bash
git add packages/scout/src/scout.ts packages/scout/test/scout.test.ts
git commit -m "feat(scout): onlyNew 模式(已存在候选保留评分只刷元数据) + added 统计"
```

---

### Task 3: server — 每日自动调度 scheduler

**Files:**
- Create: `packages/server/src/scheduler.ts`
- Modify: `packages/server/src/index.ts`（启动调度）
- Test: `packages/server/test/scheduler.test.ts`（新文件）

**Interfaces:**
- Consumes: Task 1 settings key、Task 2 `scoutCandidates(ctx, {onlyNew:true})` 与其返回 `{found,scored,rejected,added}`
- Produces:
  - `localDate(d: Date): string`（本地 YYYY-MM-DD）
  - `readAutoScoutCfg(db): { enabled: boolean; time: string; lastRunDate: string }`（默认 on/08:00，time 非法回落 08:00）
  - `shouldAutoScout(now: Date, cfg): boolean`
  - `runAutoScout(ctx, scout?): Promise<void>`（scout 参数仅测试注入）
  - `startAutoScout(ctx, opts?: { intervalMs?: number; scout?: ScoutFn }): () => void`（返回停止函数）

- [ ] **Step 1: 写失败测试 scheduler.test.ts**

```ts
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createLlmClient, getAllSettings, loadConfig, openDb, setSettings, type CoreCtx } from '@forgecast/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { localDate, readAutoScoutCfg, runAutoScout, shouldAutoScout, startAutoScout } from '../src/scheduler'

let ctx: CoreCtx
beforeEach(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-sched-'))
  const config = loadConfig(root, {})
  ctx = { db: openDb(config.paths.db), config, llm: createLlmClient(config.llm) }
})

describe('shouldAutoScout', () => {
  const at = (h: number, m: number) => { const d = new Date(); d.setHours(h, m, 0, 0); return d }
  it('关着不跑', () => {
    expect(shouldAutoScout(at(9, 0), { enabled: false, time: '08:00', lastRunDate: '' })).toBe(false)
  })
  it('未到时间不跑', () => {
    expect(shouldAutoScout(at(7, 59), { enabled: true, time: '08:00', lastRunDate: '' })).toBe(false)
  })
  it('到点且今天没跑过 → 跑（含补跑：远超时间点也算）', () => {
    expect(shouldAutoScout(at(8, 0), { enabled: true, time: '08:00', lastRunDate: '' })).toBe(true)
    expect(shouldAutoScout(at(23, 0), { enabled: true, time: '08:00', lastRunDate: '' })).toBe(true)
  })
  it('今天已跑不再跑；昨天跑过今天照跑', () => {
    const now = at(9, 0)
    expect(shouldAutoScout(now, { enabled: true, time: '08:00', lastRunDate: localDate(now) })).toBe(false)
    expect(shouldAutoScout(now, { enabled: true, time: '08:00', lastRunDate: '2000-01-01' })).toBe(true)
  })
})

describe('readAutoScoutCfg', () => {
  it('默认 on/08:00；time 非法回落 08:00；off 生效', () => {
    expect(readAutoScoutCfg(ctx.db)).toEqual({ enabled: true, time: '08:00', lastRunDate: '' })
    setSettings(ctx.db, { auto_scout: 'off', auto_scout_time: 'abc', auto_scout_last_run: '2026-08-08' })
    expect(readAutoScoutCfg(ctx.db)).toEqual({ enabled: false, time: '08:00', lastRunDate: '2026-08-08' })
    setSettings(ctx.db, { auto_scout_time: '21:30' })
    expect(readAutoScoutCfg(ctx.db).time).toBe('21:30')
  })
})

describe('runAutoScout', () => {
  it('成功：last_run=今天、last_result 记结果', async () => {
    await runAutoScout(ctx, async () => ({ found: 5, scored: 2, rejected: 1, added: 2 }))
    const s = getAllSettings(ctx.db)
    expect(s.auto_scout_last_run).toBe(localDate(new Date()))
    expect(JSON.parse(s.auto_scout_last_result!)).toMatchObject({ added: 2 })
  })
  it('失败：error 记入 last_result，last_run 仍标今天（次日才重试，避免整天打限流）', async () => {
    await runAutoScout(ctx, async () => { throw new Error('GitHub 限流') })
    const s = getAllSettings(ctx.db)
    expect(s.auto_scout_last_run).toBe(localDate(new Date()))
    expect(JSON.parse(s.auto_scout_last_result!).error).toMatch(/限流/)
  })
  it('默认走真 scoutCandidates（mock 全链路）：候选入库', async () => {
    await runAutoScout(ctx)
    const n = (ctx.db.prepare('SELECT COUNT(*) AS n FROM candidates').get() as any).n
    expect(n).toBeGreaterThan(0)
  })
})

describe('startAutoScout', () => {
  it('启动即补跑（到点未跑时）；停止函数可用', async () => {
    setSettings(ctx.db, { auto_scout_time: '00:00' })
    const spy = vi.fn(async () => ({ found: 0, scored: 0, rejected: 0, added: 0 }))
    const stop = startAutoScout(ctx, { intervalMs: 3600_000, scout: spy })
    await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(1))
    stop()
  })
  it('关着则不跑', async () => {
    setSettings(ctx.db, { auto_scout: 'off', auto_scout_time: '00:00' })
    const spy = vi.fn(async () => ({ found: 0, scored: 0, rejected: 0, added: 0 }))
    const stop = startAutoScout(ctx, { intervalMs: 3600_000, scout: spy })
    await new Promise((r) => setTimeout(r, 50))
    expect(spy).not.toHaveBeenCalled()
    stop()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @forgecast/server test`
Expected: FAIL（scheduler.ts 不存在）

- [ ] **Step 3: 实现 scheduler.ts + index.ts 挂载**

`packages/server/src/scheduler.ts`：

```ts
import type Database from 'better-sqlite3'
import { getAllSettings, setSettings, type CoreCtx } from '@forgecast/core'
import { scoutCandidates } from '@forgecast/scout'

type ScoutFn = (ctx: CoreCtx, opts: { onlyNew: boolean }) => Promise<{ found: number; scored: number; rejected: number; added: number }>

export interface AutoScoutCfg { enabled: boolean; time: string; lastRunDate: string }

/** 本地时区 YYYY-MM-DD（sv-SE 格式恰好是 ISO 日期样式） */
export function localDate(d: Date): string {
  return d.toLocaleDateString('sv-SE')
}

export function readAutoScoutCfg(db: Database.Database): AutoScoutCfg {
  const s = getAllSettings(db)
  return {
    enabled: (s.auto_scout ?? 'on') !== 'off',
    time: /^\d{1,2}:\d{2}$/.test(s.auto_scout_time ?? '') ? s.auto_scout_time! : '08:00',
    lastRunDate: s.auto_scout_last_run ?? '',
  }
}

/** 今天（本地日期）还没跑 && 已过设定时间 → 该跑。server 启动时也用它判定，天然支持当天补跑。 */
export function shouldAutoScout(now: Date, cfg: AutoScoutCfg): boolean {
  if (!cfg.enabled) return false
  if (cfg.lastRunDate === localDate(now)) return false
  const [h, m] = cfg.time.split(':').map(Number)
  const target = new Date(now)
  target.setHours(h || 0, m || 0, 0, 0)
  return now >= target
}

/** 跑一次每日抓取（onlyNew）。失败也把 last_run 标为今天——整天每分钟重试只会连续打限流，次日再试。 */
export async function runAutoScout(ctx: CoreCtx, scout: ScoutFn = scoutCandidates): Promise<void> {
  const started = new Date()
  try {
    const r = await scout(ctx, { onlyNew: true })
    setSettings(ctx.db, {
      auto_scout_last_run: localDate(started),
      auto_scout_last_result: JSON.stringify({ at: started.toISOString(), ...r }),
    })
    console.log(`[forgecast] 每日自动抓取完成：发现 ${r.found}，新增 ${r.added}`)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    setSettings(ctx.db, {
      auto_scout_last_run: localDate(started),
      auto_scout_last_result: JSON.stringify({ at: started.toISOString(), error: msg }),
    })
    console.log(`[forgecast] ⚠ 每日自动抓取失败：${msg}（明天自动重试）`)
  }
}

/** 启动调度：立即判定一次（补跑）+ 每 intervalMs 判定。返回停止函数。 */
export function startAutoScout(ctx: CoreCtx, opts: { intervalMs?: number; scout?: ScoutFn } = {}): () => void {
  let running = false
  const tick = async () => {
    if (running) return
    if (!shouldAutoScout(new Date(), readAutoScoutCfg(ctx.db))) return
    running = true
    try { await runAutoScout(ctx, opts.scout) } finally { running = false }
  }
  void tick()
  const timer = setInterval(() => { void tick() }, opts.intervalMs ?? 60_000)
  timer.unref?.()
  return () => clearInterval(timer)
}
```

`packages/server/src/index.ts` 在 `serve(...)` 之后加：

```ts
startAutoScout(ctx)
```

（顶部补 `import { startAutoScout } from './scheduler'`。测试直接 createApp 不走 index.ts，不会误启动调度。）

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @forgecast/server test`
Expected: PASS（含既有 65 用例）

- [ ] **Step 5: Commit**

```bash
git add packages/server/src packages/server/test/scheduler.test.ts
git commit -m "feat(server): 每日自动抓取调度(启动补跑/失败次日重试/onlyNew)"
```

---

### Task 4: server — favorite / auto-status 路由

**Files:**
- Modify: `packages/server/src/app.ts`（candidates 路由区内追加，**必须在 webDist 块之前**——现 candidates 路由区本就在其前）
- Test: `packages/server/test/scout-extras.test.ts`（新文件，harness 照抄 candidates.test.ts 顶部）

**Interfaces:**
- Consumes: Task 1 favorite 列 + settings key、Task 3 `readAutoScoutCfg`
- Produces:
  - `POST /api/candidates/:id/favorite` body `{favorite: boolean}` → `{ok:true}`；不存在 404
  - `GET /api/scout/auto-status` → `{enabled, time, lastRun: string|null, lastResult: object|null}`
  - `GET /api/candidates` 返回列增加 `favorite`

- [ ] **Step 1: 写失败测试 scout-extras.test.ts**

```ts
describe('favorite + auto-status (mock)', () => {
  it('favorite 切换与 404；列表返回 favorite 列', async () => {
    ctx.db.prepare("INSERT INTO candidates (repo, url, license_ok, status) VALUES ('a/b', 'u', 1, 'candidate')").run()
    expect((await app.request('/api/candidates/999/favorite', { method: 'POST', body: JSON.stringify({ favorite: true }) })).status).toBe(404)
    const res = await app.request('/api/candidates/1/favorite', { method: 'POST', body: JSON.stringify({ favorite: true }) })
    expect(res.status).toBe(200)
    let rows = await (await app.request('/api/candidates')).json() as any[]
    expect(rows[0].favorite).toBe(1)
    await app.request('/api/candidates/1/favorite', { method: 'POST', body: JSON.stringify({ favorite: false }) })
    rows = await (await app.request('/api/candidates')).json() as any[]
    expect(rows[0].favorite).toBe(0)
  })
  it('auto-status：默认值与写入后', async () => {
    let s = await (await app.request('/api/scout/auto-status')).json() as any
    expect(s).toEqual({ enabled: true, time: '08:00', lastRun: null, lastResult: null })
    setSettings(ctx.db, { auto_scout: 'off', auto_scout_time: '21:30', auto_scout_last_run: '2026-08-09', auto_scout_last_result: '{"at":"t","added":3}' })
    s = await (await app.request('/api/scout/auto-status')).json() as any
    expect(s.enabled).toBe(false)
    expect(s.time).toBe('21:30')
    expect(s.lastRun).toBe('2026-08-09')
    expect(s.lastResult).toEqual({ at: 't', added: 3 })
  })
  it('last_result 坏 JSON 兜底 null 不 500', async () => {
    setSettings(ctx.db, { auto_scout_last_result: 'not json' })
    const s = await (await app.request('/api/scout/auto-status')).json() as any
    expect(s.lastResult).toBeNull()
  })
})
```

（文件顶部 harness：`beforeEach` 建临时 ctx/queue/app，照抄 `candidates.test.ts`；`setSettings` 从 `@forgecast/core` import。）

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @forgecast/server test`
Expected: FAIL（路由 404 / favorite 列缺）

- [ ] **Step 3: 实现**

app.ts 的 `GET /api/candidates` SELECT 列名里加 `favorite`（`..., status, favorite, created_at FROM candidates ...`）。

candidates 路由区（`/api/candidates/:id/intro` 附近）追加：

```ts
  app.post('/api/candidates/:id/favorite', async (c) => {
    const id = c.req.param('id')
    if (!ctx.db.prepare('SELECT id FROM candidates WHERE id = ?').get(id)) return c.json({ error: '候选不存在' }, 404)
    const body = await c.req.json().catch(() => ({}))
    ctx.db.prepare('UPDATE candidates SET favorite = ? WHERE id = ?').run(body.favorite ? 1 : 0, id)
    return c.json({ ok: true })
  })

  app.get('/api/scout/auto-status', (c) => {
    const cfg = readAutoScoutCfg(ctx.db)
    const s = getAllSettings(ctx.db)
    let lastResult: unknown = null
    try { lastResult = s.auto_scout_last_result ? JSON.parse(s.auto_scout_last_result) : null } catch { /* 坏 JSON 兜底 null */ }
    return c.json({ enabled: cfg.enabled, time: cfg.time, lastRun: s.auto_scout_last_run ?? null, lastResult })
  })
```

顶部 import 补 `getAllSettings`（来自 `@forgecast/core`）与 `readAutoScoutCfg`（来自 `./scheduler`）。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @forgecast/server test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/app.ts packages/server/test/scout-extras.test.ts
git commit -m "feat(server): 候选收藏切换 + 自动抓取状态查询路由"
```

---

### Task 5: web — api 类型 + CandidateCard 四列新版

**Files:**
- Modify: `apps/web/src/api.ts`（Candidate 补字段 + AutoScoutStatus）、`apps/web/src/pages/board/CandidateCard.tsx`（重写卡片组件，**保留 DIMS/Detail/parseDetail/Bar 四个导出不动**——抽屉与页面还要用）

**Interfaces:**
- Consumes: Task 4 的 API 返回
- Produces:
  - api.ts：`Candidate` 增加 `favorite: number; last_commit: string | null; created_at: string`；新增 `export interface AutoScoutStatus { enabled: boolean; time: string; lastRun: string | null; lastResult: { at: string; found?: number; scored?: number; rejected?: number; added?: number; error?: string } | null }`
  - CandidateCard 新 props：`{ c: Candidate; isNew: boolean; onOpenDetail: (c: Candidate) => void; onToggleFavorite: (c: Candidate) => void; favPending: boolean }`（旧 props rank/onPick/onRescore/picking/rescoring 移除——立项/重评挪进抽屉，Task 7 一并接线）

- [ ] **Step 1: api.ts 补类型**

`Candidate` 接口尾部加 `favorite: number; last_commit: string | null; created_at: string`；追加 `AutoScoutStatus`（定义见上）。

- [ ] **Step 2: 重写 CandidateCard 默认导出（文件内 DIMS/Detail/parseDetail/Bar/num/str/Row 保持原样）**

```tsx
// 领域分类 → 图标底色（无真实 logo 数据，用色块 + 分类短名替代）
const CAT_COLORS: Record<string, string> = {
  '客服/IM': 'bg-sky-500', 'CRM/销售': 'bg-emerald-500', '电商/商城': 'bg-orange-500',
  '仪表盘/BI': 'bg-violet-500', '表单/问卷': 'bg-pink-500', '文档/知识库': 'bg-amber-500',
  '建站/CMS': 'bg-teal-500', '项目/协作': 'bg-indigo-500', '财务/发票': 'bg-lime-600',
  '预约/排期': 'bg-cyan-600', 'AI助手/Agent': 'bg-fuchsia-500', '其它': 'bg-neutral-400',
}

function daysAgoText(iso: string | null): string {
  if (!iso) return ''
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return ''
  const days = Math.floor((Date.now() - t) / 86400000)
  return days <= 0 ? '今天更新' : `${days} 天前更新`
}

export default function CandidateCard({ c, isNew, onOpenDetail, onToggleFavorite, favPending }: {
  c: Candidate; isNew: boolean
  onOpenDetail: (c: Candidate) => void
  onToggleFavorite: (c: Candidate) => void
  favPending: boolean
}) {
  const d = parseDetail(c.score_detail)
  const [owner, name] = c.repo.split('/')
  const cat = d?.category || '其它'
  const empty = '未生成 — 详情里点「重新评分」'
  return (
    <div className="flex cursor-pointer flex-col rounded-xl border bg-white p-4 shadow-sm hover:border-blue-300"
      onClick={() => onOpenDetail(c)}>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs text-neutral-400">
            {owner}/{isNew && <span className="ml-1 rounded bg-red-500 px-1 py-0.5 text-[10px] font-semibold text-white">NEW</span>}
          </div>
          <div className="truncate text-lg font-bold leading-tight">{name}</div>
        </div>
        <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-xs font-medium text-white ${CAT_COLORS[cat] ?? CAT_COLORS['其它']}`}>
          {cat === '其它' ? (name?.[0] ?? '?').toUpperCase() : cat.split('/')[0].slice(0, 2)}
        </div>
      </div>
      <div className="mt-1 line-clamp-2 min-h-[2rem] text-xs text-neutral-500">{c.description ?? ''}</div>
      <div className="mt-2 flex items-center gap-2 text-xs">
        <span className="text-neutral-500">⭐ {num(c.stars).toLocaleString()}</span>
        <span className="rounded bg-blue-50 px-1.5 py-0.5 font-semibold text-blue-700">{c.score ?? '—'} 分</span>
        <span className="rounded bg-green-50 px-1.5 py-0.5 text-green-700">{c.license ?? '—'}</span>
        {d?.category && d.category !== '其它' && (
          <span className="truncate rounded bg-indigo-50 px-1.5 py-0.5 text-indigo-700">{d.category}</span>
        )}
      </div>
      <div className="mt-2 flex-1 space-y-1">
        <Row icon="👤" label="目标群体" value={d?.targetBuyer || empty} muted={!d?.targetBuyer} />
        <Row icon="💢" label="行业痛点" value={d?.painPoint || empty} muted={!d?.painPoint} />
      </div>
      <div className="mt-1 text-right text-xs text-neutral-400">{daysAgoText(c.last_commit)}</div>
      <div className="mt-2 flex items-center gap-2 border-t pt-2" onClick={(e) => e.stopPropagation()}>
        <button title={c.favorite ? '取消收藏' : '收藏'} disabled={favPending}
          className={`rounded-lg border px-2.5 py-1.5 text-sm disabled:opacity-50 ${c.favorite ? 'border-amber-400 bg-amber-50 text-amber-500' : 'text-neutral-400 hover:text-amber-500'}`}
          onClick={() => onToggleFavorite(c)}>
          {c.favorite ? '★' : '☆'}
        </button>
        <button className="flex-1 rounded-lg border py-1.5 text-sm hover:border-blue-400 hover:text-blue-600"
          onClick={() => onOpenDetail(c)}>详情</button>
        <a className="rounded-lg border px-2.5 py-1.5 text-sm text-neutral-500 hover:text-blue-600"
          title="打开 GitHub" href={c.url} target="_blank" rel="noreferrer">↗</a>
      </div>
    </div>
  )
}
```

（`Row`/`num` 等内部函数复用文件内既有实现；三维 Bar 不再放卡片上——挪进抽屉。旧默认导出整体替换。此步之后 ScoutPage 会 TS 报错——props 不匹配，属预期，Task 7 接线修复；本任务只保证 api.ts 与本文件自身无语法错。）

- [ ] **Step 3: 验证（仅本文件语法级）**

Run: `pnpm --filter web exec tsc --noEmit 2>&1 | grep -v ScoutPage || true`
Expected: 除 ScoutPage 的 props 不匹配错误外无其他错误（ScoutPage 由 Task 7 修复；如有 CandidateCard/api.ts 自身错误须修掉）

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/api.ts apps/web/src/pages/board/CandidateCard.tsx
git commit -m "feat(web): 四列卡片样式重写 CandidateCard + 收藏按钮 + api 类型"
```

---

### Task 6: web — CandidateDrawer 抽屉详情

**Files:**
- Create: `apps/web/src/pages/board/CandidateDrawer.tsx`
- Delete: `apps/web/src/pages/board/CandidateDetailModal.tsx`（内容已被吸收；Task 7 改完 ScoutPage 引用后一起 `git rm`——本任务先建新文件不删旧）

**Interfaces:**
- Consumes: Task 5 的 Candidate 类型、CandidateCard 的 `DIMS/Bar/parseDetail` 导出、现有 `/api/candidates/:id/intro` 接口
- Produces: `CandidateDrawer` default export，props `{ candidate: Candidate; onClose: () => void; onPick: (repo: string) => void; onRescore: (id: number) => void; onToggleFavorite: (c: Candidate) => void; picking: boolean; rescoring: boolean; favPending: boolean }`

- [ ] **Step 1: 创建 CandidateDrawer.tsx**

内容改造自现 CandidateDetailModal.tsx（intro 加载逻辑 load/useEffect/Esc 关闭三段逐字保留），外壳与操作区如下：

```tsx
import { useEffect, useState } from 'react'
import { api, type Candidate, type IntroResponse } from '../../api'
import { Bar, DIMS, parseDetail } from './CandidateCard'

/** 右侧抽屉详情：产品说明书 + 评分明细 + 操作区（立项/重评/收藏）。原 CandidateDetailModal 改造。 */
export default function CandidateDrawer({ candidate, onClose, onPick, onRescore, onToggleFavorite, picking, rescoring, favPending }: {
  candidate: Candidate; onClose: () => void
  onPick: (repo: string) => void; onRescore: (id: number) => void; onToggleFavorite: (c: Candidate) => void
  picking: boolean; rescoring: boolean; favPending: boolean
}) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [res, setRes] = useState<IntroResponse | null>(null)
  const [entered, setEntered] = useState(false)   // 滑入过渡
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
  useEffect(() => { requestAnimationFrame(() => setEntered(true)) }, [])

  const live = res && res.mode === 'live' ? res : null

  return (
    <div className="fixed inset-0 z-50 bg-black/40" onClick={onClose}>
      <div
        className={`absolute right-0 top-0 h-full w-full max-w-[480px] overflow-y-auto bg-white p-5 shadow-xl transition-transform duration-200 ${entered ? 'translate-x-0' : 'translate-x-full'}`}
        onClick={(e) => e.stopPropagation()}>
        <div className="flex items-baseline gap-2 border-b pb-2">
          <a className="font-semibold text-blue-600" href={candidate.url} target="_blank" rel="noreferrer">{candidate.repo}</a>
          <span className="rounded bg-green-50 px-1.5 py-0.5 text-xs text-green-700">{candidate.license ?? '—'}</span>
          {d?.category && d.category !== '其它' && (
            <span className="rounded bg-indigo-50 px-1.5 py-0.5 text-xs text-indigo-700">{d.category}</span>
          )}
          <button className="ml-auto text-neutral-400 hover:text-neutral-700" onClick={onClose}>✕</button>
        </div>

        {/* 操作区：立项 / 重评 / 收藏 */}
        <div className="mt-3 flex items-center gap-2">
          {candidate.status === 'picked'
            ? <span className="text-sm text-green-600">已立项</span>
            : <button className="rounded bg-blue-600 px-4 py-1.5 text-sm text-white disabled:opacity-50"
                disabled={picking} onClick={() => onPick(candidate.repo)}>{picking ? '立项中…' : '立项'}</button>}
          <button className="rounded border px-3 py-1.5 text-sm text-neutral-600 disabled:opacity-50"
            disabled={rescoring} onClick={() => onRescore(candidate.id)}>{rescoring ? '评分中…' : '重新评分'}</button>
          <button disabled={favPending}
            className={`rounded border px-3 py-1.5 text-sm disabled:opacity-50 ${candidate.favorite ? 'border-amber-400 bg-amber-50 text-amber-500' : 'text-neutral-500'}`}
            onClick={() => onToggleFavorite(candidate)}>{candidate.favorite ? '★ 已收藏' : '☆ 收藏'}</button>
        </div>

        {/* 评分明细（卡片上不再展示三维条，挪到这里） */}
        {d && (
          <div className="mt-3 rounded-lg border bg-neutral-50 p-3">
            <div className="mb-1 flex items-center gap-2 text-sm font-medium">
              评分明细 <span className="font-semibold text-blue-700">{candidate.score ?? '—'} 分</span>
            </div>
            <div className="space-y-1">
              {DIMS.map((dim) => <Bar key={dim.key} label={dim.label} value={d[dim.key]} max={dim.max} />)}
            </div>
            {d.rationale && <p className="mt-1 text-xs text-neutral-500">💡 {d.rationale}</p>}
          </div>
        )}

        {/* 以下 loading / error / mock 提示 / live 产品说明书五段 + 底部“生成于…重新生成”，
            全部照抄原 CandidateDetailModal.tsx 对应 JSX（评分 section 已上移，删原文件里的那段） */}
      </div>
    </div>
  )
}
```

其中「照抄」部分指原 Modal 第 42-95 行的 `{loading && ...}`、`{!loading && error && ...}`、`{!loading && res?.mode === 'mock' && ...}`、`{!loading && live && (...)}` 四块，唯一改动：live 块里删掉 `{d && (<section className="border-t pt-3">...评分...</section>)}`（已上移为常驻区）。

- [ ] **Step 2: 验证（语法级）**

Run: `pnpm --filter web exec tsc --noEmit 2>&1 | grep -v ScoutPage || true`
Expected: 除 ScoutPage 既有 props 错误外无新错误

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/pages/board/CandidateDrawer.tsx
git commit -m "feat(web): 候选详情右侧抽屉(产品说明书+评分明细+立项/重评/收藏)"
```

---

### Task 7: web — ScoutPage 三 tab 重构 + 设置页自动抓取段 + 收尾

**Files:**
- Modify: `apps/web/src/pages/ScoutPage.tsx`（整文件重写）、`apps/web/src/pages/SettingsPage.tsx`（加自动抓取段）、`README.md`
- Delete: `apps/web/src/pages/board/CandidateDetailModal.tsx`（`git rm`）

**Interfaces:**
- Consumes: Task 4 API、Task 5 CandidateCard 新 props 与 AutoScoutStatus、Task 6 CandidateDrawer

- [ ] **Step 1: 重写 ScoutPage.tsx**

保留原有：scout()/rescoreAll()/backfillCats() 三个动作与日志面板、pick/rescore/moveStage 无关（moveStage 在 ProjectsPage）、pickingRepos/rescoringIds 并发追踪、catOf 分类工具。新增/改动如下（整文件）：

```tsx
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useRef, useState } from 'react'
import { api, subscribeTask, type AutoScoutStatus, type Candidate } from '../api'
import CandidateCard from './board/CandidateCard'
import CandidateDrawer from './board/CandidateDrawer'

type Tab = 'all' | 'fav' | 'daily'
const TABS: Array<{ key: Tab; label: string }> = [
  { key: 'all', label: '全部' }, { key: 'fav', label: '已收藏' }, { key: 'daily', label: '每日新增' },
]

/** SQLite datetime('now') 存的是无时区 UTC 串（YYYY-MM-DD HH:MM:SS）→ 本地日期 YYYY-MM-DD */
function localDay(utc: string | null): string {
  if (!utc) return ''
  const d = new Date(utc.includes('T') ? utc : utc.replace(' ', 'T') + 'Z')
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('sv-SE')
}
function dayLabel(day: string, today: string): string {
  if (day === today) return '今天'
  const t = new Date(today + 'T00:00:00')
  t.setDate(t.getDate() - 1)
  if (day === t.toLocaleDateString('sv-SE')) return '昨天'
  const [, m, dd] = day.split('-')
  return `${Number(m)}月${Number(dd)}日`
}

export default function ScoutPage() {
  const qc = useQueryClient()
  const [logs, setLogs] = useState<string[]>([])
  const [scanning, setScanning] = useState(false)
  const logRef = useRef<HTMLDivElement>(null)
  const [tab, setTab] = useState<Tab>('all')
  const [detailId, setDetailId] = useState<number | null>(null)

  const candidates = useQuery({ queryKey: ['candidates'], queryFn: () => api<Candidate[]>('/api/candidates') })
  const autoStatus = useQuery({ queryKey: ['auto-scout'], queryFn: () => api<AutoScoutStatus>('/api/scout/auto-status') })

  const [pickingRepos, setPickingRepos] = useState<Set<string>>(new Set())
  const pick = useMutation({
    mutationFn: (repo: string) => api('/api/candidates/pick', { method: 'POST', body: JSON.stringify({ repo }) }),
    onMutate: (repo) => setPickingRepos((prev) => new Set(prev).add(repo)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['candidates'] }),
    onError: (e) => alert(`立项失败: ${e instanceof Error ? e.message : String(e)}`),
    onSettled: (_d, _e, repo) => setPickingRepos((prev) => { const next = new Set(prev); next.delete(repo); return next }),
  })
  const [rescoringIds, setRescoringIds] = useState<Set<number>>(new Set())
  const rescore = useMutation({
    mutationFn: (id: number) => api<{ ok: boolean; mode: string }>(`/api/candidates/${id}/rescore`, { method: 'POST' }),
    onMutate: (id) => setRescoringIds((prev) => new Set(prev).add(id)),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['candidates'] })
      if (r.mode === 'mock') alert('当前是 mock 模式，评分不会产生目标群体/行业痛点。去「设置」把大模型切到 live 并填 key。')
    },
    onError: (e) => alert(`重新评分失败: ${e instanceof Error ? e.message : String(e)}`),
    onSettled: (_d, _e, id) => setRescoringIds((prev) => { const next = new Set(prev); next.delete(id); return next }),
  })
  const [favPendingIds, setFavPendingIds] = useState<Set<number>>(new Set())
  const favorite = useMutation({
    mutationFn: (c: Candidate) => api(`/api/candidates/${c.id}/favorite`, { method: 'POST', body: JSON.stringify({ favorite: !c.favorite }) }),
    onMutate: (c) => setFavPendingIds((prev) => new Set(prev).add(c.id)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['candidates'] }),
    onError: (e) => alert(`收藏失败: ${e instanceof Error ? e.message : String(e)}`),
    onSettled: (_d, _e, c) => setFavPendingIds((prev) => { const next = new Set(prev); next.delete(c.id); return next }),
  })

  async function scout() {
    if (scanning) return
    setScanning(true); setLogs([])
    try {
      const { taskId } = await api<{ taskId: string }>('/api/scout', { method: 'POST', body: '{}' })
      subscribeTask(taskId, (e) => {
        setLogs((l) => [...l, e.message]); logRef.current?.scrollTo({ top: 999999 })
        if (e.type === 'done' || e.type === 'error') { setScanning(false); qc.invalidateQueries({ queryKey: ['candidates'] }) }
      })
    } catch (err) { setLogs((l) => [...l, `❌ ${err instanceof Error ? err.message : String(err)}`]); setScanning(false) }
  }
  const [rescoringAll, setRescoringAll] = useState(false)
  async function rescoreAll() {
    if (rescoringAll || scanning) return
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
  const [cat, setCat] = useState<string | null>(null)
  const catOf = (c: { score_detail: string | null }): string => {
    try { return (c.score_detail && (JSON.parse(c.score_detail) as any)?.category) || '' } catch { return '' }
  }
  async function backfillCats() {
    try {
      const r = await api<{ updated: number }>('/api/candidates/backfill-categories', { method: 'POST' })
      alert(`已回填 ${r.updated} 个候选的领域分类`); qc.invalidateQueries({ queryKey: ['candidates'] })
    } catch (e) { alert('回填失败：' + (e instanceof Error ? e.message : String(e))) }
  }

  const rows = candidates.data ?? []
  const today = new Date().toLocaleDateString('sv-SE')
  const ok = rows.filter((c) => c.license_ok === 1)
  const blocked = rows.filter((c) => c.license_ok !== 1)
  const catCounts = new Map<string, number>()
  for (const c of ok) { const k = catOf(c); if (k) catCounts.set(k, (catCounts.get(k) ?? 0) + 1) }
  const byCat = (list: Candidate[]) => (cat ? list.filter((c) => catOf(c) === cat) : list)
  const byScore = (a: Candidate, b: Candidate) => (b.score ?? -1) - (a.score ?? -1)
  // 全部：收藏置顶（收藏内部与其余各按分数降序）
  const allShown = byCat(ok).sort((a, b) => (b.favorite - a.favorite) || byScore(a, b))
  const favShown = ok.filter((c) => c.favorite === 1).sort(byScore)
  // 每日新增：近 14 天入库的可商用候选，按本地日期倒序分组
  const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 14)
  const dailyGroups = [...byCat(ok)
    .map((c) => ({ c, day: localDay(c.created_at) }))
    .filter((x) => x.day && new Date(x.day) >= cutoff)
    .reduce((m, x) => { (m.get(x.day) ?? m.set(x.day, []).get(x.day)!).push(x.c); return m }, new Map<string, Candidate[]>())
    .entries()].sort((a, b) => b[0].localeCompare(a[0]))
    .map(([day, list]) => [day, list.sort(byScore)] as const)

  const detail = detailId == null ? null : rows.find((c) => c.id === detailId) ?? null
  const auto = autoStatus.data
  const lastText = !auto?.lastRun ? '尚未运行'
    : auto.lastResult && 'error' in (auto.lastResult) && auto.lastResult.error ? `${auto.lastRun} 失败：${auto.lastResult.error}`
    : `${auto.lastRun} 新增 ${auto.lastResult?.added ?? 0} 个`
  const grid = 'grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4'
  const card = (c: Candidate) => (
    <CandidateCard key={c.id} c={c} isNew={localDay(c.created_at) === today}
      onOpenDetail={(x) => setDetailId(x.id)} onToggleFavorite={(x) => favorite.mutate(x)}
      favPending={favPendingIds.has(c.id)} />
  )
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <button className="rounded bg-blue-600 px-4 py-2 text-sm text-white disabled:opacity-50" disabled={scanning || rescoringAll} onClick={scout}>
          {scanning ? '抓取中…' : '抓取候选'}
        </button>
        <button className="rounded border px-4 py-2 text-sm disabled:opacity-50" disabled={scanning || rescoringAll} onClick={rescoreAll}>
          {rescoringAll ? '评分中…' : '全部重新评分'}
        </button>
        <button className="rounded border px-4 py-2 text-sm disabled:opacity-50" disabled={scanning || rescoringAll} onClick={backfillCats}>
          分类回填
        </button>
        <span className="text-sm text-neutral-500">共 {rows.length} 个候选</span>
        <span className="ml-auto text-xs text-neutral-400">
          {auto ? (auto.enabled ? `每日 ${auto.time} 自动抓取 · 上次：${lastText}` : '自动抓取已关（设置页可开）') : ''}
        </span>
      </div>

      <div className="flex items-center gap-2">
        {TABS.map((t) => (
          <button key={t.key}
            className={`rounded-full border px-4 py-1.5 text-sm ${tab === t.key ? 'bg-blue-600 text-white' : 'bg-white text-neutral-600'}`}
            onClick={() => setTab(t.key)}>
            {t.label}{t.key === 'fav' ? ` (${favShown.length})` : ''}
          </button>
        ))}
      </div>

      {tab !== 'fav' && catCounts.size > 0 && (
        <div className="flex flex-wrap gap-2 text-xs">
          <button className={`rounded-full border px-3 py-1 ${cat === null ? 'bg-blue-600 text-white' : 'bg-white'}`} onClick={() => setCat(null)}>全部 ({ok.length})</button>
          {[...catCounts.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => (
            <button key={k} className={`rounded-full border px-3 py-1 ${cat === k ? 'bg-blue-600 text-white' : 'bg-white'}`} onClick={() => setCat(k)}>{k} ({n})</button>
          ))}
        </div>
      )}

      {logs.length > 0 && (
        <div ref={logRef} className="h-32 space-y-1 overflow-y-auto rounded-lg border bg-neutral-900 p-3 font-mono text-xs text-green-400">
          {logs.map((l, i) => <div key={i}>{l}</div>)}
        </div>
      )}

      {tab === 'all' && (
        <>
          <div className={grid}>{allShown.map(card)}</div>
          {rows.length === 0 && <div className="rounded-lg border p-6 text-center text-neutral-400">暂无候选，点「抓取候选」</div>}
          {blocked.length > 0 && (
            <details className="rounded-lg border bg-neutral-50 p-3 text-sm text-neutral-500">
              <summary className="cursor-pointer">另有 {blocked.length} 个协议不可商用（GPL/AGPL 系），点开查看</summary>
              <div className="mt-2 space-y-1">
                {blocked.map((c) => (
                  <div key={c.id} className="flex gap-2 text-xs">
                    <a className="text-neutral-600" href={c.url} target="_blank" rel="noreferrer">{c.repo}</a>
                    <span className="text-neutral-400">{c.license ?? '无协议'}</span>
                  </div>
                ))}
              </div>
            </details>
          )}
        </>
      )}
      {tab === 'fav' && (
        favShown.length
          ? <div className={grid}>{favShown.map(card)}</div>
          : <div className="rounded-lg border p-6 text-center text-neutral-400">还没有收藏，点卡片上的 ☆ 收藏感兴趣的项目</div>
      )}
      {tab === 'daily' && (
        dailyGroups.length
          ? dailyGroups.map(([day, list]) => (
              <div key={day}>
                <div className="mb-2 text-sm font-medium text-neutral-600">{dayLabel(day, today)} <span className="text-neutral-400">({list.length})</span></div>
                <div className={grid}>{list.map(card)}</div>
              </div>
            ))
          : <div className="rounded-lg border p-6 text-center text-neutral-400">近 14 天没有新入库的候选（每日自动抓取会把新发现的项目归到这里）</div>
      )}

      {detail && (
        <CandidateDrawer candidate={detail} onClose={() => setDetailId(null)}
          onPick={(repo) => pick.mutate(repo)} onRescore={(id) => rescore.mutate(id)}
          onToggleFavorite={(c) => favorite.mutate(c)}
          picking={pickingRepos.has(detail.repo)} rescoring={rescoringIds.has(detail.id)}
          favPending={favPendingIds.has(detail.id)} />
      )}
    </div>
  )
}
```

（要点：`detailId` 存 id、`detail` 从最新列表派生——重评/收藏后抽屉内容跟着刷新，不像旧 Modal 持有过期快照。）

- [ ] **Step 2: 删除旧 Modal**

Run: `git rm apps/web/src/pages/board/CandidateDetailModal.tsx`

- [ ] **Step 3: SettingsPage 加自动抓取段**

先读 `apps/web/src/pages/SettingsPage.tsx` 现有分段结构，在最后一段之后插入 `<AutoScoutSection />`，组件定义加在文件底部（确保文件顶部已 import `useQuery, useQueryClient`、`useState`、`api`；缺则补，类型 `AutoScoutStatus` 从 `../api` import）：

```tsx
/** 每日自动抓取设置：读 auto-status，写 PUT /api/settings（auto_scout / auto_scout_time） */
function AutoScoutSection() {
  const qc = useQueryClient()
  const status = useQuery({ queryKey: ['auto-scout'], queryFn: () => api<AutoScoutStatus>('/api/scout/auto-status') })
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [time, setTime] = useState<string | null>(null)
  const en = enabled ?? status.data?.enabled ?? true
  const tm = time ?? status.data?.time ?? '08:00'
  async function save() {
    try {
      await api('/api/settings', { method: 'PUT', body: JSON.stringify({ auto_scout: en ? 'on' : 'off', auto_scout_time: tm }) })
      qc.invalidateQueries({ queryKey: ['auto-scout'] })
      alert('已保存（server 每分钟检查一次，到点自动抓取；当天错过启动时会补跑）')
    } catch (e) { alert(`保存失败: ${e instanceof Error ? e.message : String(e)}`) }
  }
  return (
    <div className="rounded-lg border bg-white p-4 space-y-3">
      <div className="font-semibold">每日自动抓取</div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={en} onChange={(e) => setEnabled(e.target.checked)} />
        每天自动抓取候选（只给新项目评分，不覆盖已有评分）
      </label>
      <label className="flex items-center gap-2 text-sm">
        每日时间
        <input type="time" className="rounded border px-2 py-1 text-sm" value={tm} onChange={(e) => setTime(e.target.value)} />
      </label>
      {status.data?.lastRun && (
        <div className="text-xs text-neutral-400">上次运行：{status.data.lastRun}</div>
      )}
      <button className="rounded bg-blue-600 px-4 py-1.5 text-sm text-white" onClick={save}>保存</button>
    </div>
  )
}
```

- [ ] **Step 4: 类型检查 + 构建 + 全仓测试**

Run: `pnpm --filter web exec tsc --noEmit && pnpm --filter web build && pnpm test`
Expected: 全部通过

- [ ] **Step 5: 浏览器手工验收（唯一一次）**

Run: `pnpm dev`（Node 22），打开 http://localhost:5173/scout 确认：
1. 卡片四列排布（缩窗依次 3/2/1 列），样式含分类色块/⭐/分数/协议/买家/痛点/更新时间/底部三按钮
2. 点卡片 → 右侧抽屉滑入；抽屉内评分明细、立项、重新评分、收藏可用；Esc/遮罩关闭
3. ☆ 收藏 → 图标点亮 → 「已收藏」tab 可见、「全部」里置顶
4. 「每日新增」tab：把某候选 created_at 改成今天验证分组（或直接抓一次新候选）；当天新增卡片带 NEW 徽章
5. 设置页「每日自动抓取」段可保存；找项目页顶部显示自动抓取状态
6. 把 auto_scout_time 设为 1 分钟后 → 等到点 → 自动跑一次，状态行更新（server 控制台有日志）

- [ ] **Step 6: README 更新 + Commit**

README「路线图」上方或 CLI 段附近补一句（跟随现有行文）：找项目板块支持收藏 / 每日自动抓取（server 内置调度，设置页配置）/ 每日新增视图 / 抽屉详情。

```bash
git add apps/web/src README.md
git commit -m "feat(web): 找项目页三tab重构(全部/收藏/每日新增)+抽屉详情+设置页自动抓取"
```
