# 做内容工位重构 P0（结构阶段）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 完成子项目③的 P0 结构阶段：ContentItem 聚合（一条内容一张卡）、7 tab→3 tab、工位条压面包屑、删除进 `⋯` 菜单、骨架/空/失败三态全量替换。

**Architecture:** 服务端新增 content-items 聚合视图（assets 三行聚一条、状态派生，库表零改动）；任务队列加可选 meta 支撑「渲染中/失败」派生；前端把 WorkshopPage 从 7 tab 重组为 剪辑台(过渡)/成片库/模板库 三视图，全部沿用现有无路由 state 切换模式。真剪辑台在 P1，本阶段剪辑台 tab 是现有能力的过渡装配。

**Tech Stack:** Hono + better-sqlite3（server）、React 18 + TanStack Query + Tailwind v4（web，无测试框架）、vitest（server/studio）

**Spec:** `docs/superpowers/specs/2026-09-03-content-station-editor-design.md`；视觉/交互规格权威：`docs/剪辑台-实施说明.md`（下称「实施说明」）

## Global Constraints

- **不动** 找项目/拆解/分发/定制 四个工位的内部实现（实施说明 §1）；不动 `lower()`、`hyperframes.ts` 既有行为、①②门禁（`equivalence.test.ts`、compositions 内容断言）。
- `apps/web` **无测试框架**（`"test": "echo 'web: 人工验收，无单测'"`），**不得新增**；可测逻辑一律放 server/studio 包。
- 色值/字号/控件高度**照实施说明 §3-§5 实测值**，不新造；组件里**不硬编码中文枚举**（展示映射常量表）。
- 一屏只有一个黑色实心按钮；状态标签不可点（实施说明 §7）。
- 本应用**无路由**：视图切换全走 state，不引入路由库（spec §5.1 修正）。
- 测试须 Node ≥22 且 nvm 与命令**同一次 shell 调用内**：`export NVM_DIR="$HOME/.nvm" && source "$NVM_DIR/nvm.sh" && nvm use 22.23.2 && npx pnpm test`。
- **禁止 `pkill`/`killall`**（用户 dev server 在 5173/4321）；自己起的进程按 PID 关。
- 提交信息不带 `Co-Authored-By` trailer。
- 已知无关既有报错：`packages/studio/test/hyperframes.test.ts:591` tsc 错误、`packages/rebrand/test/kill-port.test.ts` 偶发 flake。

## 文件结构

```
packages/studio/src/semantic.ts        改：buildSemantic opts 加 sourceAssetId
packages/studio/src/generate.ts        改：调用处传 assetId
packages/server/src/tasks.ts           改：enqueue 可选 meta + list()
packages/server/src/content-items.ts   新：聚合纯函数 + 类型
packages/server/src/app.ts             改：GET content-items 路由 + enqueue 调用点带 meta
apps/web/src/index.css                 改：--fc-* design tokens
apps/web/src/Topbar.tsx                改：并入工位面包屑（52px 单行）
apps/web/src/Rail.tsx                  删（并入 Topbar）
apps/web/src/App.tsx                   改：去掉 Rail 挂载
apps/web/src/api.ts                    改：ContentItem 类型 + 展示映射常量
apps/web/src/components/ui/States.tsx  新：Skeleton / Empty / Failure 三态
apps/web/src/components/ContentCard.tsx 新：一条内容一张卡（含 ⋯ 菜单）
apps/web/src/pages/WorkshopPage.tsx    改：3 tab 重构
apps/web/src/pages/workshop/EditorTransitionTab.tsx 新：剪辑台过渡页
apps/web/src/pages/workshop/LibraryTab.tsx          新：成片库
（CopyTab/UploadTab/VideoTab 的生成面板与审片逻辑被上述两个新 tab 吸收后删除；ScriptTab/CutPlanEditor/PreviewTab/TemplatesTab 保留被复用）
```

---

### Task 1: studio — 补 video→copy 链接（sourceAssetId 一直是 null 的既有缺陷）

**Files:**
- Modify: `packages/studio/src/semantic.ts`（`buildSemantic` opts、约 :126）
- Modify: `packages/studio/src/generate.ts:195`（调用处）
- Test: `packages/studio/test/semantic.test.ts`、`packages/studio/test/generate.test.ts`

