import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type Project } from '../api'
import ProjectGroups from './board/ProjectGroups'
import AcceptanceSection from './board/AcceptanceSection'

export default function ProjectsPage({ onOpenProject }: { onOpenProject: (slug: string) => void }) {
  const qc = useQueryClient()
  // 与 Topbar / WorkshopPage 同名查询保持一致的 networkMode，理由见 Topbar.tsx 的注释
  const projects = useQuery({ queryKey: ['projects'], queryFn: () => api<Project[]>('/api/projects'), networkMode: 'always' })
  const moveStage = useMutation({
    mutationFn: ({ slug, stage }: { slug: string; stage: string }) =>
      api(`/api/projects/${slug}`, { method: 'PATCH', body: JSON.stringify({ stage }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['projects'] }),
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
        onMove={(slug, stage) => moveStage.mutate({ slug, stage })}
        onOpenProject={onOpenProject}
      />
      <AcceptanceSection
        projects={projects.data ?? []}
        onOpenProject={onOpenProject}
        onAdvance={(slug) => moveStage.mutate({ slug, stage: 'producing' })}
      />
    </div>
  )
}
