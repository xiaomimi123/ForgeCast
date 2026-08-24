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
