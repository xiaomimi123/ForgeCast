# 画布拖拽排版第一期 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 剪辑台预览画布上直接拖动/缩放图层（卡片、字幕、图片等），带对齐吸附线，预览即所得进成片。

**Architecture:** 文档流→按需固化：用户开始拖的那一刻用 offsetLeft 系测量图层布局位置写进 `style.x/y/width`，此后该层由 style 驱动（LayerView 补 `position:absolute` 语义）。吸附计算是 editing 纯函数 `snapPosition`；web 端新增 CanvasOverlay 盖在 Player 上做选中/拖动/缩放手柄。

**Tech Stack:** React + @remotion/player（页内 DOM，图层 `id={layer.id}` 可直接测量）、@forgecast/editing 纯函数包、vitest。

**Spec:** `docs/superpowers/specs/2026-09-07-canvas-layout-design.md`

## Global Constraints

- `@forgecast/editing` 零 Node 依赖（有守护测试）；纯函数、不可变、未变层返回原引用
- lower() 单向：改图层不反写语义层；`overridden` 照常置位
- ①②门禁红线：无 x/y 的既有 fixture 渲染结果不得变化
- `apps/web` 无测试框架，不得引入；验证走 `tsc --noEmit` + 浏览器自测（临时 workspace+独立 db，绝不碰用户 live db）
- 测试须 Node ≥22 同 shell：`export NVM_DIR="$HOME/.nvm" && source "$NVM_DIR/nvm.sh" && nvm use 22.23.2 && npx pnpm test`
- 用户 dev 服务在 5173/4321，禁止 `pkill`/`killall`，自用进程按 PID 关
- 提交信息不带 Co-Authored-By
- 吸附阈值 8px；安全边距线四边 60px；出界钳制=至少 40px 留在画布内；键盘微移 1px / Shift 10px

---

### Task 1: editing 纯函数 `snapPosition` / `clampToCanvas` / `clearLayerGeometry`

**Files:**
- Create: `packages/editing/src/canvas-ops.ts`
- Modify: `packages/editing/src/index.ts`（加 `export * from './canvas-ops'`）
- Test: `packages/editing/test/canvas-ops.test.ts`

**Interfaces:**
- Consumes: `VideoSpec`/`Layer` 类型（`import type ... from '@forgecast/studio'`，与 video-ops.ts 同姿势）；`round3`（ops.ts 已有则复用，没导出就在 canvas-ops 本地定义）
- Produces（Task 3/4 依赖，签名逐字）:

```ts
export interface CanvasRect { x: number; y: number; w: number; h: number }
export interface SnapGuide { axis: 'x' | 'y'; pos: number }   // axis:'x'=竖线(pos为x坐标), 'y'=横线
export interface SnapResult { x: number; y: number; guides: SnapGuide[] }

/** 对齐吸附。moving 为拖动中矩形（x/y 是候选新位置），others 为同画布其他图层矩形。
 *  候选线：画布中线(w/2,h/2)、安全边距(60 与 w-60/h-60)、others 的左/中/右(上/中/下)。
 *  moving 的左/中/右边缘各自与候选线比距离，≤ thresholdPx(默认8) 时吸上，取最近命中。
 *  disabled=true 时原样返回（Alt 旁路走这里，保持纯函数可测）。 */
export function snapPosition(moving: CanvasRect, others: CanvasRect[], canvas: { w: number; h: number }, thresholdPx?: number, disabled?: boolean): SnapResult

/** 出界钳制：矩形至少 minVisible(默认40)px 留在画布内。 */
export function clampToCanvas(rect: CanvasRect, canvas: { w: number; h: number }, minVisible?: number): { x: number; y: number }

/** 单层排版重置：从 style 删除 x/y/width/height/fontSize（回文档流）。全都没有时返回原 spec 引用。 */
export function clearLayerGeometry(spec: VideoSpec, layerId: string): VideoSpec
```

- [ ] **Step 1: 写失败测试**（`packages/editing/test/canvas-ops.test.ts`）

