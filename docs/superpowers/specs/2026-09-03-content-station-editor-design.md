# 做内容工位重构 + 剪辑台（子项目③）设计

> 日期：2026-09-03　状态：设计已确认，待写实施计划
>
> 这是「做内容重构」四个子项目里的第③个：① 素材包 schema（done）→ ② Remotion 渲染器 + 实时预览（done）→ **③ 生成前剪辑台** → ④ 视频合成能力。
>
> **视觉与交互规格的唯一权威是用户提供的 [`docs/剪辑台-实施说明.md`](../../剪辑台-实施说明.md)**（下称「实施说明」）：design tokens（§3）、布局尺寸（§4）、组件规格（§5）、三条硬交互规则（§7）、验收清单（§9）一律以它为准，本 spec 不复述、只在冲突处裁决。本 spec 负责：与既有架构的对接方式、数据流、包边界、分阶段与测试策略。

## 0. 范围升级说明

子项目③原名「生成前剪辑台」。用户的实施说明把范围升级为**整个「做内容」工位的重构**：7 个二级 tab 压成 3 个（剪辑台 / 成片库 / 模板库）、封面+文案+视频合并为一条内容卡、全套骨架屏/空态/失败态、成片库批量审片。本 spec 按升级后的范围写。

剪辑台四个维度**全做**：A 选素材与排序、B 改文字与字幕、C 调版式与特效、D 对时间轴与卡点，另加 **LLM 重写某段**。

## 1. 与既有架构的三条对接裁决

实施说明是在不了解 ①② 内部架构的前提下写的，三处与现状有张力，均已与用户确认：

### 1.1 ContentItem = 展示层聚合，不动库表

实施说明 §6 说「一条内容是一个对象，不是三条记录」。落地为**服务端聚合视图**：`assets` 表保持 copy / cover / video 各一行不变，新接口把同一条内容的三行聚成实施说明定义的 `ContentItem` 形状返回。**`VideoSpec` 仍是渲染真相**（①②的全部门禁与渲染链不动），历史数据零迁移。

`ContentStatus` 是**派生的，不新存**：

| 派生条件 | 状态 |
|---|---|
| 无 video asset | `script_ready` 待出片 |
| 渲染任务在任务队列跑 | `rendering`（进度从现有任务 SSE 来） |
| 渲染任务失败 | `failed`（error 从任务结果来） |
| video asset 为 draft | `review` 待审 |
| video asset 为 approved | `approved` 已通过 |

「通过并送分发」= 现有 ops `approveAsset`（日历/分发链路零改动）；「打回」= 回到剪辑态，不动库。`HOOK_LABEL` / `STATUS_LABEL` 展示映射照实施说明 §6 做成常量表，组件里不硬编码中文。

### 1.2 逐镜重渲取消，Player 即时预览替代

实施说明的「改字即改画面：失焦触发该镜重渲」「只重渲这一镜」假设的是服务端逐镜出片。②送来的 `@remotion/player` 让改动**当帧即时可见、零请求**，比逐镜重渲更快且零成本；成片渲染（`renderMedia`）是整条出 mp4，不存在段渲拼接路径。

裁决：**「只重渲这一镜」按钮取消**；分镜行操作条改为 `换画面素材` / `加卡点` /（LLM）`重写这段`。成片只有整条「渲成片」一个动作。**存与渲分开**：「保存」秒级写 spec JSON；「渲成片」显式按钮走现有任务队列。

### 1.3 剪辑台接管卡点，CutPlanEditor 退役

时间轴直接拖 `spec.layers` 的 `start/duration`，卡点吸附读 `spec.audio.beatGrid`。CutPlanEditor（cutplan.json 那套）保留不动但**不再扩建**，新视频一律用剪辑台；入口在 P2 卡点轨落地后从工坊移除（cutplan API 与数据保留，老项目还能用）。

## 2. 已确认的能力决策

| 决策点 | 结论 |
|---|---|
| 版式粒度 | 全量 `LayerStyle`（位置/尺寸/字号/颜色/对齐/透明度）+ 特效按图层勾选开关（固定类型集 decode/fadeIn/slideUp/pulse/demote/exit + at/duration 参数，不造新特效类型） |
| 撤销 | 会话内 Ctrl+Z / Shift+Ctrl+Z（内存历史栈，刷新即清）+「重置为生成结果」（服务端整条重 lower，丢弃全部手工改动，前端弹确认）。不做磁盘版本快照 |
| LLM 重写某段 | 做。**铁律：自带 mock 分支**（mock 不借道 ctx.llm——那返回的是文案 fixture） |
| emphasis 高亮 | 实施说明 §6 Shot 的「被模板放大的词」区间**第一版暂缓**——现有模板没有可派生的放大词规则，硬造会假 |

