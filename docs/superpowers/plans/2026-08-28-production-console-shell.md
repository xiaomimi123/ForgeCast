# ForgeCast「生产控制台」视觉基础 + 导航壳重构（子项目①）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `apps/web` 的视觉从「锻造车间」主题换成设计稿的「生产控制台」主题（暖纸底+衬线/等宽混排+红蓝绿琥珀语义色），导航从「侧边栏 + React Router 多路由」改成「顶部工位流水线 + 单页 tab 切换」，项目/定制需求详情从整页路由改成右侧抽屉。

**Architecture:** 保留现有 CSS 变量**名字**（`--color-paper`/`--color-fire`/`--color-danger` 等），只换**取值**——这样全仓已经在用 `text-fire`/`bg-fire-soft`/`border-danger` 这类 Tailwind 工具类的地方（几十处）自动跟着换色，不用逐处改类名。`.card-forge`/`.btn-fire`/`.btn-ink`/`.seg-tabs` 四个既有组件类只换 CSS 实现，JSX 里的类名不用改。导航去 `react-router-dom`，`App.tsx` 用 `useState` 管理"当前工位" + 两个详情抽屉的开关状态，五个工位组件继续是普通函数组件，只是不再挂在 `<Route>` 上。

**Tech Stack:** React 18 + Vite + Tailwind v4（`@theme`）+ `@tanstack/react-query`，纯前端改动，不碰 `packages/server`。

**Spec:** `docs/superpowers/specs/2026-08-28-production-console-shell-design.md`

## Global Constraints

- 本次**只换皮肤 + 导航壳**，五个工位内部页面的数据结构、交互逻辑、组件拆分一律不动——除非该文件本身就要为了去 `react-router-dom` 依赖而改（把 `navigate()`/`useParams()`/`useSearchParams()` 换成回调 prop / 局部 `useState`），这类改动只许动路由相关的那几行，不许顺手重构其他逻辑。
- 不新增任何后端接口、不新增聚合查询——工位计数栏用现有 `useQuery(['candidates'])`/`useQuery(['projects'])`/`useQuery(['tailor'])` 的 `.length` 就地算，算不出来的工位（做内容/分发）就不显示计数，不编造假数字。
- 不做双轨评分表 / 热点雷达 / 四关验收灯——这三个是设计稿里的新概念，属于子项目②③，本计划任何一步都不涉及。
- 已知局限、本次不处理：现有页面里有一些内联 arbitrary Tailwind 阴影值直接写死了旧的炉火橙 RGB（如 `hover:shadow-[3px_3px_0_rgba(217,72,28,0.9)]`），不经过 `--color-fire` 变量，换 token 后这些内联阴影颜色不会跟着变。这次不逐处 grep 摘除，视觉上会有极少数残留旧橙色阴影，不影响功能；后续子项目②③④重做对应页面布局时顺手清掉。
- 每个任务做完都要跑 `pnpm --filter web exec tsc --noEmit` 确认 0 错误，且用 Playwright/Chrome 工具手动过一遍受影响的页面截图确认——这个仓库 `apps/web` 没有单元测试（`package.json` 的 `test` 脚本就是一行 `echo`），验收方式是类型检查 + 人工过一遍，不是伪造测试。

---

### Task 1: 视觉 Token 替换（`index.css` + `index.html`）

**Files:**
- Modify: `apps/web/index.html`
- Modify: `apps/web/src/index.css`

**Interfaces:**
- Produces：CSS 变量 `--color-paper/--color-card/--color-ink/--color-sub/--color-faint/--color-hairline/--color-fire/--color-fire-soft/--color-danger`（沿用旧名字、新取值）+ 新增 `--color-hairline-strong/--color-blue/--color-blue-soft/--color-green/--color-green-soft/--color-amber/--color-amber-soft`；`body` 纸张纹理背景；新增 `.chip`/`.stamp`/`.eyebrow`/`.rail`/`.station` 组件类，供 Task 3 的 `Rail.tsx` 使用。

- [ ] **Step 1: 加 Google Fonts 引入**

编辑 `apps/web/index.html`，在 `<head>` 里 `<title>` 标签后面加：

```html
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Noto+Serif+SC:wght@600;900&family=JetBrains+Mono:wght@400;600;700&display=swap" rel="stylesheet">
```

- [ ] **Step 2: 重写 `index.css`**

完整替换 `apps/web/src/index.css` 内容为：