```ts
import { describe, expect, it } from 'vitest'
import { clampToCanvas, clearLayerGeometry, snapPosition } from '../src/canvas-ops'
// spec fixture 参考 video-ops.test.ts 的 talkSpec() 写法自建最小 spec

const CANVAS = { w: 1080, h: 1920 }

describe('snapPosition', () => {
  it('中心距画布竖中线 ≤8px 时吸中并给出竖参考线', () => {
    const r = snapPosition({ x: 534, y: 100, w: 20, h: 20 }, [], CANVAS)   // 中心 544, 距 540 差 4
    expect(r.x).toBe(530)                                                  // 中心=540
    expect(r.guides).toContainEqual({ axis: 'x', pos: 540 })
  })
  it('差 9px 不吸（阈值边界）', () => {
    const r = snapPosition({ x: 529, y: 100, w: 20, h: 20 }, [], CANVAS, 8)
    // 中心 539 距 540 差 1 会吸——换个真不吸的: 左缘 529 距 60 边距线差 469... 用明确超阈值例
    const r2 = snapPosition({ x: 100, y: 100, w: 20, h: 20 }, [], CANVAS, 8)
    expect(r2.x).toBe(100)
    expect(r2.guides).toHaveLength(0)
    void r
  })
  it('吸其他图层的左缘对左缘', () => {
    const other = { x: 200, y: 500, w: 300, h: 100 }
    const r = snapPosition({ x: 205, y: 100, w: 50, h: 50 }, [other], CANVAS)
    expect(r.x).toBe(200)
    expect(r.guides).toContainEqual({ axis: 'x', pos: 200 })
  })
  it('多候选取最近；x/y 两轴独立吸', () => {
    const r = snapPosition({ x: 57, y: 1855, w: 100, h: 60 }, [], CANVAS)  // 左缘57↔60边距差3; 下缘1915↔1860差55不吸,y中心1885↔... 自行取明确值
    expect(r.x).toBe(60)
    expect(r.guides.some((g) => g.axis === 'x' && g.pos === 60)).toBe(true)
  })
  it('disabled=true 原样返回、无参考线', () => {
    const r = snapPosition({ x: 538, y: 100, w: 4, h: 4 }, [], CANVAS, 8, true)
    expect(r).toEqual({ x: 538, y: 100, guides: [] })
  })
})

describe('clampToCanvas', () => {
  it('拖出左侧只留 10px 时钳回到留 40px', () => {
    expect(clampToCanvas({ x: -290, y: 0, w: 300, h: 100 }, CANVAS)).toEqual({ x: -260, y: 0 })
  })
  it('完全在内不动', () => {
    expect(clampToCanvas({ x: 100, y: 100, w: 300, h: 100 }, CANVAS)).toEqual({ x: 100, y: 100 })
  })
  it('右/下同理（对称）', () => {
    expect(clampToCanvas({ x: 1075, y: 1915, w: 300, h: 100 }, CANVAS)).toEqual({ x: 1040, y: 1880 })
  })
})

describe('clearLayerGeometry', () => {
  it('删掉 x/y/width/height/fontSize，保留 color/cssClass 等', () => { /* 建带全量 style 的层断言删净+保留 */ })
  it('本就没有几何覆盖时返回原 spec 引用', () => { /* toBe 同引用 */ })
  it('不存在的 layerId throw', () => { /* 与 video-ops 报错风格一致 */ })
})
```

- [ ] **Step 2: 跑测试确认红**：`cd packages/editing && npx vitest run test/canvas-ops.test.ts` → FAIL（模块不存在）
- [ ] **Step 3: 实现 `canvas-ops.ts`**（吸附：分别收集 x 轴候选（画布 w/2、60、w-60、others 左/中/右）与 y 轴候选，moving 三条边逐一比距，各轴取最小距离且 ≤threshold 的候选；纯函数无副作用）
- [ ] **Step 4: 跑到绿 + 变异实验**：把「取最近」改成「取第一个」→ 多候选用例必须红；还原。跑整包 `npx vitest run` 全绿（零 Node 守护含新文件）
- [ ] **Step 5: Commit** `feat(editing): 画布吸附/钳制/几何重置纯函数`

### Task 2: compositions 绝对定位语义 + 六模板门禁

**Files:**
- Modify: `packages/compositions/src/LayerView.tsx`（geom()）
- Test: `packages/compositions/test/content.test.tsx`、`test/fixtures/generate.ts`

