import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createLlmClient, loadConfig, openDb, type CoreCtx } from '@forgecast/core'
import { beforeEach, describe, expect, it } from 'vitest'
import { generateProposal, renderProposalMock } from '../src/proposal'
import { addCapability, addRequest, getRequestDetail, updateCapability } from '../src/requests'

let ctx: CoreCtx
beforeEach(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-prop-'))
  const config = loadConfig(root, {})
  ctx = { db: openDb(config.paths.db), config, llm: createLlmClient(config.llm) }
})

function seedDecided(): number {
  const { id } = addRequest(ctx, { title: '宠物店小程序', rawNeed: '要登录和支付' })
  const a = addCapability(ctx, id, { name: '登录', keywords: ['oauth'] }).id
  const b = addCapability(ctx, id, { name: '支付', keywords: ['payment'] }).id
  ctx.db.prepare("INSERT INTO tailor_wheels (capability_id, repo, url, license, license_ok, stars, score, score_detail) VALUES (?, 'a/login', 'http://u', 'MIT', 1, 100, 80, '{}')").run(a)
  updateCapability(ctx, a, { decision: 'wheel', chosenRepo: 'a/login' })
  updateCapability(ctx, b, { decision: 'self_build' })
  return id
}

describe('renderProposalMock', () => {
  it('含标题/选型总表/选中轮子链接；dropped 项不进表', () => {
    const id = seedDecided()
    const c = addCapability(ctx, id, { name: '弃项', keywords: ['x'] }).id
    updateCapability(ctx, c, { decision: 'dropped' })
    const md = renderProposalMock(getRequestDetail(ctx, id))
    expect(md).toContain('拼装方案书')
    expect(md).toContain('选型总表')
    expect(md).toContain('[a/login](http://u)')
    expect(md).not.toContain('弃项')
  })
})

describe('generateProposal', () => {
  it('有 pending 决策抛错；没能力清单抛错', async () => {
    const { id } = addRequest(ctx, { title: 'x', rawNeed: 'n' })
    await expect(generateProposal(ctx, id)).rejects.toThrow(/先拆解/)
    addCapability(ctx, id, { name: 'a', keywords: ['k'] })
    await expect(generateProposal(ctx, id)).rejects.toThrow(/未决策/)
  })
  it('mock 写文件、status→proposed、proposal_path 回填', async () => {
    const id = seedDecided()
    const { path: rel } = await generateProposal(ctx, id)
    expect(rel).toBe(path.join('tailor', String(id), 'proposal.md'))
    const abs = path.join(ctx.config.paths.workspace, rel)
    expect(fs.readFileSync(abs, 'utf8')).toContain('拼装方案书')
    const d = getRequestDetail(ctx, id)
    expect(d.request.status).toBe('proposed')
    expect(d.request.proposal_path).toBe(rel)
  })
  it('live 内容过短重试一次，仍短则抛', async () => {
    const id = seedDecided()
    fs.mkdirSync(path.join(ctx.config.paths.templates, 'prompts'), { recursive: true })
    fs.writeFileSync(path.join(ctx.config.paths.templates, 'prompts', 'tailor-proposal.md'), 'tpl')
    ctx.config.llm.mode = 'live'
    let calls = 0
    ctx.llm = { complete: async () => { calls++; return '太短' } }
    await expect(generateProposal(ctx, id)).rejects.toThrow(/过短/)
    expect(calls).toBe(2)
  })
})
