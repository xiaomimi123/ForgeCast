# 行业锚定选品（选品筛选重构）设计

> 日期：2026-09-15　状态：设计已确认，待写实施计划
>
> 用户实报问题：选品捞上来的多是排版/模板类仓库，没有商业可行性。根因——搜索词是产品形态（`crm/dashboard/form-builder/link-in-bio`），分类也是产品形态，**整条链路无行业维度**，且评分三维（换皮成本/买家清晰度/视觉效果）**不含「是不是真业务系统」**。

## 0. 决策记录

| 决策点 | 结论 |
|---|---|
| 行业如何锚定 | **LLM 生成搜索词**（GitHub 无行业标签）；生成结果**缓存**，不每次选品重跑 |
| 行业清单 | 内置默认 8 个 + 设置页可增删改启停 |
| 排除模板类 | **新增第四评分维「业务含量」**（低于阈值直接不入库）+ 关键词硬排兜底（省 token，跑在 LLM 之前） |

## 1. 行业词表与搜索词生成

### 1.1 数据模型（core/db.ts 幂等迁移）

```sql
CREATE TABLE IF NOT EXISTS industries (
  id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL, note TEXT,
  enabled INTEGER NOT NULL DEFAULT 1, sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS industry_queries (
  industry_id INTEGER PRIMARY KEY REFERENCES industries(id) ON DELETE CASCADE,
  keywords TEXT NOT NULL, model TEXT, generated_at TEXT DEFAULT (datetime('now'))
);
```
`candidates` 加 `industry_id INTEGER`（ensureColumn，可空；存量为 null＝「未分类」，不影响既有流程）。

内置默认 8 行业（首次 openDb 时 seed，已存在则不动）：资讯媒体、情感社交、教育培训、外贸跨境、本地生活服务、健康养生、汽车房产、餐饮零售。

### 1.2 搜索词生成（scout 新能力，mock/live 双模式）

`generateIndustryQueries(ctx, industry): Promise<string[]>`
- live：prompt 给行业名+note，要求输出 **12-20 个 GitHub 上真实存在的英文技术关键词/topic**（例：教育培训 → `lms, moodle, course-management, student-information-system, quiz, e-learning, gradebook`），JSON 数组。
- **mock 自带固定词表**（8 行业各一组硬编码）——仓内铁律：每个 LLM 能力必须自带 mock，不得借道 `ctx.llm` 的通用返回。
- 结果写 `industry_queries` 缓存；设置页「重新生成」手动刷新。

选品时：遍历 enabled 行业 → 读缓存词（无缓存则先生成）→ `searchRepos` → 命中结果带 `industry_id` 入库。**全部行业停用时回落既有 `DEFAULT_TOPICS`**（选品功能不至于整个失效）。

## 2. 业务含量评分 + 排模板

### 2.1 关键词硬排（LLM 之前，零成本）

repo 名/描述命中 `template|boilerplate|starter|theme|scaffold|admin-ui|component-library|awesome-|example|demo|tutorial|learning` **且** README 无业务实证（无数据库模型/API 路由/业务实体迹象）→ 跳过不入库，日志计数。

### 2.2 新增第四评分维 `businessDepth`

- 权重重配（原 30/40/30=100）：`rebrandCost 20 / buyerClarity 30 / visualAppeal 20 / businessDepth 30`（合计 100，`scout.weights` 加键）。
- live：LLM 读 README 判断——有真实业务实体与流程（订单/学员/客户/库存/工单、数据库模型、角色权限、状态机）高分；只是 UI 壳/组件库/主题/脚手架/demo 集合低分。prompt 给正反例锚定，避免一律中间分；额外输出一句 `businessDepthReason`。
- mock：`heuristicScore` 同款关键词启发式扩展，离线确定可测。
- **硬门槛**：`businessDepth < 12`（=权重 30 的 40%）**直接不入库**，日志「N 个因业务含量过低跳过」。

### 2.3 分类维度并存

既有 `CATEGORIES`（客服/CRM/电商…＝产品形态）保留不动；**行业是正交新维度**。一个候选可以是「教育培训行业 × 表单/问卷形态」。

## 3. UI 与兼容

- **设置页「选品行业」块**：列表（名称/备注/启停/删除）+ 新增行；每行显示缓存词数与生成时间 + 「生成/重新生成搜索词」按钮。
- **选品页**：行业筛选 chips（全部/各启用行业）；候选卡片显示行业标签；跑选品可勾选行业子集。
- **候选抽屉**：评分明细加「业务含量」行，低分显示 `businessDepthReason`。
- 存量候选不回溯重评（值快照）；设置页给可选动作「按新标准重评候选池」，复用既有 `rescoreCandidate`（scout.ts:138）。

