import { init, push, redo as redoH, undo as undoH, type History } from '@forgecast/editing'
import type { VideoSpec } from '@forgecast/compositions/src/videospec-types'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { rebaseSpecForPreview } from '../../../lib/rebase'

/**
 * 「重置为生成结果」时后端返回 404＝这条视频生成于旧版本、没落 `.orig.json` 快照。
 * 这不是故障而是能力缺失，调用方据此**隐藏**重置按钮而不是弹一个红色报错。
 * 用具名类给调用方一个可识别（instanceof）的判据——靠 message 里 '404' 子串匹配太脆。
 */
export class NoOrigSnapshotError extends Error {
  constructor(message = '这条视频没有生成快照（生成于旧版本），无法重置') {
    super(message)
    this.name = 'NoOrigSnapshotError'
  }
}

export interface EditorState {
  spec: VideoSpec | null
  loading: boolean
  loadError: string | null
  dirty: boolean
  apply(next: VideoSpec): void
  /**
   * 拖拽期间的「替换 present，不压栈」。第一次调用时把当前 present 记成本次拖拽的基线，
   * 之后每一帧只换 present——否则一次拖拽会在 undo 栈里留下几十格，⌘Z 得按到手酸。
   * 必须与 `commit()` 成对使用（pointerdown→applyTransient…→pointerup→commit）。
   */
  applyTransient(next: VideoSpec): void
  /** 收尾一次 transient 序列：与基线不同则重建成「基线 push 当前值」＝一次拖拽恰好一格 undo。 */
  commit(): void
  /**
   * 把「当前这份 spec 已与磁盘一致」告诉状态机。用于**服务端替我们落了盘**的路径
   *（重写这段：服务端读盘、改、写回，再把新 spec 返回给前端）——那时磁盘已是新值，
   * 不调它的话净快照还停在重写前，「未保存」会假亮，用户会去按一次没有意义的 ⌘S。
   */
  markSaved(spec: VideoSpec): void
  undo(): void
  redo(): void
  canUndo: boolean
  canRedo: boolean
  saving: boolean
  /**
   * 返回是否**真的写了盘**：没有 spec（待出片内容）时静默 false，调用方据此决定弹不弹「已保存」。
   *
   * `explicit`：要落盘的那一份。调用方刚 `apply(next)` 又马上要保存时**必须**传它——
   * setState 还没刷新，内部从 ref 取到的仍是改动前那一份，会静默保存旧值（然后按旧值渲染，
   * 而界面上参数已经变了，这是最难查的那类不一致）。
   */
  save(explicit?: VideoSpec): Promise<boolean>
  resetToOrig(): Promise<void>
  /**
   * 这条视频有没有 `.orig.json` 生成快照（＝「重置为生成结果」能不能用）。随 GET spec 一起拿到，
   * 调用方据此**进场就决定**显不显示重置入口，而不是等用户点了吃个 404 再收回按钮。
   * 还没载入时为 false（宁可少显示一个入口，也不要显示一个点了必失败的入口）。
   */
  hasOrig: boolean
  previewSpec: VideoSpec | null
  /**
   * 有没有一条**服务端读改写**在途（重写这段 / 用新参数重渲 / 用当前编辑结果渲成片）。
   * 这三条都是「服务端读盘 → 改 → 写回」，在途时若另一条并发发出，两次读改写会乱序、
   * 静默互覆盖磁盘上的结果——只罩住 `save()` 的 PUT 不够，问题出在 PUT 之后那次 POST 上。
   * 调用方据此把触发按钮 `disabled` 一起罩住。
   */
  busy: boolean
  /**
   * 三条服务端读改写路径的互斥闸门：`busy` 时直接返回 `undefined`（`fn` 不会被调用），
   * 调用方据此提示「另一操作进行中」；否则置 `busy` 执行 `fn`，`finally` 清。
   * **只管标志，不嵌套调用自身**——`save()` 不走它，被它包裹的路径内部调 `save()` 不会死锁。
   */
  runExclusive<T>(fn: () => Promise<T>): Promise<T | undefined>
}

/**
 * 剪辑台的**单一真相**：内存里的 VideoSpec + 撤销栈 + 与磁盘的脏/净关系。
 *
 * - 撤销栈用 `@forgecast/editing` 的 History reducer（纯函数、已有单测），这里只负责把它接到 React。
 * - `dirty` 用 `JSON.stringify` 与「最后一次落盘的快照」比。这比逐字段 diff 笨，但 spec 是纯 JSON、
 *   字段顺序在整个链路里都由同一份对象结构决定，够用且不会漏报；漏报（该脏说不脏）才是危险方向。
 * - `previewSpec` 是喂 Player 的那份（资源路径改成 `/files/...` 基准），**不入历史、不落盘**：
 *   它只是同一份 spec 的显示投影，写回磁盘会把绝对 URL 固化进素材包。
 */
