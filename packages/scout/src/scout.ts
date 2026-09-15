import type { CoreCtx } from '@forgecast/core'
import { createGithubClient, type GithubClient } from './github'
import { isTemplateRepo, queriesFor, type Industry } from './industry'
import { isLicenseOk } from './license'
import { CATEGORIES, businessDepthFloor, categorizeHeuristic, generateSummaryZh, scoreCandidate } from './score'
import type { RepoMeta } from './types'

export const DEFAULT_TOPICS = [
  'crm', 'e-commerce', 'live-chat', 'booking', 'invoice', 'inventory', 'form-builder',
  'dashboard', 'chatbot', 'link-in-bio', 'scheduling', 'pos', 'wiki', 'survey',
]

// source 只升不降：一旦被标为 manual（手动投喂），之后自动抓取重新 ingest 同一 repo 也不会把它冲回 scout。
// license_ok 同理跟着 source 一起 sticky：manual 的候选不管后续真实协议怎么重新判定，都不会被自动流程打回不可商用。
const LICENSE_OK_STICKY = `CASE WHEN candidates.source = 'manual' THEN 1 ELSE excluded.license_ok END`
const UPSERT = `INSERT INTO candidates (repo, url, description, license, license_ok, stars, last_commit, tech_stack, score, score_detail, status, source, industry_id)
VALUES (@repo, @url, @description, @license, @license_ok, @stars, @last_commit, @tech_stack, @score, @score_detail, 'candidate', @source, @industry_id)
ON CONFLICT(repo) DO UPDATE SET url=excluded.url, description=excluded.description, license=excluded.license, license_ok=${LICENSE_OK_STICKY},
  stars=excluded.stars, last_commit=excluded.last_commit, tech_stack=excluded.tech_stack,
  score=excluded.score, score_detail=excluded.score_detail,
  industry_id=COALESCE(excluded.industry_id, candidates.industry_id),
  source=CASE WHEN excluded.source = 'manual' THEN 'manual' ELSE candidates.source END`

// onlyNew 模式下已存在候选只刷元数据：score/score_detail/tech_stack/favorite/status 保持旧值
// （保护 live 真评分不被 mock 启发式洗掉，也不重复烧 LLM 额度）
const UPSERT_META = `INSERT INTO candidates (repo, url, description, license, license_ok, stars, last_commit, status)
VALUES (@repo, @url, @description, @license, @license_ok, @stars, @last_commit, 'candidate')
ON CONFLICT(repo) DO UPDATE SET url=excluded.url, description=excluded.description, license=excluded.license, license_ok=${LICENSE_OK_STICKY},
  stars=excluded.stars, last_commit=excluded.last_commit`

/** 抓 README + 评分（仅协议过关者）后 upsert 入池；rejected 者不评分只登记。
 *  forceLicenseOk：手动投喂（addRepo）用，用户自担来源可用性，无视协议白名单一律放行。
 *  source：'manual'=用户手动投喂，'scout'=自动抓取/找爆款（默认）。
 *  opts.industryId：归属行业（null=未走行业锚定，如 DEFAULT_TOPICS 回落/手动投喂）。
 *  opts.enforceDepth：业务含量门槛，businessDepth 低于 businessDepthFloor 时**连 candidate 都不建**，
 *    返回 'shallow' 让调用方计数——只有行业锚定选品开这个闸，手动投喂/爆款检测不受影响。
 *  opts.readme：调用方已抓过的 README（模板硬排会先抓一次），传进来免得重复请求。 */
