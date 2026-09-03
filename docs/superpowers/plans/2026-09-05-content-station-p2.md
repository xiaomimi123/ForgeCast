# 做内容工位重构 P2（效率阶段）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 完成子项目③收官阶段：时间轴 BGM 波形轨 + 卡点轨（接管并退役 CutPlanEditor 入口）、成片库批量审片（6 列网格 + J/K/Space/A/R/E 快捷键 + 批量操作）、窄屏完整档，并收掉 P0/P1 挂给 P2 的全部账（mood 自动选曲、beatGrid 换曲重分析、perf/发布展示回工位、moveShotBy/layoutRow 迁包、in-app confirm）。

**Architecture:** 卡点数据全走 spec（`beatGrid` + 新可选 `manualBeats`），换曲改为服务端端点（选曲+节拍重分析一体，顺带放开 mood）；波形 peaks 用现有 ffmpeg 采样、服务端算前端画；批量审片建立在 P0 成片库与既有 review/approve 能力上，快捷键流程用新的 in-app confirm（原生 confirm 会阻塞连续 J/K 操作）。

**Tech Stack:** Hono + ffmpeg（peaks）+ librosa via `analyzeBeats`（studio 现成）、@forgecast/editing（纯函数扩容）、React 18 + Tailwind v4（web 无测试框架）、vitest

**Spec:** `docs/superpowers/specs/2026-09-03-content-station-editor-design.md`（§1.3/§3.4/§6 P2 行/§10）；视觉/交互权威 `docs/剪辑台-实施说明.md`（§4 窄屏表与轨道尺寸、§5 BeatMarker、§7 批量审片快捷键、§8 P2 条目、§9 验收）

## Global Constraints

- `apps/web` **无测试框架**不得新增；可测逻辑进 `@forgecast/editing` / server / studio。
- **不动** `lower()`、`hyperframes.ts` 既有行为（`analyzeBeats/chooseBgmPath/pickBgm` 只调用不改）、①②门禁。CutPlanEditor **只删工坊入口**，其组件文件、cutplan API 与数据保留（spec §1.3：老项目还能用）。
- `manualBeats` 是 `AudioSpec.beatGrid` 上的**可选**字段（`bgVariant` 同款先例）：`lower()` 不产它、①门禁不比它、自动重分析**不覆盖**它（实施说明 §5 BeatMarker 规定）。
- 一屏唯一常驻黑实心；状态标签不可点；批量条高 28（实施说明 §3 控件高度表）。
- 测试 Node ≥22 且 nvm 与命令**同一次 shell 调用内**：`export NVM_DIR="$HOME/.nvm" && source "$NVM_DIR/nvm.sh" && nvm use 22.23.2 && npx pnpm test`。
- **禁止 `pkill`/`killall`**（用户 dev server 在 5173/4321）；自起进程按 PID 关；浏览器自验注意本机 `db/forgecast.db` 可能被用户会话占用——**自验一律用临时 workspace + 独立 db**（P1 各任务的做法），不碰用户数据。
- 提交信息不带 `Co-Authored-By` trailer。
- 已知无关：`hyperframes.test.ts:591` tsc 错误、`rebrand/kill-port` 满载 flake。

## 文件结构

```
packages/editing/src/timeline.ts       新：moveShotBy/layoutRow 迁入（终审 backlog）+ beat 工具
packages/server/src/spec-routes.ts     改：+POST pick-bgm（服务端换曲+重分析）、+GET waveform、PUT 校验容 manualBeats
packages/studio/src/videospec.ts       改：beatGrid 加 manualBeats?: number[]（可选，注释注明来源）
apps/web/src/components/ui/Confirm.tsx 新：in-app confirm（Promise 化，替代原生 confirm）
apps/web/src/pages/workshop/editor/TimelinePane.tsx  改：波形轨+卡点轨、窄屏两轨档
apps/web/src/pages/workshop/editor/ShotList.tsx      改：「加卡点」启用
apps/web/src/pages/workshop/editor/InspectorPane.tsx 改：换曲走 pick-bgm、mood 放开
apps/web/src/pages/workshop/editor/EditorPage.tsx    改：confirm 替换、<1040 左栏抽屉、E 键入口对接
apps/web/src/pages/workshop/LibraryTab.tsx           改：6 列网格+快捷键+批量+perf/发布展示
apps/web/src/pages/WorkshopPage.tsx                  改：卡点 tab（CutPlanEditor）入口移除、库→剪辑台跳转
```

