# 爆款项目检测（手动触发） Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 找项目面板新增一个手动触发的"🔥 找爆款"功能——按「创建时间 ≤7 天 且 star ≥2000」检测新晋高星 GitHub 仓库，走现有换皮/评分流程入池，供短视频内容管线蹭热度使用。

**Architecture:** GitHub search API 原生支持 `created:>` 和 `stars:>=` 限定符，一次查询直接筛出目标仓库，不需要记录历史快照算增速。检测结果复用现有 `ingest()` 评分入库逻辑和 `candidates` 表，前端靠已有"今日入炉"角标自然高亮，不新增字段/表。自底向上实现：先 `github.ts` 客户端方法，再 `scout.ts` 业务函数，再 server 路由，再 CLI，最后前端按钮。

**Tech Stack:** TypeScript, Vitest（后端测试），Hono（server 路由），React + TanStack Query（前端，不加自动化测试）。

## Global Constraints

- 检测标准固定：`minStars` 默认 2000，`withinDays` 默认 7（换算成 `createdAfter = 今天 - withinDays 天`，格式 `YYYY-MM-DD`），`limit` 默认 30。
- **纯手动按钮触发，不做定时/后台自动检测**，不新增调度基础设施。
- **不新增数据库字段/表**标记"这是爆款检测来的候选"——复用现有 `created_at` + 前端"今日入炉"角标机制。
- **不做真实 star 增速计算**（不记录历史快照），用"创建时间+当前 star 数"的静态阈值代替。
- **不引入任何软件交付能力**（不做 Electron/安装包构建/桌面应用打包）——检测到的项目走 ForgeCast 现有"选品→换皮→做短视频内容"流程。
- **不做主动推送提醒**，用户需要自己点按钮查看。
- `scoutBreakouts` **不做 `onlyNew` 限制**——每次点击都对命中的协议 OK 仓库重新评分覆盖（这是手动偶发触发，不是每日巡检，不用为了省 LLM 额度而跳过已存在的 repo）。
- 参考 spec：`docs/superpowers/specs/2026-08-15-breakout-scout-design.md`。

---

### Task 1: GithubClient.searchBreakouts（客户端方法）

**Files:**
- Modify: `packages/scout/src/github.ts`
- Test: `packages/scout/test/github.test.ts`

**Interfaces:**
- Produces: `GithubClient.searchBreakouts(opts: { minStars: number; createdAfter: string; perPage: number }): Promise<RepoMeta[]>`——Task 2（`scoutBreakouts`）依赖此方法。

- [ ] **Step 1: 写失败测试——mock 分支返回 fixtures，受 perPage 限制**

在 `packages/scout/test/github.test.ts` 文件末尾（`describe('searchByKeywords', ...)` 块之后）新增：

```ts
describe('searchBreakouts', () => {
  it('mock 返回 fixture，条数受 perPage 限制', async () => {
    const gh = createGithubClient({ mode: 'mock', token: '' })
    const repos = await gh.searchBreakouts({ minStars: 2000, createdAfter: '2026-08-08', perPage: 2 })
    expect(repos.length).toBe(2)
    expect(repos[0].repo).toBe(candidateFixtures[0].repo)
  })

  it('live 拼对 URL（stars/created/sort/per_page）并解析', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      items: [{
        full_name: 'acme/newstar', html_url: 'https://github.com/acme/newstar', description: '新晋爆款',
        license: { spdx_id: 'MIT' }, stargazers_count: 5000, pushed_at: '2026-08-14T00:00:00Z', topics: [],
      }],
    })))
    const gh = createGithubClient({ mode: 'live', token: 't1' }, fetchImpl as any)
    const repos = await gh.searchBreakouts({ minStars: 2000, createdAfter: '2026-08-08', perPage: 30 })
    expect(repos[0]).toEqual({
      repo: 'acme/newstar', url: 'https://github.com/acme/newstar', description: '新晋爆款',
      license: 'MIT', stars: 5000, lastCommit: '2026-08-14T00:00:00Z', topics: [],
    })
    const [url, init] = fetchImpl.mock.calls[0] as any
    expect(url).toContain('stars%3A%3E%3D2000')
    expect(url).toContain('created%3A%3E2026-08-08')
    expect(url).toContain('sort=stars')
    expect(url).toContain('per_page=30')
    expect(init.headers.authorization).toBe('Bearer t1')
  })

  it('live 请求失败（限流）→ 抛错带提示', async () => {
    const fetchImpl = vi.fn(async () => new Response('rate limited', { status: 403 }))
    const gh = createGithubClient({ mode: 'live', token: 't1' }, fetchImpl as any)
    await expect(gh.searchBreakouts({ minStars: 2000, createdAfter: '2026-08-08', perPage: 30 }))
      .rejects.toThrow(/限流/)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/scout && npx vitest run test/github.test.ts -t "searchBreakouts"`
