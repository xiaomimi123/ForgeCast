import type { Effect, Layer, LayerStyle, VideoSpec } from '@forgecast/compositions/src/videospec-types'
import { applyStylePreset, applyStylePresetToKind, clearLayerGeometry, GEOMETRY_KEYS, paramsDiff, setEffectParams, setLayerStyle, setVideoVolume, toggleEffect, trimVideoLayer, type EffectPatch, type StylePresetPayload } from '@forgecast/editing'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { api, createStylePreset, deleteStylePreset, listLayoutTemplates, listStylePresets, type Asset, type BgmList, type ContentItemView, type CustomTemplate, type LayoutTemplate, type StylePreset } from '../../../api'
import TaskProgress from '../../../components/TaskProgress'
import type { ConfirmOpts } from '../../../components/ui/Confirm'
import { usePrompt } from '../../../components/ui/Prompt'
import type { TaskRun } from '../../../useTaskRun'
import { BGS, EFFECT_DIRECTIONS, EFFECT_PARAM_META, EFFECTS, MOODS, OUTLINE, VIDEO_TPLS, type EffectParamKey, type EffectTimingKey, type VideoParams } from './ui'
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

/** 图层 kind 的人话名（预设条的文案用）。键与服务端 style_presets.layer_kind 白名单一致（不含 video）。 */
const KIND_LABEL: Record<'text' | 'image' | 'caption' | 'shape', string> = {
  text: '文字', image: '图片', caption: '字幕', shape: '色块',
}

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
  specEpoch, slug, videoId, onSpecReplaced, className, uploadAssets, confirm,
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
  /** in-app 确认弹层（删预设用）——同 ShotList，由 EditorPage 的 useConfirm 统一提供。 */
  confirm: (opts: ConfirmOpts) => Promise<boolean>
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
            <LayerInspector ed={ed} spec={spec} layerId={selectedLayerId} confirm={confirm} onNotice={onNotice} />

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
function LayerInspector({ ed, spec, layerId, confirm, onNotice }: {
  ed: ReturnType<typeof useEditorState>; spec: VideoSpec; layerId: string | null
  confirm: (opts: ConfirmOpts) => Promise<boolean>; onNotice: (msg: string) => void
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
  /** 文字效果（描边 / 发光）只有真有文字的两种 kind 有意义——两端 CSS 映射对 image/shape 不产出。 */
  const isText = layer.content.kind === 'text' || layer.content.kind === 'caption'
  const patchLive = (patch: Partial<LayerStyle>) => ed.applyTransient(setLayerStyle(spec, layer.id, patch))
  const patchStep = (patch: Partial<LayerStyle>) => ed.apply(setLayerStyle(spec, layer.id, patch))
  /** 数字输入：空串＝不设这一项（回落模板默认），不是 0。 */
  const num = (v: string): number | undefined => (v === '' ? undefined : Number(v))

  /** 画布拖拽/缩放写下的几何覆盖。全都没有＝这层还在模板的文档流里，「清除」无事可做。 */
  const hasGeometry = GEOMETRY_KEYS.some((k) => st[k] !== undefined)

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
      {/* 风格预设条：底片层（video）没有可存的品牌样式，服务端的 layerKind 白名单也把它排除在外 */}
      {layer.kind !== 'video' && <PresetStrip ed={ed} spec={spec} layer={layer} confirm={confirm} onNotice={onNotice} />}
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
        {/* 单层排版重置：把画布上拖/缩出来的 x/y/宽/高/字号一次删干净，让这层退回模板的文档流位置。
            全片重置在别处，这里只管当前这一层。 */}
        <Field label="排版">
          <button
            className={`${OUTLINE} !px-2 !py-0.5 !text-[11px]`}
            disabled={!hasGeometry}
            title={hasGeometry
              ? '删掉 x / y / 宽 / 高 / 字号，这层回到模板排版'
              : '这层没有位置覆盖，本来就在模板排版里'}
            // 先收掉上面数字框可能还没失焦的 transient 序列，免得这一步和它挤进同一格 undo
            onClick={() => { ed.commit(); ed.apply(clearLayerGeometry(spec, layer.id)) }}
          >清除位置覆盖</button>
        </Field>
        {/* 卡片效果对 text / image / caption / shape 一视同仁（都是画面上的一块矩形）；
            video 层走的是上面那条分支，本来就到不了这里。 */}
        <CardEffectFields st={st} layerId={layer.id} patchLive={patchLive} patchStep={patchStep} commit={() => ed.commit()} />
        {isText && (
          <TextEffectFields st={st} layerId={layer.id} patchLive={patchLive} patchStep={patchStep} commit={() => ed.commit()} />
        )}
      </>
        )}

        <SectionLabel>特效</SectionLabel>
        <div className="space-y-0.5">
          {EFFECTS.map((fx) => <EffectRow key={fx.type} ed={ed} spec={spec} layer={layer} fx={fx} />)}
        </div>
      </div>
    </div>
  )
}