**Interfaces:**
- Produces: `style.x != null || style.y != null` ⇒ 渲染元素 `position:absolute`（Task 3 的固化行为依赖此语义）

- [ ] **Step 1: 失败测试**：content.test.tsx 加断言——带 `style:{x:100,y:200}` 的层渲染出 `position:absolute; left:100px; top:200px`；不带 x/y 的层 **无** position 内联（文档流不受扰）。六模板 fixture（generate.ts）各挑一层加 x/y 变体进内容门禁（新增 fixture 断言，不改既有 fixture——①②门禁红线）
- [ ] **Step 2: 确认红**（现状 geom() 只设 left/top 不设 position）
- [ ] **Step 3: 实现**：geom() 里 `if (style.x !== undefined || style.y !== undefined) s.position = 'absolute'`
- [ ] **Step 4: 全包绿**：`cd packages/compositions && npx vitest run`（166+新增），确认既有 fixture 快照/断言零变化
- [ ] **Step 5: Commit** `feat(compositions): style.x/y 触发绝对定位——画布排版的渲染语义`

### Task 3: CanvasOverlay——选中 + 拖动 + 吸附线 + 固化

**Files:**
- Create: `apps/web/src/pages/workshop/editor/CanvasOverlay.tsx`
- Modify: `apps/web/src/pages/workshop/editor/EditorPage.tsx`（StageBody 里 Player 外包相对定位容器、挂 overlay、传 selectedLayerId/onSelectLayer/currentSec）

**Interfaces:**
- Consumes: Task 1 `snapPosition/clampToCanvas`、editing `setLayerStyle`、`ed.applyTransient/apply`（useEditorState 既有）、`selectedLayerId/setSelectedLayerId`（EditorPage:115）
- Produces: `<CanvasOverlay spec={preview} currentSec playerRef selectedLayerId onSelectLayer ed containerRef />`

核心逻辑（实现要点，非逐行）：

