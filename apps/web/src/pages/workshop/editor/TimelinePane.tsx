import { secToFrames } from '@forgecast/compositions/src/time'
import type { VideoSpec } from '@forgecast/compositions/src/videospec-types'
import {
  addCaptionLayer, addManualBeat, allBeats, deriveShots, layoutRow, moveLayer, moveShotBy,
  removeCaptionLayer, removeManualBeat, resizeLayer, snapToBeats, trimVideoLayer, updateLayerText,
  type Beat, type ShotView,
} from '@forgecast/editing'
import type { PlayerRef } from '@remotion/player'
import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type RefObject } from 'react'
import type { ConfirmOpts } from '../../../components/ui/Confirm'
import { isUnsupported } from '../../../lib/rebase'
import { fmtTimecode } from './ShotList'
import { isManualCaption } from './ui'
import type { useEditorState } from './useEditorState'

/** §4 尺寸表。五条轨道的高度是**唯一**来源：轨道名列与轨道行都从这个数组渲，才不会各写各的。
 *  20+46+30+30+26 = 152，加头 32 = 184 ≤ 186（容器高度不变）。
 *
 * `compact:false` 的轨（字幕 / BGM）在 <1040 时不渲染——§4 原文「只留分镜+卡点两轨」，这里把
 * 刻度轨也留下：它是播放头定位/scrub 的基础设施而非可编辑内容轨，且 20px 很薄，不留它反而让
 * 分镜/卡点轨没有时间参照物。留它之后 compact 高度 = 头32 + 刻度20 + 分镜46 + 卡点26 = 124 ≤ 148。 */
const HEAD_H = 32
const NAME_W = 104
type TrackDef = {
  key: 'ruler' | 'film' | 'shots' | 'caption' | 'bgm' | 'beats'
  name: string
  h: number
  compact: boolean
  /** talk 独有的轨（口播底片）——其余六模板没有视频层，这一轨不渲染也不占高度。 */
  talkOnly?: boolean
}
const TRACKS_ALL: TrackDef[] = [
  { key: 'ruler', name: '刻度', h: 20, compact: true },
  { key: 'film', name: '口播底片', h: 26, compact: true, talkOnly: true },
  { key: 'shots', name: '分镜', h: 46, compact: true },
  { key: 'caption', name: '字幕', h: 30, compact: false },
  { key: 'bgm', name: 'BGM', h: 30, compact: false },
  { key: 'beats', name: '卡点', h: 26, compact: true },
]
/** 五模板下的容器高度（§4）。talk 多一条 26 的底片轨，见 `timelineHeight`。 */
export const TIMELINE_H = 186
export const TIMELINE_H_COMPACT = 148

/** 这份 spec 需不需要底片轨：talk 且真有视频层（老 spec / 手工删层都可能没有）。 */
export function hasFilmTrack(spec: VideoSpec | null | undefined): boolean {
  if (!spec || isUnsupported(spec)) return false
  return spec.template === 'talk' && spec.layers.some((l) => l.content.kind === 'video')
}

/**
 * 时间轴容器高度。**EditorPage 的网格行高与本组件的 section 高度必须同源**——两边各写各的，
 * talk 多出来的那一轨就会溢出网格行（时间轴被下一块盖住半条卡点轨）。
 */
export function timelineHeight(spec: VideoSpec | null | undefined, compact: boolean): number {
  const base = compact ? TIMELINE_H_COMPACT : TIMELINE_H
  return base + (hasFilmTrack(spec) ? TRACKS_ALL.find((t) => t.key === 'film')!.h : 0)
}
/** Clip 高 38 = 轨 46 减上下 padding 4（§5）。 */
const CLIP_H = 38
/** 拖拽吸附阈值（秒）。0.15 ≈ 半帧多一点，够粘上拍点又不会把人锁死在网格上。 */
const SNAP_SEC = 0.15
/** 边缘热区宽（px）：在这个范围内按下＝改时长，否则＝移动。 */
const EDGE_PX = 8

type Drag =
  /** `beats`：按下那一刻的吸附候选（含手动点）。**在 dragstart 算一次**而不是每帧重算——
   *  拖拽期间 spec 每帧都在 applyTransient 里换新对象，每帧重跑网格外推是白烧 CPU；
   *  而拍点本身不会因为移分镜而变，一次算好即可。 */
  | { mode: 'move'; shot: ShotView; base: VideoSpec; startX: number; pxPerSec: number; beats: number[] }
  | { mode: 'resize'; shot: ShotView; base: VideoSpec; startX: number; pxPerSec: number; layerId: string; baseDuration: number }
  /** talk 口播底片的两端裁剪。`edge` 决定 δ 的符号换算，见 `onDragMove`。 */
  | { mode: 'trim'; base: VideoSpec; startX: number; pxPerSec: number; layerId: string; edge: 'start' | 'end' }
  /** talk 手动字幕的挪位 / 改时长（普通图层口径：moveLayer / resizeLayer）。 */
  | { mode: 'cap-move'; base: VideoSpec; startX: number; pxPerSec: number; layerId: string; baseStart: number; beats: number[] }
  | { mode: 'cap-resize'; base: VideoSpec; startX: number; pxPerSec: number; layerId: string; baseDuration: number }

