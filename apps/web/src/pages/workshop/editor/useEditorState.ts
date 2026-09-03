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
  undo(): void
  redo(): void
  canUndo: boolean
  canRedo: boolean
  saving: boolean
  save(): Promise<void>
  resetToOrig(): Promise<void>
  previewSpec: VideoSpec | null
  reload(): void
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
export function useEditorState(slug: string, videoId: string | null): EditorState {
  const [history, setHistory] = useState<History | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  // 最后一次与磁盘一致的序列化快照。null＝还没载入。
  const [savedJson, setSavedJson] = useState<string | null>(null)
  const [reloadTick, setReloadTick] = useState(0)
  // save() 被键盘快捷键调用时闭包会捕获旧的 history；用 ref 取「此刻」的 present。
  const historyRef = useRef<History | null>(null)
  historyRef.current = history

  useEffect(() => {
    setHistory(null)
    setSavedJson(null)
    setLoadError(null)
    if (!slug || !videoId) { setLoading(false); return }
    setLoading(true)
    let alive = true
    fetch(`/api/projects/${slug}/specs/${videoId}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}：${await r.text()}`)
        return r.json() as Promise<VideoSpec>
      })
      .then((spec) => {
        if (!alive) return
        setHistory(init(spec))
        setSavedJson(JSON.stringify(spec))
        setLoading(false)
      })
      .catch((e) => {
        if (!alive) return
        setLoadError(`素材包读取失败：${e instanceof Error ? e.message : String(e)}`)
        setLoading(false)
      })
    return () => { alive = false }
  }, [slug, videoId, reloadTick])

  const spec = history?.present ?? null

  const apply = useCallback((next: VideoSpec) => {
    setHistory((h) => (h ? push(h, next) : h))
  }, [])
  const undo = useCallback(() => setHistory((h) => (h ? undoH(h) : h)), [])
  const redo = useCallback(() => setHistory((h) => (h ? redoH(h) : h)), [])

  const save = useCallback(async () => {
    const cur = historyRef.current?.present
    if (!cur || !slug || !videoId) return
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
    } finally {
      setSaving(false)
    }
  }, [slug, videoId])

  const resetToOrig = useCallback(async () => {
    if (!slug || !videoId) return
    const r = await fetch(`/api/projects/${slug}/specs/${videoId}/reset`, { method: 'POST' })
    if (r.status === 404) {
      // 项目不存在也会 404。两者都让「重置」这条路走不通，文案取服务端原文更准。
      const text = await r.text()
      throw new NoOrigSnapshotError(text.includes('快照') ? '这条视频没有生成快照（生成于旧版本），无法重置' : `重置失败：${text}`)
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
    undo,
    redo,
    canUndo: (history?.past.length ?? 0) > 0,
    canRedo: (history?.future.length ?? 0) > 0,
    saving,
    save,
    resetToOrig,
    previewSpec,
    reload: useCallback(() => setReloadTick((t) => t + 1), []),
  }
}
