# 找项目板块：手动投喂 URL 前端入口 + 评分权重可配置 设计

## 背景

审查"找项目"板块功能清单时发现两处缺口：

1. **手动投喂单个 repo URL 只有 CLI 入口**（`forgecast scout --add=<url>`），后端 `addRepo`/`POST /api/candidates/add` 都齐全，但前端页面完全没有触发方式。
2. **评分权重硬编码**：`packages/scout/src/score.ts` 的三维评分上限（`rebrandCost` 30 / `buyerClarity` 40 / `visualAppeal` 30）写死在代码里（mock 的 `heuristicScore`、live 的 LLM prompt 文案、`parseScoreJson` 的 clamp 逻辑三处都是），无设置页可调。

用户要求：补前端投喂入口；评分权重开放到设置页可手动调整。

## 已与用户对齐的关键决定

1. **投喂 URL 交互**：加一个按钮，弹出输入对话框（不做常驻输入框）。
2. **权重可调范围**：三维各自独立调整，不要求总和固定 100 分（换皮成本可以设更低、买家清晰度可以设更高，互不联动）。
3. **老候选处理**：改权重后不自动/不提示重新评分，老分数原样保留，用户自己判断要不要点现有的"全部重新评分"按钮。

## 现有系统摸底

- `packages/core/src/settings.ts`：`SETTING_KEYS` 白名单 + `getAllSettings`/`setSettings`（幂等 upsert，仅白名单 key）+ `applyStoredSettings`（stored 值覆盖到 `ForgecastConfig`，优先级 stored > env > 默认）。所有配置值都以字符串存 `settings` 表（数字型配置如 `auto_scout_time` 同样是字符串）。
- `packages/core/src/config.ts` 的 `ForgecastConfig`：`{root, llm, github, video, tts, paths}` 几大段，`loadConfig()` 负责从 env 拼出默认值。
- `packages/server/src/app.ts`：`settingsView()`（L122）把 `ctx.config` 里非密字段整理成前端可读的 JSON；`PUT /api/settings`（L145）按白名单接收字符串字段、写 `settings` 表、`refreshCtx(ctx)` 就地生效。
- `apps/web/src/pages/SettingsPage.tsx`：`Draft` 草稿对象 + `Field` 组件 + 保存/回填模式，LLM/TTS/GitHub 各是一个独立"卡片"区块。
- `packages/scout/src/score.ts`：`heuristicScore(meta, readme)`（mock，不接收 ctx，纯函数）、`scoreCandidate(ctx, meta, readme)`（live 分支读 `ctx.llm`）、`parseScoreJson(text)`（不接收 ctx，纯函数）——三处都要通到配置。
- `apps/web/src/pages/board/CandidateCard.tsx` 的 `DIMS`（硬编码 `max: 30/40/30`）：唯一消费方是 `CandidateDrawer.tsx` 的评分条渲染，无其它引用。
- `POST /api/candidates/add`（`app.ts` L411）：已存在，接 `{url: string}`，任务队列异步跑 `addRepo(ctx, url)`。前端本次**零后端改动**，只加 UI。

## 设计

### 功能1：投喂 URL 弹窗（纯前端）

`apps/web/src/pages/ScoutPage.tsx`：
- 新增按钮"+ 投喂"，插入现有 5 个操作按钮之后，`disabled` 表达式并入现有互斥禁用逻辑（`scanning || scanningBreakouts || rescoringAll || backfillingSummary`，本功能不新增忙碌态——投喂走已有任务队列+SSE日志展示，复用现有 `logs`/`scanning` 逻辑即可，不需要单独的 loading 状态，因为它跟"抓取候选"共享同一套日志区域和任务订阅模式）。
- 新增 `addUrlOpen`（布尔，控制对话框显隐）+ `addUrl`（输入框受控值）两个状态。
- 对话框：一个输入框（placeholder 提示可以贴 `https://github.com/owner/repo` 或 `owner/repo`）+ "投喂"确认按钮 + "取消"按钮。简单的 fixed 定位遮罩层，跟仓库现有的其它弹窗（若有）风格一致；若现有代码库里没有先例弹窗组件，就地写一个最小实现（`fixed inset-0 ...` 遮罩 + 居中卡片），不引入新依赖。
- 提交逻辑：`POST /api/candidates/add`（body `{url: addUrl}`）拿到 `taskId`，复用现有 `subscribeTask` 模式把进度打进 `logs`，成功/失败后关闭对话框、清空输入框、`invalidateQueries(['candidates'])`。
- 空输入校验：提交前 trim 非空校验，空值不发请求、给出提示。

### 功能2：评分权重可配置

**`packages/core/src/settings.ts`**：`SETTING_KEYS` 追加三个 key：`scout_weight_rebrand`、`scout_weight_buyer`、`scout_weight_visual`（字符串存整数）。

**`packages/core/src/config.ts`**：`ForgecastConfig` 新增一段：

```ts
scout: { weights: { rebrandCost: number; buyerClarity: number; visualAppeal: number } }
```