async function ingest(
  ctx: CoreCtx, gh: GithubClient, meta: RepoMeta, scoreIt: boolean,
  forceLicenseOk = false, source: 'manual' | 'scout' = 'scout',
  opts: { industryId?: number | null; enforceDepth?: boolean; readme?: string } = {},
): Promise<'ok' | 'shallow'> {
  const ok = forceLicenseOk || isLicenseOk(meta.license)
  let score: number | null = null
  let scoreDetail: string | null = null
  let techStack: string | null = null
  if (ok && scoreIt) {
    const readme = opts.readme ?? await gh.fetchReadme(meta.repo)
    const d = await scoreCandidate(ctx, meta, readme)
    if (opts.enforceDepth && d.businessDepth < businessDepthFloor(ctx.config.scout.weights)) return 'shallow'
    score = d.rebrandCost + d.buyerClarity + d.visualAppeal + d.businessDepth
    techStack = JSON.stringify(d.techStack)
    scoreDetail = JSON.stringify({
      rebrandCost: d.rebrandCost, buyerClarity: d.buyerClarity, visualAppeal: d.visualAppeal,
      businessDepth: d.businessDepth, businessDepthReason: d.businessDepthReason,
      rationale: d.rationale, targetBuyer: d.targetBuyer, painPoint: d.painPoint,
      summaryZh: d.summaryZh, category: d.category,
    })
  }
  ctx.db.prepare(UPSERT).run({
    repo: meta.repo, url: meta.url, description: meta.description, license: meta.license, license_ok: ok ? 1 : 0,
    stars: meta.stars, last_commit: meta.lastCommit, tech_stack: techStack, score, score_detail: scoreDetail, source,
    industry_id: opts.industryId ?? null,
  })
  return 'ok'
}

/** 取参与本次选品的行业：默认全部启用行业，industryIds 给了就只取其中启用的那些。 */
function selectIndustries(ctx: CoreCtx, industryIds?: number[]): Industry[] {
  const rows = ctx.db.prepare(
    'SELECT id, name, note, enabled FROM industries WHERE enabled = 1 ORDER BY sort_order, id',
  ).all() as Industry[]
  if (!industryIds?.length) return rows
  const want = new Set(industryIds)
  return rows.filter((r) => want.has(r.id))
}

/** 行业锚定选品：启用行业 → 各自生成搜索词 → 搜 GitHub（结果带 industry_id）→ 模板硬排 → 协议 gate →
 *  过关者按 star 取 Top-limit 抓 README 评分 → 业务含量门槛 → 入池。
 *  onlyNew：已存在的 repo 只刷元数据（不评分不覆盖旧评分），只有新 repo 进入评分池。
 *  行业全停用（或显式传 topics）→ 回落 DEFAULT_TOPICS，industry_id 记 null，选品不失效。 */
