import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, subscribeTask, type AutoScoutStatus, type Candidate } from '../api'
import CandidateCard from './board/CandidateCard'
import CandidateDrawer from './board/CandidateDrawer'

type Tab = 'all' | 'fav' | 'daily'
const TABS: Array<{ key: Tab; label: string }> = [
  { key: 'all', label: '全部' }, { key: 'fav', label: '已收藏' }, { key: 'daily', label: '每日新增' },
]

/** SQLite datetime('now') 存的是无时区 UTC 串（YYYY-MM-DD HH:MM:SS）→ 本地日期 YYYY-MM-DD */
function localDay(utc: string | null): string {
  if (!utc) return ''
  const d = new Date(utc.includes('T') ? utc : utc.replace(' ', 'T') + 'Z')
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('sv-SE')
}
function dayLabel(day: string, today: string): string {
  if (day === today) return '今天'
  const t = new Date(today + 'T00:00:00')
  t.setDate(t.getDate() - 1)
  if (day === t.toLocaleDateString('sv-SE')) return '昨天'
  const [, m, dd] = day.split('-')
  return `${Number(m)}月${Number(dd)}日`
}

export default function ScoutPage() {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [logs, setLogs] = useState<string[]>([])
  const [scanning, setScanning] = useState(false)
  const logRef = useRef<HTMLDivElement>(null)
  const [tab, setTab] = useState<Tab>('all')
  const [detailId, setDetailId] = useState<number | null>(null)

  const candidates = useQuery({ queryKey: ['candidates'], queryFn: () => api<Candidate[]>('/api/candidates') })
  const autoStatus = useQuery({ queryKey: ['auto-scout'], queryFn: () => api<AutoScoutStatus>('/api/scout/auto-status') })

  const [pickingRepos, setPickingRepos] = useState<Set<string>>(new Set())
  const pick = useMutation({
    mutationFn: (repo: string) => api<{ slug: string }>('/api/candidates/pick', { method: 'POST', body: JSON.stringify({ repo }) }),
    onMutate: (repo) => setPickingRepos((prev) => new Set(prev).add(repo)),
    onSuccess: ({ slug }) => {
      qc.invalidateQueries({ queryKey: ['candidates'] })
      qc.invalidateQueries({ queryKey: ['projects'] })
      navigate(`/projects/${slug}`)
    },
    onError: (e) => alert(`立项失败: ${e instanceof Error ? e.message : String(e)}`),
    onSettled: (_d, _e, repo) => setPickingRepos((prev) => { const next = new Set(prev); next.delete(repo); return next }),
  })
  const [rescoringIds, setRescoringIds] = useState<Set<number>>(new Set())
  const rescore = useMutation({
    mutationFn: (id: number) => api<{ ok: boolean; mode: string }>(`/api/candidates/${id}/rescore`, { method: 'POST' }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['candidates'] })
      if (r.mode === 'mock') alert('当前是 mock 模式，评分不会产生目标群体/行业痛点。去「设置」把大模型切到 live 并填 key。')
    },
    onMutate: (id) => setRescoringIds((prev) => new Set(prev).add(id)),
    onError: (e) => alert(`重新评分失败: ${e instanceof Error ? e.message : String(e)}`),
    onSettled: (_d, _e, id) => setRescoringIds((prev) => { const next = new Set(prev); next.delete(id); return next }),
  })
  const [favPendingIds, setFavPendingIds] = useState<Set<number>>(new Set())
  const favorite = useMutation({
    mutationFn: (c: Candidate) => api(`/api/candidates/${c.id}/favorite`, { method: 'POST', body: JSON.stringify({ favorite: !c.favorite }) }),
    onMutate: (c) => setFavPendingIds((prev) => new Set(prev).add(c.id)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['candidates'] }),
    onError: (e) => alert(`收藏失败: ${e instanceof Error ? e.message : String(e)}`),
    onSettled: (_d, _e, c) => setFavPendingIds((prev) => { const next = new Set(prev); next.delete(c.id); return next }),
  })

  async function scout() {
    if (scanning) return
    setScanning(true); setLogs([])
    try {
      const { taskId } = await api<{ taskId: string }>('/api/scout', { method: 'POST', body: '{}' })
      subscribeTask(taskId, (e) => {
        setLogs((l) => [...l, e.message]); logRef.current?.scrollTo({ top: 999999 })
        if (e.type === 'done' || e.type === 'error') { setScanning(false); qc.invalidateQueries({ queryKey: ['candidates'] }) }
      })
    } catch (err) { setLogs((l) => [...l, `❌ ${err instanceof Error ? err.message : String(err)}`]); setScanning(false) }
  }
  const [rescoringAll, setRescoringAll] = useState(false)
  async function rescoreAll() {
    if (rescoringAll || scanning) return
    const n = (candidates.data ?? []).filter((c) => {
      try { return !(c.score_detail && (JSON.parse(c.score_detail) as any)?.targetBuyer) } catch { return true }
    }).length
    if (n === 0) { alert('候选都已真评过，无需批量评分'); return }
    if (!window.confirm(`将对 ${n} 个未评候选真评分，消耗 key 额度、耗时较长（每个几秒），继续？`)) return
    setRescoringAll(true); setLogs([])
    try {
      const { taskId } = await api<{ taskId: string }>('/api/candidates/rescore-all', { method: 'POST' })
      subscribeTask(taskId, (e) => {
        setLogs((l) => [...l, e.message]); logRef.current?.scrollTo({ top: 999999 })
        if (e.type === 'done' || e.type === 'error') { setRescoringAll(false); qc.invalidateQueries({ queryKey: ['candidates'] }) }
      })
    } catch (err) { setLogs((l) => [...l, `❌ ${err instanceof Error ? err.message : String(err)}`]); setRescoringAll(false) }
  }
  const [cat, setCat] = useState<string | null>(null)
  const catOf = (c: { score_detail: string | null }): string => {
    try { return (c.score_detail && (JSON.parse(c.score_detail) as any)?.category) || '' } catch { return '' }
  }
  async function backfillCats() {
    try {
      const r = await api<{ updated: number }>('/api/candidates/backfill-categories', { method: 'POST' })
      alert(`已回填 ${r.updated} 个候选的领域分类`); qc.invalidateQueries({ queryKey: ['candidates'] })
    } catch (e) { alert('回填失败：' + (e instanceof Error ? e.message : String(e))) }
  }

  const rows = candidates.data ?? []
  const today = new Date().toLocaleDateString('sv-SE')
  const ok = rows.filter((c) => c.license_ok === 1)
  const blocked = rows.filter((c) => c.license_ok !== 1)
  const catCounts = new Map<string, number>()
  for (const c of ok) { const k = catOf(c); if (k) catCounts.set(k, (catCounts.get(k) ?? 0) + 1) }
  const byCat = (list: Candidate[]) => (cat ? list.filter((c) => catOf(c) === cat) : list)
  const byScore = (a: Candidate, b: Candidate) => (b.score ?? -1) - (a.score ?? -1)
  // 全部：收藏置顶（收藏内部与其余各按分数降序）
  const allShown = byCat(ok).sort((a, b) => (b.favorite - a.favorite) || byScore(a, b))
  const favShown = ok.filter((c) => c.favorite === 1).sort(byScore)
  // 每日新增：近 14 天入库的可商用候选，按本地日期倒序分组
  const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 14)
  const dailyGroups = [...byCat(ok)
    .map((c) => ({ c, day: localDay(c.created_at) }))
    .filter((x) => x.day && new Date(x.day) >= cutoff)
    .reduce((m, x) => { (m.get(x.day) ?? m.set(x.day, []).get(x.day)!).push(x.c); return m }, new Map<string, Candidate[]>())
    .entries()].sort((a, b) => b[0].localeCompare(a[0]))
    .map(([day, list]) => [day, list.sort(byScore)] as const)

  const detail = detailId == null ? null : rows.find((c) => c.id === detailId) ?? null
  const auto = autoStatus.data
  const lastText = !auto?.lastRun ? '尚未运行'
    : auto.lastResult && 'error' in (auto.lastResult) && auto.lastResult.error ? `${auto.lastRun} 失败：${auto.lastResult.error}`
    : `${auto.lastRun} 新增 ${auto.lastResult?.added ?? 0} 个`
  const grid = 'grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4'
  const card = (c: Candidate) => (
    <CandidateCard key={c.id} c={c} isNew={localDay(c.created_at) === today}
      onOpenDetail={(x) => setDetailId(x.id)} onToggleFavorite={(x) => favorite.mutate(x)}
      favPending={favPendingIds.has(c.id)} />
  )
  return (
    <div className="space-y-4">
      <h1 className="text-[26px] font-black tracking-tight text-ink">
        找项目<span className="ml-3 text-xs font-normal text-faint">从 GitHub 矿脉里挑能换钱的坯料</span>
      </h1>
      <div className="flex items-center gap-3">
        <button className="btn-fire px-4 py-2 text-sm disabled:opacity-50" disabled={scanning || rescoringAll} onClick={scout}>
          {scanning ? '抓取中…' : '抓取候选'}
        </button>
        <button className="btn-ink px-4 py-2 text-sm disabled:opacity-50" disabled={scanning || rescoringAll} onClick={rescoreAll}>
          {rescoringAll ? '评分中…' : '全部重新评分'}
        </button>
        <button className="btn-ink px-4 py-2 text-sm disabled:opacity-50" disabled={scanning || rescoringAll} onClick={backfillCats}>
          分类回填
        </button>
        <span className="text-sm text-sub">共 {rows.length} 个候选</span>
        <span className="ml-auto text-xs text-faint">
          {auto ? (auto.enabled ? `每日 ${auto.time} 进料 · 上次：${lastText}` : '每日进料已关（设置页可开）') : ''}
        </span>
      </div>

      <div className="seg-tabs">
        {TABS.map((t) => (
          <button key={t.key}
            className={tab === t.key ? 'on' : ''}
            onClick={() => setTab(t.key)}>
            {t.label}{t.key === 'fav' ? ` (${favShown.length})` : ''}
          </button>
        ))}
      </div>

      {tab !== 'fav' && catCounts.size > 0 && (
        <div className="flex flex-wrap gap-2 text-xs">
          <button className={`rounded-full px-3 py-1 ${cat === null ? 'border-[1.5px] border-fire bg-fire-soft font-bold text-fire' : 'border-[1.5px] border-hairline text-sub'}`} onClick={() => setCat(null)}>全部 ({ok.length})</button>
          {[...catCounts.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => (
            <button key={k} className={`rounded-full px-3 py-1 ${cat === k ? 'border-[1.5px] border-fire bg-fire-soft font-bold text-fire' : 'border-[1.5px] border-hairline text-sub'}`} onClick={() => setCat(k)}>{k} ({n})</button>
          ))}
        </div>
      )}

      {logs.length > 0 && (
        <div ref={logRef} className="h-32 space-y-1 overflow-y-auto rounded-lg border bg-neutral-900 p-3 font-mono text-xs text-green-400">
          {logs.map((l, i) => <div key={i}>{l}</div>)}
        </div>
      )}

      {tab === 'all' && (
        <>
          <div className={grid}>{allShown.map(card)}</div>
          {rows.length === 0 && <div className="rounded-lg border-2 border-dashed border-hairline p-6 text-center text-faint">暂无候选，点「抓取候选」</div>}
          {blocked.length > 0 && (
            <details className="rounded-lg bg-transparent border-[1.5px] border-hairline p-3 text-sm text-sub">
              <summary className="cursor-pointer">另有 {blocked.length} 个协议不可商用（GPL/AGPL 系），点开查看</summary>
              <div className="mt-2 space-y-1">
                {blocked.map((c) => (
                  <div key={c.id} className="flex gap-2 text-xs">
                    <a className="text-sub" href={c.url} target="_blank" rel="noreferrer">{c.repo}</a>
                    <span className="text-faint">{c.license ?? '无协议'}</span>
                  </div>
                ))}
              </div>
            </details>
          )}
        </>
      )}
      {tab === 'fav' && (
        favShown.length
          ? <div className={grid}>{favShown.map(card)}</div>
          : <div className="rounded-lg border-2 border-dashed border-hairline p-6 text-center text-faint">还没有收藏，点卡片上的 ☆ 收藏感兴趣的项目</div>
      )}
      {tab === 'daily' && (
        dailyGroups.length
          ? dailyGroups.map(([day, list]) => (
              <div key={day}>
                <div className="mb-2 text-sm font-bold text-ink">{dayLabel(day, today)} <span className="text-faint">({list.length})</span></div>
                <div className={grid}>{list.map(card)}</div>
              </div>
            ))
          : <div className="rounded-lg border-2 border-dashed border-hairline p-6 text-center text-faint">近 14 天没有新入库的候选（每日自动抓取会把新发现的项目归到这里）</div>
      )}

      {detail && (
        <CandidateDrawer candidate={detail} onClose={() => setDetailId(null)}
          onPick={(repo) => pick.mutate(repo)} onRescore={(id) => rescore.mutate(id)}
          onToggleFavorite={(c) => favorite.mutate(c)}
          picking={pickingRepos.has(detail.repo)} rescoring={rescoringIds.has(detail.id)}
          favPending={favPendingIds.has(detail.id)} />
      )}
    </div>
  )
}
