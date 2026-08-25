import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadConfig, openDb, type CoreCtx } from '@forgecast/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentResult } from '../src/fixtures/rebrand-exec-fixture'
import { rebrandExec } from '../src/rebrand-exec'

let ctx: CoreCtx
let root: string

function seedProject(slug: string, opts: { withPlan?: boolean; withCandidate?: boolean } = {}) {
  const { withPlan = true, withCandidate = true } = opts
  let candidateId: number | null = null
  if (withCandidate) {
    const info = ctx.db.prepare(
      "INSERT INTO candidates (repo, url, license_ok) VALUES (?, ?, 1)",
    ).run(`owner/${slug}`, `https://github.com/owner/${slug}`)
    candidateId = Number(info.lastInsertRowid)
  }
  ctx.db.prepare('INSERT INTO projects (slug, candidate_id) VALUES (?, ?)').run(slug, candidateId)
  const dir = path.join(root, 'workspace', slug)
  fs.mkdirSync(dir, { recursive: true })
  if (withPlan) fs.writeFileSync(path.join(dir, 'rebrand-plan.md'), '# demo 换皮改造清单\n## 1. 品牌替换\n- x')
}

function ok(): AgentResult { return { status: 'done', summary: '改完了', changedFiles: ['a.ts'] } }

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-rbx-'))
  const config = loadConfig(root, {})
  ctx = { db: openDb(config.paths.db), config, llm: null as any }
})

describe('rebrandExec 前置检查', () => {
  it('无 rebrand-plan.md → 抛错', async () => {
    seedProject('demo', { withPlan: false })
    await expect(rebrandExec(ctx, 'demo', { deps: { clone: vi.fn(), runAgent: vi.fn(), runBuild: vi.fn() } }))
      .rejects.toThrow(/先跑 forgecast rebrand/)
  })
  it('项目无关联 candidate（拿不到仓库地址）→ 抛错', async () => {
    seedProject('demo', { withCandidate: false })
    await expect(rebrandExec(ctx, 'demo', { deps: { clone: vi.fn(), runAgent: vi.fn(), runBuild: vi.fn() } }))
      .rejects.toThrow(/缺少候选来源/)
  })
})

describe('rebrandExec clone 幂等', () => {
  it('source-full/ 已存在且未传 fresh → 不调 clone', async () => {
    seedProject('demo')
    fs.mkdirSync(path.join(root, 'workspace', 'demo', 'source-full'), { recursive: true })
    const clone = vi.fn(async () => {})
    const runAgent = vi.fn(async () => ok())
    const runBuild = vi.fn(async () => ({ ok: true, output: '' }))
    await rebrandExec(ctx, 'demo', { deps: { clone, runAgent, runBuild } })
    expect(clone).not.toHaveBeenCalled()
  })
  it('--fresh → 即使已存在也重新 clone', async () => {
    seedProject('demo')
    fs.mkdirSync(path.join(root, 'workspace', 'demo', 'source-full'), { recursive: true })
    const clone = vi.fn(async () => {})
    const runAgent = vi.fn(async () => ok())
    const runBuild = vi.fn(async () => ({ ok: true, output: '' }))
    await rebrandExec(ctx, 'demo', { fresh: true, deps: { clone, runAgent, runBuild } })
    expect(clone).toHaveBeenCalledWith(`https://github.com/owner/demo`, path.join(root, 'workspace', 'demo', 'source-full'))
  })
})

describe('rebrandExec 重试状态机', () => {
  it('首轮 build 就过 → status=done，rounds=1', async () => {
    seedProject('demo')
    const runBuild = vi.fn(async () => ({ ok: true, output: '' }))
    const r = await rebrandExec(ctx, 'demo', { deps: { clone: vi.fn(async () => {}), runAgent: vi.fn(async () => ok()), runBuild } })
    expect(r).toEqual(expect.objectContaining({ status: 'done', rounds: 1 }))
    expect(runBuild).toHaveBeenCalledTimes(1)
  })
  it('第一轮失败、第二轮成功 → status=done，rounds=2', async () => {
    seedProject('demo')
    let call = 0
    const runBuild = vi.fn(async () => { call++; return call === 1 ? { ok: false, output: 'err1' } : { ok: true, output: '' } })
    const r = await rebrandExec(ctx, 'demo', { deps: { clone: vi.fn(async () => {}), runAgent: vi.fn(async () => ok()), runBuild } })
    expect(r).toEqual(expect.objectContaining({ status: 'done', rounds: 2 }))
  })
  it('三轮全失败 → status=build-failed，rounds=3', async () => {
    seedProject('demo')
    const runBuild = vi.fn(async () => ({ ok: false, output: 'still broken' }))
    const runAgent = vi.fn(async () => ok())
    const r = await rebrandExec(ctx, 'demo', { deps: { clone: vi.fn(async () => {}), runAgent, runBuild } })
    expect(r).toEqual(expect.objectContaining({ status: 'build-failed', rounds: 3 }))
    expect(runAgent).toHaveBeenCalledTimes(3)
    expect(runBuild).toHaveBeenCalledTimes(3)
  })
  it('runBuild 返回 null（无可用验证脚本）→ status=no-buildscript，不重试', async () => {
    seedProject('demo')
    const runAgent = vi.fn(async () => ok())
    const runBuild = vi.fn(async () => null)
    const r = await rebrandExec(ctx, 'demo', { deps: { clone: vi.fn(async () => {}), runAgent, runBuild } })
    expect(r).toEqual(expect.objectContaining({ status: 'no-buildscript', rounds: 1 }))
    expect(runAgent).toHaveBeenCalledTimes(1)
  })
})

describe('rebrandExec 报告', () => {
  it('写 rebrand-exec-report.md，含状态/轮数/summary/changedFiles', async () => {
    seedProject('demo')
    const r = await rebrandExec(ctx, 'demo', {
      deps: {
        clone: vi.fn(async () => {}),
        runAgent: vi.fn(async () => ({ status: 'done', summary: '品牌名换成了 Demo', changedFiles: ['package.json', 'src/App.tsx'] })),
        runBuild: vi.fn(async () => ({ ok: true, output: '' })),
      },
    })
    expect(r.reportPath).toBe(path.join('demo', 'rebrand-exec-report.md'))
    const report = fs.readFileSync(path.join(root, 'workspace', r.reportPath), 'utf8')
    expect(report).toContain('状态：done')
    expect(report).toContain('轮数：1')
    expect(report).toContain('品牌名换成了 Demo')
    expect(report).toContain('package.json')
    expect(report).toContain('src/App.tsx')
  })
  it('build-failed 时报告里含最后一次 build 输出', async () => {
    seedProject('demo')
    await rebrandExec(ctx, 'demo', {
      deps: {
        clone: vi.fn(async () => {}),
        runAgent: vi.fn(async () => ok()),
        runBuild: vi.fn(async () => ({ ok: false, output: 'TypeError: xxx is not a function' })),
      },
    })
    const report = fs.readFileSync(path.join(root, 'workspace', 'demo', 'rebrand-exec-report.md'), 'utf8')
    expect(report).toContain('build-failed')
    expect(report).toContain('TypeError: xxx is not a function')
  })
})
