# 素材包（VideoSpec）：可编辑中间表示 设计

> 日期：2026-08-31　状态：设计已确认，待写实施计划
>
> **这是四个子项目里的第①个**：① 素材包 schema + 生成产出并消费它 → ② Remotion 渲染器 → ③ 生成前剪辑台 → ④ 视频合成能力。
> 后三个各自独立 spec；本文只覆盖 ①。

## 0. 背景：为什么需要它

用户要做「生成前剪辑台——素材包可视化调校工作台」，四个维度：选素材与排序、改文字与字幕、调版式与特效、对时间轴与卡点。
同时确认「动效叠在真实视频素材上（真人口播加动态标题、数字人叠 UI、绿幕合成）」是**现在就要做**的能力。

这两件事、加上「换 Remotion 渲染器」，共同缺的是**同一样东西**：一份持久化、结构化、可编辑的视频描述文档。

现状是没有的。`generateVideo` 直接把内容焊进 HTML 字符串——`build*Sections` 手工拼
`<div class="clip" data-start=...>…</div>`（`hyperframes.ts:417/506/550/607/662` 等处）。
后果：

- **剪辑台无处下手**：没有可改的对象，唯一的产物是一份已经渲染定型的 HTML。
- **换渲染器等于重写全部动效生成逻辑**：动效以 GSAP 调用字符串的形式散落在各 `build*Sections` 里。
- **每个项目只有一份 `hf/`，每次生成覆盖**（`generate.ts:91` 等，`hfDir` 路径固定）——历史视频无法重新打开编辑。

## 1. 目标

1. 定义 **VideoSpec**：语义层 + 图层层两层结构，每条视频一份文件。
2. `generateVideo` 产出 VideoSpec，并且**现有 HyperFrames 渲染路径改为消费它**（不是旁路写一份没人读的 JSON）。
3. `hf/` 目录改为每条视频一份，历史视频可重新定位。
4. 顺带修掉本链路上三个正在产生坏视频的缺陷（§6）。

## 2. 非目标

- **不做 Remotion 渲染器**（子项目②）。本次渲染仍走 HyperFrames。
- **不做剪辑台 UI**（子项目③）。本次不提供任何编辑入口，只保证数据结构支持编辑。
- **不做视频合成/绿幕**（子项目④）。VideoSpec 的图层类型**预留** `video` 但本次不实现其渲染。
- **不改 TTS / ASR / BGM / 卡点算法**。它们的产物（cues、BeatGrid、选曲结果）被 VideoSpec 引用，算法本身不动。
- **不改 5 个模板的观感**。本次是重构：同样的输入应产出与改造前**视觉等价**的视频（§7 验收据此）。
- 不给 `apps/web` 引入单测框架（既定约定）。

## 3. 两层模型

### 3.1 关系：单向下沉，不做双向同步

```
文案/分析 ──LLM──▶ 语义层 ──纯函数 lower()──▶ 图层层 ──▶ 渲染器
                   (可重新生成)              (剪辑台改这层)
```

**语义层是输入与来源凭证，不是活镜像。** 图层层才是渲染真相。
两种操作各自语义清晰、互不干扰：

| 操作 | 行为 |
|---|---|
| 重写某段文案 | 重跑该 section 的语义生成 → 只重新 `lower()` 这一段的图层。**该段内被手工改过的图层会丢失，必须明确提示后再执行** |
| 微调某个图层 | 直接改图层层，该图层打 `overridden: true`；语义层不动 |

**明确不做**：改图层反写语义层。这是双向同步的入口，也是这类系统失控的典型起点。

### 3.2 schema

