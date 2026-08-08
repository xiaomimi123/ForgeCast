# 全站「锻造车间」主题换皮 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把选定的「C · 锻造车间」风格（暖纸底/粗墨描边/硬阴影/炉火橙）落成 `apps/web` 全站视觉体系，纯换皮、结构逻辑零改动。

**Architecture:** `index.css` 用 Tailwind v4 `@theme` 注册 9 个颜色 token（生成 `bg-paper`/`text-ink`/`border-hairline` 等工具类）+ 4 个组件类（`.card-forge`/`.btn-fire`/`.btn-ink`/`.seg-tabs`）；然后按统一映射表逐页替换 className。找项目页卡片按 C 稿做小幅结构调整，其余页面布局不动。

**Tech Stack:** Tailwind CSS v4（现有）。无新依赖。

**Spec:** `docs/superpowers/specs/2026-08-09-forge-theme-design.md`
**设计稿参照:** `designs/forgecast-restyle/`（`direction-c.jsx` + `Style Directions.html` 中 `.vc-*` 样式段 = 视觉唯一事实来源）

## Global Constraints

- **Node 22**：任何 pnpm 命令前 `export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH"`。
- **纯换皮红线**：不改任何组件的 JSX 结构逻辑、props、hooks、事件处理（Task 2 找项目卡片的既定布局调整除外）；不动 `packages/*`；不动路由。
- web 无单测：每任务验证 = `pnpm --filter web exec tsc --noEmit` + `pnpm --filter web build`。
- 主题文案只限找项目页三处（NEW→今日入炉、买家/痛点→谁掏钱/为何掏、自动抓取行→进料）；其他页面文案一律不动。
- 日志面板（`bg-neutral-900 … text-green-400` 终端风）保持原样不换。
- commit message 末尾带 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`。

### 全局映射表（Task 2-4 共用，逐条对照替换）

| 旧写法 | 新写法 |
|---|---|
| 页面底 `bg-neutral-50` | `bg-paper` |
| 主卡片 `rounded-lg border bg-white`（或 rounded-xl） | `card-forge`（去掉原 border/bg/rounded/shadow 类） |
| 次级卡/泳道内小卡 `rounded border bg-white` | `rounded-lg border-[1.5px] border-ink bg-card shadow-[2px_2px_0_rgba(28,23,18,0.85)]` |
| 主按钮 `rounded bg-blue-600 … text-white` | `btn-fire px-4 py-2 text-sm`（保留原 padding/字号工具类，去掉 rounded/bg/text-white） |
| 次按钮 `rounded border px-… `（白底描边） | `btn-ink px-… text-sm`（小号动作按钮可用 `rounded-md border-[1.5px] border-ink bg-card`） |
| 链接/激活文字 `text-blue-600` | `text-fire` |
| 激活 chip `bg-blue-600 text-white`（圆胶囊） | `border-fire text-fire bg-fire-soft font-bold`（保留胶囊形状类） |
| 未激活 chip `border bg-white` | `border-[1.5px] border-hairline bg-transparent text-sub` |
| tab 组（圆胶囊组或下划线） | `seg-tabs` 结构：容器 `className="seg-tabs"`，每个 `<button>` 激活加 `on` |
| 徽章 `bg-blue-50 text-blue-700` / `bg-indigo-50 text-indigo-700` | `bg-fire-soft text-fire` |
| license 徽章 `bg-green-50 text-green-700` | 去徽章底色 → 纯文字 `text-sub`（C 稿 metas 风格） |
| 收藏激活 `text-amber-500/bg-amber-50/border-amber-400` | `text-fire bg-fire-soft border-fire` |
| 次级文字 `text-neutral-500/600` | `text-sub` |
| 弱文字 `text-neutral-400/300` | `text-faint` |
| 输入框 `rounded border` | `rounded-md border-[1.5px] border-ink bg-card` |
| 分隔线 `border-t` / `border-b`（灰） | 结构性分隔 `border-t-2 border-ink`；弱分隔 `border-t border-hairline` |
| 错误红 `text-red-*` | `text-danger` |

---

### Task 1: index.css 主题层 + App.tsx 导航壳

**Files:**
- Modify: `apps/web/src/index.css`（整文件替换）、`apps/web/src/App.tsx`（整文件替换）

**Interfaces:**
- Produces: 颜色工具类 `bg-paper/bg-card/text-ink/text-sub/text-faint/text-fire/text-danger/bg-fire-soft/border-ink/border-fire/border-hairline` 等（由 `@theme --color-*` 自动生成）；组件类 `.card-forge`/`.btn-fire`/`.btn-ink`/`.seg-tabs`（含 `.on` 激活态）。Task 2-4 全部依赖这些名字。

- [ ] **Step 1: 替换 index.css**

```css
@import "tailwindcss";

