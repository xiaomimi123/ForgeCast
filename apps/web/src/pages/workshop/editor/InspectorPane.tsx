import type { Effect, Layer, LayerStyle, VideoSpec } from '@forgecast/compositions/src/videospec-types'
import { paramsDiff, setLayerStyle, setVideoVolume, toggleEffect, trimVideoLayer } from '@forgecast/editing'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { api, type Asset, type BgmList, type ContentItemView, type CustomTemplate } from '../../../api'
import TaskProgress from '../../../components/TaskProgress'
import type { TaskRun } from '../../../useTaskRun'
import { BGS, MOODS, OUTLINE, VIDEO_TPLS, type VideoParams } from './ui'
import type { useEditorState } from './useEditorState'

/**
 * 暂存草稿。键缺席＝没编辑过（paramsDiff 就是按这条口径跳过的）。
 *
 * §10 可改集三项全在这（P2）：
 * - `bgVariant` 是纯本地字段，直接并进 spec，走「用新参数重渲」PUT。
 * - `bgmSrc` / `mood` **不再本地写 spec**——任一项被改动，提交时先 `POST …/pick-bgm`
 *   让服务端选曲 + 重析节拍 + 落盘，返回的 spec 才是这两项的真相（见 `applyParams`）。
 *   `bgmSrc` 存的是**曲库相对名**（如 `tense/foo.wav`），不是绝对路径——绝对路径只有服务端拼得出
 *   （曲库根在服务端文件系统上，见 pick-bgm 的 `bgmInside` 校验）；`null` 表示显式选了「不加背景乐」。
 */
export interface ParamsDraft { bgVariant?: string; bgmSrc?: string | null; mood?: string }

/** 六种特效（Effect['type'] 的全集）与它们的人话名。新增类型时这里要跟着加。 */
const EFFECTS: Array<{ type: Effect['type']; label: string }> = [
  { type: 'decode', label: '解码' },
  { type: 'fadeIn', label: '淡入' },
  { type: 'slideUp', label: '上移' },
  { type: 'pulse', label: '脉冲' },
  { type: 'demote', label: '退居' },
  { type: 'exit', label: '退场' },
]

/** 背景变体下拉：五个变体 + 不加背景。**不含 `random`**——random 是生成期的「随机挑一个」，
 *  写进 spec 就成了 Background 认不出的变体名（回落 grid），在剪辑台里没有意义。 */
const BG_OPTIONS = BGS.filter((b) => b.value !== 'random')

/** 控件基线：§5 Field —— 标签 Mono 12 固定 38 宽，控件高 28。 */
const CTRL = 'h-[28px] w-full rounded-[var(--fc-r-sm)] border border-[var(--fc-line-2)] bg-[var(--fc-surface-2)] px-1.5 text-xs text-[var(--fc-ink)]'
const CTRL_RO = 'h-[28px] w-full rounded-[var(--fc-r-sm)] border border-[var(--fc-line)] bg-[var(--fc-sunken)] px-1.5 text-xs leading-[28px] text-[var(--fc-faint)]'
const GROUP = 'border-b border-[var(--fc-line)]'
const GROUP_PAD = { padding: '10px 14px' } as const

/**
 * §5 `Field`：标签 Mono 12 / 固定 38 宽 / 控件高 28；**改动过的值在标签前加 4×4 accent 圆点**。
 * 圆点画在 38 的宽度**之内**（不是外挂），否则改动项的控件会比未改动项窄 8px，一列参数看着是歪的。
 */
