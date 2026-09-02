import { useEffect, useRef, useState } from 'react'
import { HOOK_LABEL, STATUS_LABEL, type ContentItemView } from '../api'

/** StatusTag：高 20，Mono 10，永远不可点（span 非 button）。五态样式见 docs/剪辑台-实施说明.md §5。 */
function StatusTag({ status, progress }: { status: ContentItemView['status']; progress: number | null }) {
  const base = 'inline-flex h-5 shrink-0 items-center gap-1 whitespace-nowrap rounded-[var(--fc-r-xs)] px-1.5 font-mono text-[10px]'
  if (status === 'approved') {
    return <span className={`${base} bg-[var(--fc-ink)] text-white`}>✓ {STATUS_LABEL[status]}</span>
  }
  if (status === 'failed') {
    return <span className={`${base} bg-[var(--fc-accent)] text-white`}>{STATUS_LABEL[status]}</span>
  }
  if (status === 'rendering' || status === 'review') {
    const label = status === 'rendering' && progress != null ? `${STATUS_LABEL[status]} ${progress}%` : STATUS_LABEL[status]
    return (
      <span className={`${base} border border-[var(--fc-accent)] bg-[var(--fc-accent-tint)] text-[var(--fc-accent-deep)]`}>
        {status === 'rendering' && <span className="inline-block h-1.5 w-1.5 animate-spin rounded-full border border-[var(--fc-accent)] border-t-transparent" />}
        {label}
      </span>
    )
  }
  // script_ready
  return <span className={`${base} border border-[var(--fc-line-2)] text-[var(--fc-muted)]`}>{STATUS_LABEL[status]}</span>
}

/** 状态点 6×6：跟随 StatusTag 的语义色，出现在行1编号/钩子之后。 */
function StatusDot({ status }: { status: ContentItemView['status'] }) {
  const color =
    status === 'approved' ? 'var(--fc-ink)'
      : status === 'failed' ? 'var(--fc-accent)'
        : status === 'rendering' || status === 'review' ? 'var(--fc-accent)'
          : 'var(--fc-line-2)'
  return <span className="inline-block h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: color }} />
}

/**
 * 左栏队列行（QueueRow，见实施说明 §5）：高 71，缩略图 31×55，四态（default/hover/selected/done）。
 * 卡上不出现裸删除按钮——唯一入口是右上「⋯」菜单，二次确认后回调 onDelete。
 * P0 无消费方，不传 onApprove（通过动作在成片库，见 task-5 brief）。
 */
export default function ContentCard({
  item, selected, onOpen, onDelete,
}: {
  item: ContentItemView
  selected: boolean
  onOpen: (item: ContentItemView) => void
  onDelete: (item: ContentItemView) => void
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!menuOpen) return
    const h = (e: MouseEvent) => { if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false) }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [menuOpen])

  const done = item.status === 'approved'
  const hookLabel = item.hook ? (HOOK_LABEL[item.hook] ?? item.hook) : '—'

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onOpen(item)}
      onKeyDown={(e) => { if (e.key === 'Enter') onOpen(item) }}
      className="relative flex cursor-pointer items-start gap-2.5 border-l-[3px] py-[7px] pl-2.5 pr-8 transition-colors"
      style={{
        height: 71,
        boxSizing: 'border-box',
        background: selected ? 'var(--fc-accent-tint)' : 'transparent',
        borderLeftColor: selected ? 'var(--fc-accent)' : 'transparent',
        opacity: done ? 0.62 : 1,
      }}
      onMouseEnter={(e) => { if (!selected) e.currentTarget.style.background = '#F5F6F1' }}
      onMouseLeave={(e) => { if (!selected) e.currentTarget.style.background = 'transparent' }}
    >
      {/* 缩略图 31×55，9:16，无图占位 --fc-sunken */}
      <div className="shrink-0 overflow-hidden rounded-[var(--fc-r-xs)] bg-[var(--fc-sunken)]" style={{ width: 31, height: 55 }}>
        {item.cover?.url && <img src={item.cover.url} alt="" className="h-full w-full object-cover" />}
      </div>

      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex items-center gap-1.5">
          <span className="font-mono text-[11px] font-bold text-[var(--fc-ink)]">#{item.seq}</span>
          <span className="font-mono text-[10px] text-[var(--fc-muted)]">{hookLabel}</span>
          <StatusDot status={item.status} />
        </div>
        <div className="truncate text-[12.5px] text-[var(--fc-ink)]" style={{ lineHeight: 1.45 }}>{item.title}</div>
        <div className="flex items-center gap-1.5 font-mono text-[10px] text-[var(--fc-faint)]">
          {item.render && <span>v{item.render.version}</span>}
          <StatusTag status={item.status} progress={item.progress} />
        </div>
      </div>

      {/* 右上「⋯」菜单：唯一项「删除」，卡上不出现裸删除按钮 */}
      <div ref={menuRef} className="absolute right-1 top-1">
        <button
          type="button"
          className="flex h-5 w-5 items-center justify-center rounded-[var(--fc-r-xs)] text-[var(--fc-muted)] hover:bg-[var(--fc-line-3)]"
          onClick={(e) => { e.stopPropagation(); setMenuOpen((v) => !v) }}
          aria-label="更多操作"
        >
          ⋯
        </button>
        {menuOpen && (
          <div
            className="absolute right-0 top-6 z-10 min-w-[88px] rounded-[var(--fc-r-sm)] border border-[var(--fc-line-2)] bg-[var(--fc-surface-2)] py-1 shadow-md"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              className="block w-full px-3 py-1.5 text-left text-xs text-[var(--fc-accent)] hover:bg-[var(--fc-accent-tint)]"
              onClick={() => {
                setMenuOpen(false)
                if (window.confirm('删除这条内容及其封面/视频素材？不可恢复')) onDelete(item)
              }}
            >
              删除
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
