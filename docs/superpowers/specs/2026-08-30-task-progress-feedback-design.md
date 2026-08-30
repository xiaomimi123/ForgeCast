# 长任务过程反馈统一化设计

> 日期：2026-08-30　状态：设计待确认

## 背景

用户反馈：点「抓取候选」这类按钮后，界面长时间没有任何变化，不知道要等多久、也不知道是不是卡死了。

实测复现（2026-08-30 手动触发 `POST /api/scout`）：任务从 18:53 跑到 18:56，**整整 3 分钟里 SSE 只在最后吐了一条消息**：

```
data: {"type":"log","message":"发现 208 个，评分 30，协议不过 114"}
data: {"type":"done","message":"完成","result":{...}}
```

排查下来是两层问题：

**第一层（后端）**：项目里 21 个长任务入口几乎都已经把 `onProgress: log` 透传进业务函数（如「全部重新评分」会逐条报 `评分中 3/17：owner/repo`），唯独 `packages/scout/src/scout.ts` 的 `scoutCandidates`（抓取候选）和 `scoutBreakouts`（找爆款）**函数签名里根本没有 `onProgress` 参数**，跑多久都不报进度。这是「抓取候选」按钮显得卡死的直接原因。

**第二层（前端）**：21 个调用点里有 7 个在 `subscribeTask` 回调里**只判断 `done`/`error`，把中间的 log 事件整个丢掉**（`DemandPage` 的入池/匹配/提炼 3 个、`UploadTab` 的审片/复盘 2 个、`AssetCard` 的重生成封面、`ScriptTab` 的生成脚本）。即便后端报了进度，这些页面也不显示。剩下 14 个虽然存了 `logs`，但只渲染在页面靠下的日志框里，点按钮的位置看不到，且**没有任何「已用时长」提示**——而"还要等多久"正是用户的核心诉求。

## 目标

1. `scoutCandidates` / `scoutBreakouts` 支持 `onProgress`，在耗时最长的评分主循环里逐条报 `评分 i/N：repo`。
2. 抽出共用的 `useTaskRun` hook + `TaskProgress` 展示组件，让**全站 21 个长任务入口**在按钮旁就地显示「已用时长 · 最新进度」。
3. 顺带修掉现有 `subscribeTask` 调用不在组件卸载时关闭 EventSource 的资源泄漏。

## 非目标

- **不做全局任务中心**（顶栏统一挂所有在跑的任务）。本工具是单人本机使用、任务队列并发为 1，就地反馈已经够用，全局中心属于过度设计。
- **不做进度百分比条 / 剩余时间预估**。评分单条耗时受 LLM 波动影响大，预估值会误导；显示「已用 47s · 评分 7/30」用户自己能推算。
- **不改 `GithubClient` 接口给搜索阶段加 per-topic 进度**。搜索阶段约 10–20s，一条「搜索 GitHub（14 个 topic）…」配上实时秒表已经能消除"卡死"错觉；为它改动 tailor 也在用的共享接口不划算。
- **不改任务队列 / SSE 协议 / 数据模型**。现有 `packages/server/src/tasks.ts` 的事件广播机制完全够用，一行不动。
- **不给 `apps/web` 引入单测框架**。该包 `package.json` 里 `"test": "echo 'web: 人工验收，无单测'"` 是既定约定，前端改动按项目惯例走浏览器人工验收；后端 `packages/scout` 有 vitest，那部分照常 TDD。

## 1. 后端：scout 补 `onProgress`（`packages/scout/src/scout.ts`）

两个函数的 opts 各加一个可选字段，**缺省为 no-op**，所有现有调用方与测试不受影响：

```ts
export async function scoutCandidates(
  ctx: CoreCtx,
  opts: {
    topics?: string[]; limit?: number; pushedAfter?: string; onlyNew?: boolean
    onProgress?: (msg: string) => void          // 新增
  } = {},
): Promise<{ found: number; scored: number; rejected: number; added: number }>
```

函数体开头取一次：`const log = opts.onProgress ?? (() => {})`。

消息序列（`scoutCandidates`）：

| 时机 | 消息 |
|---|---|
| 搜索前 | `搜索 GitHub（14 个 topic）…` |
| 搜索后、评分前 | `搜到 208 个仓库 · 协议可商用 94 个 · 本次评分 30 个` |
| 评分主循环内，每条评分前 | `评分 7/30：javahuang/SurveyKing` |

`scoutBreakouts` 同构：

| 时机 | 消息 |
|---|---|
| 搜索前 | `检测新晋高星仓库（≥2000 star · 7 天内新建）…` |
| 搜索后 | `命中 12 个仓库，开始评分…` |
| 循环内，每条 ingest 前 | `评分 3/12：owner/repo` |

**不发结尾汇总行**：`packages/server/src/app.ts` 的路由已经用 `.then((r) => log('发现 X 个，评分 Y，协议不过 Z'))` 收尾，scout 内部再发一条会重复。路由那行保持原样不动。

分母口径：`scoutCandidates` 用 `toScore.size`（真正会走 LLM 评分的条数），不是 `found.length`——后者含大量只刷元数据/协议不过的条目，用它当分母会让进度条看起来卡在前几个百分点。

## 2. 后端：路由透传（`packages/server/src/app.ts`）

第 448、457 行两处 `queue.enqueue` 补 `onProgress: log`，与其余 20 处路由写法一致：

```ts
const taskId = queue.enqueue((log) => scoutCandidates(ctx, {
  topics: ..., limit: ..., onProgress: log,        // 新增这一项
}).then((r) => { log(`发现 ${r.found} 个，评分 ${r.scored}，协议不过 ${r.rejected}`); return r }))
```

