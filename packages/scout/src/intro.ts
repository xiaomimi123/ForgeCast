import fs from 'node:fs'
import path from 'node:path'
import type { CoreCtx } from '@forgecast/core'
import { createGithubClient } from './github'
import type { RepoMeta } from './types'

export interface IntroDetail {
  summary: string
  features: string[]
  targetUser: string
  painPoint: string
  rebrandIdea: string
  generatedAt: string
}

/** mock：从 meta/README 确定性拼出占位介绍（离线、可测；绝不走 ctx.llm）。features 恒 3 条保证结构合法。 */
export function heuristicIntro(meta: RepoMeta, readme: string): IntroDetail {
  const name = meta.repo.split('/')[1] ?? meta.repo
  const desc = (meta.description || readme.replace(/\s+/g, ' ').trim().slice(0, 120) || name).trim()
  return {
    summary: `${name}：${desc}。（占位内容——配好 live 大模型后可生成完整产品介绍）`,
    features: ['核心功能待 live 大模型生成', '功能清单待 live 大模型生成', '更多功能待 live 大模型生成'],
    targetUser: '目标用户画像待 live 大模型生成',
    painPoint: '行业痛点待 live 大模型生成',
    rebrandIdea: '换皮改造 / 变现卖点建议待 live 大模型生成',
    generatedAt: new Date().toISOString(),
  }
}

/** 剥 ```json 围栏 → JSON.parse（malformed 直接抛）→ 字段类型兜底。generatedAt 现填。 */
export function parseIntroJson(raw: string): IntroDetail {
  const cleaned = raw.trim().replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/```\s*$/, '').trim()
  const o = JSON.parse(cleaned)
  return {
    summary: typeof o.summary === 'string' ? o.summary : '',
    features: Array.isArray(o.features) ? o.features.filter((x: unknown): x is string => typeof x === 'string') : [],
    targetUser: typeof o.targetUser === 'string' ? o.targetUser : '',
    painPoint: typeof o.painPoint === 'string' ? o.painPoint : '',
    rebrandIdea: typeof o.rebrandIdea === 'string' ? o.rebrandIdea : '',
    generatedAt: new Date().toISOString(),
  }
}

/** 返回不合格字段名（空数组=通过）：五个文本字段非空 + features 至少 3 条非空。 */
export function validateIntro(d: IntroDetail): string[] {
  const bad: string[] = []
  if (!d.summary.trim()) bad.push('summary')
  if (!d.targetUser.trim()) bad.push('targetUser')
  if (!d.painPoint.trim()) bad.push('painPoint')
  if (!d.rebrandIdea.trim()) bad.push('rebrandIdea')
  if (!Array.isArray(d.features) || d.features.filter((x) => x.trim()).length < 3) bad.push('features')
  return bad
}

/** 生成候选详情：读候选元数据 → mock 走 heuristicIntro / live 抓 README+LLM → 校验。候选不存在或校验不过则抛。 */
export async function generateCandidateIntro(ctx: CoreCtx, id: number): Promise<IntroDetail> {
  const row = ctx.db.prepare(
    'SELECT repo, url, description, license, stars, last_commit FROM candidates WHERE id = ?',
  ).get(id) as { repo: string; url: string; description: string | null; license: string | null; stars: number | null; last_commit: string | null } | undefined
  if (!row) throw new Error(`候选不存在: ${id}`)
  const meta: RepoMeta = {
    repo: row.repo, url: row.url, description: row.description,
    license: row.license, stars: row.stars ?? 0, lastCommit: row.last_commit, topics: [],
  }
  const gh = createGithubClient(ctx.config.github)
  const readme = await gh.fetchReadme(row.repo)

  let intro: IntroDetail
  if (ctx.config.llm.mode === 'mock') {
    intro = heuristicIntro(meta, readme)
  } else {
    const tpl = fs.readFileSync(path.join(ctx.config.paths.templates, 'prompts', 'candidate-intro.md'), 'utf8')
    const system = '你是开源项目产品分析专家，只输出给定 JSON 结构，不要多余文字。'
    const prompt = [
      tpl,
      `项目：${meta.repo}（stars: ${meta.stars}）`,
      `GitHub 简介：${meta.description ?? ''}`,
      `README：\n${readme.slice(0, 8000)}`,
    ].join('\n\n---\n\n')
    intro = parseIntroJson(await ctx.llm.complete({ model: ctx.config.llm.models.analysis, system, prompt }))
  }
  const bad = validateIntro(intro)
  if (bad.length) throw new Error(`详情生成结果缺字段: ${bad.join('、')}`)
  return intro
}
