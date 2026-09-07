# 预设与模板固化（排版工作台第二期 C）设计

> 日期：2026-09-08　状态：设计已确认，待写实施计划
>
> 「可持续复用的特效与排版工作台」四方向：A 画布拖拽（done, PR #5）→ **C 预设与模板固化（本期）**；B 特效库、D 素材图层各自后续独立 spec。

## 0. 决策记录

| 决策点 | 结论 |
|---|---|
| 第一期范围 | 三样全做：图层样式预设 + 整版排版模板 + 品牌 kit |
| 作用域 | 样式/排版全局（跨项目复用）；品牌 kit 按项目 |
| 套用策略 | 按角色对位，多余保持原样（不做严格同构/智能插值） |
| kit 内容与时机 | 主色/强调色/标题字号尺度/CTA 文案；生成期 lower 注入，已出片不回刷（剪辑台可手动刷） |

## 1. 数据模型与存储

全部 SQLite（全局库天然跨项目）：

- **`style_presets`（全局）**：`id / name / layer_kind('text'|'caption'|'image'|'shape') / payload JSON / created_at`。payload = 层的 `style`（可选含 x/y 位置，存时勾选）+ `effects` 开关组合。
- **`layout_templates`（全局）**：`id / name / template(六模板之一) / ratio / payload JSON / created_at`。payload = 按角色条目 `[{ role, style, effects }]`；角色从 `from`+kind+同角色序号推导。只在同模板视频间套用。
- **品牌 kit（按项目）**：`projects` 表加 `brand_kit` JSON 列：`{ primaryColor?, accentColor?, titleScale?, ctaText? }`，字段可空——空则不注入用模板默认。

**核心原则：预设是值的快照，不是引用**——改/删预设不反噬已出片；套用永远是显式动作。

## 2. 套用逻辑（editing 纯函数 + lower 注入）

### 样式预设（单层，剪辑台）
- `deriveLayerRole(layer)`：`from`+kind+序号 → 角色键（`pain`/`card#0`/`cta`/`cap`/`manual-text#1`…），纯函数。
- `applyStylePreset(spec, layerId, preset, { withPosition })`：style 合并（`withPosition:false` 剔除 x/y）、effects 整组替换、`overridden` 置位。一次套用=一步 undo。
- `applyStylePresetToKind(spec, kind, preset, opts)`：同 kind 全部层一键统一（高频动作）。

### 排版模板（整版，剪辑台）
- `extractLayoutTemplate(spec)` → `[{role, style, effects}]`（跳过 video 底片层）。
- `applyLayoutTemplate(spec, payload)`：逐层按角色查条目，命中套 style+effects（**含** x/y/width/fontSize——排版模板的意义就是位置）；新视频多出的层不动、模板多的条目忽略。一步 undo。
- **时间轴（start/duration/track）不进模板**——节奏由 lower 按内容算，套时间会打乱同轨不重叠；本期只固化视觉与排版。

### 品牌 kit（生成期）
- `applyBrandKit(spec, kit)`：lower() 收尾统一调用。`primaryColor`→CTA/强调层 color/bg；`accentColor`→高亮卡背景；`titleScale`→标题层 fontSize 乘数；`ctaText`→CTA 文案替换（沿用现有品牌名烧录位）。
- 生成时注入、已出片不回刷；剪辑台另给「应用品牌 kit」手动按钮。纯数据变换，与 mock/render 双模式无关。

## 3. UI 与接口

### server（薄 CRUD）
- `GET/POST/DELETE /api/style-presets`、`/api/layout-templates`（POST 校验 payload 形状、name 非空唯一）。
- `GET/PUT /api/projects/:slug/brand-kit`（校验色值格式、titleScale 0.5–2、文案长度）。
- 不做版本化/回收站（值快照，删了不影响已出片）。并发 last-write-wins。

### 剪辑台
- **Inspector 样式组**加预设条：同 kind 预设下拉 +「套用」「套用到全部同类」+「存为预设…」（in-app 弹层输入名+勾「含位置」）。
- **EditorPage 工具栏**「版式」菜单：「存为版式…」/「套用版式」（同模板列表，busy 禁用）/「应用品牌 kit」。
- **设置页**加「品牌 kit」块（按项目）：主色/强调色（色板输入）/标题字号尺度/CTA 文案。
- 预设管理只做下拉内删除小按钮，不做独立管理页。

### 出片链路
- 出片参数加可选「排版模板」下拉（同模板版式，选了则 lower 后、渲染前套用）；kit 有值自动注入。

## 4. 边界与测试

**边界**
- 套用只写图层 `style/effects`，语义层/时间轴不碰（lower 单向铁律）；`overridden` 置位。
- 手动层无 `from` → 角色 `manual-<kind>#n`；模板无对应条目则不动，静默。
- kit 字段可空可局部；`ctaText` 空不替换。
- 删预设不影响已出片/已套用 spec。

**测试**
- editing：`deriveLayerRole`/`applyStylePreset(ToKind)`/`extractLayoutTemplate`/`applyLayoutTemplate`/`applyBrandKit` 全量单测+变异（角色对位错一位必须红；withPosition:false 泄漏 x/y 必须红）；零 Node 守护。
- studio：lower+kit 注入断言（**kit 空=零变化**，门禁思路）。
- server：三组路由正反用例。
- ①②门禁红线：不套预设/kit 空时既有 fixture 渲染零变化。
- 端到端：真渲「套版式+kit」的片抽帧验色/字号/位置；浏览器走查存→套→undo→跨视频套。

## 5. 非目标

跨模板套用；智能插值；预设导出/分享；logo 图层（D 期）；时间轴节奏进模板；预设管理页。

## 6. 风险与取舍

- 角色推导依赖 lower 产出的 `from`/id 命名稳定性——六模板命名已固化多期未变；若未来改名，旧模板条目对不上=静默不动（安全侧）。
- `titleScale` 乘数作用于 lower 算出的字号，与画布手动 fontSize 是两个来源——手动值（overridden）优先，kit 不覆盖已手调层。
