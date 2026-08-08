# 找项目板块升级（收藏 / 每日自动抓取 / 每日新增 / 抽屉详情 / 四列卡片）设计

日期：2026-08-09　状态：已与用户逐节确认

## 目标

1. **收藏**：感兴趣的候选可收藏，自动抓取不覆盖收藏状态。
2. **每日自动抓取**：server 内置调度，每天定时用现有评分规则抓取入库排行；只给新 repo 评分，不洗已有评分、不白烧 LLM 额度。
3. **每日新增视图**：按入库日期分组展示每天新发现的候选。
4. **抽屉详情**：点卡片右侧滑入详情抽屉，替换现有弹窗。
5. **四列卡片**：参照用户提供的截图样式重排候选卡片。

不改评分规则本身（协议白名单 gate + 三维评分 rebrandCost 0-30 / buyerClarity 0-40 / visualAppeal 0-30 保持现状）。

## 1. 数据模型与 API

### candidates 表迁移（packages/core/src/db.ts，ensureColumn 幂等）
- `favorite INTEGER DEFAULT 0` — 收藏标记。现有 scout UPSERT 语句不含此列，自动抓取天然不覆盖收藏。

### settings 新 key（白名单 SETTING_KEYS 扩充）
| key | 含义 | 默认 |
|---|---|---|
| `auto_scout` | 每日自动抓取开关 `'on'/'off'` | `'on'` |
| `auto_scout_time` | 每日触发时间 `HH:mm`（本地时区） | `'08:00'` |
| `auto_scout_last_run` | 上次成功运行的本地日期 `YYYY-MM-DD` | 空 |
| `auto_scout_last_result` | 上次运行结果 JSON `{at,found,scored,rejected,added,error?}` | 空 |

### API 新增（packages/server）
- `POST /api/candidates/:id/favorite` body `{favorite: boolean}` → `{ok}`；不存在 404
- `GET /api/scout/auto-status` → `{enabled, time, lastRun, lastResult}`（找项目页顶部展示）
- 设置读写复用现有 `GET/PUT /api/settings`（新 key 进白名单即可）
- `GET /api/candidates` 返回增加 `favorite`、`created_at` 字段（前端做置顶排序与按日分组）

## 2. 每日自动调度（packages/server/src/scheduler.ts 新文件）

- **纯函数判定** `shouldAutoScout(now: Date, cfg: {enabled, time, lastRunDate}): boolean`：今天（本地日期）尚未运行 && 当前时间 ≥ 配置时间 → true。可单测。
- server 启动时立即判定一次（**补跑**：当天错过时间点也会跑），此后 `setInterval` 每 60s 判定。
- 触发时调 `scoutCandidates(ctx, {onlyNew: true})`，运行完写 `auto_scout_last_run` + `auto_scout_last_result`；异常捕获进 `lastResult.error`，不崩 server，次日照常重试。
- 手动「抓取候选」按钮行为不变（全量、会重评 top-N）。

### scout 改动（packages/scout/src/scout.ts）
- `scoutCandidates` 加 `opts.onlyNew?: boolean`：
  - 入库前查库：repo 已存在且已有 `score_detail` → 不评分，且 UPSERT 改用**保留评分**变体（只更新 stars/last_commit/description/license 等元数据，`score/score_detail/tech_stack` 保持旧值）。
  - 新 repo → 照常抓 README 评分入库。
  - 返回值增加 `added`（本次新入库数）。
- 保护动机：①live 真评分（targetBuyer/painPoint）不被 mock 启发式洗掉；②每日运行不重复消耗 LLM 额度。

## 3. 找项目页 UI 改版（apps/web）

### 顶部
- 操作行保留：抓取候选 / 全部重新评分 / 分类回填 + 候选计数；新增一行小字：上次自动抓取时间 + 新增 N 个（来自 auto-status）。
- **Tab：全部 / 已收藏 / 每日新增**。分类 chips 保留，对「全部」「每日新增」生效；协议不可商用折叠区保留在底部（仅「全部」tab 显示）。

### 三个 tab 的排序/分组
- 全部：`favorite=1` 置顶（收藏内部按 score 降序），其余按 score 降序；当天（本地日期）入库的卡片加「NEW」徽章。
- 已收藏：只显示 `favorite=1`，按 score 降序。
- 每日新增：按 `created_at` 的本地日期倒序分组（今天/昨天/M月D日），取最近 14 天；组内按 score 降序。`created_at` 存的是 UTC，前端转本地日期分组。

### 卡片（一排 4 个，参照截图）
- 栅格：`grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4`。
- 卡片结构自上而下：
  1. 头部：owner 小字 + repo 名加粗大字；右上角方形色块图标（按领域分类配底色 + 分类/首字母，无真实 logo 数据）
  2. 一句话简介（description，两行截断）
  3. 指标行：⭐ stars · 总分徽章（如 `86 分`）· license
  4. 真评过则显示：👤 目标买家 / 💢 痛点（各一行截断）
  5. 「N 天前更新」（last_commit 距今）
  6. 底部操作行：**书签收藏按钮 |「详情」大按钮 | GitHub 外链按钮**（与截图布局一致）
- 「立项」「重新评分」从卡片挪进抽屉。
- 收藏按钮：请求成功后 invalidate 候选列表刷新（不做乐观更新），失败 alert。

### 抽屉详情（CandidateDetailModal → CandidateDrawer 改造）
- 点卡片主体或「详情」→ 右侧滑入抽屉：`fixed right-0 top-0 h-full w-[480px]`（小屏全宽）+ 半透明遮罩；点遮罩或 Esc 关闭；简单滑入过渡。
- 内容：现有产品说明书（summary/features/targetUser/painPoint/rebrandIdea + 重新生成按钮，逻辑照搬）+ 评分明细（三维分 + rationale）+ 操作区：**立项**（原按钮逻辑）/ 重新评分 / 收藏切换 / GitHub 链接。
- 立项、重评的 pending 状态与错误提示沿用现有 mutation 逻辑。

## 4. 错误处理与测试

- 调度器：单次运行失败（GitHub 限流、LLM 失败）捕获写入 lastResult.error，页面顶部可见，次日自动重试；判定函数与运行动作分离。
- `shouldAutoScout` 边界单测（未到点/已到点/今天已跑/跨天）；`onlyNew` 保护单测（已评分 repo 元数据更新但 score_detail 不变、新 repo 正常评分、返回 added 数）。
- server 路由测试：favorite 切换与 404、auto-status 返回、settings 新 key 白名单往返。
- Web 无单测惯例：tsc --noEmit + vite build + 浏览器验收（四列布局、三 tab、收藏置顶、NEW 徽章、抽屉开关、立项/重评在抽屉内可用）。

## 范围外（YAGNI）

评分规则调整、收藏分组/备注、抓取 topic 自定义界面、新增候选的推送通知、GitHub logo 抓取。