## 3. 数据流

### 3.1 新增接口（全部挂在现有 Hono server）

| 接口 | 作用 |
|---|---|
| `GET /api/projects/:slug/content-items` | ContentItem 聚合（§1.1）。video 通过 `spec.semantic.sourceAssetId` 关联回 copy，cover 挂在 copy 上 |
| `GET /api/projects/:slug/specs/:videoId` | 读 spec（编辑器载入用；替代直接抓 /files 静态文件，便于校验与演进） |
| `PUT /api/projects/:slug/specs/:videoId` | 「保存」。服务端做基本形状校验（version/layers 数组/同 track 不重叠兜底）+ 路径防穿越（照 cutplan 接口先例） |
| `POST /api/projects/:slug/specs/:videoId/render` | 从既有 spec 直接渲成片（renderRemotion + mixAudio + 登记 assets），**不**重新生成文案。走现有任务队列 + `/api/tasks/:id/events` SSE |
| `POST /api/projects/:slug/specs/:videoId/reset` | 「重置为生成结果」：从语义层整条重 lower |
| `POST /api/projects/:slug/specs/:videoId/rewrite-section` | LLM 重写某段（§3.3） |

### 3.2 Shot 是派生视图，不落库

实施说明 §6 的 `Shot`（分镜）在实现里是**从 spec 派生的编辑视图**：语义 section + 其对应图层的时间范围。编辑动作直接落到 `layers`（改字 = 改 `layer.content.text` + 打 `overridden: true`）；`from` 字段是图层→section 的既有关联。派生函数放 `@forgecast/editing`（§4），有单测。

### 3.3 LLM 重写某段

`rewriteSection(ctx, spec, sectionId)`（studio 新能力）：mock 走启发式 fixture / live 走 LLM。落地方式：**重生成该段文本 → 整条重 lower → 按 id 把 `overridden` 图层原样覆盖回去**——效果等价于 ①spec 设想的「只重 lower 这一段 + 保护手工改动」，但不需要给 `lower()` 做段级拆分（成本高、且段间时间联动本来就该整条重排）。前端在有 `overridden` 图层会被该段重排波及时弹确认（①spec 要求的提示）。

### 3.4 手动卡点

`BeatMarker` 三态里的「手动加的」需要持久化：`AudioSpec.beatGrid` 加可选 `manualBeats?: number[]`（秒）。可选附加字段、`lower()` 不产它、①门禁不比它——与 ② 加 `bgVariant` 同一先例。自动重分析不覆盖手动卡点（实施说明 §5 的规定）。

## 4. 包边界：`@forgecast/editing`

新包，**纯 TS、零 Node 依赖、浏览器安全**（复制 compositions 的 no-node-deps 守卫，含 ② 终审修过的完整正则 + dependencies 白名单）。承载所有可测的编辑逻辑：

- 编辑操作纯函数：改字、挪 `start/duration` 的**同轨不重叠钳制**、`beatGrid` 吸附、特效开关、LayerStyle 修改
- undo 栈 reducer（不可变 spec 快照）
- Shot 派生（§3.2）、「改动 N 项」的参数 diff

`apps/web` 只做装配（**无测试框架的项目约定不破**）；逻辑全在包里用 vitest 测。对 `@forgecast/studio` 只能 `import type`（取 VideoSpec 类型，同 compositions 先例）。

## 5. 前端结构

### 5.1 视图切换（修正：本应用无路由）

写计划前核实：当前 app 是**纯 state 切换、不占 URL**（`Rail.tsx` 注释明写「单页 tab 切换（不占 URL）」，「板块重组」那轮已把 react-router 移除）。实施说明 §2 的路由是建议而非硬要求，遵循现状：

- 三个视图（剪辑台 / 成片库 / 模板库）= WorkshopPage 内的 state tab，不引入路由库。
- 「选中某条内容」= 剪辑台内的 state；项目选择器只作用于剪辑台；成片库跨项目。
- 深链/可分享 URL 不在本期（将来引入路由是独立决策）。

### 5.2 三栏装配与单一真相

`EditorPage` 按实施说明 §4 尺寸表搭骨架；`QueuePane` / `StagePane` / `InspectorPane` / `TimelinePane` 四个子组件各管一栏。**编辑态只有一个真相**：`useEditorState` 持有当前 spec（内存态），所有面板读写它；Player 的 `inputProps` 直接喂内存 spec（复用 ② 的 `rebaseSpecForPreview` 做路径重定基）——任何改动不保存也当帧可见，「保存」只是 PUT 回磁盘，未保存时 toolbar 显脏标记。

