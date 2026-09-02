# 做内容工位重构 P1（剪辑台本体）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 P0 的剪辑台过渡装配换成真剪辑台：三栏正式骨架 + 分镜列表改字即时可见 + 右栏参数暂存 + 时间轴（刻度/分镜/字幕轨）+ spec 读写/渲染/重置/重写端点 + `@forgecast/editing` 纯编辑包 + 会话内 undo。

**Architecture:** 服务端补 spec 的读写与操作端点（orig 快照重置、renderFromSpec 渲当前编辑态、rewrite-section 只换文本）；新包 `@forgecast/editing`（纯 TS 零 Node，承载全部可测编辑逻辑）；前端 `useEditorState` 持有内存 spec 作为唯一真相，Player 直接喂它（改动不保存也当帧可见），保存= PUT、渲成片=显式按钮走任务队列。

**Tech Stack:** Hono + better-sqlite3（server）、@forgecast/studio（lower/renderRemotion 复用）、React 18 + @remotion/player + TanStack Query + Tailwind v4（web 无测试框架）、vitest

**Spec:** `docs/superpowers/specs/2026-09-03-content-station-editor-design.md`（§4/§5/§10 为本阶段核心；§10 的三条 P1 修正**覆盖** §2/§3.3 的旧表述）；视觉/交互规格权威：`docs/剪辑台-实施说明.md`（§4 尺寸表、§5 组件、§7 硬规则）

## Global Constraints

- `apps/web` **无测试框架**（项目约定），不得新增；可测逻辑全放 `@forgecast/editing` / server / studio。
- **不动** `lower()` 的产出结构、`hyperframes.ts` 既有行为、①的 `equivalence.test.ts`、②的 compositions 门禁（编辑后的 spec 走同一个 SpecView，它们顺带守住剪辑台产出，红了=改到共享层，**绝不改基线**）。
- **不动**找项目/拆解/分发/定制四工位内部实现。
- `@forgecast/editing` 零 Node 依赖：对 `@forgecast/studio` 只能 `import type`；守卫测试用 ② 终审修过的完整正则（`node:[a-z_/]+` + 内置清单 + 动态 import/require）+ `dependencies` 精确白名单。
- LLM 能力铁律：**自带 mock 分支**，mock 不借道 `ctx.llm`（那返回文案 fixture）。
- 一屏只有一个黑实心按钮；状态标签不可点；右栏参数不即时生效（实施说明 §7）。
- 色值/尺寸用 `--fc-*` 变量（P0 已落），不写裸色值（实施说明明确给的裸值除外，如 hover 底 `#F5F6F1`）。
- 测试须 Node ≥22 且 nvm 与命令**同一次 shell 调用内**：`export NVM_DIR="$HOME/.nvm" && source "$NVM_DIR/nvm.sh" && nvm use 22.23.2 && npx pnpm test`。
- **禁止 `pkill`/`killall`**（用户 dev server 在 5173/4321）；自起进程按 PID 关。
- 提交信息不带 `Co-Authored-By` trailer。
- 已知无关既有报错：`packages/studio/test/hyperframes.test.ts:591` tsc 错误、`packages/rebrand/test/kill-port.test.ts` 偶发 flake。

## 文件结构

```
packages/server/src/spec-routes.ts     新：spec GET/PUT/render/reset/rewrite 五端点（注册须在 SPA /* 兜底前）
packages/server/src/app.ts             改：挂 spec-routes；content-items 路由真装配测试所需注入不变
packages/studio/src/generate.ts        改：renderAndRegister 同步落 orig 快照；导出 renderFromSpec
packages/studio/src/rewrite.ts         新：rewriteSection（mock/live 分支）
packages/editing/                      新包 @forgecast/editing（纯 TS 零 Node）
  src/{ops.ts,undo.ts,shots.ts,params.ts,index.ts}
  test/{no-node-deps,ops,undo,shots,params}.test.ts
apps/web/src/lib/rebase.ts             新：rebaseSpecForPreview 从 PreviewTab 抽出共享
apps/web/src/pages/workshop/editor/    新：EditorPage.tsx / useEditorState.ts / QueuePane.tsx /
                                        StagePane.tsx / ShotList.tsx / InspectorPane.tsx / TimelinePane.tsx
apps/web/src/pages/workshop/EditorTransitionTab.tsx  删（被 EditorPage 取代；生成面板/参数逻辑迁入）
apps/web/src/pages/WorkshopPage.tsx    改：剪辑台 tab 挂 EditorPage
apps/web/src/index.css                 改：删 .rail/.station 死代码（P0 挂账）
```

---

