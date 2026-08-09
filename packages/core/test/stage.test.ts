import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { openDb } from '../src/db'
import { advanceStage, isStage, STAGES } from '../src/stage'

let db: ReturnType<typeof openDb>
let projectId: number
beforeEach(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-stage-'))
  db = openDb(path.join(root, 'db', 't.db'))
  const info = db.prepare("INSERT INTO projects (slug, stage) VALUES ('demo', 'analysis')").run()
  projectId = Number(info.lastInsertRowid)
})

describe('isStage', () => {
  it('合法值通过，非法值/非字符串拒绝', () => {
    for (const s of STAGES) expect(isStage(s)).toBe(true)
    expect(isStage('xxx')).toBe(false)
    expect(isStage(undefined)).toBe(false)
    expect(isStage(123)).toBe(false)
  })
})

describe('advanceStage', () => {
  it('目标排名高于当前：推进', () => {
    advanceStage(db, projectId, 'producing')
    const row = db.prepare('SELECT stage FROM projects WHERE id = ?').get(projectId) as any
    expect(row.stage).toBe('producing')
  })
  it('目标排名低于当前：不回退', () => {
    db.prepare("UPDATE projects SET stage = 'producing' WHERE id = ?").run(projectId)
    advanceStage(db, projectId, 'analysis')
    const row = db.prepare('SELECT stage FROM projects WHERE id = ?').get(projectId) as any
    expect(row.stage).toBe('producing')
  })
  it('目标与当前同级：原地不动', () => {
    db.prepare("UPDATE projects SET stage = 'rebranding' WHERE id = ?").run(projectId)
    advanceStage(db, projectId, 'rebranding')
    const row = db.prepare('SELECT stage FROM projects WHERE id = ?').get(projectId) as any
    expect(row.stage).toBe('rebranding')
  })
  it('当前 stage 是脏数据（不在枚举内）：按最低排名处理，可被拉回合法值', () => {
    db.prepare("UPDATE projects SET stage = 'xxx' WHERE id = ?").run(projectId)
    advanceStage(db, projectId, 'analysis')
    const row = db.prepare('SELECT stage FROM projects WHERE id = ?').get(projectId) as any
    expect(row.stage).toBe('analysis')
  })
})
