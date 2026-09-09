/**
 * VideoSpec 类型定义。只放类型 + 常量，不要写任何函数——本文件被后续每个 Task 引用，必须零副作用。
 * schema 详见 docs/superpowers/specs/2026-08-31-videospec-asset-package-design.md §3.2。
 */

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

  /** 科技背景变体（`resolveBgVariant` 解析一次的结果；story 与 `--bg=none` 为 undefined）。
   *  可选字段：Task 10 之前它只走 inputProps，Web 预览拿不到 → 预览无背景、成片有背景。
   *  实时预览是子项目②的交付目标，故落进 spec；渲染时必须在 renderRemotion **之前**写好，
   *  否则 `--bg=random` 下「传给渲染的值」与「写进磁盘的值」会是两个随机结果。
   *  ① 的 HTML 路径不读它（背景由 injectTechFx 在 HTML 侧注入），加字段不影响等价性。 */
  bgVariant?: string
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
  items?: string[]                // 纯字符串列表（痛点列表等）；对话轮次见 dialogue，不要塞进这里
  dialogue?: Array<{ who: 'them' | 'me'; text: string }>   // story 的气泡对话轮次
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
  | {                              // Task 8 起真渲染（Remotion <Video>）
      kind: 'video'; src: string; muted: boolean
      /** 子项目④ talk：以下四项均可选，缺省即①②的行为（整段铺满、不裁剪、满音量）。 */
      trimStart?: number            // 秒，片源裁掉的头（缺省 0）
      trimEnd?: number               // 秒，片源终点（缺省=片源末尾，即不传 endAt）
      volume?: number                // 0..1，缺省 1
      /** 片源总长（ffprobe 实测，生成期落值）。裁剪的吐尾钳制（editing）与剪辑台 UI 的
       *  时间轴刻度都靠它——只看 trimStart/trimEnd 无从知道「还能往后拉多少」。 */
      sourceDurationSec?: number
    }
  | { kind: 'caption'; text: string }
  | { kind: 'shape'; shape: 'rect' | 'ellipse' | 'line' }

/** 只放渲染器都能实现的通用属性；模板特有的观感留在模板 CSS 里 */
export interface LayerStyle {
  x?: number; y?: number; width?: number; height?: number   // px，相对 canvas
  align?: 'left' | 'center' | 'right'
  fontSize?: number
  color?: string
  bg?: string
  opacity?: number
  cssClass?: string               // 逃生舱：模板 CSS 里已有的类名，如 'card' / 'painT'
  // 特效库 Task 1 新增：只放渲染器都能实现的通用视觉效果，CSS 映射规则见
  // .superpowers/sdd/2026-09-08-effects-library/task-1-brief.md（两端 geom()/styleAttr() 完全一致）。
  borderWidth?: number; borderColor?: string
  radius?: number
  shadow?: { blur: number; x: number; y: number; color: string }
  backdropBlur?: number
  textStrokeWidth?: number; textStrokeColor?: string
  glow?: { blur: number; color: string }
  bgGradient?: { from: string; to: string; angle: number }
}

/** 特效参数化——现在硬编码在 DECODE_RUNTIME/fillAccents 里的东西挪到这里。
 *  `exit`（Fix round 1 新增）：迁自 buildInsightSections 的卡片退场——缩小+降透明度移出
 *  （`tl.to(...opacity:0,scale:.85...)`）随即在 clip 结束时刻硬收尾（`tl.set(...opacity:0...)`，
 *  StaticGuard 契约：非线性 seek 落在渐隐尾巴之后不能读到 stale 的可见状态）。这两行必须同时出现、
 *  且退场终点必须精确对齐 layer.start+layer.duration，所以建成一个 effect 类型而不是拆两条，
 *  避免消费方（render-html.ts）各自算错位。 */
export interface Effect {
  // 后三种为特效库 Task 2 新增（zoomIn 缩放进场 / slideIn 四向滑入 / blurIn 模糊消散），
  // 参数见 params：direction | distance | scale | blur。
  type: 'decode' | 'fadeIn' | 'slideUp' | 'pulse' | 'demote' | 'exit' | 'zoomIn' | 'slideIn' | 'blurIn'
  at?: number                     // 相对图层起点的秒偏移
  duration?: number
  params?: Record<string, number | string>
}

export interface AudioSpec {
  narration: { src: string; degraded: string | null } | null
  bgm: { src: string; mood: string | null } | null
  /** manualBeats：手动卡点（剪辑台加的）；自动重分析不覆盖——P2。 */
  beatGrid: { t0: number; T: number; bpm: number; strongBeats: number[]; manualBeats?: number[] } | null
  captionsEnabled: boolean
}

/** 品牌 kit：预设级的批量观感覆盖，由 `applyBrandKit`（brand-kit.ts）套到 spec 图层上。
 *  字段全部可选；空 kit 是恒等变换（返回原 spec 引用）。各字段的作用目标（cssClass 表）与
 *  「overridden 层跳过」的理由见 brand-kit.ts 顶部注释。 */
export interface BrandKit {
  primaryColor?: string           // CTA 类层的文字色
  accentColor?: string            // card / highlightCard 类层的背景色
  titleScale?: number             // 标题类层的 fontSize 乘数
  ctaText?: string                // CTA 主文案（只换第一行，品牌名第二行保留）
}

/** 各模板的最短成片时长（秒）。原先硬编码散落在 generate.ts 五个分支里。
 *  `talk` 是预留常量，**暂无读取方**：口播成片时长 = ffprobe 实测的片源时长（见 generate.ts
 *  renderTalkPipeline），补到 6s 只会在片源后面挂一段黑屏。 */
export const MIN_DURATION: Record<string, number> = {
  flash: 12, story: 14, demo: 14, insight: 16, changelog: 12, custom: 6, talk: 6,
}
