import { useParams } from 'react-router-dom'

export default function TailorDetailPage() {
  const { id } = useParams()
  return <div className="text-neutral-400">定制需求 #{id} 详情（下一任务实现）</div>
}