**Interfaces:**
- Produces: `buildSemantic(doc, template, opts?: { cues?: Cue[]; brandName?: string; sourceAssetId?: number })` → `semantic.sourceAssetId` 为传入值（缺省仍 null）。Task 3 的聚合靠 spec JSON 里这个字段连 video↔copy。

- [ ] **Step 1: 写失败测试**

```ts
// packages/studio/test/semantic.test.ts 追加
it('opts.sourceAssetId 透传进 semantic（聚合视图靠它连 video↔copy）', () => {
  const s = buildSemantic(doc, 'flash', { sourceAssetId: 42 })
  expect(s.sourceAssetId).toBe(42)
})
it('不传 sourceAssetId 时保持 null（equivalence 基线兼容）', () => {
  expect(buildSemantic(doc, 'flash').sourceAssetId).toBeNull()
})
```

```ts
// packages/studio/test/generate.test.ts 追加（仿既有 stub 模式用例的建项目/建 copy asset 方式）
it('生成的 spec.semantic.sourceAssetId = 传入的文案 assetId', async () => {
  // 走既有测试的 generateVideo(ctx, slug, { assetId, tpl: 'flash' }) 路径后：
  const spec = JSON.parse(fs.readFileSync(path.join(ws, slug, 'specs', `${videoId}.json`), 'utf8'))
  expect(spec.semantic.sourceAssetId).toBe(assetId)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `export NVM_DIR="$HOME/.nvm" && source "$NVM_DIR/nvm.sh" && nvm use 22.23.2 && npx pnpm --filter @forgecast/studio test semantic generate`
Expected: 新用例 FAIL（sourceAssetId 为 null）

- [ ] **Step 3: 实现**

`semantic.ts`：opts 类型加 `sourceAssetId?: number`，返回处 `sourceAssetId: opts?.sourceAssetId ?? null`。
`generate.ts:195`：`buildSemantic(doc, tpl, { cues: voice.cues, brandName, sourceAssetId: 该函数已持有的文案 assetId })`（generateVideo 入参里就有）。

- [ ] **Step 4: 跑 studio 全量确认通过（equivalence.test.ts 必须仍绿——fixture 不传该字段，基线不变）**

Run: `export NVM_DIR="$HOME/.nvm" && source "$NVM_DIR/nvm.sh" && nvm use 22.23.2 && npx pnpm --filter @forgecast/studio test`
Expected: 全绿

- [ ] **Step 5: 提交** `git commit -m "fix(studio): 生成时落 sourceAssetId，补上 video→copy 的一直缺失的链接"`

---

### Task 2: server — 任务队列可选 meta + list()

**Files:**
- Modify: `packages/server/src/tasks.ts`
- Modify: `packages/server/src/app.ts`（`/copy` :213 与 `/video` :601 两个 enqueue 调用点带 meta；其余调用点不动）
- Test: `packages/server/test/tasks.test.ts`

**Interfaces:**
- Produces: `interface TaskMeta { kind: 'copy' | 'video'; slug: string; sourceAssetId?: number }`；`enqueue(fn, meta?: TaskMeta): string`；`TaskRecord` 加 `meta?: TaskMeta`；`list(): TaskRecord[]`（含 meta，供 Task 3 派生「渲染中/失败」）。
- 兼容：meta 可选，既有全部 `enqueue(fn)` 调用零改动。

- [ ] **Step 1: 写失败测试**

```ts
// packages/server/test/tasks.test.ts 追加
it('enqueue 可带 meta，list() 返回含 meta 的任务', async () => {
  const q = createTaskQueue()
  const id = q.enqueue(async () => 'ok', { kind: 'video', slug: 's1', sourceAssetId: 7 })
  await new Promise((r) => setTimeout(r, 10))
  const rec = q.list().find((t) => t.id === id)
  expect(rec?.meta).toEqual({ kind: 'video', slug: 's1', sourceAssetId: 7 })
  expect(rec?.status).toBe('done')
})
it('不带 meta 的既有调用不受影响', async () => {
  const q = createTaskQueue()
  const id = q.enqueue(async () => 'ok')
  expect(q.get(id)?.meta).toBeUndefined()
})
```

- [ ] **Step 2: 跑测试确认失败**（`npx pnpm --filter @forgecast/server test tasks`，同一 shell 带 nvm）
- [ ] **Step 3: 实现**——`tasks.ts`：`TaskRecord` 加 `meta?`；`enqueue(fn, meta?)` 建记录时存入；`list: () => [...tasks.values()]`。`app.ts` 两处：`queue.enqueue(fn, { kind: 'copy', slug })`、`queue.enqueue(fn, { kind: 'video', slug, sourceAssetId: body.assetId })`。
- [ ] **Step 4: 跑 server 全量确认通过**
- [ ] **Step 5: 提交** `git commit -m "feat(server): 任务队列可选 meta + list，为内容状态派生供数"`

---

### Task 3: server — ContentItem 聚合 + 状态派生（表驱动主闸）

**Files:**
- Create: `packages/server/src/content-items.ts`
- Modify: `packages/server/src/app.ts`（新路由，注册在 SPA `/*` 兜底**之前**——曾有路由注册在兜底之后 Docker 下全 404 的教训）
- Test: `packages/server/test/content-items.test.ts`

**Interfaces:**
- Consumes: Task 1 的 spec.semantic.sourceAssetId、Task 2 的 `queue.list()`
- Produces:

```ts
export type ContentStatus = 'script_ready' | 'rendering' | 'review' | 'approved' | 'failed'
export interface ContentItemView {
  id: number                     // = copy asset id
  seq: number                    // 项目内序号（copy 按 id 升序的第 N 条），显示成 #N
  hook: string | null            // 库内枚举原样返回，展示映射在前端
  status: ContentStatus
  title: string                  // 文案首个标题行，读不到回落文件名
  copyAssetId: number
  cover: { assetId: number; url: string } | null
  render: { assetId: number; url: string; specPath: string | null; version: number; status: string } | null
  progress: number | null        // rendering 时从任务日志「渲染 N%」解析；解析不到为 null
  error: string | null           // failed 时的任务 error 消息
  warnings: string[]
}
export function buildContentItems(input: {
  assets: AssetRow[]             // 该项目全部 assets 行（server 现有查询结果原样）
  readSpec: (specPath: string) => { semantic?: { sourceAssetId?: number | null } } | null
  tasks: TaskRecord[]            // queue.list()
  readTitle: (filePath: string) => string | null
  slug: string
}): ContentItemView[]
```

**聚合规则（实现者照此写，测试逐条钉）：**
1. 以 `type==='copy'` 的行为根，`seq` 按 id 升序编号。
2. cover 关联：**同名不同扩展名**——copy `pain-xxx-1-ab.md` ↔ cover `pain-xxx-1-ab.png`（生成代码用同一个 `${hook}-${stamp}-${i}-${rand}` 词干，见 `copywriter/generate.ts:93/105`）。
3. video 关联：`type==='video' && origin!=='upload'` 且 `readSpec(spec_path).semantic.sourceAssetId === copy.id`。多条取 **id 最大**（最新）为 `render`，`version` = 关联条数。spec_path 为 null 或 readSpec 失败的 video **不炸、不关联**（fail-soft）。
4. 状态派生优先级（高→低）：
   - queue 里有 `meta.kind==='video' && meta.sourceAssetId===copy.id` 且 `status==='running'|'pending'` → `rendering`
   - 同 meta 的最近任务 `status==='failed'` **且其后没有更新的关联 video asset** → `failed`（error = 该任务最后一条 error 事件 message）
   - 无关联 video → `script_ready`
   - 最新关联 video `status==='draft'` → `review`
   - 最新关联 video `status==='approved'|'published'` → `approved`
5. `progress`：rendering 时取该任务日志里最后一条匹配 `/(\d+)%/` 的数字，否则 null。
6. url 一律 `/files/<file_path>` 前缀（现有静态托管）。

- [ ] **Step 1: 写失败测试（表驱动主闸）**

```ts
// packages/server/test/content-items.test.ts（新文件；readSpec/readTitle 用内存函数注入，不碰磁盘）
import { describe, expect, it } from 'vitest'
import { buildContentItems } from '../src/content-items'

const copy = (id: number, fp = `s1/copy/pain-t-1-ab.md`) =>
  ({ id, type: 'copy', hook: 'pain', file_path: fp, status: 'draft', warnings: '[]' }) as never
const cover = (id: number, fp = `s1/covers/pain-t-1-ab.png`) =>
  ({ id, type: 'cover', hook: 'pain', file_path: fp, status: 'draft', warnings: '[]' }) as never
const video = (id: number, status = 'draft', specPath: string | null = `s1/specs/v${id}.json`) =>
  ({ id, type: 'video', origin: 'rendered', hook: 'pain', file_path: `s1/videos/v${id}.mp4`, status, warnings: '[]', spec_path: specPath }) as never
const linkSpec = (copyId: number) => () => ({ semantic: { sourceAssetId: copyId } })
const base = { readTitle: () => '标题一句话', slug: 's1', tasks: [] as never[] }

// 表驱动：〔场景 → 期望状态〕，正是仓库翻过四次车的那类映射，一张表收口
const CASES: Array<[string, Parameters<typeof buildContentItems>[0], string]> = [
  ['无 video', { ...base, assets: [copy(1)], readSpec: () => null }, 'script_ready'],
  ['渲染任务在跑', { ...base, assets: [copy(1)], readSpec: () => null,
    tasks: [{ id: 't', status: 'running', events: [{ ts: 1, type: 'log', message: '渲染 68%' }], meta: { kind: 'video', slug: 's1', sourceAssetId: 1 } } as never] }, 'rendering'],
  ['任务失败且无更新视频', { ...base, assets: [copy(1)], readSpec: () => null,
    tasks: [{ id: 't', status: 'failed', events: [{ ts: 1, type: 'error', message: '渲染崩了' }], meta: { kind: 'video', slug: 's1', sourceAssetId: 1 } } as never] }, 'failed'],
  ['video draft', { ...base, assets: [copy(1), video(9)], readSpec: linkSpec(1) }, 'review'],
  ['video approved', { ...base, assets: [copy(1), video(9, 'approved')], readSpec: linkSpec(1) }, 'approved'],
  ['失败后又渲成了新视频→按新视频算', { ...base, assets: [copy(1), video(9)], readSpec: linkSpec(1),
    tasks: [{ id: 't', status: 'failed', events: [], meta: { kind: 'video', slug: 's1', sourceAssetId: 1 } } as never] }, 'review'],
]
describe('状态派生（表驱动）', () => {
  it.each(CASES)('%s → %s', (_n, input, want) => {
    expect(buildContentItems(input)[0].status).toBe(want)
  })
})

describe('聚合', () => {
  it('cover 按同词干文件名关联', () => {
    const [item] = buildContentItems({ ...base, assets: [copy(1), cover(2)], readSpec: () => null })
    expect(item.cover?.assetId).toBe(2)
    expect(item.cover?.url).toBe('/files/s1/covers/pain-t-1-ab.png')
  })
  it('多条 video 取最新为 render，version=条数', () => {
    const [item] = buildContentItems({ ...base, assets: [copy(1), video(9), video(11)], readSpec: linkSpec(1) })
    expect(item.render?.assetId).toBe(11)
    expect(item.render?.version).toBe(2)
  })
  it('spec_path 为 null / readSpec 抛错 的 video 不关联也不炸', () => {
    const boom = () => { throw new Error('bad json') }
    const [item] = buildContentItems({ ...base, assets: [copy(1), video(9, 'draft', null), video(10)], readSpec: boom })
    expect(item.status).toBe('script_ready')
  })
  it('rendering 时 progress 取最后一个百分比', () => {
    const [item] = buildContentItems({ ...base, assets: [copy(1)], readSpec: () => null,
      tasks: [{ id: 't', status: 'running', events: [
        { ts: 1, type: 'log', message: '渲染 12%' }, { ts: 2, type: 'log', message: '渲染 68%' },
      ], meta: { kind: 'video', slug: 's1', sourceAssetId: 1 } } as never] })
    expect(item.progress).toBe(68)
  })
  it('upload 来源的 video 不进队列聚合（归成片库）', () => {
    const up = { ...video(9), origin: 'upload' } as never
    const [item] = buildContentItems({ ...base, assets: [copy(1), up], readSpec: linkSpec(1) })
    expect(item.status).toBe('script_ready')
  })
  it('seq 按 copy id 升序编号', () => {
    const items = buildContentItems({ ...base, assets: [copy(5), copy(3)], readSpec: () => null })
    expect(items.map((i) => [i.id, i.seq])).toEqual([[3, 1], [5, 2]])
  })
})
```

- [ ] **Step 2: 跑测试确认失败**（模块不存在）
- [ ] **Step 3: 实现 `content-items.ts` 纯函数**（照上面聚合规则；不 import db/fs——全部依赖注入，这是它可表驱动测试的前提）
- [ ] **Step 4: app.ts 接路由**

```ts
app.get('/api/projects/:slug/content-items', (c) => {
  const slug = c.req.param('slug')
  const project = getProject(ctx.db, slug)   // 仿既有 assets 路由的取法与 404
  if (!project) return c.json({ error: 'not found' }, 404)
  const assets = /* 既有 assets 查询语句原样 */
  return c.json(buildContentItems({
    assets, slug, tasks: queue.list(),
    readSpec: (p) => { try { return JSON.parse(fs.readFileSync(path.join(ctx.config.paths.workspace, p), 'utf8')) } catch { return null } },
    readTitle: (p) => { try { return fs.readFileSync(path.join(ctx.config.paths.workspace, p), 'utf8').split('\n').find((l) => l.trim())?.replace(/^#+\s*/, '').slice(0, 60) ?? null } catch { return null } },
  }))
})
```

加一条路由级测试（仿既有 `assets` 路由测试：建项目→插 copy 行→GET 返回一条 `script_ready`）。

- [ ] **Step 5: 跑 server 全量确认通过**
- [ ] **Step 6: 提交** `git commit -m "feat(server): ContentItem 聚合视图与状态派生，一条内容一个对象"`

---

### Task 4: web — design tokens + Header 压缩（工位条并入顶栏）

**Files:**
- Modify: `apps/web/src/index.css`（追加 `--fc-*` 变量）
- Modify: `apps/web/src/Topbar.tsx`（吸收 Rail 的工位切换，52px 单行）
- Modify: `apps/web/src/App.tsx`（Rail 挂载移除，active/onChange 传给 Topbar）
- Delete: `apps/web/src/Rail.tsx`

**Interfaces:**
- Consumes: `SectionKey` 类型（从 Rail.tsx 挪到 Topbar.tsx 导出，App.tsx 改 import 来源）
- Produces: `Topbar({ active, onChange, onOpenSettings, onOpenTopics })`

- [ ] **Step 1: index.css 追加 tokens**——实施说明 §3 的 `:root { --fc-* }` 整块**逐字复制**（面/墨/线/强调/画布/圆角全部变量）。追加在现有内容之后、不删既有类；现有类不强制改写为变量（P1 新组件用变量，存量渐进迁移）。
- [ ] **Step 2: Topbar 重构**——单行 52px：左 logo（现有 Noto Serif SC 规格不动）+ 工位面包屑（Rail 的 5 个入口压成文字链：`找项目 · 拆解 · 做内容 · 分发 · 定制`，当前项 `--fc-accent` 色 + 700 字重，其余 `--fc-muted`；计数徽章保留 Mono 小字）+ 右侧 P0 状态条/选题库/设置（现状保留）。Rail.tsx 的三个 useQuery 计数逻辑整体搬进 Topbar。
- [ ] **Step 3: App.tsx 去掉 `<Rail>` 与外层 mt-4 px-7 容器**，`<Topbar active={activeSection} onChange={setActiveSection} …/>`；删除 Rail.tsx。
- [ ] **Step 4: 构建检查** `export NVM_DIR="$HOME/.nvm" && source "$NVM_DIR/nvm.sh" && nvm use 22.23.2 && npx pnpm --filter web exec tsc --noEmit && npx pnpm --filter web build`（Expected: 通过；`grep -rn "from './Rail'" src` 零命中）
- [ ] **Step 5: 提交** `git commit -m "feat(web): design tokens 落地 + 工位条压成面包屑并入 Header"`

---

### Task 5: web — ContentCard + 三态组件 + 展示映射

**Files:**
- Create: `apps/web/src/components/ui/States.tsx`、`apps/web/src/components/ContentCard.tsx`
- Modify: `apps/web/src/api.ts`（`ContentItemView` 类型 + 映射常量）

**Interfaces:**
- Consumes: Task 3 的 `GET /api/projects/:slug/content-items` 返回形状
- Produces:
  - `HOOK_LABEL: Record<string,string>`（`{ pain:'行业痛点', sideline:'副业', infogap:'信息差', story:'接单故事', fun:'趣味' }`——**键用库内真实枚举**，见 CopyTab HOOKS，实施说明 §6 的 `side/gap` 是它不了解库内值，以库为准）、`STATUS_LABEL`（`{ script_ready:'待出片', rendering:'渲染中', review:'待审', approved:'已通过', failed:'失败' }`）
  - `<Skeleton lines={n} />`（占位条，`--fc-sunken` 底 + 脉动）、`<Empty why="…" action={<button/>} />`（说明为什么空 + 下一步按钮）、`<Failure step="…" error="…" onRetry={fn} />`（哪步失败 + 报错原文 + 重试实心红 + 「查看日志」展开 details）
  - `<ContentCard item onOpen onDelete onApprove />`：照实施说明 §5 QueueRow 规格——高 71（padding 7×2 + 缩略图 55）、缩略图 31×55（cover 有图用图，无图 `--fc-sunken` 占位）、编号 Mono 11/700 `#{seq}`、钩子 Mono 10 用 `HOOK_LABEL`、状态点 6×6、标题一行 12.5 截断、状态标签高 20 Mono 10 **不可点**（实施说明 §5 StatusTag 五态样式）、`rendering` 时显示 `渲染中 {progress}%`。右上 `⋯` 按钮开小菜单：唯一项「删除」红字 → `confirm('删除这条内容及其封面/视频素材？不可恢复')` 二次确认后回调 `onDelete`。卡上**不出现**裸删除按钮。
- [ ] **Step 1: 实现三件套**（本任务纯前端无单测，靠 Task 7 浏览器验收；写完 `tsc --noEmit` + `build` 必须过）
- [ ] **Step 2: 提交** `git commit -m "feat(web): ContentCard 与骨架/空态/失败态三态组件"`

---

### Task 6: web — WorkshopPage 三视图重构（剪辑台过渡 / 成片库 / 模板库）

**Files:**
- Modify: `apps/web/src/pages/WorkshopPage.tsx`
- Create: `apps/web/src/pages/workshop/EditorTransitionTab.tsx`、`apps/web/src/pages/workshop/LibraryTab.tsx`
- Delete: `apps/web/src/pages/workshop/CopyTab.tsx`、`UploadTab.tsx`、`VideoTab.tsx`（能力被吸收后删除；`VideoParams` 类型与参数面板挪进 EditorTransitionTab）

**Interfaces:**
- Consumes: Task 5 的 ContentCard/三态/映射、Task 3 的接口；现有 `ScriptTab`/`CutPlanEditor`/`PreviewTab`/`TemplatesTab`/`useTaskRun` 原样复用
- Produces: `TABS = [{key:'editor',label:'剪辑台'},{key:'library',label:'成片库'},{key:'templates',label:'模板库'}]`

**重组去处（照实施说明 §2 表格 + spec §6 P0 过渡说明）：**

| 旧 | 新 |
|---|---|
| 文案 tab 生成面板 + 文案/封面卡列表 | EditorTransitionTab 左栏：生成面板（钩子/篇数/生成按钮）+ **ContentCard 队列**（消费 content-items，替代 copy+cover 两张卡） |
| 出视频 tab 参数 + 渲染按钮 | EditorTransitionTab 右栏：VideoParams 面板 + 对选中 ContentItem「渲成片」（沿用 makeVideo，assetId = item.copyAssetId） |
| 预览 tab | EditorTransitionTab 中栏：PreviewTab 原样内嵌（Player） |
| 拍摄脚本 tab | EditorTransitionTab 底部折叠区 `<details><summary>拍摄脚本</summary><ScriptTab …/></details>`（P1 挪进分镜行） |
| 卡点 tab | EditorTransitionTab 底部折叠区 `<details><summary>卡点（旧版，P2 由时间轴接管）</summary><CutPlanEditor …/></details>` |
| 成片 tab（upload 审片） | LibraryTab：全部 video assets（rendered + upload）列表 + 现有 审片/通过/删除 动作（UploadTab 的 review 请求逻辑平移） |
| 模板库 tab | 原样 `<TemplatesTab/>` |

- [ ] **Step 1: 重构 WorkshopPage**——TABS 换三项；state（slug/hook/n/vp/两个 useTaskRun）保留在 WorkshopPage 下传；`content-items` 用 `useQuery({ queryKey: ['content-items', selected], refetchInterval: (q) => q.state.data?.some((i) => i.status==='rendering') ? 2000 : false })`（渲染中轮询进度，否则不轮询）。
- [ ] **Step 2: EditorTransitionTab**——三列 grid `320px 1fr 360px`（过渡版不追实施说明 §4 尺寸表，P1 才做正式骨架；但按钮层级守 §7：本 tab 唯一黑实心 = 「生成」或选中项的「渲成片」，二者同屏时「渲成片」降为描边——以选中态区分主次）。队列加载中 `<Skeleton lines={4}/>`、空 `<Empty why="这个项目还没有内容" action={生成按钮}/>`、接口错 `<Failure step="载入内容列表" …/>`；`failed` 状态的卡片下方内联 `<Failure step="渲染" error={item.error} onRetry={()=>makeVideo(item.copyAssetId)}/>`。
- [ ] **Step 3: LibraryTab**——video 列表卡（沿用现有 AssetCard 或平移 UploadTab 卡片结构）+ 审片动作平移；空态/失败态用三态组件。
- [ ] **Step 4: 删除 CopyTab/UploadTab/VideoTab**，`grep -rn "CopyTab\|UploadTab\|VideoTab" src` 零命中；`tsc --noEmit` + `build` 过。
- [ ] **Step 5: 提交** `git commit -m "feat(web): 做内容 7 tab 压 3 tab，剪辑台过渡装配 + 成片库"`

---

### Task 7: 浏览器人工验收 + 文档

**Files:**
- Modify: `README.md`（做内容板块描述：三视图结构）
- Test: 人工走查（apps/web 无测试框架，项目约定）

- [ ] **Step 1: 起服务**——自用端口（如 `PORT=4322` server + vite `--port 5174`），**绝不碰用户的 5173/4321**，记录自己的 PID，结束只关它们。
- [ ] **Step 2: 走查实施说明 §9 的 P0 四条**，逐条截图/记录：
  1. 做一条片子从选题到通过全程不换页（工位面包屑→剪辑台生成→渲染→成片库通过）
  2. 任意一屏黑色实心按钮只有一个
  3. 列表看不到 `draft`/`pain` 这类库内枚举（全走 HOOK_LABEL/STATUS_LABEL）
  4. 断网/接口报错显示可读失败态（DevTools offline 模拟一次），无破图无「加载中…」裸文案
- [ ] **Step 3: 回归**——找项目/拆解/分发/定制 四工位各点开一眼确认未被 Header 改动波及；全仓 `npx pnpm test` 绿。
- [ ] **Step 4: README 更新 + 提交** `git commit -m "docs: 做内容板块三视图结构说明（P0）"`

---

## 计划自查

**Spec 覆盖（P0 行）**：ContentItem 聚合接口→Task 3；列表合成一张卡→Task 5/6；7→3 tab + 过渡装配→Task 6；工位条压面包屑→Task 4；删除进 ⋯ 菜单→Task 5；三态替换→Task 5/6；成片库基础列表→Task 6；「看不到库内枚举」→Task 5 映射 + Task 7 验收。sourceAssetId 缺陷→Task 1（聚合的前置）。任务队列 meta→Task 2。
**占位符扫描**：无 TBD；web 任务给了结构与规格出处（实施说明章节号+具体数值），server 任务给了完整测试代码。
**类型一致性**：`ContentItemView`（Task 3 定义→Task 5 api.ts 复制→Task 6 消费）；`TaskMeta`（Task 2→Task 3）；`buildSemantic` opts（Task 1→Task 3 readSpec 消费其产物）。
**已知取舍**：P0 的 `rendering/failed` 派生依赖 server 内存任务队列，重启后退回静态派生（spec §9 已接受）；历史视频（sourceAssetId 为 null 的旧 spec）不关联到 ContentItem，只出现在成片库——Task 3 fail-soft 用例钉住不炸。
