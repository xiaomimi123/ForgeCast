import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createLlmClient, loadConfig, openDb, type CoreCtx } from '@forgecast/core'
import { describe, expect, it, vi } from 'vitest'
import { generateCandidateIntro, heuristicIntro, parseIntroJson, validateIntro, type IntroDetail } from '../src/intro'

function seedCandidate(ctx: CoreCtx) {
  ctx.db.prepare("INSERT INTO candidates (repo,url,description,license_ok,status) VALUES ('a/adminlte','u','后台模板',1,'candidate')")
    .run()
  return (ctx.db.prepare("SELECT id FROM candidates WHERE repo='a/adminlte'").get() as any).id as number
}

const meta = { repo: 'a/adminlte', url: 'u', description: '后台管理模板', license: 'MIT', stars: 40000, lastCommit: null, topics: [] }

describe('heuristicIntro', () => {
  it('结构合法：features≥3、五个文本字段非空、含 generatedAt', () => {
    const d = heuristicIntro(meta, 'React admin dashboard template')
    expect(d.features.length).toBeGreaterThanOrEqual(3)
    expect(d.summary.trim()).not.toBe('')
    expect(d.targetUser.trim()).not.toBe('')
    expect(d.painPoint.trim()).not.toBe('')
    expect(d.rebrandIdea.trim()).not.toBe('')
    expect(typeof d.generatedAt).toBe('string')
    expect(validateIntro(d)).toEqual([])
  })
})

describe('parseIntroJson', () => {
  it('解析带 ```json 围栏的合法 JSON', () => {
    const raw = '```json\n{"summary":"s","features":["f1","f2","f3"],"targetUser":"t","painPoint":"p","rebrandIdea":"r"}\n```'
    const d = parseIntroJson(raw)
    expect(d.summary).toBe('s')
    expect(d.features).toEqual(['f1', 'f2', 'f3'])
    expect(d.rebrandIdea).toBe('r')
    expect(validateIntro(d)).toEqual([])
  })
  it('缺字段按空兜底，交给 validateIntro 判失败', () => {
    const d = parseIntroJson('{"summary":"s"}')
    expect(d.features).toEqual([])
    expect(validateIntro(d).sort()).toEqual(['features', 'painPoint', 'rebrandIdea', 'targetUser'])
  })
  it('malformed JSON 抛错', () => {
    expect(() => parseIntroJson('not json at all')).toThrow()
  })
})

describe('validateIntro', () => {
  it('features 少于 3 条判 features 不合格', () => {
    const d: IntroDetail = { summary: 's', features: ['a', 'b'], targetUser: 't', painPoint: 'p', rebrandIdea: 'r', generatedAt: '' }
    expect(validateIntro(d)).toEqual(['features'])
  })
  it('空串字段被列出', () => {
    const d: IntroDetail = { summary: '', features: ['a', 'b', 'c'], targetUser: '  ', painPoint: 'p', rebrandIdea: 'r', generatedAt: '' }
    expect(validateIntro(d).sort()).toEqual(['summary', 'targetUser'])
  })
})

describe('generateCandidateIntro', () => {
  it('mock 模式走 heuristicIntro，结构合法', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-intro-'))
    const config = loadConfig(root, {}) // mock
    const ctx: CoreCtx = { db: openDb(config.paths.db), config, llm: createLlmClient(config.llm) }
    const id = seedCandidate(ctx)
    const d = await generateCandidateIntro(ctx, id)
    expect(validateIntro(d)).toEqual([])
    expect(d.features.length).toBeGreaterThanOrEqual(3)
  })

  it('live 模式调 LLM 解析 JSON 并通过校验', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-intro2-'))
    const config = loadConfig(root, { FORGECAST_LLM_MODE: 'live', FORGECAST_LLM_KEY: 'k' })
    config.paths.templates = path.resolve(__dirname, '../../../templates')
    const llm = { complete: vi.fn(async () => '```json\n{"summary":"AdminLTE 是后台模板","features":["数据看板","权限管理","响应式布局"],"targetUser":"中小团队后台","painPoint":"自研后台成本高","rebrandIdea":"换 logo 卖给行业客户"}\n```') }
    const ctx: CoreCtx = { db: openDb(config.paths.db), config, llm: llm as any }
    const id = seedCandidate(ctx)
    const d = await generateCandidateIntro(ctx, id)
    expect(d.summary).toBe('AdminLTE 是后台模板')
    expect(d.features).toHaveLength(3)
    expect(llm.complete).toHaveBeenCalledOnce()
    expect(validateIntro(d)).toEqual([])
  })

  it('live LLM 返回缺字段 → 校验抛错（不返脏数据）', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-intro3-'))
    const config = loadConfig(root, { FORGECAST_LLM_MODE: 'live', FORGECAST_LLM_KEY: 'k' })
    config.paths.templates = path.resolve(__dirname, '../../../templates')
    const llm = { complete: vi.fn(async () => '{"summary":"只有简介"}') }
    const ctx: CoreCtx = { db: openDb(config.paths.db), config, llm: llm as any }
    const id = seedCandidate(ctx)
    await expect(generateCandidateIntro(ctx, id)).rejects.toThrow(/缺字段/)
  })

  it('候选不存在 → 抛错', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-intro4-'))
    const config = loadConfig(root, {})
    const ctx: CoreCtx = { db: openDb(config.paths.db), config, llm: createLlmClient(config.llm) }
    await expect(generateCandidateIntro(ctx, 999)).rejects.toThrow(/候选不存在/)
  })
})
