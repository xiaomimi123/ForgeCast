import type { CoreCtx } from '@forgecast/core'
import type { RepoMeta, ScoreDetail } from './types'

const TECHS = ['react', 'next', 'vue', 'node', 'python', 'go', 'docker']

/** 领域类别闭集（顺序=启发式匹配优先级：先具体领域，AI 靠后，最后其它）。 */
export const CATEGORIES = ['客服/IM', 'CRM/销售', '电商/商城', '仪表盘/BI', '表单/问卷', '文档/知识库', '建站/CMS', '项目/协作', '财务/发票', '预约/排期', 'AI助手/Agent', '其它'] as const

const CATEGORY_KW: Array<[string, RegExp]> = [
  ['客服/IM', /chat|chatbot|chatwoot|helpdesk|support|客服|messaging|\bim\b/],
  ['CRM/销售', /crm|sales|lead|pipeline|销售|客户管理/],
  ['电商/商城', /ecommerce|commerce|shop|store|cart|\bpos\b|saleor|电商|商城/],
  ['仪表盘/BI', /dashboard|admin|analytics|\bbi\b|metabase|report|仪表盘|报表/],
  ['表单/问卷', /form|survey|questionnaire|poll|表单|问卷/],
  ['文档/知识库', /docs|wiki|knowledge|notion|markdown|文档|知识库/],
  ['建站/CMS', /\bcms\b|website|landing|wordpress|strapi|建站/],
  ['项目/协作', /project|task|kanban|todo|collaborat|项目管理|看板/],
  ['财务/发票', /invoice|accounting|finance|billing|payment|expense|财务|发票/],
  ['预约/排期', /booking|appointment|schedul|calendar|reservation|预约|排期/],
  ['AI助手/Agent', /\bai\b|\bllm\b|agent|\brag\b|gpt|assistant|langchain|智能|大模型/],
]

/** 启发式领域分类：repo+文本+techStack 拼小写，按 CATEGORY_KW 顺序首个命中的类；都不中→其它。 */
export function categorizeHeuristic(repo: string, text: string, techStack: string[]): string {
  const hay = `${repo} ${text} ${techStack.join(' ')}`.toLowerCase()
  for (const [cat, re] of CATEGORY_KW) if (re.test(hay)) return cat
  return '其它'
}

/** mock：从 README 关键词确定性推分（离线、可测），live：调 LLM 读 README 打分 */
export async function scoreCandidate(ctx: CoreCtx, meta: RepoMeta, readme: string): Promise<ScoreDetail> {
  if (ctx.config.llm.mode === 'mock') return heuristicScore(meta, readme)

  const system = '你是开源项目商业化评估专家。只输出 JSON，不要多余文字。'
  const prompt = [
    `评估这个开源项目能否"换皮"成面向中国中小老板的付费产品，给三维打分（各维不超上限）：`,
    `- rebrandCost 换皮成本(0-30)：技术栈(React/Node/Next 高)、有无 Docker、i18n、UI 可主题化`,
    `- buyerClarity 买家清晰度(0-40)：能否一句话说清"什么老板会掏钱"，越垂直越高`,
    `- visualAppeal 内容可视性(0-30)：有无好看可演示的 UI（纯 CLI/后端低分）`,
    `输出 JSON：{"rebrandCost":n,"buyerClarity":n,"visualAppeal":n,"techStack":["..."],"rationale":"一句话","targetBuyer":"什么老板会掏钱，一句话（行业+规模）","painPoint":"解决的行业痛点，一句话，注明现状成本","summaryZh":"这个项目是做什么的，一句话，中文","category":"从下列类别选一个最贴切的"}`,
    `类别（选一个）：${CATEGORIES.join(' / ')}`,
    `项目：${meta.repo}（topics: ${meta.topics.join(',')}, stars: ${meta.stars}）`,
    `README:\n${readme.slice(0, 6000)}`,
  ].join('\n')
  const raw = await ctx.llm.complete({ model: ctx.config.llm.models.analysis, system, prompt })
  const detail = parseScoreJson(raw)
  // LLM 给的类别不在闭集内 → 启发式兜底，杜绝表外标签
  detail.category = (CATEGORIES as readonly string[]).includes(detail.category) ? detail.category : categorizeHeuristic(meta.repo, readme, detail.techStack)
  return detail
}

function heuristicScore(meta: RepoMeta, readme: string): ScoreDetail {
  const r = readme.toLowerCase()
  const has = (re: RegExp) => re.test(r)
  const rebrandCost = Math.min(30, 12 + (has(/docker/) ? 9 : 0) + (has(/react|next|vue|node/) ? 9 : 0))
  const buyerClarity = Math.min(40, 18 + (readme.length > 200 ? 10 : 0) + (has(/crm|invoice|chat|booking|shop|commerce|pos|survey|form/) ? 12 : 0))
  const visualAppeal = Math.min(30, 8 + (has(/screenshot|demo|preview/) ? 12 : 0) + (has(/dashboard|ui|interface/) ? 10 : 0))
  const techStack = TECHS.filter((t) => r.includes(t)).concat(meta.topics)
  return {
    rebrandCost, buyerClarity, visualAppeal, techStack: [...new Set(techStack)],
    rationale: `离线启发式评分：${meta.repo}`,
    // mock 不编造买家与痛点——关键词拼出来的假数据比空着更坏
    targetBuyer: '', painPoint: '', summaryZh: '',
    category: categorizeHeuristic(meta.repo, readme, techStack),
  }
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
    targetBuyer: typeof o.targetBuyer === 'string' ? o.targetBuyer : '',
    painPoint: typeof o.painPoint === 'string' ? o.painPoint : '',
    summaryZh: typeof o.summaryZh === 'string' ? o.summaryZh : '',
    category: typeof o.category === 'string' ? o.category : '',
  }
}
