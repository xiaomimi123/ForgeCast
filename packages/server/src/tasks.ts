import { randomUUID } from 'node:crypto'

export interface TaskEvent { ts: number; type: 'log' | 'done' | 'error'; message: string; result?: unknown }
export interface TaskRecord {
  id: string
  status: 'pending' | 'running' | 'done' | 'failed'
  events: TaskEvent[]
}

export interface TaskQueue {
  enqueue(fn: (log: (msg: string) => void) => Promise<unknown>): string
  get(id: string): TaskRecord | undefined
  subscribe(id: string, cb: (e: TaskEvent) => void): () => void
}

/** 内存任务队列：并发 1（生成类操作串行），事件既存档又实时广播（供 SSE） */
export function createTaskQueue(): TaskQueue {
  const tasks = new Map<string, TaskRecord>()
  const subs = new Map<string, Set<(e: TaskEvent) => void>>()
  let chain: Promise<unknown> = Promise.resolve()

  function emit(id: string, e: TaskEvent) {
    tasks.get(id)!.events.push(e)
    for (const cb of subs.get(id) ?? []) cb(e)
  }

  return {
    enqueue(fn) {
      const id = randomUUID()
      tasks.set(id, { id, status: 'pending', events: [] })
      chain = chain.then(async () => {
        const t = tasks.get(id)!
        t.status = 'running'
        try {
          const result = await fn((msg) => emit(id, { ts: Date.now(), type: 'log', message: msg }))
          t.status = 'done'
          emit(id, { ts: Date.now(), type: 'done', message: '完成', result })
        } catch (err) {
          t.status = 'failed'
          emit(id, { ts: Date.now(), type: 'error', message: err instanceof Error ? err.message : String(err) })
        }
      })
      return id
    },
    get: (id) => tasks.get(id),
    subscribe(id, cb) {
      if (!subs.has(id)) subs.set(id, new Set())
      subs.get(id)!.add(cb)
      return () => subs.get(id)!.delete(cb)
    },
  }
}
