# 特效库升级（排版工作台第三期 B）设计

> 日期：2026-09-08　状态：设计已确认，待写实施计划
>
> 「可持续复用的特效与排版工作台」四方向：A 画布拖拽（done, PR #5）→ C 预设与品牌 kit（done, PR #6）→ **B 特效库升级（本期）**；D 素材图层后续独立 spec。

## 0. 决策记录

| 决策点 | 结论 |
|---|---|
| 视觉效果范围 | 四组全做：描边/圆角/阴影 + 毛玻璃 + 文字描边/发光 + 渐变背景 |
| 动画参数深度 | 时长/延迟/方向/幅度（不做 easing） |
| 新动画类型 | 补基础三种：zoomIn / slideIn（四向，slideUp 保留为存量别名）/ blurIn |
| 双渲染器边界 | 视觉效果两端都实现（纯 CSS 映射，等价门禁续成立）；动画参数与新动画只实现 Remotion（成片渲染器），HF 不反映——README 注明 |

## 1. 数据模型

### 1.1 LayerStyle 新增（全部可选，缺省=现状零变化）

```ts
borderWidth?: number; borderColor?: string
radius?: number                          // 圆角 px
shadow?: { blur: number; x: number; y: number; color: string }
backdropBlur?: number                    // 毛玻璃 backdrop-filter blur px
textStrokeWidth?: number; textStrokeColor?: string
glow?: { blur: number; color: string }   // 文字发光（text-shadow）
bgGradient?: { from: string; to: string; angle: number }  // 有值时覆盖 bg
```

### 1.2 动画参数（既有 Effect.params 落地启用）

- 通用：`at`/`duration`（既有顶层字段）；`params.direction`('up'|'down'|'left'|'right'，slide 类)、`params.distance`(位移 px)、`params.scale`(zoom/pulse 幅度)、`params.blur`(blurIn 起始模糊 px)
- 新类型：`zoomIn` / `slideIn`（吃 direction；slideUp 不动存量，等价于 slideIn+direction:'up' 但保留独立 case）/ `blurIn`
- **缺省值=现行硬编码值——不带参数的存量 spec 渲染逐字节不变**（门禁思路）

视觉字段与 effects（含 params）天然进 C 期样式预设 payload，无需改预设机制。

## 2. 渲染实现与门禁边界

- **视觉效果两端实现**：Remotion 端扩 `compositions/src/LayerView.tsx` 的 `geom()`；HF 端扩 `studio/src/render-html.ts` 的 `styleAttr`。同一 LayerStyle→CSS 映射，各约 20 行；①等价门禁继续成立（新字段在两端映射一致）。
- **动画只动 Remotion**：`compositions/src/effects.ts` 的 `styleAt` 按参数插值——direction/distance 决定 translate 轴与符号、scale 起点、blurIn 走新的 `blur` 返回通道（LayerView 映射 `filter: blur()`，仅在 >0 时写，沿用「只写被动画目标」的既有铁律）。HF 的 GSAP 时间线（render-html/DECODE_RUNTIME）不动：成片由 Remotion 渲，HF 复刻成本高价值零。
- ①等价门禁按现状锁：只守五模板既有六效果不带参数的产出；新效果/带参 spec 不进等价断言范围。
- `backdropBlur` 依赖 Chrome Headless 的 backdrop-filter：端到端真渲抽帧验证；HF 同引擎低风险。
- 剪辑台 Player=Remotion：参数即调即见，所见=成片。

## 3. UI（Inspector）

- **样式组「卡片效果」小节**：描边（宽+色）/圆角/阴影（模糊/偏移 x/y/色）/毛玻璃滑杆(0-40)/渐变（双色+角度 0-360）；文字层（text/caption）另出「文字描边/发光」小节。数字框+色板，local draft + blur/Enter commit（trim 字段姿势），一次提交=一步 undo；清空输入=删除该字段（效果移除）。
- **特效组重做**：勾选列表 → 每效果一行「勾选+展开参数」（at/duration/方向下拉/幅度数字框）。参数走 editing 新纯函数 `setEffectParams(spec, layerId, type, patch)`（patch 含顶层 at/duration 与 params 键；目标层未开该效果 throw；同值返回原引用）。新动画三种进列表。
- 视频层（kind:'video'）不出卡片效果/文字小节（底片不吃）；效果列表照旧隐藏。

## 4. 测试与验收

- editing：`setEffectParams` 全量单测+变异（同值原引用/未开 throw/params 合并语义）；零 Node 守护。
- compositions：`styleAt` 参数化插值单测（四向符号、distance/scale/blur 数值、**缺省=现行硬编码值的显式断言**）；geom() 新字段→CSS 映射断言；不带新字段/参数的既有 fixture 渲染零变化（门禁）。
- studio：styleAttr 新字段映射单测；①等价门禁按现状锁（范围声明写进测试注释）。
- 端到端真渲：一条片齐上描边/圆角/阴影/毛玻璃/文字发光/渐变+zoomIn(direction+distance) → 抽帧逐项验（毛玻璃重点）；对照组（全缺省）与 merge-base 出片逐字节对照（C 期验收法）。
- 浏览器走查：Inspector 调参即时预览、undo、进预设跨视频复用。

## 5. 非目标

easing 曲线；HF 端动画参数化；强调类新动画（shake/闪烁）；关键帧编辑；视频层效果；效果预设独立管理页（沿用 C 期样式预设机制）。

## 6. 风险与取舍

- backdrop-filter 在 Remotion 服务端截帧的表现需真渲验证；若不支持则毛玻璃降级为半透明底色+注记（验收时定）。
- shadow/glow 用结构化对象而非自由字符串——牺牲表达力换取 UI 可控与两端映射无歧义。
- slideUp 与 slideIn+up 并存是刻意的存量保护：改存量 spec 的 type 会破「缺省零变化」。
