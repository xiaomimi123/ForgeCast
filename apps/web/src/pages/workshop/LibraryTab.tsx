import { useQueryClient, type UseQueryResult } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  api, ASSET_STATUS_LABEL, PLATFORM_LABEL,
  type Asset, type ContentItemView,
} from '../../api'
import TaskProgress from '../../components/TaskProgress'
import type { ConfirmOpts } from '../../components/ui/Confirm'
import { useConfirm } from '../../components/ui/Confirm'
import { Empty, Failure, Skeleton } from '../../components/ui/States'
import { videoIdFromSpecPath } from '../../lib/rebase'
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

/** assets.perf 的形状（分发工位录入，成片库只读）。字段都当可选处理——历史数据可能缺项。 */
interface PerfData { views?: number; likes?: number; leads?: number; recordedAt?: string }

const DIM_LABELS: Array<[keyof ReviewReport['scores'], string]> = [
  ['hook', '钩子'], ['pacing', '节奏'], ['fidelity', '贴合'], ['cta', 'CTA'],
]

/** 解析素材上的 JSON 字符串字段；坏数据一律当「没有」处理（静默不显示，不炸整页）。 */
function parseJson<T>(raw: string | null): T | null {
  if (!raw) return null
  try {
    const v = JSON.parse(raw)
    return v && typeof v === 'object' ? (v as T) : null
  } catch { return null }
}

const OUTLINE_XS = 'h-6 shrink-0 rounded-[var(--fc-r-sm)] border border-[var(--fc-line-2)] bg-transparent px-2 text-xs font-medium text-[var(--fc-ink)] hover:border-[var(--fc-ink)] hover:bg-[var(--fc-bg)] disabled:border-[var(--fc-line)] disabled:text-[var(--fc-line-2)]'

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

/** 成片状态标签：与 ContentCard.StatusTag 同规格（高 20 / Mono 10 / span 不可点，§7 规则 2）。 */
function AssetStatusTag({ status, rejected }: { status: string | null; rejected: boolean }) {
  const base = 'inline-flex h-5 shrink-0 items-center gap-1 whitespace-nowrap rounded-[var(--fc-r-xs)] px-1.5 font-mono text-[10px]'
  if (rejected) return <span className={`${base} bg-[var(--fc-line-2)] text-[var(--fc-surface)]`}>已打回</span>
  const label = ASSET_STATUS_LABEL[status ?? ''] ?? status ?? '—'
  if (status === 'approved') return <span className={`${base} bg-[var(--fc-ink)] text-white`}>✓ {label}</span>
  if (status === 'published') return <span className={`${base} border border-[var(--fc-accent)] bg-[var(--fc-accent-tint)] text-[var(--fc-accent-deep)]`}>{label}</span>
  return <span className={`${base} border border-[var(--fc-line-2)] text-[var(--fc-muted)]`}>{label}</span>
}

/**
 * 发布信息 + 表现数据（P0 挂账的 perf 回工位）：**只展示不录入**——录入仍在分发工位。
 * perf/published_* 任一为空就不占位；perf JSON 解析失败静默跳过（见 parseJson）。
 */
function PerfLine({ asset }: { asset: Asset }) {
  const perf = parseJson<PerfData>(asset.perf)
  const published = !!(asset.published_at || asset.platform || asset.published_url)
  if (!published && !perf) return null
  const num = (v: number | undefined) => (typeof v === 'number' ? v.toLocaleString('en-US') : '—')
  return (
    <div className="space-y-0.5 border-t border-[var(--fc-line-3)] pt-1 font-mono text-[10px] text-[var(--fc-muted)]">
      {published && (
        <div className="flex items-center gap-1 truncate">
          <span>{PLATFORM_LABEL[asset.platform ?? ''] ?? asset.platform ?? '已发布'}</span>
          {asset.published_at && <span>· {asset.published_at.slice(0, 10)}</span>}
          {asset.published_url && (
            <a href={asset.published_url} target="_blank" rel="noreferrer"
              className="text-[var(--fc-accent)] hover:text-[var(--fc-accent-deep)]">链接 ↗</a>
          )}
        </div>
      )}
      {perf && (
        <div className="truncate" title={perf.recordedAt ? `采集于 ${perf.recordedAt}` : undefined}>
          播放 {num(perf.views)} · 赞 {num(perf.likes)} · 线索 {num(perf.leads)}
        </div>
      )}
    </div>
  )
}

