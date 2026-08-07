# 界面五板块重组 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Web 导航按业务流重组为「找项目 / 拆解需求 / 做内容 / 分发营销 / 定制项目 / 设置」六项，现 BoardPage 一拆为二，Calendar+Review 合并进分发营销板块，/tailor 先放占位壳。

**Architecture:** 只动 `apps/web`，后端零改动。BoardPage 的候选池部分变成 ScoutPage、项目泳道部分变成 ProjectsPage；MarketPage 是一层 tab 壳直接复用 CalendarPage/ReviewPage 组件；旧路由 301 式 `<Navigate>` 重定向。

**Tech Stack:** React 18 + react-router-dom v6 + @tanstack/react-query + Tailwind（全部已有，无新依赖）。

**Spec:** `docs/superpowers/specs/2026-08-08-tailor-blocks-design.md` §1

## Global Constraints

- web 无单测（package.json test 脚本即 echo），每个任务的验证 = `pnpm --filter web exec tsc --noEmit` 通过 + `pnpm --filter web build` 通过。
- 不改任何 `packages/*` 后端代码、不改 `apps/web/src/api.ts`。
- 中文 UI 文案；代码注释风格跟随现有文件（中文、说明约束而非复述代码）。
- commit message 末尾带 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`。

---

### Task 1: BoardPage 拆分为 ScoutPage + ProjectsPage

**Files:**
- Create: `apps/web/src/pages/ScoutPage.tsx`
- Create: `apps/web/src/pages/ProjectsPage.tsx`
- Delete: `apps/web/src/pages/BoardPage.tsx`（Task 2 改完 App.tsx 后一起删，本任务先建新页）
- 不动: `apps/web/src/pages/board/`（CandidateCard / CandidateDetailModal / StageLanes 原样复用）

**Interfaces:**
- Consumes: 现 `BoardPage.tsx` 的全部逻辑（`apps/web/src/pages/BoardPage.tsx`，149 行）；`board/StageLanes.tsx` 的 props `{ projects, onMove, loaded }`
- Produces: `ScoutPage`（default export，无 props）、`ProjectsPage`（default export，无 props），Task 2 的 App.tsx 引用这两个组件

- [ ] **Step 1: 创建 ScoutPage.tsx**

内容 = 现 `BoardPage.tsx` 整体复制后做减法，保留候选池全部逻辑（candidates 查询、pick/rescore/rescoreAll/backfillCats/scout、分类筛选、日志面板、协议折叠区、CandidateDetailModal），删掉三处：

1. 删 `import StageLanes from './board/StageLanes'` 与 `type Project` 导入（`import { api, subscribeTask, type Candidate } from '../api'`）
2. 删 `const projects = useQuery(...)` 与 `const moveStage = useMutation(...)` 两段
3. 删 JSX 里 `<StageLanes ... />` 一行

组件改名 `export default function ScoutPage()`。其余一字不动（含并发追踪注释）。

- [ ] **Step 2: 创建 ProjectsPage.tsx**

```tsx
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type Project } from '../api'
import StageLanes from './board/StageLanes'