### Task 1: server — content-items 路由真装配测试（P0 终审点名的第一件事）

**Files:**
- Test: `packages/server/test/content-items-route.test.ts`（新）

**Interfaces:**
- Consumes: 既有 `GET /api/projects/:slug/content-items`（P0 产物，不改实现——本任务**只加测试**）

**背景：** P0 终审 M-5——纯函数层钉得很死（表驱动+变异全验过），但路由的三个真实注入（`abs()` 路径拼接、readTitle 正则、statVersion）零覆盖：把 `abs()` 或 readSpec 的 `JSON.parse` 改坏，13 包照样全绿。

- [ ] **Step 1: 写测试（真文件装配）**

仿 `packages/server/test/content-items.test.ts:139` 那条路由用例的建库方式（`createTestCtx`/建项目/插 assets 行——先读该文件确认 helper 名），但这次**真写文件**：

```ts
// packages/server/test/content-items-route.test.ts
// 真装配：workspace 里落真 copy.md / cover.png / spec.json，走真实的 abs()/readTitle/readSpec/statVersion 注入
it('真文件装配：cover.url 带 ?v=、render 关联、标题来自 md 首行', async () => {
  // 1) 建项目 slug='s1'，workspace 临时目录（mkdtemp）
  // 2) 写 workspace/s1/copy/pain-t-1-ab.md 内容 "# 真标题\n正文"
  // 3) 写 workspace/s1/covers/pain-t-1-ab.png（任意字节）
  // 4) 写 workspace/s1/specs/v1.json：{"semantic":{"sourceAssetId":<copyId>}}（最小形状）
  // 5) 插 assets 行：copy(指向 md)、cover(指向 png)、video(spec_path='s1/specs/v1.json')
  const res = await app.request('/api/projects/s1/content-items')
  expect(res.status).toBe(200)
  const [item] = await res.json()
  expect(item.title).toBe('真标题')                       // readTitle 的 ^#+\s* 正则真跑
  expect(item.cover.url).toMatch(/^\/files\/s1\/covers\/pain-t-1-ab\.png\?v=\d+$/)  // statVersion 真 stat
  expect(item.render.version).toBe(1)                     // readSpec 真 JSON.parse + 关联
  expect(item.status).toBe('review')
})
it('spec.json 是坏 JSON → 不炸、video 不关联（fail-soft 走真实 catch）', async () => {
  // 同上但 spec 文件写入 "not json"
  // 断言 200 且 item.status === 'script_ready'
})
```

- [ ] **Step 2: 跑测试确认当前实现通过**（这是回归护栏不是 TDD 新功能——若红说明发现了真 bug，报告并停）

Run: `export NVM_DIR="$HOME/.nvm" && source "$NVM_DIR/nvm.sh" && nvm use 22.23.2 && npx pnpm --filter @forgecast/server test content-items-route`

- [ ] **Step 3: 变异验证护栏有牙**——把 `app.ts` 路由里 `abs()` 的 `path.join` 第二参临时改成空串 → 本测试必须红 → 还原（`git diff` 确认干净）。结果进报告。
- [ ] **Step 4: server 全量绿后提交** `git commit -m "test(server): content-items 路由真装配护栏——接线层不再零覆盖"`

---

### Task 2: server+studio — spec GET/PUT + orig 快照 + reset 端点

**Files:**
- Create: `packages/server/src/spec-routes.ts`
- Modify: `packages/server/src/app.ts`（挂载，SPA `/*` 兜底**之前**）、`packages/studio/src/generate.ts`（renderAndRegister 落 orig 快照）
- Test: `packages/server/test/spec-routes.test.ts`、`packages/studio/test/generate.test.ts`（追加 orig 断言）

**Interfaces:**
- Produces:
  - `GET /api/projects/:slug/specs/:videoId` → VideoSpec JSON（404 if 不存在）
  - `PUT  同上`，body=完整 VideoSpec → 200 `{ok:true}` / 400 `{error}`
  - `POST 同上/reset` → 200 返回还原后的 spec / 404 `{error:'无生成快照（此视频生成于旧版本）'}`
  - videoId 校验 `/^[0-9a-f-]{8,64}$/i`（uuid 形状，防路径穿越——照 cutplan 的 bgmInside 先例思路）
  - PUT 校验（拒绝即 400 带具体原因）：`version===1`；`layers` 为数组且每层有 `id/kind/start/duration/track`；`start>=0 && duration>0`；**同 track 时间不重叠**（排序后相邻比较）；`videoId` 与路径参数一致
- generate 侧：`renderAndRegister` 写 `specs/<videoId>.json` 的同一处，**同步写** `specs/<videoId>.orig.json`（内容相同；只在文件不存在时写，重渲不覆盖 orig）

