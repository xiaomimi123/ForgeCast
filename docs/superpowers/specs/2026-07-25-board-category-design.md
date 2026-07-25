# 看板领域分类 / 筛选 设计（看板改进 C）

> 日期：2026-07-25　状态：设计已确认，待写实施计划
>
> 看板改进三件套之 C（A 全部重新评分已做，B 详细介绍+说明书后做）。

## 目标

207 个候选找不到匹配客户需求的产品。给每个候选打**领域标签**（客服/CRM/电商…），看板加类别 chip 筛选 + 卡片徽章。领域标签评分时 LLM 给（准），启发式兜底，并一键回填现有候选（免等重新评分）。

## 固定类别表（闭集）

`CATEGORIES`（顺序即启发式匹配优先级，先具体后宽泛）：
```
客服/IM · CRM/销售 · 电商/商城 · 仪表盘/BI · 表单/问卷 ·
文档/知识库 · 建站/CMS · 项目/协作 · 财务/发票 · 预约/排期 · AI助手/Agent · 其它
```
（AI助手放靠后：领域特定的 AI 工具先归其领域，纯 AI 助手/Agent 才落 AI 类；无命中落「其它」。）

## category 的产生（三路，保证所有候选都有）

### scout `packages/scout/src/types.ts` + `score.ts`
- `ScoreDetail` 加 `category: string`。
- 新增 `CATEGORIES: readonly string[]`（上表，导出）。
- 新增 `categorizeHeuristic(repo: string, text: string, techStack: string[]): string`——纯关键词映射：把 `repo + text(README/description) + techStack` 拼一起小写，按 `CATEGORIES` 顺序逐类匹配关键词，**首个命中的类**返回；都不中 → `其它`。关键词表（每类，示例，实现时按此写全）：
  - 客服/IM：chat, chatbot, chatwoot, helpdesk, support, 客服, im, messaging
  - CRM/销售：crm, sales, lead, pipeline, 销售, 客户管理
  - 电商/商城：ecommerce, commerce, shop, store, cart, pos, saleor, 电商, 商城
  - 仪表盘/BI：dashboard, admin, analytics, bi, metabase, report, 仪表盘, 报表
  - 表单/问卷：form, survey, questionnaire, poll, 表单, 问卷
  - 文档/知识库：docs, wiki, knowledge, note, notion, markdown, 文档, 知识库
  - 建站/CMS：cms, website, landing, blog, wordpress, strapi, 建站
  - 项目/协作：project, task, kanban, todo, collaboration, 项目管理, 看板
  - 财务/发票：invoice, accounting, finance, billing, payment, expense, 财务, 发票
  - 预约/排期：booking, appointment, schedul, calendar, reservation, 预约, 排期
  - AI助手/Agent：ai, llm, agent, rag, gpt, assistant, langchain, 智能, 大模型
- `heuristicScore` 返回值加 `category: categorizeHeuristic(meta.repo, readme, techStack)`。
- LLM 评分：prompt 的输出 JSON 加 `"category":"从[类别表]选一个最贴切的"`，并在 prompt 里列出 `CATEGORIES`。`parseScoreJson` 读 `o.category`（字符串，缺则空串）；**`scoreCandidate` 在拿到 detail 后收尾校验**：`detail.category = CATEGORIES.includes(detail.category) ? detail.category : categorizeHeuristic(meta.repo, readme, detail.techStack)`（LLM 给的不在表内 → 启发式兜底）。

### 回填现有候选：scout `backfillCategories(ctx): number`
遍历所有候选，解析 `score_detail`：若 `category` 为空/缺/不在 `CATEGORIES` → 用 `categorizeHeuristic(repo, description, techStack from score_detail)` 算出类别、写回 `score_detail.category`（保留其余字段）、`UPDATE candidates SET score_detail=?`。返回更新条数。`score_detail` 为 NULL/坏 JSON 的候选：构造一个最小 detail `{category, ...空}` 或跳过——**跳过**（无 score_detail 的是未评/协议不过的，回填领域意义不大；只回填有 score_detail 的）。

### server `packages/server/src/app.ts`
`POST /api/candidates/backfill-categories` → `const n = backfillCategories(ctx); return c.json({ updated: n })`（同步、快、无 LLM，不用排队任务）。

## 前端

### `apps/web/src/pages/board/CandidateCard.tsx`
- `Detail` 类型加 `category`；`parseDetail` 解析 `str(o.category)`。
- 卡片标题行加类别徽章（`d?.category` 非空且非「其它」时显示一个小 badge，如 `[客服/IM]`）。

### `apps/web/src/pages/BoardPage.tsx`
- 从 `candidates.data` 的 `score_detail.category` 聚合类别 → 计数：`Map<category, count>`（只统计可商用 `license_ok===1` 的）。
- 类别筛选条：`全部(N)` + 各**有候选**的类别 chip（带计数），**单选**。状态 `const [cat, setCat] = useState<string | null>(null)`（null=全部）。
- 过滤：`ok` 列表再按 `cat` 过滤（`cat===null` 或 候选 category===cat）后渲染。计数用未过滤的 ok 全量算。
- 「分类回填」按钮（「抓取候选」「全部重新评分」旁）：`POST /api/candidates/backfill-categories` → 成功 alert(`已回填 N 个`) + `qc.invalidateQueries(['candidates'])`。
- 协议不可商用批（blocked）不参与分类筛选（仍折叠底部，同现在）。

## Fail-soft / 边界
- `score_detail` 坏 JSON / NULL → 回填跳过；前端聚合/parseDetail 里 try/catch 归「无类别」（不进 chip 计数、卡片不显徽章）。
- LLM 给的 category 不在表内 → 启发式兜底（不出现表外标签）。
- 选中某类后该类候选被回填/重评改了类 → 刷新后按新类归位（可接受）。

## 测试
| 层 | 用例 |
|---|---|
| `categorizeHeuristic`（scout，纯） | chatbot→客服、invoice→财务、dashboard→仪表盘、纯 ai→AI助手、无命中→其它；领域优先于 AI（"ai crm"→CRM） |
| `backfillCategories`（scout） | 缺 category 的候选写入启发式类；已有合法 category 的不动；坏JSON/NULL 跳过；返回更新数 |
| `scoreCandidate` category | mock 走 heuristic 出 category；（live 的 LLM 解析+表外回落靠 parseScoreJson 单测：给含非法 category 的 JSON → scoreCandidate 收尾回落启发式——可加一例 mock ctx.llm 返回定制 JSON）|
| server backfill 路由 | POST → 返 `{updated:n}`，候选 score_detail.category 被写入 |
| 前端 | 手动走查：点「分类回填」→ 类别 chip 出现+计数、点 chip 只看该类、卡片徽章显示 |

## 不做
- 多选筛选、按技术栈/分数段筛、分类统计图（本轮只领域分类单选）。
- 给未评/协议不过的候选（无 score_detail）强行分类。
- B（详细介绍+说明书）。
