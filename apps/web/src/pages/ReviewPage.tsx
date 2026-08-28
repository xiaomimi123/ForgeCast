import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { api, type Lead, type WeeklyReport } from '../api'

export default function ReviewPage({ onOpenTailor }: { onOpenTailor: (id: number) => void }) {
  const qc = useQueryClient()
  const report = useQuery({ queryKey: ['report'], queryFn: () => api<WeeklyReport>('/api/report') })
  const leads = useQuery({ queryKey: ['leads'], queryFn: () => api<Lead[]>('/api/leads') })

  const [perf, setPerf] = useState({ id: '', views: '', likes: '', leads: '' })
  const [lead, setLead] = useState({ id: '', wechat: '', intent: '' })

  async function submitPerf() {
    if (!perf.id) return alert('填素材 id')
    try {
      await api(`/api/assets/${perf.id}/perf`, { method: 'POST', body: JSON.stringify({ views: Number(perf.views) || 0, likes: Number(perf.likes) || 0, leads: Number(perf.leads) || 0 }) })
      setPerf({ id: '', views: '', likes: '', leads: '' }); qc.invalidateQueries({ queryKey: ['report'] })
    } catch (e) { alert(`录入失败: ${e instanceof Error ? e.message : String(e)}`) }
  }
  async function submitLead() {
    if (!lead.id) return alert('填素材 id')
    try {
      await api('/api/leads', { method: 'POST', body: JSON.stringify({ assetId: Number(lead.id), wechat: lead.wechat, intent: lead.intent }) })
      setLead({ id: '', wechat: '', intent: '' }); qc.invalidateQueries({ queryKey: ['leads'] }); qc.invalidateQueries({ queryKey: ['report'] })
    } catch (e) { alert(`登记失败: ${e instanceof Error ? e.message : String(e)}`) }
  }
  async function toTailor(leadId: number) {
    try {
      const r = await api<{ id: number }>(`/api/leads/${leadId}/to-tailor`, { method: 'POST', body: '{}' })
      onOpenTailor(r.id)
    } catch (e) { alert(`转入失败: ${e instanceof Error ? e.message : String(e)}`) }
  }

  const r = report.data
  const inp = 'rounded-md border-[1.5px] border-ink bg-card px-2 py-1 text-sm'
  return (
    <div className="grid grid-cols-[1fr_360px] gap-6">
      <div className="space-y-4">
        <div className="card-forge p-4">
          <div className="mb-2 font-semibold">周报（自 {r?.since ?? '—'}）</div>
          <table className="w-full text-sm">
            <thead className="text-left font-bold text-sub"><tr><th className="p-1">钩子</th><th className="p-1">发布</th><th className="p-1">询单</th></tr></thead>
            <tbody>
              {r && Object.entries(r.perHook).map(([h, s]) => <tr key={h} className="border-t border-hairline"><td className="p-1">{h}</td><td className="p-1">{s.published}</td><td className="p-1">{s.leads}</td></tr>)}
              {r && Object.keys(r.perHook).length === 0 && <tr><td colSpan={3} className="p-2 text-faint">暂无数据</td></tr>}
            </tbody>
            {r && <tfoot><tr className="border-t border-hairline font-medium"><td className="p-1">合计</td><td className="p-1">{r.totals.published}</td><td className="p-1">{r.totals.leads}</td></tr></tfoot>}
          </table>
        </div>
        <div className="card-forge p-4">
          <div className="mb-2 font-semibold">询单列表（{leads.data?.length ?? 0}）</div>
          <ul className="space-y-1 text-sm">
            {leads.data?.map((l) => <li key={l.id} className="border-t border-hairline py-1">[{l.hook ?? '—'}·{l.slug ?? '—'}] {l.wechat ?? '—'} · {l.intent ?? '—'} · {l.status} · {l.created_at}<button className="ml-2 rounded-md border-[1.5px] border-ink px-2 py-0.5 text-xs font-semibold" onClick={() => toTailor(l.id)}>转定制</button></li>)}
            {leads.data?.length === 0 && <li className="text-faint">暂无询单</li>}
          </ul>
        </div>
      </div>
      <div className="space-y-4">
        <div className="card-forge p-4 space-y-2">
          <div className="font-semibold">录入数据</div>
          <input className={`${inp} w-full`} placeholder="素材 id" value={perf.id} onChange={(e) => setPerf((p) => ({ ...p, id: e.target.value }))} />
          <div className="flex gap-2">
            <input className={`${inp} w-full`} placeholder="曝光" value={perf.views} onChange={(e) => setPerf((p) => ({ ...p, views: e.target.value }))} />
            <input className={`${inp} w-full`} placeholder="赞" value={perf.likes} onChange={(e) => setPerf((p) => ({ ...p, likes: e.target.value }))} />
            <input className={`${inp} w-full`} placeholder="询单" value={perf.leads} onChange={(e) => setPerf((p) => ({ ...p, leads: e.target.value }))} />
          </div>
          <button className="btn-fire w-full py-1.5 text-sm" onClick={submitPerf}>提交数据</button>
        </div>
        <div className="card-forge p-4 space-y-2">
          <div className="font-semibold">登记询单</div>
          <input className={`${inp} w-full`} placeholder="素材 id" value={lead.id} onChange={(e) => setLead((s) => ({ ...s, id: e.target.value }))} />
          <input className={`${inp} w-full`} placeholder="微信号" value={lead.wechat} onChange={(e) => setLead((s) => ({ ...s, wechat: e.target.value }))} />
          <input className={`${inp} w-full`} placeholder="意向" value={lead.intent} onChange={(e) => setLead((s) => ({ ...s, intent: e.target.value }))} />
          <button className="btn-fire w-full py-1.5 text-sm" onClick={submitLead}>登记</button>
        </div>
      </div>
    </div>
  )
}