---

### Task 1: editing — moveShotBy/layoutRow 迁包 + beat 纯函数

**Files:**
- Create: `packages/editing/src/timeline.ts`；Test: `packages/editing/test/timeline.test.ts`
- Modify: `packages/editing/src/index.ts`（导出）、`apps/web/src/pages/workshop/editor/TimelinePane.tsx`（改 import，删本地实现）

**Interfaces:**
- Produces（web 侧 TimelinePane 现有调用签名**原样保留**，读 `TimelinePane.tsx:36-66,341-361` 逐字迁）：
  - `moveShotBy(spec, shot: ShotView, deltaSec, thresholdSec): VideoSpec`（含按位移方向排序、最小 effective 重算——P1 终审确认的实现直接搬）
  - `layoutRow(shots: ShotView[], durationSec): Array<{ shot: ShotView; weight: number; gapWeight: number }>`（含重叠裁剪）
  - 新增 `allBeats(grid: BeatGrid & { manualBeats?: number[] } | null, durationSec): Array<{ t: number; kind: 'strong' | 'derived' | 'manual' }>`：strongBeats→strong；t0+n·T 网格外推里不在 strongBeats 的→derived；manualBeats→manual；越界(<0/>durationSec)剔除、去重（同 t 保留 manual>strong>derived）
  - 新增 `addManualBeat(spec, tSec): VideoSpec` / `removeManualBeat(spec, tSec): VideoSpec`（写 `audio.beatGrid.manualBeats`；beatGrid 为 null 时 addManualBeat 建 `{t0:0,T:0,bpm:0,strongBeats:[],manualBeats:[t]}` 形状——T=0 表示无网格仅手动点，`allBeats` 对 T<=0 跳过外推；不可变；重复 t(±0.01s) 幂等）
- [ ] **Step 1: 失败测试**——迁移部分：把 P1 里 TimelinePane 相关浏览器验过的场景写成单测（三段重叠链权重=片长、双层同轨右移不互钳、吸附+钳制组合）；新增部分：allBeats 三态/去重优先级/T=0 跳外推、add/remove 幂等与不可变。
- [ ] **Step 2-4: 红→迁移+实现→editing 全绿**；TimelinePane 改 import 后 `tsc --noEmit`+`build` 过；**变异一组**：删 layoutRow 重叠裁剪→对应用例红→还原。
- [ ] **Step 5: 提交** `git commit -m "feat(editing): 时间轴纯函数迁包+卡点工具——终审 backlog 收口"`

---

### Task 2: server — pick-bgm（换曲+重分析一体）+ waveform peaks + manualBeats 过闸

**Files:**
- Modify: `packages/server/src/spec-routes.ts`、`packages/studio/src/videospec.ts`（beatGrid 加 `manualBeats?: number[]`）
- Test: `packages/server/test/spec-routes.test.ts`（追加）

**Interfaces:**
- `POST /api/projects/:slug/specs/:videoId/pick-bgm` body `{ bgm?: string; mood?: string }`：
  1. `chooseBgmPath(templates/bgm 目录, { bgm: body.bgm ?? '', mood: body.mood ?? '', hook: spec.semantic.hook ?? '' }, Math.random)`（studio 已导出，选不到→400「曲库为空或无匹配」）
  2. `analyzeBeats(bgmPath, ctx.config.video.beatPython)` 重分析（失败→**仍换曲**，`beatGrid` 置 null + `spec.warnings.push('节拍分析失败，卡点不可用')`——fail-soft，cutplan analyze 端点同款先例）
  3. 更新 `spec.audio.bgm = { src: bgmPath, mood: body.mood ?? null }`、`spec.audio.beatGrid = { ...新grid字段, manualBeats: 旧 beatGrid?.manualBeats ?? undefined }`（**手动卡点保留**——实施说明 §5 规定重新分析不覆盖）
  4. 落盘（走既有 `pickKnownSpecFields`）并返回 spec。
