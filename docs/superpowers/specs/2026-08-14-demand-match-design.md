# 需求×项目匹配设计（产品重心调整第二步 C）

## 背景

产品重心调整三部曲（见 `2026-08-14-demand-signals-design.md`）的第二步。B 需求信号库已落地：`demand_signals` 表有真实信号，`status='starred'` 是本功能的天然输入，`'matched'` 状态位当时已预留。

C 的目标：对一条需求信号，**上 GitHub 现搜**能承接它的开源项目，规则评分排序后由 LLM 给每个「信号×项目」组合生成**轻资产商业模式建议**（开店卖货 / 私人定制），看中的一键入候选池走现有立项流程。

用户已确认的取舍：匹配来源=GitHub 现搜新项目（不做池内匹配）；输出深度=每个匹配一段轻建议（不做完整方案书）；触发粒度=单条信号点按钮（不做批量，GitHub 未登录搜索限流 10 次/分钟）。

## 数据流（matchSignal）

```
信号(任意 status) → LLM#1 生成 3-5 个搜索关键词（mock: 启发式切词，不调 ctx.llm）
  → gh.searchByKeywords(keywords, {perPage: 8})（复用 @forgecast/scout，live 抛错由调用方转任务失败）
  → 协议过滤不做硬拒（沿用 tailor 立场：非白名单协议只扣分不淘汰，license 分 0-15）
  → wheelScore 四维规则评分排序（复用 @forgecast/tailor 纯函数：活跃30+热度25+协议15+命中30）
  → 取 top 5
  → LLM#2 对 top 批量生成 {bizMode: 'shop'|'custom'|'both', bizPlan: 交付思路+为什么这个需求配这个项目}
     （mock: fixture 固定建议；真实感红线：bizPlan 不编造任何数字）
  → 事务写 demand_matches（同 signal 重复匹配删旧插新，同 tailor searchWheels 模式）
  → 信号 status → 'matched'
```

搜索 0 结果时：不写表、不改 status，进度输出提示"没搜到合适项目，换个信号或稍后再试"。

## 数据模型

新表 `demand_matches`（packages/core/src/db.ts）：

| 字段 | 类型 | 说明 |
|---|---|---|
| id | INTEGER PK | |
| signal_id | INTEGER REFERENCES demand_signals(id) | |
| repo | TEXT NOT NULL | owner/name |
| url | TEXT NOT NULL | |
| description | TEXT | |
| license | TEXT | |
| license_ok | INTEGER | isLicenseOk 结果 |
| stars | INTEGER | |
| last_commit | TEXT | |
| score | REAL | wheelScore 总分 |
| score_detail | TEXT (JSON) | WheelScoreDetail |
| biz_mode | TEXT | shop / custom / both |
| biz_plan | TEXT | 交付思路+匹配理由（定性，无编造数字） |
| created_at | TEXT DEFAULT datetime('now') | |

## 模块结构

`packages/demand/src/match.ts`（不新建包）：
- `matchSignal(ctx, signalId, opts?: { onProgress?, gh? }): Promise<{ matched: number }>`——主流程；`gh` 可注入（测试用假 client，同 tailor searchWheels 的 opts.gh 模式）
- `listMatches(ctx, signalId): DemandMatch[]`
- `src/fixtures/match-fixture.ts`：mock 关键词切词 + mock 商业模式建议（绝不调 ctx.llm）
- 新增 workspace 依赖：`@forgecast/scout`（createGithubClient/isLicenseOk）、`@forgecast/tailor`（wheelScore）——依赖方向 demand→scout/tailor，无循环

提示词模板（两次 LLM 调用各一个文件）：
- `templates/prompts/demand-match-keywords.md`：输入信号 title/summary/opportunity → 输出 JSON `{"keywords": ["...", ...]}`（3-5 个英文优先的 GitHub 搜索词）
- `templates/prompts/demand-match-plan.md`：输入信号 + top repo 列表 → 输出 JSON 数组 `[{repo, bizMode, bizPlan}]`；含真实感红线（bizPlan 不编造市场规模/销量/收入数字，只写模式与交付思路）

## API / CLI / Web

server（`packages/server/src/app.ts`，demand 路由块内追加）：
- `POST /api/demand/signals/:id/match` → 任务队列 `{taskId}`（SSE 进度）
- `GET /api/demand/signals/:id/matches` → 匹配结果列表

CLI（`cli.ts` demand case 内追加子命令）：
- `forgecast demand match <id>`
- `forgecast demand matches <id>`

Web（`apps/web/src/pages/DemandPage.tsx`）：
- 每张信号卡片加「找项目」按钮（busy 态 + subscribeTask SSE，完成 invalidate）
- 卡片有匹配结果时内嵌展开区：每条匹配显示 repo（GitHub 链接）/ star / 协议 / 总分 / 模式徽章（开店卖货·私人定制·皆可）/ bizPlan 文本 + 「入候选池」按钮（调已有 `POST /api/candidates/add`，body `{url}`，入池后可去项目池立项）
- `matched` 状态显示「已匹配」徽章（沿用 dismissed/starred 的徽章样式语言）

## 不做的事

- 不做池内（candidates 表）匹配——用户确认只上 GitHub 现搜。
- 不做批量匹配所有 starred——限流不友好，逐条触发。
- 不生成完整机会方案书文档——轻建议存表即可；深入分析走「入候选池→立项→analyze」现有流程。
- 不改 analyze 的 prompt 来引用需求信号（留给后续 D，如果需要）。
- 不动 packages/scout / packages/tailor 的任何代码（只 import 纯函数/client 工厂）。
- 系统代码零抓取逻辑不变——GitHub 搜索走官方 API（scout 既有能力），不算爬虫。

## 验证

1. `pnpm test` 全仓 + 新增单测（matchSignal mock 全流程、0 结果不写表、重复匹配删旧插新、status 翻转、LLM#2 输出校验失败整批抛错不写脏数据、路由、CLI 冒烟）。
2. 端到端（live）：对一条真实 starred 信号点「找项目」→ 搜到真实 GitHub 项目、评分排序合理、商业模式建议无编造数字 → 点「入候选池」→ 项目池 tab 出现该候选。
3. 测试造的假数据清理；真实匹配结果保留（产品数据）。
