import type { Effect, LayerStyle, VideoSpec } from '@forgecast/compositions/src/videospec-types'
import { paramsDiff, setLayerStyle, toggleEffect } from '@forgecast/editing'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { api, type BgmList, type ContentItemView, type CustomTemplate } from '../../../api'
import TaskProgress from '../../../components/TaskProgress'
import type { TaskRun } from '../../../useTaskRun'
import { BGS, MOODS, OUTLINE, VIDEO_TPLS, type VideoParams } from './ui'
import type { useEditorState } from './useEditorState'

/** §10 可改集的暂存草稿。键缺席＝没编辑过（paramsDiff 就是按这条口径跳过的）。 */
export interface ParamsDraft { bgVariant?: string; bgmSrc?: string | null; mood?: string | null }

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

/** 曲库文件的展示名（去掉曲库根前缀）。src 存的是绝对路径，整条铺在下拉里没法看。 */
function bgmLabel(src: string, dir: string | undefined): string {
  if (dir && src.startsWith(dir)) return src.slice(dir.length).replace(/^[/\\]/, '')
  return src.split(/[/\\]/).pop() ?? src
}

/**
 * 把暂存草稿并进 spec。**只动 §10 的三项**，其余字段逐层浅拷贝原样带过。
 * - `bgVariant: 'none'` 是合法值（`Background` 见到 'none' 就不渲染），不是「删掉字段」，
 *   所以直接写进去；与「字段本就不存在」在渲染结果上等价，但在 diff 上诚实地算一次改动。
 * - bgm 的 src 与 mood 同住一个对象：改任一项都要把另一项从当前值里带过来，否则会把它抹成 null。
 */
