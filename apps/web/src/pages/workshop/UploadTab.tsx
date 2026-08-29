import { useQueryClient } from '@tanstack/react-query'
import { useRef, useState } from 'react'
import { api, subscribeTask, type Asset } from '../../api'

interface ReviewReport {
  scores: { hook: number; pacing: number; fidelity: number; cta: number; overall: number }
  suggestions: string[]
  transcript?: string
  metrics: { durationSec: number | null; charCount: number; charsPerSec: number | null }
  degraded?: string
  reviewedAt: string
}

interface RetroReport { verdict: string; keep: string[]; change: string[]; focus: string; generatedAt: string; hadPerf: boolean }

const DIM_LABELS: Array<[keyof ReviewReport['scores'], string]> = [
  ['hook', '钩子'], ['pacing', '节奏'], ['fidelity', '贴合'], ['cta', 'CTA'],
]

/** 分数条：0-100，>=70 绿 / >=50 琥珀 / 其余红（语义色例外，见 forge-theme spec） */
function ScoreBar({ label, value }: { label: string; value: number }) {
  const color = value >= 70 ? 'bg-green-600' : value >= 50 ? 'bg-amber-500' : 'bg-danger'
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="w-8 shrink-0 text-sub">{label}</span>
      <div className="h-2 flex-1 rounded-full bg-paper">
        <div className={`h-2 rounded-full ${color}`} style={{ width: `${Math.min(100, Math.max(0, value))}%` }} />
      </div>
      <span className="w-6 text-right font-bold">{value}</span>
    </div>
  )
}

