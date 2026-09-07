# 预设与品牌 kit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 图层样式预设 + 整版排版模板 + 项目品牌 kit——剪辑台调好的东西存下来跨视频/跨项目复用。

**Architecture:** editing 包出五个纯函数（角色推导/套样式/提取版式/套版式）；studio 出 `applyBrandKit` 挂 lower 收尾；core 建两张全局表 + projects 加 kit 列；server 薄 CRUD；web 在 Inspector/EditorPage/SettingsPage/出片参数四处开入口。预设=值快照非引用。

**Tech Stack:** better-sqlite3（既有 openDb 幂等迁移）、@forgecast/editing 纯函数、Hono routes、React。

**Spec:** `docs/superpowers/specs/2026-09-08-preset-brand-kit-design.md`

## Global Constraints

- `@forgecast/editing` 零 Node 依赖（守护测试）；纯函数、不可变、未变层返回原引用
- lower() 单向：套用只写图层 `style/effects`，语义层/时间轴（start/duration/track）不碰；`overridden` 置位
- ①②门禁红线：不套预设、kit 为空时既有 fixture 渲染零变化
- 预设=值快照：删/改预设不影响已出片；套用永远显式
- kit 不覆盖已手调层（`overridden:true` 的层 titleScale 等不作用）
- `apps/web` 无测试框架；验证 `tsc --noEmit`+浏览器自测（临时 workspace+独立 db）
- 测试同 shell：`export NVM_DIR="$HOME/.nvm" && source "$NVM_DIR/nvm.sh" && nvm use 22.23.2 && npx pnpm test`
- 用户 dev 服务 5173/4321 不碰；禁止 `pkill`/`killall`；提交不带 Co-Authored-By
- titleScale 合法域 0.5–2；色值须 `#rrggbb`；name 非空且同表唯一

---

### Task 1: editing 预设纯函数五件套

**Files:**
- Create: `packages/editing/src/preset-ops.ts`
- Modify: `packages/editing/src/index.ts`（`export * from './preset-ops'`）
- Test: `packages/editing/test/preset-ops.test.ts`

**Interfaces:**
- Consumes: `Layer/VideoSpec/LayerStyle/Effect` 类型（`import type ... from '@forgecast/studio'`，同 video-ops 姿势）
- Produces（后续任务逐字消费）:

```ts
export interface StylePresetPayload { style: Partial<LayerStyle>; effects: Effect[] }
export interface LayoutEntry { role: string; style: Partial<LayerStyle>; effects: Effect[] }

/** 角色键：cssClass 优先（'card'→'card#0','card#1'…按同键出现序），
 *  无 cssClass 时用 from（语义段 id），再无则 `manual-<kind>`；同键追加 #n。
 *  必须对整个 layers 数组一次算（序号取决于兄弟层）：*/
export function deriveLayerRoles(layers: Layer[]): Map<string, string>   // layerId → role

export function applyStylePreset(spec: VideoSpec, layerId: string, preset: StylePresetPayload, opts: { withPosition: boolean }): VideoSpec
export function applyStylePresetToKind(spec: VideoSpec, kind: Layer['kind'], preset: StylePresetPayload, opts: { withPosition: boolean }): VideoSpec
export function extractLayoutTemplate(spec: VideoSpec): LayoutEntry[]    // 跳过 kind==='video'
export function applyLayoutTemplate(spec: VideoSpec, entries: LayoutEntry[]): VideoSpec
```

语义细则：`applyStylePreset` 将 preset.style 合并进层 style（`withPosition:false` 时剔除 x/y 两键后再合并）、effects 整组替换、`overridden:true`；目标层不存在 throw（同 video-ops 报错风格）。`applyLayoutTemplate` 按 deriveLayerRoles 对位，命中层套 entry（style **全量合并含 x/y/width/fontSize**、effects 替换、overridden 置位），未命中层与多余 entry 均静默跳过；一个层都没命中返回原 spec 引用。`ToKind` 对零命中同样返回原引用。

- [ ] **Step 1: 写失败测试**（关键用例，其余同型自补）

```ts
import { applyLayoutTemplate, applyStylePreset, applyStylePresetToKind, deriveLayerRoles, extractLayoutTemplate } from '../src/preset-ops'
// fixture: 手搓含 cssClass:'card'×2、'cta'×1、caption(cap)×1、video×1、无cssClass手动text×1 的 spec

it('deriveLayerRoles: card 两层得 card#0/card#1，视频层也有角色但 extract 跳过', ...)
it('applyStylePreset withPosition:false 不写入 x/y（预设里有也剔除）', ...)
it('applyStylePreset effects 整组替换而非合并', ...)
it('applyStylePresetToKind 只动同 kind 层，其余层保持原引用', ...)
it('extractLayoutTemplate 跳过 video 层，条目带角色', ...)
it('applyLayoutTemplate 按角色对位：卡片数不同时多余层不动、多余条目忽略', ...)
it('applyLayoutTemplate 全未命中返回原 spec 引用', ...)
it('套用不碰 start/duration/track 与语义层', ...)  // 铁律断言
it('目标层不存在 throw', ...)
```

