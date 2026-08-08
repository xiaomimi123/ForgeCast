import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import ReactMarkdown from 'react-markdown'
import { api, type Asset } from '../api'

export default function AssetCard({ asset, onRegenerate, onVideo }: {
  asset: Asset
  onRegenerate: (feedback: string) => void
  onVideo?: (assetId: number) => void
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
  const del = useMutation({
    mutationFn: () => api(`/api/assets/${asset.id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['assets'] }),
    onError: (e) => {
      const m = e instanceof Error ? e.message : String(e)
      const i = m.indexOf('{'); let text = m
      if (i >= 0) { try { const j = JSON.parse(m.slice(i)); if (j?.error) text = j.error } catch { /* 非 JSON */ } }
      alert('删除失败：' + text)
    },
  })

  if (asset.type === 'video') {
    return (
      <div className="card-forge p-3 space-y-2">
        <div className="flex items-center justify-between">
          <div className="text-sm text-sub">视频 · {asset.hook} · {asset.status}</div>
          <button className="rounded-md border-[1.5px] border-danger px-2 py-0.5 text-xs text-danger disabled:opacity-50"
            disabled={del.isPending}
            onClick={() => { if (window.confirm('删除这个视频？文件和记录都会删掉，不可恢复')) del.mutate() }}>删除</button>
        </div>
        <video src={`/files/${asset.file_path}`} controls className="w-full max-h-96 rounded border-[1.5px] border-ink bg-black" />
      </div>
    )
  }

  if (asset.type === 'cover') {
    return (
      <div className="card-forge p-3 flex items-center gap-3">
        <img src={`/files/${asset.file_path}`} alt="封面" className="h-32 rounded border-[1.5px] border-ink" />
        <div className="text-sm text-sub">封面 · {asset.hook} · {asset.status}</div>
      </div>
    )
  }

  return (
    <div className="card-forge p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-sm text-sub">
          #{asset.id} · {asset.hook} ·
          <span className={asset.status === 'approved' ? 'text-fire font-medium' : ''}> {asset.status}</span>
        </div>
        <div className="flex gap-2">
          {!editing && (
            <button className="btn-ink px-3 py-1 text-sm"
              onClick={() => { setDraft(content.data?.content ?? ''); setEditing(true) }}>编辑</button>
          )}
          {asset.status === 'draft' && (
            <button className="btn-fire px-3 py-1 text-sm"
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
          <textarea className="w-full h-72 rounded-md border-[1.5px] border-ink bg-card p-2 font-mono text-sm"
            value={draft} onChange={(e) => setDraft(e.target.value)} />
          <div className="flex gap-2">
            <button className="btn-fire px-3 py-1 text-sm" onClick={() => save.mutate(draft)}>保存</button>
            <button className="btn-ink px-3 py-1 text-sm" onClick={() => setEditing(false)}>取消</button>
          </div>
        </div>
      ) : (
        <div className="text-sm leading-relaxed [&_h2]:font-bold [&_h2]:mt-3 [&_li]:ml-4 max-h-72 overflow-y-auto border-t border-hairline pt-2">
          <ReactMarkdown>{content.data?.content ?? '加载中…'}</ReactMarkdown>
        </div>
      )}
      <div className="flex gap-2 border-t border-hairline pt-2">
        <input className="flex-1 rounded-md border-[1.5px] border-ink bg-card px-2 py-1 text-sm" placeholder="修改意见（拼入提示词重新生成）"
          value={feedback} onChange={(e) => setFeedback(e.target.value)} />
        <button className="btn-ink px-3 py-1 text-sm disabled:opacity-50" disabled={!feedback}
          onClick={() => { onRegenerate(feedback); setFeedback('') }}>重新生成</button>
        {onVideo && (
          <button className="btn-ink px-3 py-1 text-sm" onClick={() => onVideo(asset.id)}>生成视频</button>
        )}
      </div>
    </div>
  )
}
