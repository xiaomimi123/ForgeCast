# 长任务过程反馈统一化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让全站 21 个长任务入口在按钮旁实时显示「已用时长 · 最新进度」，并给唯独缺失进度上报的 `scoutCandidates`/`scoutBreakouts` 补上 `onProgress`。

**Architecture:** 后端在 scout 两个函数的评分主循环里逐条 `onProgress`，经既有任务队列 SSE 原样送出；前端抽 `useTaskRun` hook 收敛「发起→订阅→计时→收尾」样板，配 `TaskProgress` 展示组件插在每个触发按钮后面。任务队列、SSE 协议、数据模型一律不动。

**Tech Stack:** TypeScript · React 18 + @tanstack/react-query · Hono SSE · vitest（仅后端）· Tailwind v4 token 体系

**Spec:** `docs/superpowers/specs/2026-08-30-task-progress-feedback-design.md`

## Global Constraints

- **不改任务队列 / SSE 协议 / 数据模型**：`packages/server/src/tasks.ts`、`api.ts` 的 `TaskEvent`/`subscribeTask` 签名一行不动。
- **`onProgress` 必须可选且缺省 no-op**：所有现有调用方与测试不加参数也要照常通过。
- **`apps/web` 不引入单测框架**：该包 `"test": "echo 'web: 人工验收，无单测'"` 是既定约定；前端改动靠 `npx tsc --noEmit` + 浏览器人工验收把关，不要新增 vitest/testing-library 依赖。
- **视觉走既有 token**：只用 `text-sub`/`text-faint`/`text-danger`/`bg-fire` 等现有类，不新增 CSS 变量、不改 `index.css`。
- **不顺手改无关样式**：`DemandPage`/`AssetCard`/`TopicsPage`/`ProjectDrawer` 里残留的 `btn-fire`/`btn-ink`/`border-[1.5px]` 不在本次范围，保持原样。
- **保留各调用点原有的 `alert()` 与 `invalidateQueries()` 语义**：它们各页不同，迁移时逐条搬进 `onSettled` 回调，不得增删。
- **测试须用 Node ≥22**：本机 nvm 默认 v20，`better-sqlite3` ABI 不匹配会假失败。跑测试前先
  `export NVM_DIR="$HOME/.nvm" && source "$NVM_DIR/nvm.sh" && nvm use 22.23.2`，用 `npx pnpm test`。

---

### Task 1: 后端 scout 补 `onProgress`

**Files:**
- Modify: `packages/scout/src/scout.ts`（`scoutCandidates` 约 59-100 行、`scoutBreakouts` 约 192-215 行）
- Modify: `packages/server/src/app.ts:446-462`
- Test: `packages/scout/test/scout.test.ts`

**Interfaces:**
- Consumes: 无（本任务是链路起点）
- Produces: `scoutCandidates(ctx, { …, onProgress?: (msg: string) => void })` 与 `scoutBreakouts(ctx, { …, onProgress?: (msg: string) => void })`，返回值类型不变。

- [ ] **Step 1: 写失败测试**

在 `packages/scout/test/scout.test.ts` 的 `describe('scoutCandidates (mock)')` 块内追加：

```ts
  it('onProgress：报搜索阶段 + 逐条评分进度，分母是真正评分条数', async () => {
    const msgs: string[] = []
    const r = await scoutCandidates(ctx, { onProgress: (m) => msgs.push(m) })

    expect(msgs[0]).toMatch(/^搜索 GitHub（\d+ 个 topic）…$/)
    expect(msgs[1]).toMatch(/^搜到 \d+ 个仓库 · 协议可商用 \d+ 个 · 本次评分 \d+ 个$/)

    const scoreLines = msgs.filter((m) => m.startsWith('评分 '))
    expect(scoreLines).toHaveLength(r.scored)
    // 分母恒为本次真评分条数（不是搜到的总数——否则进度看着像卡在个位数）
    scoreLines.forEach((m, i) => expect(m).toMatch(new RegExp(`^评分 ${i + 1}/${r.scored}：`)))
  })

  it('不传 onProgress 时不抛错，返回值与传时一致（向后兼容）', async () => {
    const a = await scoutCandidates(ctx)
    const b = await scoutCandidates(ctx, { onProgress: () => {} })
    expect(a).toEqual(b)
  })
```

在 `describe('scoutBreakouts (mock)')` 块内追加：

```ts
  it('onProgress：报检测阶段 + 逐条评分进度，分母是协议可商用条数', async () => {
    const msgs: string[] = []
    const r = await scoutBreakouts(ctx, { onProgress: (m) => msgs.push(m) })

    expect(msgs[0]).toMatch(/^检测新晋高星仓库（≥\d+ star · \d+ 天内新建）…$/)
    expect(msgs[1]).toMatch(/^命中 \d+ 个仓库 · 协议可商用 \d+ 个，开始评分…$/)

    const scoreLines = msgs.filter((m) => m.startsWith('评分 '))
    expect(scoreLines).toHaveLength(r.scored)
    scoreLines.forEach((m, i) => expect(m).toMatch(new RegExp(`^评分 ${i + 1}/${r.scored}：`)))
  })
```

- [ ] **Step 2: 跑测试确认失败**

```bash
export NVM_DIR="$HOME/.nvm" && source "$NVM_DIR/nvm.sh" && nvm use 22.23.2
npx pnpm --filter @forgecast/scout test
```

预期：3 个新用例失败（`onProgress` 不是合法参数 / `msgs` 为空数组，`msgs[0]` 是 `undefined`）。

- [ ] **Step 3: 实现 `scoutCandidates` 的进度上报**

在 `packages/scout/src/scout.ts` 中，把 `scoutCandidates` 的签名与函数体前段改成：

