import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadConfig, openDb, type CoreCtx } from '@forgecast/core'
import { beforeEach, describe, expect, it } from 'vitest'
import { rebrandExecAuto } from '../src/rebrand-exec'

let ctx: CoreCtx
let root: string

function seedProject(slug: string) {
  const info = ctx.db.prepare("INSERT INTO candidates (repo, url, license_ok) VALUES (?, ?, 1)").run(`owner/${slug}`, `https://github.com/owner/${slug}`)
  ctx.db.prepare('INSERT INTO projects (slug, candidate_id) VALUES (?, ?)').run(slug, Number(info.lastInsertRowid))
  const dir = path.join(root, 'workspace', slug)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'rebrand-plan.md'), '# demo 换皮改造清单\n## 1. 品牌替换\n- x')
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-rbx-auto-'))
})

describe('rebrandExecAuto mode 装配', () => {
  it('config.rebrandExec.mode=mock（默认）→ 走 mock fixture，不碰网络，跑完 status=done', async () => {
    const config = loadConfig(root, {})
    ctx = { db: openDb(config.paths.db), config, llm: null as any }
    seedProject('demo')
    const r = await rebrandExecAuto(ctx, 'demo')
    expect(r.status).toBe('done')
    expect(r.rounds).toBe(1)
    // mock clone 落的占位 package.json 应该被 mock agent 改了 name
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'workspace', 'demo', 'source-full', 'package.json'), 'utf8'))
    expect(pkg.name).toBe('rebranded')
  })
})