```tsx
// 测量：图层 DOM id = layer.id（LayerView.tsx:79）。在 Player 容器里
// const el = container.querySelector<HTMLElement>(`#${CSS.escape(id)}`)
// 用 offsetLeft/offsetTop 沿 offsetParent 链累加到合成根——布局坐标天然就是画布 px
// （Player 以 transform:scale 缩放合成，offset 系不受 transform 影响，正合 spec §2 要求）。
// 指针位移换算：deltaCanvas = deltaClient / (containerRect.width / spec.canvas.width)
//
// 命中区：对 currentSec 时刻可见（start<=t<start+duration）且 kind!=='video' 的层，
// 按测量矩形画透明 hitbox（绝对定位 div 盖在 Player 上，pointer-events:auto；overlay 本体 none）。
// 播放中（playerRef.current.isPlaying()）不渲 hitbox——观看态。
//
// pointerdown 于 hitbox：选中该层。若 style.x/y 缺失→固化：一次 applyTransient(
//   setLayerStyle(spec, id, { x: 测量x, y: 测量y, width: 测量w }))。记 grab 基线（矩形+指针）。
// pointermove：raw = 基线 + delta；snapPosition(raw矩形, 其他可见层矩形, canvas, 8, altKey)
//   → clampToCanvas → applyTransient(setLayerStyle(...{x,y}))；渲染命中 guides（1px 高亮线）。
// pointerup：ed.apply(同 patch) 收尾——一次拖拽=一步 undo（applyTransient 链后 commit，
//   沿用 TimelinePane 拖拽的既有姿势，先读它对齐）。setPointerCapture 全程。
// 点空白/视频层区域：onSelectLayer(null)。
// 选中态：描边框 + 四角 8px 手柄（手柄本 Task 只显示，缩放逻辑 Task 4）。
```

- [ ] **Step 1: 读现场**：TimelinePane 拖拽的 applyTransient/apply 姿势、useEditorState 的 busy/canEdit 门、StageBody 结构
- [ ] **Step 2: 实现 CanvasOverlay**（select+drag+guides+固化+钳制；手柄仅展示）
- [ ] **Step 3: 挂进 StageBody**：Player 外套 `<div style={{position:'relative',width:CANVAS_W,height:CANVAS_H}}>`，overlay 铺满
- [ ] **Step 4: 验证**：`cd apps/web && npx tsc --noEmit`；浏览器自测（临时 workspace+独立 db）：六模板各开一条→拖卡片见吸附线/钳制、undo 一步回、保存后重开位置在、没拖过的层文档流未动（对照拖前截图）
- [ ] **Step 5: Commit** `feat(web): 画布拖拽——选中/拖动/吸附线/文档流按需固化`

### Task 4: 缩放手柄 + 字号联动 + 键盘微移 + 单层重置

**Files:**
- Modify: `apps/web/src/pages/workshop/editor/CanvasOverlay.tsx`、`InspectorPane.tsx`

**Interfaces:**
- Consumes: Task 1 `clearLayerGeometry`、Task 3 的测量/固化基建

- [ ] **Step 1: 缩放**：四角手柄 pointerdown → 记 grab 基线（矩形 + 该层 computed fontSize，`getComputedStyle(el).fontSize` 解析 px）。pointermove 按对角固定点改 width（等比可选：文字/卡片/caption 层 `fontSize = 基线fontSize × newWidth/基线width`，四舍五入；image/shape 层同时改 width/height 不动字号）。applyTransient→pointerup commit。width 下限 40px。
- [ ] **Step 2: 键盘**：overlay 或 EditorPage 键盘链（对齐③既有 blockedRef 门）：选中层且未聚焦输入框时，方向键=±1px、Shift=±10px（x/y 直改，同样先固化）；一次按键=一步 undo（apply 直提）。**Delete 不新增**——删层规则沿用现有入口，不在画布上开新删除路径（避开误删）。
- [ ] **Step 3: Inspector「清除位置覆盖」**：VideoLayerFields 之外的通用 LayerStyle 组里加按钮，`ed.apply(clearLayerGeometry(spec, layer.id))`；仅当层有 x/y/width/height/fontSize 任一时可点。双向同步顺手核对：画布拖动后 Inspector 数字框跟着变（同一 spec 应自然成立，验证即可）。
- [ ] **Step 4: 验证**：`tsc --noEmit` + 浏览器走查：拖角文字变大字号跟随、图片自由改宽高、方向键微移、清除覆盖回文档流、undo/redo 全链
- [ ] **Step 5: Commit** `feat(web): 画布缩放/字号联动/键盘微移/单层排版重置`

### Task 5: 端到端真渲验收 + 文档

**Files:**
- Modify: `README.md`（剪辑台段补画布排版）、`docs/superpowers/specs/2026-09-07-canvas-layout-design.md`（如有实现偏差记附注）

- [ ] **Step 1: 真渲验收**（复用④Task 8 方式：临时 workspace+独立 db、app.fetch 真路由、FORGECAST_VIDEO_MODE 真渲）：任选模板出片→PUT spec 把一张卡片设 `x/y` 到画布正中+width 缩到 60%→真渲→抽帧验位置（±3px，与预览测量值对照）、字号缩放生效、**无 x/y 的层帧内位置与固化前一帧逐像素一致**（等价门禁思路）
- [ ] **Step 2: 回归**：全仓 `npx pnpm test` 绿（已知 flake 单包重跑）；④talk 主链快速复核（trim/字幕不受 overlay 改动影响）
- [ ] **Step 3: 文档**：README 剪辑台段加「画布直接拖动/缩放图层，吸附对齐，清除覆盖回模板排版」；spec 附实现偏差注记
- [ ] **Step 4: Commit** `docs: 画布拖拽排版落地说明`

## Self-Review

- Spec 覆盖：§1 固化+absolute（T2/T3）、§2 交互全项（T3/T4；Delete 一项按§2「沿用现有规则」落为不开新入口）、§3 边界（40px 钳制 T1/T3、单层重置 T1/T4、lower 铁律不触碰语义层）、§4 测试（T1 单测+变异、T2 门禁、T5 端到端）、§5/§6 非目标未越界。缺口：无。
- 占位符：无 TBD/TODO；Task 3/4 的 UI 逻辑以要点+关键算式给出（apps/web 无测试框架，行为验收走浏览器+真渲，与③④先例一致）。
- 类型一致性：`snapPosition/clampToCanvas/clearLayerGeometry/CanvasRect/SnapGuide` 各任务引用与 Task 1 签名逐字一致。
