import { useEffect, useRef, useState } from 'react'

/** 合成产物页内预览：iframe 加载 hf/index.html，父页面直接驱动其 window.__timelines 上的 GSAP 时间线。
 *  只读预览（播放/暂停/拖动），不做编辑。 */
export default function PreviewTab({ slug }: { slug: string }) {
  const frameRef = useRef<HTMLIFrameElement>(null)
  const [dur, setDur] = useState(0)
  const [t, setT] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [err, setErr] = useState('')
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
          预览的是该项目**最近一次生成**的合成产物（每个项目一份、每次生成覆盖），不是选中的某条历史视频。
        </div>
        <iframe
          ref={frameRef} onLoad={onLoad} title="composition preview"
          src={`/files/${slug}/hf/index.html`}
          className="aspect-video w-full rounded border border-hairline bg-black"
        />
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
