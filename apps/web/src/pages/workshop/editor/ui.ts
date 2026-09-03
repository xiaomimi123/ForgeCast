/**
 * 剪辑台各栏共用的常量与按钮 class。
 *
 * **单独一个模块**而不是挂在 EditorPage 上：EditorPage 要 import 子面板、子面板又要用这些常量，
 * 从 EditorPage 取就形成了模块环。环里被后加载的那一侧在**模块顶层**读常量会撞 TDZ
 *（`Cannot access 'BGS' before initialization`，dev 下白屏、打包后靠 rollup 的重排侥幸不炸），
 * 这类崩溃只在运行时出现，tsc 与 build 都拦不住。把常量放在两侧都只依赖的叶子模块，环就不存在了。
 */
export const VIDEO_TPLS = [
  { value: 'flash', label: 'flash · 文字快闪' },
  { value: 'story', label: 'story · 微信气泡' },
  { value: 'demo', label: 'demo · 产品截图轮播' },
  { value: 'changelog', label: 'changelog · 代码变更' },
  { value: 'insight', label: 'insight · 数据卡片解说' },
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

export interface VideoParams { tpl: string; bgm: string; mood: string; bg: string; captions: boolean; ratio: 'portrait' | 'landscape' }

/** 实心（黑）与描边两套按钮 class——同屏只能有一个用 SOLID，见 docs/剪辑台-实施说明.md §7 */
export const SOLID = 'rounded-[var(--fc-r-sm)] bg-[var(--fc-ink)] px-3 py-1.5 text-sm font-medium text-white hover:bg-[var(--fc-ink-2)] disabled:bg-[var(--fc-line)] disabled:text-[var(--fc-faint)]'
export const OUTLINE = 'rounded-[var(--fc-r-sm)] border border-[var(--fc-line-2)] bg-transparent px-3 py-1.5 text-sm font-medium text-[var(--fc-ink)] hover:border-[var(--fc-ink)] hover:bg-[var(--fc-bg)] disabled:border-[var(--fc-line)] disabled:text-[var(--fc-line-2)]'
