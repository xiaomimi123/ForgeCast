import { useState } from 'react'
import type { Candidate } from '../../api'
import { parseDetail } from './CandidateCard'

/** SQLite datetime('now') 的无时区 UTC 串 → 解析成 Date（跟 ScoutPage.tsx 的 localDay 同一套解析方式） */
function toDate(utc: string | null): Date | null {
  if (!utc) return null
  const d = new Date(utc.includes('T') ? utc : utc.replace(' ', 'T') + 'Z')
  return Number.isNaN(d.getTime()) ? null : d
}
function hoursSince(utc: string | null): number | null {
  const d = toDate(utc)
  return d ? (Date.now() - d.getTime()) / 3_600_000 : null
}

/** 找项目页"双轨评分" tab：选型总纲说明卡 + 热点雷达预警卡 + 利润款/引流款两张榜单。
 *  只读 candidates 已有数据做前端筛选/分组，不发起任何新请求。 */
export default function DualTrackView({ candidates, onOpenDetail, onPick, picking }: {
  candidates: Candidate[]
  onOpenDetail: (c: Candidate) => void
  onPick: (repo: string) => void
  picking: Set<string>
}) {
  const rows = candidates.map((c) => ({ c, d: parseDetail(c.score_detail) }))
  const profitRows = rows.filter((r) => r.d?.track === 'profit').sort((a, b) => (b.d?.gapScore ?? 0) - (a.d?.gapScore ?? 0))
  const trafficRows = rows.filter((r) => r.d?.track === 'traffic').sort((a, b) => (b.d?.emotionScore ?? 0) - (a.d?.emotionScore ?? 0))

  const [dismissedHotId, setDismissedHotId] = useState<number | null>(null)
  const hot = candidates
    .filter((c) => c.source === 'scout' && c.id !== dismissedHotId)
    .map((c) => ({ c, hrs: hoursSince(c.created_at) }))
    .filter((x): x is { c: Candidate; hrs: number } => x.hrs != null && x.hrs <= 48 && x.c.stars >= 2000)
    .sort((a, b) => b.c.stars - a.c.stars)[0]?.c

  return (
    <div className="space-y-4">
      <section className="card p-4">
        <span className="eyebrow">选型总纲</span>
        <div className="mt-2 flex flex-wrap items-center gap-2.5">
          <span className="text-lg font-black text-fire">差价</span>
          <span className="text-sub">=</span>
          <span className="rounded border border-hairline-strong bg-paper px-3.5 py-1.5 font-bold">需求热度</span>
          <span className="text-sub">×</span>
          <span className="rounded border border-hairline-strong bg-paper px-3.5 py-1.5 font-bold">安装门槛</span>
          <span className="text-sub">×</span>
          <span className="rounded border border-hairline-strong bg-paper px-3.5 py-1.5 font-bold">受众小白度</span>
        </div>
        <p className="mt-2.5 text-sm text-sub">官方已出一键安装包的项目自动降权——差价被官方吃掉了。GPL / AGPL 一票否决。</p>
      </section>

      {hot && (
        <section className="card border-l-[3px] border-fire bg-fire-soft p-4">
          <span className="eyebrow text-fire">热点雷达 · 快反窗口开启</span>
          <div className="mt-1.5 flex flex-wrap items-baseline gap-2.5">
            <b>{hot.repo}</b>
            <time className="text-xs text-sub">发现于 {Math.round(hoursSince(hot.created_at) ?? 0)} 小时前 · ⭐{hot.stars}</time>
          </div>
          <div className="mt-2 flex items-center gap-2">
            <span className="text-xs font-semibold text-fire">建议 48h 内评估</span>
            <button className="btn ml-auto px-3 py-1 text-sm" onClick={() => onOpenDetail(hot)}>评估开跑</button>
            <button className="btn ghost px-3 py-1 text-sm" onClick={() => setDismissedHotId(hot.id)}>忽略</button>
          </div>
        </section>
      )}

      <section className="card p-4">
        <h3 className="mb-2 flex items-center gap-2 font-bold">利润款榜 <span className="chip">PROFIT · 交付线</span></h3>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-hairline-strong text-left text-xs text-faint">
              <th className="py-1.5">项目</th><th>差价分</th><th>门槛</th><th>出口</th><th />
            </tr>
          </thead>
          <tbody>
            {profitRows.map(({ c, d }) => {
              const blocked = c.license_ok !== 1
              return (
                <tr key={c.id} className="border-b border-hairline">
                  <td className="py-2">
                    <div className="font-bold">{c.repo}</div>
                    <div className="text-xs text-faint">{c.license ?? '无协议'}</div>
                  </td>
                  <td className="font-mono font-bold" style={{ color: blocked ? 'var(--color-faint)' : 'var(--color-fire)' }}>
                    {blocked ? '—' : (d?.gapScore ?? '—')}
                  </td>
                  <td>
                    <div className="h-1 w-16 rounded bg-hairline">
                      <div className="h-1 rounded bg-ink" style={{ width: `${blocked ? 0 : (d?.threshold ?? 0)}%` }} />
                    </div>
                  </td>
                  <td>
                    {blocked
                      ? <span className="chip veto">已淘汰</span>
                      : (d?.exitRoutes ?? []).map((r) => <span key={r} className="chip mr-1">{r}</span>)}
                  </td>
                  <td>
                    {!blocked && (
                      <button className="btn px-3 py-1 text-xs" disabled={picking.has(c.repo)} onClick={() => onPick(c.repo)}>
                        {picking.has(c.repo) ? '立项中…' : '立项'}
                      </button>
                    )}
                  </td>
                </tr>
              )
            })}
            {profitRows.length === 0 && (
              <tr><td colSpan={5} className="py-4 text-center text-faint">暂无已分轨的利润款候选</td></tr>
            )}
          </tbody>
        </table>
      </section>

      <section className="card p-4">
        <h3 className="mb-2 flex items-center gap-2 font-bold">引流款榜 <span className="chip">TRAFFIC · 仅内容线</span></h3>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-hairline-strong text-left text-xs text-faint">
              <th className="py-1.5">项目</th><th>情绪值</th><th>爽感</th><th />
            </tr>
          </thead>
          <tbody>
            {trafficRows.map(({ c, d }) => (
              <tr key={c.id} className="border-b border-hairline">
                <td className="py-2"><div className="font-bold">{c.repo}</div></td>
                <td className="font-mono font-bold text-fire">{d?.emotionScore ?? '—'}</td>
                <td>
                  <div className="h-1 w-16 rounded bg-hairline">
                    <div className="h-1 rounded bg-fire" style={{ width: `${d?.wowScore ?? 0}%` }} />
                  </div>
                </td>
                <td><button className="btn ghost px-3 py-1 text-xs" onClick={() => onOpenDetail(c)}>出内容角度</button></td>
              </tr>
            ))}
            {trafficRows.length === 0 && (
              <tr><td colSpan={4} className="py-4 text-center text-faint">暂无已分轨的引流款候选</td></tr>
            )}
          </tbody>
        </table>
        <p className="mt-2.5 text-sm text-sub">红线：不碰真人肖像 / 擦边 / 灰产。引流款不进交付排期。</p>
      </section>
    </div>
  )
}