- [ ] **Step 1: 写失败测试**

```ts
// packages/server/test/spec-routes.test.ts（建库方式仿既有 server 测试）
const validSpec = { version: 1, videoId: 'v1', slug: 's1', template: 'flash', createdAt: '',
  semantic: { hook: null, sourceAssetId: null, sections: [] },
  canvas: { width: 1080, height: 1920 }, durationSec: 12,
  layers: [{ id: 'l1', kind: 'text', from: null, overridden: false, start: 0, duration: 3, track: 1,
    content: { kind: 'text', text: 'hi' }, style: {}, effects: [] }],
  audio: { narration: null, bgm: null, beatGrid: null, captionsEnabled: false }, warnings: [] }

it('GET 读盘上 spec；不存在 404', …)
it('PUT 合法 spec → 200 且文件内容更新', …)
it('PUT 同 track 重叠 → 400 提到「重叠」', () => {
  const bad = { ...validSpec, layers: [ …l1(start:0,dur:5,track:1), …l2(start:3,dur:5,track:1) ] }
  // 400 且 error 含 'track'
})
it('videoId 带 ../ → 400，不触盘', …)   // app.request('/api/projects/s1/specs/..%2Fx')
it('PUT 的 videoId 与路径不一致 → 400', …)
it('reset：有 orig → 还原并返回；无 orig → 404 带说明', …)
```

```ts
// packages/studio/test/generate.test.ts 追加
it('生成落盘 spec 的同时写 orig 快照，且内容一致', …)      // 读两个文件 JSON.parse 后 deepEqual
it('重复渲染不覆盖已有 orig', …)                            // 先手改 orig 再跑一次，orig 不变
```

- [ ] **Step 2: 跑测试确认失败**（模块/端点不存在）
- [ ] **Step 3: 实现**——`spec-routes.ts` 导出 `registerSpecRoutes(app, ctx, queue)`；app.ts 在 content-items 路由旁挂载。generate.ts 的 orig 写入放 `renderAndRegister` 写 spec 那两行旁边（`if (!fs.existsSync(origAbs)) fs.writeFileSync(origAbs, …)`）。
- [ ] **Step 4: server + studio 全量绿**（equivalence 仍绿）
- [ ] **Step 5: 提交** `git commit -m "feat(server): spec 读写端点 + orig 快照重置，剪辑台的保存与还原落地"`

---

### Task 3: studio — renderFromSpec + POST render 端点

**Files:**
- Modify: `packages/studio/src/generate.ts`（抽出并导出 `renderFromSpec`）、`packages/server/src/spec-routes.ts`
- Test: `packages/studio/test/render-from-spec.test.ts`、`packages/server/test/spec-routes.test.ts`（追加）

**Interfaces:**
- Produces: `renderFromSpec(ctx: CoreCtx, slug: string, videoId: string, onProgress: (m:string)=>void): Promise<GeneratedVideo>`：
  1. 读 `specs/<videoId>.json`（无 → throw 明确消息）；hfDir = `workspace/<slug>/hf/<videoId>`（无 → throw「素材目录缺失」）
  2. 从 `spec.audio` 重建 AudioMix：`bgm.src` 存在且文件在 → `{ bgmPath, beats: beatGrid.strongBeats, … }`（对照 `selectBgm` 返回的 AudioMix 字段逐个补齐——**先读 `generate.ts` 里 AudioMix 的真实形状**）；bgm 文件不在 → **fail-soft**：不混 BGM + `spec.warnings.push('BGM 文件缺失，本次无背景乐')`
  3. 复用现有 `renderAndRegister(ctx, hfDir, slug, spec.template, spec.semantic.hook, projectId, onProgress, spec, audioMix, { engine:'remotion', bgVariant: spec.bgVariant })`——产**新** video asset 行（version+1 的语义与 P0 聚合一致），orig 不动
- server：`POST /api/projects/:slug/specs/:videoId/render` → `queue.enqueue(fn, { kind:'video', slug, sourceAssetId: spec.semantic.sourceAssetId ?? undefined })` 返回 `{taskId}`（meta 让 P0 的「渲染中」派生直接生效）

- [ ] **Step 1: 写失败测试**（stub 模式，绝不 spawn 浏览器）

```ts
// packages/studio/test/render-from-spec.test.ts（建 ctx 仿 generate.test.ts）
it('stub 模式：从既有 spec 渲出占位 mp4 并登记新 asset（version 语义=新行）', …)
it('spec 不存在 → 抛错消息含 videoId', …)
it('hfDir 缺失 → 抛「素材目录」', …)
it('bgm.src 指向不存在文件 → 不炸，warnings 追加缺失说明', …)
it('渲染后 spec.semantic.sourceAssetId 原样保留（新 asset 仍关联同一 copy）', …)
```