- `GET /api/projects/:slug/specs/:videoId/waveform`：读 `spec.audio.bgm.src`（无/文件缺→404）；`ffmpeg -i <src> -ac 1 -ar 200 -f s16le -acodec pcm_s16le -`（spawn，stdout 收满）→ 每样本 `|s|/32768` 归一→按 `ceil(样本数/1000)` 分桶取 max → `{ peaks: number[](≤1000), durationSec }`；结果按 `src+mtime` 内存缓存；ffmpeg 失败→503「波形不可用」。
- PUT 校验：`manualBeats` 属 audio.beatGrid 内层，`pickKnownSpecFields` 只剥顶层——确认现有 PUT 不会丢它（写一条测试：PUT 带 manualBeats 的 spec → 盘上保留）。
- [ ] **Step 1: 失败测试**（用例：pick-bgm 换曲成功+beatGrid 更新+manualBeats 保留 / 曲库空 400 / 节拍分析失败仍换曲+warning / waveform 返回 ≤1000 peaks 且 0..1 / 无 bgm 404 / PUT 保 manualBeats）。`analyzeBeats`/ffmpeg 在测试里怎么处理：**读 `packages/server/test/cutplan.test.ts` 的现成做法**（它测过 analyze 端点）——同款 stub/真跑策略照抄。
- [ ] **Step 2-4: 红→实现→server+studio 全绿**（equivalence/compositions 门禁必须绿——videospec.ts 只加可选字段，红了查自己）。
- [ ] **Step 5: 提交** `git commit -m "feat(server): 换曲+节拍重分析一体端点与波形 peaks，手动卡点持久化过闸"`

---

### Task 3: web — in-app Confirm 组件 + 全量替换原生 confirm

**Files:**
- Create: `apps/web/src/components/ui/Confirm.tsx`；Modify: `EditorPage.tsx`/`ShotList.tsx`/`WorkshopPage.tsx`/`ContentCard.tsx`（原生 `confirm(` 全替换）

**Interfaces:**
- `useConfirm(): { confirm(opts: { title: string; body?: string; okLabel?: string; danger?: boolean }): Promise<boolean>; element: ReactNode }`——Promise 化模态；`element` 挂在调用组件树根；样式 `--fc-*`（面板 `--fc-surface`、danger 时确认钮实心 accent——实施说明 §5「失败态里的重试用实心红，那是那一处的主操作」同理，模态内实心不违反一屏规则）；Esc=取消、Enter=确认、遮罩点击=取消。
- 三选场景（dirty 闸的「保存并切/丢弃/取消」）：`confirm3(opts): Promise<'save' | 'discard' | 'cancel'>`。
- 替换点（grep `confirm(` 全找）：dirty 闸两段→confirm3 一个弹层；重写 409、渲成片确认、删除内容二次确认、重置确认。**替换后语义逐一保持**（尤其 dirty 闸「保存失败不放行」）。
- [ ] **Step 1: 实现+替换**；`grep -rn "window.confirm\|[^.]confirm(" apps/web/src` 仅剩 Confirm.tsx 自身。
- [ ] **Step 2: 构建 + 浏览器自验**（临时 workspace）：dirty 切换三选、删除 danger 态、Esc/Enter、重写 409。逐项报告。
- [ ] **Step 3: 提交** `git commit -m "feat(web): in-app confirm 替代原生弹窗——批量审片快捷键流的前置"`

---

### Task 4: web — 时间轴波形轨 + 卡点轨 + 加卡点

**Files:**
- Modify: `editor/TimelinePane.tsx`（+BGM 轨 30 +卡点轨 26，总高 186 内重排：头32+刻度20+分镜46+字幕30+BGM30+卡点26=184≤186，照实施说明 §4 轨道表）、`editor/ShotList.tsx`（「加卡点」启用）、`editor/EditorPage.tsx`（装配）

