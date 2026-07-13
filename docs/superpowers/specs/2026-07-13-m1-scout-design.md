# M1 — 项目发现与筛选（scout）设计

> 里程碑：ForgeCast P1 剩余项之一（开发文档 §3 / §10 P1 item 6 的引擎部分）。
> 本里程碑只交付**引擎（CLI + API）**；Web 项目看板页作为紧接的下一步（不在本 spec 范围）。
> 下游：M1 的 `pick` 立项产物是 M2（analyst）的输入；M2 单独 spec。

## 目标

从 GitHub 发现可"换皮变现"的开源项目，按四维模型评分入候选池，人工挑选后**立项**（生成 project + workspace 目录 + 把源项目 README/目录树落地），为后续 M2 分析、M4 文案、M5 视频提供起点。

核心原则沿用现有切片：引擎/界面分离（能力是 `packages/*` 的 core 函数，CLI 与 API 是两个入口）；mock 默认、无 key 可离线跑通；产物是文件；中文文档与注释。

## 范围

**做**：`@forgecast/scout` 包（GitHub 搜索/抓取、协议 gate、LLM 三维评分、去重入池、立项）；`core/config` 增加 github 双模式配置；server 薄端点（scout/add/candidates/pick，复用现有任务队列+SSE）；CLI `scout` / `scout --add` / `pick`；mock fixture 候选与评分；vitest 全 mock 覆盖。

**不做（本里程碑）**：Web 项目看板页；GitHub Trending HTML 抓取（无官方 API、页面易变）；评分权重配置化（P2 按实测校准，先硬编码默认值）；stage 泳道拖拽；官网截图作为评分输入（纯文本 README 起步）。

## 架构

新包 `packages/scout`（`@forgecast/scout`），包名与 monorepo 结构约定一致（开发文档 §1）。依赖 `@forgecast/core`（config/db/llm/ctx）。

对外 core 函数（三个编排 + 内部评分）：

```ts
// 搜索 topic 白名单 × stars>300 × 近半年活跃 → 去重 → 协议 gate → Top-N 抓 README → LLM 评分 → 入 candidates
scoutCandidates(ctx: CoreCtx, opts?: ScoutOptions): Promise<ScoutResult>
// 手动投喂单个 repo：抓元数据+README → 协议 gate → LLM 评分 → 入池
addRepo(ctx: CoreCtx, repoUrl: string): Promise<Candidate>
// 立项：candidate → projects 行 + workspace/<slug>/source/{README.md,tree.txt}
pickCandidate(ctx: CoreCtx, repo: string): Promise<{ slug: string; projectId: number }>
```

内部：

```ts
// GitHub 客户端（mock/live 双模式），只在 scout 包内出现——M2 不碰 GitHub
createGithubClient(cfg, fetchImpl?): GithubClient
  // .searchRepos(topics, opts) / .fetchRepo(repo) / .fetchReadme(repo) / .fetchTree(repo)
scoreCandidate(ctx, repoMeta, readme): Promise<ScoreDetail>  // 协议 gate 后调用，一次 LLM
```

### 数据流

```
forgecast scout
  搜索(topic白名单) → 去重(repo full_name) → 协议 gate(license 字段)
    → 过关者按 star 取 Top-N → 抓 README → 每个一次 LLM 三维评分
    → 写 candidates(score/score_detail/tech_stack/status=candidate)
  打印 Top20 排名表（人看）
        │
        ▼
forgecast pick <repo>
  candidates → projects(slug,candidate_id) + workspace/<slug>/source/{README.md,tree.txt}
  candidates.status = 'picked'
        │
        ▼  ← M2 的输入（下一个里程碑）
  forgecast analyze <slug>
```

**边界纪律**：GitHub 抓取只在 `@forgecast/scout` 内发生；M2 只读 `workspace/<slug>/source/`，不重复实现抓取。

## 评分模型（四维，总分 100）

