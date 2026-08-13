import fs from 'node:fs'
import path from 'node:path'
import type { CoreCtx } from '@forgecast/core'
import { createGithubClient, isLicenseOk, type GithubClient } from '@forgecast/scout'
import { wheelScore } from '@forgecast/tailor'
import { mockMatchKeywords, mockMatchPlans, type MatchPlanDraft } from './fixtures/match-fixture'
import type { DemandSignal } from './signals'

export type { MatchPlanDraft } from './fixtures/match-fixture'

export type BizMode = 'shop' | 'custom' | 'both'
const BIZ_MODES: BizMode[] = ['shop', 'custom', 'both']

export interface DemandMatch {
  id: number
  signal_id: number
  repo: string
  url: string
  description: string | null
  license: string | null
  license_ok: number
  stars: number
  last_commit: string | null
  score: number
  /** JSON 串：WheelScoreDetail，自行解析 */
  score_detail: string
  biz_mode: BizMode
  biz_plan: string
  created_at: string
}

/** 剥 ```json 围栏 */
function stripFence(raw: string): string {
  return raw.trim().replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/```\s*$/, '').trim()
}

function parseKeywordsJson(raw: string): string[] {
  const v = JSON.parse(stripFence(raw))
  const arr = Array.isArray(v) ? v : v?.keywords
  if (!Array.isArray(arr) || !arr.length) throw new Error('关键词输出不是非空数组')
  return arr.map(String).map((s) => s.trim()).filter(Boolean).slice(0, 5)
}

function parsePlansJson(raw: string): MatchPlanDraft[] {
  const arr = JSON.parse(stripFence(raw))
  if (!Array.isArray(arr)) throw new Error('建议输出不是数组')
  return arr
}

/**
 * 对单条需求信号「找项目」：LLM 生成搜索关键词 → GitHub 现搜（perPage 8）→ wheelScore
 * 规则评分排序取 top5 → LLM 逐项目生成轻资产商业模式建议 → 事务写 demand_matches
 * （同信号删旧插新）+ 信号 status→matched。搜索 0 结果时不写表不改 status。
 * mock 模式两次 LLM 调用都走 fixture，绝不调 ctx.llm。`opts.gh` 可注入假 client（测试用）。
 */
export async function matchSignal(
  ctx: CoreCtx, signalId: number,
  opts: { onProgress?: (msg: string) => void; gh?: GithubClient } = {},
): Promise<{ matched: number }> {
  const { onProgress = () => {} } = opts
  const signal = ctx.db.prepare('SELECT * FROM demand_signals WHERE id = ?').get(signalId) as DemandSignal | undefined
  if (!signal) throw new Error(`信号不存在: #${signalId}`)

  onProgress('生成搜索关键词…')
  let keywords: string[]
  if (ctx.config.llm.mode === 'mock') {
    keywords = mockMatchKeywords(signal)
  } else {
    const tpl = fs.readFileSync(path.join(ctx.config.paths.templates, 'prompts', 'demand-match-keywords.md'), 'utf8')
    const system = '你是开源项目搜索专家，只输出给定 JSON 结构，不要多余文字。'
    const prompt = [tpl, `【需求信号】\n标题：${signal.title}\n说明：${signal.summary ?? ''}\n可承接方向：${signal.opportunity ?? ''}`].join('\n\n---\n\n')
    keywords = parseKeywordsJson(await ctx.llm.complete({ model: ctx.config.llm.models.analysis, system, prompt }))
  }
  onProgress(`关键词：${keywords.join(' / ')}`)

  onProgress('搜索 GitHub…')
  const gh = opts.gh ?? createGithubClient(ctx.config.github)
  const repos = await gh.searchByKeywords(keywords, { perPage: 8 })
  if (!repos.length) {
    onProgress('没搜到合适项目，换个信号或稍后再试')
    return { matched: 0 }
  }

  const scored = repos
    .map((meta) => ({ meta, ...wheelScore(meta, keywords) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)

  onProgress(`为 ${scored.length} 个项目生成商业模式建议…`)
  let plans: MatchPlanDraft[]
  if (ctx.config.llm.mode === 'mock') {
    plans = mockMatchPlans(scored.map((s) => s.meta.repo))
  } else {
    const tpl = fs.readFileSync(path.join(ctx.config.paths.templates, 'prompts', 'demand-match-plan.md'), 'utf8')
    const system = '你是轻资产商业模式顾问，只输出给定 JSON 结构，不要多余文字。'
    const repoBlock = scored.map((s) => `- ${s.meta.repo}（${s.meta.stars} star, ${s.meta.license ?? '无协议'}）：${s.meta.description ?? ''}`).join('\n')
    const prompt = [
      tpl,
      `【需求信号】\n标题：${signal.title}\n说明：${signal.summary ?? ''}\n可承接方向：${signal.opportunity ?? ''}`,
      `【候选项目】\n${repoBlock}`,
    ].join('\n\n---\n\n')
    plans = parsePlansJson(await ctx.llm.complete({ model: ctx.config.llm.models.analysis, system, prompt }))
  }

  // 校验：repo 在本批、bizMode 在枚举、bizPlan 非空——任一非法整批抛错，不写脏数据
  const repoSet = new Set(scored.map((s) => s.meta.repo))
  const planMap = new Map<string, MatchPlanDraft>()
  for (const p of plans) {
    const bad: string[] = []
    if (!repoSet.has(p.repo)) bad.push('repo')
    if (!BIZ_MODES.includes(p.bizMode)) bad.push('bizMode')
    if (typeof p.bizPlan !== 'string' || !p.bizPlan.trim()) bad.push('bizPlan')
    if (bad.length) throw new Error(`建议结果非法（${bad.join('、')}）: ${JSON.stringify(p)}`)
    planMap.set(p.repo, p)
  }

  onProgress('写入匹配结果…')
  const ins = ctx.db.prepare(`
    INSERT INTO demand_matches (signal_id, repo, url, description, license, license_ok, stars, last_commit, score, score_detail, biz_mode, biz_plan)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  let inserted = 0
  const tx = ctx.db.transaction(() => {
    ctx.db.prepare('DELETE FROM demand_matches WHERE signal_id = ?').run(signalId)
    for (const s of scored) {
      const p = planMap.get(s.meta.repo)
      if (!p) continue // LLM 少给某个 repo 的建议：跳过该条，不算整体失败
      ins.run(
        signalId, s.meta.repo, s.meta.url, s.meta.description ?? null, s.meta.license ?? null,
        isLicenseOk(s.meta.license) ? 1 : 0, s.meta.stars, s.meta.lastCommit ?? null,
        s.score, JSON.stringify(s.detail), p.bizMode, p.bizPlan,
      )
      inserted++
    }
    ctx.db.prepare("UPDATE demand_signals SET status = 'matched' WHERE id = ?").run(signalId)
  })
  tx()
  onProgress(`匹配完成：${inserted} 个项目`)
  return { matched: inserted }
}

export function listMatches(ctx: CoreCtx, signalId: number): DemandMatch[] {
  return ctx.db.prepare('SELECT * FROM demand_matches WHERE signal_id = ? ORDER BY score DESC, id').all(signalId) as DemandMatch[]
}