```css
@import "tailwindcss";

/* 「生产控制台」主题 token（spec 2026-08-28-production-console-shell-design.md §1）
   沿用旧变量名（--color-fire 等），只换取值——全仓已在用的 text-fire/bg-fire-soft/border-danger
   等 Tailwind 工具类自动跟着换色，不用逐处改类名。 */
@theme {
  --color-paper: #F1F2EE;
  --color-card: #FAFAF8;
  --color-ink: #181A16;
  --color-sub: #6E7368;
  --color-faint: #9AA093;
  --color-hairline: #D9DBD2;
  --color-hairline-strong: #B9BCB0;
  --color-fire: #C13A1B;
  --color-fire-soft: #F5E4DE;
  --color-danger: #C13A1B;
  --color-blue: #2C4A6E;
  --color-blue-soft: #E3E9F0;
  --color-green: #3E6B4F;
  --color-green-soft: #E4EDE6;
  --color-amber: #9A6B14;
  --color-amber-soft: #F4EBD8;
}

* { box-sizing: border-box; }
body {
  background-image: repeating-linear-gradient(0deg, transparent 0 31px, rgba(24, 26, 22, .028) 31px 32px);
}

/* 组件类：只此几个（卡片/主按钮/次按钮/分段 tab/胶囊/图章/眼眉小标签/工位导航），其余一律工具类拼 */
.card-forge, .card {
  background: var(--color-card);
  border: 1px solid var(--color-hairline);
  border-radius: 4px;
}
.btn-fire, .btn {
  background: var(--color-ink);
  color: var(--color-paper);
  border: 1px solid var(--color-ink);
  border-radius: 3px;
  font-weight: 500;
}
.btn-fire:hover, .btn:hover { background: var(--color-fire); border-color: var(--color-fire); }
.btn-fire:disabled, .btn:disabled { opacity: 0.5; }
.btn-ink, .btn.ghost {
  background: transparent;
  color: var(--color-ink);
  border: 1px solid var(--color-ink);
  border-radius: 3px;
  font-weight: 500;
}
.btn-ink:hover, .btn.ghost:hover { background: var(--color-ink); color: var(--color-paper); }
.btn-ink:disabled { opacity: 0.5; }
.seg-tabs {
  display: inline-flex;
  border: 1px solid var(--color-ink);
  border-radius: 4px;
  overflow: hidden;
  background: var(--color-card);
}
.seg-tabs > button {
  border: none;
  background: transparent;
  padding: 8px 20px;
  font-size: 13.5px;
  font-weight: 600;
  color: var(--color-sub);
  border-right: 1px solid var(--color-hairline);
}
.seg-tabs > button:last-child { border-right: none; }
.seg-tabs > button.on { background: var(--color-ink); color: var(--color-paper); }

.chip {
  display: inline-block;
  font-family: "JetBrains Mono", monospace;
  font-size: 0.64rem;
  padding: 2px 7px;
  border-radius: 2px;
  border: 1px solid var(--color-hairline-strong);
  color: var(--color-sub);
}
.chip.veto { background: var(--color-ink); color: var(--color-paper); border-color: var(--color-ink); }

.stamp {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-family: "Noto Serif SC", serif;
  font-weight: 900;
  border: 2px solid var(--color-fire);
  color: var(--color-fire);
  border-radius: 50%;
  width: 52px;
  height: 52px;
  font-size: 0.8rem;
  transform: rotate(-8deg);
  opacity: 0.9;
}
.stamp.pending { border-style: dashed; color: var(--color-sub); border-color: var(--color-hairline-strong); transform: rotate(-4deg); }

.eyebrow {
  font-family: "JetBrains Mono", monospace;
  font-size: 0.64rem;
  letter-spacing: 0.14em;
  color: var(--color-faint);
}

/* 顶部工位流水线导航 */
.rail {
  border: 1px solid var(--color-hairline-strong);
  background: var(--color-card);
  border-radius: 4px;
  display: flex;
  overflow: hidden;
}
.station {
  position: relative;
  background: transparent;
  border: 0;
  border-right: 1px solid var(--color-hairline);
  padding: 13px 16px 11px;
  text-align: left;
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1;
}
.station:last-child { border-right: 0; }
.station .no {
  font-family: "JetBrains Mono", monospace;
  font-size: 0.62rem;
  color: var(--color-faint);
  letter-spacing: 0.12em;
}
.station .nm {
  font-family: "Noto Serif SC", serif;
  font-weight: 700;
  font-size: 1.02rem;
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.station .ct {
  font-family: "JetBrains Mono", monospace;
  font-size: 0.7rem;
  color: var(--color-sub);
}
.station[aria-selected="true"] { background: var(--color-ink); color: var(--color-paper); }
.station[aria-selected="true"] .no, .station[aria-selected="true"] .ct { color: var(--color-hairline-strong); }
.station.spur { border-left: 1px dashed var(--color-hairline-strong); flex: 0 0 auto; min-width: 140px; }
.station:hover:not([aria-selected="true"]) { background: var(--color-hairline); }
```

- [ ] **Step 2: 手动验证（不用等 Task 3 导航壳做完就能看）**

```bash
export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH"
cd /Users/lizhishaoniange/Documents/开源变现内容工厂
pnpm --filter web exec tsc --noEmit
```

