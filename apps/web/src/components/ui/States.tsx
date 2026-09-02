import type { ReactNode } from 'react'

/** 骨架占位：n 条脉动条，--fc-sunken 底。加载中占位用，不承载任何真实数据。 */
export function Skeleton({ lines = 3 }: { lines?: number }) {
  return (
    <div className="space-y-2" aria-hidden>
      {Array.from({ length: lines }).map((_, i) => (
        <div key={i} className="h-3.5 animate-pulse rounded-[var(--fc-r-xs)] bg-[var(--fc-sunken)]" style={{ width: i % 3 === 2 ? '60%' : '100%' }} />
      ))}
    </div>
  )
}

/** 空态：说明为什么空 + 给下一步能直接点的动作，不做纯文案空转。 */
export function Empty({ why, action }: { why: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-[var(--fc-r-sm)] border border-dashed border-[var(--fc-line-2)] px-4 py-8 text-center">
      <div className="text-sm text-[var(--fc-muted)]">{why}</div>
      {action}
    </div>
  )
}

/** 失败态：哪一步失败 + 报错原文 + 重试（实心红，本组件唯一允许的实心按钮）+ 折叠日志。 */
export function Failure({ step, error, onRetry }: { step: string; error: string; onRetry: () => void }) {
  return (
    <div className="space-y-2 rounded-[var(--fc-r-sm)] border border-[var(--fc-accent)] bg-[var(--fc-accent-tint)] px-4 py-3">
      <div className="text-sm font-medium text-[var(--fc-accent-deep)]">{step} 失败</div>
      <div className="flex items-center gap-2">
        <button
          className="rounded-[var(--fc-r-sm)] bg-[var(--fc-accent)] px-3 py-1 text-xs font-medium text-white hover:bg-[var(--fc-accent-deep)]"
          onClick={onRetry}
        >
          重试
        </button>
      </div>
      <details className="text-xs text-[var(--fc-muted)]">
        <summary className="cursor-pointer select-none">查看日志</summary>
        <pre className="mt-1 whitespace-pre-wrap break-all rounded-[var(--fc-r-xs)] bg-[var(--fc-surface-2)] p-2 text-[var(--fc-ink)]">{error}</pre>
      </details>
    </div>
  )
}