```ts
export async function scoutCandidates(
  ctx: CoreCtx,
  opts: {
    topics?: string[]; limit?: number; pushedAfter?: string; onlyNew?: boolean
    onProgress?: (msg: string) => void
  } = {},
): Promise<{ found: number; scored: number; rejected: number; added: number }> {
  const log = opts.onProgress ?? (() => {})
  const gh = createGithubClient(ctx.config.github)
  const topics = opts.topics ?? DEFAULT_TOPICS
  const limit = opts.limit ?? 30
  const pushedAfter = opts.pushedAfter ?? new Date(Date.now() - 183 * 864e5).toISOString().slice(0, 10)
  log(`搜索 GitHub（${topics.length} 个 topic）…`)
  const found = await gh.searchRepos(topics, { minStars: 300, pushedAfter, perTopic: 20 })
```

`existing` / `isNew` / `scorePool` / `toScore` 四行保持原样不动，在 `toScore` 定义之后插入一行：

```ts
  // 口径说明：可商用数按 found 全量算（不受 onlyNew 影响），评分数按 toScore 算——
  // 两者在 onlyNew 模式下会差很多，分开报才不误导。
  const licenseOkCount = found.filter((m) => isLicenseOk(m.license)).length
  log(`搜到 ${found.length} 个仓库 · 协议可商用 ${licenseOkCount} 个 · 本次评分 ${toScore.size} 个`)
```

再把主循环的 `else` 分支改成（只加一行 `log`，其余不动）：

```ts
    } else {
      const willScore = toScore.has(m.repo)
      if (willScore) log(`评分 ${scored + 1}/${toScore.size}：${m.repo}`)
      await ingest(ctx, gh, m, willScore)
      if (willScore) scored++
      if (isNew(m) && ok) added++
    }
```

**不要**在函数末尾加汇总行——`app.ts` 的路由已经用 `.then()` 收尾报了一条，重复会刷两遍。

- [ ] **Step 4: 实现 `scoutBreakouts` 的进度上报**

```ts
export async function scoutBreakouts(
  ctx: CoreCtx,
  opts: {
    minStars?: number; withinDays?: number; limit?: number
    onProgress?: (msg: string) => void
  } = {},
): Promise<{ found: number; scored: number; rejected: number; added: number; hits: Array<{ repo: string; url: string }> }> {
  const log = opts.onProgress ?? (() => {})
  const gh = createGithubClient(ctx.config.github)
  const minStars = opts.minStars ?? 2000
  const withinDays = opts.withinDays ?? 7
  const limit = opts.limit ?? 30
  const createdAfter = new Date(Date.now() - withinDays * 864e5).toISOString().slice(0, 10)
  log(`检测新晋高星仓库（≥${minStars} star · ${withinDays} 天内新建）…`)
  const found = await gh.searchBreakouts({ minStars, createdAfter, perPage: limit })

  let scored = 0
  let rejected = 0
  let added = 0
  const hits: Array<{ repo: string; url: string }> = []
  const okTotal = found.filter((m) => isLicenseOk(m.license)).length
  log(`命中 ${found.length} 个仓库 · 协议可商用 ${okTotal} 个，开始评分…`)
  for (const m of found) {
    const ok = isLicenseOk(m.license)
    if (ok) log(`评分 ${scored + 1}/${okTotal}：${m.repo}`)
    await ingest(ctx, gh, m, ok)
    if (ok) { scored++; added++; hits.push({ repo: m.repo, url: m.url }) }
    else rejected++
  }
  return { found: found.length, scored, rejected, added, hits }
}
```

- [ ] **Step 5: 路由透传 `onProgress`**

`packages/server/src/app.ts` 第 446-462 行两处，各加一行（`.then()` 收尾行保持原样）：

```ts
  app.post('/api/scout', async (c) => {
    const body = await c.req.json().catch(() => ({}))
    const taskId = queue.enqueue((log) => scoutCandidates(ctx, {
      topics: Array.isArray(body.topics) ? body.topics : undefined,
      limit: typeof body.limit === 'number' ? body.limit : undefined,
      onProgress: log,
    }).then((r) => { log(`发现 ${r.found} 个，评分 ${r.scored}，协议不过 ${r.rejected}`); return r }))
    return c.json({ taskId })
  })
```

`/api/scout/breakouts` 同样在 `limit:` 那行之后补 `onProgress: log,`。

- [ ] **Step 6: 跑测试确认通过**

```bash
export NVM_DIR="$HOME/.nvm" && source "$NVM_DIR/nvm.sh" && nvm use 22.23.2
npx pnpm --filter @forgecast/scout test && npx pnpm --filter @forgecast/server test
```

预期：全绿，含 3 个新用例；scout 原有用例与 server 原有用例均不受影响。

- [ ] **Step 7: 提交**

```bash
git add packages/scout/src/scout.ts packages/scout/test/scout.test.ts packages/server/src/app.ts
git commit -m "feat(scout): scoutCandidates/scoutBreakouts 支持 onProgress 逐条上报评分进度"
```

---

### Task 2: `useTaskRun` hook + `TaskProgress` 组件 + ScoutPage 接入

**Files:**
- Create: `apps/web/src/useTaskRun.ts`
- Create: `apps/web/src/components/TaskProgress.tsx`
- Modify: `apps/web/src/pages/ScoutPage.tsx`

**Interfaces:**
- Consumes: Task 1 产出的后端进度消息（运行时验证用，编译期无依赖）
- Produces: `useTaskRun(): TaskRun`（字段 `running` / `lastMessage` / `elapsedSec` / `logs` / `failed` / `run`）与默认导出组件 `TaskProgress({ run, className? })`。后续 Task 3-7 全部依赖这两个。

- [ ] **Step 1: 新建 hook**

创建 `apps/web/src/useTaskRun.ts`：

