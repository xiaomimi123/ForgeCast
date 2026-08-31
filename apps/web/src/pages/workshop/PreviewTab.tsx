import { useEffect, useRef, useState } from 'react'
import type { Asset } from '../../api'

/** 从 spec_path（`<slug>/specs/<videoId>.json`）里取出 videoId：即去掉目录前缀和 .json 后缀的文件名。 */
function videoIdFromSpecPath(specPath: string): string {
  const base = specPath.split('/').pop() ?? ''
  return base.replace(/\.json$/, '')
}

/** 合成产物页内预览：iframe 加载该项目最近一条视频素材的 hf/<videoId>/index.html，
 *  父页面直接驱动其 window.__timelines 上的 GSAP 时间线。只读预览（播放/暂停/拖动），不做编辑。 */
export default function PreviewTab({ slug, assets }: { slug: string; assets: Asset[] }) {
  const frameRef = useRef<HTMLIFrameElement>(null)
  // 目录改造后每次生成的产物按 videoId 分子目录，不再有唯一的 hf/index.html。
  // 取该项目最近一条 type==='video' 且 spec_path 非空的素材（数组按 id 升序返回，故取最后一条），解出 videoId。
  const latestVideo = [...assets].reverse().find((a) => a.type === 'video' && a.spec_path)
  const videoId = latestVideo?.spec_path ? videoIdFromSpecPath(latestVideo.spec_path) : null
  const [dur, setDur] = useState(0)
  const [t, setT] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [err, setErr] = useState('')
  // 合成产物的宽高比：iframe 的视口由外层 CSS 盒子决定，不会跟着内部文档的声明尺寸自适应缩放——
  // 固定 aspect-video(16:9) 会把竖版(9:16，产品默认比例)合成产物按 16:9 视口裁成左上角一小块。
  // 从 #root 的 data-width/data-height 读真实比例；读不到时默认竖版 9:16（不是 16:9）。
  const [ratio, setRatio] = useState(9 / 16)
  const rafRef = useRef<number | null>(null)

  /** 取 iframe 内那条暂停的 GSAP 主时间线；拿不到返回 null（合成产物还没生成/结构不符） */
  function timeline(): any | null {
    try {
      const w = frameRef.current?.contentWindow as any
      const tls = w?.__timelines
      if (!tls) return null
      const first = Object.values(tls)[0] as any
      return first && typeof first.seek === 'function' ? first : null
    } catch { return null }
  }

  function onLoad() {
    try {
      const doc = frameRef.current?.contentWindow?.document
      const root = doc?.getElementById('root')
      const w = Number(root?.getAttribute('data-width'))
      const h = Number(root?.getAttribute('data-height'))
      if (w > 0 && h > 0) setRatio(w / h)
      else setRatio(9 / 16)
    } catch { setRatio(9 / 16) }
    const tl = timeline()
    if (!tl) { setErr('没读到合成时间线——该项目可能还没生成过视频'); return }
    setErr(''); tl.pause(); setDur(tl.duration()); setT(0); tl.seek(0)
  }

  // 播放：用 rAF 推进 seek，不依赖任何第三方播放器
  useEffect(() => {
    if (!playing) return
    let last = performance.now()
    const step = (now: number) => {
      const tl = timeline()
      if (!tl) { setPlaying(false); return }
      const next = tl.time() + (now - last) / 1000
      last = now
      if (next >= tl.duration()) { tl.seek(tl.duration()); setT(tl.duration()); setPlaying(false); return }
      tl.seek(next); setT(next)
      rafRef.current = requestAnimationFrame(step)
    }
    rafRef.current = requestAnimationFrame(step)
    return () => { if (rafRef.current != null) cancelAnimationFrame(rafRef.current) }
  }, [playing])

  const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`

  return (
    <div className="space-y-3">
      <div className="card p-3">
        <div className="mb-2 text-xs text-faint">
          预览的是该项目最近一条生成的视频素材，不是选中的某条历史视频。
        </div>
        {videoId ? (
          <iframe
            ref={frameRef} onLoad={onLoad} title="composition preview"
            src={`/files/${slug}/hf/${videoId}/index.html`}
            style={{ aspectRatio: ratio }}
            className="w-full rounded border border-hairline bg-black"
          />
        ) : (
          <div className="text-sm text-danger">没读到合成时间线——该项目可能还没生成过视频</div>
        )}
        {err && <div className="mt-2 text-sm text-danger">{err}</div>}
        <div className="mt-3 flex items-center gap-3">
          <button className="btn px-3 py-1 text-sm" disabled={!dur}
            onClick={() => { const tl = timeline(); if (tl) { setPlaying((p) => !p) } }}>
            {playing ? '暂停' : '播放'}
          </button>
          <input type="range" min={0} max={dur || 0} step={0.05} value={t} disabled={!dur}
            className="flex-1"
            onChange={(e) => { const v = Number(e.target.value); const tl = timeline(); if (tl) { tl.seek(v); setT(v) } }} />
          <span className="font-mono text-xs text-sub">{fmt(t)} / {fmt(dur)}</span>
        </div>
      </div>
    </div>
  )
}
