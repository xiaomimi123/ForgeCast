import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { api, type Project } from '../api'
import ProjectGroups from './board/ProjectGroups'
import AcceptanceSection from './board/AcceptanceSection'

export default function ProjectsPage({ onOpenProject, onOpenWorkshop }: {
  onOpenProject: (slug: string) => void
  /** 跨板块交接：切到做内容工位并预选该项目（App 提供） */
  onOpenWorkshop: (slug: string) => void
}) {
  const qc = useQueryClient()
  // 与 Topbar / WorkshopPage 同名查询保持一致的 networkMode，理由见 Topbar.tsx 的注释
  const projects = useQuery({ queryKey: ['projects'], queryFn: () => api<Project[]>('/api/projects'), networkMode: 'always' })
  /** 刚被移出拆解阶段的那一个，用于就地反馈（卡片消失时页面原本毫无提示） */
  const [moved, setMoved] = useState<{ slug: string; name: string; stage: string } | null>(null)
  const moveStage = useMutation({
    mutationFn: ({ slug, stage }: { slug: string; stage: string; jump?: boolean }) =>
      api(`/api/projects/${slug}`, { method: 'PATCH', body: JSON.stringify({ stage }) }),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ['projects'] })
      const name = projects.data?.find((p) => p.slug === vars.slug)?.brand_name || vars.slug
      // 卡片下拉推进到「产素材」＝ 交接给做内容：直接把用户带过去并选中它（本页随即卸载，不用再留提示）
      if (vars.jump && vars.stage === 'producing') { setMoved(null); onOpenWorkshop(vars.slug); return }
      // 其余离开拆解阶段的移动（发布/成交，或「验收通过」——那条路径卡片仍在「已完成」区可见）就地提示
      setMoved(['producing', 'publishing', 'selling'].includes(vars.stage) ? { slug: vars.slug, name, stage: vars.stage } : null)
    },
    onError: (e) => alert(`移动失败: ${e instanceof Error ? e.message : String(e)}`),
  })
  return (
    <div className="space-y-4">
      <h1 className="text-[26px] font-black tracking-tight text-ink">
        拆解需求<span className="ml-3 text-xs font-normal text-faint">把已立项的项目拆解成分析报告 + 换皮清单</span>
      </h1>
      <ProjectGroups
        projects={projects.data ?? []}
        loaded={projects.isSuccess}
        onMove={(slug, stage) => moveStage.mutate({ slug, stage, jump: true })}
        onOpenProject={onOpenProject}
        moved={moved}
        onGoWorkshop={onOpenWorkshop}
      />
      <AcceptanceSection
        projects={projects.data ?? []}
        onOpenProject={onOpenProject}
        onAdvance={(slug) => moveStage.mutate({ slug, stage: 'producing' })}
      />
    </div>
  )
}
