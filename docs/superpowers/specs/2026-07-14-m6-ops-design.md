# M6（引擎）— 素材库与发布辅助（ops）设计

> M6 分两口：本 spec 只覆盖**引擎（CLI+API）**：发布回填 + 数据回填 + leads 询单 + 排期规则 + 周报。
> 两个 Web 页（发布日历页 / 数据复盘页）作为紧接的下一口，单独 spec。
> 开发文档 §7；**明确不做自动发布**——发布是人工，ops 只回填元数据与做统计。

## 目标

补齐素材生成之后的运营闭环：人工发布后回填平台/链接、录入曝光/赞/询单数据、登记 leads（打通"哪条内容带来哪个客户"归因）、按规则提示今天该发什么、出各钩子转化周报反哺 M4。

沿用现有原则：引擎/界面分离；产物落 DB；确定性可测（无 LLM/网络）；中文文档注释。

## 范围

**做**：新包 `@forgecast/ops`（`publishAsset`/`recordPerf`/`addLead`/`listLeads`/`calendarSuggestions`/`weeklyReport`）；core `db.ts` 加 leads 表 + assets `published_url` 列（幂等迁移）；server 6 个端点；CLI 5 个命令；vitest 确定性覆盖。

**不做（本口）**：Web 发布日历页与数据复盘页（下一口）；自动发布（永不做）；配比里 20% 开发过程碎片的追踪（那类内容不由本系统生成）；leads 的复杂 CRM 流转（只 new/contacted/deal/lost 状态字段，不做工作流）；图表（属 Web 页）。

## 架构

新包 `packages/ops`（`@forgecast/ops`，运营辅助层），依赖 `@forgecast/core`。纯数据层，无 LLM/渲染/网络。

对外核心函数：
```ts
publishAsset(ctx, assetId, opts: { platform: string; url?: string }): void
  // status='published' + published_at=now + platform + published_url

recordPerf(ctx, assetId, perf: { views?: number; likes?: number; leads?: number }): void
  // 写 assets.perf = JSON.stringify({views,likes,leads,recordedAt})

addLead(ctx, input: { assetId: number; wechat?: string; intent?: string }): { id: number }
listLeads(ctx): Lead[]   // 带来源素材信息（hook/slug）

calendarSuggestions(ctx, now?: Date): CalendarView   // 排期建议（now 可注入）
weeklyReport(ctx, since?: string): WeeklyReport       // since ISO 日期，默认 7 天前
```

### 数据流

```
素材 draft →(人工审, 现有 PATCH) approved →(人工发完) publishAsset 回填 → published
                                              │
                    recordPerf(曝光/赞/询单)  addLead(询单登记, 归因到 asset)
                                              │
   calendarSuggestions: 库存 + 已发历史 → 今天发什么(配比 §5.2 / ≤2条/天 / 同钩子≥3天)
   weeklyReport: 各钩子 发布数×询单数 → 反哺 M4 模板迭代
```

**边界纪律**：ops 只读写 DB（assets/leads），不碰 LLM/渲染/GitHub。

## 数据模型（core `db.ts`）

- **新增 leads 表**（`CREATE TABLE IF NOT EXISTS`，对已有库安全）：
  ```sql
  CREATE TABLE IF NOT EXISTS leads (
    id INTEGER PRIMARY KEY,
    asset_id INTEGER REFERENCES assets(id),
    wechat TEXT, intent TEXT,
    status TEXT DEFAULT 'new',        -- new/contacted/deal/lost
    created_at TEXT DEFAULT (datetime('now'))
  );
  ```
- **assets 加 `published_url` 列**：`CREATE TABLE IF NOT EXISTS` 不会给已有表补列，故引入幂等迁移助手 `ensureColumn(db, table, column, decl)`（读 `PRAGMA table_info(table)`，缺列则 `ALTER TABLE table ADD COLUMN column decl`），在 openDb 建表后调用 `ensureColumn(db,'assets','published_url','TEXT')`。这是 P1 后第一次加列，立一个可复用的迁移小模式。
  - `published_at` / `platform` / `perf` 列 P1 已有，直接用。

## 排期规则 `calendarSuggestions(ctx, now = new Date())`

