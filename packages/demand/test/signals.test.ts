import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createLlmClient, loadConfig, openDb, type CoreCtx } from '@forgecast/core'
import { beforeEach, describe, expect, it } from 'vitest'
import { collectStatus, importSignals, listSignals, requestCollect, setSignalStatus } from '../src/signals'

let ctx: CoreCtx
beforeEach(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-demand-'))
  const config = loadConfig(root, {})
  ctx = { db: openDb(config.paths.db), config, llm: createLlmClient(config.llm) }
})

describe('importSignals', () => {
  it('批量入库；同 (source,title) 重复导入为更新且保留 kind/status', () => {
    const r1 = importSignals(ctx, { source: 'douyin_hot', signals: [
      { title: '热点A', summary: '说明A', heat: 90, evidence: { url: 'https://x.com/a' } },
      { title: '热点B', heat: 80 },
    ] })
    expect(r1).toEqual({ imported: 2, updated: 0 })
    // 手工标记 kind/status 模拟 extract+star 后再重复导入
    ctx.db.prepare("UPDATE demand_signals SET kind = 'traffic', status = 'starred' WHERE title = '热点A'").run()
    const r2 = importSignals(ctx, { source: 'douyin_hot', signals: [{ title: '热点A', heat: 95 }] })
    expect(r2).toEqual({ imported: 0, updated: 1 })
    const a = listSignals(ctx).find((s) => s.title === '热点A')!
    expect(a.heat).toBe(95)
    expect(a.kind).toBe('traffic') // upsert 不覆盖 kind
    expect(a.status).toBe('starred') // 不覆盖 status
  })
  it('未知 source 抛错；空 title 跳过', () => {
    expect(() => importSignals(ctx, { source: 'nope' as any, signals: [] })).toThrow(/未知数据源/)
    const r = importSignals(ctx, { source: 'xhs', signals: [{ title: '  ' }, { title: '正常' }] })
    expect(r.imported).toBe(1)
  })
  it('导入成功清除采集请求标记并记录采集时间', () => {
    requestCollect(ctx)
    expect(collectStatus(ctx).requestedAt).toBeTruthy()
    importSignals(ctx, { source: 'github_trending', signals: [{ title: 'repo/x' }] })
    const s = collectStatus(ctx)
    expect(s.requestedAt).toBeNull()
    expect(s.lastCollectedAt).toBeTruthy()
  })
})

describe('listSignals / setSignalStatus', () => {
  it('按 source/kind/status 筛选，heat 降序（NULL 排后）', () => {
    importSignals(ctx, { source: 'xhs', signals: [{ title: '低', heat: 1 }, { title: '高', heat: 9 }, { title: '无热度' }] })
    const all = listSignals(ctx)
    expect(all.map((s) => s.title)).toEqual(['高', '低', '无热度'])
    expect(listSignals(ctx, { source: 'douyin_hot' })).toEqual([])
    setSignalStatus(ctx, all[0].id, 'starred')
    expect(listSignals(ctx, { status: 'starred' }).map((s) => s.title)).toEqual(['高'])
  })
  it('setSignalStatus：非法状态/不存在 id 抛错', () => {
    importSignals(ctx, { source: 'xhs', signals: [{ title: 'x' }] })
    const id = listSignals(ctx)[0].id
    expect(() => setSignalStatus(ctx, id, 'bogus' as any)).toThrow(/非法状态/)
    expect(() => setSignalStatus(ctx, 9999, 'starred')).toThrow(/不存在/)
  })
})
