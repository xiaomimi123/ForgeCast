# ForgeCast「生产控制台」视觉基础 + 导航壳重构（子项目①）设计

> 日期：2026-08-28　状态：设计已确认，待实施
>
> 设计稿：`~/Desktop/ForgeCast-UI设计稿.html`（用户提供，静态 HTML mock）
>
> 这是全站重新设计的第一个子项目。整体拆成 4 个子项目：
> ① 视觉基础 + 导航壳（本 spec）
> ② 找项目页重做（含"利润款/引流款"双轨评分 + "热点雷达"趋势预警）—— 独立 spec，未开始
> ③ 拆解页重做（含"四关验收+盖章"QA 流程）—— 独立 spec，未开始
> ④ 做内容/分发/定制三页视觉套用 —— 独立 spec，未开始
>
> 本 spec **只覆盖①**：换视觉 token + 导航壳从"侧边栏+路由"改成"顶部工位流水线+单页 tab 切换"。五个工位内部的页面内容本身这次只换皮肤（新 token），不改数据/交互逻辑；②③设计稿里那些新概念（双轨评分表、热点雷达、四关验收灯）不在本次范围。

## 目标

1. 全站视觉从现有"锻造车间"主题（`docs/superpowers/specs/2026-08-09-forge-theme-design.md`，粗墨描边+硬阴影+炉火橙）换成设计稿的"生产控制台"主题（暖纸底+衬线/等宽混排+克制的红蓝绿琥珀四色语义+传送带流水线导航）。
2. 导航从左侧竖栏 + React Router 多路由，改成顶部横向"工位"单页 tab 切换（不占 URL），详情页从整页路由改成右侧抽屉。

## 非目标

- 不新增任何后端数据/接口（P0 状态条复用已有 `/api/report`，其余全部沿用现有 `useQuery`/`useMutation` 调用）。
- 不改找项目/拆解/做内容/分发/定制五个工位内部页面的数据结构、交互逻辑、组件拆分——只套新 token。
- 不做设计稿里的双轨评分表 / 热点雷达 / 四关验收灯（②③单独做）。
- 不改设置页、选题库页内部内容（只改它们从路由页面变成抽屉/浮层的容器形式）。

## 1. 视觉 Token（`apps/web/src/index.css`）

替换现有 `@theme` 色板 + 组件类。新增 Google Fonts 引入（`Noto Serif SC` 600/900、`Noto Sans SC` 400/500/700、`JetBrains Mono` 400/600/700）——在 `apps/web/index.html` 的 `<head>` 里加 `<link>`（不用 `@import` 进 CSS，避免阻塞渲染）。

```css
@theme {
  --color-paper: #F1F2EE; --color-card: #FAFAF8; --color-ink: #181A16;
  --color-sub: #6E7368; --color-faint: #9AA093;
  --color-hairline: #D9DBD2; --color-hairline-strong: #B9BCB0;
  --color-red: #C13A1B; --color-red-soft: #F5E4DE;
  --color-blue: #2C4A6E; --color-blue-soft: #E3E9F0;
  --color-green: #3E6B4F; --color-green-soft: #E4EDE6;
  --color-amber: #9A6B14; --color-amber-soft: #F4EBD8;
}
body {
  background-image: repeating-linear-gradient(0deg, transparent 0 31px, rgba(24,26,22,.028) 31px 32px);
}
```

字体：标题用 `font-family: "Noto Serif SC", serif`，正文沿用系统 `sans`（`Noto Sans SC` 只在需要衬线对照的地方显式声明，不整体替换正文字体栈，减少改动面），数字/标签类用 `font-family: "JetBrains Mono", monospace`。

组件类（沿用"只此几个自定义类，其余工具类拼"的既有约定，参照 `docs/superpowers/specs/2026-08-09-forge-theme-design.md` §1 组件类原则）：

| 类名 | 替代 | 说明 |
|---|---|---|
| `.card` | `.card-forge` | `1px solid var(--color-hairline)` + 4px 圆角，取消硬阴影 |
| `.btn` | `.btn-fire` | 墨底纸字，`hover` 变红底 |
| `.btn.ghost` | `.btn-ink` | 透明底墨字描边，`hover` 反色 |
| `.chip` | （新增） | `1px hairline` 描边胶囊，携带 4 个语义变体 `.chip.shell/.hosted/.pack/.veto` |
| `.stamp` | （新增） | 圆形红圈"验讫"图章，`.stamp.pending` 虚线灰变体 |
| `.eyebrow` | （新增） | mono 小字全大写标签，弱化色 |
| `.seg-tabs` | 保留 | 已有分段 tab 容器，改用新色板即可，结构不变 |