预期无输出。然后启动 `pnpm dev`（若未在跑），用 Chrome 工具打开 `http://localhost:5173/scout`，截图确认：背景变暖纸色、卡片描边变细（1px，不再有硬阴影+粗黑边）、按钮/收藏态变成新的红色（不再是橙色）。**此时导航栏还是旧的侧边栏样式（Task 3 才改），这是预期的，本步骤只验证 token。**

- [ ] **Step 3: 提交**

```bash
git add apps/web/index.html apps/web/src/index.css
git commit -m "feat(web): 生产控制台视觉 token 替换——沿用旧变量名换新取值，全仓自动跟着换色"
```

---

### Task 2: 通用 Drawer 组件 + `CandidateDrawer` 重构

**Files:**
- Create: `apps/web/src/components/Drawer.tsx`
- Modify: `apps/web/src/pages/board/CandidateDrawer.tsx`

**Interfaces:**
- Produces: `export default function Drawer({ onClose, width?, children }: { onClose: () => void; width?: number; children: React.ReactNode })`——右侧滑入抽屉外壳，处理 Esc 关闭 + 遮罩点击关闭 + 滑入过渡动画。Task 3 的 `ProjectDrawer`/`TailorDrawer` 会复用它。
- Consumes: 无新依赖，纯前端组件。

- [ ] **Step 1: 创建 `Drawer.tsx`**

创建 `apps/web/src/components/Drawer.tsx`：

```tsx
import { useEffect, useState, type ReactNode } from 'react'

/** 通用右侧抽屉外壳：Esc/点遮罩关闭 + 滑入过渡。从 CandidateDrawer.tsx 抽出，ProjectDrawer/TailorDrawer 复用。 */
export default function Drawer({ onClose, width = 480, children }: { onClose: () => void; width?: number; children: ReactNode }) {
  const [entered, setEntered] = useState(false)
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [onClose])
  useEffect(() => { requestAnimationFrame(() => setEntered(true)) }, [])

  return (
    <div className="fixed inset-0 z-50 bg-black/40" onClick={onClose}>
      <div
        className={`absolute right-0 top-0 h-full w-full overflow-y-auto bg-paper border-l-2 border-ink p-5 shadow-xl transition-transform duration-200 ${entered ? 'translate-x-0' : 'translate-x-full'}`}
        style={{ maxWidth: width }}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  )
}
```

- [ ] **Step 2: 重构 `CandidateDrawer.tsx` 用它**

编辑 `apps/web/src/pages/board/CandidateDrawer.tsx`：

在文件顶部 import 区加一行：
```tsx
import Drawer from '../../components/Drawer'
```

删除这两个 effect（`entered` 状态和滑入动画的处理已经搬进 `Drawer` 组件）：
```tsx
  const [entered, setEntered] = useState(false)   // 滑入过渡
```
（这一行删除，同时删除下面这个 effect）
```tsx
  useEffect(() => { requestAnimationFrame(() => setEntered(true)) }, [])
```

保留 Esc 监听那个 `useEffect`（`Drawer` 组件内部也会注册一个 Esc 监听，两边都注册没问题，`onClose` 幂等，不会冲突；如果想干净一点可以把这个 effect 也删掉，因为 `Drawer` 已经处理——**删掉它**，避免重复监听）：
```tsx
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [onClose])
```

把 `return (...)` 里最外层的两层 `<div>`：
```tsx
    <div className="fixed inset-0 z-50 bg-black/40" onClick={onClose}>
      <div
        className={`absolute right-0 top-0 h-full w-full max-w-[480px] overflow-y-auto bg-paper border-l-2 border-ink p-5 shadow-xl transition-transform duration-200 ${entered ? 'translate-x-0' : 'translate-x-full'}`}
        onClick={(e) => e.stopPropagation()}>
        {/* ...原有内容... */}
      </div>
    </div>
```
换成：
```tsx
    <Drawer onClose={onClose}>
      {/* ...原有内容原样保留... */}
    </Drawer>
```

即：删掉外层两个 `<div>` 及其 `onClick`/`className`，改用 `<Drawer onClose={onClose}>` 包裹原来内层 `<div>` 里的全部 JSX 内容（从 `<div className="flex items-baseline gap-2 border-b border-hairline pb-2">` 开始到结尾），闭合标签从 `</div></div>` 改成 `</Drawer>`。

`useState`/`useEffect` 的 import 行不用动（`loading`/`error`/`res` 等其余 state 还在用）。

- [ ] **Step 3: 验证**

```bash
export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH"
cd /Users/lizhishaoniange/Documents/开源变现内容工厂
pnpm --filter web exec tsc --noEmit
```

预期无输出。然后浏览器打开找项目页，点一张候选卡片，确认抽屉照常从右侧滑入、Esc 能关、点遮罩能关、立项/收藏/重评按钮照常工作——行为跟改之前完全一样。

- [ ] **Step 4: 提交**

```bash
git add apps/web/src/components/Drawer.tsx apps/web/src/pages/board/CandidateDrawer.tsx
git commit -m "refactor(web): 抽出通用 Drawer 组件，CandidateDrawer 改用它（行为不变）"
```