Expected: FAIL（`gh.searchBreakouts is not a function`）

- [ ] **Step 3: 改 `GithubClient` 接口**

`packages/scout/src/github.ts` 顶部的接口定义，加一个方法（放在 `searchByKeywords` 之后、`fetchReadme` 之前）：

```ts
export interface GithubClient {
  searchRepos(topics: string[], opts: SearchOpts): Promise<RepoMeta[]>
  /** 按关键词全文搜（tailor 找轮子用）：失败抛错（调用方按能力项隔离失败），searchRepos 则是静默跳过 */
  searchByKeywords(keywords: string[], opts: { perPage: number }): Promise<RepoMeta[]>
  /** 爆款检测：按「创建时间 + 当前 star 数」筛新晋高星仓库，按 star 降序，单次查询不去重多请求 */
  searchBreakouts(opts: { minStars: number; createdAfter: string; perPage: number }): Promise<RepoMeta[]>
  fetchReadme(repo: string): Promise<string>
  fetchTree(repo: string): Promise<string[]>
}
```

- [ ] **Step 4: mock 分支实现**

在 `createGithubClient` 的 `if (cfg.mode === 'mock')` 分支返回对象里，`searchByKeywords` 方法之后加：

```ts
      async searchBreakouts(opts) {
        return candidateFixtures.slice(0, opts.perPage).map((f) => ({
          repo: f.repo, url: f.url, description: f.description, license: f.license,
          stars: f.stars, lastCommit: f.lastCommit, topics: f.topics,
        }))
      },
```

- [ ] **Step 5: live 分支实现**

在 `createGithubClient` 的 live 分支返回对象里，`searchByKeywords` 方法之后加（照抄 `searchByKeywords` 的错误处理风格）：

