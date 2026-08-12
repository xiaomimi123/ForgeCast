import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadConfig, openDb, type CoreCtx } from '@forgecast/core'
import { beforeEach, describe, expect, it } from 'vitest'
import { addSource } from '../src/sources'
import { importNotes, listNotes } from '../src/notes'

let ctx: CoreCtx
beforeEach(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-topics-notes-'))
  const config = loadConfig(root, {})
  ctx = { db: openDb(config.paths.db), config, llm: undefined as any }
})

describe('importNotes', () => {
  it('未知账号抛错', () => {
    expect(() => importNotes(ctx, { sourceHandle: 'nope', platform: 'douyin', notes: [] }))
      .toThrow(/未知账号/)
  })
  it('有粉丝数时正确算比值并落库', () => {
    addSource(ctx, { platform: 'douyin', handle: 'a', followerCount: 1000 })
    const r = importNotes(ctx, {
      sourceHandle: 'a', platform: 'douyin',
      notes: [{ noteId: 'n1', title: '标题1', playCount: 5000, likeCount: 100, collectCount: 20 }],
    })
    expect(r).toEqual({ imported: 1, updated: 0 })
    const notes = listNotes(ctx)
    expect(notes.length).toBe(1)
    expect(notes[0].ratio).toBeCloseTo(5)
    expect(notes[0].follower_count_at_scrape).toBe(1000)
    expect(notes[0].collect_count).toBe(20)
  })
  it('账号无粉丝数时 ratio 存 null，笔记仍入库', () => {
    addSource(ctx, { platform: 'douyin', handle: 'b' })
    importNotes(ctx, { sourceHandle: 'b', platform: 'douyin', notes: [{ noteId: 'n2', title: 't', playCount: 100, likeCount: 1 }] })
    expect(listNotes(ctx)[0].ratio).toBeNull()
  })
  it('同 platform+note_id 重复导入更新而不重复插入', () => {
    addSource(ctx, { platform: 'douyin', handle: 'c', followerCount: 100 })
    importNotes(ctx, { sourceHandle: 'c', platform: 'douyin', notes: [{ noteId: 'n3', title: '旧标题', playCount: 10, likeCount: 1 }] })
    const r2 = importNotes(ctx, { sourceHandle: 'c', platform: 'douyin', notes: [{ noteId: 'n3', title: '新标题', playCount: 999, likeCount: 5 }] })
    expect(r2).toEqual({ imported: 0, updated: 1 })
    const notes = listNotes(ctx)
    expect(notes.length).toBe(1)
    expect(notes[0].title).toBe('新标题')
    expect(notes[0].play_count).toBe(999)
  })
  it('listNotes 按 source_id 过滤', () => {
    const a = addSource(ctx, { platform: 'douyin', handle: 'd', followerCount: 100 })
    addSource(ctx, { platform: 'douyin', handle: 'e', followerCount: 100 })
    importNotes(ctx, { sourceHandle: 'd', platform: 'douyin', notes: [{ noteId: 'n4', title: 't', playCount: 1, likeCount: 1 }] })
    importNotes(ctx, { sourceHandle: 'e', platform: 'douyin', notes: [{ noteId: 'n5', title: 't', playCount: 1, likeCount: 1 }] })
    expect(listNotes(ctx, a.id).length).toBe(1)
    expect(listNotes(ctx).length).toBe(2)
  })
})
