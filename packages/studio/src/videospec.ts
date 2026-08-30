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

/** 各模板的最短成片时长（秒）。原先硬编码散落在 generate.ts 五个分支里。 */
export const MIN_DURATION: Record<string, number> = {
  flash: 12, story: 14, demo: 14, insight: 16, changelog: 12, custom: 6,
}