- [ ] **Step 2: 确认红** `cd packages/editing && npx vitest run test/preset-ops.test.ts`
- [ ] **Step 3: 实现 preset-ops.ts**（纯函数；deriveLayerRoles 一次遍历计数同键序号）
- [ ] **Step 4: 绿 + 变异两发**：(a) 角色序号错一位（`#n`→`#n+1`）→ 对位用例红；(b) withPosition:false 不剔除 x/y → 对应用例红。还原，整包绿（零 Node 守护含新文件）。
- [ ] **Step 5: Commit** `feat(editing): 预设纯函数——角色推导/套样式/提取套用版式`

### Task 2: studio applyBrandKit + lower 注入

**Files:**
- Create: `packages/studio/src/brand-kit.ts`
- Modify: `packages/studio/src/lower.ts`（lower() 收尾调用）、`packages/studio/src/videospec.ts` 或 core 导出 `BrandKit` 类型、`LowerOpts` 加 `brandKit?: BrandKit`
- Test: `packages/studio/test/brand-kit.test.ts`

**Interfaces:**
- Produces: `export interface BrandKit { primaryColor?: string; accentColor?: string; titleScale?: number; ctaText?: string }`；`export function applyBrandKit(spec: VideoSpec, kit: BrandKit): VideoSpec`（kit 空对象/全 undefined ⇒ 返回原 spec 引用）

语义：`primaryColor`→cssClass 含 'cta' 层的 color；`accentColor`→cssClass 'card'/'highlightCard' 层的 bg；`titleScale`→标题类层（cssClass 'painT'/'hookT'/'chat'?——以实际 lower 产出为准，实施时枚举六模板标题 cssClass 写成表）fontSize 乘数（基于该层现有 style.fontSize，无显式 fontSize 的层跳过——不猜模板 CSS 默认值）；`ctaText`→CTA 层文案替换（保留现有 brandName 第二行烧录逻辑：ctaText 只换第一行主文案）。**`overridden:true` 的层一律跳过**（kit 不覆盖手调）。

- [ ] **Step 1: 失败测试**：六模板 lower 产出各过一遍 applyBrandKit——kit 空=同引用（门禁）；各字段单独给值只动对应层；overridden 层不动；ctaText 不丢品牌名第二行。
- [ ] **Step 2: 红 → 实现 → 绿**；lower() 收尾 `if (opts.brandKit) spec = applyBrandKit(spec, opts.brandKit)` 前置于返回。
- [ ] **Step 3: studio 全包绿**（350+新增；既有 fixture 快照零变化）。
- [ ] **Step 4: Commit** `feat(studio): 品牌 kit 注入——lower 收尾统一套用`

### Task 3: core 迁移 + server CRUD

**Files:**
- Modify: `packages/core/src/db.ts`（两张新表 + `ensureColumn(db,'projects','brand_kit','TEXT')`）
- Create: `packages/server/src/preset-routes.ts`（挂进 app.ts）
- Test: `packages/server/test/presets.test.ts`

**Interfaces:**
- Produces 路由：
  - `GET /api/style-presets` → `[{id,name,layerKind,payload,createdAt}]`；`POST` body `{name,layerKind,payload}`（name 空/重复 400、layerKind 非四值 400、payload 非对象 400）；`DELETE /api/style-presets/:id`（不存在 404）
  - 同构三条 `/api/layout-templates`（多 `template`/`ratio` 字段，template 非六值 400）
  - `GET /api/projects/:slug/brand-kit` → kit JSON（无则 `{}`）；`PUT` 校验：色值 `/^#[0-9a-fA-F]{6}$/`、titleScale 0.5–2、ctaText ≤60 字符、未知键 400
- 建表 SQL：

```sql
CREATE TABLE IF NOT EXISTS style_presets (
  id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL, layer_kind TEXT NOT NULL,
  payload TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS layout_templates (
  id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL, template TEXT NOT NULL,
  ratio TEXT NOT NULL DEFAULT 'portrait', payload TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
```

- [ ] **Step 1: 路由正反测试先行**（每组：建→列→删；重名 400；畸形 payload 400；kit PUT 越界 400/合法 200 回读一致）
- [ ] **Step 2: 红 → 实现 → server 全包绿**（224+新增）
- [ ] **Step 3: 出片链路接线**：`/video` 路由 body 加可选 `layoutTemplateId`（number 校验；查无 404）；generate 完成 lower 后、渲染前 `applyLayoutTemplate`；`brand_kit` 列有值自动作为 `LowerOpts.brandKit` 传入。studio/server 相应测试补 stub 断言（模板套用生效、kit 自动注入）。
- [ ] **Step 4: Commit** `feat(core,server): 预设/版式/品牌kit 存储与 CRUD + 出片链路接线`