/* 「锻造车间」主题 token（spec 2026-08-09-forge-theme-design.md §1）
   @theme 注册后自动生成 bg-paper / text-ink / border-hairline 等工具类 */
@theme {
  --color-paper: #f7f2ea;
  --color-card: #fffdf8;
  --color-ink: #1c1712;
  --color-sub: #5f574c;
  --color-faint: #989083;
  --color-hairline: #cfc6b8;
  --color-fire: #d9481c;
  --color-fire-soft: #fbe9e2;
  --color-danger: #b91c1c;
}

/* 组件类：只此四个（卡片/主按钮/次按钮/分段 tab），其余一律工具类拼 */
.card-forge {
  background: var(--color-card);
  border: 2px solid var(--color-ink);
  border-radius: 10px;
  box-shadow: 4px 4px 0 rgba(28, 23, 18, 0.85);
}
.btn-fire {
  background: var(--color-fire);
  color: #fff;
  border: 2px solid var(--color-fire);
  border-radius: 6px;
  font-weight: 700;
  box-shadow: 3px 3px 0 rgba(28, 23, 18, 0.9);
}
.btn-fire:disabled { opacity: 0.5; box-shadow: none; }
.btn-ink {
  background: var(--color-card);
  color: var(--color-ink);
  border: 2px solid var(--color-ink);
  border-radius: 6px;
  font-weight: 600;
}
.btn-ink:disabled { opacity: 0.5; }
.seg-tabs {
  display: inline-flex;
  border: 2px solid var(--color-ink);
  border-radius: 8px;
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
  border-right: 2px solid var(--color-ink);
}
.seg-tabs > button:last-child { border-right: none; }
.seg-tabs > button.on { background: var(--color-ink); color: var(--color-paper); }
```

- [ ] **Step 2: 替换 App.tsx（导航壳按 C 稿）**

```tsx
import { Navigate, NavLink, Route, Routes } from 'react-router-dom'
import MarketPage from './pages/MarketPage'
import ProjectDetailPage from './pages/ProjectDetailPage'
import ProjectsPage from './pages/ProjectsPage'
import ScoutPage from './pages/ScoutPage'
import SettingsPage from './pages/SettingsPage'
import TailorPage from './pages/TailorPage'
import TailorDetailPage from './pages/TailorDetailPage'
import WorkshopPage from './pages/WorkshopPage'

/* 锻造车间导航：激活项 3px 炉火橙底边，文字加粗（C 稿 .vc-nav） */
const nav = ({ isActive }: { isActive: boolean }) =>
  `px-3 pb-[14px] pt-[17px] text-[13.5px] border-b-[3px] -mb-[2px] ${
    isActive ? 'font-bold text-ink border-fire' : 'text-sub border-transparent'
  }`

