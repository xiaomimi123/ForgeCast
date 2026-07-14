import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createLlmClient, loadConfig, openDb, type CoreCtx } from '@forgecast/core'
import { beforeEach, describe, expect, it } from 'vitest'
import { calendarSuggestions, weeklyReport } from '../src/schedule'

let ctx: CoreCtx
const NOW = new Date('2026-07-14T12:00:00Z')
function ins(hook: string, status: string, publishedAt?: string) {
  ctx.db.prepare(
    'INSERT INTO assets (project_id, type, hook, file_path, status, published_at) VALUES (1, ?, ?, ?, ?, ?)',
  ).run('copy', hook, `demo/copy/${hook}-${Math.random()}.md`, status, publishedAt ?? null)
}
beforeEach(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-sch-'))
  const config = loadConfig(root, {})
  ctx = { db: openDb(config.paths.db), config, llm: createLlmClient(config.llm) }
  ctx.db.prepare("INSERT INTO projects (slug) VALUES ('demo')").run()
})

describe('calendarSuggestions', () => {
  it('今日已发计数、库存、cooldown、建议', () => {
    ins('pain', 'approved')                                  // 库存
    ins('infogap', 'approved')                               // 库存
    ins('story', 'approved')                                 // 库存
    ins('pain', 'published', '2026-07-14 08:00:00')          // 今日已发 1
    ins('sideline', 'published', '2026-07-13 09:00:00')      // 1天前 → cooldown
    ins('story', 'published', '2026-07-01 09:00:00')         // 13天前 → 不 cooldown
    const v = calendarSuggestions(ctx, NOW)
    expect(v.date).toBe('2026-07-14')
    expect(v.publishedToday).toBe(1)
    expect(v.remainingToday).toBe(1)
    expect(v.inventory.pain).toBe(1)
    expect(v.inventory.infogap).toBe(1)
    expect(v.cooldown.sideline).toBeGreaterThan(0) // 1天前发过，冷却中
    expect(v.cooldown.pain).toBeGreaterThan(0)     // 今日发过 pain，冷却中
    // suggestions：条数 <= remainingToday，不含 cooldown 钩子，钩子互不重复
    expect(v.suggestions.length).toBeLessThanOrEqual(1)
    for (const s of v.suggestions) expect(s.hook in v.cooldown).toBe(false)
    const hooks = v.suggestions.map((s) => s.hook)
    expect(new Set(hooks).size).toBe(hooks.length)
  })
})

describe('weeklyReport', () => {
  it('按钩子统计发布数与询单数', () => {
    ins('pain', 'published', '2026-07-12 08:00:00')
    ins('pain', 'published', '2026-07-13 08:00:00')
    ins('story', 'published', '2026-07-13 08:00:00')
    const painId = (ctx.db.prepare("SELECT id FROM assets WHERE hook='pain' LIMIT 1").get() as any).id
    ctx.db.prepare("INSERT INTO leads (asset_id, created_at) VALUES (?, '2026-07-13 10:00:00')").run(painId)
    ctx.db.prepare("INSERT INTO leads (asset_id, created_at) VALUES (?, '2026-07-13 11:00:00')").run(painId)
    const r = weeklyReport(ctx, '2026-07-08')
    expect(r.perHook.pain.published).toBe(2)
    expect(r.perHook.pain.leads).toBe(2)
    expect(r.perHook.story.published).toBe(1)
    expect(r.totals.published).toBe(3)
    expect(r.totals.leads).toBe(2)
  })
})
