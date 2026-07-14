export interface Project {
  id: number; slug: string; brand_name: string | null; target_buyer: string | null
  demo_url: string | null; price_deploy: number | null; price_custom: number | null
  stage: string; analysisMd?: string
}
export interface Asset {
  id: number; project_id: number; type: 'copy' | 'cover' | 'video'; hook: string | null
  file_path: string; status: 'draft' | 'approved' | 'published'; warnings: string | null
}
export interface TaskEvent { ts: number; type: 'log' | 'done' | 'error'; message: string }

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { headers: { 'content-type': 'application/json' }, ...init })
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`)
  return res.json() as Promise<T>
}

/** 订阅任务 SSE；done/error 后自动关闭。返回手动关闭函数。 */
export function subscribeTask(taskId: string, onEvent: (e: TaskEvent) => void): () => void {
  const es = new EventSource(`/api/tasks/${taskId}/events`)
  es.onmessage = (m) => {
    const e = JSON.parse(m.data) as TaskEvent
    onEvent(e)
    if (e.type === 'done' || e.type === 'error') es.close()
  }
  es.onerror = () => es.close()
  return () => es.close()
}

export interface Candidate {
  id: number; repo: string; url: string; license: string | null; license_ok: number
  stars: number; tech_stack: string | null; score: number | null; score_detail: string | null; status: string
}
export interface CalendarView {
  date: string; publishedToday: number; remainingToday: number
  inventory: Record<string, number>; cooldown: Record<string, number>
  mix: { demo: number; income: number; targetDemo: number; targetIncome: number }
  suggestions: Array<{ hook: string; assetId: number; reason: string }>
}
export interface WeeklyReport {
  since: string; perHook: Record<string, { published: number; leads: number }>
  totals: { published: number; leads: number }
}
export interface Lead {
  id: number; asset_id: number; wechat: string | null; intent: string | null
  status: string; created_at: string; hook: string | null; slug: string | null
}