export default function ProjectsPage() {
  const qc = useQueryClient()
  const projects = useQuery({ queryKey: ['projects'], queryFn: () => api<Project[]>('/api/projects') })
  const moveStage = useMutation({
    mutationFn: ({ slug, stage }: { slug: string; stage: string }) =>
      api(`/api/projects/${slug}`, { method: 'PATCH', body: JSON.stringify({ stage }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['projects'] }),
    onError: (e) => alert(`移动失败: ${e instanceof Error ? e.message : String(e)}`),
  })
  return (
    <StageLanes
      projects={projects.data ?? []}
      loaded={projects.isSuccess}
      onMove={(slug, stage) => moveStage.mutate({ slug, stage })}
    />
  )
}
```

- [ ] **Step 3: 类型检查（BoardPage 仍在且未被改，应通过）**

Run: `pnpm --filter web exec tsc --noEmit`
Expected: 无错误

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/pages/ScoutPage.tsx apps/web/src/pages/ProjectsPage.tsx
git commit -m "feat(web): BoardPage 拆分为 ScoutPage(候选池) + ProjectsPage(项目泳道)"
```

---

### Task 2: MarketPage tab 壳 + TailorPage 占位

**Files:**
- Create: `apps/web/src/pages/MarketPage.tsx`
- Create: `apps/web/src/pages/TailorPage.tsx`

**Interfaces:**
- Consumes: `CalendarPage`、`ReviewPage`（default export、无 props，原样内嵌）
- Produces: `MarketPage`、`TailorPage`（均 default export、无 props），Task 3 的 App.tsx 引用；TailorPage 是占位壳，tailor 板块计划（2026-08-08-tailor-blocks.md）会整体替换它

- [ ] **Step 1: 创建 MarketPage.tsx**

```tsx
import { useState } from 'react'
import CalendarPage from './CalendarPage'
import ReviewPage from './ReviewPage'

// 分发营销板块：发布日历 + 数据复盘两个 tab（组件不重写，只套壳）
const TABS = [
  { key: 'calendar', label: '发布日历' },
  { key: 'review', label: '数据复盘' },
] as const
type TabKey = (typeof TABS)[number]['key']

export default function MarketPage() {
  const [tab, setTab] = useState<TabKey>('calendar')
  return (
    <div className="space-y-4">
      <div className="flex gap-2 text-sm">
        {TABS.map((t) => (
          <button
            key={t.key}
            className={`rounded-full border px-4 py-1.5 ${tab === t.key ? 'bg-blue-600 text-white' : 'bg-white text-neutral-600'}`}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tab === 'calendar' ? <CalendarPage /> : <ReviewPage />}
    </div>
  )
}
```

- [ ] **Step 2: 创建 TailorPage.tsx（占位壳）**

```tsx
// 定制项目板块占位壳：完整功能见 docs/superpowers/plans/2026-08-08-tailor-blocks.md
export default function TailorPage() {
  return (
    <div className="rounded-lg border bg-white p-10 text-center text-neutral-400">
      定制项目板块开发中：客户需求拆解 → GitHub 找轮子 → 拼装方案书
    </div>
  )
}
```

- [ ] **Step 3: 类型检查**

Run: `pnpm --filter web exec tsc --noEmit`
Expected: 无错误

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/pages/MarketPage.tsx apps/web/src/pages/TailorPage.tsx
git commit -m "feat(web): 分发营销 tab 壳(日历+复盘) + 定制项目占位页"
```

---

### Task 3: App.tsx 六项导航 + 旧路由重定向 + 删 BoardPage

**Files:**
- Modify: `apps/web/src/App.tsx`（整文件替换）
- Delete: `apps/web/src/pages/BoardPage.tsx`

**Interfaces:**
- Consumes: Task 1/2 产出的 `ScoutPage` `ProjectsPage` `MarketPage` `TailorPage`
- Produces: 路由约定 `/scout` `/projects` `/workshop` `/market` `/tailor` `/settings`，tailor 板块计划依赖 `/tailor` 路由存在

- [ ] **Step 1: 替换 App.tsx**

```tsx
import { Navigate, NavLink, Route, Routes } from 'react-router-dom'
import MarketPage from './pages/MarketPage'
import ProjectDetailPage from './pages/ProjectDetailPage'
import ProjectsPage from './pages/ProjectsPage'
import ScoutPage from './pages/ScoutPage'
import SettingsPage from './pages/SettingsPage'
import TailorPage from './pages/TailorPage'
import WorkshopPage from './pages/WorkshopPage'

const nav = ({ isActive }: { isActive: boolean }) => (isActive ? 'font-semibold text-blue-600' : 'text-neutral-500')

export default function App() {
  return (
    <div className="min-h-screen bg-neutral-50 text-neutral-900">
      <header className="border-b bg-white px-6 py-3 flex items-center gap-6">
        <span className="font-bold text-lg">ForgeCast</span>
        <nav className="flex gap-4 text-sm">
          <NavLink to="/scout" className={nav}>找项目</NavLink>
          <NavLink to="/projects" className={nav}>拆解需求</NavLink>
          <NavLink to="/workshop" className={nav}>做内容</NavLink>
          <NavLink to="/market" className={nav}>分发营销</NavLink>
          <NavLink to="/tailor" className={nav}>定制项目</NavLink>
          <NavLink to="/settings" className={nav}>设置</NavLink>
        </nav>
      </header>
      <main className="p-6">
        <Routes>
          <Route path="/" element={<Navigate to="/scout" replace />} />
          <Route path="/scout" element={<ScoutPage />} />
          <Route path="/projects" element={<ProjectsPage />} />
          <Route path="/workshop" element={<WorkshopPage />} />
          <Route path="/market" element={<MarketPage />} />
          <Route path="/tailor" element={<TailorPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/projects/:slug" element={<ProjectDetailPage />} />
          {/* 旧路由重定向：书签/肌肉记忆兼容 */}
          <Route path="/board" element={<Navigate to="/scout" replace />} />
          <Route path="/calendar" element={<Navigate to="/market" replace />} />
          <Route path="/review" element={<Navigate to="/market" replace />} />
        </Routes>
      </main>
    </div>
  )
}
```

说明：`拆解需求` 的 NavLink 故意不加 `end`——打开 `/projects/:slug` 项目详情时该导航保持高亮，详情页本就属于拆解需求板块，这是期望行为。

- [ ] **Step 2: 删除 BoardPage.tsx**

Run: `git rm apps/web/src/pages/BoardPage.tsx`

- [ ] **Step 3: 类型检查 + 构建**

Run: `pnpm --filter web exec tsc --noEmit && pnpm --filter web build`
Expected: 均无错误

- [ ] **Step 4: 手工验收（唯一一次，起 dev 服务）**

Run: `pnpm dev`（起 API :4321 + Web :5173，验完 Ctrl-C）
打开 http://localhost:5173 依次确认：
1. `/` 跳到 `/scout`，能看到「抓取候选」按钮与候选卡片
2. 「拆解需求」页显示五列泳道；点项目卡进详情、返回
3. 「分发营销」页两个 tab 能切换，日历/周报正常渲染
4. 「定制项目」页显示占位文案
5. 手输 `/board` `/calendar` `/review` 分别跳到 `/scout` `/market` `/market`

- [ ] **Step 5: 全仓测试回归（确认没碰坏后端）**

Run: `pnpm test`
Expected: 全绿（web 的 test 脚本是 echo 占位，正常）

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/App.tsx
git commit -m "feat(web): 导航按五大板块重组(找项目/拆解需求/做内容/分发营销/定制项目)"
```

---

### Task 4: README 更新

**Files:**
- Modify: `README.md`（第 3 行进度描述、第 17 行快速开始的入口描述）

**Interfaces:**
- Consumes: Task 3 的最终路由结构
- Produces: 无（文档）

- [ ] **Step 1: 更新 README**

1. 第 17 行 `打开 http://localhost:5173 → 素材工坊 → 选 demo-project → 生成。` 改为：
   `打开 http://localhost:5173 → 默认进「找项目」板块；做素材在「做内容」板块选 demo-project → 生成。`
2. 「目录结构」节 `apps/web Web 控制台` 后补一句板块说明：
   `apps/web` Web 控制台（按业务流分五板块：找项目 `/scout` / 拆解需求 `/projects` / 做内容 `/workshop` / 分发营销 `/market` / 定制项目 `/tailor`）

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: README 更新五板块导航说明"
```
