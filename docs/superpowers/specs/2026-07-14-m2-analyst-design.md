# M2 — 商业化分析引擎（analyst）设计

> 里程碑：ForgeCast P1 剩余项之一（开发文档 §4 / §10 P1 item 5）。
> 上游：M1 的 `pick` 已把源项目 README/目录树落 `workspace/<slug>/source/{README.md,tree.txt}`；M2 读它。
> 下游：M2 产出 `workspace/<slug>/analysis.md`，M4 `generateCopy` 已在读它（作为自由字符串塞进提示词）。

## 目标

把一个已立项项目的源码信息（README + 目录树）自动分析成固定结构的商业化分析报告 `analysis.md`，替代当前给 demo 手写的做法。analysis.md 是后续所有素材生成的唯一上下文源（M4/M5 不重读原始 README，只读 analysis.md），保证口径一致。

沿用现有切片原则：引擎/界面分离；mock 默认、无 key 离线可跑；产物是文件；中文文档与注释。

## 范围

**做**：新包 `@forgecast/analyst`（`analyzeProject` 核心函数 + 7 段校验 + mock fixture）；live 提示词模板 `templates/prompts/analysis.md`；server 端点 `POST /api/projects/:slug/analyze`（复用队列+SSE）；CLI `analyze <slug>`；ProjectDetailPage 加「生成分析」按钮；vitest 全 mock 覆盖。

**不做（本里程碑）**：官网截图作为分析输入（纯文本 README 起步）；analysis.md 的结构化解析（下游按自由 markdown 消费，只做段落存在性校验）；多轮/长链分析（一次 LLM 调用）；对 analysis.md 的 Web 行内编辑（详情页目前只渲染，不编辑正文）。

## 架构

新包 `packages/analyst`（`@forgecast/analyst`），包名与 monorepo 结构约定一致（开发文档 §1）。依赖 `@forgecast/core`。

对外核心函数：

```ts
// 读 source → mock fixture / live LLM → 校验 7 段 → 写 analysis.md
async function analyzeProject(
  ctx: CoreCtx,
  slug: string,
  opts?: { onProgress?: (msg: string) => void },
): Promise<{ path: string }>  // path 为相对 workspace 的 analysis.md 路径
```

内部：

```ts
function validateAnalysis(md: string): string[]        // 返回缺失的段名（空数组=齐全）
function mockAnalysis(slug: string, readme: string): string  // 结构完整的 fixture（不调 LLM）
```

### 数据流

```
forgecast pick <repo>  →  workspace/<slug>/source/{README.md,tree.txt}   [M1]
                                    │
                                    ▼
forgecast analyze <slug> / POST /api/projects/<slug>/analyze / 详情页「生成分析」
  读 source/README.md(+tree.txt)
    → mock: mockAnalysis(slug, readme)（7 段 fixture，slug 填标题，不调 ctx.llm）
    → live: 组装(模板 + source + slug) → ctx.llm.complete(analysis 模型) → validateAnalysis 缺段抛错
    → 写 workspace/<slug>/analysis.md（覆盖=重新生成）
                                    │
                                    ▼  ← M4 generateCopy 已在读它
                              素材工坊生成文案/封面
```

**边界纪律**：M2 只读本地 `source/`，不碰 GitHub（抓取只在 scout）；mock 分支不调 `ctx.llm`（会拿到文案 fixture，见 forgecast 既有教训）。

## analysis.md 固定结构（开发文档 §4）

```markdown
# <项目名> 商业化分析

## 一句话：这是给谁的什么
## 目标买家画像（主攻1个，备选2个）
## 痛点清单（按付费意愿排序，每条注明"现状成本"）
## 换皮方向建议
## 定价建议
## 钩子匹配（核心输出，直接喂给 M4）
## 风险
```

`validateAnalysis` 检查的 7 个二级标题关键词（`## ` 后的起始词，允许后接副标题）：`一句话`、`目标买家画像`、`痛点清单`、`换皮方向建议`、`定价建议`、`钩子匹配`、`风险`。缺任一 → 返回该段名。live 输出缺段 → `analyzeProject` 抛错，不写半成品。

## 双模式（复用现有 llm 轴）