**Interfaces:**
- Consumes: Task 1 `allBeats/addManualBeat/removeManualBeat`、Task 2 waveform 端点。
- BGM 轨：无 bgm → 灰字「无背景乐」；有 → GET waveform 画 `<canvas>`（peaks 柱状，`--fc-line-2` 色，宽随轨道容器）；503/404 → 灰字「波形不可用」。加载中 Skeleton 条。
- 卡点轨：`allBeats(spec.audio.beatGrid, durationSec)` 渲 BeatMarker——11×11 菱形 `position:absolute; left:<t/duration 百分比>`（实施说明 §5）；三态：`strong`=实心 accent（已用）/`derived`=实心灰（检出未用，**点一下切分镜**：调 `moveShotBy` 把最近的 shot 边界吸到该拍——具体=找 startSec 距该拍最近的 shot，`moveShotBy(spec, shot, t - shot.startSec, 0)`，与手动拖拽同一函数）/`manual`=描边墨色。manual 点击=删除（confirm 轻确认）；空白处 **双击**=`addManualBeat(在双击 x 换算的秒)`。
- 「加卡点」（ShotList 操作条 P2 占位启用）：对 active shot 的 startSec 调 `addManualBeat`。
- 全部编辑走 `ed.apply`（进 undo）；beatGrid 为 null 时卡点轨显示「无节拍数据——换曲或重分析后可用」。
- [ ] **Step 1: 实现**；**Step 2: 构建+浏览器自验**（临时 workspace，造带 beatGrid 的 spec）：波形出图、三态菱形各点一次行为对、双击加点、Ctrl/⌘Z 回退加点、拖 Clip 吸附现在也吸 manual 点（Task 1 的 allBeats 若接进 snapStart 的候选——**注意**：P1 的 `snapStart` 只读 t0+n·T 网格；本任务把吸附候选换成 `allBeats` 的全部 t——这是 `editing` 侧一个小改（`snapStart` 加可选 beats 参数或新函数 `snapToBeats(beats, raw, threshold)`），带单测，别在 web 里散装实现）。
- [ ] **Step 3: 提交** `git commit -m "feat(web): 时间轴波形轨与卡点轨——三态菱形、手动卡点、检出点切分镜"`

---

### Task 5: web — Inspector mood 放开 + 换曲走 pick-bgm

**Files:**
- Modify: `editor/InspectorPane.tsx`、`packages/editing/src/params.ts`（mood 回到 diff——P1 留的注释指到这）、`packages/editing/test/params.test.ts`

**Interfaces:**
- mood 从只读档回到可改档（hint 换成「换情绪将重选曲并重析节拍」）；`ParamsDraft` 恢复 `mood`；`paramsDiff` 恢复 mood 分支+测试。
- 「用新参数重渲」流程改：bg 仍本地并入 spec；**bgm/mood 有改动时先 `POST pick-bgm`**（服务端选曲+重分析+落盘）→ 返回的 spec `ed.markSaved` 对齐 → 再渲。beatGrid 因此**自动闭环**（P1 那条「换曲后 beatGrid 仍是旧曲」的 title 提示删掉）。前端不再拼绝对路径（P1 的 /api/bgm `dir` 用途消失——**保留字段不删**，避免波及 bgm.test.ts，注释标记 deprecated）。
- 全程走 `ed.runExclusive`（P1 终审加的互斥）。
- [ ] **Step 1: editing 侧失败测试→实现**；**Step 2: web 改造+构建+浏览器自验**（换情绪→曲变+卡点轨刷新+manual 点保留；改 5 参数仍零请求直到点重渲）。
- [ ] **Step 3: 提交** `git commit -m "feat(web): mood 自动选曲接入——换曲重析节拍一体，卡点闭环"`

---

### Task 6: web — 成片库批量审片 + perf/发布展示回工位

**Files:**
- Modify: `apps/web/src/pages/workshop/LibraryTab.tsx`、`apps/web/src/pages/WorkshopPage.tsx`（E 键跳剪辑台需把 setTab+selectItem 传下去）

**Interfaces（实施说明 §7/§8-10）:**
- 布局改 **6 列网格**（`grid-cols-6`，≥1440；窄屏降列），卡=竖版缩略（video 元素 preload=metadata）+ StatusTag + 元信息。
- **键盘**（tab 激活时挂 window，input 聚焦时旁路）：`J/K` 下/上移焦点卡（滚动跟随）、`Space` 播放/暂停焦点卡、`A` 通过（PATCH approved，`danger:false` 的轻 confirm 或直接执行+可撤销提示——**裁决：直接执行**，批量流不打断，UI 闪一条「已通过 ✓」）、`R` 打回（video 行不动库、卡片标记本地「已打回」态待重做——与 P0 派生一致不新增状态列）、`E` 打开剪辑台（切 tab+选中对应 ContentItem——video 需回查 sourceAssetId，`content-items` 的 render.assetIds 有映射，从 props 传入 contentItems 查）。
- **批量**：卡片 checkbox + 顶部批量条（高 28）：「批量通过」（逐个 PATCH，失败逐条列出）、「批量重渲」（逐个 POST render——有 spec 的走 renderFromSpec 端点，无 spec 的禁用并说明）。批量条上的动作按钮描边；一屏唯一实心仍是「上传成片」。
- **perf/发布展示（P0 挂账）**：卡片扩展区显示 `published_at/platform/published_url`（已发布时）与 perf JSON 摘要（views/likes/leads，`perf` 字段自行解析）——**只展示不录入**（录入仍在分发工位，P0 终审核实过的分工）。
- 快捷键说明浮层（`?` 键或角标）。
- [ ] **Step 1: 实现**；**Step 2: 构建+浏览器自验**：造 30 条视频数据（脚本插库）验滚动流畅+选中态一致（§9 P2 验收）、J/K/Space/A/E 逐键、批量通过 3 条、perf 展示。**R 的语义如实报告实现成什么样。**
- [ ] **Step 3: 提交** `git commit -m "feat(web): 成片库批量审片——6列网格/快捷键/批量操作/表现数据回工位"`

