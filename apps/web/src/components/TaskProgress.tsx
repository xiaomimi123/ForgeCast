import type { TaskRun } from '../useTaskRun'

function fmt(sec: number): string {
  return sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m${String(sec % 60).padStart(2, '0')}s`
}

/** 长任务就地进度：紧跟触发按钮之后，显示「已用时长 · 最新一条进度」。
 *  没跑过也没消息时不渲染任何东西，保持页面初始状态干净。 */
export default function TaskProgress({ run, className = '' }: { run: TaskRun; className?: string }) {
  if (!run.running && !run.lastMessage) return null
  const tone = run.failed ? 'text-danger' : run.running ? 'text-sub' : 'text-faint'
  return (
    <span className={`inline-flex min-w-0 items-center gap-1.5 font-mono text-xs ${tone} ${className}`}>
      {run.running && <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-fire" />}
      <span className="shrink-0">{run.running ? '已用' : '用时'} {fmt(run.elapsedSec)}</span>
      <span className="truncate">· {run.lastMessage}</span>
    </span>
  )
}