/**
 * 底部时间轴（实施说明 §4/§5）。容器 186：头 32 + 刻度 20 + 分镜 46 + 字幕 30 + BGM 30 + 卡点 26 = 184。
 * `compact`（<1040）时容器降到 148：字幕/BGM 两轨隐藏，头 32 + 刻度 20 + 分镜 46 + 卡点 26 = 124。
 *
 * - **对齐是硬验收**（§9：1440/1280/1100 三宽度轨道名列与轨道行不错位）：轨道名列与轨道行共用
 *   同一份 `TRACKS` 高度，且**两边都 `box-sizing:border-box`**——不然每行的 1px 下边框会被算在
 *   高度之外，三行累计差 3px，肉眼就能看出轨道名和轨道错层。
 * - Clip 宽度用 **flex 比例**而不是百分比（§5）：`flex: 时长×10 1 0`。空隙也占一个同样口径的
 *   flex 占位，于是「flex 权重 : 时间」全轨恒为 1:1，Clip 的边缘与刻度、播放头对得上。
 * - 拖拽期间走 `applyTransient`，`pointerup` 才 `commit`：**一次拖拽 = 一步 undo**。
 *   每一帧都从「按下那一刻的 base」重算，不做增量累加，中途松手/回拖都不会漂。
 * - 字幕轨在**五模板下只显示与点选**：字幕时间来自 TTS 的 cues，拖了就和语音错位。
 *   **talk 例外**：talk 没有 TTS（人声在底片里），字幕是用户自己打的，所以可拖、可改时长，
 *   空白双击还能就地插一条（子项目④ Task 7）。
 * - talk 另有一条 26 的**口播底片轨**：底片 start 恒 0、duration 恒等于 durationSec，
 *   拖两端＝裁剪（`trimVideoLayer`）而不是移动——挪一条铺满全轨的底片没有意义。
 *   它不进分镜轨：底片跨越整条时间轴，混进 `layoutRow` 会把与它同起点的动效分镜压成 0 宽。
 */