/**
 * 载入时的**最小形状校验**：磁盘上的 spec 是可以被手改坏的（也可能是老版本/别的工具写的），
 * 而剪辑台全链路（`rebaseSpecForPreview` 取 `l.content.kind`、`deriveShots`、`spec.audio.beatGrid`）
 * 都假定了 `VideoSpec` 的形状——不合格的 spec 会在渲染期抛 TypeError，整页白屏，比「读取失败」
 * 难懂得多。这里只查最小必要项（layers 是数组且每层有 content.kind；audio 是对象），
 * 不合格就 throw 走同一条 `.catch` → `loadError` 失败态（EditorPage 已有重试/查看日志）。
 * 不做完整校验：那是服务端 `validateSpecPut` 的活，这里只负责「不白屏」。
 */
function assertSpecShape(spec: unknown): void {
  const s = spec as { layers?: unknown; audio?: unknown }
  if (!Array.isArray(s.layers)) throw new Error('spec 缺少 layers 数组')
  if (!s.audio || typeof s.audio !== 'object') throw new Error('spec 缺少 audio')
  const bad = s.layers.findIndex((l) => {
    const c = (l as { content?: { kind?: unknown } } | null)?.content
    return !c || typeof c.kind !== 'string'
  })
  if (bad >= 0) throw new Error(`第 ${bad + 1} 个图层缺少 content.kind`)
}

