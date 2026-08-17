import fs from 'node:fs'
import path from 'node:path'
import type { CoreCtx } from '@forgecast/core'
import { mockProductIntroScript } from './fixtures/broll-script-fixture'

export interface ProductIntroScriptResult { assetId: number; filePath: string }

/**
 * 生成"产品介绍"B-roll 视频用的解说词：读 analysis.md 当依据，mock 走固定骨架（绝不调 ctx.llm），
 * live 读 templates/prompts/broll-script.md 模板注入 analysis.md 全文调 LLM。
 * 写 workspace/<slug>/broll/script.md，登记 type='broll_script' 素材。不推进项目阶段（可选辅助产出物）。
 */
export async function generateProductIntroScript(
  ctx: CoreCtx,
  input: { slug: string; onProgress?: (msg: string) => void },
): Promise<ProductIntroScriptResult> {
  const { slug, onProgress = () => {} } = input
  const project: any = ctx.db.prepare('SELECT * FROM projects WHERE slug = ?').get(slug)
  if (!project) throw new Error(`项目不存在: ${slug}`)

  const analysisPath = path.join(ctx.config.paths.workspace, slug, 'analysis.md')
  if (!fs.existsSync(analysisPath)) {
    throw new Error(`缺少 analysis.md: ${analysisPath}（先 forgecast analyze ${slug}）`)
  }
  const analysis = fs.readFileSync(analysisPath, 'utf8')

  let md: string
  if (ctx.config.llm.mode === 'mock') {
    onProgress('mock 模式：使用固定产品介绍解说词骨架…')
    md = mockProductIntroScript(slug)
  } else {
    onProgress('生成产品介绍解说词（live 模式）…')
    const tpl = fs.readFileSync(path.join(ctx.config.paths.templates, 'prompts', 'broll-script.md'), 'utf8')
    const system = '你是产品宣传片解说词撰稿人，输出可直接用于配音的解说词正文，只输出 markdown。'
    const prompt = tpl.replace('{{analysis}}', analysis)
    md = await ctx.llm.complete({ model: ctx.config.llm.models.copy, system, prompt })
    if (md.trim().length < 100) throw new Error('产品介绍解说词输出过短，疑似生成失败')
  }

  const dir = path.join(ctx.config.paths.workspace, slug, 'broll')
  fs.mkdirSync(dir, { recursive: true })
  const relPath = path.join(slug, 'broll', 'script.md')
  fs.writeFileSync(path.join(dir, 'script.md'), md, 'utf8')
  const info = ctx.db.prepare(
    "INSERT INTO assets (project_id, type, hook, file_path, warnings) VALUES (?, 'broll_script', NULL, ?, '[]')",
  ).run(project.id, relPath)
  onProgress(`产品介绍解说词完成: ${relPath}`)
  return { assetId: Number(info.lastInsertRowid), filePath: relPath }
}
