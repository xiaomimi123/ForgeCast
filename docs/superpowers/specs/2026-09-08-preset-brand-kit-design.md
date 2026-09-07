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

---

## 附录：实现偏差与落地注记（2026-09-08 收官补记）

六个任务实施完毕（`packages/editing` 纯函数 → `packages/studio` kit 注入 → `packages/core`+`packages/server` 存储与 CRUD → `apps/web` 四处入口 → 端到端真渲）。以下是**实现与本 spec 正文不同**、或正文没写而实施中定下的关键点，按裁决顺序记：

1. **`titleScale` 得自带一张基准字号表**。正文 §6 写的是「乘数作用于 lower 算出的字号」，但 lower **根本不产 `fontSize`**（字号归模板 CSS），而唯一带显式 `fontSize` 的层又是手调过的、按规则要跳过——照正文实现等于死字段。落地方案：`applyBrandKit` 内建「画幅取向 → 模板 → `cssClass`」三级基准字号表（值抄自 `packages/compositions/src/styles/*.css` 并在注释里注明来源行），生效时写 `round(基准 × scale)`；未知模板（`custom-*`）回落 flash，与渲染侧 `SpecView` 的模板类名回落同口径；横竖两张表分开列（同名类在不同模板下并不同值）。代价是把 CSS 数值抄了一份，故 `studio/test/brand-kit.test.ts` 有一条**读 CSS 正则抽 `font-size` 与表逐项比对**的防漂移断言，改 CSS 会先红。
2. **changelog 天然在 kit 作用域外**。它的 CTA 层 `cssClass` 是 `brand` 而非 `cta`，且**品牌名在第一行**（其余五模板是 `${cta}\n@${brandName}`，changelog 反过来）。需求把 CTA 目标定义为「类名含 `cta` 的层」，changelog 因此落在域外——正好避开「换第一行会误删品牌名」这颗雷（品牌名烧录是回归过多次的红线区）。不为它扩表；日后若要覆盖，需要单独的行序语义。
3. **「×」删预设放在下拉右侧、删的是当前选中项**，不是每个选项内嵌一个删除按钮——原生 `<option>` 里放不了按钮，为此自绘浮层不划算。
4. **`apps/web` 深导入 `@forgecast/studio/src/brand-kit`**（不是包入口，也不在 `editing` 里重导出）。包入口会把 `@remotion/renderer`、`better-sqlite3` 拖进浏览器包；在 `editing` 重导出则会给「零 Node 依赖」的 editing 加一条指向 studio 的运行时边。同 `@forgecast/compositions/src/SpecComposition` 的深导入先例。**代价记账**：`brand-kit.ts` 目前没有「零 Node 依赖」的纯度门禁，日后有人往里加 Node 依赖不会被测试拦住。
5. **`applyLayoutTemplate` 照常置 `overridden: true`**（与正文一致），由此派生一条用户可见语义：**剪辑台里手动「应用品牌 kit」会跳过刚被套过版式的层**。这是「kit 不覆盖用户选择」的延伸，UI 如实报出跳过层数。出片链路里不冲突——顺序是**先 kit、后版式**，版式赢。
6. **`applyBrandKit` 的「空转」判定必须逐层比引用**：非空 kit 即使一层都没改也会返回**新的 spec 对象**（只有内层 Layer 按需复用引用）。Web 端按 `next === spec` 判空转会把「全被跳过」误报成「已应用」，还白压一格 undo；实现改成数 `touched` 层数。
7. **「含位置」在存预设的那一刻定死**：不勾就把 `x/y` 剔掉再存，套用时无条件 `withPosition`——payload 自身即全部真相，避免「存的时候一套语义、套的时候另一套」。
8. **`studio` → `editing` 是一条真的运行时依赖**（`generate.ts` 值导入 `applyLayoutTemplate`），与既有 `compositions ↔ studio` 同模式，评审放行。

### 端到端真渲验收结果（Task 6）

临时 workspace + 独立 db + `app.fetch` 真路由 + `FORGECAST_VIDEO_MODE=render`，flash 竖屏、`bg=none`/`bgm=none`，kit = `{primaryColor:'#ff3366', ctaText:'扣1领部署文档', titleScale:1.3}`：

- **版式跨文案一致**：把卡片层设成 `x=120 / y=700 / width=840 / fontSize=72` → 存版式 → 第二条**换文案**（pain → sideline）出片带 `layoutTemplateId`。抽帧量卡片黄边包围盒：源片 `x=108, y=693, x1=962`，第二条 `x=108, y=693, x1=962`——**三项偏差 0px**（验收线 ±3px）；卡内首行文字墨迹带两片同为 `y=760–827`（高 68px），字号一致。（帧坐标与 spec 的 `x/y` 之间有恒定 −12/−7px 差，来自全片 Camera 缓推 `scale 1→1.06`，两条片同口径，非本次改动引入。）
- **CTA 主色**：第二条 CTA 帧的最高频亮色为 `#ff3466 / #ff3366`（H.264 色度抖动 ±2），对照组同一层为 `#ffffff`、粉色像素 0 个。
- **CTA 文案与品牌名**：第二条 CTA 帧目视为「扣1领部署文档」+「@快客通」两行（墨迹两条行带，高 39 / 83px）；对照组是原文案折两行 + 品牌名共三条行带——**替换只发生在第一行，第二行品牌名仍在**。
- **`titleScale`**：spec 里标题 `fontSize = 130 = round(100 × 1.3)`；帧上标题单行墨迹高 124–125px，对照组 96px，比值 1.29–1.30。
- **对照组等价**：清掉 kit、不带版式出的第三条，与**本功能上线前的基线提交（15e5dbf）**在同参数下渲出的 mp4 **逐字节相同**（1,593,584 B），8 个抽样时刻的 rawvideo 帧亦逐字节一致；落盘 spec 除 `createdAt` 时间戳外逐字节相同。

全仓测试：123 个测试文件、1333 条用例全绿（Node 20.20.2，一次跑过，无 flake 重跑）。

### 已知遗留（记账，不阻塞）

- **服务端 `layoutTemplateId` 只校验 `template`、不校验 `ratio`**：横屏版式可以被套进竖屏出片（x/y 坐标系错位）。前端下拉按 `template + ratio` 双筛能防呆，直连 API 挡不住。**下一波必修**（server 加 ratio 校验 + 测试）。
- `preset-routes.ts` 里 `POST` 的 null body 走 500 而非 400（一行修）；`resolveBrandKit` 不复用 `validateBrandKit`，脏结构会带着 NaN 进 spec。
- `api.ts` 的 `deleteLayoutTemplate` 是死导出——版式没有删除 UI，与样式预设不对称（接 UI 或删函数）。
- 设置页 `ctaText` 未 `trim` 就发（与色值处理不一致）；hex 输入框可加 `pattern` 预校验。
- `brand-kit.ts` 缺「零 Node 依赖」纯度门禁（见上第 4 条）。
- 五模板的动效层在画面里仍是文档流堆叠、CTA 会被裁到画面顶（真渲抽帧可见）——**既有视觉债**，对照组同样如此，与本期无关。
