import type { ForgecastConfig } from './config'
import { copyFixtures } from './fixtures/copy-fixtures'
import { HOOKS, type HookType } from './types'

export interface CompleteOptions { model: string; system?: string; prompt: string }
export interface LlmClient { complete(opts: CompleteOptions): Promise<string> }

/** mock：从提示词首行【钩子类型】xxx 取 fixture；live：OpenAI 兼容调用，失败重试2次 */
export function createLlmClient(cfg: ForgecastConfig['llm'], fetchImpl: typeof fetch = fetch): LlmClient {
  if (cfg.mode === 'mock') {
    return {
      async complete(opts) {
        const m = opts.prompt.match(/【钩子类型】(\w+)/)
        const hook = (m?.[1] ?? 'pain') as HookType
        return copyFixtures[HOOKS.includes(hook) ? hook : 'pain']
      },
    }
  }
  return {
    async complete(opts) {
      let lastErr: unknown
      for (let attempt = 0; attempt <= 2; attempt++) {
        try {
          const res = await fetchImpl(`${cfg.baseURL}/chat/completions`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
            body: JSON.stringify({
              model: opts.model,
              messages: [
                ...(opts.system ? [{ role: 'system', content: opts.system }] : []),
                { role: 'user', content: opts.prompt },
              ],
            }),
          })
          if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${await res.text()}`)
          const data: any = await res.json()
          const text = data.choices?.[0]?.message?.content
          if (typeof text !== 'string' || !text) throw new Error('LLM 返回内容为空')
          return text
        } catch (err) {
          lastErr = err
          if (attempt < 2) await new Promise((r) => setTimeout(r, 500 * 2 ** attempt))
        }
      }
      throw lastErr
    },
  }
}
