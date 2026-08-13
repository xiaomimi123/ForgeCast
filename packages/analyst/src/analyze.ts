import fs from 'node:fs'
import path from 'node:path'
import { advanceStage, type CoreCtx } from '@forgecast/core'
import { mockAnalysis } from './fixtures/analysis-fixture'
import { validateAnalysis } from './validate'

export interface AnalyzeOptions { onProgress?: (msg: string) => void }

/** 读 source/README（M1 pick 落的）→ mock fixture / live LLM → 校验 7 段 → 写 analysis.md */
export async function analyzeProject(
  ctx: CoreCtx,
  slug: string,
  opts: AnalyzeOptions = {},
): Promise<{ path: string }> {
  const onProgress = opts.onProgress ?? (() => {})
  const project = ctx.db.prepare(
    'SELECT p.id, c.stars, c.license, c.tech_stack FROM projects p LEFT JOIN candidates c ON c.id = p.candidate_id WHERE p.slug = ?',
  ).get(slug) as { id: number; stars: number | null; license: string | null; tech_stack: string | null } | undefined
  if (!project) throw new Error(`项目不存在: ${slug}`)

  const srcReadme = path.join(ctx.config.paths.workspace, slug, 'source', 'README.md')
  if (!fs.existsSync(srcReadme)) {
    throw new Error(`缺少 source/README.md: ${srcReadme}（先 forgecast pick 立项，或手动补 source/）`)
  }
  const readme = fs.readFileSync(srcReadme, 'utf8')
  const treePath = path.join(ctx.config.paths.workspace, slug, 'source', 'tree.txt')
  const tree = fs.existsSync(treePath) ? fs.readFileSync(treePath, 'utf8') : ''

  onProgress(`生成商业化分析（${ctx.config.llm.mode} 模式）…`)
  let md: string
  if (ctx.config.llm.mode === 'mock') {
    md = mockAnalysis(slug, readme)
  } else {
    const tpl = fs.readFileSync(path.join(ctx.config.paths.templates, 'prompts', 'analysis.md'), 'utf8')
    const system = '你是开源项目商业化分析专家，输出严格遵循给定 markdown 结构。'
    // 真实客观事实：star 数/协议/技术栈来自 candidates 表（爬虫抓的真数据），不是 LLM 猜的——
    // 喂给分析这步当"有真材料可写"的依据，减少它在没有市场数据时瞎编价格/成本数字的冲动
    const facts = [
      project.stars != null ? `GitHub star 数：${project.stars}` : '',
      project.license ? `开源协议：${project.license}` : '',
      project.tech_stack ? `技术栈标签：${(() => { try { return (JSON.parse(project.tech_stack) as string[]).join('、') } catch { return project.tech_stack } })()}` : '',
    ].filter(Boolean).join('\n') || '（无）'
    const prompt = [
      tpl,
      `【项目 slug】${slug}`,
      `【项目客观事实（真实数据，可引用；除此以外不要编造具体数字）】\n${facts}`,
      `【源码 README】\n${readme.slice(0, 8000)}`,
      `【目录树】\n${tree.slice(0, 2000)}`,
    ].join('\n\n---\n\n')
    md = await ctx.llm.complete({ model: ctx.config.llm.models.analysis, system, prompt })
  }

  onProgress('校验结构…')
  const missing = validateAnalysis(md)
  if (missing.length) throw new Error(`分析结果缺少段落: ${missing.join('、')}`)

  const relPath = path.join(slug, 'analysis.md')
  fs.writeFileSync(path.join(ctx.config.paths.workspace, slug, 'analysis.md'), md, 'utf8')
  advanceStage(ctx.db, project.id, 'rebranding')
  onProgress(`分析完成: ${relPath}`)
  return { path: relPath }
}