---

### Task 3: 导航壳重写——去路由，顶部工位流水线 + 单页 tab 切换 + 详情抽屉

这是一个不可拆分的原子任务：以下文件必须一起改完才能编译通过（`App.tsx` 不再提供 `<Route>`，依赖它的文件如果不同步改掉 `useNavigate`/`useParams`/`useSearchParams` 就会在运行时报错或类型报错）。

**Files:**
- Modify: `apps/web/src/main.tsx`
- Modify: `apps/web/src/App.tsx`
- Delete: `apps/web/src/Sidebar.tsx`
- Create: `apps/web/src/Rail.tsx`
- Create: `apps/web/src/Topbar.tsx`
- Create: `apps/web/src/drawers/ProjectDrawer.tsx`
- Create: `apps/web/src/drawers/TailorDrawer.tsx`
- Delete: `apps/web/src/pages/ProjectDetailPage.tsx`
- Delete: `apps/web/src/pages/TailorDetailPage.tsx`
- Modify: `apps/web/src/pages/board/ProjectGroups.tsx`
- Modify: `apps/web/src/pages/TailorPage.tsx`
- Modify: `apps/web/src/pages/ScoutPage.tsx`
- Modify: `apps/web/src/pages/ReviewPage.tsx`
- Modify: `apps/web/src/pages/WorkshopPage.tsx`
- Modify: `apps/web/src/pages/MarketPage.tsx`
- Modify: `apps/web/src/pages/ScoutShellPage.tsx`
- Modify: `apps/web/package.json`

**Interfaces:**
- Produces: `App.tsx` 顶层管理 `activeSection: 'scout'|'projects'|'workshop'|'market'|'tailor'`、`selectedProjectSlug: string|null`、`selectedTailorId: number|null`、`settingsOpen`/`topicsOpen: boolean`，通过 props 往下传 `onOpenProject(slug)`/`onOpenTailor(id)` 回调。
- Consumes: Task 1 的 `.rail`/`.station` CSS 类；Task 2 的 `<Drawer>` 组件。

- [ ] **Step 1: `main.tsx` 去掉 `BrowserRouter`**

编辑 `apps/web/src/main.tsx`，删除 `import { BrowserRouter } from 'react-router-dom'` 这一行，把：
```tsx
      <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}><App /></BrowserRouter>
```
改成：
```tsx
      <App />
```

- [ ] **Step 2: 新建 `Rail.tsx`**

创建 `apps/web/src/Rail.tsx`：

```tsx
import { useQuery } from '@tanstack/react-query'
import { api, type Candidate, type Project, type TailorRequest } from './api'

export type SectionKey = 'scout' | 'projects' | 'workshop' | 'market' | 'tailor'

const STATIONS: Array<{ key: SectionKey; no: string; label: string }> = [
  { key: 'scout', no: '工位一', label: '找项目' },
  { key: 'projects', no: '工位二', label: '拆解' },
  { key: 'workshop', no: '工位三', label: '做内容' },
  { key: 'market', no: '工位四', label: '分发' },
]
const TAILOR_STATION = { key: 'tailor' as const, no: '按单', label: '定制' }

/** 顶部工位流水线导航：四工位 + 定制支线，单页 tab 切换（不占 URL）。计数用已有 query 就地算，算不出来的不显示。 */
export default function Rail({ active, onChange }: { active: SectionKey; onChange: (k: SectionKey) => void }) {
  const candidates = useQuery({ queryKey: ['candidates'], queryFn: () => api<Candidate[]>('/api/candidates') })
  const projects = useQuery({ queryKey: ['projects'], queryFn: () => api<Project[]>('/api/projects') })
  const tailor = useQuery({ queryKey: ['tailor'], queryFn: () => api<TailorRequest[]>('/api/tailor') })
  const inDecompose = (projects.data ?? []).filter((p) => p.stage === 'analysis' || p.stage === 'rebranding').length

  const count = (key: SectionKey): string | null => {
    if (key === 'scout') return candidates.data ? `候选 ${candidates.data.length}` : null
    if (key === 'projects') return projects.data ? `在制 ${inDecompose}` : null
    if (key === 'tailor') return tailor.data ? `需求 ${tailor.data.length}` : null
    return null
  }

  const station = (s: { key: SectionKey; no: string; label: string }, extraClass = '') => (
    <button key={s.key} className={`station ${extraClass}`} role="tab" aria-selected={active === s.key} onClick={() => onChange(s.key)}>
      <span className="no">{s.no}</span>
      <span className="nm">{s.label}{count(s.key) && <span className="ct">{count(s.key)}</span>}</span>
    </button>
  )

  return (
    <nav className="rail" role="tablist" aria-label="生产工位">
      {STATIONS.map((s) => station(s))}
      {station(TAILOR_STATION, 'spur')}
    </nav>
  )
}
```

- [ ] **Step 3: 新建 `Topbar.tsx`**