### 5.3 Player↔时间轴同步

PlayerRef 的 `frameupdate` 事件驱动时间轴播放头；点时间轴/拖播放头调 `seekTo`。分镜行、时间轴 Clip、播放头三方联动选中态（实施说明规定 selected 全列唯一）。

### 5.4 时间轴

照实施说明 §5：Clip 用 `flex: 时长×10 1 0`；BeatMarker 三态菱形。拖 Clip 边缘改时长、拖中间挪位置，钳制与吸附调 `@forgecast/editing`。**P1 做刻度+分镜+字幕三轨，BGM 波形轨与卡点轨在 P2**（实施说明同款切法）。

### 5.5 右栏暂存

参数改动只落本地 state，表头计「改动 N 项」+ 标签前 accent 圆点；点「用新参数重渲」才把参数并进 spec、保存并提交渲染任务（实施说明硬交互规则 3）。

## 6. 分阶段：一份 spec，三份实施计划

照实施说明 §8 的 P0→P1→P2，**每阶段独立实施计划、独立分支、做完合并 + 用户浏览器验收一轮**再往下（实施说明 §0 的叮嘱）。

| 阶段 | 内容 | 验收（取实施说明 §9） |
|---|---|---|
| **P0 结构** | ContentItem 聚合接口 + 列表合成一张卡；7 tab→3 tab + 路由重定向（成片库先做基础列表页承接旧「成片」tab，批量审片在 P2 升级；剪辑台 tab 先挂现有预览+生成能力的过渡装配，P1 换成真剪辑台）；工位条压面包屑；删除进 `⋯` 菜单+二次确认；骨架屏/空态/失败态全量替换「加载中…」 | 全程不换页做完一条片；一屏一个黑实心按钮；看不到库内枚举；失败态可读 |
| **P1 剪辑台本体** | 三栏骨架 + Player 即时预览 + 分镜列表（改字即时可见）+ 右栏参数暂存 + 时间轴分镜/字幕轨 + spec GET/PUT/render/reset 端点 + `@forgecast/editing` 包 + undo + LLM 重写（mock 全链路）+ 全量 LayerStyle/特效开关 | 时间轴 1440/1280/1100 三宽度不错位；右栏改 5 参数零请求；**编辑→保存→真渲一条，抽帧确认改动进了 mp4** |
| **P2 效率** | 成片库批量审片（6 列网格 + J/K/Space/A/R/E）+ BGM 波形轨/卡点轨（含 manualBeats、CutPlanEditor 入口移除）+ 窄屏抽屉 | 30 条滚动流畅、选中态一致；批量快捷键可用 |

## 7. 测试策略

- **`@forgecast/editing`**：纯函数全量单测；钳制/吸附这类闸门做**变异实验**（删掉钳制条件必须有测试红——②的教训：「加了测试」≠「测试有牙」）。
- **server**：ContentItem 聚合 + 状态派生用**表驱动**测试收口（`(assets 组合, 任务态) → 期望状态`）；spec PUT 校验、rewrite-section mock 链路、render/reset 端点走 stub 模式。
- **studio**：`rewriteSection` mock/live 分支 + overridden 覆盖回去的合并逻辑单测。
- **web**：不引入测试框架。每阶段一轮浏览器人工验收（§6 表）。
- **既有门禁必须全绿**：①的 `equivalence.test.ts`、②的 compositions 内容断言门禁——编辑后的 spec 走同一个 SpecView，它们顺带守住剪辑台的产出。

## 8. 非目标

- 不做视频合成/绿幕/口播叠加（子项目④；`<Video>` 包 `<Sequence>`、trimStart 等字段都留给它）。
- 不做磁盘版本快照 / 多人协作。
- 不做移动端剪辑台（实施说明：手机只给成片库竖列表 + 全屏播放器，P2 范围内从简）。
- 不改 `lower()` 的产出结构（story 气泡 / insight 卡片的 ① 视觉债另行处理，见 memory `forgecast-lower-visual-debt`）。
- 不动 TTS / BGM / 卡点算法本身。

## 9. 风险与已知取舍

- **样式层无自动门禁**（②终审确认的最大洞）：剪辑台大量动 UI，只有人工验收兜底。tokens 抽成 CSS 变量后靠实施说明 §9 清单逐屏核。
- 派生状态依赖任务队列内存态：server 重启后「渲染中」会退回派生的静态判断（任务丢了 = 按 assets 现状显示），可接受。
- `rewriteSection` 整条重 lower 会重排未 overridden 图层的时间——这是设计使然（段间时长联动），确认弹窗里要说清。
