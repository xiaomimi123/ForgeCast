# 爆款候选可见性 + 老候选中文简介补充 设计

## 背景

`breakout-scout` 分支上线后（`docs/superpowers/plans/2026-08-15-breakout-scout.md`），用户点"🔥 找爆款"实测发现两个真实缺口：

1. **扫描结果不好找**：抓到的候选（如 `deepseek-ai/deepseek-harness` 35分、`anywhere-labs/deepseek-harness-desktop` 56分）确实真实入池了，但混在"全部" tab 里 ~100+ 个按分数排序的候选中，分数不算高排不到前面。原本设计指望"今日入炉"角标高亮，但角标判定 `localDay(c.created_at) === today` 用的是 UTC 存储时间和本地日期比较，接近本地午夜抓到的候选角标经常不亮（本仓库已知的 UTC-day 时区坑，这次不修这个根因，见下方"不做的事"）。
2. **老候选没有中文简介**：`summaryZh` 功能（`docs/superpowers/specs/2026-08-15-candidate-card-zh-summary-design.md`）明确决定"不批量回填旧候选"，只有走 `rescoreCandidate` 才会补上。但现有"全部重新评分"按钮用的选取标准 `candidatesNeedingRescore` 是"`score_detail` 里 `targetBuyer` 为空"——这批老候选大部分已经被 live LLM 评过分（`targetBuyer` 有值），所以点"全部重新评分"根本不会碰到它们，`summaryZh` 永远补不上。

## 现有系统摸底

- `packages/scout/src/scout.ts` 的 `scoutBreakouts` 目前返回 `{found, scored, rejected, added}`，服务端路由只把这几个数字塞进一条汇总日志，没有把具体命中的仓库名传回前端。
- `packages/scout/src/scout.ts` 的 `candidatesNeedingRescore` + `rescoreCandidate`：前者是纯查询（选出"还没真评过"的候选 id 列表），后者是单条动作（重抓 README+重跑三维打分+patch 回库）。`packages/server/src/app.ts` 的 `POST /api/candidates/rescore-all` 路由自己拿 `candidatesNeedingRescore` 的结果做循环，每条调 `rescoreCandidate`，边跑边 `log()` 进度，单条失败不中断整批，mock 模式提前警告不生效。这是本次"补中文简介"要复用的现成结构。
- `apps/web/src/pages/ScoutPage.tsx` 的 `logs`/`scanning` 状态和 SSE 订阅模式（`scout()`/`scoutBreakouts()`/`rescoreAll()` 三个函数结构基本一致），日志区域纯文本逐行渲染（`{logs.map((l, i) => <div key={i}>{l}</div>)}`）。

## 设计

### 问题1：扫描完成后日志区直接列出命中仓库名

`packages/scout/src/scout.ts` 的 `scoutBreakouts` 返回类型扩展一个字段：

```ts
export async function scoutBreakouts(
  ctx: CoreCtx,
  opts: { minStars?: number; withinDays?: number; limit?: number } = {},
): Promise<{ found: number; scored: number; rejected: number; added: number; hits: Array<{ repo: string; url: string }> }>
```

`hits` 只收协议 OK（`isLicenseOk(m.license)` 为真）的命中项，跟 `added` 计数一一对应——协议不过的候选本来就只登记不算真正"找到的爆款"，不值得在日志里列出来。

`packages/server/src/app.ts` 的 `POST /api/scout/breakouts` 路由，在原有汇总日志行之后，把 `hits` 逐条 `log()` 出来：

```ts
.then((r) => {
  log(`发现 ${r.found} 个爆款候选，评分 ${r.scored}，协议不过 ${r.rejected}`)
  for (const h of r.hits) log(`  🔥 ${h.repo}`)
  return r
})
```

前端 `ScoutPage.tsx` 零改动——现有 `logs` 状态数组+纯文本渲染直接就能显示这些行，日志区域本来就在按钮下方常驻展示。

### 问题2：新增"补中文简介"轻量链路（不碰三维打分）

**`packages/scout/src/score.ts` 新增 `generateSummaryZh`**：