- 复用 `FORGECAST_LLM_MODE`（默认 mock）。**mock 分支返回 `mockAnalysis(...)`，绝不调 `ctx.llm.complete`**（那只会按【钩子类型】返回小红书文案 fixture，解析必错）。
- live 分支：读 `templates/prompts/analysis.md` 模板 + source README（截断到 token 预算）+ 目录树摘要 + slug，组装成 system/prompt，调 `ctx.llm.complete({ model: ctx.config.llm.models.analysis, ... })`，`validateAnalysis` 校验后落盘。
- 不引入新的 config 字段（analyst 只用现有 llm 配置）。

### mock fixture

`packages/analyst/src/fixtures/analysis-fixture.ts` 的 `mockAnalysis(slug, readme)`：返回结构完整的 7 段 analysis.md，H1 为 `# <slug> 商业化分析`，正文为通用但合规、结构有效的模板内容（离线/测试用；能被 M4 消费）。`validateAnalysis(mockAnalysis(...))` 恒为 `[]`。

## live 提示词模板（新资产）

`templates/prompts/analysis.md`：指示"你是开源项目商业化分析专家"，读下方 source README + 目录树，**严格按 7 段结构输出**（段落标题一字不差、不输出额外内容），思路同 copywriter 的 `_format.md`。模板由 `analyzeProject` live 分支读取并与 source 拼装。

## 入口

### CLI（`cli.ts` 增加分支）

```bash
forgecast analyze <slug>   # 生成 workspace/<slug>/analysis.md
```

default help 文案把 `analyze` 从"未实现"移到已实现列表。

### REST（`packages/server/src/app.ts` 增加路由，复用 `queue` + SSE）

| 方法 路径 | 说明 | 返回 |
|---|---|---|
| `POST /api/projects/:slug/analyze` | 项目不存在 404；否则 enqueue `analyzeProject(ctx, slug, {onProgress:log})` | `{taskId}`（SSE 推进度） |

（analysis 内容仍由既有 `GET /api/projects/:slug`（含 `analysisMd`）读取，无需新增读端点。）

### Web（ProjectDetailPage）

左侧分析面板加「生成分析」按钮：POST `/api/projects/:slug/analyze` 拿 `taskId` → `subscribeTask` 订阅、显示进度日志 → `done` 后 `qc.invalidateQueries({queryKey:['project', slug]})` 让 analysisMd 重新渲染。生成中禁用按钮。复用 Task 13 的 `api`/`subscribeTask`。

## 测试策略（TDD，全 mock）

`packages/analyst/test/`：
- **validateAnalysis**：完整 7 段 md → `[]`；删掉「定价建议」→ 返回含该段名的数组。
- **analyzeProject mock**：给定一个 project + `workspace/<slug>/source/README.md`，跑后 `analysis.md` 存在、含 7 段、H1 含 slug；返回相对路径；不触发 ctx.llm（可用一个会抛错的假 llm 断言未被调用）。
- **analyzeProject live**（注入 llm mock）：假 llm 返回合法 7 段 md → 落盘成功；假 llm 返回缺段 md → 抛错且不写文件。
- **无 source**：项目存在但无 `source/README.md` → 抛错（含"source"提示）。

`packages/server/test/`：`POST /api/projects/<slug>/analyze`（先造 source/README）→ 任务完成 → `GET /api/projects/<slug>` 的 `analysisMd` 含生成内容；未知 slug → 404。

Web 按钮：无单测，任务级门禁 = `tsc --noEmit` + `vite build`；里程碑末做一次走查（pick 一个 scout 候选 → analyze → 详情页看到分析渲染）。

## 全局约束（沿用）

- Node 20 / pnpm 9；`@forgecast/analyst` 的 `main` 直指 `src/index.ts`，无 build 步骤。
- 包名 `@forgecast/analyst`，依赖 `@forgecast/core`，自身 `devDependencies` 声明 `@types/better-sqlite3`（对齐 scout/copywriter）。
- 服务只绑 127.0.0.1；产物落 workspace/<slug>/；analysis.md 路径 = 相对 workspace 的 `<slug>/analysis.md`。
- 文档与注释中文；commit conventional，结尾 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`；TDD。

## 未决/后续

- 官网截图/多模态输入、评分权重联动（把 M1 的 score_detail 喂进分析）、analysis.md 的 Web 行内编辑与"重新生成附意见"——后续里程碑。
- M3 rebrand 清单生成器读 analysis.md（P2）。
- demo-project（手建、无 source/）保留其手写 analysis.md 不动；M2 端到端验证走 pick→analyze。
