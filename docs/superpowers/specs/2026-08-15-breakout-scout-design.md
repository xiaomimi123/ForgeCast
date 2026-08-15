# 爆款项目检测（手动触发） 设计

## 背景

分析了一个真实案例：`deepseek-ai/deepseek-harness`（官方 CLI Agent 框架）2026-08-13 发布，8 小时内涨到近 10 万星；第三方组织 `anywhere-labs` 在发布后 6 小时内就用 Electron 包了个桌面壳子上线官网，靠"上游只有命令行、普通用户装不明白"这个真实体验缺口自带流量，2 天内自己涨到 1664 星。

用户认可这个打法的核心价值：不是单纯蹭热点炒作，而是解决"用户想用但装不明白"的真实痛点，产品因为补上这个缺口而自带流量。用户明确本次范围：**不做软件交付能力（不引入 Electron/安装包/桌面应用打包）**，而是给 ForgeCast 现有的"找项目→分析→换皮→做内容→发布"短视频流水线，新增一种"爆款信号"来源——检测到现象级新星项目后，走**现有**的换皮/做内容流程产出蹭热度的短视频素材（介绍/安利这个爆款项目），成本低、复用现有全部基础设施。

## 现有系统摸底

- `packages/scout/src/github.ts` 的 `GithubClient` 接口：`searchRepos(topics, opts)`（按 topic 白名单+`pushed:>`日期+`minStars` 搜，live 模式对每个 topic 发一次请求去重）、`searchByKeywords(keywords, opts)`（tailor 用，全文搜）。GitHub search API 原生支持 `created:>YYYY-MM-DD` 限定符（仓库创建时间）和 `stars:>=N`，**不需要自己记录历史快照算增速**，一次查询直接筛出"最近创建+当前星数达标"的仓库，按 star 数排序。
- `packages/scout/src/scout.ts` 的 `scoutCandidates`（常规每日巡检，走 `onlyNew` 语义避免重复评分）和内部 `ingest()`（协议 gate→抓 README→LLM 评分→upsert 入 `candidates` 表，任何调用方复用这一个函数）。
- `apps/web/src/pages/board/CandidateCard.tsx` 的 `isNew` 判定（`localDay(c.created_at) === today`）已经会给"今天入库"的候选打"今日入炉"火焰角标——**新插入的爆款候选自动获得这个视觉标记，不需要新增数据库字段做区分**。
- 现有"抓取候选"按钮走 `POST /api/scout` → 任务队列 + SSE 进度日志（`apps/web/src/pages/ScoutPage.tsx` 的 `scout()` 函数）。

## 设计

### 检测标准（已与用户确认）

创建时间 ≤ 7 天 **且** 当前 star 数 ≥ 2000，按 star 数降序取 top N（`limit` 可配，默认 30，与 `scoutCandidates` 现有默认一致）。

### 触发方式（已与用户确认）

**手动按钮**，不做定时任务/后台轮询——找项目页现有"抓取候选"按钮旁边加一个"🔥 找爆款"按钮，用户想查的时候点，不需要新增调度基础设施。

### 组件

**`packages/scout/src/github.ts`** —— `GithubClient` 接口新增一个方法：

```ts
export interface GithubClient {
  searchRepos(topics: string[], opts: SearchOpts): Promise<RepoMeta[]>
  searchByKeywords(keywords: string[], opts: { perPage: number }): Promise<RepoMeta[]>
  /** 爆款检测：按「创建时间 + 当前 star 数」筛新晋高星仓库，按 star 降序，不去重多次请求（单次查询） */
  searchBreakouts(opts: { minStars: number; createdAfter: string; perPage: number }): Promise<RepoMeta[]>
  fetchReadme(repo: string): Promise<string>
  fetchTree(repo: string): Promise<string[]>
}
```

- mock 分支：和现有 `searchRepos`/`searchByKeywords` 一样，直接返回 `candidateFixtures`（截到 `opts.perPage`），忽略入参——保持"mock 就是离线 fixture，不模拟真实过滤逻辑"的既有约定。
- live 分支：发一次请求 `q=stars:>=${opts.minStars} created:>${opts.createdAfter}&sort=stars&per_page=${opts.perPage}`，其余错误处理/字段映射逻辑与现有 `searchByKeywords` 一致（`res.ok` 失败抛错，带限流提示）。

