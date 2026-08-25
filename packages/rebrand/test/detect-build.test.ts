import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { detectAndRunBuild } from '../src/detect-build'

let dir: string
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-rbx-build-')) })

describe('detectAndRunBuild', () => {
  it('无 package.json → null', async () => {
    expect(await detectAndRunBuild(dir)).toBeNull()
  })
  it('有 package.json 但无 build/typecheck/lint script → null', async () => {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', scripts: { start: 'x' } }))
    expect(await detectAndRunBuild(dir)).toBeNull()
  })
  it('有 build script + node_modules 已存在 → 只跑 build，不跑 install', async () => {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', scripts: { build: 'echo hi' } }))
    fs.mkdirSync(path.join(dir, 'node_modules'))
    const run = vi.fn(async (cmd: string, args: string[]) => ({ code: 0, stdout: 'built', stderr: '' }))
    const r = await detectAndRunBuild(dir, { run: run as any })
    expect(r).toEqual({ ok: true, output: 'built' })
    expect(run).toHaveBeenCalledTimes(1)
    expect(run).toHaveBeenCalledWith('npm', ['run', 'build'], expect.objectContaining({ cwd: dir }))
  })
  it('无 node_modules → 先 install 再跑 build', async () => {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', scripts: { build: 'echo hi' } }))
    const calls: string[] = []
    const run = vi.fn(async (cmd: string, args: string[]) => { calls.push(`${cmd} ${args.join(' ')}`); return { code: 0, stdout: '', stderr: '' } })
    await detectAndRunBuild(dir, { run: run as any })
    expect(calls).toEqual(['npm install', 'npm run build'])
  })
  it('有 pnpm-lock.yaml → 用 pnpm', async () => {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', scripts: { build: 'echo hi' } }))
    fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), '')
    fs.mkdirSync(path.join(dir, 'node_modules'))
    const run = vi.fn(async () => ({ code: 0, stdout: '', stderr: '' }))
    await detectAndRunBuild(dir, { run: run as any })
    expect(run).toHaveBeenCalledWith('pnpm', ['run', 'build'], expect.anything())
  })
  it('非 0 退出码 → ok:false，output 含 stderr', async () => {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', scripts: { build: 'exit 1' } }))
    fs.mkdirSync(path.join(dir, 'node_modules'))
    const run = vi.fn(async () => ({ code: 1, stdout: '', stderr: 'type error at line 5' }))
    const r = await detectAndRunBuild(dir, { run: run as any })
    expect(r).toEqual({ ok: false, output: 'type error at line 5' })
  })
  it('没有 build 但有 typecheck → 用 typecheck', async () => {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', scripts: { typecheck: 'tsc' } }))
    fs.mkdirSync(path.join(dir, 'node_modules'))
    const run = vi.fn(async () => ({ code: 0, stdout: '', stderr: '' }))
    await detectAndRunBuild(dir, { run: run as any })
    expect(run).toHaveBeenCalledWith('npm', ['run', 'typecheck'], expect.anything())
  })
})
