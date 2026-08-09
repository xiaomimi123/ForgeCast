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
  const project = ctx.db.prepare('SELECT id FROM projects WHERE slug = ?').get(slug) as { id: number } | undefined
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
    const prompt = [
      tpl,
      `【项目 slug】${slug}`,
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
