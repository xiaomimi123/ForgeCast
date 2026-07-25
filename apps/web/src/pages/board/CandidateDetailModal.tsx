import { useEffect, useState } from 'react'
import { api, type Candidate, type IntroResponse } from '../../api'
import { Bar, DIMS, parseDetail } from './CandidateCard'

export default function CandidateDetailModal({ candidate, onClose }: { candidate: Candidate; onClose: () => void }) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [res, setRes] = useState<IntroResponse | null>(null)
  const d = parseDetail(candidate.score_detail)

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
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [onClose])

  const live = res && res.mode === 'live' ? res : null

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4" onClick={onClose}>
      <div className="mt-8 w-full max-w-2xl rounded-lg bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-baseline gap-2 border-b pb-2">
          <a className="font-semibold text-blue-600" href={candidate.url} target="_blank" rel="noreferrer">{candidate.repo}</a>
          <span className="rounded bg-green-50 px-1.5 py-0.5 text-xs text-green-700">{candidate.license ?? '—'}</span>
          {d?.category && d.category !== '其它' && (
            <span className="rounded bg-indigo-50 px-1.5 py-0.5 text-xs text-indigo-700">{d.category}</span>
          )}
          <button className="ml-auto text-neutral-400 hover:text-neutral-700" onClick={onClose}>✕</button>
        </div>

        {loading && <div className="py-10 text-center text-sm text-neutral-400">生成中…（读 README + 大模型，约数秒）</div>}

        {!loading && error && (
          <div className="py-8 text-center">
            <div className="text-sm text-red-600">生成失败：{error}</div>
            <button className="mt-3 rounded border px-3 py-1 text-sm" onClick={() => load(false)}>重试</button>
          </div>
        )}

        {!loading && res?.mode === 'mock' && (
          <div className="py-8 text-center text-sm text-neutral-500">
            详细介绍需 live 大模型生成。请先到「设置」把大模型切到 live 并填 key。
          </div>
        )}

        {!loading && live && (
          <div className="space-y-4 py-3 text-sm">
            <section>
              <h3 className="mb-1 font-medium text-neutral-800">产品简介</h3>
              <p className="text-neutral-600">{live.intro.summary}</p>
            </section>
            <section>
              <h3 className="mb-1 font-medium text-neutral-800">核心功能</h3>
              <ul className="list-disc space-y-0.5 pl-5 text-neutral-600">
                {live.intro.features.map((f, i) => <li key={i}>{f}</li>)}
              </ul>
            </section>
            <section>
              <h3 className="mb-1 font-medium text-neutral-800">目标用户</h3>
              <p className="text-neutral-600">{live.intro.targetUser}</p>
            </section>
            <section>
              <h3 className="mb-1 font-medium text-neutral-800">行业痛点</h3>
              <p className="text-neutral-600">{live.intro.painPoint}</p>
            </section>
            <section>
              <h3 className="mb-1 font-medium text-neutral-800">换皮卖点</h3>
              <p className="text-neutral-600">{live.intro.rebrandIdea}</p>
            </section>
            {d && (
              <section className="border-t pt-3">
                <h3 className="mb-1 font-medium text-neutral-800">评分</h3>
                <div className="space-y-1">
                  {DIMS.map((dim) => <Bar key={dim.key} label={dim.label} value={d[dim.key]} max={dim.max} />)}
                </div>
                {d.rationale && <p className="mt-1 text-xs text-neutral-500">💡 {d.rationale}</p>}
              </section>
            )}
            <div className="flex items-center gap-3 border-t pt-2 text-xs text-neutral-400">
              <span>生成于 {new Date(live.intro.generatedAt).toLocaleString()}{live.cached ? '（缓存）' : ''}</span>
              <button className="ml-auto rounded border px-2 py-1 text-neutral-600" onClick={() => load(true)}>重新生成</button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