```ts
    async searchBreakouts(opts) {
      const q = `stars:>=${opts.minStars} created:>${opts.createdAfter}`
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

- [ ] **Step 6: 跑测试确认通过**

Run: `cd packages/scout && npx vitest run test/github.test.ts`
Expected: PASS（全部用例）

- [ ] **Step 7: Commit**

```bash
cd "/Users/lizhishaoniange/Documents/开源变现内容工厂"
git add packages/scout/src/github.ts packages/scout/test/github.test.ts
git commit -m "feat(scout): GithubClient 加 searchBreakouts 爆款检测查询"
```

---

### Task 2: scoutBreakouts（业务逻辑）

**Files:**
- Modify: `packages/scout/src/scout.ts`
- Test: `packages/scout/test/scout.test.ts`

**Interfaces:**
- Consumes: `GithubClient.searchBreakouts(opts): Promise<RepoMeta[]>`（Task 1 产出）；`ingest(ctx, gh, meta, scoreIt)`（同文件已有的私有函数，直接调用不用改）；`isLicenseOk(license)`（已有导入）。
- Produces: `scoutBreakouts(ctx: CoreCtx, opts?: { minStars?: number; withinDays?: number; limit?: number }): Promise<{ found: number; scored: number; rejected: number; added: number }>`——Task 3（server 路由）、Task 4（CLI）依赖此函数签名。

- [ ] **Step 1: 写失败测试**

在 `packages/scout/test/scout.test.ts` 文件末尾新增：

```ts
describe('scoutBreakouts (mock)', () => {
  it('命中的协议 OK 仓库全部评分入池；协议不过只登记', async () => {
    const r = await scoutBreakouts(ctx)
    expect(r.found).toBe(candidateFixtures.length)
    expect(r.rejected).toBe(1) // GPL fixture
    expect(r.scored).toBe(okCount)
    expect(r.added).toBe(okCount)
    const rows: any[] = ctx.db.prepare('SELECT * FROM candidates').all()
    const scored = rows.filter((x) => x.license_ok === 1)
    expect(scored.every((x) => x.score > 0)).toBe(true)
  })

  it('不受 onlyNew 限制：repo 已存在也重新评分覆盖', async () => {
    await scoutCandidates(ctx) // 先用常规扫描入池一次
    const before: any = ctx.db.prepare("SELECT score FROM candidates WHERE repo = 'chatwoot/chatwoot'").get()
    ctx.db.prepare("UPDATE candidates SET score = 1 WHERE repo = 'chatwoot/chatwoot'").run() // 手动改低，验证会被覆盖
    const r = await scoutBreakouts(ctx)
    expect(r.added).toBeGreaterThanOrEqual(1) // 即使 repo 已存在，命中的仍计入 added（不做 onlyNew 判定）
    const after: any = ctx.db.prepare("SELECT score FROM candidates WHERE repo = 'chatwoot/chatwoot'").get()
    expect(after.score).not.toBe(1) // 被重新评分覆盖，不再是我们手动改的 1
    expect(before.score).toBeGreaterThan(0) // sanity：确认 before 本身是正常评分（非空）
  })

  it('opts 透传：minStars/withinDays/limit 影响调用参数（用 spy 验证）', async () => {
    const spy = vi.spyOn(ctx.db, 'prepare') // 不直接测 github 调用参数（mock client 忽略参数），改测函数不抛错、返回值形状正确
    const r = await scoutBreakouts(ctx, { minStars: 5000, withinDays: 3, limit: 2 })
    expect(r).toHaveProperty('found')
    expect(r).toHaveProperty('scored')
    expect(r).toHaveProperty('rejected')
    expect(r).toHaveProperty('added')
    spy.mockRestore()
  })
})
```

同时把文件顶部 import 改成加 `scoutBreakouts`：

```ts
import { addRepo, backfillCategories, candidatesNeedingRescore, cleanupCandidates, scoutBreakouts, scoutCandidates } from '../src/scout'
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/scout && npx vitest run test/scout.test.ts -t "scoutBreakouts"`
Expected: FAIL（`scoutBreakouts` 未从 `../src/scout` 导出）

- [ ] **Step 3: 实现 `scoutBreakouts`**

在 `packages/scout/src/scout.ts` 里，`cleanupCandidates` 函数定义结束之后（`backfillCategories` 定义之前）插入：

```ts
/** 爆款检测：按「创建时间 ≤ withinDays 天 且 star ≥ minStars」筛新晋高星仓库，走现有换皮/评分流程入池。
 *  手动偶发触发，不做 onlyNew 限制——命中的协议 OK 仓库每次都重新评分覆盖。 */