- 钩子归类：`pain`/`infogap` → `demo`（目标 60%），`story`/`sideline` → `income`（目标 20%）。（§5.2 的 20% 开发过程碎片不由本系统生成，不计入。）
- `publishedToday` = published_at 在 now 当天的已发素材数；`remainingToday = max(0, 2 - publishedToday)`（≤2 条/天）。
- 每钩子：`inventory` = status='approved' 且未发布的素材数；`lastPublished` = 该钩子最近 published_at；`onCooldown` = `lastPublished` 距 now < 3 天。
- `mix` = 近 7 天已发按类别计数（demo/income）与目标占比对照。
- `suggestions`：eligible = `inventory>0 && !onCooldown`；排序 = 欠缺类别优先（mix 里离目标占比更远的类别先）→ 再按 `lastPublished` 最久（never→最优先）；取前 `remainingToday` 条，每条 `{ hook, assetId, reason }`（reason 一句中文，如「痛点型库存3条、上次发布7天前、demo 类配比偏低」）。
- 输出：`interface CalendarView { date: string; publishedToday: number; remainingToday: number; inventory: Record<string, number>; cooldown: Record<string, number>; mix: {...}; suggestions: Array<{ hook: string; assetId: number; reason: string }> }`。
- 纯函数、确定性（除 now 外无副作用；now 可注入）。

## 周报 `weeklyReport(ctx, since = <7天前 ISO>)`

- 每钩子：`published` = published_at ≥ since 的已发数；`leads` = join leads→assets，该钩子且 leads.created_at ≥ since 的询单数。
- 输出：`interface WeeklyReport { since: string; perHook: Record<string, { published: number; leads: number }>; totals: { published: number; leads: number } }`。
- 用途：各钩子转化，指导 M4 模板迭代。

## 入口

### CLI（`cli.ts` 增加分支）
```bash
forgecast publish <assetId> --platform=<xhs|douyin> [--url=<link>]   # 回填发布
forgecast perf <assetId> --views=N --likes=N --leads=N              # 回填数据
forgecast lead <assetId> --wechat=<..> [--intent=<..>]             # 登记询单
forgecast calendar                                                  # 今日排期建议 + 库存
forgecast report [--since=YYYY-MM-DD]                                # 各钩子周报
```
default help 把这些从「未实现」行移到已实现列表。

### REST（`packages/server/src/app.ts` 增加路由）
| 方法 路径 | body / 说明 | 返回 |
|---|---|---|
| `POST /api/assets/:id/publish` | `{platform, url?}`；素材不存在 404 | `{ok:true}` |
| `POST /api/assets/:id/perf` | `{views?,likes?,leads?}`；素材不存在 404 | `{ok:true}` |
| `POST /api/leads` | `{assetId, wechat?, intent?}`；assetId 缺或素材不存在 400/404 | `{id}` |
| `GET /api/leads` | 全部 leads（带来源素材 hook/slug） | `Lead[]` |
| `GET /api/calendar` | 今日排期建议 | `CalendarView` |
| `GET /api/report` | `?since=YYYY-MM-DD` 可选 | `WeeklyReport` |

（发布回填用独立 `POST .../publish` 端点，与现有 `PATCH /api/assets/:id`（只改 status）分工：publish 端点同时置 status=published 并回填 published_at/platform/url。）

## 测试策略（TDD，确定性、无 LLM）

`packages/core/test/db.test.ts`：追加——openDb 后 `leads` 表存在、assets 有 `published_url` 列；对同一 db 重复 openDb 不报错（幂等迁移）。

`packages/ops/test/`：
- **publishAsset**：seed 一条 asset → publish → status='published'、published_at 非空、platform、published_url 正确。
- **recordPerf**：perf 列写入含 views/likes/leads 的 JSON。
- **addLead/listLeads**：插入 lead → listLeads 返回该条且带来源 asset 的 hook。
- **calendarSuggestions**：注入固定 now + seed 各状态素材（approved 未发若干钩子、published 于不同日期）→ 断言 `remainingToday`（今日已发算对）、`inventory`、`cooldown`（3 天内发过的钩子被标 cooldown）、`suggestions`（eligible 排序取 remainingToday 条）。
- **weeklyReport**：seed 若干 published 素材 + leads（不同 hook/日期）→ 断言 `perHook` 各钩子的 published/leads 计数与 `totals`。

`packages/server/test/`：6 个端点各走一遍（publish→GET /api/projects/:slug/assets 或 GET asset 显示 published；perf；leads POST+GET；calendar；report），确定性、无 LLM。

## 全局约束（沿用）

- Node 20 / pnpm 9；`@forgecast/ops` 的 `main` 直指 `src/index.ts`，无 build 步骤。
- 包名 `@forgecast/ops`，依赖 `@forgecast/core`，自身 `devDependencies` 声明 `@types/better-sqlite3`（对齐其他包）。
- 服务只绑 127.0.0.1；文档注释中文；TDD；commit conventional，结尾 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`。

## 未决/后续

- Web 发布日历页（周视图/排期建议/拖拽/当天待发清单）+ 数据复盘页（录入表单/钩子转化图表/leads 列表）——下一口。
- 20% 开发过程碎片的库存追踪、leads 的跟进工作流、评分权重按周报实测校准（P2）——后续。
- README 增补 publish/perf/lead/calendar/report CLI（本口实现时同步，遵循全局文档规则）。
