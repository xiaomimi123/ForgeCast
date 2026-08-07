import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, type TailorRequest } from '../api'

const STATUS_LABEL: Record<TailorRequest['status'], string> = {
  draft: '待拆解', decomposed: '已拆解', searched: '已搜轮子', proposed: '已出方案',
}

export default function TailorPage() {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const list = useQuery({ queryKey: ['tailor'], queryFn: () => api<TailorRequest[]>('/api/tailor') })
  const [form, setForm] = useState({ title: '', rawNeed: '' })
  const create = useMutation({
    mutationFn: () => api<{ id: number }>('/api/tailor', { method: 'POST', body: JSON.stringify(form) }),
    onSuccess: (r) => { qc.invalidateQueries({ queryKey: ['tailor'] }); navigate(`/tailor/${r.id}`) },
    onError: (e) => alert(`录入失败: ${e instanceof Error ? e.message : String(e)}`),
  })
  const inp = 'rounded border px-2 py-1 text-sm w-full'
  return (
    <div className="grid grid-cols-[1fr_360px] gap-6">
      <div className="space-y-3">
        {list.data?.map((r) => (
          <div key={r.id} onClick={() => navigate(`/tailor/${r.id}`)}
            className="cursor-pointer rounded-lg border bg-white p-4 hover:border-blue-400">
            <div className="flex items-center justify-between">
              <div className="font-medium">#{r.id} {r.title}</div>
              <span className="rounded-full border px-2 py-0.5 text-xs text-neutral-500">{STATUS_LABEL[r.status]}</span>
            </div>
            <div className="mt-1 line-clamp-2 text-sm text-neutral-500">{r.raw_need}</div>
            <div className="mt-1 text-xs text-neutral-400">{r.created_at}{r.lead_id ? ` · 来自询单#${r.lead_id}` : ''}</div>
          </div>
        ))}
        {list.data?.length === 0 && (
          <div className="rounded-lg border p-6 text-center text-neutral-400">
            暂无定制需求：右侧录入，或在「分发营销 → 数据复盘」把询单一键转过来
          </div>
        )}
      </div>
      <div className="self-start space-y-2 rounded-lg border bg-white p-4">
        <div className="font-semibold">录入客户需求</div>
        <input className={inp} placeholder="标题（如：宠物店会员小程序）" value={form.title}
          onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))} />
        <textarea className={`${inp} h-40`} placeholder="粘贴客户原始需求描述…" value={form.rawNeed}
          onChange={(e) => setForm((f) => ({ ...f, rawNeed: e.target.value }))} />
        <button className="w-full rounded bg-blue-600 py-1.5 text-sm text-white disabled:opacity-50"
          disabled={create.isPending || !form.title.trim() || !form.rawNeed.trim()} onClick={() => create.mutate()}>
          {create.isPending ? '录入中…' : '录入需求'}
        </button>
      </div>
    </div>
  )
}
