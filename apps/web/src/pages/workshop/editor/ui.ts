/**
 * 剪辑台各栏共用的常量与按钮 class。
 *
 * **单独一个模块**而不是挂在 EditorPage 上：EditorPage 要 import 子面板、子面板又要用这些常量，
 * 从 EditorPage 取就形成了模块环。环里被后加载的那一侧在**模块顶层**读常量会撞 TDZ
 *（`Cannot access 'BGS' before initialization`，dev 下白屏、打包后靠 rollup 的重排侥幸不炸），
 * 这类崩溃只在运行时出现，tsc 与 build 都拦不住。把常量放在两侧都只依赖的叶子模块，环就不存在了。
 */
import type { Effect, Layer } from '@forgecast/compositions/src/videospec-types'

/**
 * 九种特效（`Effect['type']` 的全集）与它们的人话名 + 可调参数键。新增类型时这里要跟着加，
 * 并且 `@forgecast/editing` 的 `EFFECT_TYPES` 运行时白名单也要同步——漏了那边勾选框一点就 throw。
 *
 * `params` 只列**该类型真正读**的键（口径以 compositions/src/effects.ts `styleAt` 的 switch 为准，
 * 多列出来的键调了也不会变画面，比不给还糟）。
 *
 * `timing` 同理，列**该类型真正读**的时间键——`at`/`duration` 并非所有类型通用：`styleAt` 里
 * `pulse` 只按 t0 判窗口、不读 duration；`exit` 从 clipEnd 倒推、不读 at；`decode` 两个都不读
 * （只落成 `.tw` 类，节奏由 decode 运行时定）。列进来的才渲控件，其余不出——出了就是死控件。
 * 与 EFFECT_PARAM_META 一起构成展开面板的全部内容。
 */
export type EffectTimingKey = 'at' | 'duration'

export const EFFECTS: Array<{
  type: Effect['type']; label: string; timing: EffectTimingKey[]; params: EffectParamKey[]
}> = [
  { type: 'decode', label: '解码', timing: [], params: [] },
  { type: 'fadeIn', label: '淡入', timing: ['at', 'duration'], params: ['y', 'scale'] },
  { type: 'slideUp', label: '上移', timing: ['at', 'duration'], params: ['distance'] },
  { type: 'pulse', label: '脉冲', timing: ['at'], params: [] },
  { type: 'demote', label: '退居', timing: ['at', 'duration'], params: [] },
  { type: 'exit', label: '退场', timing: ['duration'], params: [] },
  { type: 'zoomIn', label: '缩放进场', timing: ['at', 'duration'], params: ['scale'] },
  { type: 'slideIn', label: '滑入', timing: ['at', 'duration'], params: ['direction', 'distance'] },
  { type: 'blurIn', label: '模糊消散', timing: ['at', 'duration'], params: ['blur'] },
]

export type EffectParamKey = 'direction' | 'distance' | 'scale' | 'blur' | 'y'

/** 展开面板里每个参数键的标签 / 步进 / 缺省提示（缺省值抄自 styleAt 的 `num(..., dflt)`）。 */
export const EFFECT_PARAM_META: Record<EffectParamKey, { label: string; step: number; placeholder: string; hint: string }> = {
  direction: { label: '方向', step: 1, placeholder: 'up', hint: '往哪个方向进场（起点在反侧）' },
  distance: { label: '距离', step: 5, placeholder: '40', hint: '进场位移距离，px（默认 40）' },
  scale: { label: '缩放', step: 0.05, placeholder: '0.8', hint: 'zoomIn 的起始缩放（默认 0.8）；fadeIn 填了这项就走缩放、不走位移' },
  blur: { label: '模糊', step: 1, placeholder: '12', hint: '起始模糊半径，px（默认 12）' },
  y: { label: '位移', step: 5, placeholder: '20', hint: 'fadeIn 的纵向位移，px（默认 20）；上面「缩放」填了值时这项失效' },
}

/** slideIn 的方向下拉。值必须是 styleAt 认得的四个字符串之一。 */
export const EFFECT_DIRECTIONS = [
  { value: 'up', label: '向上' }, { value: 'down', label: '向下' },
  { value: 'left', label: '向左' }, { value: 'right', label: '向右' },
] as const