```ts
/** 每条视频一份。workspace/<slug>/specs/<videoId>.json */
export interface VideoSpec {
  version: 1                      // schema 版本，后续演进靠它做迁移判断
  videoId: string                 // uuid，同时用于 hf 目录名与视频文件名
  slug: string
  template: string                // 'flash' | 'story' | 'demo' | 'changelog' | 'insight' | `custom-<id>`
  createdAt: string

  semantic: Semantic              // 语义层：可重新生成
  canvas: { width: number; height: number }
  durationSec: number
  layers: Layer[]                 // 图层层：渲染真相，剪辑台改这层
  audio: AudioSpec
  warnings: string[]              // 生成期的降级/异常，见 §6.3
}

/** 语义层：模板无关的「这条视频在讲什么」 */
export interface Semantic {
  hook: string | null             // pain/sideline/infogap/story/fun
  sourceAssetId: number | null    // 来自哪条文案素材
  sections: Section[]
}
export interface Section {
  id: string                      // 'sec-hook' / 'sec-pain' / 'sec-card-2' …稳定可读
  role: 'hook' | 'pain' | 'body' | 'demo' | 'stat' | 'cta' | 'brand'
  text?: string
  items?: string[]                // 痛点列表、气泡对话等
  shots?: string[]                // demo 截图相对路径
  stat?: { value: string; label: string }   // insight 数据卡
}

/** 图层层：一个图层 = 屏幕上一个有起止时间的东西 */
export interface Layer {
  id: string                      // 稳定可读，如 'insight-card-0'；同时用作渲染产物的元素 id
  kind: 'text' | 'image' | 'video' | 'caption' | 'shape'
  from: string | null             // 来源 section id；手工新建的图层为 null
  overridden: boolean             // 是否被剪辑台改过（重新 lower 时据此保护/提示）

  start: number                   // 秒，绝对时间
  duration: number
  track: number                   // 同 track 不得时间重叠（HyperFrames 硬规则，Remotion 下也保留语义）

  content: LayerContent
  style: LayerStyle
  effects: Effect[]
}

export type LayerContent =
  | { kind: 'text'; text: string }
  | { kind: 'image'; src: string }        // 相对 hf 目录
  | { kind: 'video'; src: string; muted: boolean }   // ④ 预留，本次不渲染
  | { kind: 'caption'; text: string }
  | { kind: 'shape'; shape: 'rect' | 'ellipse' }

/** 只放渲染器都能实现的通用属性；模板特有的观感留在模板 CSS 里 */
export interface LayerStyle {
  x?: number; y?: number; width?: number; height?: number   // px，相对 canvas
  align?: 'left' | 'center' | 'right'
  fontSize?: number
  color?: string
  bg?: string
  opacity?: number
  cssClass?: string               // 逃生舱：模板 CSS 里已有的类名，如 'card' / 'painT'
}

/** 特效参数化——现在硬编码在 DECODE_RUNTIME/fillAccents 里的东西挪到这里 */
export interface Effect {
  type: 'decode' | 'fadeIn' | 'slideUp' | 'pulse' | 'demote'
  at?: number                     // 相对图层起点的秒偏移
  duration?: number
  params?: Record<string, number | string>
}

export interface AudioSpec {
  narration: { src: string; degraded: string | null } | null
  bgm: { src: string; mood: string | null } | null
  beatGrid: { t0: number; T: number; bpm: number; strongBeats: number[] } | null
  captionsEnabled: boolean
}
```

**关于 `cssClass` 这个逃生舱**：本次是重构、要求视觉等价，把 10 个模板里所有排版细节（`.card` 的圆角/边框/内边距、`.painT` 的字号字重）都提升成结构化 `style` 字段是不现实也不必要的。图层引用模板 CSS 里已有的类名，`style` 只承载**剪辑台需要改的那几项**。子项目③再按实际需要扩充 `LayerStyle`。

### 3.3 存放位置与目录改造

| 现在 | 改后 |
|---|---|
| `workspace/<slug>/hf/`（每项目一份，覆盖） | `workspace/<slug>/hf/<videoId>/` |
| 无 | `workspace/<slug>/specs/<videoId>.json` |
| `workspace/<slug>/videos/<tpl>-<hook>-<ts>-<uuid6>.mp4` | 不变，但 uuid 段改用 `videoId` 前 6 位，可反查 |

