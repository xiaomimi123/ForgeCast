# 删除已立项项目

> 日期：2026-08-11　状态：已实施合入 main

## 背景

用户反馈"无法删除已经立项的项目"和"无法增加立项的项目"。排查后是同一个根因：系统从未实现删除 project 的能力（无 API、无 CLI、无前端按钮），而 `pickCandidate`（`packages/scout/src/pick.ts`）对同一 repo 立项一次后把候选 `status` 永久锁死为 `'picked'`（`if (cand.status === 'picked') throw ...`），没有配套的"撤销"手段——这就是"无法重新立项"的真正原因，不是新建项目功能整体损坏。

已与用户确认两个业务决策：
1. 删除项目时把对应候选状态重置回 `'candidate'`，允许同一个 repo 重新立项。
2. 若项目下的素材已有真实询单（leads，客户线索），拦下拒绝删除，保护业务数据——与现有 `deleteAsset`（单条素材删除）的护栏逻辑一致。

## 实现

`packages/scout/src/pick.ts` 新增 `deleteProject(ctx, slug)`，是 `pickCandidate` 的镜像操作：

1. 查项目是否存在，不存在抛错。
2. 查该项目下所有 `assets`，若其中任意一条有关联 `leads` → 整体抛错「该项目下的素材有关联询单，不能删除」，不做任何改动。
3. 事务内：删除该项目所有 `assets` 行 → 删除 `projects` 行 → 若 `candidate_id` 非空，把对应候选 `status` 改回 `'candidate'`。
4. 事务外：`fs.rmSync(workspace/<slug>, {recursive:true, force:true})` 整目录删除（比逐文件删除更简单彻底，覆盖 `source/`、`analysis.md`、`rebrand-plan.md`、`raw/`、`copy/`、`covers/`、`videos/`、`cutplan.json` 等所有产物）。

`packages/server/src/app.ts` 新增 `DELETE /api/projects/:slug`：项目不存在→404；询单护栏命中→409；其余异常→500，模式与现有 `DELETE /api/assets/:id` 完全一致。

`apps/web/src/pages/ProjectDetailPage.tsx` 右栏底部新增「危险操作」卡片，`window.confirm` 二次确认（沿用 `AssetCard.tsx`、`TailorDetailPage.tsx` 已有的确认弹窗模式）后调 mutation，成功后 `invalidateQueries(['projects'])` + `navigate('/projects')`；失败时用同 `AssetCard.tsx` 的错误信息解析方式弹 `alert`（从 `api()` 抛出的 `"{status}: {body}"` 里解析出 JSON `error` 字段）。

## 验证

- `packages/scout/test/pick.test.ts` 新增 5 条：正常删除+候选重置+可重新立项、连带删除素材、询单护栏拒绝且三方都不动、项目不存在报错、无关联候选（手建项目）也能删。
- `packages/server/test/delete-project.test.ts`（新）：200/404/409 三态。
- 全仓 `pnpm test` 回归、`tsc --noEmit`、`vite build` 均通过。
- 命令行端到端验证完整闭环：`DELETE /api/projects/gentelella` → 200 → `GET` 404 → 候选 `status` 变回 `candidate` → workspace 目录消失 → `POST /api/candidates/pick` 同一 repo 重新立项成功。
- 浏览器验证：「危险操作」卡片渲染正常；实际点击确认弹窗因浏览器自动化工具无法操作原生 `window.confirm()` 对话框而未完成端到端点击测试，改用上一条命令行验证覆盖同一后端逻辑。
