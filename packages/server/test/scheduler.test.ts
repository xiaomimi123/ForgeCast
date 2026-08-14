import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createLlmClient, getAllSettings, loadConfig, openDb, setSettings, type CoreCtx } from '@forgecast/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { localDate, readAutoScoutCfg, runAutoScout, shouldAutoScout, startAutoScout } from '../src/scheduler'

let ctx: CoreCtx
beforeEach(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-sched-'))
  const config = loadConfig(root, {})
  ctx = { db: openDb(config.paths.db), config, llm: createLlmClient(config.llm) }
})

describe('shouldAutoScout', () => {
  const at = (h: number, m: number) => { const d = new Date(); d.setHours(h, m, 0, 0); return d }
  it('关着不跑', () => {
    expect(shouldAutoScout(at(9, 0), { enabled: false, time: '08:00', lastRunDate: '' })).toBe(false)
  })
  it('未到时间不跑', () => {
    expect(shouldAutoScout(at(7, 59), { enabled: true, time: '08:00', lastRunDate: '' })).toBe(false)
  })
  it('到点且今天没跑过 → 跑（含补跑：远超时间点也算）', () => {
    expect(shouldAutoScout(at(8, 0), { enabled: true, time: '08:00', lastRunDate: '' })).toBe(true)
    expect(shouldAutoScout(at(23, 0), { enabled: true, time: '08:00', lastRunDate: '' })).toBe(true)
  })
  it('今天已跑不再跑；昨天跑过今天照跑', () => {
    const now = at(9, 0)
    expect(shouldAutoScout(now, { enabled: true, time: '08:00', lastRunDate: localDate(now) })).toBe(false)
    expect(shouldAutoScout(now, { enabled: true, time: '08:00', lastRunDate: '2000-01-01' })).toBe(true)
  })
})

describe('readAutoScoutCfg', () => {
  it('默认 on/08:00；time 非法回落 08:00；off 生效', () => {
    expect(readAutoScoutCfg(ctx.db)).toEqual({ enabled: true, time: '08:00', lastRunDate: '' })
    setSettings(ctx.db, { auto_scout: 'off', auto_scout_time: 'abc', auto_scout_last_run: '2026-08-08' })
    expect(readAutoScoutCfg(ctx.db)).toEqual({ enabled: false, time: '08:00', lastRunDate: '2026-08-08' })
    setSettings(ctx.db, { auto_scout_time: '21:30' })
    expect(readAutoScoutCfg(ctx.db).time).toBe('21:30')
  })
  it('小时/分钟越界（25:00、12:99）回落 08:00；23:59 合法放行', () => {
    setSettings(ctx.db, { auto_scout_time: '25:00' })
    expect(readAutoScoutCfg(ctx.db).time).toBe('08:00')
    setSettings(ctx.db, { auto_scout_time: '12:99' })
    expect(readAutoScoutCfg(ctx.db).time).toBe('08:00')
    setSettings(ctx.db, { auto_scout_time: '23:59' })
    expect(readAutoScoutCfg(ctx.db).time).toBe('23:59')
  })
})

describe('runAutoScout', () => {
  it('成功：last_run=今天、last_result 记结果', async () => {
    await runAutoScout(ctx, async () => ({ found: 5, scored: 2, rejected: 1, added: 2 }))
    const s = getAllSettings(ctx.db)
    expect(s.auto_scout_last_run).toBe(localDate(new Date()))
    expect(JSON.parse(s.auto_scout_last_result!)).toMatchObject({ added: 2 })
  })
  it('失败：error 记入 last_result，last_run 仍标今天（次日才重试，避免整天打限流）', async () => {
    await runAutoScout(ctx, async () => { throw new Error('GitHub 限流') })
    const s = getAllSettings(ctx.db)
    expect(s.auto_scout_last_run).toBe(localDate(new Date()))
    expect(JSON.parse(s.auto_scout_last_result!).error).toMatch(/限流/)
  })
  it('默认走真 scoutCandidates（mock 全链路）：候选入库', async () => {
    await runAutoScout(ctx)
    const n = (ctx.db.prepare('SELECT COUNT(*) AS n FROM candidates').get() as any).n
    expect(n).toBeGreaterThan(0)
  })
  it('成功：cleanup 结果合并进 last_result（rescored/dismissed）', async () => {
    await runAutoScout(
      ctx,
      async () => ({ found: 5, scored: 2, rejected: 1, added: 2 }),
      async () => ({ rescored: 3, dismissed: 1 }),
    )
    const s = getAllSettings(ctx.db)
    const result = JSON.parse(s.auto_scout_last_result!)
    expect(result).toMatchObject({ added: 2, rescored: 3, dismissed: 1 })
  })
  it('清理失败：抓取结果（found/added）仍保留，附加 cleanupError', async () => {
    await runAutoScout(
      ctx,
      async () => ({ found: 5, scored: 2, rejected: 1, added: 2 }),
      async () => { throw new Error('清理挂了') },
    )
    const s = getAllSettings(ctx.db)
    const result = JSON.parse(s.auto_scout_last_result!)
    expect(result).toMatchObject({ found: 5, added: 2 })
    expect(result.cleanupError).toMatch(/清理挂了/)
  })
})

describe('startAutoScout', () => {
  it('启动即补跑（到点未跑时）；停止函数可用', async () => {
    setSettings(ctx.db, { auto_scout_time: '00:00' })
    const spy = vi.fn(async () => ({ found: 0, scored: 0, rejected: 0, added: 0 }))
    const stop = startAutoScout(ctx, { intervalMs: 3600_000, scout: spy })
    await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(1))
    stop()
  })
  it('关着则不跑', async () => {
    setSettings(ctx.db, { auto_scout: 'off', auto_scout_time: '00:00' })
    const spy = vi.fn(async () => ({ found: 0, scored: 0, rejected: 0, added: 0 }))
    const stop = startAutoScout(ctx, { intervalMs: 3600_000, scout: spy })
    await new Promise((r) => setTimeout(r, 50))
    expect(spy).not.toHaveBeenCalled()
    stop()
  })
  it('tick 内部异常（DB 已关闭，readAutoScoutCfg 抛错）不逃逸为 unhandled rejection，只打日志继续存活', async () => {
    setSettings(ctx.db, { auto_scout_time: '00:00' })
    let unhandledCount = 0
    const onUnhandled = () => { unhandledCount++ }
    process.on('unhandledRejection', onUnhandled)
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    ctx.db.close() // 之后 readAutoScoutCfg(ctx.db) 必抛错，模拟 T3 场景
    const spy = vi.fn(async () => { throw new Error('不该跑到这里') })
    try {
      const stop = startAutoScout(ctx, { intervalMs: 3600_000, scout: spy })
      await new Promise((r) => setTimeout(r, 50))
      stop()
      expect(unhandledCount).toBe(0)
      expect(errSpy).toHaveBeenCalled()
      expect(spy).not.toHaveBeenCalled()
    } finally {
      process.off('unhandledRejection', onUnhandled)
      errSpy.mockRestore()
    }
  })
})
