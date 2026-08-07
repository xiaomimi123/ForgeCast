import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type Project } from '../api'
import StageLanes from './board/StageLanes'

export default function ProjectsPage() {
  const qc = useQueryClient()
  const projects = useQuery({ queryKey: ['projects'], queryFn: () => api<Project[]>('/api/projects') })
  const moveStage = useMutation({
    mutationFn: ({ slug, stage }: { slug: string; stage: string }) =>
      api(`/api/projects/${slug}`, { method: 'PATCH', body: JSON.stringify({ stage }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['projects'] }),
    onError: (e) => alert(`移动失败: ${e instanceof Error ? e.message : String(e)}`),
  })
  return (
    <StageLanes
      projects={projects.data ?? []}
      loaded={projects.isSuccess}
      onMove={(slug, stage) => moveStage.mutate({ slug, stage })}
    />
  )
}
