# 特效库升级 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 图层视觉效果四组（描边/圆角/阴影、毛玻璃、文字描边/发光、渐变）+ 动画参数化（时长/延迟/方向/幅度）+ 新动画三种（zoomIn/slideIn/blurIn），全部即调即见、可进预设。

**Architecture:** LayerStyle 新增可选字段两端 CSS 映射（Remotion geom() + HF styleAttr，等价门禁续成立）；动画只动 Remotion 的 styleAt 插值（HF 不反映，README 注明）；editing 新纯函数 setEffectParams；Inspector 卡片效果/文字效果小节 + 特效组带参数展开。缺省=现状零变化。

**Tech Stack:** React/Remotion、@forgecast/editing 纯函数、vitest。

**Spec:** `docs/superpowers/specs/2026-09-08-effects-library-design.md`

## Global Constraints

- 缺省零变化红线：不带新字段/参数的存量 spec 两端渲染逐字节不变（①②门禁不改弱；①等价门禁按现状锁，范围声明写测试注释）
- `@forgecast/editing` 零 Node/纯函数/不可变/同值与未变层返回原引用
- LayerView「只写被动画目标」铁律：blur/transform 仅在非缺省时写内联（恒等值会顶掉模板 CSS——文件头有历史教训注释）
- styleAt 缺省值=现行硬编码值（slideUp 40px、fadeIn y20 等——迁移时逐字保留）；slideUp 与 slideIn 并存（存量保护）
- `apps/web` 无测试框架；验证 tsc+浏览器自测（临时 workspace+独立 db；server 若在 worktree 用该 worktree better-sqlite3 对应的 Node 版本，先 node -e "require('better-sqlite3')" 探一下 20/22）
- 用户 5173/4321 不碰；禁止 pkill/killall；提交不带 Co-Authored-By
- 测试同 shell：`export NVM_DIR="$HOME/.nvm" && source "$NVM_DIR/nvm.sh" && nvm use <版本> && npx pnpm test`

---

### Task 1: LayerStyle 新字段 + 两端 CSS 映射

**Files:**
- Modify: `packages/studio/src/videospec.ts`（LayerStyle 追加）、`packages/compositions/src/LayerView.tsx`（geom()）、`packages/studio/src/render-html.ts`（styleAttr）
- Test: `packages/compositions/test/content.test.tsx`（映射断言）、`packages/studio/test/render-html.test.ts`（或既有 styleAttr 测试所在文件）

**Interfaces:**
- Produces（逐字，两端与 Task 3 UI 共用）:

```ts
// LayerStyle 追加（videospec.ts，compositions/videospec-types 同步）
borderWidth?: number; borderColor?: string
radius?: number
shadow?: { blur: number; x: number; y: number; color: string }
backdropBlur?: number
textStrokeWidth?: number; textStrokeColor?: string
glow?: { blur: number; color: string }
bgGradient?: { from: string; to: string; angle: number }
```

CSS 映射（两端完全一致，HF 端值经 escapeHtml）：
- border: `${borderWidth}px solid ${borderColor ?? '#fff'}`（宽>0 才写）；`border-radius:${radius}px`
- `box-shadow:${x}px ${y}px ${blur}px ${color}`；`backdrop-filter:blur(${n}px)`（>0 才写）
- `-webkit-text-stroke:${w}px ${color ?? '#000'}`（w>0）；glow→`text-shadow:0 0 ${blur}px ${color}`
- bgGradient 有值→`background:linear-gradient(${angle}deg, ${from}, ${to})`（优先于 bg，写在 bg 之后覆盖）

- [ ] **Step 1: 失败测试**：compositions 端——带各新字段的层渲染出对应内联 CSS（逐字段一例）；**不带新字段的层内联样式零变化**（取既有 fixture 渲染快照对比）。studio 端——styleAttr 同映射断言 + 空 style 返回空串不变。
- [ ] **Step 2: 红 → 实现两端 → 绿**（compositions 182+新增、studio 全包；既有断言零变化）
- [ ] **Step 3: 变异一发**：把 bgGradient 的「优先于 bg」反过来 → 对应用例红；还原。
- [ ] **Step 4: Commit** `feat(compositions,studio): LayerStyle 视觉效果字段两端映射`

### Task 2: styleAt 参数化 + 新动画三种（Remotion）

**Files:**
- Modify: `packages/compositions/src/effects.ts`（FrameStyle 加 `blur?: number`；styleAt 参数化+三新 case）、`packages/compositions/src/LayerView.tsx`（blur→`filter:blur()`，仅 >0 写）、`packages/studio/src/videospec.ts`（Effect.type 联合加 'zoomIn'|'slideIn'|'blurIn'）
- Test: `packages/compositions/test/`（effects 单测新文件或既有）

**Interfaces:**
- Produces: `FrameStyle { opacity; y; scale; x?: number; blur?: number }`（x 为 slideIn 横向通道；LayerView transform 组装 translateX/translateY/scale，沿用「非缺省才写」判断）
- 参数语义（Task 3/4 依赖）：`params.direction`('up'|'down'|'left'|'right')、`params.distance`(px)、`params.scale`(number)、`params.blur`(px)

实现细则：
- fadeIn/slideUp/pulse/demote/exit 缺省行为逐字保留；slideUp 读 `params.distance ?? 40`（参数化但缺省不变）；fadeIn 读 `params.y ?? 20`（既有）与 `params.scale`（既有）。
- `zoomIn`: `scale = (params.scale ?? 0.8) + (1-(params.scale ?? 0.8))*p; opacity *= p`
- `slideIn`: direction 决定轴与符号（up→y+d*(1-p)、down→y-d、left→x+d、right→x-d），`d = params.distance ?? 40`；`opacity *= p`
- `blurIn`: `blur = (params.blur ?? 12)*(1-p); opacity *= p`（blur 通道相加合成）