export async function scoutBreakouts(
  ctx: CoreCtx,
  opts: { minStars?: number; withinDays?: number; limit?: number } = {},
): Promise<{ found: number; scored: number; rejected: number; added: number }> {
  const gh = createGithubClient(ctx.config.github)
  const minStars = opts.minStars ?? 2000
  const withinDays = opts.withinDays ?? 7
  const limit = opts.limit ?? 30
  const createdAfter = new Date(Date.now() - withinDays * 864e5).toISOString().slice(0, 10)
  const found = await gh.searchBreakouts({ minStars, createdAfter, perPage: limit })

  let scored = 0
  let rejected = 0
  let added = 0
  for (const m of found) {
    const ok = isLicenseOk(m.license)
    await ingest(ctx, gh, m, ok)
    if (ok) { scored++; added++ }
    else rejected++
  }
  return { found: found.length, scored, rejected, added }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd packages/scout && npx vitest run test/scout.test.ts`
Expected: PASS（全部用例）

- [ ] **Step 5: Commit**

```bash
cd "/Users/lizhishaoniange/Documents/开源变现内容工厂"
git add packages/scout/src/scout.ts packages/scout/test/scout.test.ts
git commit -m "feat(scout): 新增 scoutBreakouts 爆款项目检测"
```

---

### Task 3: POST /api/scout/breakouts（server 路由）

**Files:**
- Modify: `packages/server/src/app.ts`
- Test: `packages/server/test/scout-extras.test.ts`

**Interfaces:**
- Consumes: `scoutBreakouts(ctx, opts?): Promise<{found,scored,rejected,added}>`（Task 2 产出，需要先确认从 `@forgecast/scout` 包导出——见 Step 1）。
- Produces: `POST /api/scout/breakouts` 路由，body 可选 `{minStars?, withinDays?, limit?}`，返回 `{taskId}`——Task 5（前端）依赖此路由。

- [ ] **Step 1: 检查 `@forgecast/scout` 包导出**

Run: `grep -n "export \* from './scout'\|scoutBreakouts" "/Users/lizhishaoniange/Documents/开源变现内容工厂/packages/scout/src/index.ts"`

`packages/scout/src/index.ts` 目前是 `export * from './scout'`（通配导出），`scoutBreakouts` 会被自动导出，无需改这个文件。若发现不是通配导出（比如具名导出列表），把 `scoutBreakouts` 加进那个列表。

- [ ] **Step 2: 写失败测试**

在 `packages/server/test/scout-extras.test.ts` 文件末尾新增（需要先在文件顶部补 `wait`/`runTask` 辅助函数和 `path`/`os`/`fs` 相关 import——检查文件头部是否已有，若已有则直接复用，若没有则仿 `candidates.test.ts` 的写法补上）：

```ts
function wait(ms: number) { return new Promise((r) => setTimeout(r, ms)) }
async function runTask(taskId: string) {
  for (let i = 0; i < 100; i++) {
    await wait(20)
    const s = queue.get(taskId)!.status
    if (s === 'done') return
    if (s === 'failed') throw new Error(queue.get(taskId)!.events.at(-1)!.message)
  }
  throw new Error('任务超时')
}

describe('POST /api/scout/breakouts (mock)', () => {
  it('返回 taskId；任务完成后候选入库', async () => {
    const { taskId } = await (await app.request('/api/scout/breakouts', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    })).json() as any
    expect(taskId).toBeTruthy()
    await runTask(taskId)
    const list = await (await app.request('/api/candidates')).json() as any[]
    expect(list.length).toBeGreaterThan(0)
  })
  it('body 透传 minStars/withinDays/limit（不抛错，正常入库）', async () => {
    const { taskId } = await (await app.request('/api/scout/breakouts', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ minStars: 5000, withinDays: 3, limit: 2 }),
    })).json() as any
    await runTask(taskId)
    const list = await (await app.request('/api/candidates')).json() as any[]
    expect(list.length).toBeGreaterThan(0)
  })
})
```

- [ ] **Step 3: 跑测试确认失败**

Run: `cd packages/server && npx vitest run test/scout-extras.test.ts -t "breakouts"`
Expected: FAIL（`/api/scout/breakouts` 404，`taskId` 为 `undefined`，`runTask(undefined)` 抛错或断言失败）

- [ ] **Step 4: 加路由**

`packages/server/src/app.ts` 里找到现有 `app.post('/api/scout', ...)` 路由定义（大约在 388-395 行），确认顶部 `import { ... } from '@forgecast/scout'` 里加上 `scoutBreakouts`（找到现有那一行 import，比如 `import { scoutCandidates, ... } from '@forgecast/scout'`，把 `scoutBreakouts` 加进去，按字母序插入）。

在 `app.post('/api/scout', ...)` 路由结束的 `})` 之后紧接着加：

```ts
  app.post('/api/scout/breakouts', async (c) => {
    const body = await c.req.json().catch(() => ({}))
    const taskId = queue.enqueue((log) => scoutBreakouts(ctx, {
      minStars: typeof body.minStars === 'number' ? body.minStars : undefined,
      withinDays: typeof body.withinDays === 'number' ? body.withinDays : undefined,
      limit: typeof body.limit === 'number' ? body.limit : undefined,
    }).then((r) => { log(`发现 ${r.found} 个爆款候选，评分 ${r.scored}，协议不过 ${r.rejected}`); return r }))
    return c.json({ taskId })
  })
