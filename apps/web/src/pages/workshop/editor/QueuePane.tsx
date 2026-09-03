import { type UseQueryResult } from '@tanstack/react-query'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { type ContentItemView } from '../../../api'
import ContentCard from '../../../components/ContentCard'
import TaskProgress from '../../../components/TaskProgress'
import { Empty, Failure, Skeleton } from '../../../components/ui/States'
import type { TaskRun } from '../../../useTaskRun'
import { OUTLINE, SOLID } from './EditorPage'

/** 钩子枚举（旧「文案」tab 生成面板常量，正式迁到左栏——生成 popover 与筛选 chip 组共用）。 */
export const HOOKS = [
  { value: 'pain', label: '行业痛点型' },
  { value: 'sideline', label: '副业型' },
  { value: 'infogap', label: '信息差型' },
  { value: 'story', label: '接单故事型' },
]

/**
 * 左栏队列列（QueuePane，实施说明 §4）：工具条 42 / 钩子筛选 40 / 列表 1fr（overflow-y auto）。
 *
 * - 工具条左「+ 新内容」开一个内联生成 popover（钩子四选 + 篇数 + 生成，P0 生成面板原样迁入）。
 * - 钩子筛选只筛**本地显示**，不影响生成用的 `hook`/`setHook`（那是给下一次生成选钩子，两者语义不同）。
 * - 卡片选中走调用方传入的 `onSelectItem`——真正的 dirty 闸判断在 EditorPage 的 `selectItemGuarded`，
 *   本组件不重复实现，避免出现「切换绕过未保存确认」的第二条路径。
 */