server 侧追加：`POST render → 202/200 {taskId}`，任务完成后该项目多一条 video 行（stub）。

- [ ] **Step 2-4: 失败→实现→全量绿**（equivalence 仍绿）
- [ ] **Step 5: 提交** `git commit -m "feat(studio): renderFromSpec——渲当前编辑态而非重新生成，手工改动进成片"`

---

### Task 4: studio — rewriteSection（mock/live）+ POST rewrite-section 端点

**Files:**
- Create: `packages/studio/src/rewrite.ts`
- Modify: `packages/server/src/spec-routes.ts`、`packages/studio/src/index.ts`（导出）
- Test: `packages/studio/test/rewrite.test.ts`、`packages/server/test/spec-routes.test.ts`（追加）

**Interfaces:**
- Produces: `rewriteSection(ctx: CoreCtx, spec: VideoSpec, sectionId: string, instruction?: string): Promise<{ spec: VideoSpec; newText: string }>`（**纯变换不落盘**，落盘在端点层）
  - 定位 `semantic.sections` 里的 section；**只支持** `text` 型段（有 `text` 字段且无 dialogue/stat/shots）；且 `layers` 中 `from===sectionId && content.kind==='text'` 的图层**恰好一层**——否则 throw `RewriteUnsupportedError`（端点映射 400）
  - mock 分支（`ctx.config.llm.mode==='mock'`）：**不走 ctx.llm**，返回确定性变体 `` `${原文}（重写版）` ``；live 分支：`ctx.llm.complete({ model: ctx.config.llm.models.copy, system: 重写指令, prompt: 原文+instruction })`，空响应 throw
  - 返回的 spec：section.text 与该图层 `content.text` 换新、图层 `overridden` 保持原值；`spec.warnings` push `'「<sectionId>」已重写，旁白仍为旧文案，语音与画面文案可能不一致'`
- 端点：`POST …/rewrite-section` body `{ sectionId, instruction?, force? }`
  - 目标图层 `overridden===true` 且无 `force` → **409** `{ error:'该段有手工改动', affected:[layerId…] }`（前端确认后带 force 重发）
  - 成功 → 落盘 spec 并返回 `{ spec, newText }`

- [ ] **Step 1: 写失败测试**

```ts
// packages/studio/test/rewrite.test.ts
it('mock：text 段重写返回确定性变体，图层 text 同步、时间轴一字不动', …)   // 断言 start/duration/track 全等
it('mock 不借道 ctx.llm（spy ctx.llm.complete 零调用）', …)               // 铁律
it('dialogue/stat/shots 段 → RewriteUnsupportedError', …)
it('from 该段的文本图层不止一层 → RewriteUnsupportedError', …)
it('warnings 追加旁白不一致提示', …)
it('overridden 图层的标志位不被清掉', …)
```

server 侧：409 分支（带 affected）、force 通过、400（不支持段）、落盘验证。

- [ ] **Step 2-4: 失败→实现→全量绿**
- [ ] **Step 5: 提交** `git commit -m "feat(studio): rewriteSection——LLM 重写某段只换文本图层，mock 全链路可测"`

---

### Task 5: `@forgecast/editing` 新包——编辑纯函数 + undo + Shot 派生

**Files:**
- Create: `packages/editing/{package.json,tsconfig.json,vitest.config.ts}`、`src/{index.ts,ops.ts,undo.ts,shots.ts,params.ts}`
- Test: `packages/editing/test/{no-node-deps,ops,undo,shots,params}.test.ts`

**Interfaces:**
- 包配置照抄 `packages/compositions`（`"main":"src/index.ts"`、type module、vitest jsdom 不需要——**environment: 'node' 即可**，纯逻辑无 DOM）；`dependencies` **精确白名单：空**（React 都不要）；devDependencies 含 `@forgecast/studio: workspace:*`（只 `import type`）+ vitest + typescript
- Produces（Task 6-9 消费，签名固定）：

