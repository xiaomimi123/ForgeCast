import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { api, type TopicPattern, type TopicSource } from '../api'
import TaskProgress from '../components/TaskProgress'
import { useConfirm } from '../components/ui/Confirm'
import { useTaskRun } from '../useTaskRun'

const HOOK_LABEL: Record<TopicPattern['hook_type'], string> = {
  pain: '行业痛点型', sideline: '副业型', infogap: '信息差型', story: '接单故事型',
}
const HOOK_ORDER: TopicPattern['hook_type'][] = ['pain', 'sideline', 'infogap', 'story']

export default function TopicsPage() {
  const qc = useQueryClient()
  const { confirm, element: confirmEl } = useConfirm()
  const sources = useQuery({ queryKey: ['topics', 'sources'], queryFn: () => api<TopicSource[]>('/api/topics/sources') })
  const patterns = useQuery({ queryKey: ['topics', 'patterns'], queryFn: () => api<TopicPattern[]>('/api/topics/patterns') })

  const [form, setForm] = useState<{ platform: 'douyin' | 'xiaohongshu'; handle: string; name: string; followers: string; note: string }>(
    { platform: 'douyin', handle: '', name: '', followers: '', note: '' },
  )
  const addSource = useMutation({
    mutationFn: () => api('/api/topics/sources', {
      method: 'POST',
      body: JSON.stringify({
        platform: form.platform, handle: form.handle, displayName: form.name || undefined,
        followerCount: form.followers ? Number(form.followers) : undefined, note: form.note || undefined,
      }),
    }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['topics', 'sources'] }); setForm({ platform: 'douyin', handle: '', name: '', followers: '', note: '' }) },
    onError: (e) => alert(e instanceof Error ? e.message : String(e)),
  })
  async function removeSource(id: number) {
    if (!(await confirm({ title: '删除该目标账号？', body: '已导入的笔记数据不会一并删除', danger: true, okLabel: '删除' }))) return
    try {
      await api(`/api/topics/sources/${id}`, { method: 'DELETE' })
      qc.invalidateQueries({ queryKey: ['topics', 'sources'] })
    } catch (e) { alert(e instanceof Error ? e.message : String(e)) }
  }
  const requestScrapeMut = useMutation({
    mutationFn: (id: number) => api(`/api/topics/sources/${id}/request-scrape`, { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['topics', 'sources'] }),
    onError: (e) => alert(e instanceof Error ? e.message : String(e)),
  })
  function sourceStatus(s: TopicSource): string {
    if (s.scrape_requested_at) return `待抓取（请求于 ${s.scrape_requested_at}）`
    if (s.last_scraped_at) return `上次抓取：${s.last_scraped_at}`
    return '从未抓取'
  }

  const extractRun = useTaskRun()
  function extract() {
    extractRun.run(
      async () => (await api<{ taskId: string }>('/api/topics/extract', { method: 'POST', body: '{}' })).taskId,
      (ok, e) => {
        if (ok) qc.invalidateQueries({ queryKey: ['topics', 'patterns'] })
        else alert(e?.message ?? '提炼失败')
      },
    )
  }

  const inp = 'rounded-md border-[1.5px] border-ink bg-card px-2 py-1 text-sm'
  const grouped = HOOK_ORDER.map((h) => ({ hook: h, items: (patterns.data ?? []).filter((p) => p.hook_type === h) }))

  return (
    <div className="space-y-6">
      <div className="card-forge p-4">
        <div className="mb-2 font-semibold">目标账号清单</div>
        <table className="w-full text-sm">
          <thead><tr className="text-left text-faint"><th>平台</th><th>账号</th><th>粉丝数</th><th>备注</th><th>抓取状态</th><th /></tr></thead>
          <tbody>
            {sources.data?.map((s) => (
              <tr key={s.id} className="border-t border-hairline">
                <td>{s.platform === 'douyin' ? '抖音' : '小红书'}</td>
                <td>{s.display_name ? `${s.display_name}（${s.handle}）` : s.handle}</td>
                <td>{s.follower_count ?? '—'}</td>
                <td className="text-faint">{s.note ?? ''}</td>
                <td className="text-faint">{sourceStatus(s)}</td>
                <td className="space-x-2">
                  <button className="text-xs text-ink underline disabled:opacity-50" disabled={requestScrapeMut.isPending}
                    onClick={() => requestScrapeMut.mutate(s.id)}>请求抓取</button>
                  <button className="text-xs text-red-600" onClick={() => removeSource(s.id)}>删除</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="mt-3 flex flex-wrap gap-2">
          <select className={inp} value={form.platform} onChange={(e) => setForm((f) => ({ ...f, platform: e.target.value as any }))}>
            <option value="douyin">抖音</option>
            <option value="xiaohongshu">小红书</option>
          </select>
          <input className={inp} placeholder="账号 handle" value={form.handle} onChange={(e) => setForm((f) => ({ ...f, handle: e.target.value }))} />
          <input className={inp} placeholder="显示名（可选）" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
          <input className={inp} placeholder="粉丝数（可选）" value={form.followers} onChange={(e) => setForm((f) => ({ ...f, followers: e.target.value }))} />
          <input className={inp} placeholder="备注（可选）" value={form.note} onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))} />
          <button className="btn-fire px-3 py-1 text-sm disabled:opacity-50" disabled={addSource.isPending || !form.handle.trim()} onClick={() => addSource.mutate()}>
            添加账号
          </button>
        </div>
      </div>

      <div className="card-forge p-4">
        <div className="mb-2 flex items-center justify-between">
          <div className="font-semibold">选题库</div>
          <div className="flex items-center gap-2">
            <button className="btn-ink px-3 py-1 text-sm disabled:opacity-50" disabled={extractRun.running} onClick={extract}>
              {extractRun.running ? '提炼中…' : '重新提炼'}
            </button>
            <TaskProgress run={extractRun} />
          </div>
        </div>
        <p className="mb-3 text-xs text-faint">抓取笔记数据需要在对话里让 Claude 帮你跑一次，这里只能对已导入的数据重新提炼。</p>
        {extractRun.logs.length > 0 && <pre className="mb-3 whitespace-pre-wrap rounded bg-black/5 p-2 text-xs">{extractRun.logs.join('\n')}</pre>}
        <div className="grid grid-cols-2 gap-4">
          {grouped.map(({ hook, items }) => (
            <div key={hook} className="rounded-md border-[1.5px] border-ink p-3">
              <div className="mb-2 text-sm font-bold">{HOOK_LABEL[hook]}（{items.length}）</div>
              {items.map((p) => (
                <div key={p.id} className="mb-2 rounded bg-card p-2 text-xs">
                  <div className="font-medium">标题结构：</div>
                  <ul className="list-disc pl-4">{(JSON.parse(p.title_patterns) as string[]).map((t, i) => <li key={i}>{t}</li>)}</ul>
                  <div className="mt-1">情绪类型：{p.emotion_type}</div>
                  <div className="mt-1 font-medium">推荐选题：</div>
                  <ul className="list-disc pl-4">{(JSON.parse(p.recommended_topics) as string[]).map((t, i) => <li key={i}>{t}</li>)}</ul>
                  <div className="mt-1 text-faint">基于 {(JSON.parse(p.sample_note_ids) as number[]).length} 条笔记提炼于 {p.created_at}</div>
                </div>
              ))}
              {items.length === 0 && <div className="text-xs text-faint">暂无</div>}
            </div>
          ))}
        </div>
      </div>
      {confirmEl}
    </div>
  )
}