| 维度 | 分值 | 判定 |
|---|---|---|
| 协议可商用 | 一票否决 | 本地判：SPDX ∈ {MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC, MPL-2.0} → `license_ok=1`；GPL*/AGPL*/SSPL/无协议/未知/判断不了 → `0` |
| 换皮成本 | 30 | LLM 读 README：技术栈匹配(React/Node/Next 高)、有无 Docker、i18n、UI 可主题化 |
| 买家清晰度 | 40 | LLM 判：能否一句话说清"什么老板会掏钱"，越垂直越高 |
| 内容可视性 | 30 | LLM 判：有无好看可演示的 UI（纯 CLI/后端低分） |

- **协议 gate 在 LLM 评分之前**：用 GitHub Search API 返回的 `license.spdx_id` 字段，零额外调用；`license_ok=0` 者留在池里标记但**不进 LLM 评分、不进排名**（省成本、合规一票否决）。
- **成本上限**：只对过协议关的候选按 star 排序取 Top-N（默认 `limit`，见配置）抓 README + LLM 评分，避免给几百个 repo 全量抓+评分。
- LLM 单次调用输出结构化 JSON：

```json
{ "换皮成本": 24, "买家清晰度": 34, "内容可视性": 21, "tech_stack": ["react","node","docker"], "rationale": "一句话：给中小电商的在线客服，买家清晰、有 Docker、UI 可演示" }
```

- 落库：`candidates.score` = 三维之和(0-100)；`candidates.tech_stack` = LLM 返回的 `tech_stack` 数组（JSON 字符串，独立列）；`candidates.score_detail` = 维度分解 + rationale 的 JSON 字符串（即上例去掉 tech_stack 后的其余字段，或整体存入亦可，以列 tech_stack 为准）。
- 权重（30/40/30）P1 硬编码在 scout；开发文档 §10 P2 再按成交数据校准，届时移到配置。
- 已知局限：「内容可视性」靠 LLM 从 README 推断，偏粗，接受，靠后续实测校准。

## 双模式（GitHub 与 LLM 两条独立轴）

`core/config.ts` 的 `ForgecastConfig` 增加：

```ts
github: { mode: 'mock' | 'live'; token: string }
```

- `FORGECAST_GITHUB_MODE`（默认 `mock`）、`FORGECAST_GITHUB_TOKEN`（可选，live 提限速）。
- mock：`createGithubClient` 返回 fixture 候选（见下），不发网络；live：真实 GitHub Search / raw README / git trees API（token 存在则带 `Authorization`）。
- LLM 评分复用现有 `FORGECAST_LLM_MODE`。**两轴默认都 mock → scout 全程无 key、离线、fixture 分数**（可测、可 demo）。真抓真评需两者都 live。
- `.env.example` 增补这两个变量。

### mock fixture 候选

`packages/scout/src/fixtures/candidate-fixtures.ts`：4-6 个真实感 repo（如在线客服/CRM/发票/表单各一，**含一个 GPL 项目**专门触发协议 gate），每个带：repo full_name、url、license spdx、stars、README 文本、以及 mock LLM 评分要用的预置 rationale。风格对齐 core 的 `copyFixtures`。

## 立项契约（M1→M2 交接）

`pickCandidate(ctx, repo)`：

1. 按 `repo`（owner/name）查 candidate；不存在 → 报错；`license_ok=0`（协议不过）→ 报错拒绝立项。
2. `slug` 由 repo 名派生：`owner/My-Cool-App` → `my-cool-app`（小写、非 `[a-z0-9]` 段转 `-`、去首尾 `-`）；若 `projects.slug` 已存在 → 追加 `-2`/`-3`…去重。
3. `INSERT projects(slug, candidate_id)`；`UPDATE candidates SET status='picked'`。
4. 建 `workspace/<slug>/source/`，写 `source/README.md`（源项目 README）与 `source/tree.txt`（目录树，每行一路径）。mock 模式用 fixture 的 README/tree；live 模式抓取。
5. 返回 `{ slug, projectId }`。

