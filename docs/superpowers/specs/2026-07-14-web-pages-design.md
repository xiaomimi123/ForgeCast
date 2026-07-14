# Web 前端补全（项目看板 + 发布日历 + 数据复盘）设计

> 把三个仅差 UI 的页面一次补齐：M1 项目看板页、M6 发布日历页、M6 数据复盘页。
> 全部**纯前端**（apps/web），消费**已有** REST 端点，**不改 server**。
> 现有 Web：脚手架/API 层/路由（Task 13）、素材工坊页、项目详情页。

## 目标

给已做完引擎的 M1（候选池）与 M6（发布/复盘）配上 Web 操作界面：候选池排名+一键立项、今日排期建议+回填发布、周报+leads+数据录入。三页挂进现有布局与导航。

## 范围

**做**：`api.ts` 增 `Candidate`/`CalendarView`/`WeeklyReport`/`Lead` 类型；`App.tsx` 增 3 条路由 + 顶部导航；`BoardPage`（看板）、`CalendarPage`（发布日历）、`ReviewPage`（数据复盘）三个页面；门禁 = tsc + build，里程碑末浏览器走查。

**不做**：任何 server/引擎改动（端点已全部就绪）；四维雷达图（用简单分数条代替，雷达属后续 polish）；stage 泳道拖拽（看板先做候选排名表 + 立项）；leads 跟进工作流（只列表+登记）；图表库（周报用表格/简单条，不引入 chart 依赖）。

## 复用的现有 API（均已实现，见 packages/server/src/app.ts）

- 候选：`GET /api/candidates`、`POST /api/scout`(入队+SSE)、`POST /api/candidates/pick {repo}`
- 排期/发布：`GET /api/calendar`、`POST /api/assets/:id/publish {platform,url?}`
- 复盘：`GET /api/report[?since=]`、`GET /api/leads`、`POST /api/assets/:id/perf {views,likes,leads}`、`POST /api/leads {assetId,wechat,intent}`
- SSE：`subscribeTask`（api.ts 已有）

## 页面设计

### 导航与路由（App.tsx）
顶部导航加：素材工坊(现有) / 项目看板(/board) / 发布日历(/calendar) / 数据复盘(/review)。路由加 3 条。

### BoardPage（/board）
- 顶部「抓取候选」按钮 → `POST /api/scout` → `subscribeTask` 显示进度 → done 后 invalidate `['candidates']`。
- `GET /api/candidates` → 排名表：名次 / repo(链接 url) / stars / license / score / 三维分（rebrandCost/buyerClarity/visualAppeal，从 score_detail 解析，小条或数字）/ 一句话 rationale / 状态。
- 每行（license_ok=1 且 status=candidate）一个「立项」按钮 → `POST /api/candidates/pick {repo}` → 成功后 invalidate `['candidates']`（该候选 status 变 picked）；失败 alert。
- license_ok=0 的行灰显、标「协议不可商用」，无立项按钮。

### CalendarPage（/calendar）
- `GET /api/calendar`（CalendarView）→ 顶部：日期、今日已发 N / 还可发 M；库存（各钩子条数）；冷却中（钩子→剩余天数）。
- 建议区：`suggestions` 每条 `{hook, assetId, reason}` 一行，配一个平台下拉（xhs/douyin）+「标记已发布」按钮 → `POST /api/assets/${assetId}/publish {platform}` → 成功 invalidate `['calendar']`。
- 无建议时提示「今日额度用尽或无可发库存」。

### ReviewPage（/review）
- `GET /api/report`（WeeklyReport）→ 各钩子表：钩子 / 发布数 / 询单数；合计。
- `GET /api/leads`（Lead[]）→ leads 列表：来源(hook·slug) / 微信 / 意向 / 状态 / 时间。
- 两个小表单：
  - 录数据：assetId + views + likes + leads → `POST /api/assets/${id}/perf` → invalidate `['report']`。
  - 登记询单：assetId + wechat + intent → `POST /api/leads` → invalidate `['leads','report']`。

## 类型（api.ts 追加）

```ts
interface Candidate { id:number; repo:string; url:string; license:string|null; license_ok:number; stars:number; tech_stack:string|null; score:number|null; score_detail:string|null; status:string }
interface CalendarView { date:string; publishedToday:number; remainingToday:number; inventory:Record<string,number>; cooldown:Record<string,number>; mix:{demo:number;income:number;targetDemo:number;targetIncome:number}; suggestions:Array<{hook:string;assetId:number;reason:string}> }
interface WeeklyReport { since:string; perHook:Record<string,{published:number;leads:number}>; totals:{published:number;leads:number} }
interface Lead { id:number; asset_id:number; wechat:string|null; intent:string|null; status:string; created_at:string; hook:string|null; slug:string|null }
```

## 测试策略

Web 无单测（沿用约定）；每页任务门禁 = `pnpm --filter web exec tsc --noEmit` + `pnpm --filter web build`。里程碑末浏览器走查：起栈 → 看板抓取+立项、日历看建议+标记已发布、复盘录数据+登记询单，确认交互与刷新。

## 全局约束（沿用）

- 复用现有 `api`/`subscribeTask`（Task 13）、TanStack Query、Tailwind、react-router。
- 无分页（单人数据量，全量拉取 + 前端过滤）。
- 中文文案；commit trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`。

## 未决/后续

- 四维雷达图、stage 泳道拖拽、leads 跟进状态流转、周报图表、发布日历周视图——后续 polish。
- 顶部"当前进度"文案更新随实现同步。
