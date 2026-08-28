import { useQuery } from '@tanstack/react-query'
import { api, type WeeklyReport } from './api'

const P0_TARGET_DAYS = 14
const P0_TARGET_LEADS = 5

function since14dAgo(): string {
  const d = new Date(Date.now() - P0_TARGET_DAYS * 86400_000)
  return d.toISOString().slice(0, 10)
}

/** 顶栏：品牌 + P0 状态条（近14天已发/询单，纯展示，不做达标判定业务逻辑）+ 设置/选题库入口 */
export default function Topbar({ onOpenSettings, onOpenTopics }: { onOpenSettings: () => void; onOpenTopics: () => void }) {
  const report = useQuery({ queryKey: ['report', 'p0'], queryFn: () => api<WeeklyReport>(`/api/report?since=${since14dAgo()}`) })
  const published = report.data?.totals.published ?? 0
  const leads = report.data?.totals.leads ?? 0

  return (
    <header className="flex items-baseline gap-3.5 px-7 pt-4">
      <div className="text-[1.35rem] font-black tracking-tight" style={{ fontFamily: '"Noto Serif SC", serif' }}>
        Forge<span className="text-fire">Cast</span>
        <span className="ml-2 text-sm font-normal text-faint">生产控制台</span>
      </div>
      <div className="flex-1" />
      <div className="text-[0.72rem] text-fire border border-fire rounded-[2px] bg-fire-soft px-2.5 py-0.5" style={{ fontFamily: '"JetBrains Mono", monospace' }}>
        近{P0_TARGET_DAYS}天已发 {published} 条 · 询单 {leads}/{P0_TARGET_LEADS}
      </div>
      <button className="btn-ink px-3 py-1 text-sm" onClick={onOpenTopics} title="选题库">📋 选题库</button>
      <button className="btn-ink px-3 py-1 text-sm" onClick={onOpenSettings} title="设置">⚙️ 设置</button>
    </header>
  )
}
