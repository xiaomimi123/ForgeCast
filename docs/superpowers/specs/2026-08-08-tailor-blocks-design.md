# 板块化重组 + 定制项目板块（tailor）设计

日期：2026-08-08　状态：已与用户逐节确认

## 目标

1. Web 界面按业务流重组为五大板块：找项目 → 拆解需求 → 做内容 → 分发营销 → 定制项目（+设置）。底层 packages 结构不动，界面搬运合并为主。
2. 新增**定制项目板块**：拆解客户需求 → 逐能力在 GitHub 搜可复用轮子 → 人工决策选型 → 生成拼装方案书。核心理念：避免重复造轮子；产出是**方案书**（人拿着方案去开发），不自动生成代码。
3. 打通引流→接单闭环：分发营销登记的询单（lead）可一键转为定制需求。

## 1. 界面重组（板块导航）

顶部导航改为六项，旧路由重定向到新路由：

| 导航 | 路由 | 内容来源 |
|---|---|---|
| ① 找项目 | `/scout` | 现 BoardPage 的候选池部分：抓取候选、候选卡片、详情弹窗、评分、立项按钮 |
| ② 拆解需求 | `/projects` | 现 BoardPage 的 StageLanes（已立项项目泳道）独立成页，点入 ProjectDetailPage（商业化分析 / 换皮清单） |
| ③ 做内容 | `/workshop` | 素材工坊原样保留 |
| ④ 分发营销 | `/market` | 发布日历 + 数据复盘合并，页内两个 tab；询单（leads）列表也在此，每条询单带「转定制需求」按钮 |
| ⑤ 定制项目 | `/tailor` | 新页面 |
| 设置 | `/settings` | 不变 |

- 现 BoardPage 一拆为二：候选池 → 找项目；项目泳道 → 拆解需求。
- CalendarPage / ReviewPage 组件不重写，只套一层 tab 壳。
- 首页默认跳「找项目」（业务流起点），不再跳素材工坊。

## 2. 数据模型

沿用 `packages/core/src/db.ts` 的 `CREATE TABLE IF NOT EXISTS` + `ensureColumn` 幂等迁移方式，新增三张表（需求 → 能力清单 → 轮子候选）：

```sql
CREATE TABLE IF NOT EXISTS tailor_requests (      -- 定制需求
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,                            -- 需求短标题
  raw_need TEXT NOT NULL,                         -- 客户原始需求（手动粘贴或询单文本）
  lead_id INTEGER REFERENCES leads(id),           -- 询单转入时关联，手动录入为 NULL
  status TEXT DEFAULT 'draft',                    -- draft → decomposed → searched → proposed
  proposal_path TEXT,                             -- 方案书文件路径（生成后回填）
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS tailor_capabilities (  -- 拆出的能力项
  id INTEGER PRIMARY KEY,
  request_id INTEGER REFERENCES tailor_requests(id),
  name TEXT NOT NULL,                             -- 能力名，如「微信扫码登录」
  detail TEXT,                                    -- 能力说明
  keywords TEXT,                                  -- GitHub 搜索关键词（JSON 数组）
  decision TEXT DEFAULT 'pending',                -- pending / wheel(选定轮子) / self_build(需自研) / dropped(不做)
  chosen_repo TEXT,                               -- decision=wheel 时的 owner/repo
  sort INTEGER                                    -- 展示顺序
);
CREATE TABLE IF NOT EXISTS tailor_wheels (        -- 每项能力搜到的候选轮子
  id INTEGER PRIMARY KEY,
  capability_id INTEGER REFERENCES tailor_capabilities(id),
  repo TEXT NOT NULL, url TEXT NOT NULL,
  license TEXT, license_ok INTEGER,               -- 复用 scout 的协议白名单判断
  stars INTEGER, last_commit TEXT, description TEXT,
  score REAL, score_detail TEXT                   -- 规则评分（见 §3.3）
);
```

取舍：

- **能力清单可编辑**：LLM 拆解结果落库后，Web 上直接增删改；重新拆解会清掉旧能力项及其轮子（有确认提示）。
- **协议不合规的轮子不删、标 `license_ok=0`**：折叠展示但保留——定制场景下 GPL 轮子有时可用（客户内部部署不分发），人工判断，方案书标风险。
- **产物目录**：`workspace/tailor/<id>/proposal.md`，与 `workspace/<slug>/` 每项目一目录的约定平行。

