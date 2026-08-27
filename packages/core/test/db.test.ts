import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { openDb } from '../src/db'

function tmpDbPath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fc-')), 'test.db')
}

describe('openDb', () => {
  it('建表齐全且 WAL 开启', () => {
    const db = openDb(tmpDbPath())
    const names = db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')").all()
      .map((r: any) => r.name)
    for (const t of ['candidates', 'projects', 'assets', 'knowledge_atoms']) expect(names).toContain(t)
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal')
  })
  it('幂等：重复打开不报错', () => {
    const p = tmpDbPath()
    openDb(p).close()
    expect(() => openDb(p)).not.toThrow()
  })
  it('assets 可插入并带 warnings 列', () => {
    const db = openDb(tmpDbPath())
    db.prepare("INSERT INTO projects (slug) VALUES ('t1')").run()
    db.prepare(
      "INSERT INTO assets (project_id, type, hook, file_path, warnings) VALUES (1, 'copy', 'pain', 't1/copy/a.md', '[]')",
    ).run()
    const row: any = db.prepare('SELECT * FROM assets WHERE id = 1').get()
    expect(row.status).toBe('draft')
    expect(row.warnings).toBe('[]')
  })
  it('建 leads 表且 assets 有 published_url，重复打开幂等', () => {
    const p = tmpDbPath()
    const db = openDb(p)
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r: any) => r.name)
    expect(tables).toContain('leads')
    const cols = (db.prepare('PRAGMA table_info(assets)').all() as any[]).map((c) => c.name)
    expect(cols).toContain('published_url')
    db.close()
    expect(() => openDb(p)).not.toThrow()
  })
  it('tailor 三表存在且可重开（幂等）', () => {
    const db = openDb(tmpDbPath())
    for (const t of ['tailor_requests', 'tailor_capabilities', 'tailor_wheels']) {
      const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t)
      expect(row, t).toBeTruthy()
    }
    const r = db.prepare("INSERT INTO tailor_requests (title, raw_need) VALUES ('t','n')").run()
    expect(db.prepare('SELECT status FROM tailor_requests WHERE id=?').get(r.lastInsertRowid)).toEqual({ status: 'draft' })
  })
  it('candidates.favorite 列存在且默认 0', () => {
    const db = openDb(tmpDbPath())
    db.prepare("INSERT INTO candidates (repo, url) VALUES ('a/b', 'u')").run()
    const row = db.prepare("SELECT favorite FROM candidates WHERE repo = 'a/b'").get() as any
    expect(row.favorite).toBe(0)
  })
  it('candidates.source 列存在且默认 scout', () => {
    const db = openDb(tmpDbPath())
    db.prepare("INSERT INTO candidates (repo, url) VALUES ('a/b', 'u')").run()
    const row = db.prepare("SELECT source FROM candidates WHERE repo = 'a/b'").get() as any
    expect(row.source).toBe('scout')
  })
  it('custom_templates 表存在且可插入', () => {
    const db = openDb(tmpDbPath())
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='custom_templates'").get()
    expect(row).toBeTruthy()
    const pacing = JSON.stringify({ durationSec: 12, segments: [{ start: 0, end: 12 }] })
    const info = db.prepare(
      "INSERT INTO custom_templates (name, aspect_ratio, segment_count, style_note, benchmark_path, segments_json) VALUES ('对标A', 'portrait', 1, '科技感', '_templates/x/benchmark.mp4', ?)",
    ).run(pacing)
    const inserted: any = db.prepare('SELECT * FROM custom_templates WHERE id = ?').get(info.lastInsertRowid)
    expect(inserted.name).toBe('对标A')
    expect(inserted.aspect_ratio).toBe('portrait')
    expect(JSON.parse(inserted.segments_json).durationSec).toBe(12)
    expect(inserted.created_at).toBeTruthy()
  })
})
