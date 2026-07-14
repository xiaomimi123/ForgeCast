import fs from 'node:fs'
import path from 'node:path'
import type { CoreCtx } from '@forgecast/core'
import { mockRebrand } from './fixtures/rebrand-fixture'
import { validateRebrand } from './validate'

export interface RebrandOptions { onProgress?: (msg: string) => void }

/** 读 analysis.md(+source/tree.txt) → mock fixture / live LLM → 校验 7 段 → 写 rebrand-plan.md */
export async function rebrandPlan(ctx: CoreCtx, slug: string, opts: RebrandOptions = {}): Promise<{ path: string }> {
  const onProgress = opts.onProgress ?? (() => {})
  if (!ctx.db.prepare('SELECT id FROM projects WHERE slug = ?').get(slug)) throw new Error(`项目不存在: ${slug}`)

  const analysisPath = path.join(ctx.config.paths.workspace, slug, 'analysis.md')
  if (!fs.existsSync(analysisPath)) {
    throw new Error(`缺少 analysis.md: ${analysisPath}（先 forgecast analyze ${slug}）`)
  }
  const analysis = fs.readFileSync(analysisPath, 'utf8')
  const treePath = path.join(ctx.config.paths.workspace, slug, 'source', 'tree.txt')
  const tree = fs.existsSync(treePath) ? fs.readFileSync(treePath, 'utf8') : ''

  onProgress(`生成换皮清单（${ctx.config.llm.mode} 模式）…`)
  let md: string
  if (ctx.config.llm.mode === 'mock') {
    md = mockRebrand(slug, analysis, tree)
  } else {
    const tpl = fs.readFileSync(path.join(ctx.config.paths.templates, 'prompts', 'rebrand.md'), 'utf8')
    const system = '你是开源项目换皮改造专家，输出严格遵循给定 markdown 结构。'
    const prompt = [
      tpl,
      `【项目 slug】${slug}`,
      `【商业化分析】\n${analysis.slice(0, 6000)}`,
      `【目录树】\n${tree.slice(0, 2000)}`,
    ].join('\n\n---\n\n')
    md = await ctx.llm.complete({ model: ctx.config.llm.models.analysis, system, prompt })
  }

  onProgress('校验结构…')
  const missing = validateRebrand(md)
  if (missing.length) throw new Error(`换皮清单缺少段落: ${missing.join('、')}`)

  const relPath = path.join(slug, 'rebrand-plan.md')
  fs.writeFileSync(path.join(ctx.config.paths.workspace, slug, 'rebrand-plan.md'), md, 'utf8')
  onProgress(`换皮清单完成: ${relPath}`)
  return { path: relPath }
}