```ts
// ops.ts —— 全部纯函数：入参 spec 不可变，返回新 spec
export function updateLayerText(spec: VideoSpec, layerId: string, text: string): VideoSpec
  // content.kind 为 text/caption 才生效；同时置 overridden: true
export function setLayerStyle(spec: VideoSpec, layerId: string, patch: Partial<LayerStyle>): VideoSpec
export function toggleEffect(spec: VideoSpec, layerId: string, type: Effect['type'], on: boolean): VideoSpec
  // on=加（无重复）/off=删；固定类型集之外 throw
export function moveLayer(spec: VideoSpec, layerId: string, newStart: number): VideoSpec
  // 钳制：0 <= start 且 start+duration <= durationSec；同 track 相邻图层不重叠（夹在前后邻居之间，
  //       撞邻居则贴住邻居边缘——CutPlanEditor 的 nudge 钳制同思路）
export function resizeLayer(spec: VideoSpec, layerId: string, newDuration: number): VideoSpec
  // 钳制：>= 0.2s；不越右邻居左缘；不越 durationSec
export function snapStart(spec: VideoSpec, layerId: string, rawStart: number, thresholdSec: number): number
  // 读 spec.audio.beatGrid（t0+n·T 网格外推），|raw-beat|<=threshold 吸到拍点，否则原值；无 beatGrid 原值
// shots.ts
export interface ShotView { sectionId: string; role: string; text: string; startSec: number; endSec: number; layerIds: string[]; rewritable: boolean }
export function deriveShots(spec: VideoSpec): ShotView[]
  // 按 semantic.sections 顺序；每段聚 from===sectionId 的图层（min start / max end）；无图层的段跳过；
  // rewritable = text 段且文本图层恰一层（与 Task 4 的支持判定同一逻辑——从这里导出给 studio 复用可选，最少保持两处判定一致有测试钉）
// undo.ts
export interface History { past: VideoSpec[]; present: VideoSpec; future: VideoSpec[] }
export function init(spec: VideoSpec): History
export function push(h: History, next: VideoSpec, cap?: number): History   // cap 默认 50，超出丢最旧
export function undo(h: History): History    // past 空则原样返回
export function redo(h: History): History
// params.ts
export function paramsDiff(saved: VideoSpec, draft: { bgVariant?: string; bgmSrc?: string | null; mood?: string | null }): Array<{ key: string; from: unknown; to: unknown }>
  // 「改动 N 项」的数据源；只比 §10 可改集三项
```

- [ ] **Step 1: 脚手架 + no-node-deps 守卫**——守卫测试整体照抄 `packages/compositions/test/no-node-deps.test.ts` **当前版**（②终审修过的：`node:[a-z_/]+`、内置清单、动态 import、require、dependencies 白名单——白名单此处为**空数组**），路径与包名替换。跑一次确认绿。
- [ ] **Step 2: 写失败测试**（每个函数至少：正常路径 / 钳制边界 / 不可变性 `expect(spec).not.toBe(result)` 且原对象未变）。重点用例：
  - moveLayer 撞左/右邻居各一条、越 0 与越 durationSec 各一条、不同 track 互不钳制一条
  - snapStart 网格外推（beat 超出 strongBeats 数组仍按 t0+n·T 吸附）、阈值外原值、无 beatGrid 原值
  - undo 序列：init→push×3→undo×2→redo→push（future 清空）；cap 丢最旧
  - deriveShots：顺序=sections 顺序、时间=min/max、rewritable 判定三态（text 单层 true / dialogue false / text 双层 false）