```

- [ ] **Step 5: 跑测试确认通过**

Run: `cd packages/server && npx vitest run test/scout-extras.test.ts`
Expected: PASS（全部用例）

- [ ] **Step 6: Commit**

```bash
cd "/Users/lizhishaoniange/Documents/开源变现内容工厂"
git add packages/server/src/app.ts packages/server/test/scout-extras.test.ts
git commit -m "feat(server): 新增 POST /api/scout/breakouts 路由"
```

---

### Task 4: CLI --breakouts 标志

**Files:**
- Modify: `cli.ts`

**Interfaces:**
- Consumes: `scoutBreakouts(ctx, opts?): Promise<{found,scored,rejected,added}>`（Task 2 产出，从 `@forgecast/scout` 导入）。

无自动化测试（本仓库 `cli.ts` 现有 scout/pick 等命令均无测试文件，本任务遵循既有约定，走人工命令行验证）。

- [ ] **Step 1: 加 import**

`cli.ts` 第 9 行：

```ts
import { addRepo, pickCandidate, scoutCandidates } from '@forgecast/scout'
```

改成：

```ts
import { addRepo, pickCandidate, scoutBreakouts, scoutCandidates } from '@forgecast/scout'
```

- [ ] **Step 2: 加 `--breakouts` 分支**

`cli.ts` 的 `case 'scout':` 块里，在 `const topics = arg('topics')?.split(...)` 那一行之前插入判断（`wantsAdd` 分支的 `break` 之后）：

```ts
      const wantsBreakouts = rest.includes('--breakouts')
      if (wantsBreakouts) {
        const limit = arg('limit') ? Number(arg('limit')) : undefined
        console.log('检测爆款项目中（mock/live 由 .env 决定）…')
        const r = await scoutBreakouts(ctx, { limit })
        console.log(`发现 ${r.found}，评分 ${r.scored}，协议不过 ${r.rejected}\n`)
        const rows = ctx.db.prepare(
          "SELECT repo, stars, license, score, score_detail FROM candidates WHERE license_ok = 1 ORDER BY score DESC LIMIT 20",
        ).all() as any[]
        console.log('名次  score  stars  license      repo')
        rows.forEach((x, i) => {
          const why = x.score_detail ? JSON.parse(x.score_detail).rationale : ''
          console.log(`${String(i + 1).padStart(2)}   ${String(x.score).padStart(5)}  ${String(x.stars).padStart(6)}  ${(x.license ?? '').padEnd(12)} ${x.repo}  ${why}`)
        })
        break
      }