/** 卡片展开区：审片 / 报告 / 复盘 / 删除（P0 VideoCard 的下半身原样平移，只是从常驻变成展开）。 */
function VideoDetail({ asset, scriptAssets, onDelete, confirm }: {
  asset: Asset
  scriptAssets: Asset[]
  onDelete: (id: number) => void
  confirm: (opts: ConfirmOpts) => Promise<boolean>
}) {
  const qc = useQueryClient()
  const reviewRun = useTaskRun()
  const retroRun = useTaskRun()
  const [scriptId, setScriptId] = useState<number | ''>('')
  const report = parseJson<ReviewReport>(asset.review)
  const retro = parseJson<RetroReport>(asset.retro)

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

  return (
    <div className="space-y-2 border-t border-[var(--fc-line-3)] pt-2">
      <div className="flex items-center gap-1.5">
        <select className="min-w-0 flex-1 rounded-md border border-hairline-strong bg-card px-1.5 py-1 text-xs"
          value={scriptId} onChange={(e) => setScriptId(e.target.value === '' ? '' : Number(e.target.value))}>
          <option value="">最新脚本基准（自动）</option>
          {scriptAssets.map((s) => <option key={s.id} value={s.id}>脚本 #{s.id} · {s.hook ?? '—'}</option>)}
        </select>
        <button className={OUTLINE_XS} disabled={reviewRun.running} onClick={runReview}>
          {reviewRun.running ? '审片中…' : report ? '重新审片' : '审片'}
        </button>
        <button className="h-6 shrink-0 rounded-[var(--fc-r-sm)] border border-danger px-2 text-xs text-danger"
          onClick={() => { confirm({ title: '删除这条成片？', body: '文件和记录都会删掉', danger: true, okLabel: '删除' }).then((ok) => { if (ok) onDelete(asset.id) }) }}>删除</button>
      </div>
      <TaskProgress run={reviewRun} />
      {report && (
        <div className="space-y-1.5">
          {DIM_LABELS.map(([k, label]) => <ScoreBar key={k} label={label} value={report.scores[k]} />)}
          {report.degraded && (
            <div className="rounded border border-amber-600 bg-amber-50 px-2 py-1 text-xs text-amber-800">{report.degraded}</div>
          )}
          <ul className="space-y-0.5 text-xs">
            {report.suggestions.map((s, i) => <li key={i}>· {s}</li>)}
          </ul>
          {report.transcript && (
            <div className="truncate text-xs text-faint" title={report.transcript}>转写：{report.transcript.slice(0, 60)}…</div>
          )}
          <button className={OUTLINE_XS} disabled={retroRun.running} onClick={runRetro}>
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
  )
}

/** 网格卡：竖版缩略 + 状态标签 + 元信息（Mono）+ 勾选框；焦点卡 3px accent 描边。 */
function VideoCard({
  asset, index, focused, checked, rejected, flash, expanded, canEdit,
  scriptAssets, onFocus, onToggleCheck, onToggleExpand, onApprove, onDelete, onOpenEditor, confirm, registerVideo, registerCard,
}: {
  asset: Asset
  index: number
  focused: boolean
  checked: boolean
  rejected: boolean
  flash: string | null
  expanded: boolean
  canEdit: boolean
  scriptAssets: Asset[]
  onFocus: (i: number) => void
  onToggleCheck: (id: number) => void
  onToggleExpand: (id: number) => void
  onApprove: (index: number) => void
  onDelete: (id: number) => void
  onOpenEditor: (asset: Asset) => void
  confirm: (opts: ConfirmOpts) => Promise<boolean>
  registerVideo: (id: number, el: HTMLVideoElement | null) => void
  registerCard: (id: number, el: HTMLDivElement | null) => void
}) {
  const source = asset.origin === 'upload' ? '实拍' : '渲染'
  const report = parseJson<ReviewReport>(asset.review)
  return (
    <div
      ref={(el) => registerCard(asset.id, el)}
      onClick={() => onFocus(index)}
      className={`card relative p-1.5 ${expanded ? 'col-span-2 2xl:col-span-3' : ''}`}
      style={focused ? { boxShadow: '0 0 0 3px var(--fc-accent)' } : undefined}
    >
      <label className="absolute left-2.5 top-2.5 z-10 flex h-5 w-5 cursor-pointer items-center justify-center rounded-[var(--fc-r-xs)] bg-[var(--fc-surface)]/85"
        onClick={(e) => e.stopPropagation()}>
        <input type="checkbox" checked={checked} onChange={() => onToggleCheck(asset.id)} aria-label={`选择成片 #${asset.id}`} />
      </label>
      {flash && (
        <div className="absolute right-2.5 top-2.5 z-10 rounded-[var(--fc-r-xs)] bg-[var(--fc-ink)] px-1.5 py-0.5 font-mono text-[10px] text-white">{flash}</div>
      )}
      {/* 展开态左右分栏：缩略图宽度锁死，否则跨列的卡会把 9:16 的视频拉成一屏高 */}
      <div className={expanded ? 'flex gap-3' : ''}>
        <video
          ref={(el) => registerVideo(asset.id, el)}
          src={`/files/${asset.file_path}`} controls preload="metadata"
          className={`aspect-[9/16] shrink-0 rounded-[var(--fc-r-sm)] border border-hairline-strong bg-black object-contain ${expanded ? 'w-[190px]' : 'w-full'}`}
        />
        <div className="min-w-0 flex-1 space-y-1">
      <div className="flex items-center justify-between gap-1">
        <AssetStatusTag status={asset.status} rejected={rejected} />
        <span className="truncate font-mono text-[10px] text-[var(--fc-faint)]">
          #{asset.id} · {source}{report ? ` · ${report.scores.overall}` : ''}
        </span>
      </div>
      <PerfLine asset={asset} />
      <div className="flex items-center gap-1">
        <button className={OUTLINE_XS} onClick={(e) => { e.stopPropagation(); onToggleExpand(asset.id) }}>
          {expanded ? '收起' : '详情'}
        </button>
        {asset.status === 'draft' && (
          <button className={OUTLINE_XS} title="通过（A）"
            onClick={(e) => { e.stopPropagation(); onApprove(index) }}>通过</button>
        )}
        <button className={OUTLINE_XS} disabled={!canEdit} title={canEdit ? '进剪辑台（E）' : '这条成片在本项目的内容队列里找不到出处（跨项目或实拍上传），无法进剪辑台'}
          onClick={(e) => { e.stopPropagation(); onOpenEditor(asset) }}>剪辑台</button>
      </div>
      {expanded && <VideoDetail asset={asset} scriptAssets={scriptAssets} onDelete={onDelete} confirm={confirm} />}
        </div>
      </div>
    </div>
  )
}

const SHORTCUTS: Array<[string, string]> = [
  ['J', '下一条（焦点跟随滚动）'],
  ['K', '上一条'],
  ['Space', '播放 / 暂停焦点卡'],
  ['A', '通过（直接执行，不弹窗；焦点自动跳下一条待审）'],
  ['R', '打回（本地标记待重做，不改库内状态）'],
  ['E', '进剪辑台（查不到出处时置灰）'],
  ['?', '打开 / 关闭这份说明（Esc 关闭）'],
]

/**
 * 成片库：本项目全部 video 素材（渲染 + 实拍上传）6 列网格 + 批量审片 + 上传入口。
 * 本屏唯一黑实心按钮 = 「上传成片」（推进流水线的下一步），批量条与卡上动作全是描边（§7）。
 * 键盘（§7 末尾）：J/K 上下条 · Space 播放 · A 通过 · R 打回 · E 进剪辑台 · ? 说明。
 */
export default function LibraryTab({ selected, assetsQuery, scriptAssets, contentItems, onDelete, onOpenInEditor }: {
  selected: string
  assetsQuery: UseQueryResult<Asset[]>
  scriptAssets: Asset[]
  /** 用来把 video asset 反查回它所属的 ContentItem（E 键跳剪辑台）；跨项目/实拍上传查不到就置灰 */
  contentItems: ContentItemView[]
  onDelete: (id: number) => void
  onOpenInEditor: (itemId: number) => void
}) {
  const qc = useQueryClient()
  const { confirm, element: confirmEl } = useConfirm()
  const fileRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)
  const [focusIdx, setFocusIdx] = useState(0)
  const [checkedIds, setCheckedIds] = useState<number[]>([])
  /** 本地「已打回」标记：库内没有打回语义（与 P0 一致不新增状态列），只在本次会话里提示待重做 */
  const [rejectedIds, setRejectedIds] = useState<number[]>([])
  const [expandedId, setExpandedId] = useState<number | null>(null)
  const [flash, setFlash] = useState<Record<number, string>>({})
  const [helpOpen, setHelpOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<{ title: string; lines: string[] } | null>(null)
  const videoRefs = useRef(new Map<number, HTMLVideoElement>())
  const cardRefs = useRef(new Map<number, HTMLDivElement>())
  /** 弹层/批量执行中要旁路键盘；用 ref 让 window 监听器读到最新值而不必重挂 */
  const blockedRef = useRef(false)
  blockedRef.current = helpOpen || busy

  const videos = useMemo(() => (assetsQuery.data ?? []).filter((a) => a.type === 'video'), [assetsQuery.data])

  /** video assetId → 所属 ContentItem id（render.assetIds 含全部版本，见 ContentItemView 注释） */
  const itemByAsset = useMemo(() => {
    const m = new Map<number, number>()
    for (const it of contentItems) for (const aid of it.render?.assetIds ?? []) m.set(aid, it.id)
    return m
  }, [contentItems])

  // 列表变短（删除/切项目）时把焦点收回合法范围
  useEffect(() => {
    setFocusIdx((i) => (videos.length === 0 ? 0 : Math.min(i, videos.length - 1)))
  }, [videos.length])
  useEffect(() => { setCheckedIds([]); setFocusIdx(0); setExpandedId(null) }, [selected])

  const focusAsset = videos[focusIdx] ?? null
  useEffect(() => {
    if (!focusAsset) return
    cardRefs.current.get(focusAsset.id)?.scrollIntoView({ block: 'nearest' })
  }, [focusAsset])

  const showFlash = useCallback((id: number, text: string) => {
    setFlash((f) => ({ ...f, [id]: text }))
    setTimeout(() => setFlash((f) => { const { [id]: _, ...rest } = f; return rest }), 2000)
  }, [])

  const approveOne = useCallback(async (id: number) => {
    await api(`/api/assets/${id}`, { method: 'PATCH', body: JSON.stringify({ status: 'approved' }) })
  }, [])

  function invalidate() {
    qc.invalidateQueries({ queryKey: ['assets', selected] })
    qc.invalidateQueries({ queryKey: ['content-items', selected] })
  }

  /** A 键：直接执行不弹窗（批量流不打断），成功闪一条轻提示，焦点跳到下一条待审。 */
  const approveAt = useCallback(async (idx: number) => {
    const a = videos[idx]
    if (!a || a.status !== 'draft') return
    try {
      await approveOne(a.id)
      showFlash(a.id, '已通过 ✓')
      invalidate()
    } catch (e) {
      setNotice({ title: `成片 #${a.id} 通过失败`, lines: [e instanceof Error ? e.message : String(e)] })
      return
    }
    // 下一条「待审」优先；没有就单纯下移一格
    const nextPending = videos.findIndex((v, i) => i > idx && v.status === 'draft' && !rejectedIds.includes(v.id))
    setFocusIdx(nextPending >= 0 ? nextPending : Math.min(idx + 1, videos.length - 1))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videos, rejectedIds, approveOne, showFlash])

  const openEditor = useCallback((a: Asset) => {
    const itemId = itemByAsset.get(a.id)
    if (itemId == null) {
      setNotice({ title: `成片 #${a.id} 无法进剪辑台`, lines: ['这条成片在本项目的内容队列里找不到出处（跨项目的库、或实拍上传的成片没有内容条目）。'] })
      return
    }
    onOpenInEditor(itemId)
  }, [itemByAsset, onOpenInEditor])

  // 键盘：成片库 tab 激活时才挂（本组件只在该 tab 渲染）；输入框内与弹层开着时旁路；卸载清理。
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.ctrlKey || e.metaKey || e.altKey) return
      const t = e.target as HTMLElement | null
      const tag = t?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t?.isContentEditable) return
      if (e.key === '?') { e.preventDefault(); setHelpOpen((v) => !v); return }
      if (e.key === 'Escape' && helpOpen) { e.preventDefault(); setHelpOpen(false); return }
      if (blockedRef.current) return
      const k = e.key.toLowerCase()
      if (k === 'j') { e.preventDefault(); setFocusIdx((i) => Math.min(i + 1, Math.max(0, videos.length - 1))) }
      else if (k === 'k') { e.preventDefault(); setFocusIdx((i) => Math.max(0, i - 1)) }
      else if (e.key === ' ') {
        e.preventDefault() // 防空格滚页
        const a = videos[focusIdx]
        if (!a) return
        const v = videoRefs.current.get(a.id)
        if (v) { if (v.paused) void v.play().catch(() => {}); else v.pause() }
      } else if (k === 'a') { e.preventDefault(); void approveAt(focusIdx) }
      else if (k === 'r') {
        e.preventDefault()
        const a = videos[focusIdx]
        if (!a) return
        setRejectedIds((ids) => (ids.includes(a.id) ? ids : [...ids, a.id]))
        showFlash(a.id, '已打回')
        setFocusIdx((i) => Math.min(i + 1, Math.max(0, videos.length - 1)))
      } else if (k === 'e') {
        e.preventDefault()
        const a = videos[focusIdx]
        if (a) openEditor(a)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [videos, focusIdx, helpOpen, approveAt, openEditor, showFlash])

  async function upload(file: File) {
    setUploading(true)
    try {
      const fd = new FormData()
      fd.append('file', file)
      const res = await fetch(`/api/projects/${selected}/upload-video`, { method: 'POST', body: fd })
      if (!res.ok) alert(`上传失败: ${await res.text()}`)
      invalidate()
    } finally {
      setUploading(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  const checkedAssets = videos.filter((v) => checkedIds.includes(v.id))

  /** 批量通过：逐个 PATCH，失败逐条列出（不整批回滚——已通过的就是通过了，要如实告诉用户）。 */
  async function bulkApprove() {
    setBusy(true)
    const fails: string[] = []
    let ok = 0
    let skipped = 0
    for (const a of checkedAssets) {
      if (a.status !== 'draft') { skipped += 1; continue }
      try { await approveOne(a.id); ok += 1; showFlash(a.id, '已通过 ✓') } catch (e) {
        fails.push(`#${a.id}：${e instanceof Error ? e.message : String(e)}`)
      }
    }
    invalidate()
    setBusy(false)
    setNotice({
      title: `批量通过：成功 ${ok} 条${fails.length ? `，失败 ${fails.length} 条` : ''}`,
      lines: [...(skipped ? [`跳过 ${skipped} 条（不是待审状态）`] : []), ...fails],
    })
    if (!fails.length) setCheckedIds([])
  }

  /** 批量重渲：只有带素材包（spec_path）的能走 renderFromSpec；混选时如实报告跳过了几条。 */
  async function bulkRerender() {
    const renderable = checkedAssets.filter((a) => !!a.spec_path)
    const skipped = checkedAssets.length - renderable.length
    if (renderable.length === 0) {
      setNotice({ title: '没有可重渲的成片', lines: [`选中的 ${checkedAssets.length} 条都没有素材包（实拍上传或改造前生成的历史视频），只能重新走一遍出片流程。`] })
      return
    }
    setBusy(true)
    const fails: string[] = []
    let ok = 0
    for (const a of renderable) {
      try {
        await api<{ taskId: string }>(`/api/projects/${selected}/specs/${videoIdFromSpecPath(a.spec_path!)}/render`, { method: 'POST' })
        ok += 1
      } catch (e) {
        fails.push(`#${a.id}：${e instanceof Error ? e.message : String(e)}`)
      }
    }
    invalidate()
    setBusy(false)
    setNotice({
      title: `批量重渲：已入队 ${ok} 条${fails.length ? `，失败 ${fails.length} 条` : ''}`,
      lines: [...(skipped ? [`跳过 ${skipped} 条（没有素材包，不能从剪辑台重渲）`] : []), ...fails],
    })
    if (!fails.length) setCheckedIds([])
  }

  return (
    <div className="space-y-4">
      <div className="card flex items-center gap-3 p-4">
        <input ref={fileRef} type="file" accept=".mp4,.mov,.m4v" className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f) }} />
        {/* 一屏唯一黑实心按钮（§7 规则 1） */}
        <button className="rounded-[var(--fc-r-sm)] bg-[var(--fc-ink)] px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-40"
          disabled={!selected || uploading} onClick={() => fileRef.current?.click()}>
          {uploading ? '上传中…' : '上传成片（mp4/mov）'}
        </button>
        <p className="text-xs text-faint">渲染成片和实拍成片都在这里审。J/K 上下条 · Space 播放 · A 通过 · R 打回 · E 进剪辑台。</p>
        <button className={`ml-auto ${OUTLINE_XS}`} onClick={() => setHelpOpen(true)}>快捷键 ?</button>
      </div>

      {checkedIds.length > 0 && (
        // 批量条：高 28（§3 控件高度表），吸顶；动作全描边
        <div className="sticky top-0 z-20 flex h-7 items-center gap-2 rounded-[var(--fc-r-sm)] border border-[var(--fc-line-2)] bg-[var(--fc-surface-2)] px-2">
          <span className="font-mono text-[11px] text-[var(--fc-muted)]">已选 {checkedIds.length}</span>
          <button className={OUTLINE_XS} disabled={busy} onClick={bulkApprove}>批量通过</button>
          <button className={OUTLINE_XS} disabled={busy} onClick={bulkRerender}>批量重渲</button>
          <button className={`ml-auto ${OUTLINE_XS}`} disabled={busy} onClick={() => setCheckedIds([])}>清除选择</button>
        </div>
      )}

      {notice && (
        <div className="rounded-[var(--fc-r-sm)] border border-[var(--fc-line-2)] bg-[var(--fc-surface)] p-3 text-xs">
          <div className="flex items-center gap-2">
            <span className="font-bold text-[var(--fc-ink)]">{notice.title}</span>
            <button className={`ml-auto ${OUTLINE_XS}`} onClick={() => setNotice(null)}>知道了</button>
          </div>
          {notice.lines.length > 0 && (
            <ul className="mt-1.5 space-y-0.5 text-[var(--fc-muted)]">
              {notice.lines.map((l, i) => <li key={i}>· {l}</li>)}
            </ul>
          )}
        </div>
      )}

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

      {/* 6 列网格：容器宽不足时按 210px 下限自动降列（观感对齐 1440 下的 6 列） */}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(210px,1fr))] gap-3.5">
        {videos.map((a, i) => (
          <VideoCard
            key={a.id} asset={a} index={i}
            focused={i === focusIdx}
            checked={checkedIds.includes(a.id)}
            rejected={rejectedIds.includes(a.id)}
            flash={flash[a.id] ?? null}
            expanded={expandedId === a.id}
            canEdit={itemByAsset.has(a.id)}
            scriptAssets={scriptAssets}
            onFocus={setFocusIdx}
            onToggleCheck={(id) => setCheckedIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]))}
            onToggleExpand={(id) => setExpandedId((cur) => (cur === id ? null : id))}
            onApprove={(idx) => { setFocusIdx(idx); void approveAt(idx) }}
            onDelete={onDelete}
            onOpenEditor={openEditor}
            confirm={confirm}
            registerVideo={(id, el) => { if (el) videoRefs.current.set(id, el); else videoRefs.current.delete(id) }}
            registerCard={(id, el) => { if (el) cardRefs.current.set(id, el); else cardRefs.current.delete(id) }}
          />
        ))}
      </div>

      {helpOpen && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center" style={{ background: 'rgba(24,26,22,0.45)' }}
          onClick={() => setHelpOpen(false)}>
          <div className="w-[360px] rounded-[var(--fc-r-sm)] bg-[var(--fc-surface)] p-4 shadow-xl" role="dialog" aria-modal="true"
            onClick={(e) => e.stopPropagation()}>
            <div className="text-sm font-bold text-[var(--fc-ink)]">批量审片快捷键</div>
            <ul className="mt-2 space-y-1">
              {SHORTCUTS.map(([k, desc]) => (
                <li key={k} className="flex items-center gap-2 text-xs text-[var(--fc-muted)]">
                  <kbd className="inline-flex h-5 min-w-8 items-center justify-center rounded-[var(--fc-r-xs)] border border-[var(--fc-line-2)] px-1 font-mono text-[10px] text-[var(--fc-ink)]">{k}</kbd>
                  <span>{desc}</span>
                </li>
              ))}
            </ul>
            <div className="mt-4 flex justify-end">
              <button className={OUTLINE_XS} onClick={() => setHelpOpen(false)}>关闭</button>
            </div>
          </div>
        </div>
      )}
      {confirmEl}
    </div>
  )
}
