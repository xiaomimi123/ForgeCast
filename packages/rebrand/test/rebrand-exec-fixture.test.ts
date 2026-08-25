import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { mockClone, mockRunAgent, mockRunBuild } from '../src/fixtures/rebrand-exec-fixture'

let dir: string
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-rbx-fix-')) })

describe('mockClone', () => {
  it('写占位 package.json + README.md，不发真实请求', async () => {
    await mockClone('https://github.com/x/y', dir)
    expect(fs.existsSync(path.join(dir, 'package.json'))).toBe(true)
    expect(fs.existsSync(path.join(dir, 'README.md'))).toBe(true)
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
    expect(pkg.name).toBe('original-project')
    expect(pkg.scripts.build).toBeTruthy()
  })
})

describe('mockRunAgent', () => {
  it('把 package.json name 改成 rebranded，返回 done 状态', async () => {
    await mockClone('https://github.com/x/y', dir)
    const result = await mockRunAgent('随便什么 prompt', dir)
    expect(result.status).toBe('done')
    expect(result.changedFiles).toContain('package.json')
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
    expect(pkg.name).toBe('rebranded')
  })
})

describe('mockRunBuild', () => {
  it('固定返回 ok:true', async () => {
    const r = await mockRunBuild(dir)
    expect(r.ok).toBe(true)
  })
})
