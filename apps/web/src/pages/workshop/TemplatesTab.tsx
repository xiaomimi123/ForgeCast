import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useRef, useState } from 'react'
import { api, type CustomTemplate } from '../../api'
import TaskProgress from '../../components/TaskProgress'
import { useTaskRun } from '../../useTaskRun'

/** 模板库 tab：上传对标视频 → 拆解节奏 → LLM 设计模板 → 落库；列表展示已有自定义模板。 */
export default function TemplatesTab() {
  const qc = useQueryClient()
  const fileRef = useRef<HTMLInputElement>(null)
  const [aspectRatio, setAspectRatio] = useState<'portrait' | 'landscape'>('portrait')
  const [name, setName] = useState('')
  const [styleNote, setStyleNote] = useState('')
  const tplRun = useTaskRun()

  const templates = useQuery({ queryKey: ['templates'], queryFn: () => api<CustomTemplate[]>('/api/templates') })

  async function upload(file: File) {
    if (!name.trim()) { alert('请先填模板名称'); return }
    const fd = new FormData()
    fd.append('file', file)
    fd.append('aspectRatio', aspectRatio)
    fd.append('name', name.trim())
    if (styleNote.trim()) fd.append('styleNote', styleNote.trim())
    tplRun.run(
      async () => {
        const res = await fetch('/api/templates', { method: 'POST', body: fd })
        if (!res.ok) throw new Error(`上传失败: ${await res.text()}`)
        return (await res.json() as { taskId: string }).taskId
      },
      (ok) => {
        qc.invalidateQueries({ queryKey: ['templates'] })
        if (ok) { setName(''); setStyleNote('') }
        if (fileRef.current) fileRef.current.value = ''
      },
    )
  }

  async function remove(id: number) {
    if (!confirm('删除这个模板？已渲染过的视频不受影响。')) return
    await fetch(`/api/templates/${id}`, { method: 'DELETE' })
    qc.invalidateQueries({ queryKey: ['templates'] })
  }

  return (
    <div className="space-y-4">
      <div className="card space-y-3 p-4">
        <h3 className="text-sm font-semibold">上传对标视频，拆解节奏生成新模板</h3>
        <input className="w-full rounded-md border border-hairline-strong bg-card p-2 text-sm" placeholder="模板名称"
          value={name} onChange={(e) => setName(e.target.value)} disabled={tplRun.running} />
        <div className="flex items-center gap-4 text-sm">
          <label className="flex items-center gap-1">
            <input type="radio" checked={aspectRatio === 'portrait'} onChange={() => setAspectRatio('portrait')} disabled={tplRun.running} /> 竖屏 9:16
          </label>
          <label className="flex items-center gap-1">
            <input type="radio" checked={aspectRatio === 'landscape'} onChange={() => setAspectRatio('landscape')} disabled={tplRun.running} /> 横屏 16:9
          </label>
        </div>
        <textarea className="w-full rounded-md border border-hairline-strong bg-card p-2 text-sm" placeholder="风格/调性描述（选填，如：科技感、搞笑、严肃商务）"
          value={styleNote} onChange={(e) => setStyleNote(e.target.value)} disabled={tplRun.running} rows={2} />
        <input ref={fileRef} type="file" accept=".mp4,.mov,.m4v" className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f) }} />
        <button className="btn px-4 py-2 disabled:opacity-50" disabled={tplRun.running}
          onClick={() => fileRef.current?.click()}>
          {tplRun.running ? '拆解生成中…' : '上传对标视频（mp4/mov）'}
        </button>
        <TaskProgress run={tplRun} />
        {tplRun.logs.length > 0 && (
          <div className="max-h-32 overflow-y-auto rounded-md bg-ink/5 p-2 text-xs text-sub">
            {tplRun.logs.map((l, i) => <div key={i}>{l}</div>)}
          </div>
        )}
      </div>
      <div className="grid grid-cols-3 gap-3">
        {templates.data?.map((t) => (
          <div key={t.id} className="card space-y-1 p-3 text-sm">
            <div className="font-semibold">{t.name}</div>
            <div className="text-xs text-sub">{t.aspect_ratio === 'portrait' ? '竖屏' : '横屏'} · {t.segment_count} 段</div>
            {t.style_note && <div className="text-xs text-faint">{t.style_note}</div>}
            <button className="btn ghost mt-1 px-2 py-1 text-xs" onClick={() => remove(t.id)}>删除</button>
          </div>
        ))}
        {templates.data?.length === 0 && <p className="col-span-3 text-sm text-faint">还没有自定义模板，上传一条对标视频生成第一个。</p>}
      </div>
    </div>
  )
}
