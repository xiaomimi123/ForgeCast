import fs from 'node:fs'
import path from 'node:path'
import type { CoreCtx, HookType } from '@forgecast/core'
import { assemblePrompt } from './assemble'
import { checkBannedWords } from './banned-words'
import { HOOK_KEYWORDS, searchAtoms } from './knowledge'
import { parseCopyOutput } from './parser'

export interface GenerateCopyInput {
  slug: string
  hook: HookType
  n?: number
  feedback?: string
  renderCovers?: boolean
  onProgress?: (msg: string) => void
}

export interface GeneratedAsset {
  assetId: number
  type: 'copy' | 'cover'
  filePath: string // 相对 workspace 目录
  warnings: string[]
}

function readIfExists(p: string): string {
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : ''
}

export async function generateCopy(ctx: CoreCtx, input: GenerateCopyInput): Promise<GeneratedAsset[]> {
  const { slug, hook, n = 1, feedback, onProgress = () => {} } = input
  const project: any = ctx.db.prepare('SELECT * FROM projects WHERE slug = ?').get(slug)
  if (!project) throw new Error(`项目不存在: ${slug}`)

  const wsDir = path.join(ctx.config.paths.workspace, slug)
  const analysisPath = path.join(wsDir, 'analysis.md')
  if (!fs.existsSync(analysisPath)) throw new Error(`缺少 analysis.md: ${analysisPath}（先补分析报告）`)
  const analysis = fs.readFileSync(analysisPath, 'utf8')

  onProgress('组装提示词…')
  const tplDir = ctx.config.paths.templates
  const hookTemplate = fs.readFileSync(path.join(tplDir, 'prompts', `copy-${hook}.md`), 'utf8')
  const formatSpec = fs.readFileSync(path.join(tplDir, 'prompts', '_format.md'), 'utf8')
  const knowledgeDir = path.join(tplDir, 'knowledge')
  const knowledgeMd = fs.existsSync(knowledgeDir)
    ? fs.readdirSync(knowledgeDir).filter((f) => f.endsWith('.md'))
        .map((f) => readIfExists(path.join(knowledgeDir, f))).join('\n\n')
    : ''
  const terms = [...HOOK_KEYWORDS[hook], ...(project.target_buyer ? [project.target_buyer] : [])]
  const atoms = searchAtoms(ctx.db, terms)
  const { system, prompt } = assemblePrompt({ hook, hookTemplate, formatSpec, knowledgeMd, atoms, analysis, feedback })

  const copyDir = path.join(wsDir, 'copy')
  fs.mkdirSync(copyDir, { recursive: true })
  const results: GeneratedAsset[] = []
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)

  for (let i = 1; i <= n; i++) {
    onProgress(`生成第 ${i}/${n} 篇（${ctx.config.llm.mode} 模式）…`)
    const raw = await ctx.llm.complete({ model: ctx.config.llm.models.copy, system, prompt })
    parseCopyOutput(raw) // 结构校验：解析失败即任务失败，不落盘半成品

    onProgress(`敏感词校验第 ${i}/${n} 篇…`)
    const warnings = checkBannedWords(raw).map((w) => `含敏感词: ${w}`)

    const fileName = `${hook}-${stamp}-${i}.md`
    const relPath = path.join(slug, 'copy', fileName)
    fs.writeFileSync(path.join(copyDir, fileName), raw, 'utf8')
    const info = ctx.db.prepare(
      'INSERT INTO assets (project_id, type, hook, file_path, warnings) VALUES (?, ?, ?, ?, ?)',
    ).run(project.id, 'copy', hook, relPath, JSON.stringify(warnings))
    results.push({ assetId: Number(info.lastInsertRowid), type: 'copy', filePath: relPath, warnings })
    onProgress(`第 ${i}/${n} 篇完成: ${relPath}${warnings.length ? `（⚠ ${warnings.join('；')}）` : ''}`)
  }
  return results
}
