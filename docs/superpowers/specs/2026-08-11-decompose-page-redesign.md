# 拆解需求页去拖拽 + 收窄到分析/换皮两阶段

> 日期：2026-08-11　状态：已实施合入 main

## 背景

`/projects`「拆解需求」原本是横向拖拽泳道（`StageLanes.tsx`），五条泳道 `analysis→rebranding→producing→publishing→selling` 左右排开，卡片靠 HTML5 drag 在泳道间移动。用户明确要去掉拖拽式展示。

进一步澄清后收窄了范围：**这个页面只管「拆解」这一段——分析 + 换皮两个阶段**。产素材/发布/成交三个阶段分别由「做内容」（项目下拉）、「分发营销」（日历/复盘）板块承担展示职责，不该在这里重复出现。项目一旦推进过换皮阶段（产出首条素材、自动推进到 producing），就该从这个页面消失——不是删除，只是不在这里展示；在其他板块仍完整可见可操作。

stage 现在主要靠产物落地自动推进（见 `packages/core/src/stage.ts` 和 `2026-08-10-projects-board-upgrade-design.md`），拖拽只是一个手动补丁通道。去掉拖拽后仍保留手动改阶段的入口，改成下拉选择。

## 实现

`apps/web/src/pages/board/StageLanes.tsx` 整体重命名替换为 `ProjectGroups.tsx`（"泳道"这个名字去掉拖拽后不再贴切，只有 `ProjectsPage.tsx` 一处引用）：

- `GROUPS`（只两项：分析/换皮）与 `ALL_STAGES`（完整 5 项，供下拉选择）分开声明；分组渲染只用 `GROUPS`，避免展示产素材/发布/成交空分组。
- 布局从横向定宽泳道（`min-w-[200px] flex-1` + `overflow-x-auto`）改成纵向堆叠区块，每块内是响应式卡片网格（`grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4`，抄自 `ScoutPage.tsx` 的候选网格），比定宽泳道更好利用宽屏空间。
- 卡片去掉 `draggable`/`onDragStart`/`onDragEnd`/`cursor-grab`，保留三级回退买家/痛点信息（`fallbackIntro`）和真实产物计数行；`onClick` 仍跳详情页。
- 卡片内新增一个原生 `<select>`（完整 5 阶段选项），`onChange` 复用现有 `onMove(slug, stage)` 回调（即 `PATCH /api/projects/:slug`，后端已有 `isStage` 校验，零改动）；外层包一层 `onClick={(e) => e.stopPropagation()}` 防止点下拉触发卡片跳转（抄 `CandidateCard.tsx` 按钮行的写法）。选到 producing 及以后，卡片下次渲染就从两组里消失——这是预期行为。
- 两种空态：完全没有立项项目 → 沿用旧文案；有项目但都不在拆解阶段 → 新增文案「当前没有处于拆解阶段的项目——已进入后续阶段的项目请去「做内容」/「分发营销」板块查看」。

`ProjectsPage.tsx` 补一个页面标题（原来完全没有 `<h1>`，其他板块都有），格式与 `ScoutPage.tsx` 一致；`moveStage` mutation 不变。

后端零改动：`PATCH /api/projects/:slug` 的 stage 校验、`GET /api/projects` 的 counts/JOIN 都是现成的。

## 验证

- `pnpm --filter web exec tsc --noEmit` + `pnpm --filter web build` 通过。
- 浏览器验证：`/projects` 只显示「分析」「换皮」两组；把一张卡片的下拉改成「产素材」，PATCH 生效（`curl GET /api/projects/:slug` 确认 stage 落库）且卡片从两组里消失；「做内容」页项目下拉仍能选到该项目（确认没有从全局项目列表消失，只是不在这个页面展示）；点下拉本身不触发卡片跳转；全部项目都不在拆解阶段时的空态文案正确显示。