/**
 * 数字输入：**本地草稿 + 失焦/回车提交**，不像 X/Y/字号那样每次 onChange 就 applyTransient。
 * 受控回写会把半截数字改掉——键入 `1.5`，敲到 `1.` 那一刻 `Number('1.')` 是 1，小数点再也打不进去
 * （同 VideoLayerFields 裁头/裁尾的既有姿势）。
 *
 * **清空 = 提交 `undefined`**：调用方据此把这一项从 style 里删掉（`setLayerStyle` 的删键语义），
 * 于是控件回到 placeholder 显示的模板默认值。调用方要给 `key` 带上 layer.id，换层时草稿才作废。
 */
function NumIn({ value, onCommit, step, min, max, placeholder }: {
  value: number | undefined
  onCommit: (v: number | undefined) => void
  step?: number; min?: number; max?: number; placeholder?: string
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const commit = (raw: string) => {
    setDraft(null)
    if (raw.trim() === '') { if (value !== undefined) onCommit(undefined); return }
    const n = Number(raw)
    if (!Number.isFinite(n) || n === value) return
    onCommit(n)
  }
  return (
    <input
      className={CTRL} type="number" step={step} min={min} max={max}
      placeholder={placeholder ?? '默认'}
      value={draft ?? value ?? ''}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={(e) => commit(e.target.value)}
      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
    />
  )
}

/**
 * 颜色输入 + 「清除」。颜色走 `applyTransient` + 失焦 `commit`（同上面的「颜色 / 底色」两项）而不是
 * 本地草稿：原生取色器拖动时每移一格都发 onChange，要的就是即时预览，而它又不存在「半截数字」问题。
 * 清除是离散的一步，直接 `apply`。`<input type="color">` 没有「空」态，所以未设值时显示 fallback，
 * 真实状态由右侧那行小字（色值 / 「默认」）说清楚。
 */
function ColorIn({ value, fallback, onLive, onDone, onClear }: {
  value: string | undefined; fallback: string
  onLive: (c: string) => void; onDone: () => void; onClear?: () => void
}) {
  return (
    <div className="flex items-center gap-2">
      <input
        className="h-[28px] w-[44px] shrink-0 rounded-[var(--fc-r-sm)] border border-[var(--fc-line-2)] bg-[var(--fc-surface-2)]"
        type="color" value={value ?? fallback}
        onChange={(e) => onLive(e.target.value)} onBlur={onDone}
      />
      <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-[var(--fc-faint)]">{value ?? '默认'}</span>
      {onClear && (
        <button className={`${OUTLINE} !px-2 !py-0.5 !text-[11px]`} onClick={onClear}>清除</button>
      )}
    </div>
  )
}

/** 小节标题（卡片效果 / 文字效果 / 特效）。 */
function SectionLabel({ children }: { children: ReactNode }) {
  return <div className="pt-1 font-mono text-[10px] uppercase tracking-wide text-[var(--fc-muted)]">{children}</div>
}

/** 结构化字段的兜底值：`shadow`/`glow`/`bgGradient` 的子键都是必填，从「没设过」到「设了一项」
 *  必须把整组补齐，不能落一个 `{blur: 8}` 这种缺键的对象出去（两端 CSS 映射会读到 undefined）。 */
const SHADOW_DEF = { blur: 12, x: 0, y: 6, color: '#000000' } as const
const GLOW_DEF = { blur: 8, color: '#FFD400' } as const
const GRADIENT_DEF = { from: '#FFFFFF', to: '#E6E6E6', angle: 180 } as const

/**
 * 卡片效果小节：描边 / 圆角 / 阴影 / 毛玻璃 / 渐变底。**只在非 video 层出现**——调用点就在
 * 样式组对 video 的隐藏分支里面，不另加判断。
 *
 * 结构化三项（shadow / glow / bgGradient）**整组存在或整组不存在**：任一子键被清空即整组删除
 * （`patchStep({ shadow: undefined })`），因为「有阴影但没有模糊半径」不是一个有意义的中间态。
 */
function CardEffectFields({ st, layerId, patchLive, patchStep, commit }: {
  st: LayerStyle; layerId: string
  patchLive: (p: Partial<LayerStyle>) => void
  patchStep: (p: Partial<LayerStyle>) => void
  commit: () => void
}) {
  /** 结构化组的子键改写：v === undefined ⇒ 整组删；否则以兜底值补齐后合并。 */
  const shadow = (k: 'blur' | 'x' | 'y', v: number | undefined) =>
    v === undefined ? patchStep({ shadow: undefined }) : patchStep({ shadow: { ...SHADOW_DEF, ...st.shadow, [k]: v } })
  const grad = (k: 'angle', v: number | undefined) =>
    v === undefined ? patchStep({ bgGradient: undefined }) : patchStep({ bgGradient: { ...GRADIENT_DEF, ...st.bgGradient, [k]: v } })

  return (
    <>
      <SectionLabel>卡片效果</SectionLabel>
      <Field label="描边" hint="边框宽度（px），清空＝不描边">
        <NumIn key={`${layerId}:borderWidth`} value={st.borderWidth} step={1} min={0}
          onCommit={(v) => patchStep({ borderWidth: v })} />
      </Field>
      {/* 「清除」只在真设过时可点：没设过时按下去是一步什么也不改的 undo，还会把该层
          置成 overridden（品牌 kit 不再覆盖），全是净损失。「字色」同理。 */}
      <Field label="边色" hint="边框颜色">
        <ColorIn value={st.borderColor} fallback="#181A16"
          onLive={(c) => patchLive({ borderColor: c })} onDone={commit}
          onClear={st.borderColor ? () => patchStep({ borderColor: undefined }) : undefined} />
      </Field>
      <Field label="圆角" hint="border-radius（px），清空＝回落模板默认">
        <NumIn key={`${layerId}:radius`} value={st.radius} step={2} min={0}
          onCommit={(v) => patchStep({ radius: v })} />
      </Field>
      <Field label="阴影" hint="模糊半径（px）。清空这一格＝整组阴影删除">
        <NumIn key={`${layerId}:shadowBlur`} value={st.shadow?.blur} step={2} min={0} placeholder="无阴影"
          onCommit={(v) => shadow('blur', v)} />
      </Field>
      <Field label="影X" hint="阴影横向偏移（px）。清空这一格＝整组阴影删除">
        <NumIn key={`${layerId}:shadowX`} value={st.shadow?.x} step={1}
          onCommit={(v) => shadow('x', v)} />
      </Field>
      <Field label="影Y" hint="阴影纵向偏移（px）。清空这一格＝整组阴影删除">
        <NumIn key={`${layerId}:shadowY`} value={st.shadow?.y} step={1}
          onCommit={(v) => shadow('y', v)} />
      </Field>
      <Field label="影色">
        <ColorIn value={st.shadow?.color} fallback={SHADOW_DEF.color}
          onLive={(c) => patchLive({ shadow: { ...SHADOW_DEF, ...st.shadow, color: c } })} onDone={commit}
          onClear={st.shadow ? () => patchStep({ shadow: undefined }) : undefined} />
      </Field>
      <Field label="毛玻" hint="backdrop-filter blur 0~40px">
        <div className="flex items-center gap-2">
          <input
            className="h-[28px] min-w-0 flex-1" type="range" min={0} max={40} step={1}
            value={st.backdropBlur ?? 0}
            onChange={(e) => patchLive({ backdropBlur: Number(e.target.value) })}
            onPointerUp={commit} onBlur={commit}
          />
          <span className="w-6 shrink-0 text-right font-mono text-[10px] text-[var(--fc-faint)]">
            {st.backdropBlur ?? 0}
          </span>
          <button className={`${OUTLINE} !px-2 !py-0.5 !text-[11px]`}
            disabled={st.backdropBlur === undefined}
            onClick={() => patchStep({ backdropBlur: undefined })}>清除</button>
        </div>
      </Field>
      <Field label="渐起" hint="线性渐变起点色（设了这项就整组生效）">
        <ColorIn value={st.bgGradient?.from} fallback={GRADIENT_DEF.from}
          onLive={(c) => patchLive({ bgGradient: { ...GRADIENT_DEF, ...st.bgGradient, from: c } })} onDone={commit}
          onClear={st.bgGradient ? () => patchStep({ bgGradient: undefined }) : undefined} />
      </Field>
      <Field label="渐止" hint="线性渐变终点色">
        <ColorIn value={st.bgGradient?.to} fallback={GRADIENT_DEF.to}
          onLive={(c) => patchLive({ bgGradient: { ...GRADIENT_DEF, ...st.bgGradient, to: c } })} onDone={commit}
          onClear={st.bgGradient ? () => patchStep({ bgGradient: undefined }) : undefined} />
      </Field>
      <Field label="渐角" hint="0~360 度。清空这一格＝整组渐变删除">
        <NumIn key={`${layerId}:gradAngle`} value={st.bgGradient?.angle} step={15} min={0} max={360} placeholder="无渐变"
          onCommit={(v) => grad('angle', v)} />
      </Field>
    </>
  )
}

/** 文字效果小节：描边（-webkit-text-stroke）与发光。**只有 text / caption 层有文字可描/可发光**，
 *  image / shape 上这两项在两端 CSS 映射里都不产出，出这组控件等于给一排点了没反应的框。 */
function TextEffectFields({ st, layerId, patchLive, patchStep, commit }: {
  st: LayerStyle; layerId: string
  patchLive: (p: Partial<LayerStyle>) => void
  patchStep: (p: Partial<LayerStyle>) => void
  commit: () => void
}) {
  return (
    <>
      <SectionLabel>文字效果</SectionLabel>
      <Field label="字边" hint="文字描边宽度（px），清空＝不描边">
        <NumIn key={`${layerId}:textStrokeWidth`} value={st.textStrokeWidth} step={0.5} min={0}
          onCommit={(v) => patchStep({ textStrokeWidth: v })} />
      </Field>
      <Field label="字色" hint="文字描边颜色">
        <ColorIn value={st.textStrokeColor} fallback="#181A16"
          onLive={(c) => patchLive({ textStrokeColor: c })} onDone={commit}
          onClear={st.textStrokeColor ? () => patchStep({ textStrokeColor: undefined }) : undefined} />
      </Field>
      <Field label="发光" hint="text-shadow 模糊半径（px）。清空这一格＝整组发光删除">
        <NumIn key={`${layerId}:glowBlur`} value={st.glow?.blur} step={2} min={0} placeholder="不发光"
          onCommit={(v) => (v === undefined
            ? patchStep({ glow: undefined })
            : patchStep({ glow: { ...GLOW_DEF, ...st.glow, blur: v } }))} />
      </Field>
      <Field label="光色">
        <ColorIn value={st.glow?.color} fallback={GLOW_DEF.color}
          onLive={(c) => patchLive({ glow: { ...GLOW_DEF, ...st.glow, color: c } })} onDone={commit}
          onClear={st.glow ? () => patchStep({ glow: undefined }) : undefined} />
      </Field>
    </>
  )
}

/**
 * 一行特效：勾选开关 + 「⚙」展开参数面板。
 *
 * 勾选是离散的一步（`toggleEffect` + `apply`）。参数面板里的每次提交也是**一步 undo**——
 * `setEffectParams` 是纯函数且同值返回原引用，所以拿 `next !== spec` 挡掉空改动，避免用户按 ⌘Z
 * 时先吃掉几格「什么也没变」。
 *
 * 关掉特效时顺手收起面板：这一层已经没有这个 effect 了，`setEffectParams` 对它会 throw，
 * 留着一个能点却必炸的面板毫无意义。
 */
function EffectRow({ ed, spec, layer, fx }: {
  ed: ReturnType<typeof useEditorState>; spec: VideoSpec; layer: Layer
  fx: { type: Effect['type']; label: string; timing: EffectTimingKey[]; params: EffectParamKey[] }
}) {
  const [open, setOpen] = useState(false)
  const effect = layer.effects.find((e) => e.type === fx.type) ?? null
  const on = effect !== null
  useEffect(() => { if (!on) setOpen(false) }, [on])

  const setP = (patch: EffectPatch) => {
    // 上面样式框可能还挂着没收尾的 transient 序列，不先收掉会和这一步挤进同一格 undo
    ed.commit()
    const next = setEffectParams(spec, layer.id, fx.type, patch)
    if (next !== spec) ed.apply(next)
  }
  /** params 里的数值键。清空输入框在这里是**空操作**（特效参数没有「删一个键」的语义——
   *  不设＝用 styleAt 的缺省，而缺省正是 placeholder 显示的那个数），所以只提交有值的改动。 */
  const setNum = (key: Exclude<keyof EffectPatch, 'direction'>, v: number | undefined) => {
    if (v !== undefined) setP({ [key]: v } as EffectPatch)
  }
  const paramNum = (key: EffectParamKey): number | undefined => {
    const v = effect?.params?.[key]
    return typeof v === 'number' ? v : undefined
  }

  return (
    <div className="rounded-[var(--fc-r-xs)]">
      <div className="flex items-center gap-1 text-[11px] text-[var(--fc-muted)]">
        <label className="flex min-w-0 flex-1 items-center gap-1">
          <input type="checkbox" checked={on}
            onChange={(e) => { ed.commit(); ed.apply(toggleEffect(spec, layer.id, fx.type, e.target.checked)) }} />
          <span className="truncate">{fx.label}</span>
        </label>
        <button
          className={`${OUTLINE} !px-1.5 !py-0 !text-[11px] ${open ? '!border-[var(--fc-accent)] !text-[var(--fc-accent-deep)]' : ''}`}
          disabled={!on} aria-label={`${fx.label}参数`} aria-expanded={open}
          title={on ? '展开参数' : '先勾上这个特效'}
          onClick={() => setOpen((v) => !v)}
        >⚙</button>
      </div>
      {open && effect && (
        <div className="mb-1 mt-1 space-y-1.5 rounded-[var(--fc-r-sm)] bg-[var(--fc-sunken)] px-2 py-1.5">
          {/* at / duration 按 fx.timing 出——不是所有类型都读这两项（pulse 不读 duration、
              exit 不读 at、decode 两个都不读），出了就是点了不变画面的死控件。 */}
          {fx.timing.includes('at') && (
            <Field label="延迟" hint="相对图层起点的秒偏移（默认 0）">
              <NumIn key={`${layer.id}:${fx.type}:at`} value={effect.at} step={0.1} min={0} placeholder="0"
                onCommit={(v) => setNum('at', v)} />
            </Field>
          )}
          {fx.timing.includes('duration') && (
            <Field label="时长" hint="特效持续秒数（默认 0.3）">
              <NumIn key={`${layer.id}:${fx.type}:duration`} value={effect.duration} step={0.1} min={0} placeholder="0.3"
                onCommit={(v) => setNum('duration', v)} />
            </Field>
          )}
          {fx.params.map((key) => {
            const meta = EFFECT_PARAM_META[key]
            if (key === 'direction') {
              const cur = typeof effect.params?.direction === 'string' ? effect.params.direction : 'up'
              return (
                <Field key={key} label={meta.label} hint={meta.hint}>
                  <select className={CTRL} value={cur}
                    onChange={(e) => setP({ direction: e.target.value as 'up' | 'down' | 'left' | 'right' })}>
                    {EFFECT_DIRECTIONS.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
                  </select>
                </Field>
              )
            }
            return (
              <Field key={key} label={meta.label} hint={meta.hint}>
                <NumIn key={`${layer.id}:${fx.type}:${key}`} value={paramNum(key)} step={meta.step}
                  placeholder={meta.placeholder} onCommit={(v) => setNum(key, v)} />
              </Field>
            )
          })}
          {fx.params.length === 0 && fx.timing.length > 0 && (
            <p className="text-[11px] leading-relaxed text-[var(--fc-faint)]">
              这个特效只有{fx.timing.includes('at') ? '延迟' : ''}{fx.timing.length === 2 ? ' / ' : ''}{fx.timing.includes('duration') ? '时长' : ''}可调。
            </p>
          )}
          {fx.params.length === 0 && fx.timing.length === 0 && (
            <p className="text-[11px] leading-relaxed text-[var(--fc-faint)]">这个特效没有可调参数。</p>
          )}
        </div>
      )}
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
  const [draft, setDraft] = useState<{ key: 'start' | 'end' | 'volume'; value: string } | null>(null)
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
      {/* 音量和 trim 一样走本地草稿：受控回写会把半截数字改掉——键入 `0.5` 敲到 `0.` 那一刻
          `Number('0.')` 是 0，小数点当场被抹掉，再也打不进去。失焦 / 回车才提交。 */}
      <Field label="音量" hint="口播原声音量 0~1（清空＝回到满音量）">
        <input
          className={CTRL} type="number" step={0.1} min={0} max={1}
          value={draft?.key === 'volume' ? draft.value : (content.volume ?? 1)}
          onChange={(e) => setDraft({ key: 'volume', value: e.target.value })}
          onBlur={(e) => {
            setDraft(null)
            const v = e.target.value.trim() === '' ? 1 : Number(e.target.value)
            if (!Number.isFinite(v)) return
            const next = setVideoVolume(spec, layer.id, v)
            if (next !== spec) ed.apply(next)
          }}
          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
        />
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
  const layoutTemplates = useQuery({
    queryKey: ['layout-templates'], queryFn: listLayoutTemplates, networkMode: 'always',
  })
  const tplOptions = [
    ...VIDEO_TPLS,
    ...(templates.data ?? []).map((t) => ({ value: `custom-${t.id}`, label: `${t.name}（对标拆解 · ${t.aspect_ratio === 'portrait' ? '竖屏' : '横屏'}）` })),
  ]
  // 只列「模板与当前出片模板一致、比例与当前画布比例一致」的版式——跨模板/跨比例套用会与服务端的
  // tpl 精确匹配校验失配（400），套了也没有对应的角色位置/样式可用
  const matchingLayoutTemplates = (layoutTemplates.data ?? []).filter(
    (t: LayoutTemplate) => t.template === vp.tpl && t.ratio === vp.ratio,
  )
  const sel = 'mt-1 w-full rounded-[var(--fc-r-sm)] border border-[var(--fc-line-2)] bg-[var(--fc-surface-2)] p-1.5 text-sm'
  const isTalk = vp.tpl === 'talk'
  return (
    <>
      <div>
        <label className="text-xs text-[var(--fc-muted)]">模板</label>
        {/* 切模板：套用中的版式很可能与新模板失配，一并清掉 */}
        <select className={sel} value={vp.tpl} onChange={(e) => setVp({ ...vp, tpl: e.target.value, layoutTemplateId: undefined })}>
          {tplOptions.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
        </select>
        {vp.tpl === 'demo' && <p className="mt-1 text-xs text-[var(--fc-faint)]">需先在项目详情页上传 shots/ 截图</p>}
      </div>
      <div>
        <label className="text-xs text-[var(--fc-muted)]">排版模板</label>
        <select className={sel} value={vp.layoutTemplateId ?? ''}
          onChange={(e) => setVp({ ...vp, layoutTemplateId: e.target.value ? Number(e.target.value) : undefined })}>
          <option value="">不套用</option>
          {matchingLayoutTemplates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
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
            <input type="radio" checked={vp.ratio === 'portrait'} onChange={() => setVp({ ...vp, ratio: 'portrait', layoutTemplateId: undefined })} /> 竖屏 9:16
          </label>
          <label className="flex items-center gap-1">
            <input type="radio" checked={vp.ratio === 'landscape'} onChange={() => setVp({ ...vp, ratio: 'landscape', layoutTemplateId: undefined })} /> 横屏 16:9
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


/**
 * 风格预设条（单层）。三件事：**存**当前层的样式为预设、把预设**套**到当前层、把预设**套到全部同类层**。
 *
 * 「含位置」是**存的那一刻**决定的，不是套的那一刻——勾了就把 `x/y` 一起存进 payload，没勾就在存之前
 * 剔掉。这样 payload 自己就是全部真相，套用时无条件 `withPosition: true`（payload 里没有 x/y，
 * 展开合并自然不动目标层的位置）。反过来把开关放在套用侧的话，同一条预设在两次套用中的语义会
 * 不一样，而列表里看不出区别——预设的意义就没了。
 *
 * 套用一次 = 一步 undo（`ed.apply`）。套之前先 `ed.commit()`：上面的数字/颜色框可能还挂着未
 * 收尾的 transient 序列，不收掉会和这一步挤进同一格 undo。
 *
 * 删除做成下拉右侧的「×」（删当前选中的那条）而不是下拉项内嵌的小 ×——原生 `<select>` 的
 * `<option>` 里放不了按钮，为一个删除动作换掉整个下拉（自绘浮层 + 键盘导航 + 失焦收起）不划算。
 */
function PresetStrip({ ed, spec, layer, confirm, onNotice }: {
  ed: ReturnType<typeof useEditorState>; spec: VideoSpec; layer: Layer
  confirm: (opts: ConfirmOpts) => Promise<boolean>; onNotice: (msg: string) => void
}) {
  const qc = useQueryClient()
  const { prompt, element: promptEl } = usePrompt()
  const [selId, setSelId] = useState<number | ''>('')
  const [working, setWorking] = useState(false)
  const kind = layer.kind as StylePreset['layerKind']
  const list = useQuery({ queryKey: ['style-presets'], queryFn: listStylePresets, networkMode: 'always' })
  const mine = useMemo(() => (list.data ?? []).filter((p) => p.layerKind === kind), [list.data, kind])
  // 换到别的 kind 后原来选中的那条不在列表里了，下拉会静默显示第一条却仍持有旧 id——清掉。
  useEffect(() => { setSelId('') }, [kind])
  const chosen = mine.find((p) => p.id === selId) ?? null
  const locked = working || ed.saving || ed.busy

  async function doSave() {
    const r = await prompt({
      title: '存为风格预设',
      body: `当前层的字号 / 颜色 / 对齐 / 透明度 / 特效会一起存下来，之后可套到别的${KIND_LABEL[kind]}层上。`,
      label: '预设名', placeholder: '如：主标题 · 大字白',
      checkbox: { label: '含位置（x / y）', hint: '不勾选：套用时只改观感，目标层停在原位' },
    })
    if (!r) return
    const { x, y, ...noPos } = layer.style
    const payload: StylePresetPayload = { style: r.checked ? { ...layer.style } : noPos, effects: [...layer.effects] }
    setWorking(true)
    try {
      await createStylePreset({ name: r.name, layerKind: kind, payload })
      await qc.invalidateQueries({ queryKey: ['style-presets'] })
      onNotice(`已存为预设「${r.name}」`)
    } catch (e) {
      onNotice(`存预设失败：${e instanceof Error ? e.message : String(e)}`)
    } finally { setWorking(false) }
  }

  function doApply(all: boolean) {
    if (!chosen) return
    ed.commit()
    const next = all
      ? applyStylePresetToKind(spec, kind, chosen.payload, { withPosition: true })
      : applyStylePreset(spec, layer.id, chosen.payload, { withPosition: true })
    if (next === spec) { onNotice('这份预设没有可套的内容'); return }
    ed.apply(next)
    const n = all ? spec.layers.filter((l) => l.kind === kind).length : 1
    onNotice(`已套用「${chosen.name}」到 ${n} 层（⌘/Ctrl+Z 可撤销）`)
  }

  async function doDelete() {
    if (!chosen) return
    if (!(await confirm({ title: `删除预设「${chosen.name}」？`, body: '已经套用过的图层不受影响。', danger: true }))) return
    setWorking(true)
    try {
      await deleteStylePreset(chosen.id)
      setSelId('')
      await qc.invalidateQueries({ queryKey: ['style-presets'] })
      onNotice('预设已删除')
    } catch (e) {
      onNotice(`删除失败：${e instanceof Error ? e.message : String(e)}`)
    } finally { setWorking(false) }
  }

  return (
    <div className="mb-2 rounded-[var(--fc-r-sm)] bg-[var(--fc-sunken)] p-1.5">
      <div className="flex items-center gap-1">
        <select
          className={`${CTRL} min-w-0 flex-1`} value={selId}
          onChange={(e) => setSelId(e.target.value ? Number(e.target.value) : '')}
        >
          <option value="">{mine.length ? `选一条${KIND_LABEL[kind]}预设…` : `还没有${KIND_LABEL[kind]}预设`}</option>
          {mine.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <button
          className={`${OUTLINE} !h-[28px] !px-1.5 !py-0 !text-[11px]`}
          disabled={!chosen || locked} title="删除选中的这条预设" aria-label="删除预设"
          onClick={doDelete}
        >×</button>
      </div>
      <div className="mt-1 flex items-center gap-1">
        <button className={`${OUTLINE} !h-[26px] flex-1 !px-1 !py-0 !text-[11px]`}
          disabled={!chosen || locked} title="套到当前选中的这一层" onClick={() => doApply(false)}>套用</button>
        <button className={`${OUTLINE} !h-[26px] flex-1 !px-1 !py-0 !text-[11px]`}
          disabled={!chosen || locked} title={`套到本片所有${KIND_LABEL[kind]}层`} onClick={() => doApply(true)}>全部同类</button>
        <button className={`${OUTLINE} !h-[26px] flex-1 !px-1 !py-0 !text-[11px]`}
          disabled={locked} onClick={doSave}>存为预设…</button>
      </div>
      {promptEl}
    </div>
  )
}
