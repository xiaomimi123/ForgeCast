# M3 — 换皮改造清单生成器（rebrand）设计

> 开发文档 §9：M3 不是代码模块，是**标准化任务清单生成器**。`forgecast rebrand <slug>` 读 analysis.md → 输出 `rebrand-plan.md`（可直接执行的 checklist，交 Claude Code 执行）。
> 结构、双模式、入口与 M2 analyst 高度一致（读一份 md → 一次 LLM/mock → 校验固定段落 → 写 md）。
> 上游：M2 的 `analysis.md`（+ M1 的 `source/tree.txt`）；下游：人工/Claude Code 按清单执行换皮。

## 目标

把一个已分析项目的换皮改造工作，自动生成成固定结构、可直接执行的 checklist `rebrand-plan.md`，CLI+API 两入口，mock 无 key 可跑。

## 范围

**做**：新包 `@forgecast/rebrand`（`rebrandPlan` + 段落校验 + mock fixture）；提示词模板 `templates/prompts/rebrand.md`；CLI `rebrand <slug>`；REST `POST /api/projects/:slug/rebrand`（入队+SSE）；vitest 全 mock。

**不做（本口）**：Web 页/按钮（rebrand-plan.md 主要给 CLI/Claude Code 用；如需 Web 展示属后续）；真正执行换皮（那是 Claude Code 的常规开发工作，不在本工具内）；读源码逐文件分析（本口只读 analysis.md + source/tree.txt 概览，具体文件路径由 live LLM 依 tree 推断）。

## 架构

新包 `packages/rebrand`（`@forgecast/rebrand`），依赖 core。对外：
```ts
async function rebrandPlan(ctx: CoreCtx, slug: string, opts?: { onProgress?: (m: string) => void }): Promise<{ path: string }>
function validateRebrand(md: string): string[]        // 缺失段名
function mockRebrand(slug: string, analysis: string, tree: string): string  // fixture，不调 LLM
```

**数据流**：
```
forgecast rebrand <slug> / POST /api/projects/<slug>/rebrand
  读 workspace/<slug>/analysis.md（必需，缺则报错）+ source/tree.txt（可选）
    → mock: mockRebrand(...)（固定结构 checklist，不调 ctx.llm）
    → live: 模板 + analysis + tree → ctx.llm.complete → validateRebrand 缺段抛错
    → 写 workspace/<slug>/rebrand-plan.md（覆盖=重新生成）
```

**约定**（遵循 forgecast 既有教训）：mock 分支不调 `ctx.llm`（会拿到文案 fixture）；复用 `FORGECAST_LLM_MODE`。

## rebrand-plan.md 固定结构（开发文档 §9 的 7 步）

```markdown
# <项目名> 换皮改造清单

## 1. 品牌替换
（fork 源码 → 全局替换品牌名/Logo/favicon/主题色；列出需改的文件路径）

## 2. 删除项
（原 GitHub 链接、捐赠链接、英文文档入口、遥测上报）

## 3. 中文化 i18n
（界面全量中文化的范围与入口）

## 4. 本土化新增功能
（analysis.md 建议的 1-2 个：如微信登录、对接抖店）

## 5. 部署
（Cloudflare Pages/Workers 或 Docker→轻量服务器，产出 demo_url）

## 6. 录屏
（OBS 录制 3-5 分钟全流程操作，存 raw/）

## 7. 合规自检
（确认无 GPL 传染、无原作者商标残留）
```

`validateRebrand` 检查的 7 个二级标题起始词：`1. 品牌替换`、`2. 删除项`、`3. 中文化`、`4. 本土化`、`5. 部署`、`6. 录屏`、`7. 合规自检`（按 `## ` 后起始文本 `startsWith` 判定）。live 缺段抛错不落半成品。

## 双模式（复用 llm 轴）

- 复用 `FORGECAST_LLM_MODE`（默认 mock）。mock → `mockRebrand(slug, analysis, tree)`（固定 7 段 checklist，slug 填标题，正文通用可执行），**不调 ctx.llm**；live → 读 `templates/prompts/rebrand.md` + analysis + tree 组装 → `ctx.llm.complete({model: llm.models.analysis, ...})` → 校验。
- 不加新 config。

## 入口

- **CLI**：`forgecast rebrand <slug>` → 打印 rebrand-plan.md 相对路径。default help 把 `rebrand` 从"未实现"移到已实现。
- **REST**：`POST /api/projects/:slug/rebrand` → 项目不存在 404；否则 enqueue `rebrandPlan` → `{taskId}`（SSE 进度）。

## 测试策略（TDD，全 mock）

`packages/rebrand/test/`：
- `validateRebrand`：完整 7 段 → []；删一段 → 列出。
- `mockRebrand`：H1 含 slug、含 7 个二级段。
- `rebrandPlan` mock：seed 项目 + `workspace/<slug>/analysis.md`（+可选 source/tree.txt）→ 写出 rebrand-plan.md 含 7 段、H1 含 slug、返回相对路径、不调 ctx.llm（`vi.spyOn` 断言）；无 analysis.md → 抛错（含 analysis）。
- `rebrandPlan` live：注入假 llm 返回合法 7 段 → 落盘；返回缺段 → 抛错不落盘。

`packages/server/test/`：`POST /api/projects/<slug>/rebrand` 任务完成 → `workspace/<slug>/rebrand-plan.md` 存在；未知项目 404。

## 全局约束（沿用）

- Node 20 / pnpm 9；`@forgecast/rebrand` main=src/index.ts，无 build；依赖 core，devDeps `@types/better-sqlite3`。
- 产物落 workspace/<slug>/rebrand-plan.md（相对路径）；服务只绑 127.0.0.1；中文注释；TDD；commit trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`。

## 未决/后续

- rebrand-plan.md 的 Web 展示/按钮（项目详情页）——后续。
- 读源码逐文件精确改造建议（结合 GitHub 树深读）——后续。
- README 增补 rebrand CLI（本口实现时同步）。
