import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { api, listIndustries, type AutoScoutStatus, type Candidate, type Industry } from '../api'
import TaskProgress from '../components/TaskProgress'
import { useConfirm } from '../components/ui/Confirm'
import { useTaskRun } from '../useTaskRun'
import CandidateCard from './board/CandidateCard'
import CandidateDrawer from './board/CandidateDrawer'
import DualTrackView from './board/DualTrackView'

type Tab = 'all' | 'fav' | 'daily' | 'manual' | 'dual'
const TABS: Array<{ key: Tab; label: string }> = [
  { key: 'all', label: '全部' }, { key: 'fav', label: '已收藏' }, { key: 'daily', label: '每日新增' }, { key: 'manual', label: '自主投喂' },
  { key: 'dual', label: '双轨评分' },
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

/** `/api/scout` 任务 done 事件带回的计数。skippedTemplate/skippedShallow 是判断门槛松紧的唯一依据：
 *  前者＝被模板/脚手架硬排挡掉，后者＝业务含量低于门槛（连候选都没建）。 */
interface ScoutSummary {
  found: number; scored: number; rejected: number; added: number
  skippedTemplate: number; skippedShallow: number
}
/** done 事件的 result 是 unknown（服务端原样回传），这里逐字段收窄，缺字段就当这次没有计数可显示。 */
function parseScoutSummary(result: unknown): ScoutSummary | null {
  if (!result || typeof result !== 'object') return null
  const o = result as Record<string, unknown>
  const n = (k: string) => (typeof o[k] === 'number' ? (o[k] as number) : null)
  const found = n('found'), scored = n('scored'), rejected = n('rejected'), added = n('added')
  const skippedTemplate = n('skippedTemplate'), skippedShallow = n('skippedShallow')
  if (found === null || scored === null || rejected === null || added === null
    || skippedTemplate === null || skippedShallow === null) return null
  return { found, scored, rejected, added, skippedTemplate, skippedShallow }
}

export default function ScoutPage({ onOpenProject }: { onOpenProject: (slug: string) => void }) {
  const qc = useQueryClient()
  const { confirm, element: confirmEl } = useConfirm()
  const logRef = useRef<HTMLDivElement>(null)
  const [tab, setTab] = useState<Tab>('all')
  const [detailId, setDetailId] = useState<number | null>(null)

  const [activeKey, setActiveKey] = useState<'scout' | 'breakout' | 'rescore' | 'backfill' | 'addUrl'>('scout')
  const scoutRun = useTaskRun()
  const breakoutRun = useTaskRun()
  const rescoreAllRun = useTaskRun()
  const backfillRun = useTaskRun()
  const addUrlRun = useTaskRun()
  const runs = { scout: scoutRun, breakout: breakoutRun, rescore: rescoreAllRun, backfill: backfillRun, addUrl: addUrlRun }
  const activeRun = runs[activeKey]
  // 任一长任务在跑时，其余按钮统一禁用（沿用原先各 handler 里的互斥守卫）
  const busy = scoutRun.running || breakoutRun.running || rescoreAllRun.running || backfillRun.running
  useEffect(() => { logRef.current?.scrollTo({ top: 999999 }) }, [activeRun.logs.length])

  const candidates = useQuery({ queryKey: ['candidates'], queryFn: () => api<Candidate[]>('/api/candidates') })
  const industries = useQuery({ queryKey: ['industries'], queryFn: listIndustries })
  const indList: Industry[] = industries.data ?? []
  const indName = new Map(indList.map((i) => [i.id, i.name]))
  // 行业筛选：null＝全部；'none'＝未归属（回落抓取/手动投喂/旧候选）；数字＝该行业
  const [indFilter, setIndFilter] = useState<number | 'none' | null>(null)
  // 「开始选品」勾选的行业子集；null＝弹层没开。默认全选启用行业，全选时按空数组发（＝服务端"全部启用"语义）
  const [scoutPick, setScoutPick] = useState<Set<number> | null>(null)
  const [scoutSummary, setScoutSummary] = useState<ScoutSummary | null>(null)
  const autoStatus = useQuery({ queryKey: ['auto-scout'], queryFn: () => api<AutoScoutStatus>('/api/scout/auto-status') })

  const [pickingRepos, setPickingRepos] = useState<Set<string>>(new Set())
  const pick = useMutation({
    mutationFn: (repo: string) => api<{ slug: string }>('/api/candidates/pick', { method: 'POST', body: JSON.stringify({ repo }) }),
    onMutate: (repo) => setPickingRepos((prev) => new Set(prev).add(repo)),
    onSuccess: ({ slug }) => {
      qc.invalidateQueries({ queryKey: ['candidates'] })
      qc.invalidateQueries({ queryKey: ['projects'] })
      onOpenProject(slug)
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

  /** 带行业子集跑选品。ids 为空数组＝全部启用行业（服务端语义），所以全选和不选都只是不带筛选。 */
  function scout(ids: number[]) {
    setActiveKey('scout')
    setScoutSummary(null)
    setScoutPick(null)
    const enabledIds = indList.filter((i) => i.enabled).map((i) => i.id)
    // 全选＝不带 industryIds，交给服务端按"全部启用行业"跑（用户之后改了启停也不会被这次的快照锁死）
    const body = ids.length && ids.length < enabledIds.length ? JSON.stringify({ industryIds: ids }) : '{}'
    scoutRun.run(
      async () => (await api<{ taskId: string }>('/api/scout', { method: 'POST', body })).taskId,
      (ok, e) => {
        qc.invalidateQueries({ queryKey: ['candidates'] })
        if (ok) setScoutSummary(parseScoutSummary(e?.result))
      },
    )
  }
  function openScoutPick() {
    setScoutPick(new Set(indList.filter((i) => i.enabled).map((i) => i.id)))
  }
  function scoutBreakouts() {
    setActiveKey('breakout')
    breakoutRun.run(
      async () => (await api<{ taskId: string }>('/api/scout/breakouts', { method: 'POST', body: '{}' })).taskId,
      () => qc.invalidateQueries({ queryKey: ['candidates'] }),
    )
  }
  async function rescoreAll() {
    const n = (candidates.data ?? []).filter((c) => {
      try { return !(c.score_detail && (JSON.parse(c.score_detail) as any)?.targetBuyer) } catch { return true }
    }).length
    if (n === 0) { alert('候选都已真评过，无需批量评分'); return }
    if (!(await confirm({ title: `真评分 ${n} 个未评候选？`, body: '消耗 key 额度、耗时较长（每个几秒），继续？' }))) return
    setActiveKey('rescore')
    rescoreAllRun.run(
      async () => (await api<{ taskId: string }>('/api/candidates/rescore-all', { method: 'POST' })).taskId,
      () => qc.invalidateQueries({ queryKey: ['candidates'] }),
    )
  }
  function backfillSummary() {
    setActiveKey('backfill')
    backfillRun.run(
      async () => (await api<{ taskId: string }>('/api/candidates/backfill-summary', { method: 'POST' })).taskId,
      () => qc.invalidateQueries({ queryKey: ['candidates'] }),
    )
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
  const [addUrlOpen, setAddUrlOpen] = useState(false)
  const [addUrl, setAddUrl] = useState('')
  function addUrlSubmit() {
    const url = addUrl.trim()
    if (!url) return
    setAddUrlOpen(false); setAddUrl('')
    setActiveKey('addUrl')
    addUrlRun.run(
      async () => (await api<{ taskId: string }>('/api/candidates/add', { method: 'POST', body: JSON.stringify({ url }) })).taskId,
      () => qc.invalidateQueries({ queryKey: ['candidates'] }),
    )
  }

  const rows = candidates.data ?? []
  const today = new Date().toLocaleDateString('sv-SE')
  const ok = rows.filter((c) => c.license_ok === 1 && c.status !== 'dismissed')
  const blocked = rows.filter((c) => c.license_ok !== 1)
  const dismissed = rows.filter((c) => c.license_ok === 1 && c.status === 'dismissed')
  const catCounts = new Map<string, number>()
  for (const c of ok) { const k = catOf(c); if (k) catCounts.set(k, (catCounts.get(k) ?? 0) + 1) }
  const byCat = (list: Candidate[]) => (cat ? list.filter((c) => catOf(c) === cat) : list)
  const byInd = (list: Candidate[]) => (
    indFilter === null ? list
      : indFilter === 'none' ? list.filter((c) => c.industry_id == null || !indName.has(c.industry_id))
      : list.filter((c) => c.industry_id === indFilter)
  )
  const shown = (list: Candidate[]) => byInd(byCat(list))
  // 行业 chip 上的计数按可商用候选算（与分类 chip 同口径）
  const indCount = (i: Industry) => ok.filter((c) => c.industry_id === i.id).length
  const noIndCount = ok.filter((c) => c.industry_id == null || !indName.has(c.industry_id)).length
  const byScore = (a: Candidate, b: Candidate) => (b.score ?? -1) - (a.score ?? -1)
  // 全部：收藏置顶（收藏内部与其余各按分数降序）
  const allShown = shown(ok).sort((a, b) => (b.favorite - a.favorite) || byScore(a, b))
  const favShown = ok.filter((c) => c.favorite === 1).sort(byScore)
  // 自主投喂：用户手动「+ 投喂」进来的（source='manual'），不受协议门槛过滤——投喂时已强制放行
  const manualShown = rows.filter((c) => c.source === 'manual').sort((a, b) => (b.favorite - a.favorite) || byScore(a, b))
  // 每日新增：近 14 天入库的可商用候选，按本地日期倒序分组
  const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 14)
  const dailyGroups = [...shown(ok)
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
  const chipCls = (on: boolean) => `rounded-full px-3 py-1 border-[1.5px] ${on ? 'border-fire bg-fire-soft font-bold text-fire' : 'border-hairline text-sub'}`
  const card = (c: Candidate) => (
    <CandidateCard key={c.id} c={c} isNew={localDay(c.created_at) === today}
      industryName={c.industry_id == null ? undefined : indName.get(c.industry_id)}
      onOpenDetail={(x) => setDetailId(x.id)} onToggleFavorite={(x) => favorite.mutate(x)}
      favPending={favPendingIds.has(c.id)} />
  )
  return (
    <div className="space-y-4">
      <h1 className="text-[26px] font-black tracking-tight text-ink">
        找项目<span className="ml-3 text-xs font-normal text-faint">从 GitHub 矿脉里挑能换钱的坯料</span>
      </h1>
      <div className="flex items-center gap-3">
        <button className="btn-fire px-4 py-2 text-sm disabled:opacity-50" disabled={busy} onClick={openScoutPick}>
          {scoutRun.running ? '抓取中…' : '抓取候选'}
        </button>
        <button className="btn-fire px-4 py-2 text-sm disabled:opacity-50" disabled={busy} onClick={scoutBreakouts}>
          {breakoutRun.running ? '检测中…' : '🔥 找爆款'}
        </button>
        <button className="btn-ink px-4 py-2 text-sm disabled:opacity-50" disabled={busy} onClick={rescoreAll}>
          {rescoreAllRun.running ? '评分中…' : '全部重新评分'}
        </button>
        <button className="btn-ink px-4 py-2 text-sm disabled:opacity-50" disabled={busy} onClick={backfillCats}>
          分类回填
        </button>
        <button className="btn-ink px-4 py-2 text-sm disabled:opacity-50" disabled={busy} onClick={backfillSummary}>
          {backfillRun.running ? '生成中…' : '补中文简介'}
        </button>
        <button className="btn-ink px-4 py-2 text-sm disabled:opacity-50" disabled={busy} onClick={() => setAddUrlOpen(true)}>
          + 投喂
        </button>
        <TaskProgress run={activeRun} className="max-w-[420px]" />
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
            {t.label}{t.key === 'fav' ? ` (${favShown.length})` : t.key === 'manual' ? ` (${manualShown.length})` : ''}
          </button>
        ))}
      </div>

      {/* 行业筛选：行业锚定选品把候选归到行业上，这一行按行业筛；「未归属」＝回落抓取/手动投喂/旧候选 */}
      {indList.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="text-faint">行业</span>
          <button className={chipCls(indFilter === null)} onClick={() => setIndFilter(null)}>全部 ({ok.length})</button>
          {indList.filter((i) => i.enabled).map((i) => (
            <button key={i.id} className={chipCls(indFilter === i.id)} onClick={() => setIndFilter(i.id)}>
              {i.name} ({indCount(i)})
            </button>
          ))}
          {noIndCount > 0 && (
            <button className={chipCls(indFilter === 'none')} onClick={() => setIndFilter('none')}>未归属 ({noIndCount})</button>
          )}
        </div>
      )}

      {/* 本次选品的拦截计数——判断门槛松紧的唯一依据（日志滚过去就没了，这里留到下次跑） */}
      {scoutSummary && (
        <div className="rounded-lg border-[1.5px] border-hairline p-3 text-xs text-sub">
          本次选品：发现 {scoutSummary.found} 个 · 入库 {scoutSummary.added} · 评分 {scoutSummary.scored} ·
          协议不过 {scoutSummary.rejected} ·
          <b className="mx-1 text-ink">模板/脚手架挡掉 {scoutSummary.skippedTemplate}</b>·
          <b className="mx-1 text-ink">业务含量不足挡掉 {scoutSummary.skippedShallow}</b>
          <span className="ml-1 text-faint">（挡太多＝门槛偏严，可去设置页调「业务含量上限」权重；挡太少＝行业搜索词太泛，去设置页重新生成）</span>
        </div>
      )}

      {tab !== 'fav' && catCounts.size > 0 && (
        <div className="flex flex-wrap gap-2 text-xs">
          <button className={`rounded-full px-3 py-1 ${cat === null ? 'border-[1.5px] border-fire bg-fire-soft font-bold text-fire' : 'border-[1.5px] border-hairline text-sub'}`} onClick={() => setCat(null)}>全部 ({ok.length})</button>
          {[...catCounts.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => (
            <button key={k} className={`rounded-full px-3 py-1 ${cat === k ? 'border-[1.5px] border-fire bg-fire-soft font-bold text-fire' : 'border-[1.5px] border-hairline text-sub'}`} onClick={() => setCat(k)}>{k} ({n})</button>
          ))}
        </div>
      )}

      {activeRun.logs.length > 0 && (
        <div ref={logRef} className="h-32 space-y-1 overflow-y-auto rounded-lg border bg-neutral-900 p-3 font-mono text-xs text-green-400">
          {activeRun.logs.map((l, i) => <div key={i}>{l}</div>)}
        </div>
      )}

      {tab === 'all' && (
        <>
          <div className={grid}>{allShown.map(card)}</div>
          {rows.length === 0 && <div className="rounded-lg border-2 border-dashed border-hairline p-6 text-center text-faint">暂无候选，点「抓取候选」</div>}
          {/* 有候选但被筛空：不给提示的话页面是一片空白，看不出是筛没了还是真没有 */}
          {rows.length > 0 && allShown.length === 0 && (
            <div className="rounded-lg border-2 border-dashed border-hairline p-6 text-center text-faint">当前筛选条件下没有候选——点上面的「全部」看所有。</div>
          )}
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
          {dismissed.length > 0 && (
            <details className="rounded-lg bg-transparent border-[1.5px] border-hairline p-3 text-sm text-sub">
              <summary className="cursor-pointer">另有 {dismissed.length} 个已淘汰（低分），点开查看</summary>
              <div className="mt-2 space-y-1">
                {dismissed.map((c) => (
                  <div key={c.id} className="flex gap-2 text-xs">
                    <a className="text-sub" href={c.url} target="_blank" rel="noreferrer">{c.repo}</a>
                    <span className="text-faint">{c.score ?? '—'} 分</span>
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
      {tab === 'manual' && (
        manualShown.length
          ? <div className={grid}>{manualShown.map(card)}</div>
          : <div className="rounded-lg border-2 border-dashed border-hairline p-6 text-center text-faint">还没有手动投喂过项目，点上面「+ 投喂」加一个</div>
      )}
      {tab === 'dual' && (
        <DualTrackView candidates={rows} onOpenDetail={(c) => setDetailId(c.id)}
          onPick={(repo) => pick.mutate(repo)} picking={pickingRepos} />
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
          industryName={detail.industry_id == null ? undefined : indName.get(detail.industry_id)}
          onPick={(repo) => pick.mutate(repo)} onRescore={(id) => rescore.mutate(id)}
          onToggleFavorite={(c) => favorite.mutate(c)}
          picking={pickingRepos.has(detail.repo)} rescoring={rescoringIds.has(detail.id)}
          favPending={favPendingIds.has(detail.id)} />
      )}

      {/* 开始选品：勾选参与的行业子集（默认全选启用行业）。全停用时服务端回落 DEFAULT_TOPICS，照样能跑。 */}
      {scoutPick && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setScoutPick(null)}>
          <div className="w-full max-w-md rounded-lg border-2 border-ink bg-paper p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="mb-1 font-bold text-ink">本次选品跑哪些行业？</div>
            <div className="mb-3 text-xs text-faint">只列启用的行业（停用的在设置页开）。一个都不勾＝按全部启用行业跑。</div>
            <div className="max-h-64 space-y-1 overflow-y-auto">
              {indList.filter((i) => i.enabled).map((i) => (
                <label key={i.id} className="flex items-start gap-2 text-sm">
                  <input type="checkbox" className="mt-1" checked={scoutPick.has(i.id)}
                    onChange={(e) => setScoutPick((prev) => {
                      const next = new Set(prev)
                      if (e.target.checked) next.add(i.id); else next.delete(i.id)
                      return next
                    })} />
                  <span>
                    <span className="font-medium">{i.name}</span>
                    <span className="ml-2 text-xs text-faint">{i.keywordCount} 个搜索词</span>
                  </span>
                </label>
              ))}
              {indList.filter((i) => i.enabled).length === 0 && (
                <p className="text-xs text-faint">当前没有启用的行业——直接开始会回落到内置通用搜索词，候选不归属任何行业。</p>
              )}
            </div>
            <div className="mt-3 flex justify-end gap-2">
              <button className="btn-ink px-3 py-1.5 text-sm" onClick={() => setScoutPick(null)}>取消</button>
              <button className="btn-fire px-3 py-1.5 text-sm" onClick={() => scout([...scoutPick])}>开始选品</button>
            </div>
          </div>
        </div>
      )}

      {addUrlOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setAddUrlOpen(false)}>
          <div className="w-full max-w-md rounded-lg border-2 border-ink bg-paper p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="mb-3 font-bold text-ink">投喂一个 repo</div>
            <input
              className="w-full rounded-md border-[1.5px] border-ink bg-card px-3 py-2 text-sm"
              placeholder="https://github.com/owner/repo 或 owner/repo"
              value={addUrl}
              autoFocus
              onChange={(e) => setAddUrl(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') addUrlSubmit() }}
            />
            <div className="mt-3 flex justify-end gap-2">
              <button className="btn-ink px-3 py-1.5 text-sm" onClick={() => setAddUrlOpen(false)}>取消</button>
              <button className="btn-fire px-3 py-1.5 text-sm disabled:opacity-50" disabled={!addUrl.trim()} onClick={addUrlSubmit}>投喂</button>
            </div>
          </div>
        </div>
      )}
      {confirmEl}
    </div>
  )
}
