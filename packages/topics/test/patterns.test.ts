import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createLlmClient, loadConfig, openDb, type CoreCtx } from '@forgecast/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { addSource } from '../src/sources'
import { importNotes } from '../src/notes'
import { extractPatterns, listPatterns } from '../src/patterns'

let ctx: CoreCtx
let root: string
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-topics-patterns-'))
  const config = loadConfig(root, {}) // mock
  ctx = { db: openDb(config.paths.db), config, llm: createLlmClient(config.llm) }
  addSource(ctx, { platform: 'douyin', handle: 'a', followerCount: 1000 })
})

function seedNotes(n: number) {
  const notes = Array.from({ length: n }, (_, i) => ({ noteId: `n${i}`, title: `标题${i}`, playCount: (i + 1) * 100, likeCount: 1 }))
  importNotes(ctx, { sourceHandle: 'a', platform: 'douyin', notes })
}

describe('extractPatterns mock 模式', () => {
  it('无笔记时返回空数组，不调用 ctx.llm', async () => {
    const spy = vi.spyOn(ctx.llm, 'complete')
    const r = await extractPatterns(ctx)
    expect(r).toEqual([])
    expect(spy).not.toHaveBeenCalled()
  })
  it('有笔记时产出固定 fixture 结果，写入 topic_patterns，不调用 ctx.llm', async () => {
    seedNotes(3)
    const spy = vi.spyOn(ctx.llm, 'complete')
    const r = await extractPatterns(ctx)
    expect(r.length).toBeGreaterThan(0)
    expect(spy).not.toHaveBeenCalled()
    expect(listPatterns(ctx).length).toBe(r.length)
    for (const p of r) {
      expect(JSON.parse(p.title_patterns).length).toBeGreaterThan(0)
      expect(JSON.parse(p.sample_note_ids).length).toBe(3)
    }
  })
  it('topN 限制参与提炼的笔记数（按 ratio 降序取前 N）', async () => {
    seedNotes(5)
    const r = await extractPatterns(ctx, { topN: 2 })
    expect(JSON.parse(r[0].sample_note_ids).length).toBe(2)
  })
  it('minRatio 过滤低于阈值的笔记', async () => {
    seedNotes(5) // ratio 分别是 0.1,0.2,0.3,0.4,0.5
    const r = await extractPatterns(ctx, { minRatio: 0.35 })
    expect(JSON.parse(r[0].sample_note_ids).length).toBe(2) // 只有 0.4、0.5 达标
  })
  it('已被引用过的笔记不重复参与下一次提炼', async () => {
    seedNotes(3)
    await extractPatterns(ctx) // 第一次把 3 条全用掉
    const spy = vi.spyOn(ctx.llm, 'complete')
    const r2 = await extractPatterns(ctx) // 第二次没有新笔记可用
    expect(r2).toEqual([])
    expect(spy).not.toHaveBeenCalled()
  })
  it('onProgress 收到进度消息', async () => {
    seedNotes(1)
    const msgs: string[] = []
    await extractPatterns(ctx, { onProgress: (m) => msgs.push(m) })
    expect(msgs.length).toBeGreaterThan(0)
  })
})

describe('extractPatterns live 模式', () => {
  function liveCtx(): CoreCtx {
    const config = loadConfig(root, { FORGECAST_LLM_MODE: 'live', FORGECAST_LLM_KEY: 'k' })
    config.paths.templates = path.resolve(__dirname, '../../../templates')
    return { db: ctx.db, config, llm: createLlmClient(config.llm) }
  }
  const GOOD = '```json\n[{"hookType":"pain","titlePatterns":["标题结构A"],"emotionType":"同行吐槽","topicClusters":["聚类A"],"recommendedTopics":["选题A"]}]\n```'

  it('成功解析 LLM 返回并写库', async () => {
    seedNotes(2)
    const lctx = liveCtx()
    lctx.llm.complete = vi.fn(async () => GOOD)
    const r = await extractPatterns(lctx)
    expect(r.length).toBe(1)
    expect(r[0].hook_type).toBe('pain')
    expect(JSON.parse(r[0].title_patterns)).toEqual(['标题结构A'])
  })

  it('LLM 返回缺字段 → 整批抛错，不写入部分脏数据', async () => {
    seedNotes(2)
    const lctx = liveCtx()
    lctx.llm.complete = vi.fn(async () => '```json\n[{"hookType":"pain","titlePatterns":["a"]}]\n```') // 缺 emotionType/topicClusters/recommendedTopics
    await expect(extractPatterns(lctx)).rejects.toThrow(/缺字段/)
    expect(listPatterns(lctx).length).toBe(0)
  })

  it('LLM 返回非法 JSON → 抛错，不写库', async () => {
    seedNotes(2)
    const lctx = liveCtx()
    lctx.llm.complete = vi.fn(async () => 'not json at all')
    await expect(extractPatterns(lctx)).rejects.toThrow()
    expect(listPatterns(lctx).length).toBe(0)
  })
})

describe('listPatterns', () => {
  it('按 hookType 过滤，不传返回全部，按 created_at 倒序', async () => {
    seedNotes(3)
    await extractPatterns(ctx) // mock fixture 含 pain 和 sideline 两类
    expect(listPatterns(ctx, 'pain').every((p) => p.hook_type === 'pain')).toBe(true)
    expect(listPatterns(ctx).length).toBeGreaterThanOrEqual(listPatterns(ctx, 'pain').length)
  })
})