export function mergeParamsDraft(spec: VideoSpec, draft: ParamsDraft): VideoSpec {
  let next: VideoSpec = spec
  if (draft.bgVariant !== undefined && draft.bgVariant !== spec.bgVariant) {
    next = { ...next, bgVariant: draft.bgVariant }
  }
  if (draft.bgmSrc !== undefined || draft.mood !== undefined) {
    const src = draft.bgmSrc !== undefined ? draft.bgmSrc : (spec.audio.bgm?.src ?? null)
    const mood = draft.mood !== undefined ? draft.mood : (spec.audio.bgm?.mood ?? null)
    next = { ...next, audio: { ...next.audio, bgm: src ? { src, mood } : null } }
  }
  return next
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
  onNotice: (msg: string) => void
  /** 入队渲成片（spec 须已落盘）。返回是否入队成功。 */
  onEnqueueRender: () => Promise<boolean>
  /** ⋯ 里那个「用当前编辑结果渲成片」的正主：带确认与防御式保存。 */
  onRenderFromSpec: () => void
}) {
  const spec = ed.spec
  const [draft, setDraft] = useState<ParamsDraft>({})
  const [applying, setApplying] = useState(false)
  // 换内容项 / 重置 / 重写后草稿必须清空：它是「相对当前 spec 的改动」，换了 spec 就无所指了
  useEffect(() => { setDraft({}) }, [current?.id])

  const diff = useMemo(() => (spec ? paramsDiff(spec, draft) : []), [spec, draft])
  const changed = (key: string) => diff.some((d) => d.key === key)

  async function applyParams() {
    if (!spec || diff.length === 0 || applying) return
    setApplying(true)
    try {
      const next = mergeParamsDraft(spec, draft)
      // 先进历史（这次参数改动可撤销），再落盘。**save 必须收到显式的 next**：
      // `apply` 的 setState 还没刷新，save 内部从 ref 取 present 会拿到改动前那一份，
      // 于是「保存了旧值 → 渲了旧值」，而 UI 上参数明明已经变了。
      ed.apply(next)
      if (!(await ed.save(next))) { onNotice('重渲已取消：当前内容没有可保存的素材包'); return }
      setDraft({})
      if (await onEnqueueRender()) onNotice('已按新参数入队重渲，进度看队列卡片')
    } catch (e) {
      onNotice(`重渲失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setApplying(false)
    }
  }

  return (
    <aside
      className="flex min-h-0 flex-col overflow-hidden rounded-[var(--fc-r-md)] border border-[var(--fc-line)] bg-[var(--fc-surface)]"
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
            <VideoParamFields vp={vp} setVp={setVp} bgmList={bgmList} />
            <button className={`w-full ${OUTLINE}`} disabled={!current || busy}
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
                <Field label="BGM" changed={changed('bgmSrc')}
                  hint="换曲只换音轨；卡点网格仍是上一支曲子分析出来的，节奏可能对不上">
                  <select className={CTRL} value={draft.bgmSrc ?? spec.audio.bgm?.src ?? ''}
                    onChange={(e) => setDraft({ ...draft, bgmSrc: e.target.value || null })}>
                    <option value="">不加背景乐</option>
                    <BgmOptions list={bgmList} current={draft.bgmSrc ?? spec.audio.bgm?.src ?? null} />
                  </select>
                </Field>
                <Field label="情绪" changed={changed('mood')}
                  hint="情绪只是这条视频的标注，不会自动换曲——换曲请用上面的 BGM">
                  <select className={CTRL} value={draft.mood ?? spec.audio.bgm?.mood ?? ''}
                    onChange={(e) => setDraft({ ...draft, mood: e.target.value || null })}>
                    {MOODS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
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
                  灰显三项要重新生成才可改——它们决定画面怎么搭出来，改了得整条重跑。
                </p>

                <button
                  className={`w-full ${OUTLINE} !h-[34px] !py-0`}
                  disabled={diff.length === 0 || applying || ed.saving}
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
          <button className={`w-full ${OUTLINE}`} onClick={onRenderFromSpec} disabled={ed.saving}>
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
function BgmOptions({ list, current }: { list: BgmList | undefined; current: string | null }) {
  const dir = list?.dir
  const abs = (rel: string) => (dir ? `${dir}/${rel}` : rel)
  // 情绪子目录的曲子在 spec 里是 `<dir>/<mood>/<file>`——「在不在曲库」的比对必须带上 mood 段，
  // 否则每一支情绪曲都被判成「不在曲库」，下拉里凭空多一条重复项。
  const known = new Set([
    ...(list?.root ?? []).map(abs),
    ...Object.entries(list?.byMood ?? {}).flatMap(([m, files]) => files.map((f) => abs(`${m}/${f}`))),
  ])
  return (
    <>
      {current && !known.has(current) && (
        <option value={current}>{bgmLabel(current, dir)}（当前 · 不在曲库）</option>
      )}
      {(list?.root ?? []).map((f) => <option key={f} value={abs(f)}>{f}</option>)}
      {Object.entries(list?.byMood ?? {}).map(([m, files]) => (
        <optgroup key={m} label={m}>
          {files.map((f) => <option key={f} value={abs(`${m}/${f}`)}>{f}</option>)}
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

/** 出片参数（首版渲染用）。原在右栏过渡区，现在只在「这条还没出片」时出现——
 *  已经有素材包之后再改这些，只能走全管线重生成，那会覆盖剪辑台里的手工改动。 */
function VideoParamFields({ vp, setVp, bgmList }: { vp: VideoParams; setVp: (v: VideoParams) => void; bgmList: BgmList | undefined }) {
  const templates = useQuery({
    queryKey: ['templates'], queryFn: () => api<CustomTemplate[]>('/api/templates'), networkMode: 'always',
  })
  const tplOptions = [
    ...VIDEO_TPLS,
    ...(templates.data ?? []).map((t) => ({ value: `custom-${t.id}`, label: `${t.name}（对标拆解 · ${t.aspect_ratio === 'portrait' ? '竖屏' : '横屏'}）` })),
  ]
  const sel = 'mt-1 w-full rounded-[var(--fc-r-sm)] border border-[var(--fc-line-2)] bg-[var(--fc-surface-2)] p-1.5 text-sm'
  return (
    <>
      <div>
        <label className="text-xs text-[var(--fc-muted)]">模板</label>
        <select className={sel} value={vp.tpl} onChange={(e) => setVp({ ...vp, tpl: e.target.value })}>
          {tplOptions.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
        </select>
        {vp.tpl === 'demo' && <p className="mt-1 text-xs text-[var(--fc-faint)]">需先在项目详情页上传 shots/ 截图</p>}
      </div>
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
      <label className="flex items-center gap-2 text-xs text-[var(--fc-muted)]">
        <input type="checkbox" checked={vp.captions} onChange={(e) => setVp({ ...vp, captions: e.target.checked })} />
        烧旁白字幕进视频（默认关）
      </label>
    </>
  )
}
