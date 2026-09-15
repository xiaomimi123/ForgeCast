import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { openDb } from '../src/db'

function tmpDbPath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fc-')), 'test.db')
}

describe('行业表与默认行业 seed', () => {
  it('建表齐全：industries / industry_queries，candidates 有 industry_id 列', () => {
    const db = openDb(tmpDbPath())
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r: any) => r.name)
    expect(tables).toContain('industries')
    expect(tables).toContain('industry_queries')
    const cols = (db.prepare('PRAGMA table_info(candidates)').all() as any[]).map((c) => c.name)
    expect(cols).toContain('industry_id')
  })

  it('默认 8 行业 seed 齐全，sort_order 0..7，name 唯一', () => {
    const db = openDb(tmpDbPath())
    const rows = db.prepare('SELECT name, note, enabled, sort_order FROM industries ORDER BY sort_order').all() as any[]
    expect(rows.length).toBe(8)
    const names = rows.map((r) => r.name)
    expect(names).toEqual([
      '资讯媒体',
      '情感社交',
      '教育培训',
      '外贸跨境',
      '本地生活服务',
      '健康养生',
      '汽车房产',
      '餐饮零售',
    ])
    rows.forEach((r, i) => {
      expect(r.sort_order).toBe(i)
      expect(r.enabled).toBe(1)
      expect(typeof r.note).toBe('string')
      expect(r.note.length).toBeGreaterThan(0)
    })
  })

  it('幂等：同一 db 连跑两次 openDb，industries 仍是 8 行（不重复插）', () => {
    const p = tmpDbPath()
    openDb(p).close()
    const db2 = openDb(p)
    const count = db2.prepare('SELECT COUNT(*) AS c FROM industries').get() as any
    expect(count.c).toBe(8)
  })

  it('幂等：删掉一行再 openDb 会补回', () => {
    const p = tmpDbPath()
    const db = openDb(p)
    db.prepare("DELETE FROM industries WHERE name = '餐饮零售'").run()
    let count = db.prepare('SELECT COUNT(*) AS c FROM industries').get() as any
    expect(count.c).toBe(7)
    db.close()
    const db2 = openDb(p)
    count = db2.prepare('SELECT COUNT(*) AS c FROM industries').get() as any
    expect(count.c).toBe(8)
    const row = db2.prepare("SELECT * FROM industries WHERE name = '餐饮零售'").get() as any
    expect(row).toBeTruthy()
  })

  it('industry_queries 可插入，PK 为 industry_id，级联删除', () => {
    const db = openDb(tmpDbPath())
    db.pragma('foreign_keys = ON')
    const industry = db.prepare("SELECT id FROM industries WHERE name = '外贸跨境'").get() as any
    db.prepare("INSERT INTO industry_queries (industry_id, keywords, model) VALUES (?, ?, ?)").run(
      industry.id,
      JSON.stringify(['外贸询盘管理系统', '外贸报价单工具']),
      'test-model',
    )
    const row = db.prepare('SELECT * FROM industry_queries WHERE industry_id = ?').get(industry.id) as any
    expect(row).toBeTruthy()
    expect(JSON.parse(row.keywords).length).toBe(2)
    expect(row.generated_at === null || typeof row.generated_at === 'string').toBe(true)

    db.prepare('DELETE FROM industries WHERE id = ?').run(industry.id)
    const gone = db.prepare('SELECT * FROM industry_queries WHERE industry_id = ?').get(industry.id)
    expect(gone).toBeUndefined()
  })

  it('candidates.industry_id 可空，不影响既有插入流程', () => {
    const db = openDb(tmpDbPath())
    db.prepare("INSERT INTO candidates (repo, url) VALUES ('a/b', 'u')").run()
    const row = db.prepare("SELECT industry_id FROM candidates WHERE repo = 'a/b'").get() as any
    expect(row.industry_id).toBeNull()
  })
})