`.card-forge`/`.btn-fire`/`.btn-ink` 三个旧类名**保留兼容别名**（`.card-forge { ...同 .card }`），因为工位内部页面（找项目卡片、asset 卡片等）这次不逐处改类名，只在 `index.css` 里换实现——分两步：本 spec 先把 `.card-forge`/`.btn-fire`/`.btn-ink`/`.seg-tabs` 四个既有类的**实现**换成新视觉（颜色、描边、圆角、阴影），页面 JSX 里的类名暂不用全部替换成 `.card`/`.btn`，除非顺手改。新增的 `.chip`/`.stamp`/`.eyebrow` 三个类留给②③④用。

## 2. 导航壳（`App.tsx` 重写 + 新建 `Rail.tsx` 替换 `Sidebar.tsx`）

### 结构

```
<div class="app-shell">
  <Topbar />          {/* 品牌 + P0 状态条 + 设置/选题库图标 */}
  <Rail />            {/* 横向工位导航，控制 activeStation */}
  <main>{STATIONS[activeStation].render()}</main>
  <ProjectDrawer />   {/* 全局挂载，selectedSlug 非空时显示 */}
  <TailorDrawer />    {/* 全局挂载，selectedId 非空时显示 */}
  <SettingsOverlay /> {/* 全局挂载，settingsOpen 时显示 */}
  <TopicsOverlay />   {/* 全局挂载，topicsOpen 时显示 */}
</div>
```

`App.tsx` 不再用 `<BrowserRouter>`/`<Routes>`（`react-router-dom` 依赖整体移除——检查 `package.json` 里除 `App.tsx` 外还有没有别处用到 `useNavigate`/`Link`/`useSearchParams`，若有则那些页面这次跟着一起去掉路由依赖，改用 props/局部 state 传递，具体名单见下方任务清单）。

### 状态管理

```ts
type StationKey = 'scout' | 'projects' | 'workshop' | 'market' | 'tailor'
const [activeStation, setActiveStation] = useState<StationKey>('scout')
const [selectedProjectSlug, setSelectedProjectSlug] = useState<string | null>(null)
const [selectedTailorId, setSelectedTailorId] = useState<number | null>(null)
const [settingsOpen, setSettingsOpen] = useState(false)
const [topicsOpen, setTopicsOpen] = useState(false)
```

全部提升到 `App.tsx`（用 React Context 或直接 props 透传均可，五个工位组件不多，直接 props 透传更简单、不引入新概念）。

### 工位定义

```ts
const STATIONS: Array<{ key: StationKey; no: string; label: string; count: (data) => string }> = [
  { key: 'scout',     no: '工位一', label: '找项目' },
  { key: 'projects',  no: '工位二', label: '拆解' },
  { key: 'workshop',  no: '工位三', label: '做内容' },
  { key: 'market',    no: '工位四', label: '分发' },
]
// 定制作为 spur（支线），样式加 .station.spur，逻辑上跟其余四个平级，只是视觉区分
const TAILOR_STATION = { key: 'tailor', no: '按单', label: '定制' }
```

每个工位的计数文案（如"候选 128"/"在制 5 · 待验收 2"）：**这次不新增聚合接口**，直接在 `Rail` 组件里用已有的 `useQuery(['candidates'])`/`useQuery(['projects'])`/`useQuery(['tailor'])` 等现成查询算 `.length`，工位内部页面本来就在用这些 query key，`@tanstack/react-query` 的缓存会自动复用，不会重复请求。

### 详情抽屉

`ProjectDrawer`/`TailorDrawer` 仿照现有 `apps/web/src/pages/board/CandidateDrawer.tsx` 的既有抽屉模式（右侧滑入、`entered` 状态做过渡、点遮罩关闭）：

- `ProjectDrawer`：把现有 `ProjectDetailPage.tsx` 的内容原样搬进抽屉容器，`useParams()` 的 `slug` 改成 props 传入的 `selectedProjectSlug`。
- `TailorDrawer`：同理搬 `TailorDetailPage.tsx`，`id` 改 props。
- `ProjectGroups.tsx`/`TailorPage.tsx` 里原来的 `navigate('/projects/'+slug)`/`navigate('/tailor/'+id)` 改成调用传入的 `onOpenProject(slug)`/`onOpenTailor(id)` 回调（App.tsx 里就是 `setSelectedProjectSlug`/`setSelectedTailorId`）。

### 设置 / 选题库

`SettingsOverlay`/`TopicsOverlay`：同样是右侧抽屉（复用同一套抽屉外壳组件，做成通用 `<Drawer>` 组件而不是四个抽屉各写一遍滑入动画+遮罩逻辑），内部直接渲染现有 `SettingsPage`/`TopicsPage` 的内容（这两个页面组件本身不用大改，因为它们不依赖 `useParams`）。

顶栏图标按钮：⚙️ 设置、📋 选题库，点击各自 `setSettingsOpen(true)`/`setTopicsOpen(true)`。

### Topbar 状态条

```
ForgeCast 生产控制台          localhost:5173 · v1.4          P0 验证期 · 已发 {published}/{target} 条 · 询单 {leads}/{leadTarget}
```

