import React from 'react'
import type { LayerStyle } from './videospec-types'

/**
 * 逐段编码：按 `/` 切开、每段 encodeURIComponent、再用 `/` 拼回。
 * 不能用 encodeURI（放过 `#`/`?`，含这两个字符的文件名会被浏览器截断）；
 * 也不能整串 encodeURIComponent（会把 `/` 编成 %2F 拆掉子目录）。
 */
export function encodePathForUrl(src: string): string {
  return src.split('/').map((seg) => encodeURIComponent(seg)).join('/')
}

/**
 * 素材图层的 <img> 自适配：把图片撑到 .clip 外框设定的 width/height 里，等比不裁（contain）。
 *
 * 为什么只作用于「裸 img」分支：裸分支 ⟺ 素材层。demo 截图层在 lower.ts（`lowerDemo` 里
 * 每张轮播图）恒被写上 phoneWrap / wideWrap 两个 cssClass 之一，走上面两个取景框分支，
 * 永远到不了这里；preset 套用会剔掉 cssClass，但那是给素材层用的，不会把截图层降级成裸图。
 * 所以给裸分支加内联样式 = 只动用户自己加的素材层，模板既有版式一个像素都不变
 * （image.test 的「phoneWrap/wideWrap 的 img 零内联样式」两条就是这道门禁）。
 *
 * width/height 都没设时返回 undefined——不写任何内联样式，图片按自然尺寸渲（旧行为）。
 * 只设一维时另一维 auto，等比缩放；两维都设时 contain 保证不变形、不裁切。
 *
 * **HF 端同步点**：studio/src/render-html.ts 的 renderImageContent 裸 img 分支拼的是同一组
 * 声明，两端必须同改，否则剪辑台预览与出片不一致。
 */
export function imgFit(style: LayerStyle): React.CSSProperties | undefined {
  if (style.width === undefined && style.height === undefined) return undefined
  return {
    display: 'block',
    width: style.width !== undefined ? '100%' : 'auto',
    height: style.height !== undefined ? '100%' : 'auto',
    objectFit: 'contain',
  }
}

export function ImageContent(
  { src, cssClass, style }: { src: string; cssClass: string | undefined; style: LayerStyle },
): React.ReactElement {
  const safe = encodePathForUrl(src)
  if (cssClass === 'phoneWrap') {
    return <div className="phoneWrap"><div className="phone"><img src={safe} /></div></div>
  }
  if (cssClass === 'wideWrap') {
    return (
      <div className="wideWrap">
        <div className="wideBg" style={{ backgroundImage: `url('${safe}')` }} />
        <div className="wideFg"><img src={safe} /></div>
      </div>
    )
  }
  return <img src={safe} style={imgFit(style)} />
}
