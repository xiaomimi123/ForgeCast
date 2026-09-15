# 行业锚定选品 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 选品从「产品形态关键词」改为「行业锚定」——LLM 按行业生成 GitHub 搜索词（缓存），新增「业务含量」评分维把模板/壳子类项目挡在池外。

**Architecture:** core 建 industries/industry_queries 两表+candidates.industry_id；scout 新增 generateIndustryQueries（mock 自带固定词表）与 businessDepth 评分维+硬门槛+关键词硬排；server CRUD；web 设置页行业块+选品页行业筛选。

**Tech Stack:** better-sqlite3、@forgecast/scout、Hono、React。

**Spec:** `docs/superpowers/specs/2026-09-15-industry-scouting-design.md`

## Global Constraints

- **每个 LLM 能力必须自带 mock 分支**，不得借道 `ctx.llm` 的通用返回（仓内铁律，违者 mock 模式产出 copy fixtures）
- 权重重配：`rebrandCost 20 / buyerClarity 30 / visualAppeal 20 / businessDepth 30`（合计 100）
- businessDepth 硬门槛 **< 12 直接不入库**（不是低分留着），日志计数
- 关键词硬排跑在 LLM 之前（省 token）；命中排除词但 README 有业务实证时**不排**
- 存量候选不回溯重评（值快照）；`candidates.industry_id` 可空＝未分类，不影响既有流程
- 全部行业停用时回落既有 `DEFAULT_TOPICS`，选品不失效
- 迁移幂等（ensureColumn/CREATE IF NOT EXISTS/seed 可重跑）
- 测试用 Node 22.23.2（主仓 better-sqlite3 现为 22 ABI；worktree 独立 install 后先探）
- 用户 5173/4321 不碰；禁止 pkill/killall；提交不带 Co-Authored-By

---

### Task 1: core 迁移 + 默认行业 seed

**Files:**
- Modify: `packages/core/src/db.ts`（两表 + `ensureColumn(candidates, industry_id, 'INTEGER')` + seed）
- Test: `packages/core/test/`（既有 db 测试所在文件；无则新建 `db-industries.test.ts`）

**Interfaces（后续任务消费）:**
```sql
industries(id, name UNIQUE NOT NULL, note, enabled INTEGER DEFAULT 1, sort_order INTEGER DEFAULT 0, created_at)
industry_queries(industry_id PRIMARY KEY REFERENCES industries(id) ON DELETE CASCADE, keywords TEXT NOT NULL, model TEXT, generated_at)
candidates.industry_id INTEGER  -- 可空
```
seed 默认 8 行业（`INSERT OR IGNORE`，按 name 唯一去重，sort_order 0..7）：
`资讯媒体 / 情感社交 / 教育培训 / 外贸跨境 / 本地生活服务 / 健康养生 / 汽车房产 / 餐饮零售`
每行 note 给一句老板痛点（例：外贸跨境→「做外贸的老板要管客户询盘、报价单、物流单据」），供 LLM 生成搜索词时当上下文。

- [ ] **Step 1: 失败测试**：`openDb` 后两表存在、8 行 seed 齐、candidates 有 industry_id 列；**幂等**：同一 db 连跑两次 openDb，industries 仍是 8 行（不重复插）；删掉一行再 openDb 会补回（INSERT OR IGNORE 语义）。
- [ ] **Step 2: 红 → 实现 → 绿**（core 包测试全绿）
- [ ] **Step 3: Commit** `feat(core): 行业表与默认行业 seed`

### Task 2: scout 搜索词生成 + 业务含量评分 + 硬排

**Files:**
- Modify: `packages/scout/src/scout.ts`（scoutCandidates 接 industries）、`packages/scout/src/score.ts`（businessDepth + heuristicScore 扩展）、`packages/core/src/config.ts`（weights 加 businessDepth）
- Create: `packages/scout/src/industry.ts`（生成+缓存+mock 词表）
- Test: `packages/scout/test/`（既有测试同目录）

**Interfaces:**
```ts
// industry.ts
export interface Industry { id: number; name: string; note: string | null; enabled: number }
/** live：LLM 按 name+note 生成 12-20 个 GitHub 真实英文技术关键词；mock：INDUSTRY_MOCK_KEYWORDS 固定表。
 *  写入 industry_queries 缓存并返回。 */
export async function generateIndustryQueries(ctx: CoreCtx, industry: Industry): Promise<string[]>
/** 读缓存；无缓存则调 generateIndustryQueries。 */
export async function queriesFor(ctx: CoreCtx, industry: Industry): Promise<string[]>
/** repo 名/描述命中排除词且 README 无业务实证 → true（跳过不入库）。纯函数。 */
export function isTemplateRepo(repo: string, description: string | null, readme: string): boolean
export const INDUSTRY_MOCK_KEYWORDS: Record<string, string[]>  // 8 行业各 12-20 词
```

排除词：`template|boilerplate|starter|theme|scaffold|admin-ui|component-library|awesome-|example|demo|tutorial|learning`
业务实证（反证，命中则不排）：README 含 `database|schema|migration|model|api|endpoint|auth|role|permission|order|customer|invoice|workflow|prisma|sequelize|django|rails`

`score.ts`：`ScoreDetail` 加 `businessDepth: number` 与 `businessDepthReason: string`；live prompt 加第四维（正反例锚定：「有订单/学员/客户实体+数据库模型+角色权限＝高；只有 UI 组件/主题/脚手架＝低」）；mock `heuristicScore` 加：
`businessDepth = Math.min(w.businessDepth, 6 + (有业务实证词 ? 14 : 0) + (有 db/schema/model ? 10 : 0))`

