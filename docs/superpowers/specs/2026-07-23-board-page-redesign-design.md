# 项目看板改版：候选卡片 + 评分说明 + 痛点/目标群体

> 日期：2026-07-23　状态：设计已确认，待实施

## 问题

现在的 `/board` 候选区是一张窄表格，只有 `repo / stars / 协议 / score / 24/34/20 / 一句话`。挑项目时真正需要判断的信息全都看不到：

- **项目是干什么的**——`candidates` 表没有 `description` 列，`searchRepos` 解析 GitHub 响应时把 `it.description` 丢了；README 只在立项后才落盘到 `workspace/<slug>/source/`。
- **评分为什么是这个分**——三个分项以 `24/34/20` 裸数字呈现，不说维度名、不说满分，看不出短板在哪。
- **行业痛点 / 目标群体**——完全不存在。`buyerClarity` 是分数不是描述；`projects.target_buyer` 立项后仍为空；痛点只存在于 `analysis.md`，而那要立项之后跑 M2 才有。

所以这不是纯前端问题：一半字段需要先在抓取/评分链路里采集。

## 数据来源分工

同一个项目在两个阶段各有一份信息来源，边界明确、不打架：

| 阶段 | 简介 | 目标群体 / 痛点 | 来源 |
|---|---|---|---|
| 候选池 | GitHub description | LLM 读 README 快判 | `scoreCandidate` 一次调用 |
| 已立项 | 同上 | M2 深度分析 | `analysis.md` 解析 |

## 改动

### 1. 项目简介：GitHub `description`

- `RepoMeta` 加 `description: string | null`；`searchRepos` 从 `it.description` 取。
- `candidates` 表加 `description` 列，走既有的 `ensureColumn` 幂等迁移（同 `assets.published_url` 的做法）。
- `candidate-fixtures` 补 `description`。

该字段与 LLM 无关，**mock 模式下也是真数据**。

### 2. 痛点 / 目标群体：并入现有评分调用

`scoreCandidate` 的 live prompt 已经在读 README，输出 JSON 增加两个字段，不新增 API 调用：

```
"targetBuyer": "什么老板会掏钱，一句话（行业+规模）"
"painPoint":   "解决的行业痛点，一句话，注明现状成本"
```

`parseScoreJson` 解析并存入 `score_detail`。

**`heuristicScore`（mock）对这两个字段返回空串**，不编造。关键词匹配拼出来的「痛点」是假数据，比空着更坏；这也是本仓库既有约定——每个 LLM 能力自带 mock，不共用别人的 fixture。

旧的 `score_detail`（没有这两个字段）读出来必须不崩，按缺失处理。

### 3. 单个候选重新评分：`POST /api/candidates/:id/rescore`

复用 `ingest` 的评分分支：重抓 README → 重跑 `scoreCandidate` → upsert 回写。一次一个，不重抓全库。响应带当前 LLM 模式，供前端提示「仍是 mock，不会产生痛点」。id 不存在返回 404。

### 4. 立项后由 M2 覆盖

新增纯函数 `parseAnalysisSummary(md)`：按 `## 目标买家画像` / `## 痛点清单` 标题切段，各取首条。`GET /api/projects` 每项附 `analysis_summary`。

文件不存在、缺段、空文件一律返回空对象而非报错——立项后尚未跑分析是常态。

### 5. 前端：候选池改卡片列表

每张卡的结构：

```
┌────────────────────────────────────────────────┐
│ chatwoot/chatwoot          ★12.3k  MIT ✅       │
│ 开源客服台，多渠道会话聚合                      │
│                                                 │
│ 综合 78  换皮 ███████░░ 24/30                   │
│          买家 ████████░ 34/40                   │
│          可视 ██████░░░ 20/30                   │
│                                                 │
│ 👤 目标群体  做外贸/跨境的中小电商老板          │
│ 💢 行业痛点  客户散在 WhatsApp/邮件/网站多个     │
│              入口，客服漏回消息、无法追责        │
│ 💡 评分说明  UI 完整可演示，垂直场景清晰         │
│                                      [立项]     │
└────────────────────────────────────────────────┘
```

- 色条按各维**自己的满分**归一化（30/40/30），短板一眼可见。
- **协议不通过的候选**折叠到列表底部，收成一句「另有 N 个协议不可商用（AGPL/GPL）」，点开才展开。它们永远不会被立项，不该占首屏。
- 排序维持按 score 降序。不做筛选器与分页。
- **mock 占位**：👤💢 两行显示灰字「mock 模式未生成 — 配好 key 后点重新评分」，「重新评分」按钮就在同一张卡上。

### 6. 前端：泳道卡片

`brand_name` 下面加两行小字（目标买家、痛点首条），取自 `analysis_summary`。没跑过分析的显示「未分析」，链到详情页的「生成分析」。

### 7. 顺手拆文件

`BoardPage.tsx` 现有 140 行，揉了候选表 + 泳道 + 抓取日志三件事，加卡片后会到 250+。拆为 `BoardPage.tsx`（编排）+ `CandidateCard.tsx` + `StageLanes.tsx`。只挪位置，不改逻辑。

## 测试

| 层 | 用例 |
|---|---|
| scout | `description` 入库；live 评分解析出 targetBuyer/painPoint；**mock 下两字段为空串**（防止日后给 heuristic 加假文案）；旧 score_detail 缺字段不崩 |
| server | rescore 改分且幂等；rescore 不存在的 id → 404；`parseAnalysisSummary` 正常 / 缺段 / 文件不存在 |
| web | 构建通过 + 浏览器实跑（本仓库前端无单测，沿用既有做法） |

## 不做

候选池搜索 / 筛选 / 分页、评分权重可调、痛点多条展示（只取首条）、候选阶段的深度分析。
