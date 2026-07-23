import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { Project } from '../../api'

// 立项项目阶段泳道（§8）：analysis→rebranding→producing→publishing→selling
const STAGES: Array<{ key: string; label: string }> = [
  { key: 'analysis', label: '分析' },
  { key: 'rebranding', label: '换皮' },
  { key: 'producing', label: '产素材' },
  { key: 'publishing', label: '发布' },
  { key: 'selling', label: '成交' },
]

export default function StageLanes({ projects, onMove, loaded }: {
  projects: Project[]; onMove: (slug: string, stage: string) => void; loaded?: boolean
}) {
  const navigate = useNavigate()
  const [dragSlug, setDragSlug] = useState<string | null>(null)

  return (
    <div>
      <div className="mb-2 text-sm font-medium text-neutral-600">立项项目 · 拖拽卡片流转阶段</div>
      <div className="flex gap-3 overflow-x-auto pb-2">
        {STAGES.map((s) => {
          const items = projects.filter((p) => p.stage === s.key)
          return (
            <div key={s.key}
              className="min-w-[200px] flex-1 rounded-lg border bg-neutral-50 p-2"
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => { if (dragSlug) onMove(dragSlug, s.key); setDragSlug(null) }}>
              <div className="mb-2 flex items-center justify-between px-1 text-xs font-medium text-neutral-500">
                <span>{s.label}</span><span>{items.length}</span>
              </div>
              <div className="space-y-2">
                {items.map((p) => {
                  const sum = p.analysis_summary
                  return (
                    <div key={p.id} draggable
                      onDragStart={() => setDragSlug(p.slug)}
                      onDragEnd={() => setDragSlug(null)}
                      onClick={() => navigate(`/projects/${p.slug}`)}
                      className="cursor-grab rounded border bg-white p-2 text-sm shadow-sm hover:border-blue-400 active:cursor-grabbing">
                      <div className="font-medium">{p.brand_name || p.slug}</div>
                      <div className="text-xs text-neutral-400">{p.slug}</div>
                      {sum?.targetBuyer
                        ? <div className="mt-1 text-xs text-neutral-600">👤 {sum.targetBuyer}</div>
                        : <div className="mt-1 text-xs text-neutral-300">未分析 · 点开生成分析</div>}
                      {sum?.painPoint && <div className="text-xs text-neutral-600">💢 {sum.painPoint}</div>}
                    </div>
                  )
                })}
                {items.length === 0 && <div className="rounded border border-dashed p-3 text-center text-xs text-neutral-300">拖到此</div>}
              </div>
            </div>
          )
        })}
      </div>
      {loaded && projects.length === 0 && <div className="mt-1 text-xs text-neutral-400">暂无立项项目，先在候选卡片点「立项」</div>}
    </div>
  )
}
