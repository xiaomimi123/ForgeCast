# 卡点编辑界面（BGM 子项目③）设计

> 日期：2026-07-25　状态：设计已确认，待写实施计划
>
> 承接 BGM 子项目①（节拍卡点混音）②（情绪选曲）。本子项目③做「让用户在 Web 上预览/微调 demo 视频的节拍卡点，再渲染」。

## 目标

现在 demo 的截图轮播卡点是渲染时在 `buildDemoSections` 里自动算的（每 4 拍一刀、吸附节拍），用户无法干预。加：**把卡点抽成一份可编辑的方案文件，用户在 Web 面板改（切换节奏 / 整体偏移 / 挪单刀 / 换配图），保存后渲染按方案来。**

**范围**：只做 **demo 模板**（唯一有轮播 + 图片的模板；story/flash/changelog 段少无图，无可编辑内容）。

**硬约束（无实时预览）**：渲染是离线批处理（~3min/条），编辑时**没有视频实时预览**。因此不做拖拽时间轴/波形，做「编辑方案 → 保存 → 渲染」的参数化面板 + 静态节拍刻度条。

## 数据模型

卡点方案存 `workspace/<slug>/cutplan.json`（普通文件，不入 DB，避免迁移）：

```json
{
  "bgm": "tense/energetic-01.mp3",
  "grid": { "t0": 0.51, "T": 0.5, "bpm": 120, "strongBeats": [2.0, 8.0], "duration": 24.0 },
  "cadence": 4,
  "offsetSec": 0,
  "cuts": [
    { "beat": 0, "shot": 0 },
    { "beat": 4, "shot": 1 }
  ]
}
```

- `bgm`：钉住的具体曲子（相对 `templates/bgm/` 的路径），保证「编辑时用的曲」= 「渲染时用的曲」，不受情绪随机选曲影响。
- `grid`：分析得到的节拍网格，**存完整结果含 `strongBeats`/`duration`**（渲染时音效/图片弹跳要用；避免重分析）。
- `cadence`：每 N 拍切一张（2/4/8）。
- `offsetSec`：整体偏移秒数，微调对齐听感（范围 ±0.3s）。
- `cuts`：每一刀 = `{ beat: 拍序号, shot: 配第几张图(0基) }`。
- 某刀实际时间 = `grid.t0 + offsetSec + beat × grid.T`。
- 自动初始化：轮播窗口 `[6, duration-6]` 内按 `cadence` 每隔 N 拍一刀（`beat` 取落在窗口内的拍序号），`shot` 循环取 `k % shotCount`。

## 组件与接口

### 纯逻辑（`packages/studio/src/hyperframes.ts`）

- `autoCutPlan(grid, shotCount, durationSec, cadence): Array<{ beat: number; shot: number }>`
  ——按 cadence 在轮播窗口 `[6, durationSec-6]` 内每隔 cadence 拍取一刀，`beat` 为拍序号（`round((t-t0)/T)`），`shot = k % shotCount`。`shotCount<=0` 返空。
- `planCutTimes(plan, shotCount): Array<{ start: number; shot: number }>`
  ——把 `plan.cuts` 每刀算成时间：`start = plan.grid.t0 + plan.offsetSec + beat × plan.grid.T`，`shot` 钳到 `[0, shotCount-1]`（`shotCount` 显式传入，来自 `readShots(...).length`；`shotCount<=0` 返空）。按 start 升序。返回给 `buildDemoSections` 用。
- `buildDemoSections` 加可选 `plan?: { cuts: Array<{start:number; shot:number}>; strongBeats?: number[] }`（**已算成时间的 cuts**，由 generate 用 `planCutTimes` 预处理后传入）：给了 `plan` 就用 plan 的 cuts（时间 + 配图 index）拼轮播，否则走现在的自动 cadence（`beats` 参）。段序吸附/单调仍走 `snapStarts`。

### generate（`packages/studio/src/generate.ts`）

demo 分支：渲染前查 `workspace/<slug>/cutplan.json`。
- **有方案**：用 `plan.bgm` 钉曲（拼 `templates/bgm/<plan.bgm>`）、用 `plan.grid`（跳过 `selectBgm` 的重分析与随机选曲）、`planCutTimes(plan)` → 传 `buildDemoSections`。音效/弹跳用 `plan.grid.strongBeats`。混音 `audioMix` 用钉住的曲 + `plan.grid.strongBeats`。
- **无方案**：完全走现在逻辑（selectBgm 情绪选曲 + 自动 cadence）。向后兼容。
- 方案里 `bgm` 指向的曲子已不存在 → 视为无方案降级（onProgress 打 ⚠）。

