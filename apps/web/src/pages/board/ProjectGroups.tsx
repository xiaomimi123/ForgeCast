import { useNavigate } from 'react-router-dom'
import type { IntroDetail, Project } from '../../api'
import { parseDetail } from './CandidateCard'

// 完整 5 阶段单一真源见 packages/core/src/stage.ts：analysis→rebranding→producing→publishing→selling
// 这个页面只管「拆解」这一段（分析/换皮）——产素材/发布/成交分别由「做内容」「分发营销」板块展示，不在这里重复
const GROUPS: Array<{ key: string; label: string }> = [
  { key: 'analysis', label: '分析' },
  { key: 'rebranding', label: '换皮' },
]
// 手动改阶段下拉用完整 5 项：选到产素材及之后，卡片会在下次渲染时从这两组里消失（预期行为）
const ALL_STAGES: Array<{ key: string; label: string }> = [
  ...GROUPS,
  { key: 'producing', label: '产素材' },
  { key: 'publishing', label: '发布' },
  { key: 'selling', label: '成交' },
]

/** 卡片买家/痛点三级回退：analysis.md 摘要 → 候选评分明细 → 候选产品说明书（立项刚发生、还没生成 analysis.md 时用） */
function fallbackIntro(p: Project): { targetBuyer: string; painPoint: string } {
  if (p.analysis_summary?.targetBuyer || p.analysis_summary?.painPoint) return p.analysis_summary
  const sd = parseDetail(p.score_detail)
  if (sd?.targetBuyer || sd?.painPoint) return { targetBuyer: sd.targetBuyer, painPoint: sd.painPoint }
  if (p.intro_detail) {
    try {
      const intro = JSON.parse(p.intro_detail) as IntroDetail
      return { targetBuyer: intro.targetUser, painPoint: intro.painPoint }
    } catch { /* 坏 JSON 按无数据处理 */ }
  }
  return { targetBuyer: '', painPoint: '' }
}

const grid = 'grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4'

export default function ProjectGroups({ projects, onMove, loaded }: {
  projects: Project[]; onMove: (slug: string, stage: string) => void; loaded?: boolean
}) {
  const navigate = useNavigate()
  const inDecompose = projects.filter((p) => GROUPS.some((g) => g.key === p.stage))

  return (
    <div className="space-y-6">
      {GROUPS.map((g) => {
        const items = projects.filter((p) => p.stage === g.key)
        return (
          <div key={g.key}>
            <div className="mb-2 text-xs font-bold text-sub tracking-wide">{g.label} ({items.length})</div>
            {items.length > 0 ? (
              <div className={grid}>
                {items.map((p) => {
                  const sum = fallbackIntro(p)
                  const counts = p.counts
                  const countParts = counts
                    ? [
                        counts.copies ? `文案 ${counts.copies}` : '',
                        counts.videos ? `视频 ${counts.videos}` : '',
                        counts.published ? `已发 ${counts.published}` : '',
                        counts.leads ? `询单 ${counts.leads}` : '',
                      ].filter(Boolean)
                    : []
                  return (
                    <div key={p.id}
                      onClick={() => navigate(`/projects/${p.slug}`)}
                      className="cursor-pointer rounded-lg border-[1.5px] border-ink bg-card p-3 text-sm shadow-[2px_2px_0_rgba(28,23,18,0.85)] hover:shadow-[3px_3px_0_rgba(217,72,28,0.9)]">
                      <div className="font-medium">{p.brand_name || p.slug}</div>
                      <div className="text-xs text-faint">{p.slug}</div>
                      {sum.targetBuyer
                        ? <div className="mt-1 text-xs text-sub">👤 {sum.targetBuyer}</div>
                        : <div className="mt-1 text-xs text-faint">未分析 · 点开生成分析</div>}
                      {sum.painPoint && <div className="text-xs text-sub">💢 {sum.painPoint}</div>}
                      {countParts.length > 0 && (
                        <div className="mt-1 border-t border-hairline pt-1 text-[11px] text-faint">{countParts.join(' · ')}</div>
                      )}
                      <div className="mt-2" onClick={(e) => e.stopPropagation()}>
                        <select className="w-full rounded border-[1.5px] border-hairline bg-transparent px-1.5 py-1 text-xs text-sub"
                          value={p.stage} onChange={(e) => onMove(p.slug, e.target.value)}>
                          {ALL_STAGES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
                        </select>
                      </div>
                    </div>
                  )
                })}
              </div>
            ) : (
              <div className="rounded border border-dashed border-hairline p-3 text-center text-xs text-faint">暂无</div>
            )}
          </div>
        )
      })}
      {loaded && projects.length === 0 && (
        <div className="text-xs text-faint">暂无立项项目，先到「找项目」板块在候选卡片点「立项」</div>
      )}
      {loaded && projects.length > 0 && inDecompose.length === 0 && (
        <div className="text-xs text-faint">当前没有处于拆解阶段的项目——已进入后续阶段的项目请去「做内容」/「分发营销」板块查看</div>
      )}
    </div>
  )
}