**`packages/scout/src/scout.ts`** —— 新增：

```ts
export async function scoutBreakouts(
  ctx: CoreCtx,
  opts: { minStars?: number; withinDays?: number; limit?: number } = {},
): Promise<{ found: number; scored: number; rejected: number; added: number }>
```

- `minStars` 默认 2000，`withinDays` 默认 7（换算成 `createdAfter = 今天减 withinDays 天，YYYY-MM-DD`），`limit` 默认 30。
- 逻辑：`gh.searchBreakouts({minStars, createdAfter, perPage: limit})` 拿到列表 → 对每个结果按协议 gate 判定 → 协议过关的调用 `ingest(ctx, gh, meta, true)`（永远评分，不做 `onlyNew` 判断——这是手动偶发触发，不是每日巡检，每次点击都应该拿到最新的元数据和评分，不用像 `scoutCandidates` 那样为了省 LLM 额度而跳过已存在的 repo）→ 协议不过的只登记不评分（复用 `ingest` 的 `scoreIt=false` 分支）。返回值形状和 `scoutCandidates` 一致（`found/scored/rejected/added`），方便前端复用同一套进度文案渲染逻辑。

**`packages/server/src/app.ts`** —— 新增：

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

放在现有 `POST /api/scout` 路由定义之后，风格照抄（同样的 `queue.enqueue` 任务队列+SSE 进度模式）。

**`cli.ts`** —— `scout` 命令加 `--breakouts` 标志：命中时调用 `scoutBreakouts` 而不是 `scoutCandidates`，其余参数解析风格（`--limit`）复用现有 `arg()` helper。

**`apps/web/src/pages/ScoutPage.tsx`** —— 现有"抓取候选"按钮（`scout()` 函数，`POST /api/scout`）旁边加一个"🔥 找爆款"按钮，新增一个 `scoutBreakouts()` 函数，结构完全照抄 `scout()`（`POST /api/scout/breakouts`、同一个 `logs`/`scanning` 状态、同款 SSE 订阅），成功后同样 `qc.invalidateQueries({ queryKey: ['candidates'] })`。找到的候选混进现有候选池，靠已有的"今日入炉"角标（`isNew` 判定）自然高亮，不用额外加"爆款"专属标记。

### 不做的事

- 不做定时/后台自动检测，纯手动按钮触发。
- 不新增数据库字段/表来标记"这是爆款检测来的候选"——复用现有 `created_at`/"今日入炉"角标机制。
- 不做真实 star 增速计算（不记录历史快照），用"创建时间+当前 star 数"的静态阈值代替。
- 不引入任何软件交付能力（Electron/安装包构建/桌面应用打包）——检测到的爆款项目走的是 ForgeCast 现有的"选品→换皮→做短视频内容"流程，不是"打包成桌面应用"。
- 不做主动推送提醒，用户需要自己点按钮查看。

## 测试

- `packages/scout/test/github.test.ts`（若无此文件，在 `scout.test.ts` 里加一个新 `describe`）：mock 模式下 `searchBreakouts` 返回 fixtures（截到 `perPage`）；live 分支用假 `fetchImpl` 验证请求 URL 里正确拼了 `stars:>=N`、`created:>日期`、`sort=stars`（不需要真打 GitHub API，验证 query 字符串拼装正确即可，参照现有 `searchByKeywords` live 分支若有类似测试的写法）。
- `packages/scout/test/scout.test.ts`：`scoutBreakouts` mock 模式下——命中的 fixture 全部评分入池（不受 `onlyNew` 限制，即使 repo 已存在于 `candidates` 表也重新评分覆盖）、协议不过的只登记不评分、返回值形状正确。
- `packages/server/test/scout-extras.test.ts` 或类似现有文件：`POST /api/scout/breakouts` 返回 taskId，任务完成后候选入库。
- 前端不加自动化测试，走 `pnpm --filter web exec tsc --noEmit` + 人工点击"🔥 找爆款"按钮验证 SSE 进度日志和候选卡片正常出现。
