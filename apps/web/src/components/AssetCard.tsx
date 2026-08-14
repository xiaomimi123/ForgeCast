import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import ReactMarkdown from 'react-markdown'
import { api, subscribeTask, type Asset } from '../api'

const COVER_TEMPLATES = [
  { value: '', label: '自动' },
  { value: 'bigtext', label: '大字报' },
  { value: 'annotate', label: '截图标注' },
  { value: 'contrast', label: '对比型' },
]

/** 发布/表现数据展示：published_at 有值显示已发布信息，perf 有值显示曝光/赞/询单（都缺省不渲染） */
function PublishInfo({ asset }: { asset: Asset }) {
  let perf: { views?: number; likes?: number; leads?: number } | null = null
  if (asset.perf) { try { perf = JSON.parse(asset.perf) } catch { /* 坏 JSON 忽略 */ } }
  if (!asset.published_at && !perf) return null
  return (
    <div className="space-y-0.5 text-xs text-sub">
      {asset.published_at && (
        asset.published_url
          ? <a className="text-fire" href={asset.published_url} target="_blank" rel="noreferrer">已发布 · {asset.platform || '—'} · {asset.published_at}</a>
          : <div>已发布 · {asset.platform || '—'} · {asset.published_at}</div>
      )}
      {perf && <div>曝光 {perf.views ?? 0} · 赞 {perf.likes ?? 0} · 询单 {perf.leads ?? 0}</div>}
    </div>
  )
}

export default function AssetCard({ asset, slug, onRegenerate, onVideo }: {
  asset: Asset
  slug: string
  onRegenerate: (feedback: string) => void
  onVideo?: (assetId: number) => void
}) {
  const qc = useQueryClient()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [feedback, setFeedback] = useState('')
  const [coverTemplate, setCoverTemplate] = useState('')
  const [coverShot, setCoverShot] = useState('')
  const [coverBusy, setCoverBusy] = useState(false)
  const warnings: string[] = asset.warnings ? JSON.parse(asset.warnings) : []

  const content = useQuery({
    queryKey: ['asset-content', asset.id],
    queryFn: () => api<{ content: string }>(`/api/assets/${asset.id}/content`),
    enabled: asset.type === 'copy',
  })
  const raw = useQuery({
    queryKey: ['raw', slug],
    queryFn: () => api<{ files: string[] }>(`/api/projects/${slug}/raw`),
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

  async function regenerateCover() {
    if (coverBusy) return
    setCoverBusy(true)
    try {
      const { taskId } = await api<{ taskId: string }>(`/api/assets/${asset.id}/cover`, {
        method: 'POST', body: JSON.stringify({ template: coverTemplate || undefined, shot: coverShot || undefined }),
      })
      subscribeTask(taskId, (e) => {
        if (e.type === 'done' || e.type === 'error') {
          setCoverBusy(false)
          qc.invalidateQueries({ queryKey: ['assets'] })
          if (e.type === 'error') alert('封面生成失败：' + e.message)
        }
      })
    } catch (err) {
      setCoverBusy(false)
      alert('封面生成失败：' + (err instanceof Error ? err.message : String(err)))
    }
  }

  const approveButton = asset.status === 'draft' && (
    <button className="btn-fire px-2 py-0.5 text-xs" onClick={() => approve.mutate('approved')}>审核通过</button>
  )
  const deleteButton = (
    <button className="rounded-md border-[1.5px] border-danger px-2 py-0.5 text-xs text-danger disabled:opacity-50"
      disabled={del.isPending}
      onClick={() => { if (window.confirm('删除这条素材？文件和记录都会删掉，不可恢复')) del.mutate() }}>删除</button>
  )

  if (asset.type === 'video') {
    return (
      <div className="card-forge p-2 space-y-2">
        <video src={`/files/${asset.file_path}`} controls preload="metadata"
          className="aspect-[9/16] w-full rounded-lg border-[1.5px] border-ink bg-black object-contain" />
        <div className="space-y-1 px-1">
          <div className="flex items-center justify-between gap-2">
            <div className="truncate text-xs text-sub">{asset.origin === 'upload' ? '实拍' : '渲染'} · {asset.hook ?? '—'} · {asset.status}</div>
            <div className="flex shrink-0 items-center gap-1.5">{approveButton}{deleteButton}</div>
          </div>
          <PublishInfo asset={asset} />
        </div>
      </div>
    )
  }

  if (asset.type === 'cover') {
    return (
      <div className="card-forge p-3 space-y-2">
        <div className="flex items-center gap-3">
          <img src={`/files/${asset.file_path}`} alt="封面" className="h-32 rounded border-[1.5px] border-ink" />
          <div className="flex-1 space-y-1">
            <div className="text-sm text-sub">封面 · {asset.hook} · {asset.status}</div>
            <PublishInfo asset={asset} />
          </div>
          <div className="flex flex-col items-end gap-1">{approveButton}{deleteButton}</div>
        </div>
      </div>
    )
  }

  return (
    <div className="card-forge p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-sm text-sub">
          #{asset.id} · {asset.hook} ·
          <span className={asset.status === 'approved' ? 'text-green-600 font-medium' : ''}> {asset.status}</span>
        </div>
        <div className="flex gap-2">
          {!editing && (
            <button className="btn-ink px-3 py-1 text-sm"
              onClick={() => { setDraft(content.data?.content ?? ''); setEditing(true) }}>编辑</button>
          )}
          {approveButton}
          {deleteButton}
        </div>
      </div>
      <PublishInfo asset={asset} />
      {warnings.length > 0 && (
        <div className="rounded border-[1.5px] border-amber-600 bg-amber-50 px-3 py-2 text-sm text-amber-800">
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
          <button className="btn-ink px-3 py-1 text-sm" onClick={() => onVideo(asset.id)}>去出视频 →</button>
        )}
      </div>
      <div className="flex items-center gap-2 pt-1">
        <span className="text-xs text-sub">重新生成封面</span>
        <select className="rounded-md border-[1.5px] border-ink bg-card px-1.5 py-1 text-xs"
          value={coverTemplate} onChange={(e) => setCoverTemplate(e.target.value)}>
          {COVER_TEMPLATES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
        </select>
        <select className="rounded-md border-[1.5px] border-ink bg-card px-1.5 py-1 text-xs"
          value={coverShot} onChange={(e) => setCoverShot(e.target.value)}>
          <option value="">自动选图</option>
          {raw.data?.files.map((f) => <option key={f} value={f}>{f}</option>)}
        </select>
        <button className="btn-ink px-3 py-1 text-xs disabled:opacity-50" disabled={coverBusy} onClick={regenerateCover}>
          {coverBusy ? '生成中…' : '生成'}
        </button>
      </div>
    </div>
  )
}
