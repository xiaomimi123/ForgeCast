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
import { rebaseSpecForPreview, videoIdFromSpecPath } from '../../lib/rebase'

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