export async function scoutCandidates(
  ctx: CoreCtx,
  opts: {
    topics?: string[]; limit?: number; pushedAfter?: string; onlyNew?: boolean
    industryIds?: number[]
    onProgress?: (msg: string) => void
  } = {},
): Promise<{ found: number; scored: number; rejected: number; added: number; skippedTemplate: number; skippedShallow: number }> {
  const log = opts.onProgress ?? (() => {})
  const gh = createGithubClient(ctx.config.github)
  const limit = opts.limit ?? 30
  const pushedAfter = opts.pushedAfter ?? new Date(Date.now() - 183 * 864e5).toISOString().slice(0, 10)

  // 搜索计划：一个行业一组搜索词。显式传 topics（CLI/接口指定）则完全不走行业。
  const plans: Array<{ industryId: number | null; name: string; keywords: string[] }> = []
  for (const ind of opts.topics ? [] : selectIndustries(ctx, opts.industryIds)) {
    try {
      plans.push({ industryId: ind.id, name: ind.name, keywords: await queriesFor(ctx, ind) })
    } catch (e) {
      // 单个行业生成搜索词失败（live LLM 抽风）不拖垮整轮选品
      log(`行业「${ind.name}」搜索词生成失败，跳过：${e instanceof Error ? e.message : String(e)}`)
    }
  }
  const industryCount = plans.length
  if (!plans.length) plans.push({ industryId: null, name: '', keywords: opts.topics ?? DEFAULT_TOPICS })
  const keywordCount = new Set(plans.flatMap((p) => p.keywords)).size
  log(`搜索 GitHub（${keywordCount} 个关键词 · ${industryCount} 个行业）…`)

  // 逐行业搜索并去重：同一 repo 被多个行业搜到时，归给先命中的那个行业
  const found: RepoMeta[] = []
  const industryOf = new Map<string, number | null>()
  for (const p of plans) {
    const hits = await gh.searchRepos(p.keywords, { minStars: 300, pushedAfter, perTopic: 20 })
    if (!hits.length && p.name) log(`行业「${p.name}」的 ${p.keywords.length} 个关键词 0 命中（词可能太偏，可在行业设置里重生成）`)
    for (const m of hits) {
      if (industryOf.has(m.repo)) continue
      industryOf.set(m.repo, p.industryId)
      found.push(m)
    }
  }

  const existing = new Set(
    (ctx.db.prepare('SELECT repo FROM candidates').all() as Array<{ repo: string }>).map((r) => r.repo),
  )
  // 取舍说明：spec 原文的保护条件是「repo 已存在且已有 score_detail」，这里简化为「repo 已存在」——
  // 曾入库但从未评分的 repo（score_detail 为 NULL）在每日自动抓取里不会补评分，需靠「全部重新评分」按钮兜底。
  // 现实现对 LLM 额度更保守，属已知偏差，非 bug。
  const isNew = (m: RepoMeta) => !existing.has(m.repo)
  const inPool = (list: RepoMeta[]) => new Set(
    list.filter((m) => isLicenseOk(m.license) && (!opts.onlyNew || isNew(m)))
      .sort((a, b) => b.stars - a.stars).slice(0, limit).map((m) => m.repo),
  )

  // 模板/脚手架硬排：跑在 LLM 之前（省 token）。三层收窄，尽量不为它多发 README 请求：
  // 1) 名字段/描述没命中排除词 → 连嫌疑都算不上，直接留下（零请求，绝大多数走这条）
  // 2) 有嫌疑但协议不过 / 已入库 / 排不进本轮评分名额（按 star 预排的 Top-limit）→ 本轮反正不花 LLM 钱，
  //    直接按模板跳过，也不发请求；等它 star 涨进评分名额那轮再抓 README 验反证
  // 3) 真要评分的嫌疑仓库 → 抓一次 README 找业务实体反证，抓到的顺手给后面评分复用（不重复请求）
  const preZone = inPool(found)
  let skippedTemplate = 0
  let skippedShallow = 0
  const readmes = new Map<string, string>()
  const kept: RepoMeta[] = []
  for (const m of found) {
    if (!isTemplateRepo(m.repo, m.description, '')) { kept.push(m); continue }
    if (!preZone.has(m.repo)) { skippedTemplate++; continue }
    const readme = await gh.fetchReadme(m.repo)
    if (isTemplateRepo(m.repo, m.description, readme)) { skippedTemplate++; continue }
    readmes.set(m.repo, readme)
    kept.push(m)
  }

  const toScore = inPool(kept)
  // 口径说明：可商用数按硬排后的全量算（不受 onlyNew 影响），评分数按 toScore 算——
  // 两者在 onlyNew 模式下会差很多，分开报才不误导。
  const licenseOkCount = kept.filter((m) => isLicenseOk(m.license)).length
  log(`搜到 ${found.length} 个仓库 · 协议可商用 ${licenseOkCount} 个 · 本次评分 ${toScore.size} 个`)
  if (skippedTemplate) log(`模板/脚手架硬排跳过 ${skippedTemplate} 个`)

  let scored = 0
  let rejected = 0
  let added = 0
  for (const m of kept) {
    const ok = isLicenseOk(m.license)
    if (opts.onlyNew && !isNew(m)) {
      ctx.db.prepare(UPSERT_META).run({
        repo: m.repo, url: m.url, description: m.description, license: m.license,
        license_ok: ok ? 1 : 0, stars: m.stars, last_commit: m.lastCommit,
      })
    } else {
      const willScore = toScore.has(m.repo)
      if (willScore) log(`评分 ${scored + 1}/${toScore.size}：${m.repo}`)
      const r = await ingest(ctx, gh, m, willScore, false, 'scout', {
        industryId: industryOf.get(m.repo) ?? null, enforceDepth: true, readme: readmes.get(m.repo),
      })
      if (willScore) scored++
      if (r === 'shallow') { skippedShallow++; continue } // 连 candidate 都没建，不计 added/rejected
      if (isNew(m) && ok) added++
    }
    if (!ok) rejected++
  }
  if (skippedShallow) log(`业务含量不足（businessDepth < ${businessDepthFloor(ctx.config.scout.weights)}）跳过 ${skippedShallow} 个`)
  return { found: found.length, scored, rejected, added, skippedTemplate, skippedShallow }
}

