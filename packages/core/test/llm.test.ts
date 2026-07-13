import { describe, expect, it, vi } from 'vitest'
import { copyFixtures } from '../src/fixtures/copy-fixtures'
import { createLlmClient } from '../src/llm'
import { HOOKS } from '../src/types'

const liveCfg = { mode: 'live' as const, baseURL: 'https://x.test/v1', apiKey: 'k', models: { analysis: 'a', copy: 'c', scoring: 's' } }
const mockCfg = { ...liveCfg, mode: 'mock' as const }

describe('mock 模式', () => {
  it('按提示词中的钩子标记返回对应 fixture', async () => {
    const llm = createLlmClient(mockCfg)
    const out = await llm.complete({ model: 'c', prompt: '【钩子类型】pain\n……' })
    expect(out).toBe(copyFixtures.pain)
  })
  it('四个 fixture 都含契约的五个段落', () => {
    for (const hook of HOOKS) {
      const f = copyFixtures[hook]
      for (const sec of ['## 标题', '## 小红书正文', '## 抖音口播脚本', '## 封面文案', '## 评论区运营']) {
        expect(f, `${hook} 缺 ${sec}`).toContain(sec)
      }
    }
  })
})

describe('live 模式', () => {
  it('OpenAI 兼容调用并取回文本', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: '生成结果' } }],
    })))
    const llm = createLlmClient(liveCfg, fetchImpl as any)
    const out = await llm.complete({ model: 'c', system: 'sys', prompt: 'hi' })
    expect(out).toBe('生成结果')
    const [url, init] = fetchImpl.mock.calls[0] as any
    expect(url).toBe('https://x.test/v1/chat/completions')
    const body = JSON.parse(init.body)
    expect(body.model).toBe('c')
    expect(body.messages[0]).toEqual({ role: 'system', content: 'sys' })
  })
  it('失败重试 2 次后抛错', async () => {
    const fetchImpl = vi.fn(async () => new Response('boom', { status: 500 }))
    const llm = createLlmClient(liveCfg, fetchImpl as any)
    await expect(llm.complete({ model: 'c', prompt: 'hi' })).rejects.toThrow(/500/)
    expect(fetchImpl).toHaveBeenCalledTimes(3)
  }, 15000)
})