export default function QueuePane({
  selected, hook, setHook, n, setN, busy, copyRun, onGenerate,
  items, selectedItemId, onSelectItem, onDeleteItem, onMakeVideo,
}: {
  selected: string
  hook: string
  setHook: (v: string) => void
  n: number
  setN: (v: number) => void
  busy: boolean
  copyRun: TaskRun
  onGenerate: () => void
  items: UseQueryResult<ContentItemView[]>
  selectedItemId: number | null
  /** 队列点选回调——调用方须走未保存改动闸门（见 EditorPage.selectItemGuarded），本组件只透传。 */
  onSelectItem: (item: ContentItemView) => void
  onDeleteItem: (item: ContentItemView) => void
  /** 失败卡片「重试」用：重新入队渲染 */
  onMakeVideo: (assetId: number) => void
}) {
  const [genOpen, setGenOpen] = useState(false)
  const genRef = useRef<HTMLDivElement>(null)
  const [filterHook, setFilterHook] = useState<string>('all')

  // popover 外点关闭，写法与 ContentCard「⋯」一致：mousedown 而非 click，避免第一下只关面板
  useEffect(() => {
    if (!genOpen) return
    function onDown(e: MouseEvent) {
      if (!genRef.current?.contains(e.target as Node)) setGenOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [genOpen])

  // 生成一旦真正入队（running 转 true）就收起面板——新卡稍后出现在列表里，不需要面板占着位置
  useEffect(() => { if (copyRun.running) setGenOpen(false) }, [copyRun.running])

  const list = items.data ?? []
  const filtered = filterHook === 'all' ? list : list.filter((i) => i.hook === filterHook)

  return (
    <section
      className="flex min-h-0 flex-col overflow-hidden rounded-[var(--fc-r-md)] border border-[var(--fc-line)] bg-[var(--fc-surface)]"
      style={{ boxSizing: 'border-box' }}
    >
      {/* 工具条 42 */}
      <div className="relative flex h-[42px] shrink-0 items-center gap-2 border-b border-[var(--fc-line)] px-2.5" ref={genRef}>
        <button type="button" className={OUTLINE} disabled={!selected || busy} onClick={() => setGenOpen((v) => !v)}>
          + 新内容
        </button>
        <span className="ml-auto font-mono text-[10px] text-[var(--fc-faint)]">{list.length}</span>

        {genOpen && (
          <div className="absolute left-2.5 top-[46px] z-20 w-64 space-y-2 rounded-[var(--fc-r-sm)] border border-[var(--fc-line-2)] bg-[var(--fc-surface-2)] p-3 shadow-lg">
            <div>
              <label className="text-xs text-[var(--fc-muted)]">钩子类型</label>
              <div className="mt-1 grid grid-cols-2 gap-1.5">
                {HOOKS.map((h) => (
                  <button
                    key={h.value}
                    type="button"
                    className={`rounded-[var(--fc-r-xs)] border px-2 py-1 text-xs ${hook === h.value ? 'border-[var(--fc-accent)] bg-[var(--fc-accent-tint)] font-bold text-[var(--fc-accent-deep)]' : 'border-[var(--fc-line-2)] bg-transparent text-[var(--fc-muted)]'}`}
                    onClick={() => setHook(h.value)}
                  >
                    {h.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <label className="text-xs text-[var(--fc-muted)]">篇数</label>
              <input
                type="number" min={1} max={5}
                className="h-7 w-16 rounded-[var(--fc-r-sm)] border border-[var(--fc-line-2)] bg-[var(--fc-surface)] px-2 text-sm"
                value={n} onChange={(e) => setN(Number(e.target.value))}
              />
              {/* popover 打开时视作当前主操作面：这一个「生成」可以实心，见实施说明 §7 与 task-7-brief */}
              <button type="button" className={`ml-auto ${SOLID}`} disabled={!selected || busy} onClick={onGenerate}>
                {copyRun.running ? '生成中…' : '生成'}
              </button>
            </div>
            <TaskProgress run={copyRun} />
          </div>
        )}
      </div>

      {/* 钩子筛选 40：chip 组，筛 item.hook（本地展示筛选，与上面生成用的 hook 无关） */}
      <div className="flex h-10 shrink-0 items-center gap-1.5 overflow-x-auto border-b border-[var(--fc-line)] px-2.5">
        <FilterChip active={filterHook === 'all'} onClick={() => setFilterHook('all')}>全部</FilterChip>
        {HOOKS.map((h) => (
          <FilterChip key={h.value} active={filterHook === h.value} onClick={() => setFilterHook(h.value)}>
            {h.label.replace(/型$/, '')}
          </FilterChip>
        ))}
      </div>

      {/* 列表 1fr，overflow-y auto，行间 1px 分隔线 */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {items.isLoading && <div className="p-2"><Skeleton lines={4} /></div>}
        {items.isError && (
          <div className="p-2">
            <Failure step="载入内容列表" error={items.error instanceof Error ? items.error.message : String(items.error)} onRetry={() => items.refetch()} />
          </div>
        )}
        {!items.isLoading && !items.isError && list.length === 0 && (
          <div className="p-2">
            <Empty why="这个项目还没有内容" action={
              <button type="button" className={OUTLINE} disabled={!selected || busy} onClick={() => setGenOpen(true)}>
                + 新内容
              </button>
            } />
          </div>
        )}
        {!items.isLoading && !items.isError && list.length > 0 && filtered.length === 0 && (
          <div className="p-3 text-center text-xs text-[var(--fc-faint)]">这个钩子还没有内容</div>
        )}
        {filtered.map((item) => (
          <div key={item.id} className="border-b border-[var(--fc-line)] last:border-b-0">
            <ContentCard item={item} selected={item.id === selectedItemId} onOpen={onSelectItem} onDelete={onDeleteItem} />
            {item.status === 'failed' && (
              <div className="px-2.5 pb-2">
                <Failure step="渲染" error={item.error ?? ''} onRetry={() => onMakeVideo(item.copyAssetId)} />
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  )
}

/** 钩子筛选 chip：高 22 / 1px 边 / 选中 accent 态（实施说明 §5 Button chip 级）。 */
function FilterChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`h-[22px] shrink-0 whitespace-nowrap rounded-[var(--fc-r-xs)] border px-2 text-[11px] transition-colors ${
        active
          ? 'border-[var(--fc-accent)] bg-[var(--fc-accent-tint)] font-medium text-[var(--fc-accent-deep)]'
          : 'border-[var(--fc-line)] text-[var(--fc-muted)] hover:border-[var(--fc-line-2)]'
      }`}
    >
      {children}
    </button>
  )
}