创建 `apps/web/src/Topbar.tsx`：

```tsx
import { useQuery } from '@tanstack/react-query'
import { api, type WeeklyReport } from './api'

const P0_TARGET_DAYS = 14
const P0_TARGET_LEADS = 5

function since14dAgo(): string {
  const d = new Date(Date.now() - P0_TARGET_DAYS * 86400_000)
  return d.toISOString().slice(0, 10)
}

/** 顶栏：品牌 + P0 状态条（近14天已发/询单，纯展示，不做达标判定业务逻辑）+ 设置/选题库入口 */
export default function Topbar({ onOpenSettings, onOpenTopics }: { onOpenSettings: () => void; onOpenTopics: () => void }) {
  const report = useQuery({ queryKey: ['report', 'p0'], queryFn: () => api<WeeklyReport>(`/api/report?since=${since14dAgo()}`) })
  const published = report.data?.totals.published ?? 0
  const leads = report.data?.totals.leads ?? 0

  return (
    <header className="flex items-baseline gap-3.5 px-7 pt-4">
      <div className="text-[1.35rem] font-black tracking-tight" style={{ fontFamily: '"Noto Serif SC", serif' }}>
        Forge<span className="text-fire">Cast</span>
        <span className="ml-2 text-sm font-normal text-faint">生产控制台</span>
      </div>
      <div className="flex-1" />
      <div className="text-[0.72rem] text-fire border border-fire rounded-[2px] bg-fire-soft px-2.5 py-0.5" style={{ fontFamily: '"JetBrains Mono", monospace' }}>
        近{P0_TARGET_DAYS}天已发 {published} 条 · 询单 {leads}/{P0_TARGET_LEADS}
      </div>
      <button className="btn-ink px-3 py-1 text-sm" onClick={onOpenTopics} title="选题库">📋 选题库</button>
      <button className="btn-ink px-3 py-1 text-sm" onClick={onOpenSettings} title="设置">⚙️ 设置</button>
    </header>
  )
}
```

- [ ] **Step 4: 新建 `drawers/ProjectDrawer.tsx`**

创建目录 `apps/web/src/drawers/`，新建 `apps/web/src/drawers/ProjectDrawer.tsx`：把 `apps/web/src/pages/ProjectDetailPage.tsx` 的**全部内容**复制过来，只改这几处：

1. 顶部 import 去掉 `useNavigate, useParams`（从 `react-router-dom` 的 import 整行删掉），加一行 `import Drawer from '../components/Drawer'`。
2. 函数签名从：
   ```tsx
   export default function ProjectDetailPage() {
     const { slug = '' } = useParams()
     const navigate = useNavigate()
   ```
   改成：
   ```tsx
   export default function ProjectDrawer({ slug, onClose }: { slug: string; onClose: () => void }) {
   ```
   （`navigate` 变量整个删掉，`slug` 直接是传入的 prop）
3. `del` mutation 的 `onSuccess` 里，把：
   ```tsx
       onSuccess: () => {
         qc.invalidateQueries({ queryKey: ['projects'] })
         navigate('/projects')
       },
   ```
   改成：
   ```tsx
       onSuccess: () => {
         qc.invalidateQueries({ queryKey: ['projects'] })
         onClose()
       },
   ```
4. `return` 语句最外层的 `<div className="grid grid-cols-[1fr_360px] gap-6">...</div>` 整个包一层 `<Drawer onClose={onClose} width={1100}>`，即：
   ```tsx
     return (
       <Drawer onClose={onClose} width={1100}>
         <div className="grid grid-cols-[1fr_360px] gap-6">
           {/* ...原有内容不变... */}
         </div>
       </Drawer>
     )
   ```
5. `if (!project.data) return <div className="text-faint">加载中…</div>` 这行保持在 `Drawer` 外面还是里面都行，为了让"加载中"文案也在抽屉里显示，改成：
   ```tsx
   if (!project.data) return <Drawer onClose={onClose}><div className="text-faint">加载中…</div></Drawer>
   ```

其余内容（`FIELDS`/`DOC_TABS`/所有 state/所有 mutation/JSX 内部结构）原样保留，一个字不改。

- [ ] **Step 5: 新建 `drawers/TailorDrawer.tsx`**

同理，新建 `apps/web/src/drawers/TailorDrawer.tsx`，把 `apps/web/src/pages/TailorDetailPage.tsx` 全部内容搬过来：

1. import 去掉 `useParams`（从 `react-router-dom`），加 `import Drawer from '../components/Drawer'`。
2. 函数签名从：
   ```tsx
   export default function TailorDetailPage() {
     const { id } = useParams()
   ```
   改成：
   ```tsx
   export default function TailorDrawer({ id, onClose }: { id: number; onClose: () => void }) {
   ```
