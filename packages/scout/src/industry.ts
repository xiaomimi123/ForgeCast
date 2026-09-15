import type { CoreCtx } from '@forgecast/core'

export interface Industry {
  id: number
  name: string
  note: string | null
  enabled: number
}

/** mock 词表：8 个 seed 行业各 12-20 个 GitHub 上真实存在的英文技术关键词。
 *  **这是 generateIndustryQueries 的 mock 分支专属数据**——绝不借道 ctx.llm 拿通用返回
 *  （mock LLM 返回的是文案 fixture，拿来当搜索词是灾难）。 */
export const INDUSTRY_MOCK_KEYWORDS: Record<string, string[]> = {
  资讯媒体: [
    'rss-reader', 'news-aggregator', 'headless-cms', 'content-management', 'publishing',
    'newsletter', 'feed-parser', 'web-scraper', 'markdown-editor', 'static-site-generator',
    'social-media-scheduler', 'media-library', 'digital-asset-management', 'editorial-workflow',
  ],
  情感社交: [
    'social-network', 'community-forum', 'chat-app', 'instant-messaging', 'matchmaking',
    'dating-app', 'user-profile', 'group-chat', 'moderation', 'private-messaging',
    'follow-system', 'activity-feed', 'live-stream', 'friend-recommendation',
  ],
  教育培训: [
    'lms', 'learning-management-system', 'course-platform', 'online-course', 'quiz',
    'exam-system', 'student-management', 'e-learning', 'classroom', 'attendance',
    'grading', 'tutoring', 'flashcards', 'assignment', 'enrollment',
  ],
  外贸跨境: [
    'erp', 'quotation', 'invoice', 'shipping', 'logistics',
    'inventory-management', 'multi-currency', 'order-management', 'purchase-order', 'customs',
    'b2b-ecommerce', 'supplier-management', 'payment-gateway', 'shipment-tracking', 'i18n',
  ],
  本地生活服务: [
    'booking', 'appointment-scheduling', 'reservation', 'point-of-sale', 'membership',
    'loyalty-program', 'coupon', 'review-system', 'store-management', 'queue-management',
    'local-business', 'service-booking', 'check-in', 'voucher',
  ],
  健康养生: [
    'clinic-management', 'ehr', 'emr', 'patient-management', 'appointment-booking',
    'health-tracker', 'fitness-tracker', 'nutrition', 'wellness', 'medical-records',
    'telemedicine', 'spa-booking', 'treatment-plan', 'medication-reminder',
  ],
  汽车房产: [
    'real-estate', 'property-management', 'dealership', 'car-rental', 'vehicle-management',
    'listing', 'rental-management', 'lease-management', 'contract-management', 'mortgage',
    'inspection', 'commission', 'showing-scheduler', 'tenant-portal',
  ],
  餐饮零售: [
    'restaurant-management', 'point-of-sale', 'menu', 'order-management', 'kitchen-display',
    'table-booking', 'retail', 'stock-management', 'shift-scheduling', 'loyalty-program',
    'food-delivery', 'barcode', 'receipt-printing', 'supplier-management',
  ],
}

/** 词表里没有的行业名（用户自建行业跑 mock）用的通用回落词，不让选品在 mock 下空转。 */
const FALLBACK_MOCK_KEYWORDS = [
  'crm', 'invoice', 'booking', 'dashboard', 'form-builder', 'inventory-management',
  'point-of-sale', 'survey', 'wiki', 'chatbot', 'scheduling', 'e-commerce',
]

/** live 生成的关键词最多取这么多（GitHub 一词一次搜索，再多纯烧额度）。 */
const MAX_KEYWORDS = 20

/** 按行业名+note 生成 GitHub 搜索关键词。
 *  mock：读 INDUSTRY_MOCK_KEYWORDS 固定表；live：调 LLM。两条路都写 industry_queries 缓存。 */
