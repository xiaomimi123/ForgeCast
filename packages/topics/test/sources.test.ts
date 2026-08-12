import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadConfig, openDb, type CoreCtx } from '@forgecast/core'
import { beforeEach, describe, expect, it } from 'vitest'
import { addSource, deleteSource, listSources, requestScrape, updateSource } from '../src/sources'

let ctx: CoreCtx
beforeEach(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-topics-'))
  const config = loadConfig(root, {})
  ctx = { db: openDb(config.paths.db), config, llm: undefined as any }
})

describe('topic_sources CRUD', () => {
  it('addSource 落库，listSources 倒序返回', () => {
    const a = addSource(ctx, { platform: 'xiaohongshu', handle: 'a' })
    addSource(ctx, { platform: 'douyin', handle: 'b', displayName: 'B号', followerCount: 10000, note: '同赛道头部' })
    const rows = listSources(ctx)
    expect(rows.length).toBe(2)
    expect(rows[0].handle).toBe('b')
    expect(rows[0].display_name).toBe('B号')
    expect(rows[0].follower_count).toBe(10000)
    expect(rows[1].id).toBe(a.id)
  })
  it('handle 为空抛错', () => {
    expect(() => addSource(ctx, { platform: 'douyin', handle: ' ' })).toThrow()
  })
  it('platform 非法抛错', () => {
    expect(() => addSource(ctx, { platform: 'x' as any, handle: 'a' })).toThrow()
  })
  it('同 platform+handle 重复添加抛错', () => {
    addSource(ctx, { platform: 'douyin', handle: 'dup' })
    expect(() => addSource(ctx, { platform: 'douyin', handle: 'dup' })).toThrow(/已存在/)
  })
  it('updateSource 只更新传入字段，不存在抛错', () => {
    const { id } = addSource(ctx, { platform: 'douyin', handle: 'c', followerCount: 100 })
    updateSource(ctx, id, { followerCount: 200 })
    expect(listSources(ctx)[0].follower_count).toBe(200)
    updateSource(ctx, id, { note: '更新备注' })
    const row = listSources(ctx)[0]
    expect(row.note).toBe('更新备注')
    expect(row.follower_count).toBe(200) // 只传 note 不影响 followerCount
    expect(() => updateSource(ctx, 999, { note: 'x' })).toThrow(/不存在/)
  })
  it('deleteSource 删除后 listSources 不再返回', () => {
    const { id } = addSource(ctx, { platform: 'douyin', handle: 'd' })
    deleteSource(ctx, id)
    expect(listSources(ctx).find((r) => r.id === id)).toBeUndefined()
  })
  it('requestScrape 设置待抓取时间戳，账号不存在抛错，可重复调用不报错', () => {
    const { id } = addSource(ctx, { platform: 'douyin', handle: 'e' })
    expect(listSources(ctx)[0].scrape_requested_at).toBeNull()
    requestScrape(ctx, id)
    expect(listSources(ctx)[0].scrape_requested_at).not.toBeNull()
    expect(() => requestScrape(ctx, 999)).toThrow(/不存在/)
    expect(() => requestScrape(ctx, id)).not.toThrow()
  })
})
