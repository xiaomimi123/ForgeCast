import type { CoreCtx } from '@forgecast/core'

export type Platform = 'douyin' | 'xiaohongshu'

export interface TopicSource {
  id: number
  platform: Platform
  handle: string
  display_name: string | null
  follower_count: number | null
  note: string | null
  created_at: string
}

/** 新增目标账号（选题库爆款笔记来源，手动维护，不做隐式创建）。同 platform+handle 重复抛错。 */
export function addSource(
  ctx: CoreCtx,
  input: { platform: Platform; handle: string; displayName?: string; followerCount?: number; note?: string },
): { id: number } {
  if (input.platform !== 'douyin' && input.platform !== 'xiaohongshu') throw new Error('platform 必须是 douyin/xiaohongshu')
  if (!input.handle.trim()) throw new Error('handle 必填')
  try {
    const r = ctx.db.prepare(
      'INSERT INTO topic_sources (platform, handle, display_name, follower_count, note) VALUES (?, ?, ?, ?, ?)',
    ).run(input.platform, input.handle.trim(), input.displayName ?? null, input.followerCount ?? null, input.note ?? null)
    return { id: Number(r.lastInsertRowid) }
  } catch (err) {
    if (err instanceof Error && err.message.includes('UNIQUE')) throw new Error(`账号已存在: ${input.platform}/${input.handle}`)
    throw err
  }
}

export function listSources(ctx: CoreCtx): TopicSource[] {
  return ctx.db.prepare('SELECT * FROM topic_sources ORDER BY id DESC').all() as TopicSource[]
}

export type SourcePatch = Partial<{ followerCount: number; note: string }>

/** 部分字段更新（同 tailor 的 updateCapability 写法）：只传的字段会被更新，不存在抛错。 */
export function updateSource(ctx: CoreCtx, id: number, patch: SourcePatch): void {
  if (!ctx.db.prepare('SELECT id FROM topic_sources WHERE id = ?').get(id)) throw new Error(`目标账号不存在: ${id}`)
  const sets: string[] = []
  const vals: unknown[] = []
  if (patch.followerCount !== undefined) { sets.push('follower_count = ?'); vals.push(patch.followerCount) }
  if (patch.note !== undefined) { sets.push('note = ?'); vals.push(patch.note) }
  if (!sets.length) return
  ctx.db.prepare(`UPDATE topic_sources SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id)
}

export function deleteSource(ctx: CoreCtx, id: number): void {
  ctx.db.prepare('DELETE FROM topic_sources WHERE id = ?').run(id)
}
