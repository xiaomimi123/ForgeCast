# §8 项目看板 stage 泳道拖拽流转 设计

> 清单发现的缺口：BoardPage 只有候选池排名表，缺"立项项目按 stage 泳道展示 + 拖拽流转"（§8 项目看板）。

## 现状
- 后端已齐：`GET /api/projects`(SELECT * 含 stage)、`PATCH /api/projects/:slug` 白名单已含 `stage`。projects.stage 取值 analysis|rebranding|producing|publishing|selling(默认 analysis)。
- 缺：前端泳道 UI + 拖拽改 stage。纯前端改动，无需动后端、无新依赖（用原生 HTML5 DnD）。

## 方案（仅改 apps/web/src/pages/BoardPage.tsx）
- 候选表下方加"立项项目"区，5 条泳道：analysis(分析)→rebranding(换皮)→producing(产素材)→publishing(发布)→selling(成交)。
- 数据：`useQuery(['projects'])` → `GET /api/projects`；按 stage 分组。
- 拖拽（原生）：项目卡 `draggable`，`onDragStart` 记住 slug；泳道 `onDragOver`(preventDefault) + `onDrop` → `PATCH /api/projects/:slug {stage:该道}` → 失效 `['projects']` 刷新。
- 卡片显示 slug + brand_name + 点击 `useNavigate` 到详情页（点击=导航、拖拽=移动，互不冲突）。
- 空泳道显示占位；横向可滚动不撑破页面。

## 验证
- web `tsc --noEmit` + `build` 干净。
- 浏览器加载 /board：候选表在、下方 5 泳道渲染；有立项项目时卡片落在其 stage 道。
- 拖拽落到新道 → PATCH 持久化（刷新后仍在新道）；后端 PATCH stage 既有测试已覆盖。

## 范围外
- 候选池四维雷达图（§8 提到"评分四维雷达"，当前是数字列，雷达图属可选增强，不在本 pass）。
- 拖拽动画库（dnd-kit 等）——用原生 DnD，YAGNI。

## 约束
- 沿用 Tailwind（非 shadcn）；中文；不新增依赖；trailer。