## 4. 测试

- scout：`generateIndustryQueries` mock 词表断言；硬排正反例（**含「名字带 template 但 README 有业务实证」的反证用例**）；`businessDepth` 阈值跳过+变异（删阈值判定→用例红）。
- core：两表幂等迁移 + seed 幂等（重复 openDb 不重复插）。
- server：industries CRUD 正反；queries 缓存读写与重新生成。
- 端到端（mock）：跑一次完整选品，断言候选带 industry_id、模板类被挡、日志计数正确。
- 既有 scout 测试全绿（85 条）；①②渲染门禁不涉及此链路。

## 5. 非目标

给已有候选反推行业；多语言搜索词；GitHub 之外的源（Product Hunt 等）；按行业调权重；行业级配额（每行业最多 N 个）。

## 6. 风险与取舍

- LLM 生成的关键词可能包含 GitHub 上不存在的 topic（搜出 0 结果）——不报错，日志记「该词 0 命中」，下次重新生成时可人工看日志调 note。
- 业务含量硬门槛会缩小候选池；阈值写进 `scout.weights` 旁的配置，调不动时可改。首次上线建议先跑一轮看跳过率。
- 权重重配后旧候选的 `score` 与新候选不同量纲（旧分满分仍是 100 但三维构成）——重评按钮是拉齐手段，不强制。

## 7. 实现偏差（实施后补记，2026-09-15）

实施过程中与本设计不一致、或设计未写明的裁决（出处：`.superpowers/sdd/2026-09-15-industry-scouting/progress.md` 的 Ruling 行）：

- **反证词表分档**（§2.2 之外的加法）：硬排的反证词不再是一张平表，而是分两档——**业务实体档**（订单/客户/发票/排期等真实体）才算「业务实证」可豁免硬排；**数据层档**（Prisma/schema/migration 等）只参与业务含量推分，不单独构成豁免。原因：brief 给的平表把 Authentication/Prisma 也算实证，真实感 starter 照样能放行，等于门槛不存在。代价：带数据层但无业务实体的真项目可能被误排（README 反证仍能兜底）。
- **业务含量门槛随权重等比缩**：阈值不是定值 12，而是 `min(12, businessDepth 权重 × 40%)`。原因：权重可调，写死 12 时用户把「业务含量上限」调到 ≤11 会让门槛恒不可达、选品静默清空。
- **超 limit 的仓库绕过门槛 ⇒ 门槛不是库级保证**：排不进本轮 Top-limit 的嫌疑仓库不抓 README 验反证、直接跳过（省 live 额度），等 star 涨进名额的那一轮再判。因此「库里有模板类仓库」不等于门槛失效，README 已写明这一口径。
- **一个仓库只归首个命中的行业**（按 `sort_order`）：多行业交叉命中不建多对多关系表，交叉行业统计缺失是已知代价，多对多记 backlog（属 §5 非目标邻域）。
- **FK 裁决更正**：设计实施中曾裁决「本仓未开 `PRAGMA foreign_keys`，故 `industry_queries` 的 ON DELETE CASCADE 不生效，必须显式删」——该前提**实测不成立**：better-sqlite3 默认 `foreign_keys=ON`，级联本就生效。DELETE 路由里的显式删缓存行保留（防御性双保险，将来若有人关 FK 仍正确），但注释里的理由已按实情改写（Task 4）。
- **`PATCH /api/industries/:id` 的 `enabled` 收严格布尔**（不收 0/1），前端负责转换。
- **UI 没有雷达图**：§3 说的「评分明细」在实现里是四条进度条（`buildDims`），不是雷达图；第四维「业务」按同一套条渲染，低分时在下方补一行 `businessDepthReason`。
- **「按新标准重评候选池」的实际语义**：设置页的按钮复用既有 `POST /api/candidates/rescore-all`，而该路由只重评 `score_detail` 里没有 `targetBuyer` 的候选（＝「没真评过」的），**不会**强制重评已有旧三维分的候选。逐个重评仍走候选抽屉的「重新评分」。批量强制重评的路由未新增——记 backlog，UI 与 README 已写明旧三维分与新四维分不可直接比较。

### backlog（本次未做）

- 候选 ↔ 行业多对多（交叉行业统计）。
- 批量强制重评全池（现有 rescore-all 语义是「补评未评过的」）。
- 搜索词缓存的自动失效（改名/改备注后自动标记为待重生成，目前靠人点「重新生成」）。
- `industryIds=null` 场景的服务端测试覆盖（行为正确，覆盖面窄，Task 3 遗留）。
