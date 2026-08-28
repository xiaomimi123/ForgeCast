import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { api, type TailorRequest } from '../api'

const STATUS_LABEL: Record<TailorRequest['status'], string> = {
  draft: '待拆解', decomposed: '已拆解', searched: '已搜轮子', proposed: '已出方案',
}

export default function TailorPage({ onOpenTailor }: { onOpenTailor: (id: number) => void }) {
  const qc = useQueryClient()
  const list = useQuery({ queryKey: ['tailor'], queryFn: () => api<TailorRequest[]>('/api/tailor') })
  const [form, setForm] = useState({ title: '', rawNeed: '' })
  const create = useMutation({
    mutationFn: () => api<{ id: number }>('/api/tailor', { method: 'POST', body: JSON.stringify(form) }),
    onSuccess: (r) => { qc.invalidateQueries({ queryKey: ['tailor'] }); onOpenTailor(r.id) },
    onError: (e) => alert(`录入失败: ${e instanceof Error ? e.message : String(e)}`),
  })
  const inp = 'rounded-md border-[1.5px] border-ink bg-card px-2 py-1 text-sm w-full'
  return (
    <div className="grid grid-cols-[1fr_360px] gap-6">
      <div className="space-y-3">
        {list.data?.map((r) => (
          <div key={r.id} onClick={() => onOpenTailor(r.id)}
            className="card-forge cursor-pointer p-4 hover:shadow-[3px_3px_0_rgba(217,72,28,0.9)]">
            <div className="flex items-center justify-between">
              <div className="font-medium">#{r.id} {r.title}</div>
              <span className="rounded border-[1.5px] border-ink px-2 py-0.5 text-[10px] font-extrabold tracking-widest">{STATUS_LABEL[r.status]}</span>
            </div>
            <div className="mt-1 line-clamp-2 text-sm text-sub">{r.raw_need}</div>
            <div className="mt-1 text-xs text-faint">{r.created_at}{r.lead_id ? ` · 来自询单#${r.lead_id}` : ''}</div>
          </div>
        ))}
        {list.data?.length === 0 && (
          <div className="rounded-lg border-2 border-dashed border-hairline p-6 text-center text-faint">
            暂无定制需求：右侧录入，或在「分发营销 → 数据复盘」把询单一键转过来
          </div>
        )}
      </div>
      <div className="self-start space-y-2 card-forge p-4">
        <div className="font-semibold">录入客户需求</div>
        <input className={inp} placeholder="标题（如：宠物店会员小程序）" value={form.title}
          onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))} />
        <textarea className={`${inp} h-40`} placeholder="粘贴客户原始需求描述…" value={form.rawNeed}
          onChange={(e) => setForm((f) => ({ ...f, rawNeed: e.target.value }))} />
        <button className="btn-fire w-full py-1.5 text-sm disabled:opacity-50"
          disabled={create.isPending || !form.title.trim() || !form.rawNeed.trim()} onClick={() => create.mutate()}>
          {create.isPending ? '录入中…' : '录入需求'}
        </button>
      </div>
    </div>
  )
}
