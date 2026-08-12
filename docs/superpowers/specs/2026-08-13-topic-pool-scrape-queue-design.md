# 选题库抓取请求排队

> 日期：2026-08-13　状态：设计已确认，待写实施计划

## 背景

选题库（`docs/superpowers/specs/2026-08-13-topic-pool-design.md`）已上线，但"抓取哪个账号"这件事目前完全靠对话——用户要记住/口述想抓的账号，来这边喊一声，才能触发实际抓取。这轮补一个轻量排队机制：前端加「请求抓取」按钮，把"我想让这个账号被抓一次"这个意图记录下来，用户可以随时批量点，之后找个时间统一跟 Claude 说"处理一下待抓取的"，Claude 用 CLI 一眼看到完整待处理清单，不用用户口述。

**明确不做**：不做真正的自动抓取（评估过 embedded AI agent 和自建 Playwright 爬虫两条路，都因为登录态持久化/外部反检测浏览器依赖/无节流机制等代价太高被放弃，详见对话记录）。抓取本身永远是"用户在对话里喊 Claude，Claude 用浏览器工具手动跑一次"，这条不变。本轮只解决"待抓取账号怎么标记、怎么让 Claude 一眼看到"这个小问题。

## 功能设计

### 数据模型（`topic_sources` 表加两列）

- `scrape_requested_at TEXT`：点「请求抓取」按钮时打上 `datetime('now')`；NULL 表示无待处理请求。
- `last_scraped_at TEXT`：每次 `importNotes` 成功为该账号导入笔记（不论新增/更新，只要调用发生）时更新为当前时间，同时把 `scrape_requested_at` 清回 NULL——语义是"这次导入就是对之前那个请求的响应"。

### 后端（`packages/topics`）

- `requestScrape(ctx: CoreCtx, id: number): void`——账号不存在抛错；存在则把 `scrape_requested_at` 设为当前时间（幂等：重复点击只是刷新时间戳，不报错）。
- `importNotes` 现有实现里，成功执行到函数末尾（不论 `notes` 数组是否为空——只要账号存在、函数没抛错）时，追加一步：把该账号的 `scrape_requested_at` 置 NULL、`last_scraped_at` 置当前时间。
- `listSources` 不用改（`SELECT *` 已经会带出新列）。

### CLI（`cli.ts`）

- 新增 `forgecast topics list-sources`：表格打印所有目标账号，含平台/账号/粉丝数/状态列（状态列：有 `scrape_requested_at` 显示"待抓取（请求于 <时间>）"，否则显示 `last_scraped_at` 存在则"上次抓取：<时间>"，都没有则"从未抓取"）。这是目前缺失的一个基础查看命令（Task 4 只做了 add-source，没做 list）。

### server 路由

- `POST /api/topics/sources/:id/request-scrape` → 调 `requestScrape`，返回 `{ ok: true }`；账号不存在返 404。

### 前端

- 目标账号清单每行加「请求抓取」按钮（点击后调新路由，成功后 `invalidateQueries(['topics','sources'])` 刷新列表）。
- 状态列展示同 CLI 语义：待抓取（带请求时间）/ 上次抓取时间 / 从未抓取。

## 不做的事

- 不做真正的自动/半自动抓取触发——按钮只留标记，不发起任何浏览器自动化。
- 不做"编辑账号粉丝数/备注"的前端 UI（`PUT /api/topics/sources/:id` 路由已存在但仍然只能靠 API 直接调，这是选题库主功能上线时就留下的已知缺口，本轮不顺带补）。
- 不做批量"全部标记待抓取"之类的便捷操作，一次只请求一个账号。

## 验证

- `packages/topics/test/sources.test.ts` 补：`requestScrape` 设置时间戳、账号不存在抛错、重复调用幂等。
- `packages/topics/test/notes.test.ts` 补：`importNotes` 成功后清空 `scrape_requested_at`、更新 `last_scraped_at`。
- `packages/server/test/topics.test.ts` 补：新路由 200/404。
- 前端 `tsc --noEmit` + `vite build`。
- 浏览器走查：点「请求抓取」→ 状态列变"待抓取"；CLI `topics list-sources` 能看到同样的待处理状态；CLI `topics import-notes` 导入后状态列变回"上次抓取：..."。