```ts
/** 只生成中文简介，不重新跑三维打分——用于给老候选（评过分但缺 summaryZh）做轻量补充，
 *  不烧三维评分的 LLM 调用、不改动已有 rationale/targetBuyer/painPoint。 */
export async function generateSummaryZh(ctx: CoreCtx, repo: string, stars: number, readme: string): Promise<string>
```

mock 模式留空串（跟 `heuristicScore`/`scoreCandidate` 的既有约定一致，不编造翻译）。live 模式：单独一次轻量 LLM 调用，prompt 只要求输出 `{"summaryZh":"..."}`，不涉及三维打分/买家/痛点。

**`packages/scout/src/scout.ts` 新增两个函数**（紧跟在 `candidatesNeedingRescore`/`rescoreCandidate` 附近，风格照抄）：

```ts
/** 返回"协议 OK 且 score_detail 里没有 summaryZh"的候选 id 列表，跟 candidatesNeedingRescore 同风格。 */
export function candidatesNeedingSummary(ctx: CoreCtx): number[]

/** 给单个候选补 summaryZh：重抓 README→生成→patch 回 score_detail，不动其它字段。 */
export async function backfillCandidateSummary(ctx: CoreCtx, id: number): Promise<void>
```

**`packages/server/src/app.ts` 新增 `POST /api/candidates/backfill-summary`**，结构照抄 `POST /api/candidates/rescore-all`（同样走任务队列、mock 模式提前警告、逐条 log 进度、单条失败 try/catch 不中断整批）：

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

**`apps/web/src/pages/ScoutPage.tsx`** 新增"补中文简介"按钮，照抄"全部重新评分"（`rescoreAll`/`rescoringAll`）的状态管理模式：独立的 `backfillingSummary` 状态 + `backfillSummary()` 函数（同款 SSE 订阅、成功后 `invalidateQueries(['candidates'])`）。**所有现有按钮的 `disabled` 条件都要补上这个新状态**（`scanning || scanningBreakouts || rescoringAll || backfillingSummary`）——吸取上一轮"抓取候选"按钮漏加 `scanningBreakouts` 导致并发扫描漏洞的教训，这次一次性把四个状态都串进所有按钮的判定里。

## 测试

- `packages/scout/test/score.test.ts`：`generateSummaryZh` mock 模式留空串；live 分支解析 JSON 正常提取/缺失兜底空串（仿 `scoreCandidate` live 分支已有的测试模式）。
- `packages/scout/test/scout.test.ts`：
  - `scoutBreakouts` 新增断言 `hits` 数组内容（只含协议 OK 的，字段为 `{repo, url}`，条数等于 `added`）。
  - `candidatesNeedingSummary`：协议 OK 且缺 `summaryZh` 的被选中；已有 `summaryZh` 的、协议不过的都不选中。
  - `backfillCandidateSummary`：单个候选补上 `summaryZh` 后，`rebrandCost`/`buyerClarity`/`visualAppeal`/`rationale`/`targetBuyer`/`painPoint`/`category` 全部保持不变（只有 `summaryZh` 这一个字段变化）。
- `packages/server/test`：`POST /api/scout/breakouts` 任务完成后的日志事件里出现命中仓库名；`POST /api/candidates/backfill-summary` 返回 taskId，任务完成后候选的 `summaryZh` 被填上，且其它评分字段不受影响。
- 前端不加自动化测试，走 `pnpm --filter web exec tsc --noEmit` + 人工点击验证：找爆款扫描完成后日志区能看到仓库名列表；点"补中文简介"后候选卡片文案变中文；扫描/补充过程中其它按钮全部正确禁用。

## 不做的事

- **不修"今日入炉"角标的 UTC 时区判定 bug**——用户明确表示日志列仓库名就够了，这个已知问题留到以后单独处理（不牵连本次改动）。
- **不把命中候选临时置顶到候选池排序里**——只在日志区域展示，不引入任何"本次会话高亮"的临时前端状态或数据库标记。
- **不用现有"全部重新评分"链路捎带补 summaryZh**——新建独立的轻量链路，不重跑三维打分，不改动已有 `score`/`rationale`/`targetBuyer`/`painPoint`。
- **不做批量回填的进度速率限制/并发控制**——跟现有 `rescore-all` 一样简单串行跑，候选数量级（~90个协议OK候选）不需要额外的限流设计。