export default function TimelinePane({
  slug, videoId, ed, playerRef, currentSec, selectedLayerId, onSelectLayer, onNotice, confirm, className, compact,
}: {
  /** 波形端点要项目 slug + videoId；两者缺一就只显示「无背景乐 / 波形不可用」，不发请求。 */
  slug: string
  videoId: string | null
  ed: ReturnType<typeof useEditorState>
  playerRef: RefObject<PlayerRef>
  currentSec: number
  selectedLayerId: string | null
  onSelectLayer: (layerId: string | null) => void
  onNotice: (msg: string) => void
  /** 与 EditorPage 共享的 in-app 确认（删手动卡点用轻确认）。 */
  confirm: (opts: ConfirmOpts) => Promise<boolean>
  className?: string
  /** <1040（§4）：字幕/BGM 两轨隐藏，容器降到 148。EditorPage 按 matchMedia 传入。 */
  compact?: boolean
}) {
  const spec = ed.spec
  const usable = spec && !isUnsupported(spec) ? spec : null
  /** talk 才有底片轨与可编辑字幕轨；判定同 `hasFilmTrack`（EditorPage 算行高用的也是它）。 */
  const isTalk = hasFilmTrack(usable)
  const film = useMemo(() => (isTalk ? usable!.layers.find((l) => l.content.kind === 'video') ?? null : null), [usable, isTalk])
  const TRACKS = TRACKS_ALL.filter((t) => (!t.talkOnly || isTalk) && (!compact || t.compact))
  const trackH = (key: TrackDef['key']) => TRACKS_ALL.find((t) => t.key === key)!.h
  const containerH = timelineHeight(usable, !!compact)
  const allShots = useMemo(() => (usable ? deriveShots(usable) : []), [usable])
  /** 分镜轨只排非底片的分镜：底片自己占一轨（见组件头注释）。 */
  const shots = useMemo(
    () => (film ? allShots.filter((s) => !s.layerIds.includes(film.id)) : allShots),
    [allShots, film],
  )
  const captions = useMemo(
    () => (usable ? usable.layers.filter((l) => l.content.kind === 'caption') : []),
    [usable],
  )
  const duration = usable?.durationSec ?? 0
  const beatGrid = usable?.audio.beatGrid ?? null
  const beats = useMemo(() => allBeats(beatGrid, duration), [beatGrid, duration])
  const bgmSrc = usable?.audio.bgm?.src ?? null
  const wave = useWaveform(slug, videoId, bgmSrc)
  const areaRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<Drag | null>(null)
  const [dragId, setDragId] = useState<string | null>(null)
  const [scrubbing, setScrubbing] = useState(false)
  /** 卡点轨上一次按下的时刻与位置——自己判定「双击」，见 `onBeatTrackPointerDown`。 */
  const lastTapRef = useRef<{ t: number; x: number } | null>(null)
  /** 字幕轨（talk）的双击判定。`id` 是被按到的字幕层，`null`＝按在空白上——两者不互相触发。 */
  const lastCapTapRef = useRef<{ id: string | null; t: number; x: number } | null>(null)
  /** 正在就地改字的字幕层 id（talk）。新插入的字幕会自动进这个态。 */
  const [editingCapId, setEditingCapId] = useState<string | null>(null)
  /** Esc 取消：`onKeyDown` 里置位，随后的 `onBlur` 据此跳过提交（Esc 会先 blur 再走 onBlur）。 */
  const capCancelRef = useRef(false)

  // 换内容项 / spec 被整包换掉后，正在编辑的字幕可能已不存在——收掉编辑态，别挂着一个孤儿输入框
  useEffect(() => {
    if (editingCapId && !captions.some((l) => l.id === editingCapId)) setEditingCapId(null)
  }, [captions, editingCapId])

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
      dragRef.current = {
        mode, shot, base: usable, startX: e.clientX, pxPerSec,
        beats: allBeats(usable.audio.beatGrid, usable.durationSec).map((b) => b.t),
      }
    }
    setDragId(shot.sectionId)
    // 捕获挂在**轨道区**（move/up 的监听者）而不是 Clip 自己：Clip 只出 pointerdown，
    // 后续事件靠冒泡回到轨道区处理，避免同一次移动被两处各算一遍。
    capture(e.pointerId)
  }

  /**
   * talk 口播底片：**只在两端热区起拖**，拖的是裁剪不是位移。
   * 中间按下什么也不做（底片 start 恒 0，挪它无意义）——只把它选中，右栏能出 trim/音量数字字段。
   */
  function startFilmDrag(e: ReactPointerEvent, layerId: string, edge: 'start' | 'end' | null) {
    if (!usable) return
    e.stopPropagation()
    onSelectLayer(layerId)
    if (!edge) return
    ed.commit()
    const r = areaRef.current?.getBoundingClientRect()
    if (!r || r.width === 0 || duration <= 0) return
    dragRef.current = { mode: 'trim', base: usable, startX: e.clientX, pxPerSec: r.width / duration, layerId, edge }
    setDragId(layerId)
    capture(e.pointerId)
  }

  /** talk 手动字幕：右缘热区＝改时长，其余＝挪位（与分镜 Clip 同一套口径）。 */
  function startCaptionDrag(e: ReactPointerEvent, layer: { id: string; start: number; duration: number }, mode: 'cap-move' | 'cap-resize') {
    if (!usable) return
    ed.commit()
    const r = areaRef.current?.getBoundingClientRect()
    if (!r || r.width === 0 || duration <= 0) return
    const pxPerSec = r.width / duration
    dragRef.current = mode === 'cap-resize'
      ? { mode, base: usable, startX: e.clientX, pxPerSec, layerId: layer.id, baseDuration: layer.duration }
      : {
        mode, base: usable, startX: e.clientX, pxPerSec, layerId: layer.id, baseStart: layer.start,
        beats: allBeats(usable.audio.beatGrid, usable.durationSec).map((b) => b.t),
      }
    setDragId(layer.id)
    capture(e.pointerId)
  }

  function onDragMove(e: ReactPointerEvent) {
    const d = dragRef.current
    if (!d) return
    const deltaSec = (e.clientX - d.startX) / d.pxPerSec
    if (d.mode === 'trim') {
      // δ 的符号：`trimVideoLayer` 里 δ>0 恒等于「多裁掉」。左缘往右拖（+px）＝多裁头，同号；
      // 右缘往左拖（−px）＝多裁尾，反号。两端都是「往里拖＝裁掉，往外拖＝吐回来」。
      ed.applyTransient(trimVideoLayer(d.base, d.layerId, d.edge, d.edge === 'start' ? deltaSec : -deltaSec))
      return
    }
    if (d.mode === 'cap-move') {
      const snapped = snapToBeats(d.beats, Math.max(0, d.baseStart + deltaSec), SNAP_SEC)
      ed.applyTransient(moveLayer(d.base, d.layerId, snapped))
      return
    }
    if (d.mode === 'cap-resize') {
      ed.applyTransient(resizeLayer(d.base, d.layerId, d.baseDuration + deltaSec))
      return
    }
    if (d.mode === 'move') {
      const raw = Math.max(0, d.shot.startSec + deltaSec)
      // 吸附**先于**钳制：先把「用户想放的位置」吸到拍点，再由 moveLayer 去撞邻居。
      // 反过来（先钳后吸）会把刚钳到邻居边上的位置又吸走，重新叠进邻居。
      // 候选是 `allBeats` 的**全部** t（P1 的 snapStart 只读 t0+n·T 网格）：手动加的卡点
      // 若不进候选，用户在时间轴上亲手标的那一刀反而吸不上，是最反直觉的一种失灵。
      const snapped = snapToBeats(d.beats, raw, SNAP_SEC)
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
  /** 指针捕获的成败**不能影响拖拽本身**：某些浏览器/合成事件下 setPointerCapture 会抛
   *  NotFoundError，让它冒出去就会把已经开始的拖拽卡在半途（dragRef 留着、再也收不了尾）。 */
  function capture(pointerId: number) {
    try { areaRef.current?.setPointerCapture(pointerId) } catch { /* 捕获失败就退回冒泡，行为不变 */ }
  }
  function releaseArea(pointerId: number) {
    const a = areaRef.current
    try { if (a?.hasPointerCapture(pointerId)) a.releasePointerCapture(pointerId) } catch { /* 同上 */ }
  }

  /** 轨道空白（含刻度轨、播放头）按下 = 定位播放头，按住拖 = scrub。 */
  function onAreaPointerDown(e: ReactPointerEvent) {
    if (!usable || dragRef.current) return
    setScrubbing(true)
    capture(e.pointerId)
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

  /**
   * 「检出未用」的拍点点一下 = **切分镜**（§5）。
   *
   * 语义与手动拖拽**同一函数**：找 `startSec` 距该拍最近的分镜，把它整组平移到该拍
   * （`moveShotBy(spec, shot, t - shot.startSec)`）——即「把最近的一条分镜边界吸到这一拍」。
   * 不新建分镜、不切断图层：spec 的分镜是语义段派生的，凭一个拍点造不出新段，
   * 「切」在这里只能是「把已有的那一刀挪到拍上」。
   * `moveShotBy` 会被邻居/片长钳住，钳成 0 位移时给提示而不是压一格空 undo。
   */
  function cutShotAt(t: number) {
    if (!usable || shots.length === 0) return
    const shot = shots.reduce((a, b) => (Math.abs(b.startSec - t) < Math.abs(a.startSec - t) ? b : a))
    const next = moveShotBy(usable, shot, t - shot.startSec)
    const id = shot.layerIds[0]
    const before = usable.layers.find((l) => l.id === id)?.start
    const after = next.layers.find((l) => l.id === id)?.start
    if (before === after) { onNotice('该拍点处放不下分镜边界（被相邻分镜或片长挡住了）'); return }
    ed.commit()
    ed.apply(next)
    onSelectLayer(preferredLayerId(usable, shot))
    onNotice(`已把这一镜的入点移到 ${fmtTimecode(t)}`)
  }

  async function removeBeatAt(t: number) {
    if (!usable) return
    if (!(await confirm({ title: '删除此手动卡点？', body: `${fmtTimecode(t)} 处的手动卡点将被移除（可 ⌘/Ctrl+Z 撤销）。`, danger: true }))) return
    // await 期间用户可能已经切了内容项/改了 spec：重新从 ed.spec 取，别用捕获的旧 usable
    const cur = ed.spec
    if (!cur || isUnsupported(cur)) return
    const next = removeManualBeat(cur, t)
    if (next === cur) { onNotice('这个卡点已经不在了'); return }
    ed.commit()
    ed.apply(next)
    onNotice('已删除手动卡点')
  }

  /**
   * 卡点轨空白**双击** = 加一个手动卡点。
   *
   * 不用 `onDoubleClick`：轨道区在 pointerdown 时会 `setPointerCapture`（scrub 用），
   * Chrome 于是把随后的 click/dblclick 打到**捕获元素（轨道区）**上——卡点轨是它的子节点，
   * 事件不会向下冒到这里，`ondblclick` 一次都不会触发（实测就是不响应）。
   * 所以在自己的 pointerdown 里按「350ms 内、位移 <6px」判定双击，这条路不受捕获影响。
   */
  const DBL_MS = 350
  const DBL_PX = 6
  function onBeatTrackPointerDown(e: ReactPointerEvent) {
    const now = e.timeStamp || Date.now()
    const prev = lastTapRef.current
    if (prev && now - prev.t <= DBL_MS && Math.abs(e.clientX - prev.x) <= DBL_PX) {
      lastTapRef.current = null
      addBeatAtClientX(e.clientX)
      return
    }
    lastTapRef.current = { t: now, x: e.clientX }
  }

  function addBeatAtClientX(clientX: number) {
    if (!usable) return
    const t = Math.min(Math.max(0, secAtClientX(clientX)), duration)
    const next = addManualBeat(usable, t)
    if (next === usable) { onNotice('这里已经有卡点了'); return }
    ed.commit()
    ed.apply(next)
    onNotice(`已在 ${fmtTimecode(t)} 加卡点`)
  }

  /**
   * 字幕轨（talk）空白**双击** = 在这里插一条手动字幕，并直接进就地编辑态。
   * 判定方式与卡点轨同一套（指针捕获会吃掉 dblclick，见 `onBeatTrackPointerDown` 的注释）。
   */
  function onCaptionTrackPointerDown(e: ReactPointerEvent) {
    if (!isTalk) return
    const now = e.timeStamp || Date.now()
    const prev = lastCapTapRef.current
    if (prev && prev.id === null && now - prev.t <= DBL_MS && Math.abs(e.clientX - prev.x) <= DBL_PX) {
      lastCapTapRef.current = null
      addCaptionAtClientX(e.clientX)
      return
    }
    lastCapTapRef.current = { id: null, t: now, x: e.clientX }
  }

  const NEW_CAPTION_TEXT = '新字幕'

  function addCaptionAtClientX(clientX: number) {
    if (!usable) return
    const t = Math.min(Math.max(0, secAtClientX(clientX)), duration)
    const next = addCaptionLayer(usable, t, NEW_CAPTION_TEXT)
    // 同一引用＝什么也没加（末尾放不下最短字幕）——`addCaptionLayer` 宁可不加也不制造同轨重叠
    if (next === usable) { onNotice('字幕轨该处放不下（离片尾太近或被相邻字幕占满）'); return }
    ed.commit()
    ed.apply(next)
    // 新层一定是数组最后一条（addCaptionLayer 是 concat）——选中它并直接进编辑态，
    // 用户双击完就能打字，不用再去点一次那条只有几十像素宽的小条。
    const added = next.layers[next.layers.length - 1]
    onSelectLayer(added.id)
    setEditingCapId(added.id)
    onNotice(`已在 ${fmtTimecode(added.start)} 加字幕`)
  }

  /**
   * 就地改字提交。值没变就不 apply——点一下失焦不该占掉一格 undo。
   * **清空即删**：手动字幕清空文本＝删掉这一层（否则会留下一条看不见、也没有删除入口的空层）。
   * 五模板 TTS 的字幕层不走这条（它们与旁白一一对应，删了就对不上），空文本时丢弃编辑保留旧文本。
   */
  function commitCaptionText(layerId: string, text: string) {
    const cur = ed.spec
    if (!cur || isUnsupported(cur)) return
    const layer = cur.layers.find((l) => l.id === layerId)
    if (!layer || layer.content.kind !== 'caption' || layer.content.text === text) return
    if (text.trim() === '') {
      if (!isManualCaption(layerId)) return
      ed.commit()
      ed.apply(removeCaptionLayer(cur, layerId))
      onNotice('已删除字幕（⌘/Ctrl+Z 可撤销）')
      return
    }
    ed.commit()
    ed.apply(updateLayerText(cur, layerId, text))
  }

  const pct = (sec: number) => (duration > 0 ? `${(sec / duration) * 100}%` : '0%')

  return (
    <section
      className={`overflow-hidden rounded-[var(--fc-r-md)] border border-[var(--fc-line)] bg-[var(--fc-surface)] ${className ?? ''}`}
      style={{ height: containerH, boxSizing: 'border-box' }}
    >
      <div
        className="flex items-center gap-3 border-b border-[var(--fc-line)] px-3"
        style={{ height: HEAD_H, boxSizing: 'border-box' }}
      >
        <span className="font-mono text-[12px] tabular-nums text-[var(--fc-ink)]">{fmtTimecode(currentSec)}</span>
        <span className="font-mono text-[10px] text-[var(--fc-faint)]">/ {fmtTimecode(duration)}</span>
        <span className="ml-auto font-mono text-[10px] uppercase tracking-wide text-[var(--fc-muted)]">
          {!usable
            ? '时间轴'
            : isTalk
              ? `${shots.length} 镜 · 底片拖两端裁剪 · 字幕轨双击加字幕`
              : `${shots.length} 镜 · 拖分镜移动，拖右缘改时长`}
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
              style={{ height: trackH('ruler'), boxSizing: 'border-box' }}
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

            {/* 口播底片轨 26（talk 独有）：一条铺满全轨的底片，两端热区＝裁剪 */}
            {film && (
              <div
                className="relative border-b border-[var(--fc-track)]"
                style={{ height: trackH('film'), boxSizing: 'border-box' }}
              >
                <FilmClip
                  left={pct(film.start)}
                  width={pct(film.duration)}
                  trimStart={film.content.kind === 'video' ? film.content.trimStart ?? 0 : 0}
                  durationSec={film.duration}
                  selected={selectedLayerId === film.id}
                  dragging={dragId === film.id}
                  onPointerDown={(e, edge) => startFilmDrag(e, film.id, edge)}
                />
              </div>
            )}

            {/* 分镜轨 46：Clip 高 38，宽用 flex 比例（§5），空隙用同口径的占位撑开 */}
            <div
              className="flex items-center border-b border-[var(--fc-track)]"
              style={{ height: trackH('shots'), boxSizing: 'border-box', padding: '4px 0' }}
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

            {/* 字幕轨 30：细条。五模板下只显示+点选（跟随旁白，拖了就错位）；
                talk 下可拖 / 可改时长 / 空白双击加字幕 / 双击条目就地改字。<1040 隐藏（§4） */}
            {!compact && (
              <div
                className="relative border-b border-[var(--fc-track)]"
                style={{ height: trackH('caption'), boxSizing: 'border-box' }}
                onPointerDown={onCaptionTrackPointerDown}
                title={isTalk ? '双击空白处加一条字幕；拖动挪位，拖右缘改时长；双击字幕改字' : undefined}
              >
                {captions.map((l) => (
                  <div
                    key={l.id}
                    title={isTalk ? '拖动挪位，拖右缘改时长，双击改字' : '字幕跟随旁白，不可拖'}
                    onPointerDown={(e) => {
                      e.stopPropagation()
                      if (!isTalk) { onSelectLayer(l.id); seekToSec(l.start); return }
                      const now = e.timeStamp || Date.now()
                      const prev = lastCapTapRef.current
                      if (prev && prev.id === l.id && now - prev.t <= DBL_MS && Math.abs(e.clientX - prev.x) <= DBL_PX) {
                        lastCapTapRef.current = null
                        setEditingCapId(l.id)
                        return
                      }
                      lastCapTapRef.current = { id: l.id, t: now, x: e.clientX }
                      onSelectLayer(l.id)
                      seekToSec(l.start)
                      const box = (e.currentTarget as HTMLElement).getBoundingClientRect()
                      startCaptionDrag(e, l, box.right - e.clientX <= EDGE_PX ? 'cap-resize' : 'cap-move')
                    }}
                    className={`absolute overflow-hidden truncate rounded-[var(--fc-r-xs)] px-1 text-[9px] leading-[14px] ${
                      isTalk ? 'cursor-grab' : 'cursor-pointer'
                    } ${
                      selectedLayerId === l.id
                        ? 'bg-[var(--fc-accent-tint)] text-[var(--fc-accent-deep)]'
                        : 'bg-[var(--fc-sunken)] text-[var(--fc-muted)]'
                    }`}
                    style={{
                      left: pct(l.start), width: pct(l.duration), top: 8, height: 14,
                      boxSizing: 'border-box',
                      border: dragId === l.id
                        ? '1px dashed var(--fc-accent)'
                        : selectedLayerId === l.id ? '1px solid var(--fc-accent)' : '1px solid var(--fc-line)',
                    }}
                  >
                    {l.content.kind === 'caption' ? l.content.text : ''}
                    {isTalk && (
                      <span
                        className="absolute right-0 top-0 h-full cursor-ew-resize"
                        style={{ width: EDGE_PX, boxSizing: 'border-box' }}
                      />
                    )}
                  </div>
                ))}
                {captions.length === 0 && (
                  <span className="absolute left-2 top-2 text-[10px] text-[var(--fc-faint)]">
                    {isTalk ? '双击这里加一条字幕' : '这条视频没有字幕图层'}
                  </span>
                )}
                {/* 就地改字：浮在字幕条上方的小输入框。条本身常常只有几十像素宽，直接在条内
                    放 input 打不了字，所以固定 168 宽；靠近片尾时改成右对齐，免得溢出轨道右缘。 */}
                {isTalk && editingCapId && (() => {
                  const l = captions.find((c) => c.id === editingCapId)
                  if (!l) return null
                  const nearEnd = duration > 0 && l.start / duration > 0.6
                  return (
                    <input
                      // **不能用 autoFocus**：开编辑态的是 pointerdown，React 在同一个离散事件里
                      // 同步渲出这个 input 并聚焦，随后浏览器对那次 mousedown 的**默认行为**才把焦点
                      // 挪到被点的轨道 div 上——input 当场 blur，输入框一闪就没（实测就是这样）。
                      // 推到下一个宏任务再聚焦，让默认行为先走完；此前它没被聚焦过，也就不会误触 onBlur。
                      ref={(el) => {
                        if (!el || el.dataset.fcFocused) return
                        el.dataset.fcFocused = '1'
                        setTimeout(() => { el.focus(); el.select() }, 0)
                      }}
                      className="absolute z-10 rounded-[var(--fc-r-xs)] border border-[var(--fc-accent)] bg-[var(--fc-surface-2)] px-1 text-[11px] text-[var(--fc-ink)]"
                      style={{ ...(nearEnd ? { right: 0 } : { left: pct(l.start) }), top: 4, width: 168, height: 22, boxSizing: 'border-box' }}
                      defaultValue={l.content.kind === 'caption' ? l.content.text : ''}
                      onPointerDown={(e) => e.stopPropagation()}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur() }
                        if (e.key === 'Escape') { capCancelRef.current = true; e.currentTarget.blur() }
                      }}
                      onBlur={(e) => {
                        const cancelled = capCancelRef.current
                        capCancelRef.current = false
                        if (!cancelled) commitCaptionText(l.id, e.target.value)
                        setEditingCapId(null)
                      }}
                    />
                  )
                })()}
              </div>
            )}

            {/* BGM 轨 30：波形柱状图。无 bgm / 波形取不到都只是灰字，不挡任何编辑动作。<1040 隐藏 */}
            {!compact && (
              <div
                className="relative border-b border-[var(--fc-track)]"
                style={{ height: trackH('bgm'), boxSizing: 'border-box' }}
              >
                {!bgmSrc ? (
                  <span className="absolute left-2 top-2 text-[10px] text-[var(--fc-faint)]">无背景乐</span>
                ) : wave.status === 'loading' || wave.status === 'idle' ? (
                  // idle 只是「effect 还没跑」的那一帧（bgm 已存在），与 loading 同样显示占位
                  <div className="absolute inset-x-2 top-2">
                    <div className="h-3.5 animate-pulse rounded-[var(--fc-r-xs)] bg-[var(--fc-sunken)]" />
                  </div>
                ) : wave.status === 'error' ? (
                  <span className="absolute left-2 top-2 text-[10px] text-[var(--fc-faint)]">波形不可用</span>
                ) : (
                  <WaveformCanvas peaks={wave.peaks} height={trackH('bgm')} />
                )}
              </div>
            )}

            {/* 卡点轨 26：三态菱形 + 空白双击加点 */}
            <div
              className="relative border-b border-[var(--fc-track)]"
              style={{ height: trackH('beats'), boxSizing: 'border-box' }}
              onPointerDown={onBeatTrackPointerDown}
              title="双击空白处加一个手动卡点"
            >
              {!beatGrid && (
                <span className="absolute left-2 top-2 text-[10px] text-[var(--fc-faint)]">
                  无节拍数据——换曲或重新分析后可用
                </span>
              )}
              {beats.map((b) => (
                <BeatMarker
                  key={`${b.kind}-${b.t}`}
                  beat={b}
                  left={pct(b.t)}
                  trackH={trackH('beats')}
                  onActivate={() => {
                    if (b.kind === 'derived') cutShotAt(b.t)
                    else if (b.kind === 'manual') void removeBeatAt(b.t)
                    else seekToSec(b.t)
                  }}
                />
              ))}
            </div>

            {/* 播放头：accent 竖线贯穿全部轨道。pointer-events:none，否则它会挡住底下 Clip 的拖拽 */}
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

/**
 * §5 `Clip`：高 38；default / current（accent 描边 + tint 底）/ dragging（虚线 + 阴影 + 时间码）。
 *
 * **外层只负责 flex 比例，边框/内边距全在内层**。这不是洁癖：`flex-basis: 0` 在 border-box 下
 * 会被**下限抬到 padding+border**（盒子的内容宽不能是负的），于是每个 Clip 都比自己那份多出
 * 14px，而空隙占位没有边框、一点不多——「权重 : 时间」当场就不是 1:1 了，Clip 的边缘和刻度、
 * 播放头对不上（实测 4s 的片段画成了 4.86s 宽）。内层用绝对定位铺满，外层零 padding 零 border，
 * base size 才真是 0。
 */
function Clip({ shot, weight, current, dragging, onPointerDown }: {
  shot: ShotView
  weight: number
  current: boolean
  dragging: boolean
  onPointerDown: (e: ReactPointerEvent) => void
}) {
  return (
    <div style={{ flex: `${weight} 1 0`, height: CLIP_H, position: 'relative', minWidth: 0 }}>
      <div
        onPointerDown={onPointerDown}
        title={`${shot.text.slice(0, 40)}｜拖动移动，拖右缘改时长`}
        className="absolute inset-0 flex cursor-grab items-center overflow-hidden px-1.5 text-[10px]"
        style={{
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
    </div>
  )
}

/**
 * talk 口播底片条（26 的底片轨里那一条）。
 *
 * **两端各一条 8px 热区，中间不响应拖拽**：底片 start 恒 0、duration 恒等于 durationSec，
 * 把它「挪」到别处没有任何语义；两端拖的是片源的入点/出点（`trimVideoLayer`）。
 * 中间按下只做选中——右栏图层检查器会出 trim/音量三个数字字段，微调走那边。
 */
function FilmClip({ left, width, trimStart, durationSec, selected, dragging, onPointerDown }: {
  left: string
  width: string
  trimStart: number
  durationSec: number
  selected: boolean
  dragging: boolean
  onPointerDown: (e: ReactPointerEvent, edge: 'start' | 'end' | null) => void
}) {
  const summary = `已裁头 ${trimStart.toFixed(1)}s · 片长 ${durationSec.toFixed(1)}s`
  const handle: CSSProperties = {
    position: 'absolute', top: 0, height: '100%', width: EDGE_PX,
    cursor: 'ew-resize', background: 'var(--fc-accent)', opacity: dragging ? 1 : 0.55,
    boxSizing: 'border-box',
  }
  return (
    <div
      onPointerDown={(e) => {
        const box = (e.currentTarget as HTMLElement).getBoundingClientRect()
        const edge = e.clientX - box.left <= EDGE_PX ? 'start' : box.right - e.clientX <= EDGE_PX ? 'end' : null
        onPointerDown(e, edge)
      }}
      title={`口播底片｜${summary}｜拖左缘裁头、拖右缘裁尾（往外拖是吐回来）`}
      className="absolute flex items-center overflow-hidden px-2.5 text-[10px]"
      style={{
        left, width, top: 3, height: 20, boxSizing: 'border-box',
        borderRadius: 'var(--fc-r-sm)',
        border: dragging ? '1px dashed var(--fc-accent)' : selected ? '1px solid var(--fc-accent)' : '1px solid var(--fc-line-2)',
        background: dragging || selected ? 'var(--fc-accent-tint)' : 'var(--fc-sunken)',
        color: dragging || selected ? 'var(--fc-accent-deep)' : 'var(--fc-muted)',
      }}
    >
      <span className="min-w-0 flex-1 truncate">{summary}</span>
      <span style={{ ...handle, left: 0, borderRadius: 'var(--fc-r-sm) 0 0 var(--fc-r-sm)' }} />
      <span style={{ ...handle, right: 0, borderRadius: '0 var(--fc-r-sm) var(--fc-r-sm) 0' }} />
    </div>
  )
}

type WaveState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ok'; peaks: number[] }

/**
 * BGM 波形（`GET /specs/:videoId/waveform`，≤1000 个 0..1 的 peak）。
 *
 * **按 `videoId + bgm.src` 缓存在组件外的 Map 里**：换曲（src 变）才重取，来回切内容项、
 * 或 spec 每次编辑导致的重渲都不再打服务端——波形只跟音频文件有关，跟剪辑改动无关。
 * 失败（404 无 bgm / 503 ffmpeg 不可用）**不进缓存**：那多半是环境态（换机、装好 ffmpeg
 * 就好了），缓存下来会让「一次失败＝这条内容这辈子都没波形」。
 */
const waveCache = new Map<string, number[]>()

function useWaveform(slug: string, videoId: string | null, bgmSrc: string | null): WaveState {
  const [state, setState] = useState<WaveState>({ status: 'idle' })
  useEffect(() => {
    if (!slug || !videoId || !bgmSrc) { setState({ status: 'idle' }); return }
    const key = `${slug}|${videoId}|${bgmSrc}`
    const hit = waveCache.get(key)
    if (hit) { setState({ status: 'ok', peaks: hit }); return }
    let alive = true
    setState({ status: 'loading' })
    fetch(`/api/projects/${slug}/specs/${videoId}/waveform`)
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return (await r.json()) as { peaks: number[]; durationSec: number }
      })
      .then((body) => {
        const peaks = Array.isArray(body.peaks) ? body.peaks : []
        if (peaks.length === 0) throw new Error('空波形')
        waveCache.set(key, peaks)
        if (alive) setState({ status: 'ok', peaks })
      })
      .catch(() => { if (alive) setState({ status: 'error' }) })
    return () => { alive = false }
  }, [slug, videoId, bgmSrc])
  return state
}

/**
 * 波形柱状图。
 *
 * 画在 `<canvas>` 而不是几百个 div：一千根柱子的 DOM 会把整条时间轴的每次重渲都拖慢。
 * **宽度靠 ResizeObserver 重画**：canvas 的位图尺寸不会跟着 CSS 宽度走，只设 `style.width`
 * 会把图横向拉伸成一团；这里每次容器宽变就按 devicePixelRatio 重设位图并重画。
 */
function WaveformCanvas({ peaks, height }: { peaks: number[]; height: number }) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const wrap = wrapRef.current
    const canvas = canvasRef.current
    if (!wrap || !canvas) return
    function draw() {
      const w = Math.max(1, Math.floor(wrap!.clientWidth))
      const dpr = window.devicePixelRatio || 1
      canvas!.width = Math.floor(w * dpr)
      canvas!.height = Math.floor(height * dpr)
      const ctx = canvas!.getContext('2d')
      if (!ctx) return
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, w, height)
      // 线色取自 CSS 变量：主题换了波形也跟着换，不硬编码颜色
      ctx.fillStyle = getComputedStyle(canvas!).getPropertyValue('--fc-line-2').trim() || '#c9ccc2'
      const mid = height / 2
      const maxH = height - 4
      // 一根柱子 2px（1px 柱 + 1px 缝）：柱数由**像素宽**定，peaks 多于柱数时取区间最大值，
      // 少于柱数时按比例重复——两种方向都不能让波形被裁掉一截。
      const bars = Math.max(1, Math.floor(w / 2))
      for (let i = 0; i < bars; i++) {
        const from = Math.floor((i / bars) * peaks.length)
        const to = Math.max(from + 1, Math.floor(((i + 1) / bars) * peaks.length))
        let peak = 0
        for (let k = from; k < to && k < peaks.length; k++) peak = Math.max(peak, peaks[k] ?? 0)
        const h = Math.max(1, peak * maxH)
        ctx.fillRect(i * 2, mid - h / 2, 1, h)
      }
    }
    draw()
    const ro = new ResizeObserver(draw)
    ro.observe(wrap)
    return () => ro.disconnect()
  }, [peaks, height])

  return (
    <div ref={wrapRef} className="absolute inset-0">
      <canvas ref={canvasRef} style={{ width: '100%', height }} />
    </div>
  )
}

