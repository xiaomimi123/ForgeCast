import type { CoreCtx } from '@forgecast/core'

export interface Industry {
  id: number
  name: string
  note: string | null
  enabled: number
}

/** mock 词表：8 个 seed 行业各 12-20 个 GitHub topic。
 *  **表里每个词都实调过 GitHub 搜索接口**（`topic:<词> stars:>300`，取 total_count > 0 的），
 *  因为 searchRepos 只发 `topic:` 查询——不是 topic 的通用技术词必然 0 命中，写进来等于白跑一轮。
 *  **这是 generateIndustryQueries 的 mock 分支专属数据**——绝不借道 ctx.llm 拿通用返回
 *  （mock LLM 返回的是文案 fixture，拿来当搜索词是灾难）。 */
export const INDUSTRY_MOCK_KEYWORDS: Record<string, string[]> = {
  资讯媒体: [
    'rss-reader', 'news-aggregator', 'cms', 'headless-cms', 'content-management',
    'publishing', 'newsletter', 'feed-parser', 'web-scraper', 'markdown-editor',
    'static-site-generator', 'social-media-scheduler', 'media-library', 'digital-asset-management',
  ],
  情感社交: [
    'social-network', 'forum', 'social', 'chat-app', 'instant-messaging',
    'matchmaking', 'dating-app', 'user-profile', 'group-chat', 'moderation',
    'private-messaging', 'activity-feed', 'live-stream', 'video-chat',
  ],
  教育培训: [
    'lms', 'learning-management-system', 'course', 'online-course', 'quiz',
    'exam-system', 'student-management', 'e-learning', 'classroom', 'attendance',
    'grading', 'tutoring', 'flashcards', 'assignment', 'enrollment',
  ],
  外贸跨境: [
    'erp', 'quotation', 'invoice', 'shipping', 'logistics',
    'inventory-management', 'multi-currency', 'order-management', 'purchase-order', 'supply-chain',
    'warehouse', 'b2b-ecommerce', 'payment-gateway', 'shipment-tracking', 'i18n',
  ],
  本地生活服务: [
    'booking', 'appointment-scheduling', 'appointment', 'reservation', 'point-of-sale',
    'membership', 'loyalty', 'coupon', 'reviews', 'store-management',
    'queue-management', 'qrcode', 'check-in', 'voucher',
  ],
  健康养生: [
    'healthcare', 'health', 'medical', 'ehr', 'emr',
    'hospital', 'appointment-booking', 'fitness', 'fitness-tracker', 'nutrition',
    'nutrition-tracker', 'wellness', 'medical-records', 'telemedicine',
  ],
  汽车房产: [
    'real-estate', 'real-estate-website', 'property', 'property-management', 'automotive',
    'car', 'car-rental', 'vehicle', 'rental', 'listing',
    'contracts', 'mortgage', 'inspection',
  ],
  餐饮零售: [
    'restaurant', 'restaurant-management', 'menu', 'food', 'food-delivery',
    'kitchen', 'order-management', 'table-booking', 'retail', 'inventory',
    'pos', 'scheduling', 'loyalty', 'barcode',
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
      `请给出 12-20 个用于 GitHub 搜索的 topic（我只会发 \`topic:<词>\` 查询，不是全文搜索），要求：`,
      `- 必须是 GitHub 的 topic 名（github.com/topics/<词> 能打开、底下有项目），不要生造、不要给通用技术词`,
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

// 模板/脚手架排除词：**两张表**，作用范围不同。
// 只看 repo 的 name 段与 description，owner 段不参与——owner 里带 example/demo/learning 的正经组织不少
// （典型误伤：`copyleftlabs/copyleft-tool`、`nodejs-learning/*`），拿 owner 判模板纯属株连。
//
// name 段用全表：仓库名自己写了 demo/example/tutorial/theme，基本就是那么回事。
const TEMPLATE_NAME_RE = /template|boilerplate|starter|theme|scaffold|admin-ui|component-library|awesome-|example|demo|tutorial|learning/i
// description 只用"强脚手架词"：审查实测 learning|theme|example|demo|tutorial 作用在描述上是误伤放大器——
// moodle（描述 "the world's open source learning platform"）这种行业头号项目会被直接挡在 LLM 之前，
// 而描述里出现 example/demo/tutorial 的正经产品（"see the demo"、"tutorial included"）多到没法统计。
const TEMPLATE_DESC_RE = /template|boilerplate|starter|scaffold|awesome-/i

// 业务实体词：真业务系统才会有的名词。**只有它才算"业务实证"**——
// 脚手架也会写 prisma/api/authentication（Next.js SaaS starter 就是典例），
// 拿技术栈词当实证等于给所有漂亮空壳发通行证，硬排会形同虚设。
// 词表覆盖 spec §2.2 点名的八个 seed 行业实体（学员/课程、患者/预约、库存/工单、订单/发票…）——
// 原表只有 order|customer|invoice|role|permission|workflow，实测把 openedx（course/student）、
// openemr（patient/appointment）这类行业头部项目挡在业务含量门槛外。
// **刻意不收 payment/subscription/product**：前两个是 Stripe 那套 SaaS starter 口头禅；
// product 则是电商模板的口头禅（vercel/commerce 这类"ecommerce template"通篇 products 却没有业务系统），
// 零售/外贸行业的实体由 inventory/order/quotation 覆盖，不靠 product。
// 短词一律带词边界（见下方 DATA_STACK_RE 的 `Author`→auth 教训）。
const BUSINESS_ENTITY_RE = /\b(order|customer|invoice|role|permission|workflow|student|course|enrollment|patient|appointment|booking|reservation|inventory|ticket|member|shipment|quotation)s?\b/i
// 行业域词：不是"实体"而是"行业身份"——真实仓库的 README 常常是营销/开发说明，通篇不出现
// order/patient 这类实体名词（实测 moodle 只说 learners/educators，openemr 只说 medical practice /
// electronic health records），但它们说出口的行业词脚手架永远不会说。**刻意不收 tenant（multi-tenant
// 是 SaaS starter 口头禅）、billing/payment（Stripe 那一套人人都写）、storefront（vercel/commerce
// 这类"ecommerce template"的自称）。**
const DOMAIN_RE = /\b(medical|clinical|patient|clinic|prescription|health\s+record|ehr|emr|telemedicine|learner|educator|classroom|curriculum|syllabus|grading|attendance|payroll|restaurant|warehouse|landlord|crm|erp|lms|helpdesk|ticketing|e-?commerce)s?\b/i
// 数据层词：说明它至少有持久化模型。单独出现不足以证明是业务系统，只用于业务含量推分的第二档。
// 短词一律加词边界：无边界时 `Author` 命中 auth、`rapid`/`capital` 命中 api，实测把 SaaS starter 判成满分业务系统。
const DATA_STACK_RE = /\b(api|model|schema|database|migration|endpoint|prisma|sequelize|django|rails)s?\b|\bauth(entication|orization)?\b|\boauth\b/i

/** README 里的 URL 一律不参与词判定：GitHub Actions 徽章
 *  （`https://github.com/<owner>/<repo>/actions/workflows/ci.yml/badge.svg`）人人都有，
 *  无边界地匹配 `workflows` 等于给每个仓库白送一个业务实证词——审查实测 ant-design-pro / openemr
 *  都是靠徽章里的 workflows 过的业务含量门槛。只剥 URL，正文（含 ``` 代码块里的功能列表）全留。 */
function stripUrls(readme: string): string {
  return readme.replace(/https?:\/\/\S+/g, ' ')
}

/** 模板硬排：仓库名/描述像脚手架，且 README 里拿不出**业务实体**实证 → true
 *  （跳过，连 candidate 都不建——这条硬排跑在评分之前，是真的一条记录都不落）。纯函数。 */
export function isTemplateRepo(repo: string, description: string | null, readme: string): boolean {
  const name = repo.includes('/') ? repo.slice(repo.indexOf('/') + 1) : repo
  if (!TEMPLATE_NAME_RE.test(name) && !TEMPLATE_DESC_RE.test(description ?? '')) return false
  // 反证只要求 1 个词（不是 businessProofHits 的 2 个）：这条硬排在 live 下也跑、且**连 candidate 都不建**
  // （不像业务含量门槛还会留一条 dismissed 记录），错杀就是彻底消失——
  // 所以这里宁可放过：真正的过滤交给后面那道要 2 个词的业务含量门槛。
  return businessHitCount(readme) === 0
}

/** README 里命中的**互不相同**的业务实体/行业域词个数（URL 已剥掉）。 */
function businessHitCount(readme: string): number {
  const text = stripUrls(readme)
  const hits = new Set<string>()
  for (const re of [BUSINESS_ENTITY_RE, DOMAIN_RE]) {
    for (const m of text.matchAll(new RegExp(re.source, 'gi'))) hits.add(m[0].toLowerCase().replace(/s$/, ''))
  }
  return hits.size
}

/** README 里有业务实证 / 有数据层词——mock 业务含量推分用，顺带给出人看的理由。
 *  **业务实证要求两个互不相同的词**：实测单个词几乎全是噪音——
 *  ant-design-pro 靠 "Solid workflow to make your code healthy"、vue-element-admin 靠功能清单里的
 *  "Permission Authentication"、vercel/commerce 靠 "ecommerce template" 就能过门槛，
 *  而真业务系统（moodle=learner+educator、openemr=medical+educator、twenty=crm+workflow、
 *  openedx=lms+learner+order+permission、chatwoot=customer+order+ticket+workflow）都稳稳 ≥2。 */
export function businessProofHits(readme: string): { proof: boolean; dataModel: boolean } {
  return { proof: businessHitCount(readme) >= 2, dataModel: DATA_STACK_RE.test(stripUrls(readme)) }
}
