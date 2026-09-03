import { useQueryClient, type UseQueryResult } from '@tanstack/react-query'
import { useRef, useState } from 'react'
import { api, ASSET_STATUS_LABEL, type Asset } from '../../api'
import TaskProgress from '../../components/TaskProgress'
import type { ConfirmOpts } from '../../components/ui/Confirm'
import { useConfirm } from '../../components/ui/Confirm'
import { Empty, Failure, Skeleton } from '../../components/ui/States'
import { useTaskRun } from '../../useTaskRun'

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

/**
 * 成片卡：竖屏播放器 + 审片（可选脚本基准）+ 报告 + 复盘 + 通过/删除。
 * 渲染成片与实拍上传共用一张卡，只有抬头的来源标签不同（旧「成片」tab 的卡片平移，并扩到渲染成片）。
 */
function VideoCard({ asset, scriptAssets, onStatus, onDelete, confirm }: {
  asset: Asset
  scriptAssets: Asset[]
  onStatus: (id: number) => void
  onDelete: (id: number) => void
  confirm: (opts: ConfirmOpts) => Promise<boolean>
}) {
  const qc = useQueryClient()
  const reviewRun = useTaskRun()
  const [scriptId, setScriptId] = useState<number | ''>('')
  let report: ReviewReport | null = null
  if (asset.review) { try { report = JSON.parse(asset.review) } catch { report = null } }
  const retroRun = useTaskRun()
  let retro: RetroReport | null = null
  if (asset.retro) { try { retro = JSON.parse(asset.retro) } catch { retro = null } }

  function runRetro() {
    retroRun.run(
      async () => (await api<{ taskId: string }>(`/api/assets/${asset.id}/retro`, { method: 'POST' })).taskId,
      (ok, e) => {
        qc.invalidateQueries({ queryKey: ['assets'] })
        if (!ok) alert('复盘失败：' + (e?.message ?? '未知错误'))
      },
    )
  }

  function runReview() {
    reviewRun.run(
      async () => (await api<{ taskId: string }>(`/api/assets/${asset.id}/review`, {
        method: 'POST', body: JSON.stringify(scriptId === '' ? {} : { scriptAssetId: scriptId }),
      })).taskId,
      (ok, e) => {
        qc.invalidateQueries({ queryKey: ['assets'] })
        if (!ok) alert('审片失败：' + (e?.message ?? '未知错误'))
      },
    )
  }

  const source = asset.origin === 'upload' ? '实拍' : '渲染'
  // 卡上只出中文，不露 draft/approved 这类库内枚举（验收清单第 3 条）；未知枚举兜底显示原值
  const statusLabel = ASSET_STATUS_LABEL[asset.status ?? ''] ?? asset.status
  return (
    <div className="card space-y-2 p-2">
      <video src={`/files/${asset.file_path}`} controls preload="metadata"
        className="aspect-[9/16] w-full rounded-lg border border-hairline-strong bg-black object-contain" />
      <div className="space-y-2 px-1">
        <div className="flex items-center justify-between gap-2">
          <div className="truncate text-xs text-sub">{source} · {statusLabel}{report ? ` · 总分 ${report.scores.overall}` : ''}</div>
          <div className="flex shrink-0 items-center gap-1.5">
            {asset.status === 'draft' && (
              <button
                className="rounded-[var(--fc-r-xs)] border border-[var(--fc-line-2)] px-2 py-0.5 text-xs text-[var(--fc-ink)] hover:bg-[var(--fc-line-3)]"
                onClick={() => onStatus(asset.id)}
              >审核通过</button>
            )}
            <button className="rounded-md border border-danger px-2 py-0.5 text-xs text-danger"
              onClick={() => { confirm({ title: '删除这条成片？', body: '文件和记录都会删掉', danger: true, okLabel: '删除' }).then((ok) => { if (ok) onDelete(asset.id) }) }}>删除</button>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <select className="min-w-0 flex-1 rounded-md border border-hairline-strong bg-card px-1.5 py-1 text-xs"
            value={scriptId} onChange={(e) => setScriptId(e.target.value === '' ? '' : Number(e.target.value))}>
            <option value="">最新脚本基准（自动）</option>
            {scriptAssets.map((s) => <option key={s.id} value={s.id}>脚本 #{s.id} · {s.hook ?? '—'}</option>)}
          </select>
          <button className="btn ghost shrink-0 px-2 py-1 text-xs disabled:opacity-50" disabled={reviewRun.running} onClick={runReview}>
            {reviewRun.running ? '审片中…' : report ? '重新审片' : '审片'}
          </button>
          <TaskProgress run={reviewRun} />
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
            <button className="btn ghost px-2 py-0.5 text-xs disabled:opacity-50" disabled={retroRun.running} onClick={runRetro}>
              {retroRun.running ? '复盘中…' : retro ? '重新复盘' : '生成复盘（结合发布数据）'}
            </button>
            <TaskProgress run={retroRun} />
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

/**
 * 成片库：本项目全部 video 素材（渲染 + 实拍上传）一个列表 + 审片 / 通过 / 删除 / 上传入口。
 * 本屏唯一黑实心按钮 = 「上传成片」（推进流水线的下一步），卡上动作全是描边或 chip（§7）。
 */
export default function LibraryTab({ selected, assetsQuery, scriptAssets, onStatus, onDelete }: {
  selected: string
  assetsQuery: UseQueryResult<Asset[]>
  scriptAssets: Asset[]
  onStatus: (id: number) => void
  onDelete: (id: number) => void
}) {
  const qc = useQueryClient()
  const { confirm, element: confirmEl } = useConfirm()
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
      qc.invalidateQueries({ queryKey: ['content-items', selected] })
    } finally {
      setUploading(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  const uploadButton = (
    <button className="rounded-[var(--fc-r-sm)] bg-[var(--fc-ink)] px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-40"
      disabled={!selected || uploading} onClick={() => fileRef.current?.click()}>
      {uploading ? '上传中…' : '上传成片（mp4/mov）'}
    </button>
  )

  const videos = (assetsQuery.data ?? []).filter((a) => a.type === 'video')

  return (
    <div className="space-y-4">
      <div className="card flex items-center gap-3 p-4">
        <input ref={fileRef} type="file" accept=".mp4,.mov,.m4v" className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f) }} />
        {uploadButton}
        <p className="text-xs text-faint">渲染成片和实拍成片都在这里审。按「拍摄脚本」拍好剪好后传上来，系统对照脚本审片打分并给下一条的改进建议。</p>
      </div>

      {assetsQuery.isLoading && <Skeleton lines={4} />}
      {assetsQuery.isError && (
        <Failure step="载入成片列表"
          error={assetsQuery.error instanceof Error ? assetsQuery.error.message : String(assetsQuery.error)}
          onRetry={() => assetsQuery.refetch()} />
      )}
      {!assetsQuery.isLoading && !assetsQuery.isError && videos.length === 0 && (
        // 空态里的动作用描边：顶部「上传成片」已经是本屏唯一的黑实心按钮（§7）
        <Empty why="这个项目还没有成片——去剪辑台渲一条，或直接传实拍" action={
          <button className="rounded-[var(--fc-r-sm)] border border-[var(--fc-line-2)] px-4 py-2 text-sm font-medium text-[var(--fc-ink)] hover:bg-[var(--fc-line-3)] disabled:opacity-40"
            disabled={!selected || uploading} onClick={() => fileRef.current?.click()}>
            {uploading ? '上传中…' : '上传成片（mp4/mov）'}
          </button>
        } />
      )}
      <div className="grid grid-cols-2 gap-4 2xl:grid-cols-3">
        {videos.map((a) => (
          <VideoCard key={a.id} asset={a} scriptAssets={scriptAssets} onStatus={onStatus} onDelete={onDelete} confirm={confirm} />
        ))}
      </div>
      {confirmEl}
    </div>
  )
}