`scoutCandidates`：opts 加 `industryIds?: number[]`；取 enabled 行业（或指定子集）→ `queriesFor` → `searchRepos` → 结果带 industry_id；**全停用回落 DEFAULT_TOPICS（industry_id 为 null）**。ingest 前先 `isTemplateRepo` 跳过；评分后 `businessDepth < 12` 跳过不入库；返回值加 `skippedTemplate: number; skippedShallow: number`，日志各一行。

- [ ] **Step 1: 失败测试**：mock 词表 8 行业齐全且每组 ≥12 词；`isTemplateRepo` 正反（`awesome-vue` 排除 / **`vue-element-admin` 名字带 admin 但 README 有 `api`+`role` → 不排**）；businessDepth mock 推分数值；阈值跳过（造一个 businessDepth=8 的 → 不入库、计数+1）；全停用回落 DEFAULT_TOPICS。
- [ ] **Step 2: 红 → 实现 → 绿**（scout 85 基线+新增全绿；core 包 weights 改动跟着跑）
- [ ] **Step 3: 变异两发**：(a) 删阈值判定 → 跳过用例红；(b) `isTemplateRepo` 去掉业务实证反证 → `vue-element-admin` 用例红。还原。
- [ ] **Step 4: Commit** `feat(scout): 行业搜索词生成、业务含量评分与模板硬排`

### Task 3: server CRUD + 选品入口接行业

**Files:**
- Create: `packages/server/src/industry-routes.ts`（挂进 app.ts）
- Modify: `packages/server/src/app.ts`（选品触发路由 body 加 industryIds）
- Test: `packages/server/test/industries.test.ts`

**Interfaces:**
- `GET /api/industries` → `[{id,name,note,enabled,sortOrder,keywordCount,generatedAt}]`（keywordCount/generatedAt 来自 industry_queries 左连接，无缓存则 0/null）
- `POST /api/industries` body `{name, note?}`（name 非空唯一，重名 400）；`PATCH /api/industries/:id` body `{name?,note?,enabled?,sortOrder?}`；`DELETE /api/industries/:id`（级联删缓存，不存在 404）
- `POST /api/industries/:id/queries`（重新生成，调 `generateIndustryQueries`）→ `{keywords}`；不存在 404
- 选品触发路由 body 加可选 `industryIds: number[]`（非数组或含非数字 400；空数组＝全部启用行业）

- [ ] **Step 1: 路由正反测试先行 → 红 → 实现 → server 包全绿**
- [ ] **Step 2: Commit** `feat(server): 行业 CRUD 与选品按行业触发`

### Task 4: web 设置页行业块 + 选品页行业筛选 + 文档

**Files:**
- Modify: `apps/web/src/pages/SettingsPage.tsx`（行业块）、`apps/web/src/pages/ScoutPage.tsx`（筛选 chips + 跑选品勾选行业 + 候选卡片行业标签）、`apps/web/src/pages/board/CandidateDrawer.tsx`（评分明细加业务含量行）、`apps/web/src/api.ts`
- Modify: `README.md`、spec 附实现偏差注记

要点：设置页「选品行业」块——列表（名称/备注/启停开关/删除按钮）+ 新增行输入；每行显示「N 个搜索词 · 生成于 X」+「重新生成」按钮（loading 态，失败落页面提示不用 alert）。选品页顶部行业 chips（全部/各启用行业）筛候选列表；「开始选品」弹层可勾选行业子集（默认全选）。候选抽屉评分明细加「业务含量」行，低分显示 `businessDepthReason`。

- [ ] **Step 1: 读现场**（SettingsPage 既有块姿势、ScoutPage 候选列表与触发按钮、CandidateDrawer 评分明细渲染、api.ts 封装）→ 实现 → `npx tsc --noEmit` 干净
- [ ] **Step 2: 浏览器自测**（临时 workspace+独立 db；server Node 版本先探；端口自选按 PID 关，**禁止 pkill/killall**，5173/4321 不碰）：行业增删改启停回读一致；重新生成搜索词（mock 模式秒回）显示词数；mock 跑一次选品 → 候选带行业标签、模板类被挡（日志/计数可见）；抽屉显示业务含量；全停用时选品仍能跑（回落）。
- [ ] **Step 3: 文档**：README 选品段改写（行业锚定/业务含量门槛/搜索词缓存）；spec 附实现偏差注记（从 ledger 的 Ruling 行提炼）。
- [ ] **Step 4: Commit** `feat(web)+docs: 行业设置与选品筛选`

## Self-Review

- Spec 覆盖：§1.1 迁移+seed（T1）、§1.2 生成+mock+缓存+回落（T2）、§2.1 硬排（T2）、§2.2 businessDepth+权重+阈值（T2）、§2.3 分类并存（不动 CATEGORIES＝天然满足）、§3 UI 三处+重评按钮（T4——**重评按钮复用 rescoreCandidate，spec 说「可选」，T4 里做成设置页一个按钮，若现场发现 rescore 路由不存在则记 backlog 不强行加**）、§4 测试（各任务）、§5 非目标未越界、§6 风险（0 命中日志在 T2 实现）。缺口：无。
- 占位符：无 TBD；排除词/反证词/mock 推分公式/阈值均给了字面量。
- 类型一致性：`Industry/generateIndustryQueries/queriesFor/isTemplateRepo/INDUSTRY_MOCK_KEYWORDS/businessDepth/businessDepthReason/industryIds` 各任务引用一致。
