// @forgecast/studio — M5 视频。render 内部用，不导出；generate 为主入口。
export * from './props'
export * from './generate'
export * from './tts'
// 卡点方案（cutplan）路由需要的纯函数/分析函数：显式导出，不整体 export * from './hyperframes'
// （hyperframes.ts 内部还有渲染细节，不必全部暴露为包的公共表面）
export { analyzeBeats, autoCutPlan, chooseBgmPath, readShots, type BeatGrid, type Shot } from './hyperframes'
export * from './review'
export * from './retro'
export * from './srt'
export * from './benchmark'
export * from './custom-template'
// VideoSpec 中间层类型：renderer-agnostic，供 @forgecast/compositions 做 type-only 再导出
// （packages/compositions/src/videospec-types.ts）。此前只在 studio 内部各文件间用 import type
// 互相引用，从未进过包的公共表面——@forgecast/studio 的 `import type { VideoSpec } from '@forgecast/studio'`
// 在此之前无法解析。
export type { VideoSpec, Semantic, Section, Layer, LayerContent, LayerStyle, Effect, AudioSpec } from './videospec'
