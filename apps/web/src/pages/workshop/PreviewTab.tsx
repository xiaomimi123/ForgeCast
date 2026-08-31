import { Player } from '@remotion/player'
// 深导入而非走包入口 `@forgecast/compositions`：入口带六份 CSS 的**副作用导入**，那样进来的样式
// 是「无层」的，会压过 Tailwind v4 放在 @layer utilities 里的所有工具类（base.css 里
// `* { margin:0;padding:0 }` 是给 1080×1920 渲染页写的，泄漏进控制台会把全站间距打平）。
// 样式改由 index.css 用 `@import ... layer(forgecast-compositions)` 引入，见那里的注释。
import { SpecComposition } from '@forgecast/compositions/src/SpecComposition'
import { FPS, secToFrames } from '@forgecast/compositions/src/time'
import type { VideoSpec } from '@forgecast/compositions/src/videospec-types'
import { useEffect, useState } from 'react'
import type { Asset } from '../../api'

/** 从 spec_path（`<slug>/specs/<videoId>.json`）里取出 videoId：即去掉目录前缀和 .json 后缀的文件名。 */
function videoIdFromSpecPath(specPath: string): string {
  const base = specPath.split('/').pop() ?? ''
  return base.replace(/\.json$/, '')
}

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

/**
 * 这份 spec 能不能用 Player 播？
 * 自定义模板（`custom-<id>`，见 generate.ts renderCustomTemplate）落的是 `layers: []` 的占位 spec，
 * 只为满足 spec_path 落库契约；它的画面在 hf 目录的 index.html 里，不在图层模型里。
 * 不拦的话：spec_path 非空 → 正常加载、时长正确、能拖动，但**画面全程空白**且零报错。
 */
export function isUnsupported(spec: VideoSpec): boolean {
  return spec.template.startsWith('custom-') || spec.layers.length === 0
}

/** 合成产物页内预览：用 @remotion/player 直接播该项目最近一条视频素材的 VideoSpec。
 *  与成片走的是同一套 React 组件（`SpecComposition`）和同一个 fps，只读预览，不做编辑。 */
export default function PreviewTab({ slug, assets }: { slug: string; assets: Asset[] }) {
  // 目录改造后每次生成的产物按 videoId 分子目录。
  // 取该项目最近一条 type==='video' 且 spec_path 非空的素材，解出 videoId：
  // GET /api/projects/:slug/assets（packages/server/src/app.ts:231）按 id DESC 返回，
  // 即 assets[0] 最新——find() 从头找到的第一条已经是最新，不需要也不能 reverse()。
  const latestVideo = assets.find((a) => a.type === 'video' && a.spec_path)
  const specPath = latestVideo?.spec_path ?? null
  const [spec, setSpec] = useState<VideoSpec | null>(null)
  const [err, setErr] = useState('')

  useEffect(() => {
    setSpec(null)
    // spec_path 为 NULL 的历史素材（改造前生成的）没有素材包：走空状态，不请求也不崩。
    if (!specPath) { setErr('没读到合成时间线——该项目可能还没生成过视频'); return }
    setErr('')
    let alive = true
    const videoId = videoIdFromSpecPath(specPath)
    fetch(`/files/${specPath}`)
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json() })
      .then((json: VideoSpec) => { if (alive) setSpec(rebaseSpecForPreview(json, slug, videoId)) })
      .catch((e) => { if (alive) setErr(`素材包读取失败：${e instanceof Error ? e.message : String(e)}`) })
    return () => { alive = false }
  }, [specPath, slug])

  return (
    <div className="space-y-3">
      <div className="card p-3">
        <div className="mb-2 text-xs text-faint">
          预览的是该项目最近一条生成的视频素材，不是选中的某条历史视频。
        </div>
        {spec && !isUnsupported(spec) ? (
          // 外层按 spec 的宽高比把高度封在 70vh 内：Player 自己保持比例，只给宽度约束。
          // 竖版 9:16 直接铺满卡片宽度会高出两个屏幕，得往下滚才能看见播放条。
          <div style={{ maxWidth: `calc(70vh * ${spec.canvas.width} / ${spec.canvas.height})`, margin: '0 auto' }}>
            <Player
              component={SpecComposition}
              inputProps={{ spec }}
              durationInFrames={Math.max(1, secToFrames(spec.durationSec))}
              fps={FPS}
              // 宽高比由 spec.canvas 决定：产品默认竖版 9:16，写死 16:9 会把竖版裁成左上角一小块，
              // 而「有画面/能播/拖动跟手」在被裁切的产物上照样全过——这个坑踩过。
              compositionWidth={spec.canvas.width}
              compositionHeight={spec.canvas.height}
              style={{ width: '100%' }}
              controls
            />
          </div>
        ) : (
          !err && !spec && <div className="text-sm text-sub">载入素材包…</div>
        )}
        {spec && isUnsupported(spec) && (
          <div className="text-sm text-sub">
            自定义模板暂不支持实时预览——它的画面由 LLM 产出的模板 HTML 直接渲染，
            没有走图层模型（spec 的 layers 是空的），播放器只会得到一片空白。请下载成片查看。
          </div>
        )}
        {err && <div className="mt-2 text-sm text-danger">{err}</div>}
      </div>
    </div>
  )
}
