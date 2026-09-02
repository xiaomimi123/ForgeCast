import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import { api, ASSET_STATUS_LABEL, HOOK_LABEL, type Asset } from '../../api'
import TaskProgress from '../../components/TaskProgress'
import { useTaskRun } from '../../useTaskRun'

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
    <div className="card space-y-3 p-4">
      <div className="flex items-center justify-between">
        <div className="text-sm text-sub">
          {/* 抬头只出中文：钩子走 HOOK_LABEL、状态走 ASSET_STATUS_LABEL（验收清单第 3 条） */}
          拍摄脚本 #{asset.id} · {asset.hook ? (HOOK_LABEL[asset.hook] ?? asset.hook) : '—'} ·
          <span className={asset.status === 'approved' ? 'text-green-600 font-medium' : ''}> {ASSET_STATUS_LABEL[asset.status] ?? asset.status}</span>
        </div>
        <div className="flex gap-2">
          {!editing && (
            <button className="btn ghost px-3 py-1 text-sm"
              onClick={() => { setDraft(content.data?.content ?? ''); setEditing(true) }}>编辑</button>
          )}
          {asset.status === 'draft' && (
            <button className="btn px-2 py-0.5 text-xs" onClick={() => approve.mutate()}>审核通过</button>
          )}
          <button className="rounded-md border border-danger px-2 py-0.5 text-xs text-danger"
            onClick={() => { if (window.confirm('删除这份拍摄脚本？不可恢复')) del.mutate() }}>删除</button>
        </div>
      </div>
      {editing ? (
        <div className="space-y-2">
          <textarea className="h-80 w-full rounded-md border border-hairline-strong bg-card p-2 font-mono text-sm"
            value={draft} onChange={(e) => setDraft(e.target.value)} />
          <div className="flex gap-2">
            <button className="btn px-3 py-1 text-sm" onClick={() => save.mutate(draft)}>保存</button>
            <button className="btn ghost px-3 py-1 text-sm" onClick={() => setEditing(false)}>取消</button>
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
  const [mode, setMode] = useState('screen')
  const chosen = fromCopy === '' ? copyAssets[0]?.id : fromCopy
  const scriptRun = useTaskRun()
  useEffect(() => { onRunningChange(scriptRun.running) }, [scriptRun.running, onRunningChange])

  function generate() {
    if (!selected || chosen == null) return
    scriptRun.run(
      async () => (await api<{ taskId: string }>(`/api/projects/${selected}/script`, {
        method: 'POST', body: JSON.stringify({ assetId: chosen, mode }),
      })).taskId,
      (ok, e) => {
        qc.invalidateQueries({ queryKey: ['assets'] })
        if (!ok) alert('生成失败：' + (e?.message ?? '未知错误'))
      },
    )
  }
  return (
    <div className="grid grid-cols-[320px_1fr] gap-6">
      <div className="card h-fit space-y-3 p-4">
        <h3 className="text-sm font-semibold">生成拍摄脚本</h3>
        <div>
          <label className="text-sm text-sub">文案来源</label>
          <select className="mt-1 w-full rounded-md border border-hairline-strong bg-card p-2 text-sm"
            value={chosen ?? ''} onChange={(e) => setFromCopy(Number(e.target.value))}>
            {copyAssets.length === 0 && <option value="">暂无文案，先去「文案」tab 生成</option>}
            {/* 下拉里显示中文钩子名，不许露 pain/sideline 这类库内枚举（验收清单第 3 条） */}
            {copyAssets.map((a) => <option key={a.id} value={a.id}>#{a.id} · {a.hook ? (HOOK_LABEL[a.hook] ?? a.hook) : '—'}</option>)}
          </select>
        </div>
        <div>
          <label className="text-sm text-sub">拍摄条件</label>
          <select className="mt-1 w-full rounded-md border border-hairline-strong bg-card p-2 text-sm"
            value={mode} onChange={(e) => setMode(e.target.value)}>
            <option value="screen">仅录屏 + 口播（默认）</option>
            <option value="live">可真人出镜实拍</option>
            <option value="mixed">出镜 + 录屏混合</option>
          </select>
          <p className="mt-1 text-xs text-faint">分镜只会安排你选的条件内做得到的拍法</p>
        </div>
        <p className="text-xs text-faint">从口播稿扩展成逐镜分镜表（画面/台词/拍摄要点）+ 开拍准备清单，生成后可编辑。</p>
        <button className="btn w-full py-2 disabled:opacity-50"
          disabled={!selected || running || chosen == null} onClick={generate}>
          {scriptRun.running ? '生成中…' : '生成拍摄脚本'}
        </button>
        <TaskProgress run={scriptRun} />
      </div>
      <div className="space-y-4">
        {scriptAssets.length === 0 && <div className="text-sm text-faint">暂无拍摄脚本。选好文案点左侧生成。</div>}
        {scriptAssets.map((a) => <ScriptCard key={a.id} asset={a} />)}
      </div>
    </div>
  )
}
