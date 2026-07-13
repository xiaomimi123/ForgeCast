import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import ReactMarkdown from 'react-markdown'
import { api, type Asset } from '../api'

export default function AssetCard({ asset, onRegenerate }: {
  asset: Asset
  onRegenerate: (feedback: string) => void
}) {
  const qc = useQueryClient()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [feedback, setFeedback] = useState('')
  const warnings: string[] = asset.warnings ? JSON.parse(asset.warnings) : []

  const content = useQuery({
    queryKey: ['asset-content', asset.id],
    queryFn: () => api<{ content: string }>(`/api/assets/${asset.id}/content`),
    enabled: asset.type === 'copy',
  })
  const save = useMutation({
    mutationFn: (c: string) => api(`/api/assets/${asset.id}/content`, { method: 'PUT', body: JSON.stringify({ content: c }) }),
    onSuccess: () => { setEditing(false); qc.invalidateQueries({ queryKey: ['asset-content', asset.id] }) },
  })
  const approve = useMutation({
    mutationFn: (status: string) => api(`/api/assets/${asset.id}`, { method: 'PATCH', body: JSON.stringify({ status }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['assets'] }),
  })

  if (asset.type === 'cover') {
    return (
      <div className="rounded-lg border bg-white p-3 flex items-center gap-3">
        <img src={`/files/${asset.file_path}`} alt="封面" className="h-32 rounded border" />
        <div className="text-sm text-neutral-500">封面 · {asset.hook} · {asset.status}</div>
      </div>
    )
  }

  return (
    <div className="rounded-lg border bg-white p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-sm text-neutral-500">
          #{asset.id} · {asset.hook} ·
          <span className={asset.status === 'approved' ? 'text-green-600 font-medium' : ''}> {asset.status}</span>
        </div>
        <div className="flex gap-2">
          {!editing && (
            <button className="rounded border px-3 py-1 text-sm"
              onClick={() => { setDraft(content.data?.content ?? ''); setEditing(true) }}>编辑</button>
          )}
          {asset.status === 'draft' && (
            <button className="rounded bg-green-600 px-3 py-1 text-sm text-white"
              onClick={() => approve.mutate('approved')}>审核通过</button>
          )}
        </div>
      </div>
      {warnings.length > 0 && (
        <div className="rounded bg-amber-50 border border-amber-300 px-3 py-2 text-sm text-amber-800">
          {warnings.join('；')}
        </div>
      )}
      {editing ? (
        <div className="space-y-2">
          <textarea className="w-full h-72 rounded border p-2 font-mono text-sm"
            value={draft} onChange={(e) => setDraft(e.target.value)} />
          <div className="flex gap-2">
            <button className="rounded bg-blue-600 px-3 py-1 text-sm text-white" onClick={() => save.mutate(draft)}>保存</button>
            <button className="rounded border px-3 py-1 text-sm" onClick={() => setEditing(false)}>取消</button>
          </div>
        </div>
      ) : (
        <div className="text-sm leading-relaxed [&_h2]:font-bold [&_h2]:mt-3 [&_li]:ml-4 max-h-72 overflow-y-auto border-t pt-2">
          <ReactMarkdown>{content.data?.content ?? '加载中…'}</ReactMarkdown>
        </div>
      )}
      <div className="flex gap-2 border-t pt-2">
        <input className="flex-1 rounded border px-2 py-1 text-sm" placeholder="修改意见（拼入提示词重新生成）"
          value={feedback} onChange={(e) => setFeedback(e.target.value)} />
        <button className="rounded border px-3 py-1 text-sm" disabled={!feedback}
          onClick={() => { onRegenerate(feedback); setFeedback('') }}>重新生成</button>
      </div>
    </div>
  )
}
