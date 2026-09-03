import { secToFrames } from '@forgecast/compositions/src/time'
import type { VideoSpec } from '@forgecast/compositions/src/videospec-types'
import { deriveShots, moveLayer, resizeLayer, snapStart, type ShotView } from '@forgecast/editing'
import type { PlayerRef } from '@remotion/player'
import { useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react'
import { isUnsupported } from '../../../lib/rebase'
import { fmtTimecode } from './ShotList'
import type { useEditorState } from './useEditorState'

/** §4 尺寸表。三条轨道的高度是**唯一**来源：轨道名列与轨道行都从这个数组渲，才不会各写各的。 */
const HEAD_H = 32
const NAME_W = 104
const TRACKS = [
  { key: 'ruler', name: '刻度', h: 20 },
  { key: 'shots', name: '分镜', h: 46 },
  { key: 'caption', name: '字幕', h: 30 },
] as const
/** Clip 高 38 = 轨 46 减上下 padding 4（§5）。 */
const CLIP_H = 38
/** 拖拽吸附阈值（秒）。0.15 ≈ 半帧多一点，够粘上拍点又不会把人锁死在网格上。 */
const SNAP_SEC = 0.15
/** 边缘热区宽（px）：在这个范围内按下＝改时长，否则＝移动。 */
const EDGE_PX = 8

type Drag =
  | { mode: 'move'; shot: ShotView; base: VideoSpec; startX: number; pxPerSec: number }
  | { mode: 'resize'; shot: ShotView; base: VideoSpec; startX: number; pxPerSec: number; layerId: string; baseDuration: number }

/**
 * 把一个分镜整体平移 delta 秒。
 *
 * 分镜是**一组图层**（文本层 + 背景层 + …），必须整组同步移动，否则一次拖拽就把同段的图层拆散了。
 * `moveLayer` 逐层钳制（不越邻居、不越片长），组内任一层被钳住时，整组都退到那个「被钳后的最小
 * 位移」重算一遍——**宁紧不重叠**：让整组少移一点，也不能出现某层挤进邻居的情况。
 */
export function moveShotBy(base: VideoSpec, shot: ShotView, delta: number): VideoSpec {
  const startOf = (spec: VideoSpec, id: string) => spec.layers.find((l) => l.id === id)?.start
  const applyAll = (d: number) => {
    let next = base
    for (const id of shot.layerIds) {
      const s0 = startOf(base, id)
      if (s0 === undefined) continue
      next = moveLayer(next, id, s0 + d)
    }
    return next
  }
  const first = applyAll(delta)
  // 实际位移取组内**绝对值最小**的那个：它就是这次拖拽真正能走到的距离
  let effective = delta
  for (const id of shot.layerIds) {
    const s0 = startOf(base, id)
    const s1 = startOf(first, id)
    if (s0 === undefined || s1 === undefined) continue
    if (Math.abs(s1 - s0) < Math.abs(effective)) effective = s1 - s0
  }
  if (effective === delta) return first
  return applyAll(effective)
}

/**
 * 底部时间轴（实施说明 §4/§5）。总高 186：头 32 + 刻度 20 + 分镜 46 + 字幕 30。
 *
 * - **对齐是硬验收**（§9：1440/1280/1100 三宽度轨道名列与轨道行不错位）：轨道名列与轨道行共用
 *   同一份 `TRACKS` 高度，且**两边都 `box-sizing:border-box`**——不然每行的 1px 下边框会被算在
 *   高度之外，三行累计差 3px，肉眼就能看出轨道名和轨道错层。
 * - Clip 宽度用 **flex 比例**而不是百分比（§5）：`flex: 时长×10 1 0`。空隙也占一个同样口径的
 *   flex 占位，于是「flex 权重 : 时间」全轨恒为 1:1，Clip 的边缘与刻度、播放头对得上。
 * - 拖拽期间走 `applyTransient`，`pointerup` 才 `commit`：**一次拖拽 = 一步 undo**。
 *   每一帧都从「按下那一刻的 base」重算，不做增量累加，中途松手/回拖都不会漂。
 * - 字幕轨只显示与点选。字幕时间来自 TTS 的 cues，拖了就和语音错位，P1 不给拖。
 */
export default function TimelinePane({ ed, playerRef, currentSec, selectedLayerId, onSelectLayer, className }: {
  ed: ReturnType<typeof useEditorState>
  playerRef: RefObject<PlayerRef>
  currentSec: number
  selectedLayerId: string | null
  onSelectLayer: (layerId: string | null) => void
  className?: string
}) {
  const spec = ed.spec
  const usable = spec && !isUnsupported(spec) ? spec : null
  const shots = useMemo(() => (usable ? deriveShots(usable) : []), [usable])
  const captions = useMemo(
    () => (usable ? usable.layers.filter((l) => l.content.kind === 'caption') : []),
    [usable],
  )
  const duration = usable?.durationSec ?? 0
  const areaRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<Drag | null>(null)
  const [dragId, setDragId] = useState<string | null>(null)
  const [scrubbing, setScrubbing] = useState(false)

  function seekToSec(sec: number) {
    if (!usable) return
    const clamped = Math.min(Math.max(0, sec), Math.max(0, duration - 1 / 30))
    playerRef.current?.seekTo(secToFrames(clamped))
  }
  /** 轨道区内的 x → 秒。轨道区左边界就是 0s，右边界就是片长，与 Clip 的 flex 口径一致。 */
  function secAtClientX(clientX: number): number {
    const r = areaRef.current?.getBoundingClientRect()
    if (!r || r.width === 0) return 0
    return ((clientX - r.left) / r.width) * duration
  }

  function startDrag(e: ReactPointerEvent, shot: ShotView, mode: 'move' | 'resize') {
    if (!usable) return
    e.stopPropagation()
    // 先收掉右栏输入框可能还没收尾的 transient 序列（pointerdown 早于 blur），
    // 否则这次拖拽会和上一次数值编辑挤进同一格 undo。
    ed.commit()
    const r = areaRef.current?.getBoundingClientRect()
    if (!r || r.width === 0 || duration <= 0) return
    const pxPerSec = r.width / duration
    onSelectLayer(preferredLayerId(usable, shot))
    if (mode === 'resize') {
      // 改时长作用在组内**右缘最靠后**的那层：它决定这一镜什么时候结束
      const layerId = [...shot.layerIds]
        .map((id) => usable.layers.find((l) => l.id === id))
        .filter((l): l is NonNullable<typeof l> => !!l)
        .sort((a, b) => (a.start + a.duration) - (b.start + b.duration))
        .pop()?.id
      if (!layerId) return
      const baseDuration = usable.layers.find((l) => l.id === layerId)!.duration
      dragRef.current = { mode, shot, base: usable, startX: e.clientX, pxPerSec, layerId, baseDuration }
    } else {
      dragRef.current = { mode, shot, base: usable, startX: e.clientX, pxPerSec }
    }
    setDragId(shot.sectionId)
    // 捕获挂在**轨道区**（move/up 的监听者）而不是 Clip 自己：Clip 只出 pointerdown，
    // 后续事件靠冒泡回到轨道区处理，避免同一次移动被两处各算一遍。
    areaRef.current?.setPointerCapture(e.pointerId)
  }

  function onDragMove(e: ReactPointerEvent) {
    const d = dragRef.current
    if (!d) return
    const deltaSec = (e.clientX - d.startX) / d.pxPerSec
    if (d.mode === 'move') {
      const raw = Math.max(0, d.shot.startSec + deltaSec)
      // 吸附**先于**钳制：先把「用户想放的位置」吸到拍点，再由 moveLayer 去撞邻居。
      // 反过来（先钳后吸）会把刚钳到邻居边上的位置又吸走，重新叠进邻居。
      const snapped = snapStart(d.base, d.shot.layerIds[0], raw, SNAP_SEC)
      ed.applyTransient(moveShotBy(d.base, d.shot, snapped - d.shot.startSec))
    } else {
      ed.applyTransient(resizeLayer(d.base, d.layerId, d.baseDuration + deltaSec))
    }
  }

  function endDrag(e: ReactPointerEvent) {
    if (!dragRef.current) return
    dragRef.current = null
    setDragId(null)
    // 一次拖拽收成一步 undo（拖回原位则什么也不压）
    ed.commit()
    releaseArea(e.pointerId)
  }
  function releaseArea(pointerId: number) {
    const a = areaRef.current
    if (a?.hasPointerCapture(pointerId)) a.releasePointerCapture(pointerId)
  }

  /** 轨道空白（含刻度轨、播放头）按下 = 定位播放头，按住拖 = scrub。 */
  function onAreaPointerDown(e: ReactPointerEvent) {
    if (!usable || dragRef.current) return
    setScrubbing(true)
    areaRef.current?.setPointerCapture(e.pointerId)
    seekToSec(secAtClientX(e.clientX))
  }
  function onAreaPointerMove(e: ReactPointerEvent) {
    if (dragRef.current) { onDragMove(e); return }
    if (scrubbing) seekToSec(secAtClientX(e.clientX))
  }
  function onAreaPointerUp(e: ReactPointerEvent) {
    if (dragRef.current) { endDrag(e); return }
    setScrubbing(false)
    releaseArea(e.pointerId)
  }

  const pct = (sec: number) => (duration > 0 ? `${(sec / duration) * 100}%` : '0%')

  return (
    <section
      className={`overflow-hidden rounded-[var(--fc-r-md)] border border-[var(--fc-line)] bg-[var(--fc-surface)] ${className ?? ''}`}
      style={{ height: 186, boxSizing: 'border-box' }}
    >
      <div
        className="flex items-center gap-3 border-b border-[var(--fc-line)] px-3"
        style={{ height: HEAD_H, boxSizing: 'border-box' }}
      >
        <span className="font-mono text-[12px] tabular-nums text-[var(--fc-ink)]">{fmtTimecode(currentSec)}</span>
        <span className="font-mono text-[10px] text-[var(--fc-faint)]">/ {fmtTimecode(duration)}</span>
        <span className="ml-auto font-mono text-[10px] uppercase tracking-wide text-[var(--fc-muted)]">
          {usable ? `${shots.length} 镜 · 拖分镜移动，拖右缘改时长` : '时间轴'}
        </span>
      </div>

      {!usable ? (
        <div className="p-3 text-xs text-[var(--fc-faint)]">
          {spec ? '自定义模板没有图层模型，时间轴无内容可显示。' : '选中一条已出片的内容后，这里显示它的时间轴。'}
        </div>
      ) : (
        <div className="flex">
          {/* 轨道名列 104 固定 */}
          <div className="shrink-0 border-r border-[var(--fc-line)]" style={{ width: NAME_W, boxSizing: 'border-box' }}>
            {TRACKS.map((t) => (
              <div
                key={t.key}
                className="flex items-center border-b border-[var(--fc-track)] px-3 font-mono text-[10px] text-[var(--fc-muted)]"
                style={{ height: t.h, boxSizing: 'border-box' }}
              >
                {t.name}
              </div>
            ))}
          </div>

          {/* 轨道区：与轨道名列**同一份**高度 + 同样的 border-box */}
          <div
            ref={areaRef}
            className="relative min-w-0 flex-1 touch-none select-none"
            onPointerDown={onAreaPointerDown}
            onPointerMove={onAreaPointerMove}
            onPointerUp={onAreaPointerUp}
            onPointerCancel={onAreaPointerUp}
          >
            {/* 刻度轨 20 */}
            <div
              className="relative border-b border-[var(--fc-track)]"
              style={{ height: TRACKS[0].h, boxSizing: 'border-box' }}
            >
              {Array.from({ length: Math.floor(duration) + 1 }, (_, s) => (
                <div key={s} className="absolute bottom-0" style={{ left: pct(s) }}>
                  <div style={{ width: 1, height: s % 5 === 0 ? 9 : 4, background: 'var(--fc-line-2)' }} />
                  {s % 5 === 0 && (
                    <span className="absolute left-1 top-0 font-mono text-[9px] leading-none text-[var(--fc-faint)]">{s}</span>
                  )}
                </div>
              ))}
            </div>

            {/* 分镜轨 46：Clip 高 38，宽用 flex 比例（§5），空隙用同口径的占位撑开 */}
            <div
              className="flex items-center border-b border-[var(--fc-track)]"
              style={{ height: TRACKS[1].h, boxSizing: 'border-box', padding: '4px 0' }}
            >
              {layoutRow(shots, duration).map((cell) => (
                cell.kind === 'gap' ? (
                  <div key={cell.key} style={{ flex: `${cell.weight} 1 0` }} />
                ) : (
                  <Clip
                    key={cell.key}
                    shot={cell.shot}
                    weight={cell.weight}
                    current={currentSec >= cell.shot.startSec && currentSec < cell.shot.endSec}
                    dragging={dragId === cell.shot.sectionId}
                    onPointerDown={(e) => {
                      const box = (e.currentTarget as HTMLElement).getBoundingClientRect()
                      startDrag(e, cell.shot, box.right - e.clientX <= EDGE_PX ? 'resize' : 'move')
                    }}
                  />
                )
              ))}
            </div>

            {/* 字幕轨 30：细条，只显示 + 点选，不可拖 */}
            <div
              className="relative border-b border-[var(--fc-track)]"
              style={{ height: TRACKS[2].h, boxSizing: 'border-box' }}
            >
              {captions.map((l) => (
                <div
                  key={l.id}
                  title="字幕跟随旁白，不可拖"
                  onPointerDown={(e) => {
                    e.stopPropagation()
                    onSelectLayer(l.id)
                    seekToSec(l.start)
                  }}
                  className={`absolute cursor-pointer overflow-hidden truncate rounded-[var(--fc-r-xs)] px-1 text-[9px] leading-[14px] ${
                    selectedLayerId === l.id
                      ? 'bg-[var(--fc-accent-tint)] text-[var(--fc-accent-deep)]'
                      : 'bg-[var(--fc-sunken)] text-[var(--fc-muted)]'
                  }`}
                  style={{
                    left: pct(l.start), width: pct(l.duration), top: 8, height: 14,
                    boxSizing: 'border-box',
                    border: selectedLayerId === l.id ? '1px solid var(--fc-accent)' : '1px solid var(--fc-line)',
                  }}
                >
                  {l.content.kind === 'caption' ? l.content.text : ''}
                </div>
              ))}
              {captions.length === 0 && (
                <span className="absolute left-2 top-2 text-[10px] text-[var(--fc-faint)]">这条视频没有字幕图层</span>
              )}
            </div>

            {/* 播放头：accent 竖线贯穿三轨。pointer-events:none，否则它会挡住底下 Clip 的拖拽 */}
            <div
              className="pointer-events-none absolute top-0"
              style={{
                left: pct(currentSec), width: 1,
                height: TRACKS.reduce((a, t) => a + t.h, 0),
                background: 'var(--fc-accent)',
              }}
            />
          </div>
        </div>
      )}
    </section>
  )
}

/** 该分镜被点选时进检查器的图层：优先唯一文本层（用户想调的多半是字），否则第一层。 */
function preferredLayerId(spec: VideoSpec, shot: ShotView): string {
  const text = shot.layerIds.filter((id) => spec.layers.find((l) => l.id === id)?.content.kind === 'text')
  return text.length === 1 ? text[0] : shot.layerIds[0]
}

type Cell =
  | { kind: 'gap'; key: string; weight: number }
  | { kind: 'clip'; key: string; weight: number; shot: ShotView }

/**
 * 把分镜排成一行 flex 单元：`flex: 时长×10 1 0`（§5，**不用百分比**）。
 * 分镜之间和首尾的空隙也占一个同口径的占位，否则「权重 : 时间」不再是 1:1，
 * Clip 的边缘就会和刻度、播放头对不上——那正是时间轴最不能出的错。
 */
export function layoutRow(shots: ShotView[], duration: number): Cell[] {
  const cells: Cell[] = []
  const w = (sec: number) => Math.max(0, sec) * 10
  let cursor = 0
  for (const shot of [...shots].sort((a, b) => a.startSec - b.startSec)) {
    if (shot.startSec > cursor) cells.push({ kind: 'gap', key: `gap-${shot.sectionId}`, weight: w(shot.startSec - cursor) })
    cells.push({ kind: 'clip', key: shot.sectionId, weight: w(shot.endSec - shot.startSec), shot })
    cursor = Math.max(cursor, shot.endSec)
  }
  if (duration > cursor) cells.push({ kind: 'gap', key: 'gap-tail', weight: w(duration - cursor) })
  return cells
}

/** §5 `Clip`：高 38；default / current（accent 描边 + tint 底）/ dragging（虚线 + 阴影 + 时间码）。 */
function Clip({ shot, weight, current, dragging, ...handlers }: {
  shot: ShotView
  weight: number
  current: boolean
  dragging: boolean
  onPointerDown: (e: ReactPointerEvent) => void
}) {
  return (
    <div
      {...handlers}
      title={`${shot.text.slice(0, 40)}｜拖动移动，拖右缘改时长`}
      className="relative flex min-w-0 cursor-grab items-center overflow-hidden px-1.5 text-[10px]"
      style={{
        flex: `${weight} 1 0`,
        height: CLIP_H,
        boxSizing: 'border-box',
        borderRadius: 'var(--fc-r-sm)',
        border: dragging
          ? '1px dashed var(--fc-accent)'
          : current ? '1px solid var(--fc-accent)' : '1px solid var(--fc-line-2)',
        background: dragging || current ? 'var(--fc-accent-tint)' : 'var(--fc-bg)',
        boxShadow: dragging ? '0 2px 6px rgba(0,0,0,.18)' : undefined,
        color: current || dragging ? 'var(--fc-accent-deep)' : 'var(--fc-muted)',
      }}
    >
      <span className="min-w-0 flex-1 truncate">
        {dragging ? `${fmtTimecode(shot.startSec)} → ${(shot.endSec - shot.startSec).toFixed(1)}s` : shot.text || '（空）'}
      </span>
      {/* 右缘热区：视觉上一条细把手，命中判定在 startDrag 里按 EDGE_PX 算 */}
      <span
        className="absolute right-0 top-0 h-full cursor-ew-resize"
        style={{ width: EDGE_PX, borderRight: '2px solid var(--fc-line-2)', boxSizing: 'border-box' }}
      />
    </div>
  )
}