---

### Task 7: web — 窄屏完整档 + CutPlanEditor 入口移除

**Files:**
- Modify: `editor/EditorPage.tsx`（<1040 左栏也收抽屉）、`editor/TimelinePane.tsx`（<1040 降 148 只留分镜+卡点两轨——实施说明 §4 窄屏表）、`apps/web/src/pages/WorkshopPage.tsx`（剪辑台 tab 的「卡点（旧版）」折叠区移除；`grep CutPlanEditor` 确认组件文件与 cutplan API 保留未删）、`apps/web/src/pages/workshop/LibraryTab.tsx`（手机窄宽降单列竖列表，从简）

- [ ] **Step 1: 实现**；**Step 2: 构建+浏览器自验**：1440/1240/1100/1040/900 五档各截图说明（左右抽屉触发、时间轴两轨档、库单列）；CutPlanEditor 入口不可达但 `/api/projects/:slug/cutplan` curl 仍 200。
- [ ] **Step 3: 提交** `git commit -m "feat(web): 窄屏完整档 + 旧卡点编辑器入口退役（API 保留）"`

---

### Task 8: 端到端验收 + 文档

- [ ] **Step 1: 卡点闭环真渲**：换情绪（pick-bgm 真跑 librosa）→ 卡点轨出新点 → 手动加一个卡点 → 拖 Clip 吸到它 → 保存 → 渲成片 → 抽帧/听感验切点与拍点对齐（②的 3 帧容差标准；测试 BGM 用 P1 真渲同款素材策略，自备或合成，不入库）。区分亲眼验/推断。
- [ ] **Step 2: 实施说明 §9 P2 两条**：30 条滚动流畅+选中态一致；批量快捷键可用。§7 批量审片快捷键清单逐键复核。
- [ ] **Step 3: 回归**：P0 四条 + P1 三条快速复核；全仓 `npx pnpm test` 绿（equivalence/compositions 门禁绿）。
- [ ] **Step 4: 文档**：README（波形/卡点轨、批量审片快捷键表、mood 已接入）；spec §1.3 标注 CutPlanEditor 入口已移除。**子项目③三阶段至此收官**，README 的板块描述做一次总校。
- [ ] **Step 5: 提交** `git commit -m "docs: 子项目③P2 收官——剪辑台全量落地说明"`

---

## 计划自查

**Spec 覆盖**：§6 P2 行三件（批量审片→T6；波形/卡点轨+manualBeats+CutPlanEditor 退役→T2/T4/T7；窄屏→T7）；§3.4 manualBeats→T1/T2；§1.3 入口移除→T7；P0 挂账 perf 展示→T6；P1 挂账 mood/beatGrid 重分析→T2/T5、in-app confirm→T3、moveShotBy/layoutRow 迁包→T1；实施说明 §7 快捷键→T6、§5 BeatMarker 三态→T4。
**占位符**：无 TBD；测试用例给了清单；ffmpeg peaks 给了具体命令与参数。
**类型一致性**：`allBeats/addManualBeat/removeManualBeat/snapToBeats`（T1 定义→T4/T5 消费）；`moveShotBy/layoutRow` 签名原样迁移（T1→TimelinePane 既有调用不变）；pick-bgm 返回 spec→T5 `markSaved`；waveform `{peaks,durationSec}`→T4。
**风险**：卡点「检出未用点一下切分镜」的交互语义是本计划最含糊处（实施说明只有一句话），T4 给了具体定义（最近 shot 边界吸到该拍），实施者若发现更合理解读，报告里说明并以「与手动拖拽同一函数」为底线。
