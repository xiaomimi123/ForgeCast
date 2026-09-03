import { secToFrames } from '@forgecast/compositions/src/time'
import type { VideoSpec } from '@forgecast/compositions/src/videospec-types'
import { deriveShots, updateLayerText, type ShotView } from '@forgecast/editing'
import type { PlayerRef } from '@remotion/player'
import { useEffect, useMemo, useState, type RefObject } from 'react'
import { isUnsupported } from '../../../lib/rebase'
import { OUTLINE } from './EditorPage'
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
  slug, videoId, ed, playerRef, currentSec, onNotice,
}: {
  slug: string
  videoId: string | null
  ed: ReturnType<typeof useEditorState>
  playerRef: RefObject<PlayerRef>
  currentSec: number
  onNotice: (msg: string) => void
}) {
  const spec = ed.spec
  const shots = useMemo(() => (spec && !isUnsupported(spec) ? deriveShots(spec) : []), [spec])
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
    playerRef.current?.seekTo(secToFrames(shot.startSec))
  }

  /** 提交草稿。**值没变就不 apply**——否则点一下失焦就占掉一格 undo 栈。 */
  function commitDraft() {
    if (!draft || !spec) return
    const shot = shots.find((s) => s.sectionId === draft.id)
    if (!shot || draft.value === shot.text) { setDraft(null); return }
    const layerId = textLayerId(spec, shot)
    if (!layerId) { setDraft(null); return }
    ed.apply(updateLayerText(spec, layerId, draft.value))
    setDraft(null)
  }

  async function doRewrite(shot: ShotView) {
    if (!slug || !videoId || !spec) return
    // **上锁必须在第一个 await 之前**：下面的 save 也是异步的，锁若等到 save 之后再上，
    // 保存在途那段时间按钮还是可点的，双击 = 两次 save + 两次不带 force 的 POST，
    // 响应乱序时后到的旧结果会盖掉新结果，还连压两格 undo。
    if (rewriting) return
    setRewriting(shot.sectionId)
    try {
      // 重写走服务端、以磁盘上的 spec 为输入并把结果写回磁盘。本地有未落盘的改动时先保存，
      // 不然这一趟返回的新 spec 是「基于旧版本重写的」，apply 整包替换就把手改抹了。
      if (ed.dirty) {
        try {
          if (!(await ed.save())) { onNotice('重写已取消：当前内容没有可保存的素材包'); return }
        } catch (e) {
          onNotice(`重写已取消（先保存失败）：${e instanceof Error ? e.message : String(e)}`)
          return
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
        if (!confirm(`该段含手工改动，重写将覆盖：${list}。继续？`)) { onNotice('已取消重写'); return }
        res = await post(true)
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string }
        onNotice(`重写失败：${body.error ?? `HTTP ${res.status}`}`)
        return
      }
      const out = await res.json() as RewriteResp
      // 整包替换进 undo 栈——用户 ⌘Z 可以撤销这次重写（磁盘上仍是新版本，再保存一次即可回退）
      ed.apply(out.spec)
      setDraft(null)
      onNotice('已重写；旁白仍为旧配音，语音与画面文案可能不一致')
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
        {spec && shots.length === 0 && (
          <p className="text-xs text-[var(--fc-faint)]">这条素材包里没有可编辑的分镜（图层为空或是自定义模板）。</p>
        )}
        <div className="flex flex-col gap-2">
          {shots.map((shot) => (
            <ShotRow
              key={shot.sectionId}
              shot={shot}
              active={activeId === shot.sectionId}
              busy={rewriting === shot.sectionId}
              value={draft && draft.id === shot.sectionId && draft.base === shot.text ? draft.value : shot.text}
              onSelect={() => selectShot(shot)}
              onChange={(v) => setDraft({ id: shot.sectionId, base: shot.text, value: v })}
              onCommit={commitDraft}
              onRewrite={() => doRewrite(shot)}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

/** 单行分镜（§5：collapsed 底 --fc-bg / 1px 线 / padding 9,11；active 底白 / 左 3px accent / padding 11 + 操作条）。 */
function ShotRow({
  shot, active, busy, value, onSelect, onChange, onCommit, onRewrite,
}: {
  shot: ShotView
  active: boolean
  busy: boolean
  value: string
  onSelect: () => void
  onChange: (v: string) => void
  onCommit: () => void
  onRewrite: () => void
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
            disabled={!shot.rewritable || busy}
            title={shot.rewritable ? '让 LLM 重写这段文案（会落盘）' : '结构化内容暂不支持重写'}
            onClick={onRewrite}
          >
            {busy ? '重写中…' : '重写这段'}
          </button>
          <button className={`${OUTLINE} !py-1 !text-xs`} disabled title="P2">换画面素材</button>
          <button className={`${OUTLINE} !py-1 !text-xs`} disabled title="P2">加卡点</button>
        </div>
      )}
    </div>
  )
}