`loadConfig()` 默认值 `{ rebrandCost: 30, buyerClarity: 40, visualAppeal: 30 }`（跟现状完全一致，未配置时行为不变）。

**`applyStoredSettings`**：读 `scout_weight_*` 三个 stored 值（非空才覆盖，沿用现有 `put()` helper 模式），`Number()` 转换、非法数字（`NaN`）或负数忽略不覆盖（保留默认/已有值，不让脏输入把权重改成 `NaN`）。

**`packages/scout/src/score.ts`** 三处改动：
- `heuristicScore(meta, readme)` 签名加一个 `weights` 参数：`heuristicScore(meta, readme, weights)`，内部 `Math.min(30, ...)` 改成 `Math.min(weights.rebrandCost, ...)`（三处对应）。调用方 `scoreCandidate` 在 mock 分支传入 `ctx.config.scout.weights`。
- live 分支 prompt 文案里硬编码的 "0-30"/"0-40"/"0-30" 改成读 `ctx.config.scout.weights` 插值拼字符串。
- `parseScoreJson(text, weights)` 加参数，`clamp(v, 30)` 等三处改用 `weights.xxx`。调用方 `scoreCandidate` 传入同一份 `ctx.config.scout.weights`。

**`packages/server/src/app.ts`**：
- `settingsView()` 加一段 `scout: { weights: { ...ctx.config.scout.weights } }`（非密字段，直接回显数字，不用打码）。
- `PUT /api/settings` 沿用现有白名单机制，`scout_weight_*` 三个 key 自动被现有循环覆盖（不需要特殊分支，跟其它字符串字段一视同仁）。

**`apps/web/src/api.ts`**：`SettingsView` 类型加 `scout: { weights: { rebrandCost: number; buyerClarity: number; visualAppeal: number } }`。

**`apps/web/src/pages/SettingsPage.tsx`**：新增"评分权重"卡片区块，三个独立数字输入框（`type="number"`, `min={0}`），`Draft` 加三个字符串字段（跟现有字段一样的"留空=不改"惯例——但权重字段没有"打码"语义，回填逻辑改成"直接回填当前数字转字符串"而不是留空，跟 LLM key 那种敏感字段的空白占位逻辑不同，更接近 `llm_base_url` 这类可直接回显的非密字段）。

**`apps/web/src/pages/board/CandidateCard.tsx`**：`DIMS` 从硬编码常量改成一个函数 `buildDims(weights): typeof DIMS`（或者保留名字 `DIMS` 但改成接收 weights 参数的函数），`CandidateDrawer.tsx` 需要拿到当前权重配置——通过 `useQuery(['settings'], ...)` 复用跟 `SettingsPage.tsx` 相同的 query key（React Query 会去重缓存，不会重复发请求），取 `settings.data.scout.weights` 传给 `buildDims`。评分条 `Bar` 组件本身的百分比计算 `Math.min(100, (value/max)*100)` 已经天然封顶不会溢出（老候选实际值超过新设更低上限时，条形图直接顶满 100%，不会有视觉错误），不需要额外处理。

## 测试

- 前端不加自动化测试（`ScoutPage.tsx`/`SettingsPage.tsx`/`CandidateCard.tsx` 均无组件测试先例），走 `pnpm --filter web exec tsc --noEmit` + 人工点击验证。
- `packages/scout/test/score.test.ts`：
  - `heuristicScore`/`scoreCandidate` mock 分支传入自定义 `weights`（如 `{rebrandCost: 10, buyerClarity: 60, visualAppeal: 5}`）验证封顶值跟着变、默认 `{30,40,30}` 时行为跟现有测试完全一致（不破坏现有用例）。
  - live 分支：假 LLM 返回超出自定义上限的值，验证 `parseScoreJson` 按传入的 `weights` 而非硬编码 `30/40/30` 夹取。
  - live 分支 prompt 文案里插值出的数字跟传入的 `weights` 一致（用假 LLM 捕获 `prompt` 断言包含期望数字）。
- `packages/core/test`：`applyStoredSettings` 新增用例——`scout_weight_*` 非空数字正确覆盖默认值；空/非法字符串（`NaN`、负数）不覆盖，`config.scout.weights` 保留默认 `{30,40,30}`。
- `packages/server/test`：`GET /api/settings` 返回体含 `scout.weights`；`PUT /api/settings` 传 `scout_weight_*` 后再 `GET` 能读到新值。

## 不做的事

- **不做总和联动**（不强制三维和为100，各自独立数字输入）。
- **不自动/不提示重新评分老候选**——权重只影响以后新评的候选，老分数原样保留。
- **不做权重范围硬性上限校验**（只挡 `NaN`/负数，不限制"最大能设多少"，用户自己对自己的配置负责）。
- **不新增弹窗组件库依赖**——投喂对话框就地写最小实现。
- **不改动候选评分排序逻辑**（`GET /api/candidates` 仍按 `score` 总分降序，权重只影响总分怎么算出来，不改排序规则本身）。