## 3. 定制流程与模块实现

新包 `packages/tailor`，四个核心模块，每步一个动作、可单独重跑：

### 3.1 decompose.ts 需求拆解
新 LLM capability `tailorDecompose`：输入 `raw_need`，输出 JSON 能力清单（每项 name / detail / keywords）。按项目惯例 mock 模式带自己的 fixture（不走 ctx.llm 的文案 fixture）。JSON 解析失败自动重试一次，再失败报错不写库。拆完 status → `decomposed`，用户在 Web 上增删改确认。

### 3.2 search.ts 轮子搜索
给 scout 的 `GithubClient` 加 `searchByKeywords(keywords, opts)`（现有 `searchRepos` 按 topic 搜，此处按关键词全文搜，`sort=stars`），mock 模式回 fixture。逐能力搜索，每项取 top 8，写入 `tailor_wheels` 并复用 `isLicenseOk` 标协议。单项能力搜索失败不阻塞其他能力，失败项标记后可单独重搜。全部跑完 status → `searched`。

### 3.3 score.ts 轮子评分
在 search 动作内对写入的每个轮子即时打分（纯规则零成本，不单独设状态/动作；独立成模块只为便于测试）。不烧 LLM（量大：能力数 × 8 轮子）：活跃度（last_commit 距今）+ stars 档位 + 协议分 + 关键词命中度（repo 名/描述与 keywords 匹配），四维加权 0-100，`score_detail` 存分项。排序展示，用户逐能力决策：选轮子 / 标自研 / 划掉不做。

### 3.4 proposal.ts 方案书生成
新 LLM capability `tailorProposal`（带 mock fixture）：输入需求 + 已决策能力清单（含选定轮子元数据），输出 `proposal.md`：选型总表、每项能力胶水层工作量估计、协议/维护风险、报价参考区间、自研项清单。status → `proposed`。

### 3.5 接入层

- CLI：`forgecast tailor add "<需求>"` / `tailor list` / `tailor decompose <id>` / `tailor search <id>` / `tailor proposal <id>`
- Server API：`/api/tailor` 系列 CRUD + 三个动作端点（decompose/search/proposal，复用现有 tasks 队列跑长任务，SSE 报进度）；`POST /api/leads/:id/to-tailor` 询单一键转入（intent 文本带入 raw_need）
- Web：`/tailor` 列表页（需求卡片 + 状态徽标）→ 详情页按状态分步：原始需求 → 能力清单（可编辑表格）→ 逐能力轮子候选（卡片勾选，样式沿用 CandidateCard 套路）→ 方案书预览（markdown 渲染，沿用现有产物预览方式）

## 4. 错误处理与测试

### 错误处理
- **全链路 mock 可演示**：LLM mock + GitHub mock 下从录入到方案书免 key 跑通；沿用 `⚠` 降级提示惯例，live 缺 key 降级并明确打印，绝不静默给假结果。
- **GitHub 限流**：live 搜索遇 403/429 时该能力项标记失败附提示（换 token / 稍后重搜），不影响其他能力项；搜索间加小间隔。
- **LLM 输出校验**：两个 capability 均校验 JSON/结构，失败重试一次后报错，不写半截数据。
- **状态机保护**：动作按 status 顺序约束（未拆解不能搜轮子；未决策完不能出方案书，决策完 = 每项能力均非 pending），重跑动作有覆盖确认。

### 测试（vitest，全 mock，沿用现有风格）
- tailor 包单测：拆解 JSON 解析与重试、`searchByKeywords` mock、评分规则边界值（活跃度/协议/命中度）、方案书渲染含选型表
- server 路由测试：tailor CRUD + 动作端点 + 询单转入 + 状态机拦截（乱序调用返回 4xx）
- db 迁移测试：新表幂等重建
- Web：界面搬运不写新测试；TailorPage 交互逻辑抽 hook 的部分配单测

## 范围外（YAGNI）

自动 clone 轮子 / 生成骨架代码、轮子依赖冲突分析、方案书导出 PDF、报价历史统计。
