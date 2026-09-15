import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api, type Candidate, type IntroResponse, type SettingsView } from '../../api'
import Drawer from '../../components/Drawer'
import { Bar, buildDims, parseDetail } from './CandidateCard'
import IntroSections from './IntroSections'

/** 右侧抽屉详情：产品说明书 + 评分明细 + 操作区（立项/重评/收藏）。原 CandidateDetailModal 改造。 */
export default function CandidateDrawer({ candidate, industryName, onClose, onPick, onRescore, onToggleFavorite, picking, rescoring, favPending }: {
  candidate: Candidate; onClose: () => void
  /** 归属行业名；没有＝未归属（回落抓取/手动投喂/旧候选），不渲染标签 */
  industryName?: string
  onPick: (repo: string) => void; onRescore: (id: number) => void; onToggleFavorite: (c: Candidate) => void
  picking: boolean; rescoring: boolean; favPending: boolean
}) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [res, setRes] = useState<IntroResponse | null>(null)
  const d = parseDetail(candidate.score_detail)
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => api<SettingsView>('/api/settings') })
  // 兜底值＝当前默认权重（config.ts 的 20/30/20/30），settings 还没回来时条的分母不至于离谱
  const weights = settings.data?.scout.weights ?? { rebrandCost: 20, buyerClarity: 30, visualAppeal: 20, businessDepth: 30 }
  const dims = buildDims(weights)
  // 业务含量低分＝没通过/勉强通过门槛（门槛是权重的 40%，与服务端 businessDepthFloor 同口径），
  // 这时才把判定理由摊开给用户看——高分时理由是噪音。
  const depthLow = !!d && d.businessDepth < weights.businessDepth * 0.6

  async function load(force: boolean) {
    setLoading(true); setError(null); setRes(null)
    try {
      const r = await api<IntroResponse>(`/api/candidates/${candidate.id}/intro`, {
        method: 'POST', body: JSON.stringify({ force }),
      })
      setRes(r)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setLoading(false) }
  }

  useEffect(() => { load(false) /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [candidate.id])

  const live = res && res.mode === 'live' ? res : null

  return (
    <Drawer onClose={onClose}>
        <div className="flex items-baseline gap-2 border-b border-hairline pb-2">
          <a className="font-black text-fire" href={candidate.url} target="_blank" rel="noreferrer">{candidate.repo}</a>
          <span className="text-xs text-sub">{candidate.license ?? '—'}</span>
          {d?.category && d.category !== '其它' && (
            <span className="rounded bg-fire-soft px-1.5 py-0.5 text-xs text-fire">{d.category}</span>
          )}
          {industryName && (
            <span className="rounded border-[1.5px] border-ink px-1.5 py-0.5 text-xs font-bold">{industryName}</span>
          )}
          <button className="ml-auto text-faint hover:text-ink" onClick={onClose}>✕</button>
        </div>

        {/* 操作区：立项 / 重评 / 收藏 */}
        <div className="mt-3 flex items-center gap-2">
          {candidate.status === 'picked'
            ? <span className="text-sm text-green-600">已立项</span>
            : <button className="btn-fire px-4 py-1.5 text-sm disabled:opacity-50"
                disabled={picking} onClick={() => onPick(candidate.repo)}>{picking ? '立项中…' : '立项'}</button>}
          <button className="btn-ink px-3 py-1.5 text-sm disabled:opacity-50"
            disabled={rescoring} onClick={() => onRescore(candidate.id)}>{rescoring ? '评分中…' : '重新评分'}</button>
          <button disabled={favPending}
            className={`rounded-md border-[1.5px] px-3 py-1.5 text-sm disabled:opacity-50 ${candidate.favorite ? 'border-fire bg-fire-soft text-fire' : 'border-ink bg-card text-ink'}`}
            onClick={() => onToggleFavorite(candidate)}>{candidate.favorite ? '★ 已收藏' : '☆ 收藏'}</button>
        </div>

        {/* 评分明细（卡片上不再展示三维条，挪到这里） */}
        {d && (
          <div className="mt-3 rounded-lg border-2 border-ink bg-card p-3">
            <div className="mb-1 flex items-center gap-2 text-sm font-medium">
              评分明细 <span className="font-black text-fire">{candidate.score ?? '—'} 分</span>
            </div>
            <div className="space-y-1">
              {dims.map((dim) => <Bar key={dim.key} label={dim.label} value={d[dim.key]} max={dim.max} />)}
            </div>
            {depthLow && d.businessDepthReason && (
              <p className="mt-1 text-xs text-amber-700">业务含量偏低：{d.businessDepthReason}</p>
            )}
            {d.rationale && <p className="mt-1 text-xs text-sub">💡 {d.rationale}</p>}
            {!d.businessDepth && (
              <p className="mt-1 text-xs text-faint">这条是加「业务含量」维之前评的三维分，与新四维分不可直接比较——点上面「重新评分」按新标准重评。</p>
            )}
          </div>
        )}

        {/* loading / error / mock 提示 / live 产品说明书 */}
        {loading && <div className="py-10 text-center text-sm text-faint">生成中…（读 README + 大模型，约数秒）</div>}

        {!loading && error && (
          <div className="py-8 text-center">
            <div className="text-sm text-danger">生成失败：{error}</div>
            <button className="btn-ink mt-3 px-3 py-1 text-sm" onClick={() => load(false)}>重试</button>
          </div>
        )}

        {!loading && res?.mode === 'mock' && (
          <div className="py-8 text-center text-sm text-sub">
            详细介绍需 live 大模型生成。请先到「设置」把大模型切到 live 并填 key。
          </div>
        )}

        {!loading && live && (
          <div className="py-3">
            <IntroSections intro={live.intro} />
            <div className="mt-4 flex items-center gap-3 border-t border-hairline pt-2 text-xs text-faint">
              <span>生成于 {new Date(live.intro.generatedAt).toLocaleString()}{live.cached ? '（缓存）' : ''}</span>
              <button className="btn-ink ml-auto px-2 py-1 text-xs" onClick={() => load(true)}>重新生成</button>
            </div>
          </div>
        )}
    </Drawer>
  )
}
