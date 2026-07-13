import type { CoreCtx } from '@forgecast/core'
import type { RepoMeta, ScoreDetail } from './types'

const TECHS = ['react', 'next', 'vue', 'node', 'python', 'go', 'docker']

/** mock：从 README 关键词确定性推分（离线、可测），live：调 LLM 读 README 打分 */
export async function scoreCandidate(ctx: CoreCtx, meta: RepoMeta, readme: string): Promise<ScoreDetail> {
  if (ctx.config.llm.mode === 'mock') return heuristicScore(meta, readme)

  const system = '你是开源项目商业化评估专家。只输出 JSON，不要多余文字。'
  const prompt = [
    `评估这个开源项目能否"换皮"成面向中国中小老板的付费产品，给三维打分（各维不超上限）：`,
    `- rebrandCost 换皮成本(0-30)：技术栈(React/Node/Next 高)、有无 Docker、i18n、UI 可主题化`,
    `- buyerClarity 买家清晰度(0-40)：能否一句话说清"什么老板会掏钱"，越垂直越高`,
    `- visualAppeal 内容可视性(0-30)：有无好看可演示的 UI（纯 CLI/后端低分）`,
    `输出 JSON：{"rebrandCost":n,"buyerClarity":n,"visualAppeal":n,"techStack":["..."],"rationale":"一句话"}`,
    `项目：${meta.repo}（topics: ${meta.topics.join(',')}, stars: ${meta.stars}）`,
    `README:\n${readme.slice(0, 6000)}`,
  ].join('\n')
  const raw = await ctx.llm.complete({ model: ctx.config.llm.models.analysis, system, prompt })
  return parseScoreJson(raw)
}

function heuristicScore(meta: RepoMeta, readme: string): ScoreDetail {
  const r = readme.toLowerCase()
  const has = (re: RegExp) => re.test(r)
  const rebrandCost = Math.min(30, 12 + (has(/docker/) ? 9 : 0) + (has(/react|next|vue|node/) ? 9 : 0))
  const buyerClarity = Math.min(40, 18 + (readme.length > 200 ? 10 : 0) + (has(/crm|invoice|chat|booking|shop|commerce|pos|survey|form/) ? 12 : 0))
  const visualAppeal = Math.min(30, 8 + (has(/screenshot|demo|preview/) ? 12 : 0) + (has(/dashboard|ui|interface/) ? 10 : 0))
  const techStack = TECHS.filter((t) => r.includes(t)).concat(meta.topics)
  return { rebrandCost, buyerClarity, visualAppeal, techStack: [...new Set(techStack)], rationale: `离线启发式评分：${meta.repo}` }
}

/** 从 LLM 文本里抽 JSON（可能包 ```json 围栏），并夹取维度到上限 */
function parseScoreJson(text: string): ScoreDetail {
  const m = text.match(/\{[\s\S]*\}/)
  if (!m) throw new Error('评分 LLM 未返回 JSON')
  const o = JSON.parse(m[0])
  const clamp = (v: any, max: number) => Math.max(0, Math.min(max, Number(v) || 0))
  return {
    rebrandCost: clamp(o.rebrandCost, 30),
    buyerClarity: clamp(o.buyerClarity, 40),
    visualAppeal: clamp(o.visualAppeal, 30),
    techStack: Array.isArray(o.techStack) ? o.techStack.map(String) : [],
    rationale: typeof o.rationale === 'string' ? o.rationale : '',
  }
}
