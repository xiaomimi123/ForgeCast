import React from 'react'

const lerp = (a: number, b: number, p: number): number => a + (b - a) * p
const clamp01 = (v: number): number => Math.min(1, Math.max(0, v))
/** GSAP sine.inOut 对应曲线 */
const sineInOut = (p: number): number => -(Math.cos(Math.PI * p) - 1) / 2

/** 相机时长相对片长的倍率。**刻意大于 1**：曲线若在片尾收住，最后约 0.9 秒会慢到停死并被判静止帧。 */
export const CAMERA_OVERRUN = 1.15

/** 相机曲线在时刻 t 的进度（0→1）。抽出来是为了让测试能直接钉住 ×1.15 这个常数：
 *  片尾 t=durationSec 时进度只到 sineInOut(1/1.15)≈0.9586，而不是 1。 */
export function cameraProgress(timeSec: number, durationSec: number): number {
  const span = durationSec * CAMERA_OVERRUN
  return sineInOut(clamp01(span > 0 ? timeSec / span : 0))
}

/**
 * 全程相机层。参数原样迁自 hyperframes.ts buildCameraKeyframes：
 * scale 1→1.06、x 0→-14、y 0→-8，时长 durationSec*CAMERA_OVERRUN，缓动 sine.inOut。
 *
 * transform 函数顺序写成 translate→scale，与 GSAP 的输出序（translate→rotate→skew→scale）一致；
 * 反过来写会让位移被 scale 乘一遍，与原版差出亚像素。
 * position/inset/transform-origin 由 base.css 的 #cam 规则给（搬自 FX_CSS），这里只出每帧变的 transform。
 */
export function Camera(
  { timeSec, durationSec, children }: { timeSec: number; durationSec: number; children: React.ReactNode },
): React.ReactElement {
  const p = cameraProgress(timeSec, durationSec)
  const transform = `translate(${lerp(0, -14, p)}px, ${lerp(0, -8, p)}px) scale(${lerp(1, 1.06, p)})`
  return <div id="cam" style={{ transform }}>{children}</div>
}

/** 暗角层，五个变体都有（迁自 buildTechBg 的 vig 常量）。 */
const Vig = (): React.ReactElement => <div className="vig" />

/**
 * 科技背景 5 变体。DOM 结构、类名与每个变体各自的动效行逐条迁自 hyperframes.ts buildTechBg：
 * 原实现把 GSAP 微动挂在主时间线上（全部 ease:"none"、duration 就是片长），此处改为按
 * timeSec 直接线性求值——ease:"none" ⇒ 线性插值，逐帧确定性、可任意 seek。
 *
 * 五个变体的内部结构并不一致（synth 多一个 .sun、grid 多一个 .sweep），动的属性也不同
 * （aurora 动 xPercent/yPercent、synth 动 background-position、其余动 y），故逐个分支写死。
 * variant 省略或 'none' 时不渲染（story 聊天场不加背景，保微信截图真实感）。
 * 未知变体名回落 grid，与 buildTechBg 的 default 分支一致。
 */
export function Background(
  { variant, timeSec, durationSec }: { variant: string | undefined; timeSec: number; durationSec: number },
): React.ReactElement | null {
  if (!variant || variant === 'none') return null
  const p = clamp01(durationSec > 0 ? timeSec / durationSec : 0)
  switch (variant) {
    // tl.fromTo("#techbg .mv",{xPercent:-6,yPercent:-4},{xPercent:6,yPercent:4,...})
    case 'aurora':
      return (
        <div id="techbg" className="bg-aurora">
          <div className="mv" style={{ transform: `translate(${lerp(-6, 6, p)}%, ${lerp(-4, 4, p)}%)` }} />
          <Vig />
        </div>
      )
    // tl.fromTo("#techbg .mv",{y:-220},{y:220,...})
    case 'matrix':
      return (
        <div id="techbg" className="bg-matrix">
          <div className="mv" style={{ transform: `translateY(${lerp(-220, 220, p)}px)` }} />
          <Vig />
        </div>
      )
    // tl.to("#techbg .mv",{backgroundPosition:"0px 70px",...})；起点是 CSS 默认的 0px 0px。
    // .mv 的 CSS transform（perspective+rotateX）不参与动画，故这里不写 transform，别覆盖它。
    case 'synth':
      return (
        <div id="techbg" className="bg-synth">
          <div className="sun" />
          <div className="mv" style={{ backgroundPosition: `0px ${lerp(0, 70, p)}px` }} />
          <Vig />
        </div>
      )
    // tl.fromTo("#techbg .mv",{y:0},{y:46,...})
    case 'mesh':
      return (
        <div id="techbg" className="bg-mesh">
          <div className="mv" style={{ transform: `translateY(${lerp(0, 46, p)}px)` }} />
          <Vig />
        </div>
      )
    // default（含未知名回落）：mv y 0→80，sweep xPercent 0→320。
    // .sweep 的 CSS 里有 transform: skewX(-12deg)，GSAP 的 xPercent 会与之复合（其变换序
    // 为 translate→rotate→skew→scale），故这里内联写全 translateX(...) skewX(-12deg)。
    default:
      return (
        <div id="techbg" className="bg-grid">
          <div className="mv" style={{ transform: `translateY(${lerp(0, 80, p)}px)` }} />
          <div className="sweep" style={{ transform: `translateX(${lerp(0, 320, p)}%) skewX(-12deg)` }} />
          <Vig />
        </div>
      )
  }
}