3. `return` 语句最外层 `<div className="space-y-4">...</div>` 包一层 `<Drawer onClose={onClose} width={900}>`：
   ```tsx
     return (
       <Drawer onClose={onClose} width={900}>
         <div className="space-y-4">
           {/* ...原有内容不变... */}
         </div>
       </Drawer>
     )
   ```
4. `if (!d) return <div className="text-faint">{detail.isError ? '需求不存在' : '加载中…'}</div>` 改成：
   ```tsx
   if (!d) return <Drawer onClose={onClose}><div className="text-faint">{detail.isError ? '需求不存在' : '加载中…'}</div></Drawer>
   ```

`CapabilityCard` 组件（文件下半部分）原样保留，不改。

- [ ] **Step 6: 删除旧详情页文件**

```bash
git rm apps/web/src/pages/ProjectDetailPage.tsx apps/web/src/pages/TailorDetailPage.tsx
```

- [ ] **Step 7: `ProjectGroups.tsx` 改回调 prop**

编辑 `apps/web/src/pages/board/ProjectGroups.tsx`：

删除 `import { useNavigate } from 'react-router-dom'`。

函数签名从：
```tsx
export default function ProjectGroups({ projects, onMove, loaded }: {
  projects: Project[]; onMove: (slug: string, stage: string) => void; loaded?: boolean
}) {
  const navigate = useNavigate()
```
改成：
```tsx
export default function ProjectGroups({ projects, onMove, loaded, onOpenProject }: {
  projects: Project[]; onMove: (slug: string, stage: string) => void; loaded?: boolean
  onOpenProject: (slug: string) => void
}) {
```

把 `onClick={() => navigate(`/projects/${p.slug}`)}` 改成 `onClick={() => onOpenProject(p.slug)}`。

- [ ] **Step 8: `ProjectsPage.tsx` 透传 `onOpenProject`**

编辑 `apps/web/src/pages/ProjectsPage.tsx`：函数签名加 `onOpenProject` prop，透传给 `<ProjectGroups>`：

```tsx
export default function ProjectsPage({ onOpenProject }: { onOpenProject: (slug: string) => void }) {
  ...
      <ProjectGroups
        projects={projects.data ?? []}
        loaded={projects.isSuccess}
        onMove={(slug, stage) => moveStage.mutate({ slug, stage })}
        onOpenProject={onOpenProject}
      />
```

- [ ] **Step 9: `TailorPage.tsx` 改回调 prop**

编辑 `apps/web/src/pages/TailorPage.tsx`：

删除 `import { useNavigate } from 'react-router-dom'`。

函数签名从：
```tsx
export default function TailorPage() {
  const qc = useQueryClient()
  const navigate = useNavigate()
```
改成：
```tsx
export default function TailorPage({ onOpenTailor }: { onOpenTailor: (id: number) => void }) {
  const qc = useQueryClient()
```

`create` mutation 的 `onSuccess` 里 `navigate(`/tailor/${r.id}`)` 改成 `onOpenTailor(r.id)`。

列表项的 `onClick={() => navigate(`/tailor/${r.id}`)}` 改成 `onClick={() => onOpenTailor(r.id)}`。

- [ ] **Step 10: `ScoutPage.tsx` 改回调 prop**

编辑 `apps/web/src/pages/ScoutPage.tsx`：

删除 `import { useNavigate } from 'react-router-dom'`。

函数签名从 `export default function ScoutPage() {` 改成 `export default function ScoutPage({ onOpenProject }: { onOpenProject: (slug: string) => void }) {`，删掉 `const navigate = useNavigate()` 这行。

`pick` mutation 的 `onSuccess` 里：
```tsx
    onSuccess: ({ slug }) => {
      qc.invalidateQueries({ queryKey: ['candidates'] })
      qc.invalidateQueries({ queryKey: ['projects'] })
      navigate(`/projects/${slug}`)
    },
```
改成：
```tsx
    onSuccess: ({ slug }) => {
      qc.invalidateQueries({ queryKey: ['candidates'] })
      qc.invalidateQueries({ queryKey: ['projects'] })
      onOpenProject(slug)
    },
```

- [ ] **Step 11: `ScoutShellPage.tsx` 去 URL 依赖 + 透传 `onOpenProject`**

编辑 `apps/web/src/pages/ScoutShellPage.tsx`：

删除 `import { useSearchParams } from 'react-router-dom'`。

函数签名加 `onOpenProject` prop；`tab` 状态从 `useSearchParams` 改局部 `useState`：

```tsx
export default function ScoutShellPage({ onOpenProject }: { onOpenProject: (slug: string) => void }) {
  const [tab, setTab] = useState<TabKey>('pool')
```

`onClick={() => setSearchParams({ tab: t.key }, { replace: true })}` 改成 `onClick={() => setTab(t.key)}`。

`<ScoutPage />` 改成 `<ScoutPage onOpenProject={onOpenProject} />`。

`import { useState } from 'react'` 加到 import 区（原来没有，因为原来靠 `useSearchParams` 不需要）。`normalizeTab` 函数和 `TabKey` 类型定义可以删掉（不再需要从 URL 解析），直接用 `useState<TabKey>('pool')` 初始值代替。