```ts
import { useCallback, useEffect, useRef, useState } from 'react'
import { subscribeTask, type TaskEvent } from './api'

export interface TaskRun {
  /** 任务是否在跑 */
  running: boolean
  /** 最新一条进度消息（''=还没有）。任务结束后保留最后一条，直到下次 run() */
  lastMessage: string
  /** 已用秒数：running 期间每秒自增；结束时定格为总耗时 */
  elapsedSec: number
  /** 完整日志（含 error 前缀），给需要日志框的页面用 */
  logs: string[]
  /** 最近一次是否以 error 收尾 */
  failed: boolean
  /** 启动任务。start() 负责发 POST 并返回 taskId。
   *  done/error 时自动收尾并回调 onSettled(ok, lastEvent)；
   *  start() 自身抛错（网络/4xx）也会被兜住，回调 onSettled(false, null)。
   *  running 期间重复调用直接忽略。 */
  run: (
    start: () => Promise<string>,
    onSettled?: (ok: boolean, e: TaskEvent | null) => void,
  ) => Promise<void>
}

/** 长任务统一运行状态：发起 → 订阅 SSE → 累计日志 → 秒表计时 → 收尾。
 *  一个组件里有几个互相独立的任务就调几次（如 ScoutPage 调 5 次）。 */
export function useTaskRun(): TaskRun {
  const [running, setRunning] = useState(false)
  const [logs, setLogs] = useState<string[]>([])
  const [lastMessage, setLastMessage] = useState('')
  const [failed, setFailed] = useState(false)
  const [elapsedSec, setElapsedSec] = useState(0)
  const startedAtRef = useRef(0)
  // running 的 ref 镜像：run() 里做重入判断不能读闭包里的 state（拿到的是旧值）
  const runningRef = useRef(false)
  // 卸载时关掉 EventSource——原先各处手写的 subscribeTask 没做，抽屉一关连接还挂着
  const closeRef = useRef<(() => void) | null>(null)

  useEffect(() => () => { closeRef.current?.() }, [])

  useEffect(() => {
    if (!running) return
    const t = setInterval(() => setElapsedSec(Math.floor((Date.now() - startedAtRef.current) / 1000)), 1000)
    return () => clearInterval(t)
  }, [running])

  const run = useCallback(async (
    start: () => Promise<string>,
    onSettled?: (ok: boolean, e: TaskEvent | null) => void,
  ): Promise<void> => {
    if (runningRef.current) return
    runningRef.current = true
    startedAtRef.current = Date.now()
    setRunning(true); setLogs([]); setLastMessage(''); setFailed(false); setElapsedSec(0)

    const settle = (ok: boolean, e: TaskEvent | null) => {
      runningRef.current = false
      closeRef.current = null
      setRunning(false)
      setElapsedSec(Math.round((Date.now() - startedAtRef.current) / 1000))
      if (!ok) setFailed(true)
      onSettled?.(ok, e)
    }

    try {
      const taskId = await start()
      closeRef.current = subscribeTask(taskId, (e) => {
        setLogs((l) => [...l, `${e.type === 'error' ? '❌ ' : ''}${e.message}`])
        setLastMessage(e.message)
        if (e.type === 'done' || e.type === 'error') settle(e.type === 'done', e)
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setLogs((l) => [...l, `❌ ${msg}`])
      setLastMessage(msg)
      settle(false, null)
    }
  }, [])

  return { running, lastMessage, elapsedSec, logs, failed, run }
}
```

- [ ] **Step 2: 新建展示组件**

创建 `apps/web/src/components/TaskProgress.tsx`：

```tsx
import type { TaskRun } from '../useTaskRun'

function fmt(sec: number): string {
  return sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m${String(sec % 60).padStart(2, '0')}s`
}

/** 长任务就地进度：紧跟触发按钮之后，显示「已用时长 · 最新一条进度」。
 *  没跑过也没消息时不渲染任何东西，保持页面初始状态干净。 */