`assets` 表加一列 `spec_path TEXT`（用既有 `ensureColumn` 幂等迁移，同 `rebrand_exec_result` 先例），
存 spec 的 workspace 相对路径，供子项目③定位。旧行为 NULL，前端据此判断「这条视频没有素材包，无法编辑」。

**`videoId` 在 `generateVideo` 入口生成一次**，贯穿 spec 文件名、hf 目录名、视频文件名。

## 4. 管线改造

```
现在:  copy ──▶ build*Slots ──▶ build*Sections ──▶ HTML 字符串 ──▶ 渲染
① 后:  copy ──▶ buildSemantic ──▶ lower() ──▶ VideoSpec ──▶ renderSpecToHtml ──▶ 渲染
                                              └──▶ 落盘 specs/<videoId>.json
```

三个新增的纯函数层，各自可单测：

1. **`buildSemantic(doc, tpl, ctx) → Semantic`**：吃 `CopyDoc`，吐语义层。现有 `props.ts` 的
   `buildFlashProps`/`buildDemoProps`/… 的提取逻辑迁到这里（并在迁移时修 §6.1/§6.2 两个缺陷）。
2. **`lower(semantic, opts) → VideoSpec`**：语义 → 图层 + 时间轴。现有 `build*Sections` 里
   **算时间/分组/轨道**的逻辑迁到这里（如 `buildInsightSections` 的分组、驻留上限、hero 判定；
   `buildDemoSections` 的卡点消费；`snapStarts` 吸附）。`opts` 带 cues / BeatGrid / shots / durationSec。
3. **`renderSpecToHtml(spec, tplHtml) → string`**：VideoSpec → HTML 字符串。现有 `build*Sections` 里
   **拼 HTML** 的部分迁到这里，改为遍历 `spec.layers` 统一生成，不再每模板一套。
   `injectTechFx` / `injectAudioCaptions` / `fillAccents` 的注入点保持不变。

**只有第 3 步在子项目②会被 Remotion 版替换**；1、2 两层复用。

### 4.1 `generate.ts` 的重复消除

审计指出五个模板分支（`generate.ts:88-229`）约 110 行近乎逐字重复（占该文件 38%），
外加 `renderCustomTemplate` 里第六份。改造后统一成一条管线，模板差异只剩
`buildSemantic` 的分支与模板文件名。**五个硬编码的时长下限**
（flash 12 / story 14 / demo 14 / insight 16 / changelog 12 / custom 6）收进一张常量表。

## 5. 兼容与迁移

- 旧的 `workspace/<slug>/hf/index.html`（无 videoId 子目录）**不迁移、不删除**。
  新生成一律走新路径；旧目录留在原地，`spec_path` 为 NULL 的历史 asset 在③里显示为不可编辑。
- `apps/web` 的 `PreviewTab` 现在硬编码 `/files/<slug>/hf/index.html`，目录改造后会 404。
  本次同步改为：从 `assets` 取该项目最近一条有 `spec_path` 的视频，预览
  `/files/<slug>/hf/<videoId>/index.html`；取不到则显示既有的「没读到合成时间线」提示。
  （③ 会把它换成按选中视频预览，本次只保证不坏。）

  **不需要新增 API**：`GET /api/projects/:slug/assets` 用的是 `SELECT * FROM assets`
  （`app.ts:231`），新列自动随响应下发。只需在 `apps/web/src/api.ts` 的 `Asset` 接口补
  `spec_path: string | null`，前端即可从已有的 assets 查询里筛出最近一条可预览的视频。

## 6. 顺带修掉的三个缺陷

它们都在本次要重写的这条链路上，不修就是把 bug 平移进新结构。

### 6.1 CTA 提取吐出拍摄指示（正在产生坏视频，已复现）

`props.ts:16` 的 `ctaSection.match(/台词[：:]\s*(.+)/)` 优先取「台词：」那行，
但 `templates/prompts/_format.md:13` **明确要求 LLM 不要加「台词：」标签**。
于是正则永不命中，退回 `.split('\n')[0]`，而该行带着括号里的画面提示，且**没有任何地方剥掉它**。实测：