```

（放在现有 `const topics = arg('topics')...` 那一行**之前**，这样 `--breakouts` 和常规 topic 扫描互斥，`--breakouts` 命中就直接 `break` 跳出 `case`，不会往下走常规扫描逻辑。)

- [ ] **Step 3: 人工验证**

```bash
cd "/Users/lizhishaoniange/Documents/开源变现内容工厂"
export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH"
npx tsx cli.ts scout --breakouts
```

预期：控制台打印"检测爆款项目中…"，然后打印"发现 N，评分 N，协议不过 N"和候选排行榜表格（mock 模式下会用 fixtures，输出应该正常无报错）。

- [ ] **Step 4: Commit**

```bash
cd "/Users/lizhishaoniange/Documents/开源变现内容工厂"
git add cli.ts
git commit -m "feat(cli): scout 命令加 --breakouts 爆款检测标志"
```

---

### Task 5: ScoutPage "🔥 找爆款" 按钮

**Files:**
- Modify: `apps/web/src/pages/ScoutPage.tsx`

**Interfaces:**
- Consumes: `POST /api/scout/breakouts`（Task 3 产出的路由，返回 `{taskId}`）；`subscribeTask`（已从 `../api` 导入，现有 `scout()` 函数已在用）。

- [ ] **Step 1: 加 `scoutBreakouts` 状态与函数**

`apps/web/src/pages/ScoutPage.tsx` 里，现有 `scanning`/`scout()` 定义之后（大约 32-82 行之间），新增一个独立的 `scanningBreakouts` 状态和 `scoutBreakouts()` 函数，结构照抄现有 `scout()`：

```ts
  const [scanningBreakouts, setScanningBreakouts] = useState(false)
  async function scoutBreakouts() {
    if (scanningBreakouts || scanning) return
    setScanningBreakouts(true); setLogs([])
    try {
      const { taskId } = await api<{ taskId: string }>('/api/scout/breakouts', { method: 'POST', body: '{}' })
      subscribeTask(taskId, (e) => {
        setLogs((l) => [...l, e.message]); logRef.current?.scrollTo({ top: 999999 })
        if (e.type === 'done' || e.type === 'error') { setScanningBreakouts(false); qc.invalidateQueries({ queryKey: ['candidates'] }) }
      })
    } catch (err) { setLogs((l) => [...l, `❌ ${err instanceof Error ? err.message : String(err)}`]); setScanningBreakouts(false) }
  }
```

- [ ] **Step 2: 加按钮**

在现有"抓取候选"按钮（`<button className="btn-fire ..." disabled={scanning || rescoringAll} onClick={scout}>`，大约第 148-150 行）之后紧接着加：

```tsx
        <button className="btn-fire px-4 py-2 text-sm disabled:opacity-50" disabled={scanning || scanningBreakouts || rescoringAll} onClick={scoutBreakouts}>
          {scanningBreakouts ? '检测中…' : '🔥 找爆款'}
        </button>
```

同时把该按钮组里其它按钮（"全部重新评分"、"分类回填"）的 `disabled` 条件补上 `|| scanningBreakouts`，防止爆款检测进行中时误触其它操作（照抄现有 `disabled={scanning || rescoringAll}` 的模式，改成 `disabled={scanning || scanningBreakouts || rescoringAll}`）。

- [ ] **Step 3: 类型检查**

Run: `cd "/Users/lizhishaoniange/Documents/开源变现内容工厂" && pnpm --filter web exec tsc --noEmit`
Expected: 无新增类型错误

- [ ] **Step 4: 浏览器人工走查**

1. `export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH"`
2. `pnpm dev` 启动，浏览器打开找项目页
3. 点击"🔥 找爆款"按钮，确认：按钮文案变"检测中…"、下方日志区出现进度信息（mock 模式下会用固定 fixtures，很快完成）、完成后候选卡片刷新，新入库的候选带"今日入炉"火焰角标
4. 确认检测过程中"抓取候选"/"全部重新评分"/"分类回填"按钮都被禁用，不能同时触发多个任务

- [ ] **Step 5: Commit**

```bash
cd "/Users/lizhishaoniange/Documents/开源变现内容工厂"
git add apps/web/src/pages/ScoutPage.tsx
git commit -m "feat(web): 找项目页加「🔥 找爆款」按钮"
```

---

## 验证（全部任务完成后）

1. `export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH"`
2. `pnpm test` 全仓回归（重点看 `@forgecast/scout`、`@forgecast/server`）
3. `pnpm --filter web exec tsc --noEmit` + `pnpm --filter web build`
4. 浏览器端到端：`pnpm dev` → 找项目页 → 点"🔥 找爆款" → 确认候选入库、角标正常、日志正常
5. CLI 端到端：`npx tsx cli.ts scout --breakouts` → 确认输出正常、候选入库