export async function generateIndustryQueries(ctx: CoreCtx, industry: Industry): Promise<string[]> {
  let keywords: string[]
  let model = 'mock'
  if (ctx.config.llm.mode === 'mock') {
    keywords = INDUSTRY_MOCK_KEYWORDS[industry.name] ?? FALLBACK_MOCK_KEYWORDS
  } else {
    model = ctx.config.llm.models.analysis
    const system = '你是开源选品的搜索词专家。只输出 JSON，不要多余文字。'
    const prompt = [
      `我要在 GitHub 上找能"换皮"成商业产品、卖给下面这个行业中小老板的开源项目。`,
      `行业：${industry.name}`,
      `行业里老板的真实业务场景：${industry.note ?? '（未提供）'}`,
      `请给出 12-20 个用于 GitHub 搜索的英文技术关键词，要求：`,
      `- 必须是 GitHub 上真实存在、能搜到项目的词（topic 名或通用技术词），不要生造`,
      `- 优先"业务系统"类词（如 crm / booking / invoice / inventory-management），不要给框架、UI 库、脚手架类词`,
      `- 全小写，单词间用连字符，不要中文，不要引号`,
      `输出 JSON：{"keywords":["...","..."]}`,
    ].join('\n')
    const raw = await ctx.llm.complete({ model, system, prompt })
    keywords = parseKeywords(raw)
  }
  keywords = [...new Set(keywords.map((k) => k.trim().toLowerCase()).filter(Boolean))].slice(0, MAX_KEYWORDS)
  ctx.db.prepare(
    `INSERT INTO industry_queries (industry_id, keywords, model, generated_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(industry_id) DO UPDATE SET keywords=excluded.keywords, model=excluded.model, generated_at=excluded.generated_at`,
  ).run(industry.id, JSON.stringify(keywords), model)
  return keywords
}

/** 有缓存读缓存（不烧 LLM），没有才生成。 */
export async function queriesFor(ctx: CoreCtx, industry: Industry): Promise<string[]> {
  const row = ctx.db.prepare('SELECT keywords FROM industry_queries WHERE industry_id = ?').get(industry.id) as
    { keywords: string } | undefined
  if (row) {
    try {
      const kws = JSON.parse(row.keywords)
      if (Array.isArray(kws) && kws.length) return kws.map(String)
    } catch { /* 缓存坏了 → 重新生成覆盖 */ }
  }
  return generateIndustryQueries(ctx, industry)
}

/** LLM 返回里抠关键词数组：支持 {"keywords":[...]} 与裸数组两种写法。 */
function parseKeywords(text: string): string[] {
  const m = text.match(/\{[\s\S]*\}/) ?? text.match(/\[[\s\S]*\]/)
  if (!m) throw new Error('行业搜索词 LLM 未返回 JSON')
  let o: any
  try { o = JSON.parse(m[0]) } catch { throw new Error('行业搜索词 LLM 返回的不是合法 JSON') }
  const arr = Array.isArray(o) ? o : o?.keywords
  if (!Array.isArray(arr) || !arr.length) throw new Error('行业搜索词 LLM 返回里没有 keywords 数组')
  return arr.map(String)
}

// 模板/脚手架：名字或描述命中即嫌疑
const TEMPLATE_RE = /template|boilerplate|starter|theme|scaffold|admin-ui|component-library|awesome-|example|demo|tutorial|learning/i
// 业务实证（反证）：README 里出现即说明它是真业务系统而非空壳，命中则不排
// （典型用例：vue-element-admin 名字带 admin，但 README 有 api + role，是真后台而非纯 UI 皮）
const BUSINESS_PROOF_RE = /database|schema|migration|model|api|endpoint|auth|role|permission|order|customer|invoice|workflow|prisma|sequelize|django|rails/i

/** 模板硬排：名字/描述像脚手架，且 README 拿不出业务实证 → true（跳过，连 candidate 都不建）。纯函数。 */
export function isTemplateRepo(repo: string, description: string | null, readme: string): boolean {
  if (!TEMPLATE_RE.test(`${repo} ${description ?? ''}`)) return false
  return !BUSINESS_PROOF_RE.test(readme)
}

/** README 里有业务实证词 / 有数据模型词——mock 业务含量推分用，顺带给出人看的理由。 */
export function businessProofHits(readme: string): { proof: boolean; dataModel: boolean } {
  return {
    proof: BUSINESS_PROOF_RE.test(readme),
    dataModel: /database|schema|\bmodel\b|migration|prisma|sequelize/i.test(readme),
  }
}
