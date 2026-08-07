import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createLlmClient, loadConfig, openDb, type CoreCtx } from '@forgecast/core'
import { beforeEach, describe, expect, it } from 'vitest'
import { decomposeRequest, heuristicDecompose, parseDecomposeJson, validateDecompose } from '../src/decompose'
import { addRequest, getRequestDetail } from '../src/requests'

let ctx: CoreCtx
beforeEach(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-decomp-'))
  const config = loadConfig(root, {})
  ctx = { db: openDb(config.paths.db), config, llm: createLlmClient(config.llm) }
})

describe('heuristicDecompose', () => {
  it('按句切分出多项，每项 name/keywords 非空', () => {
    const caps = heuristicDecompose('要有微信扫码登录。要能在线预约排队。要有会员储值卡')
    expect(caps.length).toBe(3)
    for (const c of caps) {
      expect(c.name.trim()).not.toBe('')
      expect(c.keywords.length).toBeGreaterThanOrEqual(1)
    }
    expect(validateDecompose(caps)).toEqual([])
  })
  it('极短输入也兜底出 1 项', () => {
    const caps = heuristicDecompose('小程序')
    expect(caps.length).toBe(1)
    expect(validateDecompose(caps)).toEqual([])
  })
})

describe('parseDecomposeJson / validateDecompose', () => {
  it('剥 ```json 围栏解析', () => {
    const raw = '```json\n[{"name":"登录","detail":"d","keywords":["oauth"]}]\n```'
    expect(parseDecomposeJson(raw)).toEqual([{ name: '登录', detail: 'd', keywords: ['oauth'] }])
  })
  it('非数组/malformed 抛错', () => {
    expect(() => parseDecomposeJson('{"name":"x"}')).toThrow()
    expect(() => parseDecomposeJson('not json')).toThrow()
  })
  it('validate: 空清单/缺 name/缺 keywords 被点名', () => {
    expect(validateDecompose([])).toContain('能力项为空')
    expect(validateDecompose([{ name: '', detail: '', keywords: ['k'] }])[0]).toMatch(/name/)
    expect(validateDecompose([{ name: 'x', detail: '', keywords: [] }])[0]).toMatch(/keywords/)
  })
})

describe('decomposeRequest', () => {
  it('mock 模式落库、status→decomposed', async () => {
    const { id } = addRequest(ctx, { title: 'A', rawNeed: '要有微信扫码登录。要能在线预约排队' })
    const r = await decomposeRequest(ctx, id)
    expect(r.count).toBeGreaterThanOrEqual(2)
    const d = getRequestDetail(ctx, id)
    expect(d.request.status).toBe('decomposed')
    expect(d.capabilities.length).toBe(r.count)
  })
  it('重拆清掉旧能力项与旧轮子', async () => {
    const { id } = addRequest(ctx, { title: 'A', rawNeed: '要有登录功能。要有支付功能' })
    await decomposeRequest(ctx, id)
    const capId = getRequestDetail(ctx, id).capabilities[0].id
    ctx.db.prepare("INSERT INTO tailor_wheels (capability_id, repo, url, score, score_detail) VALUES (?, 'a/b', 'u', 1, '{}')").run(capId)
    await decomposeRequest(ctx, id)
    expect((ctx.db.prepare('SELECT COUNT(*) AS n FROM tailor_wheels').get() as any).n).toBe(0)
  })
  it('live 首次返回坏 JSON 会重试一次', async () => {
    const { id } = addRequest(ctx, { title: 'A', rawNeed: 'x需求x' })
    fs.mkdirSync(path.join(ctx.config.paths.templates, 'prompts'), { recursive: true })
    fs.writeFileSync(path.join(ctx.config.paths.templates, 'prompts', 'tailor-decompose.md'), 'tpl')
    ctx.config.llm.mode = 'live'
    let calls = 0
    ctx.llm = { complete: async () => (++calls === 1 ? 'oops not json' : '[{"name":"登录","detail":"d","keywords":["oauth"]}]') }
    const r = await decomposeRequest(ctx, id)
    expect(calls).toBe(2)
    expect(r.count).toBe(1)
  })
  it('live 首次返回合法 JSON 但结构不合格（缺 keywords）也会重试一次', async () => {
    const { id } = addRequest(ctx, { title: 'A', rawNeed: 'x需求x' })
    fs.mkdirSync(path.join(ctx.config.paths.templates, 'prompts'), { recursive: true })
    fs.writeFileSync(path.join(ctx.config.paths.templates, 'prompts', 'tailor-decompose.md'), 'tpl')
    ctx.config.llm.mode = 'live'
    let calls = 0
    ctx.llm = {
      complete: async () =>
        ++calls === 1
          ? '[{"name":"登录","detail":"d","keywords":[]}]'
          : '[{"name":"登录","detail":"d","keywords":["oauth"]}]',
    }
    const r = await decomposeRequest(ctx, id)
    expect(calls).toBe(2)
    expect(r.count).toBe(1)
    const d = getRequestDetail(ctx, id)
    expect(d.request.status).toBe('decomposed')
    expect(d.capabilities.length).toBe(1)
  })
  it('需求不存在抛错', async () => {
    await expect(decomposeRequest(ctx, 999)).rejects.toThrow(/不存在/)
  })
})
