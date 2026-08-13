import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createLlmClient, loadConfig, openDb, type CoreCtx } from '@forgecast/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { extractSignals } from '../src/extract'
import { importSignals, listSignals } from '../src/signals'

let ctx: CoreCtx
let root: string
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-dext-'))
  const config = loadConfig(root, {}) // llm mock
  ctx = { db: openDb(config.paths.db), config, llm: createLlmClient(config.llm) }
})

describe('extractSignals mock', () => {
  it('给 kind 为空的信号填 kind+opportunity，不调 ctx.llm；已分类的不动', async () => {
    importSignals(ctx, { source: 'douyin_hot', signals: [{ title: 'A' }, { title: 'B' }] })
    ctx.db.prepare("UPDATE demand_signals SET kind = 'supply', opportunity = '既有' WHERE title = 'B'").run()
    const spy = vi.spyOn(ctx.llm, 'complete')
    const n = await extractSignals(ctx)
    expect(n).toBe(1)
    expect(spy).not.toHaveBeenCalled()
    const a = listSignals(ctx).find((s) => s.title === 'A')!
    expect(a.kind).toBeTruthy()
    expect(a.opportunity).toBeTruthy()
    expect(listSignals(ctx).find((s) => s.title === 'B')!.opportunity).toBe('既有')
  })
  it('没有待分类信号 → 返回 0 不调 LLM', async () => {
    expect(await extractSignals(ctx)).toBe(0)
  })
})

describe('extractSignals live（假 LLM）', () => {
  function liveCtx(completeImpl: () => Promise<string>): CoreCtx {
    const config = loadConfig(root, { FORGECAST_LLM_MODE: 'live', FORGECAST_LLM_KEY: 'k' })
    config.paths.templates = path.resolve(__dirname, '../../../templates')
    return { db: ctx.db, config, llm: { complete: vi.fn(completeImpl) } as any }
  }
  it('合法 JSON → 回写 kind/opportunity', async () => {
    importSignals(ctx, { source: 'xhs', signals: [{ title: 'C' }] })
    const id = listSignals(ctx)[0].id
    const lctx = liveCtx(async () => JSON.stringify([{ id, kind: 'emotional', opportunity: '可做情绪陪伴类定制' }]))
    expect(await extractSignals(lctx)).toBe(1)
    expect(listSignals(ctx)[0].kind).toBe('emotional')
  })
  it('非法输出（错 id/错 kind/空 opportunity）→ 整批抛错不写脏数据', async () => {
    importSignals(ctx, { source: 'xhs', signals: [{ title: 'D' }] })
    const lctx = liveCtx(async () => JSON.stringify([{ id: 9999, kind: 'traffic', opportunity: 'x' }]))
    await expect(extractSignals(lctx)).rejects.toThrow(/非法/)
    expect(listSignals(ctx)[0].kind).toBeNull() // 没被写脏
  })
})