### Task 4: 剪辑台 UI——预设条 + 版式菜单 + 手动刷 kit

**Files:**
- Modify: `apps/web/src/pages/workshop/editor/InspectorPane.tsx`（样式组预设条）、`EditorPage.tsx`（工具栏「版式」菜单）、`apps/web/src/api.ts`（新端点封装）

要点：Inspector 预设条=同 kind 预设下拉+「套用」「套用到全部同类」+「存为预设…」（in-app 弹层：名字输入+「含位置」勾选，复用③的 Confirm/弹层姿势，不用 window.prompt）；下拉项尾部小 × 删除（in-app confirm）。EditorPage「版式」菜单：存为版式（当前 spec `extractLayoutTemplate` POST）/套用版式（列同 template+ratio 的，点击 `ed.apply(applyLayoutTemplate(...))`）/应用品牌 kit（GET kit → `ed.apply(applyBrandKit(spec,kit))`——applyBrandKit 从 `@forgecast/studio` 导入，web 已依赖该包类型；若打包边界不允许运行时导入则在 editing 重导出，实施时按现状取舍并记录）。busy/saving 禁用；每次套用=一步 undo。

- [ ] **Step 1: 读现场**（InspectorPane 样式组结构、EditorPage 工具栏、api.ts 封装风格、Confirm 姿势）
- [ ] **Step 2: 实现 + `npx tsc --noEmit` 干净**
- [ ] **Step 3: 浏览器自测**（临时 workspace+独立 db）：存样式预设→另一条视频同类层套用生效→「全部同类」批量→undo 一步回；存版式→另一条同模板视频套用（卡片数不同验对位策略）→undo；改 kit→手动刷生效、overridden 层不被覆盖
- [ ] **Step 4: Commit** `feat(web): 剪辑台预设条/版式菜单/手动品牌kit`

### Task 5: 设置页 kit 块 + 出片参数版式下拉

**Files:**
- Modify: `apps/web/src/pages/SettingsPage.tsx`（按项目 kit 编辑块：主色/强调色 color input+hex 文本、titleScale number 0.5–2 step0.1、ctaText 文本）、`apps/web/src/pages/WorkshopPage.tsx` 或出片参数所在组件（「排版模板」下拉，列同模板版式，选中把 `layoutTemplateId` 带进 `/video` body）、`apps/web/src/api.ts`

- [ ] **Step 1: 读现场**（SettingsPage 既有块结构、出片参数表单、VideoParams 类型）
- [ ] **Step 2: 实现 + tsc 干净**
- [ ] **Step 3: 浏览器自测**：kit 保存回读一致、非法色值被 400 且 UI 有提示；出片选版式→新片带版式出来（mock 渲染即可验 spec）
- [ ] **Step 4: Commit** `feat(web): 设置页品牌kit + 出片套版式`

### Task 6: 端到端真渲验收 + 文档

**Files:**
- Modify: `README.md`、spec 附「实现偏差」注记

- [ ] **Step 1: 真渲验收**（临时 workspace+独立 db、app.fetch、FORGECAST_VIDEO_MODE 真渲）：设 kit（主色 #ff3366+ctaText）→ 出一条 flash → 剪辑台调一张卡（挪位+改字号）→ 存版式 → 再出第二条不同内容同模板片带 `layoutTemplateId`+kit → 真渲抽帧验：卡片位置/字号与版式一致（±3px）、CTA 色=#ff3366、ctaText 上屏、品牌名第二行仍在；对照组（无 kit 无版式）与既有渲染逐帧等价
- [ ] **Step 2: 回归**：全仓 `npx pnpm test` 绿（已知 flake 单包重跑）
- [ ] **Step 3: 文档**：README 加「样式预设/排版模板/品牌 kit」段；spec 实现偏差注记
- [ ] **Step 4: Commit** `docs: 预设与品牌kit落地说明`

## Self-Review

- Spec 覆盖：§1 存储（T3）、§2 五纯函数+kit（T1/T2）、§3 UI 四入口+CRUD+出片（T3/T4/T5）、§4 测试（各任务+T6 端到端；kit 空=零变化在 T2；①②门禁 T2/T6）、§5 非目标未越界、§6 titleScale 只作用显式 fontSize+overridden 跳过（T2 语义已写死）。缺口：无。
- 占位符：无 TBD；T1 测试给关键用例列表（同型自补是明确指令而非占位）；T4/T5 UI 以要点+复用姿势指引（apps/web 无测试框架先例）。
- 类型一致性：`StylePresetPayload/LayoutEntry/BrandKit/deriveLayerRoles/applyStylePreset(ToKind)/extractLayoutTemplate/applyLayoutTemplate/applyBrandKit/layoutTemplateId` 各任务引用与定义一致。
