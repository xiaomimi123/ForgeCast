import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'

export interface ConfirmOpts {
  title: string
  body?: string
  okLabel?: string
  /** 危险操作（删除类）：确认钮实心 accent 而非实心 ink。 */
  danger?: boolean
}

export interface Confirm3Opts {
  title: string
  body?: string
}

type Pending =
  | { kind: 'simple'; opts: ConfirmOpts; resolve: (v: boolean) => void }
  | { kind: 'triple'; opts: Confirm3Opts; resolve: (v: 'save' | 'discard' | 'cancel') => void }

/**
 * Promise 化的 in-app 确认模态，替代原生 `confirm()`。
 *
 * 同一 hook 实例同一时刻只允许一个未决弹层——**选的是直接拒绝而不是排队**：排队实现要维护
 * 一个等待队列、且用户在前一个弹层还开着时点出第二个请求，大概率是误触或竞态调用，
 * 排队会让这第二次请求在用户没意识到的情况下之后突然弹出来，比直接 `resolve(false)`
 * （相当于「当前状态下不能进行第二个操作，视为取消」）更容易让人困惑。调用方必须自己保证
 * 不会在弹层开着时发起第二次 confirm（正常 UI 下菜单/按钮在弹层开着时也点不到）。
 */
export function useConfirm(): {
  confirm: (opts: ConfirmOpts) => Promise<boolean>
  confirm3: (opts: Confirm3Opts) => Promise<'save' | 'discard' | 'cancel'>
  element: ReactNode
} {
  const [pending, setPending] = useState<Pending | null>(null)
  const okRef = useRef<HTMLButtonElement>(null)
  const pendingRef = useRef<Pending | null>(null)
  pendingRef.current = pending

  const confirm = useCallback((opts: ConfirmOpts) => new Promise<boolean>((resolve) => {
    setPending((prev) => {
      if (prev) { resolve(false); return prev }
      return { kind: 'simple', opts, resolve }
    })
  }), [])

  const confirm3 = useCallback((opts: Confirm3Opts) => new Promise<'save' | 'discard' | 'cancel'>((resolve) => {
    setPending((prev) => {
      if (prev) { resolve('cancel'); return prev }
      return { kind: 'triple', opts, resolve }
    })
  }), [])

  function settle(result: boolean | 'save' | 'discard' | 'cancel') {
    setPending((prev) => {
      if (!prev) return prev
      if (prev.kind === 'simple') prev.resolve(result as boolean)
      else prev.resolve(result as 'save' | 'discard' | 'cancel')
      return null
    })
  }

  // 弹出时把焦点圈进弹层：只做初始聚焦确认钮，不做完整 focus trap（Tab 仍可能跑出去，
  // 但 Esc/Enter 两条键盘路径已经覆盖了绝大多数操作，够用）。
  useEffect(() => {
    if (!pending) return
    const p = pending
    okRef.current?.focus()
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault()
        settle(p.kind === 'simple' ? false : 'cancel')
      } else if (e.key === 'Enter') {
        e.preventDefault()
        settle(p.kind === 'simple' ? true : 'save')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending])

  // 卸载兜底：调用方（比如切页）在弹层未决时把这个组件树卸载掉，若不在这里 resolve，
  // 挂在外面的 `await confirm(...)` 就永远悬挂。用 ref 拿卸载那一刻的最新 pending
  // （不能直接依赖闭包里的 pending——effect 只在挂载/卸载时跑一次）。
  useEffect(() => () => {
    const p = pendingRef.current
    if (!p) return
    if (p.kind === 'simple') p.resolve(false)
    else p.resolve('cancel')
  }, [])

  const element = pending ? (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center"
      style={{ background: 'rgba(24,26,22,0.45)' }}
      // stopPropagation：`element` 常年挂在调用方组件树里（比如卡片根节点自带
      // onClick=打开），遮罩点击若冒泡出去会顺带触发宿主的点击处理——这里必须在遮罩自己
      // 这层截断，不能指望只在弹层内部（dialog 那层）截。
      onClick={(e) => { e.stopPropagation(); settle(pending.kind === 'simple' ? false : 'cancel') }}
    >
      <div
        className="w-[360px] rounded-[var(--fc-r-sm)] bg-[var(--fc-surface)] p-4 shadow-xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="text-sm font-bold text-[var(--fc-ink)]">{pending.opts.title}</div>
        {pending.opts.body && (
          <div className="mt-1.5 whitespace-pre-wrap text-[12.5px] leading-relaxed text-[var(--fc-muted)]">
            {pending.opts.body}
          </div>
        )}
        <div className="mt-4 flex justify-end gap-2">
          {pending.kind === 'simple' ? (
            <>
              <button
                className="h-[30px] rounded-[var(--fc-r-sm)] border border-[var(--fc-line-2)] px-3 text-xs font-medium text-[var(--fc-ink)] hover:bg-[var(--fc-line-3)]"
                onClick={() => settle(false)}
              >取消</button>
              <button
                ref={okRef}
                className={pending.opts.danger
                  ? 'h-[30px] rounded-[var(--fc-r-sm)] bg-[var(--fc-accent)] px-3 text-xs font-medium text-white hover:bg-[var(--fc-accent-deep)]'
                  : 'h-[30px] rounded-[var(--fc-r-sm)] bg-[var(--fc-ink)] px-3 text-xs font-medium text-white hover:bg-[var(--fc-ink-2)]'}
                onClick={() => settle(true)}
              >{pending.opts.okLabel ?? '确定'}</button>
            </>
          ) : (
            <>
              <button
                className="h-[30px] rounded-[var(--fc-r-sm)] border border-[var(--fc-line-2)] px-3 text-xs font-medium text-[var(--fc-ink)] hover:bg-[var(--fc-line-3)]"
                onClick={() => settle('cancel')}
              >取消</button>
              <button
                className="h-[30px] rounded-[var(--fc-r-sm)] border border-[var(--fc-accent)] px-3 text-xs font-medium text-[var(--fc-accent)] hover:bg-[var(--fc-accent-tint)]"
                onClick={() => settle('discard')}
              >丢弃改动</button>
              <button
                ref={okRef}
                className="h-[30px] rounded-[var(--fc-r-sm)] bg-[var(--fc-ink)] px-3 text-xs font-medium text-white hover:bg-[var(--fc-ink-2)]"
                onClick={() => settle('save')}
              >保存并继续</button>
            </>
          )}
        </div>
      </div>
    </div>
  ) : null

  return { confirm, confirm3, element }
}