function Field({ label, changed, hint, children }: {
  label: string; changed?: boolean; hint?: string; children: ReactNode
}) {
  return (
    <div className="flex items-center gap-2" title={hint}>
      <span
        className="flex shrink-0 items-center gap-1 font-mono text-[12px] text-[var(--fc-muted)]"
        style={{ width: 38, boxSizing: 'border-box' }}
      >
        <span
          className="inline-block shrink-0 rounded-full"
          style={{ width: 4, height: 4, background: changed ? 'var(--fc-accent)' : 'transparent' }}
        />
        <span className="truncate">{label}</span>
      </span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}

/**
 * 曲库相对名（如 `tense/foo.wav`）在下拉/角标里的展示名——去掉情绪子目录段，只留文件名。
 * 不再依赖 `/api/bgm` 的 `dir`（已 deprecated，见 app.ts）：相对名本身就是自解释的。
 */
function bgmLabel(rel: string): string {
  return rel.split(/[/\\]/).pop() ?? rel
}

/**
 * 把 spec 上的 `audio.bgm.src`（绝对路径）反解成曲库相对名，用来在下拉里选中「当前这首」。
 * 做法是拿曲库清单（root + byMood 的每个相对名）逐个跟 `src` 做后缀匹配——不依赖 `dir`：
 * 绝对路径不管服务端曲库根挂在哪，末尾一段一定是 `<mood>/<file>` 或 `<file>`，后缀能稳定命中。
 * 一个都不命中（曲库被挪过 / 曲子被删）→ null，调用方据此把 src 整个当「不在曲库」的当前值处理。
 */
function relOfBgmSrc(src: string | null | undefined, list: BgmList | undefined): string | null {
  if (!src) return null
  const candidates = [
    ...(list?.root ?? []),
    ...Object.entries(list?.byMood ?? {}).flatMap(([m, files]) => files.map((f) => `${m}/${f}`)),
  ]
  return candidates.find((rel) => src === rel || src.endsWith(`/${rel}`) || src.endsWith(`\\${rel}`)) ?? null
}

/**
 * 把暂存草稿并进 spec。**只并 `bgVariant` 一项**——它是纯本地字段（Background 组件按它挑背景），
 * 没有任何服务端状态要同步，PUT 落盘就是全部真相。
 *
 * `bgmSrc` / `mood` **不在这里处理**：P1 时它们曾直接写 `spec.audio.bgm`（前端拼绝对路径），
 * P2 起换成服务端 `POST …/pick-bgm` 选曲 + 重析节拍一体完成——那次请求返回的 spec 才是真相，
 * 调用方（`applyParams`）拿到它直接 `ed.apply` + `ed.markSaved`，不经过这个函数。
 * `bgVariant: 'none'` 是合法值（`Background` 见到 'none' 就不渲染），不是「删掉字段」，
 * 所以直接写进去；与「字段本就不存在」在渲染结果上等价，但在 diff 上诚实地算一次改动。
 */
export function mergeParamsDraft(spec: VideoSpec, draft: ParamsDraft): VideoSpec {
  if (draft.bgVariant !== undefined && draft.bgVariant !== spec.bgVariant) {
    return { ...spec, bgVariant: draft.bgVariant }
  }
  return spec
}

/**
 * 右栏 Inspector（实施说明 §4/§5/§7 规则 3）。两个分区，**两套截然不同的提交语义**：
 *
 * 1. **图层检查器** —— 改的是画面本身（位置 / 字号 / 颜色 / 特效），`apply` 即时生效，
 *    Player 当帧就变。这不是「渲染参数」，不受 §7 规则 3 的暂存约束：所见即所得才谈得上调版。
 * 2. **渲染参数** —— §10 可改集三项（背景变体 / BGM / 情绪）走**本地草稿**，改多少项都**零请求**，
 *    直到按「用新参数重渲」才 PUT + POST 各一次。只读三项（模板 / 比例 / 字幕）灰显，
 *    它们要重新生成（走全管线、重新 lower）才可能变，在剪辑台里改了也没有落点。
 *
 * 没有 spec（「待出片」的内容）时这里退回**出片参数**面板：那时还没有素材包可编辑，
 * 用户需要的是「用什么模板/BGM 渲第一版」，而不是一个空的检查器。
 */
export default function InspectorPane({
  ed, current, bgmList, selectedLayerId, vp, setVp, busy, videoRun, onMakeVideo, onNotice, onEnqueueRender, onRenderFromSpec,
  specEpoch, slug, videoId, onSpecReplaced, className, uploadAssets,
}: {
  ed: ReturnType<typeof useEditorState>
  current: ContentItemView | null
  bgmList: BgmList | undefined
  selectedLayerId: string | null
  vp: VideoParams
  setVp: (v: VideoParams) => void
  busy: boolean
  videoRun: TaskRun
  onMakeVideo: (assetId: number) => void
  /** talk 模板的口播素材候选（本项目 `type==='video' && origin==='upload'` 的 assets） */
  uploadAssets: Asset[]
  onNotice: (msg: string) => void
  /** 入队渲成片（spec 须已落盘）。返回是否入队成功。 */
  onEnqueueRender: () => Promise<boolean>
  /** ⋯ 里那个「用当前编辑结果渲成片」的正主：带确认与防御式保存。 */
  onRenderFromSpec: () => void
  /** spec 被**整包换掉**的次数（重置 / 重写）。草稿是「相对当前 spec 的改动」，换了就得清。 */
  specEpoch: number
  /** 拼 `POST …/pick-bgm` 的路径用——同 ShotList/TimelinePane 已在用的这一对。 */
  slug: string
  videoId: string | null
  /** spec 被服务端整包换掉后回调（bump specEpoch），同 ShotList 的 doRewrite 成功分支。 */
  onSpecReplaced: () => void
  className?: string
}) {
  const spec = ed.spec
  const [draft, setDraft] = useState<ParamsDraft>({})
  const [applying, setApplying] = useState(false)
  /**
   * 换内容项、以及 spec 被整包换掉（重置为生成结果 / 重写这段）后清空草稿。
   *
   * **只依赖 `current?.id` 是不够的**：重置不换内容项，草稿会连同 accent 圆点一起留在界面上，
   * 用户点「用新参数重渲」就把刚刚重置掉的那支 BGM 又贴了回去——他明明选的是「回到生成结果」。
   * 所以调用方在这两条路径上递增 `specEpoch`，这里跟着它一起清。
   */
  useEffect(() => { setDraft({}) }, [current?.id, specEpoch])

  // saved 侧的 bgmSrc 归一到曲库相对名再传给 paramsDiff：spec.audio.bgm.src 落盘是绝对路径，
  // draft.bgmSrc 是下拉 option 的相对名，直接比较会把「选中当前正在用的那首」也判成改动。
  const diff = useMemo(
    () => (spec ? paramsDiff(spec, draft, relOfBgmSrc(spec.audio.bgm?.src, bgmList) ?? spec.audio.bgm?.src ?? null) : []),
    [spec, draft, bgmList],
  )
  const changed = (key: string) => diff.some((d) => d.key === key)
  /**
   * BGM 下拉当前应选中的值：草稿有值就用草稿（`null` 是「显式选了不加背景乐」，
   * 下拉里对应空字符串那个 option）；否则把 spec 里的绝对路径反解成曲库相对名，
   * 反解不出来（曲库被挪过 / 曲子被删）就原样把绝对路径当值——`BgmOptions` 会给它单列一条。
   */
  const bgmCurrent = draft.bgmSrc !== undefined
    ? draft.bgmSrc
    : (relOfBgmSrc(spec?.audio.bgm?.src, bgmList) ?? spec?.audio.bgm?.src ?? null)

  async function applyParams() {
    if (!spec || diff.length === 0 || applying || !slug || !videoId) return
    setApplying(true)
    try {
      // 与「重写这段」/「渲成片」互斥：这里也是一到两次服务端读改写（PUT 落盘
      // [+ POST pick-bgm 选曲重析再落盘] + POST 入队重渲读盘），在途时若中栏「重写这段」
      // 并发发出另一条读改写，两者会静默互覆盖磁盘。
      const ran = await ed.runExclusive(async () => {
        const withBgVariant = mergeParamsDraft(spec, draft)
        const bgmTouched = changed('bgmSrc') || changed('mood')
        if (bgmTouched) {
          // pick-bgm 是「服务端读盘 → 选曲 → 重析节拍 → 写回」，输入必须是磁盘上的最新版本：
          // 先把本地的 bgVariant 改动落盘，不然这一趟拿旧盘面重写，会把 bgVariant 悄悄冲掉。
          // **save 必须收到显式的 withBgVariant**：apply 的 setState 还没刷新，save 内部从
          // ref 取 present 会拿到改动前那一份。
          ed.apply(withBgVariant)
          if (!(await ed.save(withBgVariant))) { onNotice('重渲已取消：当前内容没有可保存的素材包'); return true }
          // bgmSrc 未提及＝用户没碰这项，交给服务端按 mood 重选（chooseBgmPath 的选曲优先级：
          // bgm 具体名 > mood 情绪目录随机 > 根目录随机，见 studio/hyperframes.ts）；
          // null＝显式选了「不加背景乐」（'none'）；字符串＝曲库相对名，指定这首。
          const bgm = draft.bgmSrc === undefined ? '' : draft.bgmSrc === null ? 'none' : draft.bgmSrc
          const mood = draft.mood ?? spec.audio.bgm?.mood ?? ''
          const res = await fetch(`/api/projects/${slug}/specs/${videoId}/pick-bgm`, {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ bgm, mood }),
          })
          if (!res.ok) {
            const body = await res.json().catch(() => ({})) as { error?: string }
            onNotice(`换曲失败：${body.error ?? `HTTP ${res.status}`}`)
            return true
          }
          const out = await res.json() as VideoSpec
          // 服务端已经把这份写回磁盘：apply 整包替换进 undo 栈（⌘Z 可回退），markSaved 对齐
          // 净快照——不对齐的话「未保存」会立刻假亮，用户会去按一次毫无意义的 ⌘S（照抄
          // ShotList doRewrite 成功分支的先例）。卡点轨/波形轨据此自然刷新，手动卡点由
          // pick-bgm 自己保留（见 spec-routes.ts pick-bgm 注释），不用剪辑台再管一次。
          ed.apply(out)
          ed.markSaved(out)
          onSpecReplaced()
        } else {
          // 只改了 bgVariant：本地并入 + PUT 落盘，不用麻烦 pick-bgm。
          ed.apply(withBgVariant)
          if (!(await ed.save(withBgVariant))) { onNotice('重渲已取消：当前内容没有可保存的素材包'); return true }
        }
        setDraft({})
        if (await onEnqueueRender()) onNotice('已按新参数入队重渲，进度看队列卡片')
        return true
      })
      if (ran === undefined) onNotice('另一操作进行中，请稍候')
    } catch (e) {
      onNotice(`重渲失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setApplying(false)
    }
  }

  return (
    <aside
      className={`flex min-h-0 flex-col overflow-hidden rounded-[var(--fc-r-md)] border border-[var(--fc-line)] bg-[var(--fc-surface)] ${className ?? ''}`}
      style={{ boxSizing: 'border-box' }}
    >
      <div className="flex h-[34px] shrink-0 items-center border-b border-[var(--fc-line)] px-3 font-mono text-[10px] uppercase tracking-wide text-[var(--fc-muted)]">
        检查器
        {diff.length > 0 && (
          <span className="ml-auto flex items-center gap-1 text-[var(--fc-accent-deep)]">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--fc-accent)]" />
            改动 {diff.length} 项
          </span>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {!spec ? (
          <div className="space-y-3 p-3">
            <div className="rounded-[var(--fc-r-sm)] bg-[var(--fc-sunken)] px-2 py-1.5 text-xs text-[var(--fc-muted)]">
              {current ? '这条还没出片——下面是渲第一版用的参数' : '未选中内容——点左侧队列里的一条'}
            </div>
            <VideoParamFields vp={vp} setVp={setVp} bgmList={bgmList} uploadAssets={uploadAssets} />
            <button className={`w-full ${OUTLINE}`}
              disabled={!current || busy || (vp.tpl === 'talk' && !vp.uploadAssetId)}
              title={vp.tpl === 'talk' && !vp.uploadAssetId ? '先选口播素材' : undefined}
              onClick={() => current && onMakeVideo(current.copyAssetId)}>
              {videoRun.running ? '渲染中…' : '按上面的参数出片'}
            </button>
            <TaskProgress run={videoRun} />
          </div>
        ) : (
          <>
            <LayerInspector ed={ed} spec={spec} layerId={selectedLayerId} />

            <div className={GROUP} style={GROUP_PAD}>
              <div className="mb-2 font-mono text-[10px] uppercase tracking-wide text-[var(--fc-muted)]">渲染参数</div>
              <div className="space-y-2">
                <Field label="背景" changed={changed('bgVariant')}>
                  <select className={CTRL} value={draft.bgVariant ?? spec.bgVariant ?? 'none'}
                    onChange={(e) => setDraft({ ...draft, bgVariant: e.target.value })}>
                    {BG_OPTIONS.map((b) => <option key={b.value} value={b.value}>{b.label}</option>)}
                  </select>
                </Field>
                <Field label="BGM" changed={changed('bgmSrc')}>
                  <select className={CTRL} value={bgmCurrent ?? ''}
                    onChange={(e) => setDraft({ ...draft, bgmSrc: e.target.value || null })}>
                    <option value="">不加背景乐</option>
                    <BgmOptions list={bgmList} current={bgmCurrent} />
                  </select>
                </Field>
                <Field label="情绪" changed={changed('mood')} hint="换情绪将重选曲并重析节拍">
                  <select className={CTRL} value={draft.mood ?? spec.audio.bgm?.mood ?? ''}
                    onChange={(e) => setDraft({ ...draft, mood: e.target.value })}>
                    <option value="">自动（按钩子情绪）</option>
                    {Object.keys(bgmList?.byMood ?? {}).map((m) => (
                      <option key={m} value={m}>{MOODS.find((x) => x.value === m)?.label ?? m}</option>
                    ))}
                  </select>
                </Field>
                <Field label="模板" hint="重新生成才可改"><div className={CTRL_RO}>{spec.template}</div></Field>
                <Field label="比例" hint="重新生成才可改">
                  <div className={CTRL_RO}>{spec.canvas.width >= spec.canvas.height ? '横屏 16:9' : '竖屏 9:16'}</div>
                </Field>
                <Field label="字幕" hint="重新生成才可改">
                  <div className={CTRL_RO}>{spec.audio.captionsEnabled ? '已烧录' : '未烧录'}</div>
                </Field>
                <p className="text-[11px] leading-relaxed text-[var(--fc-faint)]">
                  灰显三项在剪辑台里改不了：模板 / 比例 / 字幕决定画面怎么搭出来，要整条重跑；换 BGM / 情绪会连带重选曲、重析节拍并保留手动卡点。
                </p>

                <button
                  className={`w-full ${OUTLINE} !h-[34px] !py-0`}
                  disabled={diff.length === 0 || applying || ed.saving || ed.busy}
                  title={diff.length === 0 ? '先改点参数' : '保存改动并按新参数入队重渲'}
                  onClick={applyParams}
                >
                  {applying ? '提交中…' : `用新参数重渲${diff.length ? `（${diff.length} 项）` : ''}`}
                </button>
              </div>
            </div>
          </>
        )}
      </div>

      {spec && (
        <div className="shrink-0 border-t border-[var(--fc-line)] p-3">
          <button className={`w-full ${OUTLINE}`} onClick={onRenderFromSpec} disabled={ed.saving || ed.busy}>
            用当前编辑结果渲成片
          </button>
          <p className="mt-1 text-[11px] leading-relaxed text-[var(--fc-faint)]">
            旁白与字幕沿用上一版配音，改过的文字不会改配音。
          </p>
        </div>
      )}
    </aside>
  )
}

/** BGM 下拉的选项。当前曲子不在曲库里（曲库被挪过 / 曲子被删）时，把它单列一条，否则下拉会
 *  静默跳到「不加背景乐」——用户会以为这条视频本来就没有 BGM。 */
/**
 * 选项值全是**曲库相对名**（`pick-bgm` 的 `body.bgm` 期望的形状，见 spec-routes.ts
 * `chooseBgmPath`/`pickBgm`：拿 `bgmDir + name` 去 `existsSync`，name 就是这个相对名）——
 * 不再拼绝对路径，`/api/bgm` 的 `dir` 字段这里已用不上。
 */
function BgmOptions({ list, current }: { list: BgmList | undefined; current: string | null }) {
  const known = new Set([
    ...(list?.root ?? []),
    ...Object.entries(list?.byMood ?? {}).flatMap(([m, files]) => files.map((f) => `${m}/${f}`)),
  ])
  return (
    <>
      {current && !known.has(current) && (
        <option value={current}>{bgmLabel(current)}（当前 · 不在曲库）</option>
      )}
      {(list?.root ?? []).map((f) => <option key={f} value={f}>{f}</option>)}
      {Object.entries(list?.byMood ?? {}).map(([m, files]) => (
        <optgroup key={m} label={m}>
          {files.map((f) => <option key={`${m}/${f}`} value={`${m}/${f}`}>{f}</option>)}
        </optgroup>
      ))}
    </>
  )
}

/**
 * 图层检查器。**即时生效**：每次改动直接落到 spec，Player 当帧重画。
 *
 * 连续型控件（数字 / 颜色 / 滑块）走 `applyTransient` + 失焦 `commit`：拖一次滑块会触发几十次
 * onChange，每次都 push 的话 undo 栈瞬间被填满，用户按十次 ⌘Z 才退回一格改动。
 * 离散型（对齐 chip / 特效开关）一次点击就是一步，直接 `apply`。
 */
function LayerInspector({ ed, spec, layerId }: {
  ed: ReturnType<typeof useEditorState>; spec: VideoSpec; layerId: string | null
}) {
  const layer = layerId ? spec.layers.find((l) => l.id === layerId) ?? null : null
  if (!layer) {
    return (
      <div className={GROUP} style={GROUP_PAD}>
        <div className="mb-2 font-mono text-[10px] uppercase tracking-wide text-[var(--fc-muted)]">图层检查器</div>
        <p className="text-[11px] leading-relaxed text-[var(--fc-faint)]">点选分镜或时间轴上的图层，这里出现它的位置 / 字号 / 颜色 / 特效。</p>
      </div>
    )
  }
  const st = layer.style
  const isVideo = layer.content.kind === 'video'
  const patchLive = (patch: Partial<LayerStyle>) => ed.applyTransient(setLayerStyle(spec, layer.id, patch))
  const patchStep = (patch: Partial<LayerStyle>) => ed.apply(setLayerStyle(spec, layer.id, patch))
  /** 数字输入：空串＝不设这一项（回落模板默认），不是 0。 */
  const num = (v: string): number | undefined => (v === '' ? undefined : Number(v))

  const numField = (label: string, key: 'x' | 'y' | 'width' | 'height' | 'fontSize') => (
    <Field label={label}>
      <input
        className={CTRL} type="number" value={st[key] ?? ''} placeholder="默认"
        onChange={(e) => patchLive({ [key]: num(e.target.value) })}
        onBlur={() => ed.commit()}
      />
    </Field>
  )

  return (
    <div className={GROUP} style={GROUP_PAD}>
      <div className="mb-2 flex items-center font-mono text-[10px] uppercase tracking-wide text-[var(--fc-muted)]">
        图层检查器
        <span className="ml-auto max-w-[140px] truncate normal-case text-[var(--fc-faint)]" title={layer.id}>{layer.id}</span>
      </div>
      <div className="space-y-2">
        {/* 视频层（talk 口播底片）没有字号/颜色/对齐这套东西——那组控件对它一项都不生效，
            与其灰显一整列不可用的字段，不如换成它真正能调的三项：裁头 / 裁尾 / 音量。 */}
        {isVideo ? <VideoLayerFields ed={ed} spec={spec} layer={layer} /> : (
      <>
        {numField('X', 'x')}
        {numField('Y', 'y')}
        {numField('宽', 'width')}
        {numField('高', 'height')}
        {numField('字号', 'fontSize')}
        <Field label="颜色">
          <div className="flex items-center gap-2">
            <input className="h-[28px] w-[44px] shrink-0 rounded-[var(--fc-r-sm)] border border-[var(--fc-line-2)] bg-[var(--fc-surface-2)]"
              type="color" value={st.color ?? '#181A16'}
              onChange={(e) => patchLive({ color: e.target.value })} onBlur={() => ed.commit()} />
            <button className={`${OUTLINE} !px-2 !py-0.5 !text-[11px]`} onClick={() => patchStep({ color: undefined })}>清除</button>
          </div>
        </Field>
        <Field label="底色">
          <div className="flex items-center gap-2">
            <input className="h-[28px] w-[44px] shrink-0 rounded-[var(--fc-r-sm)] border border-[var(--fc-line-2)] bg-[var(--fc-surface-2)]"
              type="color" value={st.bg ?? '#FFFFFF'}
              onChange={(e) => patchLive({ bg: e.target.value })} onBlur={() => ed.commit()} />
            <button className={`${OUTLINE} !px-2 !py-0.5 !text-[11px]`} onClick={() => patchStep({ bg: undefined })}>清除</button>
          </div>
        </Field>
        <Field label="对齐">
          <div className="flex items-center gap-1">
            {(['left', 'center', 'right'] as const).map((a) => (
              <button key={a}
                className={`h-[28px] flex-1 rounded-[var(--fc-r-xs)] border text-[11px] ${
                  st.align === a
                    ? 'border-[var(--fc-accent)] bg-[var(--fc-accent-tint)] text-[var(--fc-accent-deep)]'
                    : 'border-[var(--fc-line)] text-[var(--fc-muted)] hover:border-[var(--fc-line-2)]'
                }`}
                onClick={() => patchStep({ align: st.align === a ? undefined : a })}
              >{a === 'left' ? '左' : a === 'center' ? '中' : '右'}</button>
            ))}
          </div>
        </Field>
        <Field label="透明">
          <div className="flex items-center gap-2">
            <input className="h-[28px] min-w-0 flex-1" type="range" min={0} max={1} step={0.05}
              value={st.opacity ?? 1}
              onChange={(e) => patchLive({ opacity: Number(e.target.value) })}
              // 滑块拖完不一定失焦（键盘也能改），用 pointerup + blur 双保险收尾；
              // commit 对「没变过」是空操作，多调一次不会多压一格。
              onPointerUp={() => ed.commit()} onBlur={() => ed.commit()} />
            <span className="w-8 shrink-0 text-right font-mono text-[10px] text-[var(--fc-faint)]">
              {(st.opacity ?? 1).toFixed(2)}
            </span>
          </div>
        </Field>
      </>
        )}

        <div className="pt-1 font-mono text-[10px] uppercase tracking-wide text-[var(--fc-muted)]">特效</div>
        <div className="grid grid-cols-3 gap-x-2 gap-y-1">
          {EFFECTS.map((fx) => {
            const on = layer.effects.some((e) => e.type === fx.type)
            return (
              <label key={fx.type} className="flex items-center gap-1 text-[11px] text-[var(--fc-muted)]">
                <input type="checkbox" checked={on}
                  onChange={(e) => ed.apply(toggleEffect(spec, layer.id, fx.type, e.target.checked))} />
                {fx.label}
              </label>
            )
          })}
        </div>
      </div>
    </div>
  )
}

/**
 * 视频层（talk 口播底片）的三个数字字段：裁头 / 裁尾 / 音量。
 *
 * **裁头/裁尾走本地草稿、失焦或 Enter 才提交**，不像其它数字字段那样每次 onChange 就
 * applyTransient：`trimVideoLayer` 会钳制（裁不过 0.2s 底线、吐不过片源两端），边打字边钳
 * 会把输入框里的半截数字改掉——打 `1.5` 在敲到 `1.` 那一刻就被回写成 `1`，小数点再也打不进去。
 * 提交时按「目标值 − 当前值」算 δ（该函数的入参是增量，δ>0 恒为「多裁掉」）。
 *
 * 音量是有界的离散步进，没有这个问题：直接 applyTransient + 失焦 commit，
 * 连按几下方向键收成一格 undo。
 */
function VideoLayerFields({ ed, spec, layer }: {
  ed: ReturnType<typeof useEditorState>; spec: VideoSpec; layer: Layer
}) {
  const content = layer.content.kind === 'video' ? layer.content : null
  const [draft, setDraft] = useState<{ key: 'start' | 'end'; value: string } | null>(null)
  // 换层 / 换内容项后草稿作废：否则上一层的半截数字会跟着显示在下一层的输入框里
  useEffect(() => { setDraft(null) }, [layer.id])
  if (!content) return null

  const trimStart = content.trimStart ?? 0
  const sourceDur = content.sourceDurationSec
  /** 已裁掉的尾部长度。片源总长未知（老 spec）时为 null——那时不知道尾巴还剩多少，不假装知道。 */
  const trimTail = sourceDur === undefined ? null : Math.max(0, Math.round((sourceDur - (trimStart + layer.duration)) * 1000) / 1000)

  const commitTrim = (edge: 'start' | 'end', raw: string) => {
    setDraft(null)
    const target = Number(raw)
    if (raw.trim() === '' || !Number.isFinite(target)) return
    const cur = edge === 'start' ? trimStart : trimTail
    if (cur === null) return
    const next = trimVideoLayer(spec, layer.id, edge, target - cur)
    if (next !== spec) ed.apply(next)
  }

  const trimField = (label: string, edge: 'start' | 'end', cur: number | null, hint: string) => (
    <Field label={label} hint={hint}>
      <input
        className={CTRL} type="number" step={0.1} min={0}
        value={draft?.key === edge ? draft.value : (cur ?? 0).toFixed(1)}
        disabled={cur === null}
        onChange={(e) => setDraft({ key: edge, value: e.target.value })}
        onBlur={(e) => commitTrim(edge, e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
      />
    </Field>
  )

  return (
    <>
      {trimField('裁头', 'start', trimStart, '从片源开头裁掉多少秒（减小＝把裁掉的头吐回来）')}
      {trimField('裁尾', 'end', trimTail,
        trimTail === null ? '这份 spec 没有片源总长，裁尾只能在时间轴上拖' : '从片源结尾裁掉多少秒（减小＝把裁掉的尾吐回来）')}
      <Field label="片长" hint="裁剪后的成片时长，跟着裁头/裁尾走">
        <div className={CTRL_RO}>{layer.duration.toFixed(1)}s{sourceDur !== undefined && ` / 片源 ${sourceDur.toFixed(1)}s`}</div>
      </Field>
      <Field label="音量" hint="口播原声音量 0~1">
        <div className="flex items-center gap-2">
          <input
            className={CTRL} type="number" step={0.1} min={0} max={1}
            value={content.volume ?? 1}
            onChange={(e) => {
              const v = Number(e.target.value)
              if (Number.isFinite(v)) ed.applyTransient(setVideoVolume(spec, layer.id, v))
            }}
            onBlur={() => ed.commit()}
          />
        </div>
      </Field>
    </>
  )
}

/** 出片参数（首版渲染用）。原在右栏过渡区，现在只在「这条还没出片」时出现——
 *  已经有素材包之后再改这些，只能走全管线重生成，那会覆盖剪辑台里的手工改动。 */
function VideoParamFields({ vp, setVp, bgmList, uploadAssets }: {
  vp: VideoParams; setVp: (v: VideoParams) => void; bgmList: BgmList | undefined
  /** talk 模板的口播素材候选（本项目 `type==='video' && origin==='upload'` 的 assets） */
  uploadAssets: Asset[]
}) {
  const templates = useQuery({
    queryKey: ['templates'], queryFn: () => api<CustomTemplate[]>('/api/templates'), networkMode: 'always',
  })
  const tplOptions = [
    ...VIDEO_TPLS,
    ...(templates.data ?? []).map((t) => ({ value: `custom-${t.id}`, label: `${t.name}（对标拆解 · ${t.aspect_ratio === 'portrait' ? '竖屏' : '横屏'}）` })),
  ]
  const sel = 'mt-1 w-full rounded-[var(--fc-r-sm)] border border-[var(--fc-line-2)] bg-[var(--fc-surface-2)] p-1.5 text-sm'
  const isTalk = vp.tpl === 'talk'
  return (
    <>
      <div>
        <label className="text-xs text-[var(--fc-muted)]">模板</label>
        <select className={sel} value={vp.tpl} onChange={(e) => setVp({ ...vp, tpl: e.target.value })}>
          {tplOptions.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
        </select>
        {vp.tpl === 'demo' && <p className="mt-1 text-xs text-[var(--fc-faint)]">需先在项目详情页上传 shots/ 截图</p>}
      </div>
      {isTalk && (
        <div>
          <label className="text-xs text-[var(--fc-muted)]">口播素材</label>
          {uploadAssets.length === 0 ? (
            <p className="mt-1 rounded-[var(--fc-r-sm)] bg-[var(--fc-sunken)] px-2 py-1.5 text-xs text-[var(--fc-muted)]">
              先去成片库上传口播成片
            </p>
          ) : (
            <select className={sel} value={vp.uploadAssetId ?? ''}
              onChange={(e) => setVp({ ...vp, uploadAssetId: e.target.value ? Number(e.target.value) : undefined })}>
              <option value="">选择一条上传的口播视频…</option>
              {uploadAssets.map((a) => (
                <option key={a.id} value={a.id}>
                  {(a.file_path.split(/[/\\]/).pop() ?? a.file_path)}（#{a.id}）
                </option>
              ))}
            </select>
          )}
        </div>
      )}
      <div>
        <label className="text-xs text-[var(--fc-muted)]">画布比例</label>
        <div className="mt-1 flex items-center gap-4 text-sm">
          <label className="flex items-center gap-1">
            <input type="radio" checked={vp.ratio === 'portrait'} onChange={() => setVp({ ...vp, ratio: 'portrait' })} /> 竖屏 9:16
          </label>
          <label className="flex items-center gap-1">
            <input type="radio" checked={vp.ratio === 'landscape'} onChange={() => setVp({ ...vp, ratio: 'landscape' })} /> 横屏 16:9
          </label>
        </div>
      </div>
      <div>
        <label className="text-xs text-[var(--fc-muted)]">BGM</label>
        <select className={sel} value={vp.bgm} onChange={(e) => setVp({ ...vp, bgm: e.target.value })}>
          <option value="">自动（按钩子情绪）</option>
          <option value="none">不加背景乐</option>
          {bgmList?.root.map((f) => <option key={f} value={f}>{f}</option>)}
          {Object.entries(bgmList?.byMood ?? {}).map(([m, files]) => (
            <optgroup key={m} label={m}>
              {files.map((f) => <option key={f} value={`${m}/${f}`}>{f}</option>)}
            </optgroup>
          ))}
        </select>
      </div>
      <div>
        <label className="text-xs text-[var(--fc-muted)]">情绪</label>
        <select className={sel} value={vp.mood} onChange={(e) => setVp({ ...vp, mood: e.target.value })}>
          {MOODS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
        </select>
      </div>
      <div>
        <label className="text-xs text-[var(--fc-muted)]">背景{vp.tpl === 'story' && <span className="text-[var(--fc-faint)]">（story 不显示背景层）</span>}</label>
        <select className={`${sel} disabled:opacity-50`} disabled={vp.tpl === 'story'} value={vp.bg} onChange={(e) => setVp({ ...vp, bg: e.target.value })}>
          {BGS.map((b) => <option key={b.value} value={b.value}>{b.label}</option>)}
        </select>
      </div>
      {/* talk 的人声是上传视频里自带的原声，没有 TTS 旁白可烧字幕——这项对它没有意义，隐藏而非灰显 */}
      {isTalk ? (
        <p className="text-xs text-[var(--fc-faint)]">口播人声来自视频，不走 TTS/字幕</p>
      ) : (
        <label className="flex items-center gap-2 text-xs text-[var(--fc-muted)]">
          <input type="checkbox" checked={vp.captions} onChange={(e) => setVp({ ...vp, captions: e.target.checked })} />
          烧旁白字幕进视频（默认关）
        </label>
      )}
    </>
  )
}
