import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { IntroDetail, Project } from '../../api'
import { parseDetail } from './CandidateCard'

// 立项项目阶段泳道（§8）：analysis→rebranding→producing→publishing→selling
// 枚举与自动推进规则的单一真源在 packages/core/src/stage.ts（web 不依赖 core，是浏览器包，这里保留一份带中文标签的平行声明）
const STAGES: Array<{ key: string; label: string }> = [
  { key: 'analysis', label: '分析' },
  { key: 'rebranding', label: '换皮' },
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

export default function StageLanes({ projects, onMove, loaded }: {
  projects: Project[]; onMove: (slug: string, stage: string) => void; loaded?: boolean
}) {
  const navigate = useNavigate()
  const [dragSlug, setDragSlug] = useState<string | null>(null)

  return (
    <div>
      <div className="mb-2 text-sm font-medium text-sub">立项项目 · 拖拽卡片流转阶段</div>
      <div className="flex gap-3 overflow-x-auto pb-2">
        {STAGES.map((s) => {
          const items = projects.filter((p) => p.stage === s.key)
          return (
            <div key={s.key}
              className="min-w-[200px] flex-1 rounded-lg border-[1.5px] border-hairline bg-transparent p-2"
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => { if (dragSlug) onMove(dragSlug, s.key); setDragSlug(null) }}>
              <div className="mb-2 flex items-center justify-between px-1 text-xs font-bold text-sub tracking-wide">
                <span>{s.label}</span><span>{items.length}</span>
              </div>
              <div className="space-y-2">
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
                    <div key={p.id} draggable
                      onDragStart={() => setDragSlug(p.slug)}
                      onDragEnd={() => setDragSlug(null)}
                      onClick={() => navigate(`/projects/${p.slug}`)}
                      className="cursor-grab rounded-lg border-[1.5px] border-ink bg-card p-2 text-sm shadow-[2px_2px_0_rgba(28,23,18,0.85)] hover:shadow-[3px_3px_0_rgba(217,72,28,0.9)] active:cursor-grabbing">
                      <div className="font-medium">{p.brand_name || p.slug}</div>
                      <div className="text-xs text-faint">{p.slug}</div>
                      {sum.targetBuyer
                        ? <div className="mt-1 text-xs text-sub">👤 {sum.targetBuyer}</div>
                        : <div className="mt-1 text-xs text-faint">未分析 · 点开生成分析</div>}
                      {sum.painPoint && <div className="text-xs text-sub">💢 {sum.painPoint}</div>}
                      {countParts.length > 0 && (
                        <div className="mt-1 border-t border-hairline pt-1 text-[11px] text-faint">{countParts.join(' · ')}</div>
                      )}
                    </div>
                  )
                })}
                {items.length === 0 && <div className="rounded border border-dashed border-hairline p-3 text-center text-xs text-faint">拖到此</div>}
              </div>
            </div>
          )
        })}
      </div>
      {loaded && projects.length === 0 && <div className="mt-1 text-xs text-faint">暂无立项项目，先到「找项目」板块在候选卡片点「立项」</div>}
    </div>
  )
}
