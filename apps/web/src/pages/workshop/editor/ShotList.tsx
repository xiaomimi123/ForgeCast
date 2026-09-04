import { secToFrames } from '@forgecast/compositions/src/time'
import type { Layer, VideoSpec } from '@forgecast/compositions/src/videospec-types'
import { addManualBeat, deriveShots, updateLayerText, type ShotView } from '@forgecast/editing'
import type { PlayerRef } from '@remotion/player'
import { useEffect, useMemo, useState, type RefObject } from 'react'
import type { ConfirmOpts } from '../../../components/ui/Confirm'
import { isUnsupported } from '../../../lib/rebase'
import { OUTLINE } from './ui'
import type { useEditorState } from './useEditorState'

/**
 * 展示映射（实施说明 §6：列表里不许出现库内枚举）。role 是 semantic.sections[].role 的七个值，
 * 新增 role 时这张表要跟着加，否则回落成原枚举——回落而不是空白，是为了让漏加一眼可见。
 */
export const ROLE_LABEL: Record<string, string> = {
  hook: '钩子',
  pain: '痛点',
  body: '正文',
  demo: '演示',
  stat: '数据',
  cta: '行动',
  brand: '品牌',
}

/**
 * 时间码 mm:ss.s（Mono 显示）。
 *
 * **先取整到 0.1s 再拆分钟**：直接 `Math.floor(sec/60)` 后 `toFixed(1)` 的话，
 * 59.95～60 之间会被 toFixed 进位成 `01:60.0`。这里换算成「十分之一秒」的整数再拆，
 * 既躲掉那一格越界，也顺带躲掉浮点尾数。
 */
export function fmtTimecode(sec: number): string {
  const tenths = Math.round(Math.max(0, sec) * 10)
  const m = Math.floor(tenths / 600)
  const rest = (tenths - m * 600) / 10
  return `${String(m).padStart(2, '0')}:${rest.toFixed(1).padStart(4, '0')}`
}

/**
 * 该段可改字的目标图层。
 *
 * **不能直接用 `layerIds[0]`**：一个段常常同时挂了文本层和背景/图片层，`layerIds` 按 spec 中的
 * 顺序来，第一个未必是文本层；喂给 `updateLayerText` 会命中它的「非文本原样返回」分支，
 * 表现为「改了字但什么也没发生」这种最难查的静默失败。这里按 rewritable 的同一口径取唯一文本层。
 */
function textLayerId(spec: VideoSpec, shot: ShotView): string | null {
  const ids = spec.layers
    .filter((l) => l.from === shot.sectionId && l.content.kind === 'text')
    .map((l) => l.id)
  if (ids.length === 1) return ids[0]
  return null
}

interface RewriteResp { spec: VideoSpec; newText: string }

/**
 * 中栏分镜列表（实施说明 §5 ShotRow）。**「改字即改画面」的落点**：
 *
 * - 列表由 `deriveShots(spec)` 纯派生，不另存一份文案状态——spec 是唯一真相，
 *   撤销 / 重写 / 重置改的都是 spec，列表和 Player 一起跟着变。
 * - 改字**零请求**：失焦或 ⌘/Ctrl+Enter → `apply(updateLayerText(...))` → Player 当帧就是新字。
 *   落盘由 ⌘S / 渲染前的自动保存负责（①1.2 的裁决：编辑期不打服务端）。
 * - 「重写这段」相反，它走服务端且**会落盘**，所以调用前必须先把本地脏改动写下去，
 *   否则服务端读的是磁盘旧版本，返回的新 spec 一整包替换回来就把本地手改吃掉了。
 */