`workspace/<slug>/source/` 是 M2 的读入口契约（M2 spec 依赖此）。

## 入口

### CLI（`cli.ts` 增加分支）

```bash
forgecast scout [--topics=crm,live-chat] [--limit=30]   # 批量发现+评分，打印 Top20 表
forgecast scout --add <repo-url>                         # 手动投喂单个 repo
forgecast pick <owner/repo>                              # 立项，打印生成的 slug 与 source/ 路径
```

Top20 表列：名次 / repo / stars / license / score / 一句话(rationale 截断)。

### REST（`packages/server/src/app.ts` 增加路由，复用现有 `queue` + SSE）

| 方法 路径 | 说明 | 返回 |
|---|---|---|
| `POST /api/scout` | body `{topics?, limit?}`，enqueue `scoutCandidates` | `{taskId}`（SSE 推：搜索/评分进度） |
| `POST /api/candidates/add` | body `{url}`，enqueue `addRepo` | `{taskId}` |
| `GET /api/candidates` | 候选池，`license_ok=1` 优先、`score DESC` | `Candidate[]` |
| `POST /api/candidates/pick` | body `{repo}`，调 `pickCandidate` | `{slug}` 或 404/400 |

（用 body 传 `repo` 而非路径参数，避开 `owner/name` 里的斜杠。）

## 测试策略（TDD，全 mock）

`packages/scout/test/`：
- **协议 gate**：MIT→1、Apache-2.0→1、GPL-3.0→0、AGPL→0、null/未知→0。
- **scoreCandidate**（mock LLM）：三维合成 = 三者和，`score_detail` JSON 结构与字段正确。
- **scoutCandidates**（mock GitHub + mock LLM）：fixtures → candidates 入库；同 repo 出现两次 → 去重一行；结果按 score 倒序、rejected 不进排名；GPL fixture 入池但 `license_ok=0` 且不评分。
- **addRepo**（mock）：单 repo → 入池一行、带评分。
- **pickCandidate**（mock）：建 projects 行 + `workspace/<slug>/source/{README.md,tree.txt}` 落盘、slug 派生正确、撞名加后缀、`candidate_id` 关联、`status='picked'`；对 `license_ok=0` 的候选立项 → 抛错。

`packages/core/test/config.test.ts`：新增 github 字段默认 mock、读 token 的用例（不动现有用例）。

`packages/server/test/`：mock 走一遍——`POST /api/scout` 任务完成 → `GET /api/candidates` 有排序候选；`add`；`pick` 后 `GET /api/projects` 能看到新项目。

不测 live GitHub（与 llm 只测 mock 同）。

## 全局约束（沿用）

- Node 20 / pnpm 9；`@forgecast/scout` 的 `main` 直指 `src/index.ts`，无 build 步骤（tsx/vitest bundler 解析）。
- 服务只绑 127.0.0.1；产物落 workspace/<slug>/；文档与注释中文。
- commit 用 conventional commits，结尾 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`。
- TDD：每个功能先写失败测试。
- 依赖：scout 用全局 `fetch`（Node 20 内置）做 GitHub 调用，`fetchImpl` 可注入以便测试；不引入额外 HTTP 库。scout 因在 `pickCandidate` 用 `better-sqlite3` 的 Database 类型（经 ctx.db），需在自身 `devDependencies` 声明 `@types/better-sqlite3`（对齐 copywriter 的既有做法）。

## 未决/后续

- Web 项目看板页（Top20 排名表 + 四维雷达 + 一键立项/淘汰 + stage 泳道）——紧接的下一步或并入 M2 的 UI。
- GitHub Trending 源、评分权重配置化、官网截图评分输入——P2。
- `pickCandidate` 的 live 抓取里 GitHub API 限速与增量策略在实现时按 Search API 限制（未认证 10 次/分，token 30 次/分）设退避；本 spec 只约束接口与 mock 行为。