- [ ] **Step 1: 失败测试**：缺省值显式断言（slideUp t 中点 y=40*(1-p) 用现值锁）；四向符号各一例；zoomIn/blurIn 数值例；p=1 时全部归零（终态干净）；exit 硬收尾不受新通道影响。
- [ ] **Step 2: 红 → 实现 → 绿**；LayerView blur 映射 + transform 组装扩 x（`translateX`），保持「clipFx 恒等时不写 transform/filter」。
- [ ] **Step 3: 变异一发**：slideIn direction left/right 符号互换 → 四向用例红；还原。整包绿+既有 fixture 零变化。
- [ ] **Step 4: Commit** `feat(compositions): styleAt 参数化与 zoomIn/slideIn/blurIn`

### Task 3: editing setEffectParams + Effect 类型面

**Files:**
- Create: `packages/editing/src/effect-ops.ts`；Modify: `packages/editing/src/index.ts`
- Test: `packages/editing/test/effect-ops.test.ts`

**Interfaces:**
- Produces（Task 4 逐字消费）:

```ts
export interface EffectPatch { at?: number; duration?: number; direction?: 'up'|'down'|'left'|'right'; distance?: number; scale?: number; blur?: number }
/** 顶层键(at/duration)写 Effect 顶层；其余写 params 合并。目标层不存在或未开该效果 throw。
 *  产出的 Effect 与 patch 后逐键相等时返回原 spec 引用。 */
export function setEffectParams(spec: VideoSpec, layerId: string, type: Effect['type'], patch: EffectPatch): VideoSpec
```

- [ ] **Step 1: 失败测试**：顶层/params 分流；params 合并保留未提键；同值原引用（toBe）；未开效果 throw；不碰其他层（原引用）与时间轴。
- [ ] **Step 2: 红 → 实现 → 绿 + 变异**（params 合并改整组替换 → 保留键用例红；还原）。零 Node 守护绿。
- [ ] **Step 3: Commit** `feat(editing): setEffectParams——动画参数纯函数`

### Task 4: Inspector UI——卡片/文字效果小节 + 特效组参数展开

**Files:**
- Modify: `apps/web/src/pages/workshop/editor/InspectorPane.tsx`（样式组两小节 + 特效组重做）、`apps/web/src/pages/workshop/editor/ui.ts`（EFFECTS 清单加三新动画+标签）

要点：卡片效果小节（border 宽/色、radius、shadow 模糊/x/y/色、backdropBlur 0-40 滑杆、bgGradient 双色+角度 0-360）全层型可见（video 层除外——沿用 LayerStyle 组对 video 隐藏的既有分支）；文字效果小节（textStroke 宽/色、glow 模糊/色）仅 text/caption；全部 local draft + blur/Enter commit（`setLayerStyle` patch），清空输入=patch 该键 undefined（`setLayerStyle` 合并语义下需支持显式删键——若现实现不支持 undefined 删键，在 editing 补一档：patch 值为 undefined 时从 style 删除该键，带测试）。特效组：每效果一行勾选+「⚙」展开面板（at/duration 数字、direction 下拉、distance/scale/blur 数字，仅该效果相关键可见——zoomIn 出 scale、slideIn 出 direction+distance、blurIn 出 blur、slideUp 出 distance、fadeIn 出 y/scale），改动走 `ed.apply(setEffectParams(...))` 一次一步 undo。

- [ ] **Step 1: 读现场**（InspectorPane 样式组/特效组、setLayerStyle 合并语义——确认 undefined 键行为）
- [ ] **Step 2: 实现 + tsc 干净**（如需 editing 删键支持，先补测试再改）
- [ ] **Step 3: 浏览器自测**（临时 workspace+独立 db）：调描边/阴影/毛玻璃/渐变即时预览、清空移除、undo 一步；文字层发光；特效展开调 direction/distance 即见；新动画三种上层生效；存为预设→另一视频套用带出全部新字段与参数
- [ ] **Step 4: Commit** `feat(web): Inspector 卡片/文字效果与动画参数面板`

### Task 5: 端到端真渲验收 + 文档

**Files:**
- Modify: `README.md`、spec 附「实现偏差」注记

- [ ] **Step 1: 真渲**（临时 workspace+独立 db、app.fetch、FORGECAST_VIDEO_MODE=render）：一条片同层/分层上齐 border+radius+shadow+backdropBlur+glow+bgGradient+zoomIn(direction 无意义)+slideIn(left, distance 120)+blurIn → 抽帧逐项验（**毛玻璃重点**：抽帧看卡片后视频是否磨砂；不支持则按 spec §6 降级半透明底色并记偏差）；对照组全缺省与 merge-base 出片逐字节对照
- [ ] **Step 2: 回归**：全仓测试绿（已知 flake 单包重跑）
- [ ] **Step 3: 文档**：README 特效段（四组视觉/参数化/新动画/「HF 预览不反映动画参数」注记）；spec 实现偏差注记
- [ ] **Step 4: Commit** `docs: 特效库升级落地说明`

## Self-Review

- Spec 覆盖：§1.1 字段（T1）、§1.2 参数与新动画（T2/T3）、§2 双端映射+Remotion-only 动画+门禁（T1/T2 测试）、§3 UI（T4）、§4 测试（各任务+T5）、§5 非目标未越界、§6 毛玻璃降级预案（T5 Step1 写明）。缺口：无。
- 占位符：无 TBD；T2 给了逐效果公式；T4 删键支持给了条件路径（先确认再补）。
- 类型一致性：`FrameStyle.blur/x`、`EffectPatch`、`setEffectParams`、LayerStyle 字段名在各任务引用一致。