export const VIDEO_TPLS = [
  { value: 'flash', label: 'flash · 文字快闪' },
  { value: 'story', label: 'story · 微信气泡' },
  { value: 'demo', label: 'demo · 产品截图轮播' },
  { value: 'changelog', label: 'changelog · 代码变更' },
  { value: 'insight', label: 'insight · 数据卡片解说' },
  { value: 'talk', label: 'talk · 口播合成' },
]
export const MOODS = [
  { value: '', label: '自动（按钩子情绪）' },
  { value: 'tense', label: '紧张' },
  { value: 'upbeat', label: '热血' },
  { value: 'tech', label: '科技' },
  { value: 'warm', label: '温情' },
]
export const BGS = [
  { value: 'grid', label: '赛博网格' },
  { value: 'aurora', label: '极光' },
  { value: 'matrix', label: '数据雨' },
  { value: 'synth', label: '合成波' },
  { value: 'mesh', label: '深空' },
  { value: 'random', label: '随机' },
  { value: 'none', label: '不加背景' },
]

/** `uploadAssetId` 只在 `tpl==='talk'` 时有意义——口播合成的底片是用户上传的口播成片
 *  （`assets` 里 `type==='video' && origin==='upload'` 的一条），其余模板不读这个字段。 */
export interface VideoParams {
  tpl: string; bgm: string; mood: string; bg: string; captions: boolean; ratio: 'portrait' | 'landscape'
  uploadAssetId?: number
  /** 套用的版式模板（layout_templates.id）。可选——「不套用」不带这个字段。切 tpl/ratio 时要清掉，
   *  否则可能带着与新 tpl/ratio 失配的旧值发请求（服务端按 tpl 精确匹配，失配 400）。 */
  layoutTemplateId?: number
}

/** 实心（黑）与描边两套按钮 class——同屏只能有一个用 SOLID，见 docs/剪辑台-实施说明.md §7 */
export const SOLID = 'rounded-[var(--fc-r-sm)] bg-[var(--fc-ink)] px-3 py-1.5 text-sm font-medium text-white hover:bg-[var(--fc-ink-2)] disabled:bg-[var(--fc-line)] disabled:text-[var(--fc-faint)]'
export const OUTLINE = 'rounded-[var(--fc-r-sm)] border border-[var(--fc-line-2)] bg-transparent px-3 py-1.5 text-sm font-medium text-[var(--fc-ink)] hover:border-[var(--fc-ink)] hover:bg-[var(--fc-bg)] disabled:border-[var(--fc-line)] disabled:text-[var(--fc-line-2)]'

/**
 * 这条字幕是不是「手打的」——`addCaptionLayer` 生成的 id 形状（`removeCaptionLayer` 的同一判据）。
 * 只有手打的才允许「清空即删」；五模板 TTS 的 cap0/1/2 与旁白一一对应，删了就和语音对不上。
 */
export const isManualCaption = (layerId: string) => layerId.startsWith('cap-manual-')

/**
 * 这一层是不是「素材层」——`addImageLayer`/`addShapeLayer` 生成的 id 形状，也是
 * `removeMediaLayer` 放行删除的**同一条判据**（含出片期注入的 `media-logo`）。
 * 只有它们能删：模板生成的文案/字幕层与 `semantic.sections` 一一对应，删了就和原文案对不上。
 */
export const isMediaLayer = (layerId: string) => layerId.startsWith('media-')

/** 素材层的人话名（分镜列表/时间轴的行标签）。line 单列——它在 content 里是 shape 的一种。 */
export const MEDIA_KIND_LABEL: Record<string, string> = {
  image: '图片', rect: '矩形', ellipse: '圆形', line: '线条',
}

/**
 * 素材层的行标签：`{kind}` 是人话类型，`{name}` 是图片文件名（形状没有文件，回落空串）。
 * 两处消费（分镜列表的素材行、时间轴的素材条）共用，免得两边各写一份 basename。
 */
export function mediaLayerLabel(layer: Layer): { kind: string; name: string } {
  const c = layer.content
  if (c.kind === 'image') {
    return { kind: MEDIA_KIND_LABEL.image, name: c.src.split(/[/\\]/).pop() ?? c.src }
  }
  if (c.kind === 'shape') return { kind: MEDIA_KIND_LABEL[c.shape] ?? c.shape, name: '' }
  return { kind: c.kind, name: '' }
}
