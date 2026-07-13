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
