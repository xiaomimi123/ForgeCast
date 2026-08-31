import React from 'react'

/**
 * 逐段编码：按 `/` 切开、每段 encodeURIComponent、再用 `/` 拼回。
 * 不能用 encodeURI（放过 `#`/`?`，含这两个字符的文件名会被浏览器截断）；
 * 也不能整串 encodeURIComponent（会把 `/` 编成 %2F 拆掉子目录）。
 */
export function encodePathForUrl(src: string): string {
  return src.split('/').map((seg) => encodeURIComponent(seg)).join('/')
}

export function ImageContent({ src, cssClass }: { src: string; cssClass: string | undefined }): React.ReactElement {
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
  return <img src={safe} />
}