export default function TaskProgress({ run, className = '' }: { run: TaskRun; className?: string }) {
  if (!run.running && !run.lastMessage) return null
  const tone = run.failed ? 'text-danger' : run.running ? 'text-sub' : 'text-faint'
  return (
    <span className={`inline-flex min-w-0 items-center gap-1.5 font-mono text-xs ${tone} ${className}`}>
      {run.running && <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-fire" />}
      <span className="shrink-0">{run.running ? '已用' : '用时'} {fmt(run.elapsedSec)}</span>
      <span className="truncate">· {run.lastMessage}</span>
    </span>
  )
}
```

- [ ] **Step 3: ScoutPage 接入 5 个任务**

在 `apps/web/src/pages/ScoutPage.tsx`：

1. 顶部 import 改为（去掉 `subscribeTask`，加 hook 与组件）：

```ts
import { api, type AutoScoutStatus, type Candidate } from '../api'
import { useTaskRun } from '../useTaskRun'
import TaskProgress from '../components/TaskProgress'
```

2. 删除这些 state：`logs`/`setLogs`（31 行）、`scanning`/`setScanning`（32 行）、`scanningBreakouts`（83 行）、`rescoringAll`（95 行）、`backfillingSummary`（112 行）。改为在组件顶部声明 5 个 run：

```ts
  const scoutRun = useTaskRun()
  const breakoutRun = useTaskRun()
  const rescoreAllRun = useTaskRun()
  const backfillRun = useTaskRun()
  const addUrlRun = useTaskRun()
  // 任一长任务在跑时，其余按钮统一禁用（沿用原先各 handler 里的互斥守卫）
  const busy = scoutRun.running || breakoutRun.running || rescoreAllRun.running || backfillRun.running
```

3. 五个 handler 改写。`scout()` 为例（其余同构）：

```ts
  function scout() {
    scoutRun.run(
      async () => (await api<{ taskId: string }>('/api/scout', { method: 'POST', body: '{}' })).taskId,
      () => qc.invalidateQueries({ queryKey: ['candidates'] }),
    )
  }
```

其余四个的 endpoint / run / 收尾回调对应关系：

| handler | endpoint 与 init | run | onSettled |
|---|---|---|---|
| `scoutBreakouts` | `POST /api/scout/breakouts`, body `'{}'` | `breakoutRun` | `qc.invalidateQueries({ queryKey: ['candidates'] })` |
| `rescoreAll` | `POST /api/candidates/rescore-all` | `rescoreAllRun` | 同上 |
| `backfillSummary` | `POST /api/candidates/backfill-summary` | `backfillRun` | 同上 |
| `addUrlSubmit` | `POST /api/candidates/add`, body `JSON.stringify({ url })` | `addUrlRun` | 同上 |

`rescoreAll` 原有的「统计未评条数 → `alert('候选都已真评过…')` → `window.confirm(...)` 早退」逻辑**原样保留在 `run()` 调用之前**，`addUrlSubmit` 原有的 `setAddUrlOpen(false); setAddUrl('')` 也保留在 `run()` 之前。

4. 按钮：所有 `disabled={scanning || scanningBreakouts || rescoringAll || backfillingSummary}` 一律换成 `disabled={busy}`；按钮文案里的 `scanning ?` / `scanningBreakouts ?` / `rescoringAll ?` / `backfillingSummary ?` 分别换成 `scoutRun.running ?` / `breakoutRun.running ?` / `rescoreAllRun.running ?` / `backfillRun.running ?`（文案字符串本身不变）。

5. 进度条与日志框共用同一个「当前活跃 run」。在 `return` 之前提取变量（5 个任务共用一处显示，谁在跑显示谁；都不在跑时退回 `addUrlRun`，它是唯一没有独立按钮文案的那个）：

```ts
  const activeRun = scoutRun.running ? scoutRun
    : breakoutRun.running ? breakoutRun
    : rescoreAllRun.running ? rescoreAllRun
    : backfillRun.running ? backfillRun
    : addUrlRun
  useEffect(() => { logRef.current?.scrollTo({ top: 999999 }) }, [activeRun.logs.length])
```

（`logRef` 本身保留不动；原先写在 `subscribeTask` 回调里的滚动语句删掉，改由上面这个 effect 负责。需从 `react` 补 import `useEffect`。）

6. 在按钮行「共 N 个候选」那个 `<span>` **之前**插入 `<TaskProgress run={activeRun} className="max-w-[420px]" />`；日志框（约 232-236 行）条件改 `activeRun.logs.length > 0`、内容改 `activeRun.logs.map(...)`。

- [ ] **Step 4: 类型检查**

```bash
cd apps/web && npx tsc --noEmit
```

预期：无输出（`ScoutPage.tsx` 里不应再有 `subscribeTask`/`setLogs`/`scanning` 的残留引用）。

- [ ] **Step 5: 浏览器人工验收**

确认 dev server 在跑（`lsof -i:5173 | grep LISTEN`；不在则 `export NVM_DIR="$HOME/.nvm" && source "$NVM_DIR/nvm.sh" && nvm use 22.23.2 && nohup npx pnpm dev > /tmp/fc-dev.log 2>&1 & disown`）。

打开 `http://localhost:5173` → 「找项目」→ 点「抓取候选」，确认：
1. 按钮变「抓取中…」且其余按钮禁用；
2. 按钮旁出现脉冲点 + `已用 3s · 搜索 GitHub（14 个 topic）…`，秒数每秒递增；
3. 进入评分阶段后消息刷成 `评分 7/30：owner/repo` 并持续变化；
4. 结束后进度条变成 `用时 3m12s · 发现 … 个，评分 …`，按钮恢复可点，候选列表刷新。

- [ ] **Step 6: 提交**

```bash
git add apps/web/src/useTaskRun.ts apps/web/src/components/TaskProgress.tsx apps/web/src/pages/ScoutPage.tsx
git commit -m "feat(web): 抽 useTaskRun/TaskProgress，找项目页 5 个长任务就地显示进度与用时"
```

---

### Task 3: ProjectDrawer 接入（4 个任务）

**Files:**
- Modify: `apps/web/src/drawers/ProjectDrawer.tsx`

**Interfaces:**
- Consumes: `useTaskRun` / `TaskProgress`（Task 2 产出）
- Produces: 无

四个任务 `analyze` / `rebrand` / `runExec` / `generateScreens` 目前各有独立的 `xxxing` 布尔 + `xxxLog` 数组 + 独立日志框，互不共享 busy 状态——**保持这个独立性**，不要合并成一个 busy。

- [ ] **Step 1: 替换四组 state 与 handler**

import 去掉 `subscribeTask`，加入 `useTaskRun` / `TaskProgress`（路径 `../useTaskRun`、`../components/TaskProgress`）。

删除 `analyzing`/`setAnalyzing`、`analyzeLog`/`setAnalyzeLog`、`rebranding`/`setRebranding`、`rebrandLog`/`setRebrandLog`、`execRunning`/`setExecRunning`、`execLog`/`setExecLog`、`screensBusy`/`setScreensBusy`、`screensLog`/`setScreensLog` 八组 state，换成：

```ts
  const analyzeRun = useTaskRun()
  const rebrandRun = useTaskRun()
  const execRun = useTaskRun()
  const screensRun = useTaskRun()
```

四个 handler 按此模板改写（以 `analyze` 为例）：

```ts
  function analyze() {
    analyzeRun.run(
      async () => (await api<{ taskId: string }>(`/api/projects/${slug}/analyze`, { method: 'POST' })).taskId,
      () => qc.invalidateQueries({ queryKey: ['project', slug] }),
    )
  }
```

各自的 endpoint 与收尾：

| handler | endpoint | run | onSettled 内容（原样搬运，不增删） |
|---|---|---|---|
| `analyze` | `POST /api/projects/${slug}/analyze` | `analyzeRun` | `qc.invalidateQueries({ queryKey: ['project', slug] })` |
| `rebrand` | `POST /api/projects/${slug}/rebrand` | `rebrandRun` | 同上 |
| `runExec` | `POST /api/projects/${slug}/rebrand-exec` | `execRun` | `qc.invalidateQueries({ queryKey: ['project', slug] })` **与** `qc.invalidateQueries({ queryKey: ['projects'] })` 两句都要 |
| `generateScreens` | `POST /api/projects/${slug}/screens` | `screensRun` | `qc.invalidateQueries({ queryKey: ['shots', slug] })` |

- [ ] **Step 2: 更新四处按钮与日志框**

- 按钮 `disabled={analyzing}` → `disabled={analyzeRun.running}`，文案里的 `analyzing ?` → `analyzeRun.running ?`（其余三个同理，文案字符串不变）。
- 每个按钮后紧跟 `<TaskProgress run={analyzeRun} />`（其余三个对应各自的 run）。
- 四个日志框：`analyzeLog.length > 0` → `analyzeRun.logs.length > 0`，`analyzeLog.map(...)` → `analyzeRun.logs.map(...)`（其余三个同理）。

- [ ] **Step 3: 类型检查**

```bash
cd apps/web && npx tsc --noEmit
```

预期：无输出。

- [ ] **Step 4: 浏览器人工验收**

「拆解」→ 打开任一项目详情抽屉 → 点「生成分析」，确认按钮旁出现秒表与进度、日志框照常滚动、结束后状态复位。再把抽屉在任务运行中直接关掉，回到页面不应有报错（验证卸载时 EventSource 被关掉）。

- [ ] **Step 5: 提交**

```bash
git add apps/web/src/drawers/ProjectDrawer.tsx
git commit -m "feat(web): 项目详情抽屉 4 个长任务接入 useTaskRun"
```

---

### Task 4: DemandPage 接入（3 个任务，含丢弃进度的修复）

**Files:**
- Modify: `apps/web/src/pages/DemandPage.tsx`

**Interfaces:**
- Consumes: `useTaskRun` / `TaskProgress`（Task 2 产出）
- Produces: 无

这三处当前在 `subscribeTask` 回调里**只判断 `done`/`error`，中间的 log 事件全部丢弃**，改造后自动获得进度显示。三个任务分属三个不同组件（入池按钮在匹配结果卡片里、匹配在信号卡片里、提炼在页面头部），各自独立。

- [ ] **Step 1: 三处改写**

import 去掉 `subscribeTask`，加 `useTaskRun`（`../useTaskRun`）与 `TaskProgress`（`../components/TaskProgress`）。

| 位置 | 原 state | endpoint | 收尾（原样搬运） |
|---|---|---|---|
| `addToPool`（约 30-48 行） | `adding`/`setAdding` | `POST /api/candidates/add`，body `JSON.stringify({ url: m.url })` | 成功 → `setAdded(true)`；失败 → `alert('入池失败：' + e.message)` |
| `runMatch`（约 74-95 行） | `matching`/`setMatching` | `POST /api/demand/signals/${s.id}/match` | 成功 → `setOpen(true)` 且 `qc.invalidateQueries({ queryKey: ['demand'] })` + `qc.invalidateQueries({ queryKey: ['demand-matches', s.id] })`；失败 → `alert('匹配失败：' + e.message)` |
| `extract`（约 142-172 行） | `extracting`/`setExtracting` | `POST /api/demand/extract` | 成功 → `qc.invalidateQueries({ queryKey: ['demand'] })`；失败 → `alert('提炼失败：' + e.message)` |

模板（以 `runMatch` 为例，注意 invalidate 在成功/失败两种情况下的原有行为要保持——原代码是无论成功失败都 invalidate）：

```ts
  const matchRun = useTaskRun()
  function runMatch() {
    matchRun.run(
      async () => (await api<{ taskId: string }>(`/api/demand/signals/${s.id}/match`, { method: 'POST' })).taskId,
      (ok, e) => {
        qc.invalidateQueries({ queryKey: ['demand'] })
        qc.invalidateQueries({ queryKey: ['demand-matches', s.id] })
        if (!ok) alert('匹配失败：' + (e?.message ?? '未知错误'))
        else setOpen(true)
      },
    )
  }
```

注意 `addToPool` 原有的 `if (adding || added) return` 守卫里的 `added` 条件要保留（`run()` 只挡 `adding` 那半边）：改成 `if (added) return` 放在 `run()` 之前。

- [ ] **Step 2: 按钮与进度条**

- `disabled={adding || added}` → `disabled={addRun.running || added}`；文案 `adding ?` → `addRun.running ?`。
- `disabled={matching}` → `disabled={matchRun.running}`；文案同理。
- `disabled={extracting || pendingCount === 0}` → `disabled={extractRun.running || pendingCount === 0}`；文案同理。
- 每个按钮后紧跟对应的 `<TaskProgress run={…} />`。

- [ ] **Step 3: 类型检查**

```bash
cd apps/web && npx tsc --noEmit
```

- [ ] **Step 4: 浏览器人工验收**

「找项目」→「需求信号」tab → 点「提炼分类」，确认按钮旁出现秒表与逐条进度（这是本任务的核心收益：改造前这里完全没有任何进度）。

- [ ] **Step 5: 提交**

```bash
git add apps/web/src/pages/DemandPage.tsx
git commit -m "feat(web): 需求信号页 3 个长任务接入 useTaskRun（原先进度事件被丢弃）"
```

---

### Task 5: Workshop 主线接入（共享 running 的四个文件）

**Files:**
- Modify: `apps/web/src/pages/WorkshopPage.tsx`
- Modify: `apps/web/src/pages/workshop/CopyTab.tsx`
- Modify: `apps/web/src/pages/workshop/ScriptTab.tsx`
- Modify: `apps/web/src/pages/workshop/VideoTab.tsx`

**Interfaces:**
- Consumes: `useTaskRun` / `TaskProgress`（Task 2 产出）
- Produces: 无

`WorkshopPage` 有**一个** `running` 布尔同时管三件事（`generate` 生成文案、`makeVideo` 出视频、以及经 `onRunningChange` 交给 `ScriptTab` 的生成脚本），并把 `running` 作为 prop 传给 `CopyTab`/`ScriptTab`/`VideoTab` 控制按钮禁用。这四个文件必须一起改，不能拆开。

- [ ] **Step 1: WorkshopPage 换成两个 run + 派生 busy**

删除 `logs`/`setLogs` 与 `running`/`setRunning` 两组 state；`logRef` 本身保留（日志框还要用它滚动，只是滚动语句改由 effect 触发）。新增：

```ts
  const copyRun = useTaskRun()
  const videoRun = useTaskRun()
  // 生成脚本的 run 由 ScriptTab 自己持有，通过 onRunningChange 回传忙碌态
  const [scriptBusy, setScriptBusy] = useState(false)
  const busy = copyRun.running || videoRun.running || scriptBusy
  const activeRun = copyRun.running ? copyRun : videoRun
```

`generate(feedback?, hookOverride?, nOverride?)` 改写（保留三个可选参数与原有 body 构造）：

```ts
  function generate(feedback?: string, hookOverride?: string, nOverride?: number) {
    if (!selected) return
    copyRun.run(
      async () => (await api<{ taskId: string }>(`/api/projects/${selected}/copy`, {
        method: 'POST',
        body: JSON.stringify({ hook: hookOverride ?? hook, n: nOverride ?? n, feedback }),
      })).taskId,
      () => qc.invalidateQueries({ queryKey: ['assets', selected] }),
    )
  }
```

`makeVideo(assetId)` 同构，endpoint `POST /api/projects/${selected}/video`，body 保持原有那一长串参数（`assetId, tpl, bgm, mood, bg: vp.tpl === 'story' ? undefined : vp.bg, captions, ratio`）**逐字不变**，收尾同为 invalidate `['assets', selected]`。

传给子组件的 prop 由 `running={running}` 改成 `running={busy}`；`ScriptTab` 的 `onRunningChange={setRunning}` 改成 `onRunningChange={setScriptBusy}`。

底部日志框改读 `activeRun.logs`，滚动改 effect：

```ts
  useEffect(() => { logRef.current?.scrollTo({ top: 999999 }) }, [activeRun.logs.length])
```

在项目下拉框那一行的「查看项目详情 →」之后插入 `<TaskProgress run={activeRun} className="max-w-[360px]" />`。

- [ ] **Step 2: ScriptTab 自持一个 run**

`ScriptTab` 的 props 签名不变（仍收 `running` / `onRunningChange`）。内部：

```ts
  const scriptRun = useTaskRun()
  useEffect(() => { onRunningChange(scriptRun.running) }, [scriptRun.running, onRunningChange])

  function generate() {
    if (!selected || chosen == null) return
    scriptRun.run(
      async () => (await api<{ taskId: string }>(`/api/projects/${selected}/script`, {
        method: 'POST', body: JSON.stringify({ assetId: chosen, mode }),
      })).taskId,
      (ok, e) => {
        qc.invalidateQueries({ queryKey: ['assets'] })
        if (!ok) alert('生成失败：' + (e?.message ?? '未知错误'))
      },
    )
  }
```

按钮 `disabled={!selected || running || chosen == null}` 保持（`running` 是父传的聚合 busy），文案 `running ? '生成中…'` 改成 `scriptRun.running ? '生成中…' : '生成拍摄脚本'`——用自己的 run 判断，避免别的任务在跑时这个按钮也显示「生成中…」。按钮后插 `<TaskProgress run={scriptRun} />`。

- [ ] **Step 3: CopyTab / VideoTab 各接收一个 `run` prop**

这两个组件不持有任务，只消费父传的 `running`。父现在传的是聚合 `busy`，若文案继续读它，别的任务在跑时这两个按钮也会显示「生成中…」。解决办法是各加一个 `run` prop：

- `CopyTab` / `VideoTab` 的 props 各新增 `run: TaskRun`（`import type { TaskRun } from '../../useTaskRun'`）。
- `disabled` 继续用父传的聚合 `running`（保持"任一任务在跑就全禁用"）。
- 按钮文案的三元判断从 `running ?` 改成 `run.running ?`（文案字符串本身不变）。
- 生成按钮后插入 `<TaskProgress run={run} />`（`import TaskProgress from '../../components/TaskProgress'`）。
- 父组件分别传 `run={copyRun}`（CopyTab）与 `run={videoRun}`（VideoTab）。

- [ ] **Step 4: 类型检查**

```bash
cd apps/web && npx tsc --noEmit
```

- [ ] **Step 5: 浏览器人工验收**

「做内容」→「文案」tab 点「生成」，确认按钮旁有秒表+进度、底部日志框照常；切到「拍摄脚本」tab 点生成，确认它显示自己的进度且此时「文案」tab 的按钮处于禁用态。

- [ ] **Step 6: 提交**

```bash
git add apps/web/src/pages/WorkshopPage.tsx apps/web/src/pages/workshop/CopyTab.tsx apps/web/src/pages/workshop/ScriptTab.tsx apps/web/src/pages/workshop/VideoTab.tsx
git commit -m "feat(web): 做内容主线（文案/脚本/出视频）接入 useTaskRun"
```

---

### Task 6: UploadTab + TemplatesTab 接入

**Files:**
- Modify: `apps/web/src/pages/workshop/UploadTab.tsx`
- Modify: `apps/web/src/pages/workshop/TemplatesTab.tsx`

**Interfaces:**
- Consumes: `useTaskRun` / `TaskProgress`（Task 2 产出）
- Produces: 无

- [ ] **Step 1: UploadTab 两个任务**

`UploadCard` 组件内的 `reviewing`/`setReviewing` 与 `retroing`/`setRetroing` 换成两个 run。这两处当前**丢弃全部 log 事件**，改造后自动获得进度。

| handler | endpoint | body | 收尾（原样搬运） |
|---|---|---|---|
| `runReview` | `POST /api/assets/${asset.id}/review` | `JSON.stringify(scriptId === '' ? {} : { scriptAssetId: scriptId })` | `qc.invalidateQueries({ queryKey: ['assets'] })`；失败 → `alert('审片失败：' + e.message)` |
| `runRetro` | `POST /api/assets/${asset.id}/retro` | 无 body | `qc.invalidateQueries({ queryKey: ['assets'] })`；失败 → `alert('复盘失败：' + e.message)` |

按钮 `disabled={reviewing}` → `disabled={reviewRun.running}`，文案 `reviewing ?` → `reviewRun.running ?`（retro 同理），各自按钮后插 `<TaskProgress run={…} />`。

注意：`uploading`/`setUploading`（文件上传，走 `fetch` + FormData 不是任务队列）**不动**，它不是 SSE 任务。

- [ ] **Step 2: TemplatesTab 一个任务**

`upload(file)` 目前是「先 `fetch` POST FormData 拿 taskId，再 `subscribeTask` 并用 `await new Promise` 等它结束」的混合写法。改造要点：

- 保留前半段的表单校验（`if (!name.trim()) { alert('请先填模板名称'); return }`）与 FormData 构造，**逐字不变**。
- `start` 回调里做 `fetch` 并返回 taskId；`res.ok` 为 false 时 `throw new Error(await res.text())`，交给 hook 兜成 failed（原先是 `setLogs` 后 return，改造后统一走错误路径）。
- 原先 `finally` 里的 `setRunning(false)` 由 hook 接管；`if (fileRef.current) fileRef.current.value = ''` 与 `setName('')`/`setStyleNote('')` 搬进 `onSettled`（注意：清空表单原本只在成功路径外的 `finally` 里做，改造后放 `onSettled` 里无条件执行，与原行为一致）。
- `qc.invalidateQueries({ queryKey: ['templates'] })` 搬进 `onSettled`。

```ts
  const tplRun = useTaskRun()
  async function upload(file: File) {
    if (!name.trim()) { alert('请先填模板名称'); return }
    const fd = new FormData()
    fd.append('file', file)
    fd.append('aspectRatio', aspectRatio)
    fd.append('name', name.trim())
    if (styleNote.trim()) fd.append('styleNote', styleNote.trim())
    tplRun.run(
      async () => {
        const res = await fetch('/api/templates', { method: 'POST', body: fd })
        if (!res.ok) throw new Error(`上传失败: ${await res.text()}`)
        return (await res.json() as { taskId: string }).taskId
      },
      () => {
        qc.invalidateQueries({ queryKey: ['templates'] })
        setName(''); setStyleNote('')
        if (fileRef.current) fileRef.current.value = ''
      },
    )
  }
```

按钮 `disabled={running}` → `disabled={tplRun.running}`（页面里另外三处 `disabled={running}` 的输入框同理），文案 `running ?` → `tplRun.running ?`，日志框 `logs` → `tplRun.logs`，按钮后插 `<TaskProgress run={tplRun} />`。

- [ ] **Step 3: 类型检查**

```bash
cd apps/web && npx tsc --noEmit
```

- [ ] **Step 4: 浏览器人工验收**

「做内容」→「成片」tab，对任一已上传成片点「审片」，确认按钮旁出现秒表与进度（改造前这里无任何进度）。再到「模板库」tab 确认按钮禁用/文案/日志框工作正常。

- [ ] **Step 5: 提交**

```bash
git add apps/web/src/pages/workshop/UploadTab.tsx apps/web/src/pages/workshop/TemplatesTab.tsx
git commit -m "feat(web): 成片审片/复盘与模板库接入 useTaskRun"
```

---

### Task 7: TailorDrawer + AssetCard + TopicsPage 接入

**Files:**
- Modify: `apps/web/src/drawers/TailorDrawer.tsx`
- Modify: `apps/web/src/components/AssetCard.tsx`
- Modify: `apps/web/src/pages/TopicsPage.tsx`

**Interfaces:**
- Consumes: `useTaskRun` / `TaskProgress`（Task 2 产出）
- Produces: 无

- [ ] **Step 1: TailorDrawer——一个联合类型 state 拆成三个 run**

现状 `const [running, setRunning] = useState<'decompose' | 'search' | 'proposal' | null>(null)` 一个 state 管三个按钮。改成：

```ts
  const decomposeRun = useTaskRun()
  const searchRun = useTaskRun()
  const proposalRun = useTaskRun()
  const busy = decomposeRun.running || searchRun.running || proposalRun.running
  const activeRun = decomposeRun.running ? decomposeRun : searchRun.running ? searchRun : proposalRun
```

`runAction(action)` 拆成按 action 取对应 run 的写法：

```ts
  function runAction(action: 'decompose' | 'search' | 'proposal') {
    // 守卫读 detail.data（不是 d）——runAction 定义在 `const d = detail.data` 那行之前
    if (action === 'decompose' && (detail.data?.capabilities.length ?? 0) > 0
      && !window.confirm('重新拆解会清掉现有能力清单和已搜的轮子，继续？')) return
    const r = action === 'decompose' ? decomposeRun : action === 'search' ? searchRun : proposalRun
    r.run(
      async () => (await api<{ taskId: string }>(`/api/tailor/${id}/${action}`, { method: 'POST', body: '{}' })).taskId,
      (ok, e) => {
        qc.invalidateQueries({ queryKey: ['tailor', id] })
        qc.invalidateQueries({ queryKey: ['tailor-proposal', id] })
        if (!ok) alert(e?.message ?? '任务失败')
      },
    )
  }
```

`runAction` 原本是 `async` 且带 `if (running) return` 守卫，改写后两者都不需要——`run()` 自带重入保护，且不再需要 await。

三个按钮 `disabled={!!running}` → `disabled={busy}`（第三个额外的 `|| !caps.length || pendingCount > 0` 条件保留，第二个的 `|| d.request.status === 'draft'` 保留）；文案 `running === 'decompose' ?` → `decomposeRun.running ?`（其余两个同理）。日志框 `logs` → `activeRun.logs`。三个按钮所在的那个 `flex` 行末尾插 `<TaskProgress run={activeRun} className="self-center max-w-[320px]" />`。

- [ ] **Step 2: AssetCard——重生成封面**

`coverBusy`/`setCoverBusy` → `const coverRun = useTaskRun()`。这处当前**丢弃全部 log 事件**。

```ts
  function regenerateCover() {
    coverRun.run(
      async () => (await api<{ taskId: string }>(`/api/assets/${asset.id}/cover`, {
        method: 'POST',
        body: JSON.stringify({ template: coverTemplate || undefined, shot: coverShot || undefined }),
      })).taskId,
      (ok, e) => {
        qc.invalidateQueries({ queryKey: ['assets'] })
        if (!ok) alert('封面生成失败：' + (e?.message ?? '未知错误'))
      },
    )
  }
```

按钮 `disabled={coverBusy}` → `disabled={coverRun.running}`，文案 `coverBusy ?` → `coverRun.running ?`，按钮后插 `<TaskProgress run={coverRun} />`（import 路径 `./TaskProgress`——同在 `components/` 目录下）。

- [ ] **Step 3: TopicsPage——提炼**

`extracting`/`setExtracting` 与 `extractLog`/`setExtractLog`（注意这个是 `string` 不是 `string[]`）换成一个 run：

```ts
  const extractRun = useTaskRun()
  function extract() {
    extractRun.run(
      async () => (await api<{ taskId: string }>('/api/topics/extract', { method: 'POST', body: '{}' })).taskId,
      (ok, e) => {
        if (ok) qc.invalidateQueries({ queryKey: ['topics', 'patterns'] })
        else alert(e?.message ?? '提炼失败')
      },
    )
  }
```

**注意原行为差异**：原代码只在 `e.type === 'done'` 时 invalidate，error 时不 invalidate 也不 alert（只是复位按钮）。这里保持"成功才 invalidate"，并补上失败 alert——失败静默是原代码的缺陷，补 alert 属于本次修复范围内的合理改进，在提交信息里说明。

按钮 `disabled={extracting}` → `disabled={extractRun.running}`，文案同理。渲染日志的 `{extractLog && <pre …>{extractLog}</pre>}` 改成 `{extractRun.logs.length > 0 && <pre …>{extractRun.logs.join('\n')}</pre>}`（`<pre>` 的 className 保持原样）。按钮后插 `<TaskProgress run={extractRun} />`。

- [ ] **Step 4: 类型检查 + 全局残留检查**

```bash
cd apps/web && npx tsc --noEmit
cd ../.. && grep -rn "subscribeTask" apps/web/src | grep -v "api.ts"
```

预期：`tsc` 无输出；`grep` 无输出（所有调用点都已迁移到 hook，只剩 `api.ts` 里的定义）。

- [ ] **Step 5: 浏览器人工验收**

「定制」→ 打开需求抽屉点「搜轮子」；「找项目」→ 任一候选卡片的封面「生成」；顶栏「选题库」→「重新提炼」。三处都确认按钮旁有秒表与进度。

- [ ] **Step 6: 提交**

```bash
git add apps/web/src/drawers/TailorDrawer.tsx apps/web/src/components/AssetCard.tsx apps/web/src/pages/TopicsPage.tsx
git commit -m "feat(web): 定制抽屉/封面重生成/选题提炼接入 useTaskRun，补上提炼失败提示"
```

---

### Task 8: 全站回归与文档

**Files:**
- Modify: `README.md`（若其中描述了任务进度/交互行为则更新；没有相关段落则跳过，不为本次改动强行加章节）

**Interfaces:**
- Consumes: Task 1-7 全部产出
- Produces: 无

- [ ] **Step 1: 全量测试**

```bash
export NVM_DIR="$HOME/.nvm" && source "$NVM_DIR/nvm.sh" && nvm use 22.23.2
npx pnpm test 2>&1 | grep -E "FAIL|Test Files|Tests  "
```

预期：11 个 package 全 passed，无 FAIL。`packages/studio` 的 `tts.test.ts` 与 `packages/rebrand` 的 `kill-port.test.ts` 在并行满载时偶发超时，属已知既有 flake——若命中，单独重跑该文件确认通过即可，不算回归。

- [ ] **Step 2: 前端构建验证**

```bash
cd apps/web && npx tsc --noEmit && npx vite build
```

预期：类型无输出、构建成功。

- [ ] **Step 3: README 检查**

```bash
grep -n "进度\|任务\|SSE" README.md | head -20
```

若 README 有描述长任务交互的段落，补一句"长任务按钮旁实时显示已用时长与最新进度"；若没有相关段落，跳过本步（按全局规则：不为琐碎改动翻写 README）。

- [ ] **Step 4: 提交（若有 README 改动）**

```bash
git add README.md
git commit -m "docs: README 补充长任务进度反馈说明"
```