/** 单条上传成片卡片：竖屏播放器 + 审片（可选脚本基准）+ 报告展示 */
function UploadCard({ asset, scriptAssets, onStatus, onDelete }: {
  asset: Asset
  scriptAssets: Asset[]
  onStatus: (id: number) => void
  onDelete: (id: number) => void
}) {
  const qc = useQueryClient()
  const [reviewing, setReviewing] = useState(false)
  const [scriptId, setScriptId] = useState<number | ''>('')
  let report: ReviewReport | null = null
  if (asset.review) { try { report = JSON.parse(asset.review) } catch { report = null } }
  const [retroing, setRetroing] = useState(false)
  let retro: RetroReport | null = null
  if (asset.retro) { try { retro = JSON.parse(asset.retro) } catch { retro = null } }
  async function runRetro() {
    if (retroing) return
    setRetroing(true)
    try {
      const { taskId } = await api<{ taskId: string }>(`/api/assets/${asset.id}/retro`, { method: 'POST' })
      subscribeTask(taskId, (e) => {
        if (e.type === 'done' || e.type === 'error') {
          setRetroing(false)
          qc.invalidateQueries({ queryKey: ['assets'] })
          if (e.type === 'error') alert('复盘失败：' + e.message)
        }
      })
    } catch (err) {
      setRetroing(false)
      alert('复盘失败：' + (err instanceof Error ? err.message : String(err)))
    }
  }

  async function runReview() {
    if (reviewing) return
    setReviewing(true)
    try {
      const { taskId } = await api<{ taskId: string }>(`/api/assets/${asset.id}/review`, {
        method: 'POST', body: JSON.stringify(scriptId === '' ? {} : { scriptAssetId: scriptId }),
      })
      subscribeTask(taskId, (e) => {
        if (e.type === 'done' || e.type === 'error') {
          setReviewing(false)
          qc.invalidateQueries({ queryKey: ['assets'] })
          if (e.type === 'error') alert('审片失败：' + e.message)
        }
      })
    } catch (err) {
      setReviewing(false)
      alert('审片失败：' + (err instanceof Error ? err.message : String(err)))
    }
  }

  return (
    <div className="card space-y-2 p-2">
      <video src={`/files/${asset.file_path}`} controls preload="metadata"
        className="aspect-[9/16] w-full rounded-lg border border-hairline-strong bg-black object-contain" />
      <div className="space-y-2 px-1">
        <div className="flex items-center justify-between gap-2">
          <div className="truncate text-xs text-sub">实拍 · {asset.status}{report ? ` · 总分 ${report.scores.overall}` : ''}</div>
          <div className="flex shrink-0 items-center gap-1.5">
            {asset.status === 'draft' && (
              <button className="btn px-2 py-0.5 text-xs" onClick={() => onStatus(asset.id)}>审核通过</button>
            )}
            <button className="rounded-md border border-danger px-2 py-0.5 text-xs text-danger"
              onClick={() => { if (window.confirm('删除这条成片？文件和记录都会删掉')) onDelete(asset.id) }}>删除</button>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <select className="min-w-0 flex-1 rounded-md border border-hairline-strong bg-card px-1.5 py-1 text-xs"
            value={scriptId} onChange={(e) => setScriptId(e.target.value === '' ? '' : Number(e.target.value))}>
            <option value="">最新脚本基准（自动）</option>
            {scriptAssets.map((s) => <option key={s.id} value={s.id}>脚本 #{s.id} · {s.hook ?? '—'}</option>)}
          </select>
          <button className="btn ghost shrink-0 px-2 py-1 text-xs disabled:opacity-50" disabled={reviewing} onClick={runReview}>
            {reviewing ? '审片中…' : report ? '重新审片' : '审片'}
          </button>
        </div>
        {report && (
          <div className="space-y-1.5 border-t border-hairline pt-2">
            {DIM_LABELS.map(([k, label]) => <ScoreBar key={k} label={label} value={report!.scores[k]} />)}
            {report.degraded && (
              <div className="rounded border border-amber-600 bg-amber-50 px-2 py-1 text-xs text-amber-800">{report.degraded}</div>
            )}
            <ul className="space-y-0.5 text-xs">
              {report.suggestions.map((s, i) => <li key={i}>· {s}</li>)}
            </ul>
            {report.transcript && (
              <div className="truncate text-xs text-faint" title={report.transcript}>转写：{report.transcript.slice(0, 60)}…</div>
            )}
            <button className="btn ghost px-2 py-0.5 text-xs disabled:opacity-50" disabled={retroing} onClick={runRetro}>
              {retroing ? '复盘中…' : retro ? '重新复盘' : '生成复盘（结合发布数据）'}
            </button>
            {retro && (
              <div className="space-y-1 border-t border-hairline pt-2 text-xs">
                <div className="font-bold">复盘：{retro.verdict}{retro.hadPerf ? '' : '（暂无发布数据）'}</div>
                <div className="text-sub">保持：{retro.keep.join('；')}</div>
                <div className="text-sub">改进：{retro.change.join('；')}</div>
                <div className="rounded bg-fire-soft px-2 py-1 font-bold text-fire">下一条优先：{retro.focus}</div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

/** 成片 tab：上传实拍视频 → 审片打分 → 按建议迭代下一条（人机协作主线） */
export default function UploadTab({ selected, uploadAssets, scriptAssets, onStatus, onDelete }: {
  selected: string
  uploadAssets: Asset[]
  scriptAssets: Asset[]
  onStatus: (id: number) => void
  onDelete: (id: number) => void
}) {
  const qc = useQueryClient()
  const fileRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)
  async function upload(file: File) {
    setUploading(true)
    try {
      const fd = new FormData()
      fd.append('file', file)
      const res = await fetch(`/api/projects/${selected}/upload-video`, { method: 'POST', body: fd })
      if (!res.ok) alert(`上传失败: ${await res.text()}`)
      qc.invalidateQueries({ queryKey: ['assets'] })
    } finally {
      setUploading(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }
  return (
    <div className="space-y-4">
      <div className="card flex items-center gap-3 p-4">
        <input ref={fileRef} type="file" accept=".mp4,.mov,.m4v" className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f) }} />
        <button className="btn px-4 py-2 disabled:opacity-50" disabled={!selected || uploading}
          onClick={() => fileRef.current?.click()}>
          {uploading ? '上传中…' : '上传成片（mp4/mov）'}
        </button>
        <p className="text-xs text-faint">按「拍摄脚本」拍好剪好后传上来，系统对照脚本审片打分并给下一条的改进建议。</p>
      </div>
      <div className="grid grid-cols-2 gap-4 2xl:grid-cols-3">
        {uploadAssets.length === 0 && <div className="text-sm text-faint">暂无实拍成片。</div>}
        {uploadAssets.map((a) => (
          <UploadCard key={a.id} asset={a} scriptAssets={scriptAssets} onStatus={onStatus} onDelete={onDelete} />
        ))}
      </div>
    </div>
  )
}