export default function ShotList({
  slug, videoId, ed, playerRef, currentSec, onNotice, onSelectLayer, onSpecReplaced, confirm,
}: {
  slug: string
  videoId: string | null
  ed: ReturnType<typeof useEditorState>
  playerRef: RefObject<PlayerRef>
  currentSec: number
  onNotice: (msg: string) => void
  /** 选中这一镜的文本图层 → 右栏图层检查器（选中来源之一，另一个是时间轴点选）。 */
  onSelectLayer: (layerId: string | null) => void
  /** spec 被整包换掉了（重写返回的是一整份新 spec）——右栏的参数草稿据此作废。 */
  onSpecReplaced: () => void
  /** in-app 确认弹层，与 EditorPage 共享同一个 useConfirm 实例（同时只有一个弹层）。 */
  confirm: (opts: ConfirmOpts) => Promise<boolean>
}) {
  const spec = ed.spec
  const usable = spec && !isUnsupported(spec) ? spec : null
  /** talk 的口播底片层。它单独占一行（「口播视频」），不混进分镜列表——那一段没有文案可改，
   *  混进去就是一行永远显示「（空）」、点了也改不动的死行。 */
  const film = useMemo(
    () => (usable?.template === 'talk' ? usable.layers.find((l) => l.content.kind === 'video') ?? null : null),
    [usable],
  )
  const shots = useMemo(() => {
    const all = usable ? deriveShots(usable) : []
    return film ? all.filter((s) => !s.layerIds.includes(film.id)) : all
  }, [usable, film])
  /** talk 的手动字幕（`addCaptionLayer` 插的，from 为 null 所以不进 deriveShots）。按时间排。 */
  const captions = useMemo(
    () => (usable?.template === 'talk'
      ? usable.layers.filter((l) => l.content.kind === 'caption').sort((a, b) => a.start - b.start)
      : []),
    [usable],
  )
  /** 全列唯一 active（§5）。存 sectionId 而非索引：重写 / 撤销后段序不变但内容会变，索引会指错行。 */
  const [activeId, setActiveId] = useState<string | null>(null)
  /**
   * 编辑中的草稿。`base` 记下开始编辑时的 shot.text：外部把文本改掉了（撤销、重写、重置）
   * 就对不上，此时**丢弃草稿显示新值**——否则 Ctrl+Z 之后输入框还挂着旧字，看着像没撤销成功。
   */
  const [draft, setDraft] = useState<{ id: string; base: string; value: string } | null>(null)
  const [rewriting, setRewriting] = useState<string | null>(null)

  // 换内容项时复位：上一条的 active 行 / 草稿不该带到下一条
  useEffect(() => { setActiveId(null); setDraft(null); setRewriting(null) }, [videoId])

  function selectShot(shot: ShotView) {
    if (activeId !== shot.sectionId) {
      commitDraft()
      setActiveId(shot.sectionId)
      setDraft(null)
    }
    // 右栏检查器跟着走：这一镜的唯一文本层没有时回落第一层，总比让检查器空着强
    if (spec) onSelectLayer(textLayerId(spec, shot) ?? shot.layerIds[0] ?? null)
    playerRef.current?.seekTo(secToFrames(shot.startSec))
  }

  /**
   * 一行「可改字的东西」→ 它当前的文本与要写回的图层。
   * 行 id 有两种来源：分镜行用 sectionId，talk 的手动字幕行用图层 id（`cap-manual-n`）——
   * 两种 id 的取值空间不重叠，同一份 draft 状态可以共用。
   */
  function editableAt(id: string): { text: string; layerId: string } | null {
    if (!spec) return null
    const shot = shots.find((s) => s.sectionId === id)
    if (shot) {
      const layerId = textLayerId(spec, shot)
      return layerId ? { text: shot.text, layerId } : null
    }
    const cap = captions.find((c) => c.id === id)
    if (cap && cap.content.kind === 'caption') return { text: cap.content.text, layerId: cap.id }
    return null
  }

  /** 提交草稿。**值没变就不 apply**——否则点一下失焦就占掉一格 undo 栈。 */
  function commitDraft() {
    if (!draft || !spec) return
    const target = editableAt(draft.id)
    if (!target || draft.value === target.text) { setDraft(null); return }
    ed.apply(updateLayerText(spec, target.layerId, draft.value))
    setDraft(null)
  }

  /**
   * 「加卡点」：在这一镜的入点加一个手动卡点（进 undo，⌘/Ctrl+Z 可回退）。
   * 手动点会进时间轴卡点轨（描边墨色）并参与拖拽吸附——所以「把下一镜对到这一刀」是可行的。
   * 幂等：同一位置（±0.01s）已有卡点时 `addManualBeat` 返回同一引用，这里只提示、不压 undo。
   */
  function addBeat(shot: ShotView) {
    if (!spec) return
    const next = addManualBeat(spec, shot.startSec)
    if (next === spec) { onNotice(`${fmtTimecode(shot.startSec)} 处已经有卡点了`); return }
    ed.apply(next)
    onNotice(`已在 ${fmtTimecode(shot.startSec)} 加卡点`)
  }

  async function doRewrite(shot: ShotView) {
    if (!slug || !videoId || !spec) return
    // **上锁必须在第一个 await 之前**：下面的 save 也是异步的，锁若等到 save 之后再上，
    // 保存在途那段时间按钮还是可点的，双击 = 两次 save + 两次不带 force 的 POST，
    // 响应乱序时后到的旧结果会盖掉新结果，还连压两格 undo。
    if (rewriting) { onNotice('重写进行中，请稍候'); return }
    setRewriting(shot.sectionId)
    try {
      // 三条服务端读改写路径（重写这段 / 用新参数重渲 / 用当前编辑结果渲成片）互斥：
      // ed.saving 只罩住 save() 的 PUT，这里紧跟着的 POST rewrite-section 不在它的窗口内，
      // 右栏「用新参数重渲」若在这数秒的在途窗口里发出第二条读改写，两者会静默互覆盖磁盘。
      const ran = await ed.runExclusive(async () => {
        // 重写走服务端、以磁盘上的 spec 为输入并把结果写回磁盘。本地有未落盘的改动时先保存，
        // 不然这一趟返回的新 spec 是「基于旧版本重写的」，apply 整包替换就把手改抹了。
        if (ed.dirty) {
          try {
            if (!(await ed.save())) { onNotice('重写已取消：当前内容没有可保存的素材包'); return true }
          } catch (e) {
            onNotice(`重写已取消（先保存失败）：${e instanceof Error ? e.message : String(e)}`)
            return true
          }
        }
        const url = `/api/projects/${slug}/specs/${videoId}/rewrite-section`
        const post = (force: boolean) => fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sectionId: shot.sectionId, ...(force ? { force: true } : {}) }),
        })
        let res = await post(false)
        if (res.status === 409) {
          const body = await res.json().catch(() => ({})) as { affected?: string[] }
          const list = (body.affected ?? []).join('、') || '（未知图层）'
          if (!(await confirm({ title: '该段含手工改动', body: `重写将覆盖：${list}。继续？`, danger: true }))) { onNotice('已取消重写'); return true }
          res = await post(true)
        }
        if (!res.ok) {
          const body = await res.json().catch(() => ({})) as { error?: string }
          onNotice(`重写失败：${body.error ?? `HTTP ${res.status}`}`)
          return true
        }
        const out = await res.json() as RewriteResp
        // 整包替换进 undo 栈——用户 ⌘Z 可以撤销这次重写（磁盘上仍是新版本，再保存一次即可回退）
        ed.apply(out.spec)
        // 服务端已经把这份写回磁盘了：不对齐净快照的话「未保存」会立刻假亮，
        // 用户会去按一次毫无意义的 ⌘S（而且那次 PUT 传的还是同样的内容）。
        ed.markSaved(out.spec)
        onSpecReplaced()
        setDraft(null)
        onNotice('已重写；旁白仍为旧配音，语音与画面文案可能不一致')
        return true
      })
      if (ran === undefined) onNotice('另一操作进行中，请稍候')
    } catch (e) {
      onNotice(`重写失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setRewriting(null)
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-[34px] shrink-0 items-center border-b border-[var(--fc-line)] px-3 font-mono text-[10px] uppercase tracking-wide text-[var(--fc-muted)]">
        分镜文案
        {spec && (
          <span className="ml-auto text-[var(--fc-faint)]">
            播放头 {currentSec.toFixed(1)}s · {shots.length} 镜
          </span>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {!spec && <p className="text-xs text-[var(--fc-faint)]">选中一条已出片的内容后，这里显示它的分镜文案。</p>}
        {spec && shots.length === 0 && !film && (
          <p className="text-xs text-[var(--fc-faint)]">这条素材包里没有可编辑的分镜（图层为空或是自定义模板）。</p>
        )}
        {/* talk：口播底片单独一行——点它把右栏图层检查器切到视频层（trim/音量在那里微调） */}
        {film && (
          <FilmRow
            layer={film}
            active={activeId === film.id}
            onSelect={() => {
              if (activeId !== film.id) { commitDraft(); setActiveId(film.id); setDraft(null) }
              onSelectLayer(film.id)
              playerRef.current?.seekTo(secToFrames(film.start))
            }}
          />
        )}
        <div className="flex flex-col gap-2">
          {shots.map((shot) => (
            <ShotRow
              key={shot.sectionId}
              shot={shot}
              active={activeId === shot.sectionId}
              busy={rewriting === shot.sectionId}
              locked={ed.busy}
              value={draft && draft.id === shot.sectionId && draft.base === shot.text ? draft.value : shot.text}
              onSelect={() => selectShot(shot)}
              onChange={(v) => setDraft({ id: shot.sectionId, base: shot.text, value: v })}
              onCommit={commitDraft}
              onRewrite={() => doRewrite(shot)}
              onAddBeat={() => addBeat(shot)}
            />
          ))}
        </div>

        {/* talk 手动字幕：与分镜行同一套编辑口径（草稿 → 失焦/⌘Enter → updateLayerText） */}
        {film && (
          <div className="mt-3">
            <div className="mb-1.5 font-mono text-[10px] uppercase tracking-wide text-[var(--fc-muted)]">
              手动字幕 {captions.length > 0 && <span className="text-[var(--fc-faint)]">· {captions.length} 条</span>}
            </div>
            {captions.length === 0 ? (
              <p className="text-xs text-[var(--fc-faint)]">还没有字幕——在时间轴字幕轨上双击空白处加一条。</p>
            ) : (
              <div className="flex flex-col gap-2">
                {captions.map((l) => (
                  <CaptionRow
                    key={l.id}
                    layer={l}
                    active={activeId === l.id}
                    value={
                      draft && draft.id === l.id && draft.base === (l.content.kind === 'caption' ? l.content.text : '')
                        ? draft.value
                        : (l.content.kind === 'caption' ? l.content.text : '')
                    }
                    onSelect={() => {
                      if (activeId !== l.id) { commitDraft(); setActiveId(l.id); setDraft(null) }
                      onSelectLayer(l.id)
                      playerRef.current?.seekTo(secToFrames(l.start))
                    }}
                    onChange={(v) => setDraft({
                      id: l.id,
                      base: l.content.kind === 'caption' ? l.content.text : '',
                      value: v,
                    })}
                    onCommit={commitDraft}
                  />
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * talk 的「口播视频」行。没有文案可改，显示的是**裁剪摘要**——用户在时间轴上拖完两端，
 * 到底裁掉了多少、还剩多长，这里有一处能读到确切数字（时间轴上的条只画得下一行小字）。
 */
function FilmRow({ layer, active, onSelect }: { layer: Layer; active: boolean; onSelect: () => void }) {
  const c = layer.content.kind === 'video' ? layer.content : null
  const trimStart = c?.trimStart ?? 0
  const src = (c?.src ?? '').split(/[/\\]/).pop() ?? ''
  return (
    <div
      onClick={onSelect}
      className={`mb-2 cursor-pointer rounded-[var(--fc-r-sm)] border border-[var(--fc-line)] ${
        active ? 'bg-[var(--fc-surface-2)]' : 'bg-[var(--fc-bg)] hover:border-[var(--fc-line-2)]'
      }`}
      style={{ padding: '9px 11px', borderLeft: active ? '3px solid var(--fc-accent)' : undefined }}
    >
      <div className="flex items-center gap-2 font-mono text-[10px] text-[var(--fc-faint)]">
        <span>{fmtTimecode(layer.start)}</span>
        <span className="rounded-[var(--fc-r-xs)] bg-[var(--fc-sunken)] px-1.5 py-0.5 text-[var(--fc-muted)]">口播视频</span>
        <span className="ml-auto">已裁头 {trimStart.toFixed(1)}s · 片长 {layer.duration.toFixed(1)}s</span>
      </div>
      <p className="mt-1 truncate text-sm text-[var(--fc-ink)]">{src || '（口播底片）'}</p>
      {active && (
        <p className="mt-1 text-[11px] leading-relaxed text-[var(--fc-faint)]">
          在时间轴底片轨拖两端裁剪；右栏图层检查器里可以数字微调裁头 / 裁尾 / 音量。
        </p>
      )}
    </div>
  )
}

/** talk 的手动字幕行：一行可改字的文本（与分镜行同款，只是没有重写/加卡点那组按钮）。 */
function CaptionRow({ layer, active, value, onSelect, onChange, onCommit }: {
  layer: Layer
  active: boolean
  value: string
  onSelect: () => void
  onChange: (v: string) => void
  onCommit: () => void
}) {
  return (
    <div
      onClick={onSelect}
      className={`cursor-pointer rounded-[var(--fc-r-sm)] border border-[var(--fc-line)] ${
        active ? 'bg-[var(--fc-surface-2)]' : 'bg-[var(--fc-bg)] hover:border-[var(--fc-line-2)]'
      }`}
      style={{ padding: active ? 11 : '9px 11px', borderLeft: active ? '3px solid var(--fc-accent)' : undefined }}
    >
      <div className="flex items-center gap-2 font-mono text-[10px] text-[var(--fc-faint)]">
        <span>{fmtTimecode(layer.start)}</span>
        <span className="rounded-[var(--fc-r-xs)] bg-[var(--fc-sunken)] px-1.5 py-0.5 text-[var(--fc-muted)]">字幕</span>
        <span className="ml-auto">{layer.duration.toFixed(1)}s</span>
      </div>
      {active ? (
        <textarea
          className="mt-2 w-full resize-y rounded-[var(--fc-r-sm)] border border-[var(--fc-line-2)] bg-[var(--fc-surface-2)] p-2 text-sm leading-relaxed text-[var(--fc-ink)]"
          rows={2}
          value={value}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => onChange(e.target.value)}
          onBlur={onCommit}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault()
              onCommit();
              (e.target as HTMLTextAreaElement).blur()
            }
          }}
        />
      ) : (
        <p className="mt-1 truncate text-sm leading-relaxed text-[var(--fc-ink)]">
          {value || <span className="text-[var(--fc-faint)]">（空）</span>}
        </p>
      )}
    </div>
  )
}

/** 单行分镜（§5：collapsed 底 --fc-bg / 1px 线 / padding 9,11；active 底白 / 左 3px accent / padding 11 + 操作条）。 */
function ShotRow({
  shot, active, busy, locked, value, onSelect, onChange, onCommit, onRewrite, onAddBeat,
}: {
  shot: ShotView
  active: boolean
  busy: boolean
  /** 另一条服务端读改写在途（跨行/跨面板，ed.busy）——不是「这一行在重写」，是「哪都别点」。 */
  locked: boolean
  value: string
  onSelect: () => void
  onChange: (v: string) => void
  onCommit: () => void
  onRewrite: () => void
  onAddBeat: () => void
}) {
  const rows = Math.min(8, Math.max(2, value.split('\n').length + Math.floor(value.length / 28)))
  return (
    <div
      onClick={onSelect}
      className={`cursor-pointer rounded-[var(--fc-r-sm)] border border-[var(--fc-line)] ${
        active ? 'bg-[var(--fc-surface-2)]' : 'bg-[var(--fc-bg)] hover:border-[var(--fc-line-2)]'
      }`}
      style={{
        padding: active ? 11 : '9px 11px',
        borderLeft: active ? '3px solid var(--fc-accent)' : undefined,
      }}
    >
      <div className="flex items-center gap-2 font-mono text-[10px] text-[var(--fc-faint)]">
        <span>{fmtTimecode(shot.startSec)}</span>
        <span className="rounded-[var(--fc-r-xs)] bg-[var(--fc-sunken)] px-1.5 py-0.5 text-[var(--fc-muted)]">
          {ROLE_LABEL[shot.role] ?? shot.role}
        </span>
        <span className="ml-auto">{(shot.endSec - shot.startSec).toFixed(1)}s</span>
      </div>

      {active && shot.rewritable ? (
        <textarea
          className="mt-2 w-full resize-y rounded-[var(--fc-r-sm)] border border-[var(--fc-line-2)] bg-[var(--fc-surface-2)] p-2 text-sm leading-relaxed text-[var(--fc-ink)]"
          rows={rows}
          value={value}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => onChange(e.target.value)}
          onBlur={onCommit}
          onKeyDown={(e) => {
            // ⌘/Ctrl+Enter 提交（不等失焦）；此外不拦任何键，输入框自己的撤销栈要留给用户
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault()
              onCommit();
              (e.target as HTMLTextAreaElement).blur()
            }
          }}
        />
      ) : (
        <p className={`mt-1 whitespace-pre-wrap text-sm leading-relaxed text-[var(--fc-ink)] ${active ? '' : 'line-clamp-2'}`}>
          {value || <span className="text-[var(--fc-faint)]">（空）</span>}
        </p>
      )}

      {active && !shot.rewritable && (
        <p className="mt-1 text-[11px] text-[var(--fc-faint)]">结构化内容，暂不支持直接编辑</p>
      )}

      {active && (
        <div className="mt-2 flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
          <button
            className={`${OUTLINE} !py-1 !text-xs`}
            disabled={!shot.rewritable || busy || locked}
            title={shot.rewritable ? '让 LLM 重写这段文案（会落盘）' : '结构化内容暂不支持重写'}
            onClick={onRewrite}
          >
            {busy ? '重写中…' : '重写这段'}
          </button>
          <button className={`${OUTLINE} !py-1 !text-xs`} disabled title="P2">换画面素材</button>
          <button
            className={`${OUTLINE} !py-1 !text-xs`}
            title="在这一镜的入点加一个手动卡点（会进撤销栈，也会参与拖拽吸附）"
            onClick={onAddBeat}
          >
            加卡点
          </button>
        </div>
      )}
    </div>
  )
}