export default function App() {
  return (
    <div className="min-h-screen bg-paper text-ink">
      <header className="flex h-14 items-center gap-7 border-b-2 border-ink bg-paper px-6">
        <span className="text-[17px] font-black tracking-tight">
          Forge<span className="text-fire">Cast</span>
          <i className="ml-2 text-[10px] font-normal not-italic tracking-[2px] text-faint">开源变现内容工厂</i>
        </span>
        <nav className="flex self-stretch">
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
          <Route path="/tailor/:id" element={<TailorDetailPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/projects/:slug" element={<ProjectDetailPage />} />
          {/* 旧路由重定向：书签/肌肉记忆兼容 */}
          <Route path="/board" element={<Navigate to="/scout" replace />} />
          <Route path="/calendar" element={<Navigate to="/market?tab=calendar" replace />} />
          <Route path="/review" element={<Navigate to="/market?tab=review" replace />} />
        </Routes>
      </main>
    </div>
  )
}
```

（路由表与现文件逐字一致，只换了壳的 className 与 logo 结构。）

- [ ] **Step 3: 验证**

Run: `pnpm --filter web exec tsc --noEmit && pnpm --filter web build`
Expected: 均通过（此时其余页面仍是白卡蓝钮，落在纸底上——过渡态，后续任务逐页收敛）

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/index.css apps/web/src/App.tsx
git commit -m "feat(web): 锻造主题 token 层(@theme+四组件类) + 导航壳换皮"
```

---

### Task 2: 找项目页三件套（对齐 C 稿）

**Files:**
- Modify: `apps/web/src/pages/board/CandidateCard.tsx`（默认导出组件整体替换；`DIMS/Detail/parseDetail/Bar/num/str/Row/daysAgoText` 保留，`CAT_COLORS` 删除——锻造风不用彩色色块）、`apps/web/src/pages/board/CandidateDrawer.tsx`（按映射表换类）、`apps/web/src/pages/ScoutPage.tsx`（按映射表换类 + 三处主题文案）

**Interfaces:**
- Consumes: Task 1 全部 token/组件类
- Produces: CandidateCard props 不变（`{c, isNew, onOpenDetail, onToggleFavorite, favPending}`）——纯视觉替换，ScoutPage 调用点无需改

- [ ] **Step 1: CandidateCard 默认导出替换（C 稿 VcCard 的实现版）**

```tsx
export default function CandidateCard({ c, isNew, onOpenDetail, onToggleFavorite, favPending }: {
  c: Candidate; isNew: boolean
  onOpenDetail: (c: Candidate) => void
  onToggleFavorite: (c: Candidate) => void
  favPending: boolean
}) {
  const d = parseDetail(c.score_detail)
  const [owner, name] = c.repo.split('/')
  const empty = '未生成 — 详情里点「重新评分」'
  return (
    <div className="card-forge relative flex cursor-pointer flex-col gap-2.5 p-4"
      onClick={() => onOpenDetail(c)}>
      {isNew && (
        <div className="absolute -top-3 right-3 rounded bg-fire px-2.5 py-0.5 text-[10px] font-extrabold tracking-widest text-white shadow-[2px_2px_0_rgba(28,23,18,0.85)]">
          今日入炉
        </div>
      )}
      <div className="flex items-start">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[11px] text-faint">{owner} /</div>
          <div className="truncate text-lg font-black tracking-tight">{name}</div>
        </div>
        {d?.category && (
          <span className="ml-2 shrink-0 rounded border-[1.5px] border-ink px-1.5 py-0.5 text-[10px] font-extrabold tracking-[2px]">
            {d.category.split('/')[0]}
          </span>
        )}
      </div>
      <div className="line-clamp-2 min-h-[2.5rem] text-xs leading-relaxed text-sub">{c.description ?? ''}</div>
      <div className="flex items-baseline gap-1.5 border-t-2 border-ink pt-2">
        <span className="text-[26px] font-black tracking-tighter text-fire">{c.score ?? '—'}</span>
        <span className="text-[10px] font-bold tracking-[2px] text-faint">变现分</span>
        <span className="ml-auto text-[10.5px] text-faint">
          ⭐{num(c.stars).toLocaleString()} · {c.license ?? '无协议'}{daysAgoText(c.last_commit) ? ` · ${daysAgoText(c.last_commit)}` : ''}
        </span>
      </div>
      <div className="flex-1 space-y-0.5 text-[11px] text-sub">
        <div className="truncate"><em className="mr-2 font-extrabold not-italic text-ink">谁掏钱</em>{d?.targetBuyer || empty}</div>
        <div className="truncate"><em className="mr-2 font-extrabold not-italic text-ink">为何掏</em>{d?.painPoint || empty}</div>
      </div>
      <div className="flex gap-2" onClick={(e) => e.stopPropagation()}>
        <button disabled={favPending}
          className={`rounded-md border-[1.5px] px-2.5 py-1.5 text-xs font-semibold disabled:opacity-50 ${
            c.favorite ? 'border-fire bg-fire-soft text-fire' : 'border-ink bg-card text-ink'
          }`}
          onClick={() => onToggleFavorite(c)}>
          {c.favorite ? '★ 已收' : '☆ 收藏'}
        </button>
        <button className="flex-1 rounded-md border-[1.5px] border-ink bg-ink py-1.5 text-xs font-semibold text-paper"
          onClick={() => onOpenDetail(c)}>看详情</button>
        <a className="rounded-md border-[1.5px] border-ink bg-card px-2.5 py-1.5 text-xs font-semibold text-ink"
          href={c.url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>GitHub ↗</a>
      </div>
    </div>
  )
}
```

同文件顶部删除 `CAT_COLORS` 常量（已无引用）；`daysAgoText` 保留导出/内部函数不动。`Bar` 组件的进度条颜色 `bg-blue-500` 改 `bg-fire`、底槽 `bg-neutral-200` 改 `bg-hairline`（抽屉评分明细用）。

- [ ] **Step 2: ScoutPage 按映射表换类 + 三处文案**

逐处（读现文件对号替换，不动任何逻辑）：
1. 主按钮「抓取候选」→ `btn-fire px-4 py-2 text-sm`；「全部重新评分」「分类回填」→ `btn-ink px-4 py-2 text-sm`
2. 顶部自动抓取状态行文案：`每日 ${auto.time} 自动抓取 · 上次：${lastText}` → `每日 ${auto.time} 进料 · 上次：${lastText}`；关闭态 `'自动抓取已关（设置页可开）'` → `'每日进料已关（设置页可开）'`
3. 三 tab 圆胶囊组 → `seg-tabs`：容器 `<div className="seg-tabs">`，按钮 `className={tab === t.key ? 'on' : ''}`（去掉原胶囊类）
4. 分类 chips：激活 `bg-blue-600 text-white` → `border-fire bg-fire-soft font-bold text-fire`；未激活 `bg-white` → `border-[1.5px] border-hairline text-sub`（容器仍圆胶囊）
5. 空态/占位框 `rounded-lg border p-6 text-center text-neutral-400` → `rounded-lg border-2 border-dashed border-hairline p-6 text-center text-faint`
6. 每日新增分组标题 `text-neutral-600` → `text-ink font-bold`，计数 `text-neutral-400` → `text-faint`
7. 协议折叠区 `bg-neutral-50 text-neutral-500` → `bg-transparent border-[1.5px] border-hairline text-sub`
8. 其余 `text-neutral-500→text-sub`、`text-neutral-400→text-faint` 全量替换；日志面板类**原样不动**

- [ ] **Step 3: CandidateDrawer 按映射表换类**

逐处：面板 `bg-white` → `bg-paper border-l-2 border-ink`；头部 repo 链接 `text-blue-600` → `text-fire font-black`；license/分类徽章按映射表；「立项」`bg-blue-600` → `btn-fire px-4 py-1.5 text-sm`；「重新评分」→ `btn-ink px-3 py-1.5 text-sm`；收藏按钮激活 amber → fire 系；评分明细卡 `rounded-lg border bg-neutral-50` → `rounded-lg border-2 border-ink bg-card`，总分数字 `text-blue-700` → `text-fire font-black`；正文 neutral 系按映射表；「重新生成」按钮 → `btn-ink px-2 py-1 text-xs`。

- [ ] **Step 4: 验证 + Commit**

Run: `pnpm --filter web exec tsc --noEmit && pnpm --filter web build`
Expected: 均通过

```bash
git add apps/web/src/pages/ScoutPage.tsx apps/web/src/pages/board
git commit -m "feat(web): 找项目页三件套换锻造皮(卡片对齐C稿/抽屉/页面)"
```

---

### Task 3: 拆解需求 + 做内容换皮

**Files:**
- Modify: `apps/web/src/pages/ProjectsPage.tsx`、`apps/web/src/pages/board/StageLanes.tsx`、`apps/web/src/pages/WorkshopPage.tsx`、`apps/web/src/pages/ProjectDetailPage.tsx`、`apps/web/src/pages/CutPlanEditor.tsx`

**Interfaces:**
- Consumes: Task 1 token/组件类 + 全局映射表
- Produces: 无新接口（纯视觉）

- [ ] **Step 1: StageLanes**

泳道列 `rounded-lg border bg-neutral-50` → `rounded-lg border-[1.5px] border-hairline bg-transparent`；列头 `text-neutral-500` → `font-bold text-sub tracking-wide`；项目小卡 `rounded border bg-white shadow-sm hover:border-blue-400` → `rounded-lg border-[1.5px] border-ink bg-card shadow-[2px_2px_0_rgba(28,23,18,0.85)] hover:shadow-[3px_3px_0_rgba(217,72,28,0.9)]`；卡内 neutral 文字按映射表；空槽虚线 `border-dashed` → `border-dashed border-hairline text-faint`。

- [ ] **Step 2: WorkshopPage / ProjectDetailPage / CutPlanEditor**

先读各文件，逐处按全局映射表替换（卡片→`card-forge` 或次级卡、主按钮→`btn-fire`、次按钮→`btn-ink`、蓝激活→fire、neutral 文字→sub/faint、输入框→墨描边、tab 组→`seg-tabs`）。特别注意：
- markdown 渲染容器（ProjectDetailPage 的 analysisMd 区）容器换 `card-forge p-6`，内文排版类不动
- 视频/封面预览等媒体容器只换外框描边，不碰媒体元素
- CutPlanEditor 的节拍刻度条等功能性可视化元素配色不动（功能性表达优先），仅外壳与按钮换
- 任何 `subscribeTask` 日志面板原样

- [ ] **Step 3: 验证 + Commit**

Run: `pnpm --filter web exec tsc --noEmit && pnpm --filter web build`

```bash
git add apps/web/src/pages
git commit -m "feat(web): 拆解需求/做内容板块换锻造皮"
```

---

### Task 4: 分发营销 + 定制项目 + 设置换皮

**Files:**
- Modify: `apps/web/src/pages/MarketPage.tsx`、`apps/web/src/pages/CalendarPage.tsx`、`apps/web/src/pages/ReviewPage.tsx`、`apps/web/src/pages/TailorPage.tsx`、`apps/web/src/pages/TailorDetailPage.tsx`、`apps/web/src/pages/SettingsPage.tsx`

**Interfaces:**
- Consumes: Task 1 token/组件类 + 全局映射表

- [ ] **Step 1: MarketPage tab 壳**

两个 tab 按钮的圆胶囊组 → `seg-tabs` 结构（容器 + 按钮 `on` 激活）。

- [ ] **Step 2: CalendarPage / ReviewPage**

按映射表：白卡 → `card-forge p-4`；表格表头 `text-neutral-500` → `font-bold text-sub`；表格分隔 `border-t` → `border-t border-hairline`；提交/登记主按钮 → `btn-fire w-full py-1.5 text-sm`；「转定制」小按钮 → `rounded-md border-[1.5px] border-ink px-2 py-0.5 text-xs font-semibold`；输入框 → `rounded-md border-[1.5px] border-ink bg-card px-2 py-1 text-sm`。

- [ ] **Step 3: TailorPage / TailorDetailPage**

按映射表：需求卡片/录入表单卡 → `card-forge`；状态徽标 `rounded-full border` → `rounded border-[1.5px] border-ink px-2 py-0.5 text-[10px] font-extrabold tracking-widest`（对齐找项目分类 stamp）；三动作按钮（拆解/搜轮子/生成方案书）→ `btn-fire px-4 py-2 text-sm`；能力卡 → 次级卡样式；轮子候选 radio 卡选中 `border-blue-500 bg-blue-50` → `border-fire bg-fire-soft`；「标自研/不做/删除」小按钮 → `rounded-md border-[1.5px] border-ink px-2 py-1 text-xs`（删除按钮 `text-danger border-danger`）；方案书 markdown 容器 → `card-forge p-6`（内部排版类不动）；日志面板不动。

- [ ] **Step 4: SettingsPage**

分段卡 → `card-forge p-4`；保存/测试按钮 → 主保存 `btn-fire`、测试连接 `btn-ink`；输入框按映射表；黄条降级提示（mode_notes）保留黄色语义但描边化：`border-[1.5px] border-amber-600 bg-amber-50 text-amber-800`（功能性警示，允许保留琥珀色）。

- [ ] **Step 5: 验证 + Commit**

Run: `pnpm --filter web exec tsc --noEmit && pnpm --filter web build`

```bash
git add apps/web/src/pages
git commit -m "feat(web): 分发营销/定制项目/设置换锻造皮"
```

---

### Task 5: 全站终验 + README

**Files:**
- Modify: `README.md`（目录结构段 `designs/` 一行说明）

- [ ] **Step 1: 全量残留扫描**

Run: `grep -rn "blue-600\|blue-500\|blue-50\|blue-700\|indigo-\|amber-500\|amber-400\|amber-50\b\|neutral-500\|neutral-400\|neutral-300\|bg-neutral-50\|bg-white" apps/web/src --include="*.tsx" | grep -v "neutral-900\|green-400"`
Expected: 输出为空（日志面板的 neutral-900/green-400 已排除；SettingsPage 黄条的 amber-600/amber-800/amber-50 属于允许保留项，若命中则人工确认后放行）。有残留则逐条按映射表清掉。

- [ ] **Step 2: 全套验证**

Run: `pnpm --filter web exec tsc --noEmit && pnpm --filter web build && pnpm test`
Expected: 全部通过（后端零改动，全仓测试应原样绿）

- [ ] **Step 3: README 补一行**

目录结构段加：`designs/` 设计稿与视觉体系参照（当前主题：锻造车间，见 docs/superpowers/specs/2026-08-09-forge-theme-design.md）。

- [ ] **Step 4: 浏览器走查（控制者/用户）**

`pnpm dev` 下七页逐页对照 `designs/forgecast-restyle/Style Directions.html` 的 C 稿：导航壳、找项目（卡片/抽屉/tab/chips/今日入炉徽章）、拆解泳道、做内容、分发营销两 tab、定制列表+详情、设置。重点核对：残留蓝色、白底卡、灰胶囊 tab。

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "docs: README 补 designs 目录说明(锻造主题)"
```
