# 全部重新评分 设计（看板改进 A）

> 日期：2026-07-25　状态：设计已确认，待写实施计划
>
> 看板改进三件套之 A。B（卡片详细介绍+说明书）、C（分类筛选）各自独立 spec，A 先做。

## 目标

看板现有 207 个候选大多是离线启发式评分（假的 91 分，无目标群体/痛点）。加「全部重新评分」按钮，后台把**还没真评过**的候选批量用 LLM（live，DeepSeek）真评分，带进度、可续跑、fail-soft。

## 关键设计

1. **只评"未真评过"的**：判断依据 `score_detail.targetBuyer` 为空 = 还是启发式假分（heuristicScore 不产出 targetBuyer/painPoint）；非空 = 已真评过。批量任务遍历所有候选，**跳过 targetBuyer 已非空的**（省额度、可中断后续跑）。强制重评单个候选仍用卡片上的「重新评分」。
2. **后台任务 + SSE 进度**：复用现有任务队列（scout 同款）。点按钮 → `POST /api/candidates/rescore-all` 排队 → 任务里顺序遍历、逐个 `rescoreCandidate(ctx, id)`，每个前后打进度日志（`评分中 12/207…`）→ 前端订阅 SSE 显示进度 → 完成后刷新候选列表。
3. **顺序跑**：一个个调（不并发），避免 DeepSeek 限流。
4. **fail-soft**：单个候选 LLM 失败（超时/限流/解析失败）→ 记一条 ⚠ 日志、跳过、继续下一个；不中断整批。
5. **开始前二次确认**：前端 `window.confirm('将对 N 个未评候选真评分，消耗 key 额度、耗时较长（每个几秒），继续？')`；N = 未真评候选数（前端据已加载的 candidates 里 targetBuyer 为空的数量估算）。
6. **mock 模式提示**：若当前 LLM 是 mock，任务里 rescore 不产真分——任务开始时若 `ctx.config.llm.mode==='mock'` 直接返回一条提示日志、不空跑（前端也可在确认前提示）。

## 组件与接口

### scout：新增可测的筛选助手 + 复用 rescoreCandidate
`rescoreCandidate(ctx, id)` 已存在（rescore 单个候选）。新增纯查询助手（便于单测，避免测批量时打网络）：
`candidatesNeedingRescore(ctx: CoreCtx): number[]`——查所有候选，解析 `score_detail`，返回 `targetBuyer` 为空（空串/缺字段/JSON 解析失败都算）的候选 id 列表。批量任务用它拿"需评"列表。

### 后端 `packages/server/src/app.ts`
`POST /api/candidates/rescore-all` → `queue.enqueue(async (log) => { ... })` 返回 `{ taskId }`：
- 若 `ctx.config.llm.mode === 'mock'` → `log('⚠ 当前为 mock 模式，真评分不生效；请先在设置切 live 并填 key')` 后 return。
- `const 需评 = candidatesNeedingRescore(ctx)`（复用助手）；`N = 需评.length`。
- `log('共 N 个候选需真评分…')`；`for (const [i, id] of 需评.entries())`：`log('评分中 ' + (i+1) + '/' + N + '：' + repo)`；`try { await rescoreCandidate(ctx, id) } catch (e) { log('⚠ ' + repo + ' 评分失败：' + e.message) }`。
- 末尾 `log('完成：真评 X 个，跳过失败 Y 个')`。
- 任务抛错的兜底由队列处理（同 scout）。

「未真评」判定：解析 `score_detail` JSON，`!d.targetBuyer`（空串/缺字段/解析失败都视为需评）。

### 前端 `apps/web/src/pages/BoardPage.tsx`
「抓取候选」按钮旁加「全部重新评分」按钮：
- `onClick`：算未评数 `n = candidates.filter(c => !parseDetail(c.score_detail)?.targetBuyer).length`；`window.confirm('将对 ' + n + ' 个未评候选真评分，消耗 key 额度、耗时较长，继续？')` 确认后 → `POST /api/candidates/rescore-all` → `subscribeTask` 显示进度（复用 scout 的 logs/进度 UI）→ done 时 `qc.invalidateQueries(['candidates'])`。
- 评分中禁用按钮（复用 scanning 类似的 busy 状态，或新增 rescoringAll 状态）。

## Fail-soft / 边界
- 无候选 / 全部已真评 → N=0，任务 log「无需评分」直接完成（前端 confirm 也可拦 n===0 时提示）。
- 单候选失败 → 跳过继续（见上）。
- mock 模式 → 提示不空跑。
- 任务进行中刷新页面 → 任务在后台继续（队列在服务端）；重进看板订阅不到旧任务进度，但评分结果已落库、刷新可见（可接受，不做任务恢复 UI）。

## 测试
| 层 | 用例 |
|---|---|
| `candidatesNeedingRescore`（scout，纯 DB） | 插入几个候选：有的 score_detail 含 targetBuyer、有的不含/JSON 坏/NULL → 只返回 targetBuyer 为空的那些 id |
| server `rescore-all` | mock 模式 → 返 taskId，任务只 log「mock 提示」不遍历（不新增/改动候选 score_detail）；非 mock 空库 → 无需评、log 完成。（用 mock LLM 或空候选，避免真调 DeepSeek）|
| 前端 | 手动走查（主控里程碑）：live 下点「全部重新评分」→ 确认弹窗 → 进度日志滚动 → 完成后看板分数/痛点更新；mock 模式点则任务提示切 live |

（批量真遍历 + 逐个 fail-soft 由主控里程碑真跑验证——需 live DeepSeek，单测里 mock README 抓取+LLM 太重、收益低；`candidatesNeedingRescore` 与 mock 早返回已单测覆盖决策逻辑。）

## 不做
- 并发评分、强制重评已评过的、评分同时生成详细介绍（B）、任务进度恢复 UI、按分数/领域筛选（C）。