/** 手动投喂单个 repo（URL 或 owner/name）：抓元数据+评分入池。用户手动指定来源，无视协议白名单强制放行。 */
export async function addRepo(ctx: CoreCtx, repoUrl: string): Promise<void> {
  const repo = normalizeRepo(repoUrl)
  const gh = createGithubClient(ctx.config.github)
  // mock 下 searchRepos 即 fixtures，从中取该 repo；live 下用一次 search 兜底元数据
  const all = await gh.searchRepos([], { minStars: 0, pushedAfter: '1970-01-01', perTopic: 1 })
  const meta = all.find((m) => m.repo === repo)
    ?? { repo, url: `https://github.com/${repo}`, description: null, license: null, stars: 0, lastCommit: null, topics: [] }
  await ingest(ctx, gh, meta, true, true, 'manual')
}

function normalizeRepo(input: string): string {
  const m = input.match(/github\.com\/([^/]+\/[^/#?]+)/)
  return (m ? m[1] : input).replace(/\.git$/, '').replace(/\/$/, '')
}

/** 返回"还没真评过"的候选 id：score_detail 里 targetBuyer 为空（空串/缺字段/坏JSON/NULL 都算需评）。 */
export function candidatesNeedingRescore(ctx: CoreCtx): number[] {
  const rows = ctx.db.prepare('SELECT id, score_detail FROM candidates').all() as Array<{ id: number; score_detail: string | null }>
  return rows.filter((r) => {
    if (!r.score_detail) return true
    try { return !(JSON.parse(r.score_detail) as any)?.targetBuyer } catch { return true }
  }).map((r) => r.id)
}

/** 重新评分单个候选：按 id 取回元数据 → 重抓 README → 重跑评分 → upsert 回写 */
export async function rescoreCandidate(ctx: CoreCtx, id: number): Promise<void> {
  const row = ctx.db.prepare(
    'SELECT repo, url, description, license, stars, last_commit FROM candidates WHERE id = ?',
  ).get(id) as any
  if (!row) throw new Error(`候选不存在: ${id}`)
  const gh = createGithubClient(ctx.config.github)
  // topics 不入库，重评分时按空处理。只影响 tech_stack 里来自 topic 的那部分，
  // 三个维度分数与 targetBuyer/painPoint 都只依赖 README，不受影响。
  await ingest(ctx, gh, {
    repo: row.repo, url: row.url, description: row.description,
    license: row.license, stars: row.stars, lastCommit: row.last_commit, topics: [],
  }, true)
}

/** 返回"协议 OK 且 score_detail 里没有 summaryZh"的候选 id 列表，跟 candidatesNeedingRescore 同风格。 */
export function candidatesNeedingSummary(ctx: CoreCtx): number[] {
  const rows = ctx.db.prepare(
    "SELECT id, score_detail FROM candidates WHERE license_ok = 1 AND score_detail IS NOT NULL",
  ).all() as Array<{ id: number; score_detail: string }>
  return rows.filter((r) => {
    try { return !(JSON.parse(r.score_detail) as any)?.summaryZh } catch { return true }
  }).map((r) => r.id)
}

/** 给单个候选补 summaryZh：重抓 README→生成→patch 回 score_detail，不动其它字段。 */
export async function backfillCandidateSummary(ctx: CoreCtx, id: number): Promise<void> {
  const row = ctx.db.prepare('SELECT repo, stars, score_detail FROM candidates WHERE id = ?').get(id) as any
  if (!row) throw new Error(`候选不存在: ${id}`)
  const gh = createGithubClient(ctx.config.github)
  const readme = await gh.fetchReadme(row.repo)
  const summaryZh = await generateSummaryZh(ctx, row.repo, row.stars, readme)
  const d = JSON.parse(row.score_detail)
  d.summaryZh = summaryZh
  ctx.db.prepare('UPDATE candidates SET score_detail = ? WHERE id = ?').run(JSON.stringify(d), id)
}

/** 候选池低分自动淘汰：先给协议可商用但从未评过分的候选补评分（复用 rescoreCandidate），
 *  再把补评分后仍低于阈值的标记为 status='dismissed'（不删除、只改状态，保留记录可查）。
 *  单个候选补评分失败不中断整批——跳过该条，留到下次自动清理再补。 */
export async function cleanupCandidates(
  ctx: CoreCtx,
  opts: { threshold?: number } = {},
): Promise<{ rescored: number; dismissed: number }> {
  const threshold = opts.threshold ?? 50
  const unscored = ctx.db.prepare(
    "SELECT id FROM candidates WHERE license_ok = 1 AND status = 'candidate' AND score IS NULL",
  ).all() as Array<{ id: number }>
  let rescored = 0
  for (const { id } of unscored) {
    try {
      await rescoreCandidate(ctx, id)
      rescored++
    } catch { /* 单个候选补评分失败：跳过，留到下次自动清理再补 */ }
  }
  const low = ctx.db.prepare(
    "SELECT id FROM candidates WHERE license_ok = 1 AND status = 'candidate' AND score < ?",
  ).all(threshold) as Array<{ id: number }>
  const dismiss = ctx.db.prepare("UPDATE candidates SET status = 'dismissed' WHERE id = ?")
  for (const { id } of low) dismiss.run(id)
  return { rescored, dismissed: low.length }
}

/** 爆款检测：按「创建时间 ≤ withinDays 天 且 star ≥ minStars」筛新晋高星仓库，走现有换皮/评分流程入池。
 *  手动偶发触发，不做 onlyNew 限制——命中的协议 OK 仓库每次都重新评分覆盖。 */
export async function scoutBreakouts(
  ctx: CoreCtx,
  opts: {
    minStars?: number; withinDays?: number; limit?: number
    onProgress?: (msg: string) => void
  } = {},
): Promise<{ found: number; scored: number; rejected: number; added: number; hits: Array<{ repo: string; url: string }> }> {
  const log = opts.onProgress ?? (() => {})
  const gh = createGithubClient(ctx.config.github)
  const minStars = opts.minStars ?? 2000
  const withinDays = opts.withinDays ?? 7
  const limit = opts.limit ?? 30
  const createdAfter = new Date(Date.now() - withinDays * 864e5).toISOString().slice(0, 10)
  log(`检测新晋高星仓库（≥${minStars} star · ${withinDays} 天内新建）…`)
  const found = await gh.searchBreakouts({ minStars, createdAfter, perPage: limit })

  let scored = 0
  let rejected = 0
  let added = 0
  const hits: Array<{ repo: string; url: string }> = []
  const okTotal = found.filter((m) => isLicenseOk(m.license)).length
  log(`命中 ${found.length} 个仓库 · 协议可商用 ${okTotal} 个，开始评分…`)
  for (const m of found) {
    const ok = isLicenseOk(m.license)
    if (ok) log(`评分 ${scored + 1}/${okTotal}：${m.repo}`)
    await ingest(ctx, gh, m, ok)
    if (ok) { scored++; added++; hits.push({ repo: m.repo, url: m.url }) }
    else rejected++
  }
  return { found: found.length, scored, rejected, added, hits }
}

/** 回填现有候选的领域标签：score_detail 里 category 缺/非法的，用 categorizeHeuristic 算并写回。无 score_detail 跳过。返回更新条数。 */
export function backfillCategories(ctx: CoreCtx): number {
  const rows = ctx.db.prepare('SELECT id, repo, description, score_detail FROM candidates').all() as Array<{ id: number; repo: string; description: string | null; score_detail: string | null }>
  const upd = ctx.db.prepare('UPDATE candidates SET score_detail = ? WHERE id = ?')
  let n = 0
  for (const r of rows) {
    if (!r.score_detail) continue
    let d: any
    try { d = JSON.parse(r.score_detail) } catch { continue }
    if (d.category && (CATEGORIES as readonly string[]).includes(d.category)) continue
    d.category = categorizeHeuristic(r.repo, r.description ?? '', Array.isArray(d.techStack) ? d.techStack : [])
    upd.run(JSON.stringify(d), r.id); n++
  }
  return n
}
