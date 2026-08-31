// 样式为副作用导入：base.css 是共享 FX（相机层/五套背景/解码），其余五份是模板专属
// （各自作用域在 .tpl-<template> 下，由 SpecView 挂到根节点）。
import './styles/base.css'
import './styles/flash.css'
import './styles/story.css'
import './styles/demo.css'
import './styles/insight.css'
import './styles/changelog.css'

export * from './videospec-types'
export * from './time'
export { SpecView } from './SpecView'
export { SpecComposition } from './SpecComposition'
export { RemotionRoot } from './Root'
export { Background, Camera } from './Background'
