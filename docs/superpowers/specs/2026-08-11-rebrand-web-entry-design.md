# 换皮清单 Web 入口 + 立项后直达详情页

> 日期：2026-08-11　状态：已实施合入 main

## 背景

`2026-08-10-projects-board-upgrade-design.md` 明确把 rebrand 的 Web 展示标记为"本轮不做"。用户随后把完整目标流程讲清楚：**找项目卡片点「立项」→ 直达项目详情页 → 详情页把项目拆解成「分析」+「换皮清单」两份产物，换皮清单是可以直接复制给外部 Claude Code 会话执行的开发任务清单**。这正好是上次跳过的那个缺口，本次补上。

**AI 接入的程度**（已与用户确认）：生成可复制的 checklist，人工拷贝给另一个 Claude Code 会话去改真实代码仓库——不在 ForgeCast 内做自动 clone+改代码，与开发文档 §9「换皮是 Claude Code 的常规开发工作，不写成代码模块」的既定设计一致。

## 1. 立项后直达详情页

`apps/web/src/pages/ScoutPage.tsx` 的 `pick` mutation：原来只 `invalidateQueries(['candidates'])`，`POST /api/candidates/pick` 返回体里的 `{slug}` 被完全丢弃，用户点「立项」后停在找项目页。改为：

```ts
mutationFn: (repo: string) => api<{ slug: string }>('/api/candidates/pick', ...)
onSuccess: ({ slug }) => {
  qc.invalidateQueries({ queryKey: ['candidates'] })
  qc.invalidateQueries({ queryKey: ['projects'] })
  navigate(`/projects/${slug}`)
}
```

## 2. 后端带出 rebrand-plan.md

`GET /api/projects/:slug` 复用既有的 `readFileSafe`（文件不存在返回空串，和 `analysisMd` 同构），加一行读 `rebrand-plan.md`：

```ts
const rebrandMd = readFileSafe(path.join(ctx.config.paths.workspace, row.slug, 'rebrand-plan.md'))
return c.json({ ...row, analysisMd, rebrandMd })
```

## 3. 项目详情页「分析 / 换皮清单」tab

`ProjectDetailPage.tsx` 左主区顶部操作条用现成的 `.seg-tabs` 组件类加两个 tab。`analyze()` 和新增的 `rebrand()` 各自独立的 `busy`/`log` 状态（不共享互斥锁，允许分析做完立刻点换皮清单）：

- **分析 tab**：行为不变。
- **换皮清单 tab**：按钮 `disabled={rebranding || !p.analysisMd}`（`rebrandPlan()` 后端硬要求 `analysis.md` 存在，前端提前拦一次比等报错体验好）；无 `analysisMd` 时旁边灰字提示"先在「分析」tab 生成分析报告"，正文空态"先生成分析"；有 `analysisMd` 无 `rebrandMd` 时正文空态"点上方「生成换皮清单」"；生成完成后渲染 markdown + 顶部「复制全文」按钮（`navigator.clipboard.writeText`，失败态有 `alert` 兜底，不静默吞错——剪贴板 API 在文档不可见/失焦场景会拒绝）。

## 验证

- `pnpm test` 全仓回归（新增 `server/projects.test.ts` 一条：`GET /api/projects/:slug` 带出 `rebrandMd`，没有文件时为空串）。
- `pnpm --filter web exec tsc --noEmit` + `pnpm --filter web build` 通过。
- 浏览器实测：候选卡片点「立项」直接跳到 `/projects/<slug>`；新项目「换皮清单」tab 按钮 disabled + 正确提示；生成分析后按钮启用；生成换皮清单后正文渲染 7 段 checklist（含具体文件路径，如 `README.md`、`docs/*.md`、`favicon.ico` 等，是可直接执行的改造指引）；老项目（无 `analysis.md`）同样正确显示"先生成分析"。