/**
 * §5 `BeatMarker`：11×11 菱形（8×8 方块转 45°，对角线正好 ≈11.3px），`left` 用百分比。
 *
 * 三态：`strong`＝已用（实心 accent，点＝定位播放头）/ `derived`＝检出未用（实心灰，
 * **点一下切分镜**）/ `manual`＝手动加的（描边墨色，点＝删除，重新分析不覆盖）。
 *
 * `pointerdown` 必须 `stopPropagation`：轨道区的 pointerdown 是「定位播放头 + 开始 scrub」，
 * 不拦的话点一颗菱形会顺手把播放头挪走；同时它也把卡点轨的双击判定挡在外面——
 * 连点两下一颗菱形不会在原地又补一个手动点。
 */
function BeatMarker({ beat, left, trackH, onActivate }: {
  beat: Beat
  left: string
  trackH: number
  onActivate: () => void
}) {
  const size = 8
  const style: CSSProperties = {
    position: 'absolute',
    left,
    top: (trackH - size) / 2,
    width: size,
    height: size,
    boxSizing: 'border-box',
    transform: 'translateX(-50%) rotate(45deg)',
    background: beat.kind === 'strong' ? 'var(--fc-accent)' : beat.kind === 'derived' ? 'var(--fc-line-2)' : 'transparent',
    border: beat.kind === 'manual' ? '1px solid var(--fc-ink)' : undefined,
    cursor: 'pointer',
  }
  const title = beat.kind === 'strong'
    ? `${fmtTimecode(beat.t)} 重音拍（已用）——点击定位播放头`
    : beat.kind === 'derived'
      ? `${fmtTimecode(beat.t)} 检出未用——点一下把最近的分镜入点移到这一拍`
      : `${fmtTimecode(beat.t)} 手动卡点——点击删除`
  return (
    <div
      style={style}
      title={title}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => { e.stopPropagation(); onActivate() }}
    />
  )
}
