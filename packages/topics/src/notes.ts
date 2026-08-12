import type { CoreCtx } from '@forgecast/core'
import type { Platform } from './sources'

export interface RawNote {
  noteId: string
  title: string
  playCount: number
  likeCount: number
  collectCount?: number
}

export interface ViralNote {
  id: number
  source_id: number
  platform: Platform
  note_id: string
  title: string
  play_count: number
  like_count: number
  collect_count: number | null
  follower_count_at_scrape: number | null
  ratio: number | null
  scraped_at: string
  raw_json: string
}

/**
 * 导入一批爆款笔记原始数据（由 agent 会话手动抓取后写成 JSON，本函数不做任何抓取）。
 * 账号必须已在 topic_sources 存在，不隐式创建；用账号当前 follower_count 作为这批笔记的
 * follower_count_at_scrape 快照，据此算 ratio（账号无粉丝数时 ratio 存 null，笔记仍正常入库）。
 * 同 (platform, note_id) 重复导入视为数据更新（覆盖旧值），不重复插入。
 */
export function importNotes(
  ctx: CoreCtx,
  input: { sourceHandle: string; platform: Platform; notes: RawNote[] },
): { imported: number; updated: number } {
  const source = ctx.db.prepare('SELECT id, follower_count FROM topic_sources WHERE platform = ? AND handle = ?')
    .get(input.platform, input.sourceHandle) as { id: number; follower_count: number | null } | undefined
  if (!source) throw new Error(`未知账号，请先在选题库页面添加目标账号: ${input.platform}/${input.sourceHandle}`)

  const now = new Date().toISOString()
  const findExisting = ctx.db.prepare('SELECT id FROM viral_notes WHERE platform = ? AND note_id = ?')
  const upsert = ctx.db.prepare(`
    INSERT INTO viral_notes (source_id, platform, note_id, title, play_count, like_count, collect_count, follower_count_at_scrape, ratio, scraped_at, raw_json)
    VALUES (@source_id, @platform, @note_id, @title, @play_count, @like_count, @collect_count, @follower_count_at_scrape, @ratio, @scraped_at, @raw_json)
    ON CONFLICT(platform, note_id) DO UPDATE SET
      title = excluded.title, play_count = excluded.play_count, like_count = excluded.like_count,
      collect_count = excluded.collect_count, follower_count_at_scrape = excluded.follower_count_at_scrape,
      ratio = excluded.ratio, scraped_at = excluded.scraped_at, raw_json = excluded.raw_json
  `)

  let imported = 0
  let updated = 0
  for (const n of input.notes) {
    const exists = findExisting.get(input.platform, n.noteId)
    const ratio = source.follower_count ? n.playCount / source.follower_count : null
    upsert.run({
      source_id: source.id, platform: input.platform, note_id: n.noteId, title: n.title,
      play_count: n.playCount, like_count: n.likeCount, collect_count: n.collectCount ?? null,
      follower_count_at_scrape: source.follower_count, ratio, scraped_at: now, raw_json: JSON.stringify(n),
    })
    if (exists) updated++; else imported++
  }
  return { imported, updated }
}

export function listNotes(ctx: CoreCtx, sourceId?: number): ViralNote[] {
  if (sourceId !== undefined) {
    return ctx.db.prepare('SELECT * FROM viral_notes WHERE source_id = ? ORDER BY id DESC').all(sourceId) as ViralNote[]
  }
  return ctx.db.prepare('SELECT * FROM viral_notes ORDER BY id DESC').all() as ViralNote[]
}
