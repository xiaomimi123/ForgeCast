// 唯一允许触碰 studio 包的文件，且只搬类型（值导入会把 Node 依赖拖进浏览器包）。
export type { VideoSpec, Semantic, Section, Layer, LayerContent, LayerStyle, Effect, AudioSpec } from '@forgecast/studio'
