/** CSS 只为副作用导入（Remotion 的 webpack 会打进包，vitest 下按空模块处理）。 */
declare module '*.css'
