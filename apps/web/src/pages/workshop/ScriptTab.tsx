import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import ReactMarkdown from 'react-markdown'
import { api, subscribeTask, type Asset } from '../../api'

/** 单张拍摄脚本卡片：markdown 预览 / 编辑保存 / 审核 / 删除（编辑走通用 content 路由） */
function ScriptCard({ asset }: { asset: Asset }) {
  const qc = useQueryClient()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const content = useQuery({
    queryKey: ['asset-content', asset.id],
    queryFn: () => api<{ content: string }>(`/api/assets/${asset.id}/content`),
  })
  const save = useMutation({
    mutationFn: (c: string) => api(`/api/assets/${asset.id}/content`, { method: 'PUT', body: JSON.stringify({ content: c }) }),
    onSuccess: () => { setEditing(false); qc.invalidateQueries({ queryKey: ['asset-content', asset.id] }) },
  })
  const approve = useMutation({
    mutationFn: () => api(`/api/assets/${asset.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'approved' }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['assets'] }),
  })
  const del = useMutation({
    mutationFn: () => api(`/api/assets/${asset.id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['assets'] }),
  })
  return (
    <div className="card-forge space-y-3 p-4">
      <div className="flex items-center justify-between">
        <div className="text-sm text-sub">
          拍摄脚本 #{asset.id} · {asset.hook ?? '—'} ·
          <span className={asset.status === 'approved' ? 'text-green-600 font-medium' : ''}> {asset.status}</span>
        </div>
        <div className="flex gap-2">
          {!editing && (
            <button className="btn-ink px-3 py-1 text-sm"
              onClick={() => { setDraft(content.data?.content ?? ''); setEditing(true) }}>编辑</button>
          )}
          {asset.status === 'draft' && (
            <button className="btn-fire px-2 py-0.5 text-xs" onClick={() => approve.mutate()}>审核通过</button>
          )}
          <button className="rounded-md border-[1.5px] border-danger px-2 py-0.5 text-xs text-danger"
            onClick={() => { if (window.confirm('删除这份拍摄脚本？不可恢复')) del.mutate() }}>删除</button>
        </div>
      </div>
      {editing ? (
        <div className="space-y-2">
          <textarea className="h-80 w-full rounded-md border-[1.5px] border-ink bg-card p-2 font-mono text-sm"
            value={draft} onChange={(e) => setDraft(e.target.value)} />
          <div className="flex gap-2">
            <button className="btn-fire px-3 py-1 text-sm" onClick={() => save.mutate(draft)}>保存</button>
            <button className="btn-ink px-3 py-1 text-sm" onClick={() => setEditing(false)}>取消</button>
          </div>
        </div>
      ) : (
        <div className="max-h-96 overflow-y-auto border-t border-hairline pt-2 text-sm leading-relaxed [&_h1]:text-base [&_h1]:font-black [&_h2]:mt-3 [&_h2]:font-bold [&_h3]:mt-2 [&_h3]:font-semibold [&_li]:ml-4">
          <ReactMarkdown>{content.data?.content ?? '加载中…'}</ReactMarkdown>
        </div>
      )}
    </div>
  )
}

/** 拍摄脚本 tab：选一条文案 → LLM 扩展成可执行分镜表；脚本可编辑（拍摄前自己按实际情况调） */
export default function ScriptTab({ selected, copyAssets, scriptAssets, running, onRunningChange }: {
  selected: string
  copyAssets: Asset[]
  scriptAssets: Asset[]
  running: boolean
  onRunningChange: (v: boolean) => void
}) {
  const qc = useQueryClient()
  const [fromCopy, setFromCopy] = useState<number | ''>('')
  const chosen = fromCopy === '' ? copyAssets[0]?.id : fromCopy
  async function generate() {
    if (!selected || running) return
    onRunningChange(true)
    try {
      const { taskId } = await api<{ taskId: string }>(`/api/projects/${selected}/script`, {
        method: 'POST', body: JSON.stringify({ assetId: chosen }),
      })
      subscribeTask(taskId, (e) => {
        if (e.type === 'done' || e.type === 'error') {
          onRunningChange(false)
          qc.invalidateQueries({ queryKey: ['assets'] })
          if (e.type === 'error') alert('生成失败：' + e.message)
        }
      })
    } catch (err) {
      onRunningChange(false)
      alert('生成失败：' + (err instanceof Error ? err.message : String(err)))
    }
  }
  return (
    <div className="grid grid-cols-[320px_1fr] gap-6">
      <div className="card-forge h-fit space-y-3 p-4">
        <h3 className="text-sm font-semibold">生成拍摄脚本</h3>
        <div>
          <label className="text-sm text-sub">文案来源</label>
          <select className="mt-1 w-full rounded-md border-[1.5px] border-ink bg-card p-2 text-sm"
            value={chosen ?? ''} onChange={(e) => setFromCopy(Number(e.target.value))}>
            {copyAssets.length === 0 && <option value="">暂无文案，先去「文案」tab 生成</option>}
            {copyAssets.map((a) => <option key={a.id} value={a.id}>#{a.id} · {a.hook}</option>)}
          </select>
        </div>
        <p className="text-xs text-faint">从口播稿扩展成逐镜分镜表（画面/台词/拍摄要点）+ 开拍准备清单，生成后可编辑。</p>
        <button className="btn-fire w-full py-2 disabled:opacity-50"
          disabled={!selected || running || chosen == null} onClick={generate}>
          {running ? '生成中…' : '生成拍摄脚本'}
        </button>
      </div>
      <div className="space-y-4">
        {scriptAssets.length === 0 && <div className="text-sm text-faint">暂无拍摄脚本。选好文案点左侧生成。</div>}
        {scriptAssets.map((a) => <ScriptCard key={a.id} asset={a} />)}
      </div>
    </div>
  )
}
