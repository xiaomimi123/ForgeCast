// 预览用的资源路径改基准。原本长在 PreviewTab 里，Task 6 起有第二个消费方（剪辑台
// useEditorState），故抽到 lib/ 共享——函数体一字未改，只换了 import 来源。
import type { VideoSpec } from '@forgecast/compositions/src/videospec-types'

/**
 * 把 spec 里的相对资源路径改成浏览器能取到的绝对 URL。
 *
 * 渲染时 `bundle({ publicDir: hfDir })` 让 `assets/<rel>` 这类**裸相对**路径落到 hf 项目目录；
 * 预览时页面 URL 是 `/projects/<slug>` 之类，同样的相对路径会解析到前端路由下 → 图片/视频全 404，
 * 而画面照样渲得出来（只是缺图），正是本仓库最忌的「零报错坏结果」。所以这里显式改基准：
 * - 图层里的图片/视频 src 是 **hf 目录相对** → `/files/<slug>/hf/<videoId>/<src>`
 * - `audio.narration.src` 是 **workspace 相对**（见 tts.ts）→ `/files/<src>`
 * 只改 URL 基准，不动其它任何字段（spec 不可变，逐层浅拷贝）。
 */
export function rebaseSpecForPreview(spec: VideoSpec, slug: string, videoId: string): VideoSpec {
  /** 已经是协议绝对（`https://…`）、协议相对（`//…`）或根相对（`/…`）的 URL：原样保留，别再拼基准。 */
  const isAbsolute = (src: string): boolean => /^([a-z]+:)?\/\//i.test(src) || src.startsWith('/')
  const narration = spec.audio.narration
  // 旁白的基准是 workspace 根（`/files/`），图层是 hf 目录——基准不同，但「已经是绝对 URL / 根
  // 相对路径就别再拼」这条判断必须一样：只判 `startsWith('/')` 会把 `https://…` 的旁白拼成
  // `/files/https://…`（当前 tts.ts 只产相对路径故不触发，但两条分支不该各判各的）。
  const absFrom = (base: string) => (src: string): string => (isAbsolute(src) ? src : base + src)
  const absLayer = absFrom(`/files/${slug}/hf/${videoId}/`)
  const absNarration = absFrom('/files/')
  return {
    ...spec,
    layers: spec.layers.map((l) => (
      (l.content.kind === 'image' || l.content.kind === 'video')
        ? { ...l, content: { ...l.content, src: absLayer(l.content.src) } }
        : l
    )),
    audio: {
      ...spec.audio,
      narration: narration ? { ...narration, src: absNarration(narration.src) } : null,
    },
  }
}

/** 从 spec_path（`<slug>/specs/<videoId>.json`）里取出 videoId：即去掉目录前缀和 .json 后缀的文件名。 */
export function videoIdFromSpecPath(specPath: string): string {
  const base = specPath.split('/').pop() ?? ''
  return base.replace(/\.json$/, '')
}
