import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { api, type CalendarView } from '../api'

export default function CalendarPage() {
  const qc = useQueryClient()
  const [platform, setPlatform] = useState<Record<number, string>>({})
  const cal = useQuery({ queryKey: ['calendar'], queryFn: () => api<CalendarView>('/api/calendar') })

  async function publish(assetId: number) {
    try {
      await api(`/api/assets/${assetId}/publish`, { method: 'POST', body: JSON.stringify({ platform: platform[assetId] ?? 'xhs' }) })
      qc.invalidateQueries({ queryKey: ['calendar'] })
    } catch (e) { alert(`标记失败: ${e instanceof Error ? e.message : String(e)}`) }
  }

  const v = cal.data
  if (!v) return <div className="text-faint">加载中…</div>
  return (
    <div className="space-y-4 max-w-3xl">
      <div className="card-forge p-4">
        <div className="text-lg font-semibold">{v.date}</div>
        <div className="mt-1 text-sm text-sub">今日已发 {v.publishedToday}，还可发 <span className="font-medium text-fire">{v.remainingToday}</span></div>
        <div className="mt-2 text-xs text-sub">库存: {Object.entries(v.inventory).map(([h, n]) => `${h}:${n}`).join('  ') || '（空）'}</div>
        <div className="text-xs text-sub">冷却中: {Object.entries(v.cooldown).map(([h, d]) => `${h}(${d}天)`).join('  ') || '（无）'}</div>
        <div className="mt-1 text-xs text-sub">配比(近7天): 演示 {v.mix.demo}／收入 {v.mix.income}／过程 {v.mix.process}（目标 60/20/20）</div>
        {v.gaps.length > 0 && (
          <ul className="mt-2 space-y-1">
            {v.gaps.map((g, i) => <li key={i} className="text-xs text-amber-700">⚠ {g}</li>)}
          </ul>
        )}
      </div>
      <div className="card-forge p-4">
        <div className="mb-2 font-semibold">今日建议发布</div>
        {v.suggestions.length === 0 && <div className="text-sm text-faint">今日额度用尽或无可发库存</div>}
        <ul className="space-y-2">
          {v.suggestions.map((s) => (
            <li key={s.assetId} className="flex items-center gap-3 rounded-lg border-[1.5px] border-ink bg-card p-2 text-sm shadow-[2px_2px_0_rgba(28,23,18,0.85)]">
              <span className="rounded bg-fire-soft px-2 py-0.5 text-fire">{s.hook}</span>
              <span className="flex-1 text-sub">素材 {s.assetId} — {s.reason}</span>
              <select className="rounded-md border-[1.5px] border-ink bg-card px-1 py-0.5 text-xs" value={platform[s.assetId] ?? 'xhs'} onChange={(e) => setPlatform((p) => ({ ...p, [s.assetId]: e.target.value }))}>
                <option value="xhs">小红书</option>
                <option value="douyin">抖音</option>
              </select>
              <button className="btn-fire px-2 py-1 text-xs" onClick={() => publish(s.assetId)}>标记已发布</button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