- [ ] **Step 3: 跑确认失败 → 实现 → 全绿**
- [ ] **Step 4: 变异实验（不可跳过）**——①删 moveLayer 的邻居钳制 → 撞邻居用例必须红；②snapStart 阈值判断反转 → 阈值外用例红；③undo 的 future 清空去掉 → 序列用例红。各还原并 `git diff` 确认干净，证据进报告。
- [ ] **Step 5: 根 `pnpm-workspace.yaml` 无需改（packages/* 通配）；全仓测试绿后提交** `git commit -m "feat(editing): 纯编辑包——钳制/吸附/undo/Shot 派生，变异实验证明有牙"`

---

### Task 6: web — rebase 抽共享 + EditorPage 骨架 + useEditorState

**Files:**
- Create: `apps/web/src/lib/rebase.ts`、`apps/web/src/pages/workshop/editor/EditorPage.tsx`、`editor/useEditorState.ts`
- Modify: `apps/web/src/pages/workshop/PreviewTab.tsx`（改 import 共享 rebase）、`apps/web/src/pages/WorkshopPage.tsx`（剪辑台 tab 挂 EditorPage）、`apps/web/src/index.css`（删 `.rail/.station` 死代码 :132-174，P0 挂账）
- Delete: `apps/web/src/pages/workshop/EditorTransitionTab.tsx`（生成面板/参数控件/HOOKS 迁入 editor/ 下各组件）

**Interfaces:**
- `rebase.ts`：把 `rebaseSpecForPreview` 从 PreviewTab **原样搬出**（一字不改），两处消费（PreviewTab + useEditorState）
- `useEditorState(slug, videoId)` 返回：

```ts
{
  spec: VideoSpec | null           // 内存真相（History.present）
  loading: boolean; loadError: string | null
  dirty: boolean                   // 与最后一次保存的快照比（JSON.stringify 相等即可）
  apply(next: VideoSpec): void     // 所有编辑操作经此进 undo 栈（editing.push）
  undo(): void; redo(): void; canUndo: boolean; canRedo: boolean
  save(): Promise<void>            // PUT spec；成功后更新 saved 快照
  resetToOrig(): Promise<void>     // POST reset；确认弹窗在调用方
  previewSpec: VideoSpec | null    // rebaseSpecForPreview(spec)——喂 Player 的
}
```

- `EditorPage({ slug, assets, contentItems, … })`：三栏骨架照实施说明 §4 尺寸表——队列 300 固定 / Stage 1fr(min 620)：toolbar 46 + preview mat 300 固定 + shot script 1fr / Inspector 320；Timeline 186 固定；grid 模板 `grid-template-columns: 300px minmax(620px,1fr) 320px` + 底部整宽 Timeline 行。**⚠ 轨道名列与轨道行都 `box-sizing:border-box`**（实施说明 §4 的警告原文）。窄屏分档本期只做 `<1240 右栏收抽屉`（toolbar 出「参数」按钮），其余 P2。
- 选中内容：来自 WorkshopPage 的 `selectedItemId`（P0 已有）→ `item.render?.specPath` 有值才进编辑态；无 spec（待出片/自定义模板）→ 中栏显示引导空态（「先渲一版才能进剪辑台」+ 渲成片按钮 / custom 显示「自定义模板暂不支持剪辑」）。
- Player：`<Player component={SpecComposition} inputProps={{ spec: previewSpec }} durationInFrames={secToFrames(spec.durationSec)} fps={FPS} compositionWidth={spec.canvas.width} compositionHeight={spec.canvas.height} controls style={{width:'100%'}} />`（`FPS/secToFrames` 从 `@forgecast/compositions` 导入——P0 已有先例）；`playerRef` 挂 `frameupdate` 监听把当前秒写进 state 供 Timeline 播放头（Task 9 消费）。
- 键盘：`Ctrl/Cmd+Z` undo、`Shift+Ctrl/Cmd+Z` redo、`Ctrl/Cmd+S` save（preventDefault）；输入框聚焦时 undo/redo 不抢（`e.target` 是 input/textarea 则跳过）。
- toolbar（§5 规格）：左=标题+StatusTag+`v{version}`；右=`打回重做`(描边，回 script_ready 视角即关闭编辑态)+`通过并送分发`(实心，调 P0 成片库同款 PATCH approved)+`⋯`；dirty 时标题旁小圆点+「未保存」。**一屏唯一实心=「通过并送分发」**；保存按钮为描边（或只靠 Ctrl+S+自动提示）。

- [ ] **Step 1: rebase 抽出**（PreviewTab 改 import，行为零变化）→ `tsc --noEmit` 过
- [ ] **Step 2: useEditorState + EditorPage 骨架**（三栏空壳 + Player + toolbar + 键盘 + 载入/保存/undo 接线）
- [ ] **Step 3: WorkshopPage 换挂 + 删 EditorTransitionTab + 删 index.css 死代码**；`grep -rn "EditorTransitionTab" apps/web/src` 零命中
- [ ] **Step 4: 构建 + 浏览器自验**（自用端口 4322/5174，按 PID 关，禁 pkill）：载入 spec、改不了东西也先验 undo 快捷键不报错、保存 PUT 成功、脏标记出现与消失、无 spec 项引导空态
- [ ] **Step 5: 提交** `git commit -m "feat(web): 剪辑台三栏骨架 + useEditorState 单一真相 + 保存/撤销"`

---

### Task 7: web — QueuePane + 生成入口迁移

**Files:**
- Create: `apps/web/src/pages/workshop/editor/QueuePane.tsx`
- Modify: `editor/EditorPage.tsx`（装配）

**Interfaces:**
- 照实施说明 §4 队列列：工具条 42（左「+ 新内容」描边按钮开一个内联生成面板 popover——钩子四选+篇数+生成，即 P0 生成面板的迁移；HOOKS 常量随迁）/ 钩子筛选 40（chip 组，筛 `item.hook`）/ 列表 1fr overflow-y auto，行间 1px 分隔线
- 复用 P0 `ContentCard`（含 ⋯ 菜单/重生封面/删除），selected 与 EditorPage 联动；`approved` 项 opacity .62 不消失（组件已支持）
- 三态沿用 P0（Skeleton/Empty/Failure）
- **实心按钮纪律**：生成按钮在 popover 内可为实心（popover 打开时视作该屏主操作，toolbar 的「通过并送分发」被遮挡外区域——若同屏可见则生成降描边，以简单规则「popover 内实心、页面上描边」实现）

- [ ] **Step 1: 实现 + 装配**；Step 2: 构建 + 浏览器自验（筛选生效、生成→新卡出现、选中联动中栏）；Step 3: 提交 `git commit -m "feat(web): 剪辑台队列列——生成入口与钩子筛选迁入"`

---

### Task 8: web — ShotList 分镜列表：改字即时可见 + LLM 重写

**Files:**
- Create: `apps/web/src/pages/workshop/editor/ShotList.tsx`
- Modify: `editor/EditorPage.tsx`（装配进 Stage 下半区）

**Interfaces:**
- Consumes: `deriveShots(spec)`（Task 5）、`updateLayerText`（Task 5）、`POST …/rewrite-section`（Task 4）
- ShotRow 照实施说明 §5：collapsed（底 `--fc-bg`、1px 线、padding 9/11）/ active（底白、左 3px accent、padding 11、展开操作条）。行首时间码 Mono（`startSec→mm:ss.s`）
- active 行：文本变 `<textarea>`（autosize 简版：rows 按行数），**onBlur 或 Cmd+Enter** → `apply(updateLayerText(spec, layerIds[0], value))` → Player 当帧可见（无请求——①1.2 的裁决）。多图层段只读展示 + 提示「结构化内容，暂不支持直接编辑」
- 操作条按钮：`重写这段`（`shot.rewritable` 才可用；点击 → POST rewrite-section → 409 时 `confirm('该段含手工改动，重写将覆盖：<affected>。继续？')` 后带 force 重发 → 成功后**整包替换** `apply(res.spec)` 并提示旁白不一致 warning）/ `换画面素材`、`加卡点` 两个按钮**置灰** + title「P2」（实施说明操作条位置先占住，不实现）
- 选中联动：点 ShotRow → seekTo(startSec)（playerRef）+ Timeline 选中（Task 9）

- [ ] **Step 1: 实现 + 装配**；Step 2: 构建 + 浏览器自验：改字失焦 → Player 画面文字立变（**亲眼验并截图说明**，这是「改字即改画面」的交付时刻）；mock 模式点重写 → 文本变「…（重写版）」+ warning 提示；Step 3: 提交 `git commit -m "feat(web): 分镜列表改字即时可见 + LLM 重写接线"`

---

### Task 9: web — InspectorPane 暂存 + TimelinePane 三轨

**Files:**
- Create: `editor/InspectorPane.tsx`、`editor/TimelinePane.tsx`
- Modify: `editor/EditorPage.tsx`（装配）

**Interfaces（Inspector）:**
- 两个分区：**图层检查器**（有选中图层时）——全量 LayerStyle 控件（x/y/w/h/fontSize 数字输入、color/bg 色板、align 三选、opacity 滑块）经 `apply(setLayerStyle(…))` **即时生效**（这是画面编辑不是渲染参数，不受暂存规则约束）+ 特效开关组（固定类型集 checkbox，`toggleEffect`）；**渲染参数**（§10 拆档）——可改 `{bg 变体下拉, bgm 选曲, mood}` 走**暂存**：本地 draft state + 表头「改动 N 项」（`paramsDiff`）+ 标签前 4×4 accent 圆点（改过的项）+ 底部整宽 34px「用新参数重渲」→ 把 draft 并进 spec → `save()` → `POST …/render`；只读 `{tpl, ratio, captions}` 灰显 + 「重新生成才可改」。Field 规格照 §5：标签 Mono 12 宽 38、控件高 28
- **§7 规则 3 验收点**：改 5 个参数期间 network 面板零请求，点「用新参数重渲」才发（PUT+POST 各一）

**Interfaces（Timeline，照实施说明 §4/§5）:**
- 总高 186：头 32（左时间码显示当前播放位置 Mono）+ 轨道区：轨道名列 104 固定（刻度/分镜/字幕）+ 轨道行 刻度 20 / 分镜 46 / 字幕 30（BGM/卡点 P2）。**box-sizing 警告落实**
- 刻度轨：每秒一格短线、每 5s 长线+数字；播放头 accent 竖线贯穿三轨（读 EditorPage 的当前秒 state），点击刻度/轨道空白 → seekTo
- 分镜轨：`deriveShots` 的 Clip，`flex: <时长×10> 1 0`（实施说明 §5——不用百分比），高 38；`default/current(accent 描边+tint 底)/dragging(虚线+时间码)`。**拖拽**：中间拖=移动（`snapStart`→`moveLayer` 应用到该 shot 的全部 layerIds，保持相对偏移——组内每层同 delta，钳制取组内最紧约束；简化实现：对 shot 的每个 layer 依次 moveLayer(start+delta)，任一被钳制则整组用被钳后的最小 delta 重算一次）、边缘拖=改时长（`resizeLayer` 应用到组内 max-end 的那层）。拖拽中实时 `apply`，`onDragEnd` 收进一次 undo 步（拖拽期间 apply 用「替换 present 不 push」的变体——给 useEditorState 加 `applyTransient(next)` + `commit()`）
- 字幕轨：caption 图层的细条（只显示+点击 seekTo，P1 不拖——字幕时间来自 TTS cues，拖了就与语音错位；title 提示「字幕跟随旁白，不可拖」）

- [ ] **Step 1: Inspector 实现**；**Step 2: Timeline 实现**（`applyTransient/commit` 先加进 useEditorState）；Step 3: 构建 + 浏览器自验：
  - 拖 Clip 撞邻居被钳、靠近拍点被吸（有 beatGrid 的视频）、Ctrl+Z 一步回整个拖拽
  - 改 5 参数零请求 → 点重渲发 2 个请求（network 面板截图说明）
  - 1440/1280/1100 三宽度时间轴轨道名列与轨道行不错位（±0px，实施说明 §9 硬验收）
- [ ] **Step 4: 提交** `git commit -m "feat(web): 参数暂存检查器 + 时间轴三轨拖拽吸附"`

---

### Task 10: 端到端验收 + 文档

**Files:**
- Modify: `README.md`、`docs/superpowers/specs/2026-09-03-content-station-editor-design.md`（如实记录实现偏差，若有）
- Test: 人工走查 + 一次真渲

- [ ] **Step 1: P1 核心验收——编辑进成片**：真渲模式下选一条有 spec 的视频 → 剪辑台改一处文字 + 挪一个图层 2 秒 → 保存 → 渲成片 → `ffprobe` 分辨率帧率 + **抽帧目视：改的字在画面上、挪的图层时间变了**。区分「亲眼验的/推断的」，没验到的如实列。
- [ ] **Step 2: 实施说明 §9 P1 三条**：三宽度不错位（Step 9 已验则引用证据）、右栏 5 参数零请求、一屏一实心（三栏+popover 各态数一遍）。
- [ ] **Step 3: 回归**：P0 的四条验收快速复核（不换页/无裸枚举/断网失败态）；成片库/模板库未被波及；全仓 `npx pnpm test` 绿（equivalence + compositions 门禁必须绿）。
- [ ] **Step 4: 文档**：README 剪辑台段更新（真剪辑台落地：三栏/时间轴/重写/undo）；undo 只在会话内、重置走 orig 快照这两条用户须知写进 README。
- [ ] **Step 5: 提交** `git commit -m "docs: 剪辑台 P1 落地说明"`

---

## 计划自查

**1. Spec 覆盖**：§3.1 六端点→T2(GET/PUT/reset)/T3(render)/T4(rewrite)（content-items P0 已有）；§4 editing 包→T5；§5.2 单一真相→T6；§5.3 播放头→T6/T9；§5.4 时间轴→T9；§5.5 暂存→T9；§10 三条修正→T2(orig)/T4(只换文本)/T9(参数拆档)；§7 测试策略变异实验→T5 Step4；P0 终审遗留(接线层测试/死代码)→T1/T6。**manualBeats(§3.4)属 P2 卡点轨，不在本计划**。
**2. 占位符扫描**：无 TBD；测试给了用例清单与关键断言；web 任务给了固定签名与 §4/§5 规格出处。
**3. 类型一致性**：`updateLayerText/moveLayer/resizeLayer/snapStart/deriveShots/paramsDiff/History`（T5 定义→T6/T8/T9 消费同名）；`renderFromSpec`（T3→T9 端点消费）；`rewriteSection` 支持判定与 `ShotView.rewritable`（T4/T5 各一份判定——T5 用例注明「与 Task 4 判定一致」由测试钉住）；`useEditorState` 的 `apply/applyTransient/commit`（T6 定义、T9 扩展并回注 T6 文件）。
**4. 风险**：拖拽组内钳制的「最紧约束重算」是本计划最复杂的纯函数逻辑，已放 T5/T9 两层（纯函数可测 + UI 装配），若实现中发现约束冲突，以「宁可钳得紧不可重叠」为准。
