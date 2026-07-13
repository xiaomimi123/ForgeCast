import { describe, expect, it } from 'vitest'
import { createTaskQueue } from '../src/tasks'

function wait(ms: number) { return new Promise((r) => setTimeout(r, ms)) }

describe('createTaskQueue', () => {
  it('执行任务并记录事件，成功后 status=done 且有 done 事件', async () => {
    const q = createTaskQueue()
    const id = q.enqueue(async (log) => { log('步骤1'); return { ok: 1 } })
    await wait(50)
    const t = q.get(id)!
    expect(t.status).toBe('done')
    expect(t.events.map((e) => e.type)).toEqual(['log', 'done'])
    expect(t.events[1].result).toEqual({ ok: 1 })
  })
  it('任务抛错 → status=failed 且有 error 事件', async () => {
    const q = createTaskQueue()
    const id = q.enqueue(async () => { throw new Error('炸了') })
    await wait(50)
    const t = q.get(id)!
    expect(t.status).toBe('failed')
    expect(t.events.at(-1)).toMatchObject({ type: 'error', message: expect.stringContaining('炸了') })
  })
  it('并发 1：两个任务串行执行', async () => {
    const q = createTaskQueue()
    const order: string[] = []
    q.enqueue(async () => { await wait(30); order.push('a') })
    q.enqueue(async () => { order.push('b') })
    await wait(100)
    expect(order).toEqual(['a', 'b'])
  })
  it('subscribe 收到后续事件，退订生效', async () => {
    const q = createTaskQueue()
    const got: string[] = []
    const id = q.enqueue(async (log) => { await wait(20); log('hi') })
    const off = q.subscribe(id, (e) => got.push(e.type))
    await wait(60)
    off()
    expect(got).toEqual(['log', 'done'])
  })
})