export function useEditorState(slug: string, videoId: string | null): EditorState {
  const [history, setHistory] = useState<History | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  // 最后一次与磁盘一致的序列化快照。null＝还没载入。
  const [savedJson, setSavedJson] = useState<string | null>(null)
  const [hasOrig, setHasOrig] = useState(false)
  const [busy, setBusy] = useState(false)
  // 用 ref 做互斥判据：两次点击之间 setState 不一定已经刷新，state 判「是否已在途」会漏拦。
  const busyRef = useRef(false)
  const runExclusive = useCallback(async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    if (busyRef.current) return undefined
    busyRef.current = true
    setBusy(true)
    try {
      return await fn()
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }, [])
  // save() 被键盘快捷键调用时闭包会捕获旧的 history；用 ref 取「此刻」的 present。
  const historyRef = useRef<History | null>(null)
  historyRef.current = history

  useEffect(() => {
    setHistory(null)
    setSavedJson(null)
    setLoadError(null)
    setHasOrig(false)
    if (!slug || !videoId) { setLoading(false); return }
    setLoading(true)
    let alive = true
    fetch(`/api/projects/${slug}/specs/${videoId}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}：${await r.text()}`)
        return r.json() as Promise<VideoSpec & { hasOrig?: boolean }>
      })
      .then((body) => {
        if (!alive) return
        // `hasOrig` 是**响应包装字段，不是 VideoSpec 的一部分**：必须在这里摘掉。留在对象里，
        // 它会跟着 PUT 一起写回磁盘（服务端 validateSpecPut 不拒未知字段），从此每份 spec 都带一个
        // 假字段，还会让 dirty 的 JSON 比较凭空多一项。
        const { hasOrig: orig = false, ...spec } = body
        assertSpecShape(spec)
        setHasOrig(orig)
        setHistory(init(spec as VideoSpec))
        setSavedJson(JSON.stringify(spec))
        setLoading(false)
      })
      .catch((e) => {
        if (!alive) return
        setLoadError(`素材包读取失败：${e instanceof Error ? e.message : String(e)}`)
        setLoading(false)
      })
    return () => { alive = false }
  }, [slug, videoId])

  const spec = history?.present ?? null

  const apply = useCallback((next: VideoSpec) => {
    // `@forgecast/editing` 的 op 在「这次操作什么也没改」时**刻意返回同一引用**（钳制到边界、
    // 吸附到原位等）。不拦的话每次这样的空操作都占一格 undo 栈，用户连按几次 ⌘Z 却一动不动。
    setHistory((h) => (h && next !== h.present ? push(h, next) : h))
  }, [])
  /** 一次 transient 序列的基线（拖拽开始时的 present）。null＝当前不在序列中。 */
  const transientBase = useRef<VideoSpec | null>(null)
  const applyTransient = useCallback((next: VideoSpec) => {
    // 基线在**序列的第一次调用**时取，且取自 ref 而不是 setState 的 updater 参数：
    // updater 必须是纯函数（StrictMode 下会被调用两次），在里面写 ref 会记错基线。
    if (transientBase.current === null) transientBase.current = historyRef.current?.present ?? null
    setHistory((h) => (h && next !== h.present ? { ...h, present: next } : h))
  }, [])
  const commit = useCallback(() => {
    const base = transientBase.current
    transientBase.current = null
    if (!base) return
    // 「基线 push 当前值」：past 末尾补上基线、present 保持拖完的值 → ⌘Z 一步回到拖拽前。
    // 拖了又拖回原位（present === base）时什么都不压，不占空格子。
    setHistory((h) => (h && h.present !== base ? push({ ...h, present: base }, h.present) : h))
  }, [])

  // 拖拽进行中（transient 序列未收尾）时忽略撤销/重做：此刻 present 是「还没入栈的中间态」，
  // undo 会把 past 顶上那格弹出来当 present，而拖拽的基线还攥在 transientBase 里——松手时
  // commit 再把基线压回去，净效果是**白吃掉一级历史**，用户按一次 ⌘Z 反而多丢一步。
  const dragging = () => transientBase.current !== null
  const undo = useCallback(() => setHistory((h) => (h && !dragging() ? undoH(h) : h)), [])
  const redo = useCallback(() => setHistory((h) => (h && !dragging() ? redoH(h) : h)), [])

  const save = useCallback(async (explicit?: VideoSpec): Promise<boolean> => {
    const cur = explicit ?? historyRef.current?.present
    // 没有 spec 就没有可保存的东西。这里必须把「什么都没做」如实回给调用方——早先返回 void，
    // ⌘S 的 `.then()` 照样弹「已保存」，在「待出片」内容上就是一句假回执。
    if (!cur || !slug || !videoId) return false
    const body = JSON.stringify(cur)
    setSaving(true)
    try {
      const r = await fetch(`/api/projects/${slug}/specs/${videoId}`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body,
      })
      if (!r.ok) throw new Error(`${r.status}：${await r.text()}`)
      // 用发出去的那份（而不是重新序列化 present）当净快照：保存期间用户又改了的话，
      // 脏标记应当**继续亮着**，重新序列化会把那次改动误判成已保存。
      setSavedJson(body)
      return true
    } finally {
      setSaving(false)
    }
  }, [slug, videoId])

  const markSaved = useCallback((spec: VideoSpec) => setSavedJson(JSON.stringify(spec)), [])

  const resetToOrig = useCallback(async () => {
    if (!slug || !videoId) return
    const r = await fetch(`/api/projects/${slug}/specs/${videoId}/reset`, { method: 'POST' })
    if (r.status === 404) {
      // 同一个 404 有两种成因，**不能混**：真的没有 orig 快照（能力缺失 → 抛具名错，UI 永久隐藏
      // 重置菜单），还是项目/spec 找不到（故障 → 普通错误，弹提示但菜单要留着，否则一次网络抖动
      // 就把重置这条路对这条视频永久关掉了）。靠服务端文案区分：只有它说「快照」才是前者。
      const text = await r.text()
      if (text.includes('快照')) throw new NoOrigSnapshotError()
      throw new Error(`重置失败：${text}`)
    }
    if (!r.ok) throw new Error(`${r.status}：${await r.text()}`)
    const fresh = (await r.json()) as VideoSpec
    // 重置是「回到出厂」，历史从头开始：留着旧的 past 会让 Ctrl+Z 把用户拽回他刚放弃的那版。
    setHistory(init(fresh))
    setSavedJson(JSON.stringify(fresh))
  }, [slug, videoId])

  const previewSpec = useMemo(
    () => (spec && videoId ? rebaseSpecForPreview(spec, slug, videoId) : null),
    [spec, slug, videoId],
  )

  return {
    spec,
    loading,
    loadError,
    dirty: savedJson !== null && spec !== null && JSON.stringify(spec) !== savedJson,
    apply,
    applyTransient,
    commit,
    markSaved,
    undo,
    redo,
    canUndo: (history?.past.length ?? 0) > 0,
    canRedo: (history?.future.length ?? 0) > 0,
    saving,
    save,
    resetToOrig,
    hasOrig,
    previewSpec,
    busy,
    runExclusive,
  }
}
