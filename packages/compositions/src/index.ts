// 样式为副作用导入，且**只导 all.css 这一份聚合入口**：base.css 是共享 FX（相机层/五套背景/
// 解码），其余五份是模板专属（各自作用域在 .tpl-<template> 下，由 SpecView 挂到根节点）。
// 这里若把六份逐个列出，就与 all.css 里那六条 @import 成了两份手抄清单——将来加第七份样式
// 只改其中一处，成片有、Web 预览没有（预览是 @import all.css 进 CSS 层的），而且只在预览页暴露。
// 清单唯一的一份放在 all.css 里。
import './styles/all.css'

export * from './videospec-types'
export * from './time'
export * from './composition'
export { SpecView } from './SpecView'
export { SpecComposition } from './SpecComposition'
export { RemotionRoot } from './Root'