- [ ] **Step 12: `WorkshopPage.tsx` 去 URL 依赖 + 加 `onOpenProject`**

编辑 `apps/web/src/pages/WorkshopPage.tsx`：

`import { Link, useSearchParams } from 'react-router-dom'` 整行删除。

函数签名加 `onOpenProject` prop；`tab` 状态从 `useSearchParams` 改局部 `useState`：

```tsx
export default function WorkshopPage({ onOpenProject }: { onOpenProject: (slug: string) => void }) {
  const qc = useQueryClient()
  const [tab, setTab] = useState<TabKey>('copy')
```

`setSearchParams`/`searchParams` 相关代码删除，`normalizeTab` 函数可删（不再需要）。

`{selected && <Link to={`/projects/${selected}`} className="text-xs text-fire">查看项目详情 →</Link>}` 改成：
```tsx
{selected && <button onClick={() => onOpenProject(selected)} className="text-xs text-fire">查看项目详情 →</button>}
```

- [ ] **Step 13: `MarketPage.tsx` 去 URL 依赖 + 透传 `onOpenTailor`**

编辑 `apps/web/src/pages/MarketPage.tsx`：完整替换为：

```tsx
import { useState } from 'react'
import CalendarPage from './CalendarPage'
import ReviewPage from './ReviewPage'

const TABS = [
  { key: 'calendar', label: '发布日历' },
  { key: 'review', label: '数据复盘' },
] as const
type TabKey = (typeof TABS)[number]['key']

export default function MarketPage({ onOpenTailor }: { onOpenTailor: (id: number) => void }) {
  const [tab, setTab] = useState<TabKey>('calendar')
  return (
    <div className="space-y-4">
      <div className="seg-tabs">
        {TABS.map((t) => (
          <button key={t.key} className={tab === t.key ? 'on' : ''} onClick={() => setTab(t.key)}>{t.label}</button>
        ))}
      </div>
      {tab === 'calendar' ? <CalendarPage /> : <ReviewPage onOpenTailor={onOpenTailor} />}
    </div>
  )
}
```

- [ ] **Step 14: `ReviewPage.tsx` 改回调 prop**

编辑 `apps/web/src/pages/ReviewPage.tsx`：

删除 `import { useNavigate } from 'react-router-dom'`。

函数签名从 `export default function ReviewPage() {` 改成 `export default function ReviewPage({ onOpenTailor }: { onOpenTailor: (id: number) => void }) {`，删掉 `const navigate = useNavigate()`。

`toTailor` 函数里：
```tsx
  async function toTailor(leadId: number) {
    try {
      const r = await api<{ id: number }>(`/api/leads/${leadId}/to-tailor`, { method: 'POST', body: '{}' })
      navigate(`/tailor/${r.id}`)
    } catch (e) { alert(`转入失败: ${e instanceof Error ? e.message : String(e)}`) }
  }
```
改成：
```tsx
  async function toTailor(leadId: number) {
    try {
      const r = await api<{ id: number }>(`/api/leads/${leadId}/to-tailor`, { method: 'POST', body: '{}' })
      onOpenTailor(r.id)
    } catch (e) { alert(`转入失败: ${e instanceof Error ? e.message : String(e)}`) }
  }
```

- [ ] **Step 15: 删除 `Sidebar.tsx`**

```bash
git rm apps/web/src/Sidebar.tsx
```

- [ ] **Step 16: 重写 `App.tsx`**

完整替换 `apps/web/src/App.tsx`：

