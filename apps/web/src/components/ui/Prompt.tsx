import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'

export interface PromptOpts {
  title: string
  body?: string
  /** 输入框上方的标签，缺省「名称」。 */
  label?: string
  placeholder?: string
  /** 输入框初值。 */
  defaultValue?: string
  /** 给了就多一个勾选框（如「含位置」）；`checkbox.defaultChecked` 是初值。 */
  checkbox?: { label: string; hint?: string; defaultChecked?: boolean }
  okLabel?: string
}

export interface PromptResult { name: string; checked: boolean }

/**
 * Promise 化的 in-app 输入模态——`window.prompt` 的替代。与 `useConfirm` 同一套姿势
 * （遮罩点掉 = 取消、Esc 取消、Enter 确认、卸载兜底 resolve(null)、同时刻只允许一个未决弹层），
 * 只是多了一个文本输入 + 一个可选勾选框。取消返回 `null`。
 *
 * 「名字为空就不让确认」的校验放在这里而不是调用方：三处调用（存样式预设 / 存版式 / 未来的重命名）
 * 都要这一条，写在弹层里省得各写一遍、也省得让一次空名请求白跑到服务端换个 400 回来。
 */
export function usePrompt(): {
  prompt: (opts: PromptOpts) => Promise<PromptResult | null>
  element: ReactNode
  open: boolean
} {
  const [pending, setPending] = useState<{ opts: PromptOpts; resolve: (v: PromptResult | null) => void } | null>(null)
  const [name, setName] = useState('')
  const [checked, setChecked] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const pendingRef = useRef<typeof pending>(null)
  pendingRef.current = pending
  // settle 要读最新的 name/checked，但键盘 handler 的 effect 只在 pending 变化时重挂——
  // 用 ref 取值，否则 Enter 提交拿到的永远是弹层刚打开那一刻的空串。
  const valueRef = useRef({ name: '', checked: false })
  valueRef.current = { name, checked }

  const prompt = useCallback((opts: PromptOpts) => new Promise<PromptResult | null>((resolve) => {
    setPending((prev) => {
      if (prev) { resolve(null); return prev }
      setName(opts.defaultValue ?? '')
      setChecked(opts.checkbox?.defaultChecked ?? false)
      return { opts, resolve }
    })
  }), [])

  const settle = useCallback((v: PromptResult | null) => {
    setPending((prev) => { prev?.resolve(v); return null })
  }, [])

  useEffect(() => {
    if (!pending) return
    inputRef.current?.focus()
    inputRef.current?.select()
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') { e.preventDefault(); settle(null) }
      else if (e.key === 'Enter') {
        e.preventDefault()
        const { name: n, checked: c } = valueRef.current
        if (n.trim()) settle({ name: n.trim(), checked: c })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [pending, settle])

  // 卸载兜底：调用方在弹层未决时被卸载（切页），不 resolve 的话外面的 await 永远悬挂。
  useEffect(() => () => { pendingRef.current?.resolve(null) }, [])

  const element = pending ? (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center"
      style={{ background: 'rgba(24,26,22,0.45)' }}
      onClick={(e) => { e.stopPropagation(); settle(null) }}
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
        <label className="mt-3 block text-[11px] text-[var(--fc-muted)]">{pending.opts.label ?? '名称'}</label>
        <input
          ref={inputRef}
          className="mt-1 h-[30px] w-full rounded-[var(--fc-r-sm)] border border-[var(--fc-line-2)] bg-[var(--fc-surface-2)] px-2 text-xs text-[var(--fc-ink)]"
          value={name}
          placeholder={pending.opts.placeholder}
          onChange={(e) => setName(e.target.value)}
        />
        {pending.opts.checkbox && (
          <label className="mt-2 flex items-center gap-1.5 text-[11px] text-[var(--fc-muted)]" title={pending.opts.checkbox.hint}>
            <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
            {pending.opts.checkbox.label}
          </label>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <button
            className="h-[30px] rounded-[var(--fc-r-sm)] border border-[var(--fc-line-2)] px-3 text-xs font-medium text-[var(--fc-ink)] hover:bg-[var(--fc-line-3)]"
            onClick={() => settle(null)}
          >取消</button>
          <button
            className="h-[30px] rounded-[var(--fc-r-sm)] bg-[var(--fc-ink)] px-3 text-xs font-medium text-white hover:bg-[var(--fc-ink-2)] disabled:bg-[var(--fc-line)] disabled:text-[var(--fc-faint)]"
            disabled={!name.trim()}
            onClick={() => settle({ name: name.trim(), checked })}
          >{pending.opts.okLabel ?? '保存'}</button>
        </div>
      </div>
    </div>
  ) : null

  return { prompt, element, open: pending !== null }
}