## 3. 前端：`useTaskRun` hook（新文件 `apps/web/src/useTaskRun.ts`）

统一封装「发起任务 → 订阅 SSE → 累计日志 → 计时 → 收尾」，替换 21 处各写一遍的样板代码。

```ts
export interface TaskRun {
  /** 任务是否在跑 */
  running: boolean
  /** 最新一条进度消息（''=还没有）。任务结束后保留最后一条，直到下次 run() */
  lastMessage: string
  /** 已用秒数：running 期间每秒自增；结束后冻结为总耗时 */
  elapsedSec: number
  /** 完整日志。需要日志框的页面（ScoutPage/WorkshopPage/TailorDrawer 等）继续用它 */
  logs: string[]
  /** 最近一次是否以 error 收尾 */
  failed: boolean
  /** 启动任务。start() 负责发 POST 并返回 taskId。
   *  done/error 时自动置 running=false，并回调 onSettled(ok, lastEvent)。
   *  start() 自身抛错（网络/4xx）也会被捕获成 failed，onSettled(false, null)。 */
  run: (start: () => Promise<string>, onSettled?: (ok: boolean, e: TaskEvent | null) => void) => Promise<void>
}

export function useTaskRun(): TaskRun
```

要点：

- **可多实例**：一个组件里有几个独立任务就调几次（`const analyze = useTaskRun()`、`const rebrand = useTaskRun()`）。`ProjectDrawer` 有 4 个、`ScoutPage` 有 5 个、`UploadTab` 卡片有 2 个。
- **计时**：`running` 变 true 时记起始时间戳并起 `setInterval(1000)`；结束/卸载时 `clearInterval`。结束后 `elapsedSec` 停在总耗时不再变。
- **卸载清理**：保存 `subscribeTask` 返回的 close 函数，`useEffect` 的 cleanup 里调用。这修掉现有代码「抽屉关掉后 EventSource 仍连着」的泄漏。
- **`run()` 期间再次调用直接忽略**（等价于现有各处的 `if (running) return` 守卫），调用点不必再自己写。
- **不接管 `alert()` 和 `invalidateQueries()`**：这些各页语义不同，留在 `onSettled` 回调里由调用点自己做，改动范围最小。

## 4. 前端：`TaskProgress` 组件（新文件 `apps/web/src/components/TaskProgress.tsx`）

```tsx
export default function TaskProgress({ run, className }: { run: TaskRun; className?: string })
```

- `!running && !lastMessage` 时渲染 `null`（页面初始状态干净）。
- 运行中：一个脉冲圆点 + `已用 47s · 评分 7/30`。
- 结束后：保留 `用时 3m12s · 完成`（失败则 `text-danger` 显示错误消息），直到下次点按钮。
- 时长格式：`< 60s` → `47s`；`≥ 60s` → `3m12s`。
- 视觉走子项目①的 token 系统：等宽小字（同 `.eyebrow` 风格）、`text-faint`/`text-sub`，失败态 `text-danger`。不引入新 CSS 变量。

放置位置：紧跟在触发按钮之后的同一行，用户点完按钮视线不用移动。

## 5. 前端：21 个调用点改造清单

| 文件 | 任务数 | 现状 |
|---|---|---|
| `pages/ScoutPage.tsx` | 5 | 存 logs，有日志框，无时长 |
| `drawers/ProjectDrawer.tsx` | 4 | 4 个都存 logs（analyze/rebrand/runExec/generateScreens），各有独立日志框 |
| `pages/DemandPage.tsx` | 3 | **全部丢弃 log 事件**（入池/匹配/提炼） |
| `pages/WorkshopPage.tsx` | 2 | 存 logs，有日志框 |
| `pages/workshop/UploadTab.tsx` | 2 | **全部丢弃 log 事件**（审片/复盘） |
| `drawers/TailorDrawer.tsx` | 1 | 存 logs（3 按钮共享一个 running 联合类型） |
| `pages/workshop/TemplatesTab.tsx` | 1 | 存 logs |
| `pages/workshop/ScriptTab.tsx` | 1 | **丢弃 log 事件** |
| `pages/TopicsPage.tsx` | 1 | 存字符串日志（`extractLog` 是 string 不是 string[]） |
| `components/AssetCard.tsx` | 1 | **丢弃 log 事件** |

合计 21 个，其中 7 个当前完全丢弃进度消息。

改造统一手法：删掉本地的 `running`/`logs` state 与手写的 `subscribeTask` 块，换成 `useTaskRun()`，按钮 disabled 与文案改读 `run.running`，按钮后插 `<TaskProgress run={run} />`；原有日志框改读 `run.logs`。

特殊情况 `TailorDrawer`：现在是 `running: 'decompose' | 'search' | 'proposal' | null` 一个 state 管三个按钮。改成三个 `useTaskRun()`，「任一在跑则其余禁用」由 `const busy = decompose.running || search.running || proposal.running` 派生。

## 测试与验收

- **后端**（`packages/scout/test/scout.test.ts`，vitest）：TDD 补两组用例——① 传入 `onProgress` 时收到的消息序列符合预期（含 `评分 i/N` 的分母是 `toScore.size`）；② 不传 `onProgress` 时不抛错且返回值与改动前一致（向后兼容）。
- **前端**：按 `apps/web` 既定约定人工验收——浏览器实点「抓取候选」，确认按钮旁秒表实时走动、评分进度逐条刷新；再抽查 `DemandPage`、`UploadTab`、`TailorDrawer` 各一个按钮确认反馈正常、任务结束后状态正确复位。
- **回归**：`pnpm test` 全绿（注意需 Node ≥22，本机 nvm 默认是 20，会因 better-sqlite3 ABI 不匹配假失败）。