数据来源：`/api/report` 默认按最近 7 天统计（`packages/ops/src/schedule.ts` 的 `weeklyReport` 函数 `since` 默认 `Date.now() - 7*DAY`），跟"两周"的 P0 口径对不上，需要显式传 14 天前的日期：`api<WeeklyReport>('/api/report?since=' + since14dAgoISODate)`，取返回的 `totals.published`/`totals.leads`。**注意**：`P0 通过线`（两周 ≥5 个合格询单）是设计稿里的新概念，当前真实代码库里完全不存在这个阈值（已 grep 确认 `apps/web/src` 全仓无 `P0` 字样）——这次只做**展示**，`target`/`leadTarget` 作为本次新增的纯前端常量写死在 `apps/web/src/constants.ts`（`export const P0_TARGET_DAYS = 14` / `export const P0_TARGET_LEADS = 5`），不接后端、不做真正的"达标判定"业务逻辑（那是产品决策，超出本子项目范围）。

## 3. 需要跟着调整的现有文件

已用 `grep -rln "react-router-dom" apps/web/src` 核实过完整引用清单（12 个文件），逐一列出改法，避免遗漏：

- `apps/web/src/main.tsx`：去掉 `<BrowserRouter>` 包裹。
- `apps/web/src/App.tsx`：重写，去 `<Routes>`，改成 §2 描述的 state 驱动单页结构。
- `apps/web/src/Sidebar.tsx` → 删除，新建 `apps/web/src/Rail.tsx` + `apps/web/src/Topbar.tsx`。
- `apps/web/src/components/Drawer.tsx`（新建）：通用抽屉外壳，从 `CandidateDrawer.tsx` 抽取滑入/遮罩逻辑。
- `apps/web/src/pages/board/CandidateDrawer.tsx`：改用通用 `<Drawer>` 包裹，逻辑不变。
- `apps/web/src/pages/ProjectDetailPage.tsx` → 内容搬到新建 `apps/web/src/drawers/ProjectDrawer.tsx`，原文件删除。
- `apps/web/src/pages/TailorDetailPage.tsx` → 内容搬到新建 `apps/web/src/drawers/TailorDrawer.tsx`，原文件删除。
- `apps/web/src/pages/board/ProjectGroups.tsx`：`navigate('/projects/'+slug)` 改成 `onOpenProject(slug)` 回调 prop。
- `apps/web/src/pages/TailorPage.tsx`：`navigate('/tailor/'+id)` 改成 `onOpenTailor(id)` 回调 prop（含创建成功后跳转、点列表项两处调用）。
- `apps/web/src/pages/ScoutPage.tsx`：`navigate('/projects/'+slug)`（立项成功后跳转）改成 `onOpenProject(slug)` 回调 prop——`ScoutPage` 现在由 `ScoutShellPage` 渲染，回调要从 `App.tsx` 一路透传：`App → ScoutShellPage → ScoutPage`。
- `apps/web/src/pages/ReviewPage.tsx`：`navigate('/tailor/'+id)` 改成 `onOpenTailor(id)` 回调 prop——透传链：`App → MarketPage → ReviewPage`。
- `apps/web/src/pages/WorkshopPage.tsx`：`<Link to={'/projects/'+selected}>` 改成 `<button onClick={() => onOpenProject(selected)}>`；内部"tpl 相关" tab 用 `useSearchParams` 记的状态改局部 `useState`。
- `apps/web/src/pages/MarketPage.tsx`：内部"日历/复盘" tab 的 `useSearchParams` 改局部 `useState`；`ReviewPage` 的 `onOpenTailor` 从这里继续往下传。
- `apps/web/src/pages/ScoutShellPage.tsx`：内部"项目池/需求信号" tab 的 `useSearchParams` 改局部 `useState`；`ScoutPage` 的 `onOpenProject` 从这里继续往下传。
- `apps/web/src/index.css`：换 token + 组件类实现。
- `apps/web/index.html`：加 Google Fonts `<link>`。
- `apps/web/package.json`：以上全部改完、确认 `grep -rln "react-router-dom" apps/web/src` 无结果后，移除 `react-router-dom` 依赖。

## 4. 验收标准

- `pnpm --filter web exec tsc --noEmit` 通过。
- 浏览器手动走一遍：五个工位横向 tab 能正常切换且不刷新页面；点候选卡片仍能开收藏/立项等原有操作；点项目卡片弹出项目详情抽屉，抽屉内容跟原 `/projects/:slug` 页面一致；点定制需求同理；设置/选题库图标能打开对应抽屉且内容功能不变（尤其是设置页顶部"保存"按钮要还在能看见的位置——上次刚修过这个）；刷新页面后回到默认工位（找项目），这是预期行为（不算 bug）。
- 视觉上过一遍亮色主题下的每个工位截图，跟设计稿的配色/字体/卡片描边风格比对无明显偏差（不要求像素级一致，找项目/拆解/做内容/分发/定制内部页面这次只换 token 不改布局，跟设计稿的具体页面布局本来就不会完全一样，这是预期的，②③④才会改布局）。