### 后端 API（`packages/server/src/app.ts`，Hono，仿现有 `/api/projects/:slug/...`）

- `POST /api/projects/:slug/cutplan/analyze`　body `{ bgm?, mood? }`
  → `chooseBgmPath` 解析曲（可被 body.bgm/mood 覆盖）→ `analyzeBeats` → `autoCutPlan` → 返回 `{ bgm, grid, cadence: 4, offsetSec: 0, cuts, shots: [{ rel }] }`（`shots` 来自 `readShots`）。不存盘。
  失败（无 beatPython / 无曲 / 无 shots / 分析失败）→ `{ error }` + 合适状态码。
- `GET /api/projects/:slug/cutplan` → 读 `cutplan.json`，返回方案或 `null`。
- `PUT /api/projects/:slug/cutplan`　body `{ plan }` → 校验必需字段（bgm/grid/cadence/offsetSec/cuts 类型）→ 写 `cutplan.json`。非法 → 400。
- `DELETE /api/projects/:slug/cutplan` → 删文件（清除回自动）；不存在也返成功。

### 前端（`apps/web`）

ProjectDetailPage（或其内新组件 `CutPlanEditor`）：当项目有 shots 时显示「卡点编辑 (demo)」块。
- 顶部：钉住曲名 + `[重新分析]`（调 analyze）。
- 控件：`每几拍切`（下拉 2/4/8，改则本地重算 cuts = autoCutPlan）；`整体偏移`（滑块 ±0.3s）。
- 节拍刻度条：纯 CSS，画拍点 + 每刀落点 + 配图序号（不画波形）。
- 卡点列表：每行 `#i 时间 [配图下拉] ← →`。`←/→` 把该刀 `beat` ±1，钳制不越过相邻刀（保持严格递增）。配图下拉选 0..shotCount-1。
- `[保存方案]`（PUT）、`[清除(回自动)]`（DELETE）。
- 保存后，页面现有「生成视频」按钮（tpl=demo）即按方案渲染。
- 无 beatPython / analyze 失败 → 块内提示「需配置 librosa(FORGECAST_BEAT_PYTHON) 才能编辑卡点；不编辑则渲染按自动卡点」。

## Fail-soft（逐条）
- 无 `cutplan.json` → 渲染同现在（自动情绪选曲 + 自动 cadence）。
- 方案曲子失效 / grid 缺字段 → 降级为无方案，onProgress ⚠，不崩。
- 方案 `shot` index 越界（图删了/少了）→ `planCutTimes` 钳到有效范围。
- 无 beatPython → analyze 报错、面板提示；渲染时若无方案则同①（BGM 不卡点或不加）。
- 无 shots → 不显示编辑块（demo 本就要求 shots）。

## 测试
| 层 | 用例 |
|---|---|
| `autoCutPlan` | cadence=4/2/8 在窗口内取对拍序号；shot 循环 `k%n`；shotCount=0 空；窗口太短则少刀 |
| `planCutTimes` | beat+offset+grid 算时间正确；升序；shot 越界钳制；早于窗口起点的去掉 |
| `buildDemoSections` + plan | 传 plan 用 plan 的 cuts（时间+配图），不再自动 cadence；不传 plan 行为不变（回归） |
| generate 消费 plan | 有 cutplan.json 钉曲+用 plan.grid（mock：不 spawn librosa/ffmpeg，验选曲/cuts 来源）；曲失效降级；无方案走原路 |
| API | analyze 返方案结构；PUT 存盘 + GET 读回；DELETE 删；非法 plan 400；无 beatPython analyze 报错（mock analyzeBeats） |
| Web | 浏览器手动走查：分析→改 cadence/offset/挪刀/换图→保存→渲染按方案（纯前端消费 API，跟前几次 Web 页一样手动验） |

## 不做（本子项目）
- 波形图、自由拖拽时间轴、视频实时预览（受离线渲染 ~3min 限制）。
- 非 demo 模板的卡点编辑（story/flash/changelog 无可编辑内容）。
- 多方案版本管理 / 撤销重做（单个 `cutplan.json` 覆盖式保存）。
- 服务端强制校验 beat 落点合法性（信任前端 ←/→ 的钳制；后端只校验字段类型）。