```
输入: 【52-60s CTA】（画面：手机弹出评论通知，光标闪烁）想要同款？评论区扣1，链接自己去接
上屏: （画面：手机弹出评论通知，光标闪烁）想要同款？评论区扣1，链接自己去接
```

修法：`buildSemantic` 提取任何上屏文案时，一律先过 `cleanNarrationText`（`tts.ts:27-37`，
现在只用于旁白/字幕路径）。保留「台词：」分支做旧格式兼容，但不再依赖它。

### 6.2 `INSIGHT_STAT_RE` 只认阿拉伯数字

中文口播说「三个」「几万」时命中 0 张卡。上一轮已加了「0 卡时标题铺满」的兜底，
但根因未解。本次在 `buildSemantic` 里扩展为同时识别中文数字（一二三四五六七八九十百千万亿/几/两），
仍保留 0 卡兜底作为最后防线。

### 6.3 fail-soft 信号被扔掉

TTS 降级成静音 WAV、BGM 混音失败、节拍分析失败——全部只 `onProgress` 进内存任务日志
（`packages/server/src/tasks.ts`，无持久化，服务重启即丢），而 `assets.warnings` 列**早已存在、
INSERT 语句里也写了，却硬编码成 `'[]'`**（`generate.ts:255`）。

修法：VideoSpec 的 `warnings: string[]` 收集全部降级原因，`renderAndRegister` 落库时
写入 `assets.warnings`。`AudioSpec.narration.degraded` 同时保留细粒度原因。

## 7. 测试与验收

**核心验收是「视觉等价」**：本次是重构，同样输入应产出与改造前观感一致的视频。

- **纯函数单测**（`packages/studio`，vitest）：`buildSemantic` 的提取（含 §6.1/§6.2 的回归用例）、
  `lower()` 的时间轴/分组/轨道分配（迁移现有 `buildInsightSections` 的全部既有断言）、
  `renderSpecToHtml` 的输出结构。
- **VideoSpec 落盘断言**：`generateVideo`（stub 模式）后，spec 文件存在、可 JSON 解析、
  `layers` 非空、同 track 无时间重叠、`warnings` 反映注入的降级。
- **等价性回归**：对同一份固定 `CopyDoc` fixture，改造前后生成的 HTML 中
  **clip 的 `id` / `data-start` / `data-duration` / `data-track-index` 集合必须完全一致**。
  这是本次最重要的一条——它证明重构没有改变时间轴语义。改造前的期望值先跑一次现有代码采集。
- **合成产物检查**：`npx --yes hyperframes@0.7.68 check` 在样例上 **lint 0 error**。
- **抽帧人工核对**：`snapshot --at 5,14,22,30,40,50 --no-end`（**注意 `--at` 是逗号分隔单参数**，
  重复 flag 只有最后一个生效），肉眼确认与改造前观感一致。
- **前端**：`npx tsc --noEmit` + 浏览器确认预览 tab 未因目录改造而坏。
- **回归**：`pnpm test` 全绿（需 Node ≥22；`tts`/`kill-port`/`screenshot` 为已知并行满载 flake）。

## 8. 已知风险

- **`renderSpecToHtml` 统一生成 HTML 是本次最大风险点**。现在五个模板的 HTML 拼装各有各的细节
  （demo 的手机外框、story 的气泡、insight 的卡片 hero/降级），统一成「遍历 layers」很可能
  在某个模板上产出细微差异。§7 的等价性回归 + 抽帧核对就是为它设的。若某模板确实无法统一，
  允许该模板保留专用的 `renderXxxLayers` 分支——**但时间轴必须来自 VideoSpec**，不得回退到自己算。
- `<audio>` 必须是合成根节点的**直接子元素**（HyperFrames 硬约束，违反则静默静音——
  commit `65c47f8` 刚踩过）。`renderSpecToHtml` 生成的音轨图层不得被包进 `#cam` 或任何中间容器。