```tsx
import { useState } from 'react'
import MarketPage from './pages/MarketPage'
import ProjectsPage from './pages/ProjectsPage'
import ScoutShellPage from './pages/ScoutShellPage'
import SettingsPage from './pages/SettingsPage'
import TailorPage from './pages/TailorPage'
import TopicsPage from './pages/TopicsPage'
import WorkshopPage from './pages/WorkshopPage'
import Drawer from './components/Drawer'
import ProjectDrawer from './drawers/ProjectDrawer'
import TailorDrawer from './drawers/TailorDrawer'
import Rail, { type SectionKey } from './Rail'
import Topbar from './Topbar'

export default function App() {
  const [activeSection, setActiveSection] = useState<SectionKey>('scout')
  const [selectedProjectSlug, setSelectedProjectSlug] = useState<string | null>(null)
  const [selectedTailorId, setSelectedTailorId] = useState<number | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [topicsOpen, setTopicsOpen] = useState(false)

  // 原路由行为：NavLink 到 /projects、/tailor 对 /projects/:slug、/tailor/:id 前缀匹配也会高亮——
  // 打开对应抽屉时一并切到该工位，保持"打开详情=进入该板块"的原有观感
  const openProject = (slug: string) => { setSelectedProjectSlug(slug); setActiveSection('projects') }
  const openTailor = (id: number) => { setSelectedTailorId(id); setActiveSection('tailor') }

  return (
    <div className="min-h-screen bg-paper text-ink">
      <Topbar onOpenSettings={() => setSettingsOpen(true)} onOpenTopics={() => setTopicsOpen(true)} />
      <div className="mt-4 px-7">
        <Rail active={activeSection} onChange={setActiveSection} />
      </div>
      <main className="p-7">
        {activeSection === 'scout' && <ScoutShellPage onOpenProject={openProject} />}
        {activeSection === 'projects' && <ProjectsPage onOpenProject={openProject} />}
        {activeSection === 'workshop' && <WorkshopPage onOpenProject={openProject} />}
        {activeSection === 'market' && <MarketPage onOpenTailor={openTailor} />}
        {activeSection === 'tailor' && <TailorPage onOpenTailor={openTailor} />}
      </main>

      {selectedProjectSlug && (
        <ProjectDrawer slug={selectedProjectSlug} onClose={() => setSelectedProjectSlug(null)} />
      )}
      {selectedTailorId != null && (
        <TailorDrawer id={selectedTailorId} onClose={() => setSelectedTailorId(null)} />
      )}
      {settingsOpen && (
        <Drawer onClose={() => setSettingsOpen(false)} width={720}>
          <SettingsPage />
        </Drawer>
      )}
      {topicsOpen && (
        <Drawer onClose={() => setTopicsOpen(false)} width={900}>
          <TopicsPage />
        </Drawer>
      )}
    </div>
  )
}
```

- [ ] **Step 17: 移除 `react-router-dom` 依赖**

```bash
export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH"
cd /Users/lizhishaoniange/Documents/开源变现内容工厂
grep -rln "react-router-dom" apps/web/src
```

预期：无输出（如果还有输出，说明上面某一步漏改，回去补）。确认无输出后：

```bash
cd apps/web
pnpm remove react-router-dom
cd /Users/lizhishaoniange/Documents/开源变现内容工厂
```

- [ ] **Step 18: 验证**

```bash
export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH"
cd /Users/lizhishaoniange/Documents/开源变现内容工厂
pnpm --filter web exec tsc --noEmit
```

预期无输出（0 错误）。

浏览器手动走一遍（Chrome 工具，`http://localhost:5173/`）：
1. 顶部能看到品牌+P0状态条+设置/选题库图标；下面是横向工位流水线（工位一~四 + 定制支线），点每个都能切换内容且不刷新页面、不改 URL。
2. 找项目工位：点候选卡片能开抽屉；抽屉里点"立项"，抽屉打开并自动切到"拆解"工位（`App.tsx` 的 `openProject` 回调里已经会 `setActiveSection('projects')`）。
3. 拆解工位：点项目卡片开抽屉，内容跟以前 `/projects/:slug` 页面一致；点"删除项目"确认后抽屉关闭。
4. 做内容工位：顶部"查看项目详情 →"能开抽屉。
5. 分发工位：数据复盘 tab 里"转入定制"能开定制抽屉。
6. 定制支线：点需求卡片开抽屉；录入新需求后自动打开新建的抽屉。
7. 设置图标：打开抽屉，顶部"保存"按钮可见（上次刚修过要还在）。
8. 选题库图标：打开抽屉，内容正常。
9. 刷新浏览器页面：回到默认"找项目"工位——这是预期行为（单页应用，放弃了 URL 深链），不是 bug。

- [ ] **Step 19: 提交**

```bash
git add -A
git commit -m "feat(web): 导航壳重构——去 react-router-dom，顶部工位流水线单页切换，详情页改抽屉"
```

---

### Task 4: 全量回归

**Files:** 无改动，纯验证

- [ ] **Step 1: 类型检查**

```bash
export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH"
cd /Users/lizhishaoniange/Documents/开源变现内容工厂
pnpm --filter web exec tsc --noEmit
```

预期：无输出。

- [ ] **Step 2: 后端测试不受影响确认**

```bash
pnpm test 2>&1 | grep -E "Test Files|Tests |FAIL"
```

预期：全绿，数量跟改动前一致（本计划没碰任何 `packages/*`，理论上一个测试都不会变）。

- [ ] **Step 3: 浏览器过一遍全部工位 + 两个抽屉 + 设置/选题库的截图**

用 Chrome 工具依次截图：`找项目`/`拆解`/`做内容`/`分发`/`定制` 五个工位主视图、`候选详情抽屉`、`项目详情抽屉`、`定制需求详情抽屉`、`设置抽屉`、`选题库抽屉`，确认：
- 视觉上是新的"生产控制台"风格（暖纸底、细描边、红色强调色），不是旧的"锻造车间"风格（粗黑边+硬阴影+橙色）
- 没有明显的布局错位/文字溢出/看起来像旧路由的残留提示

- [ ] **Step 4: 确认无遗留改动**

```bash
git status --porcelain
```

预期：干净（每个 Task 结束都已提交）。
