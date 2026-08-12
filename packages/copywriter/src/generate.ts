import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { advanceStage, type CoreCtx, type HookType } from '@forgecast/core'
import { listPatterns } from '@forgecast/topics'
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

/** 把选题库提炼结果格式化成参考风格文本：标题结构示例 + 情绪类型 + 可参考的选题方向。 */
function formatPatternsMd(p: { title_patterns: string; emotion_type: string; recommended_topics: string }): string {
  const titles = (JSON.parse(p.title_patterns) as string[]).map((t) => `- ${t}`).join('\n')
  const topics = (JSON.parse(p.recommended_topics) as string[]).map((t) => `- ${t}`).join('\n')
  return `参考同赛道爆款提炼的标题结构：\n${titles}\n\n情绪类型：${p.emotion_type}\n\n可参考的选题方向：\n${topics}`
}

export async function generateCopy(ctx: CoreCtx, input: GenerateCopyInput): Promise<GeneratedAsset[]> {
  const { slug, hook, n = 1, feedback, renderCovers = true, onProgress = () => {} } = input
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
  const terms = [...HOOK_KEYWORDS[hook], ...(project.target_buyer ? [project.target_buyer] : [])]
  const atoms = searchAtoms(ctx.db, terms)
  // 已 knowledge sync（有原子）→ 检索驱动、跳过整包 dump（大语料可扩展）；未 sync → 回落整包 md（P1 行为）
  const knowledgeDir = path.join(tplDir, 'knowledge')
  const knowledgeMd = atoms.length === 0 && fs.existsSync(knowledgeDir)
    ? fs.readdirSync(knowledgeDir).filter((f) => f.endsWith('.md'))
        .map((f) => readIfExists(path.join(knowledgeDir, f))).join('\n\n')
    : ''
  // 选题库风格参考：查当前 hook 类型最新一条提炼结果，格式化成参考文本；没有则跳过，不影响生成
  const patterns = listPatterns(ctx, hook)
  const patternsMd = patterns.length ? formatPatternsMd(patterns[0]) : ''
  const { system, prompt } = assemblePrompt({ hook, hookTemplate, formatSpec, patternsMd, knowledgeMd, atoms, analysis, feedback })

  const copyDir = path.join(wsDir, 'copy')
  fs.mkdirSync(copyDir, { recursive: true })
  const results: GeneratedAsset[] = []
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)

  // 封面截图源解析一次（raw 图片 → raw 视频抽帧 → demo_url 截图），供 annotate 模板；失败则 null → 回落纯文字 bigtext
  let coverShot: string | null = null
  if (renderCovers) {
    try {
      const { resolveCoverShot } = await import('./cover')
      coverShot = await resolveCoverShot({ rawDir: path.join(wsDir, 'raw'), demoUrl: project.demo_url })
    } catch { coverShot = null }
  }

  for (let i = 1; i <= n; i++) {
    onProgress(`生成第 ${i}/${n} 篇（${ctx.config.llm.mode} 模式）…`)
    const raw = await ctx.llm.complete({ model: ctx.config.llm.models.copy, system, prompt })
    const doc = parseCopyOutput(raw) // 结构校验：解析失败即任务失败，不落盘半成品；同时供下方封面复用

    onProgress(`敏感词校验第 ${i}/${n} 篇…`)
    const warnings = checkBannedWords(raw).map((w) => `含敏感词: ${w}`)

    const rand = randomBytes(4).toString('hex')
    const fileName = `${hook}-${stamp}-${i}-${rand}.md`
    const relPath = path.join(slug, 'copy', fileName)
    fs.writeFileSync(path.join(copyDir, fileName), raw, 'utf8')
    const info = ctx.db.prepare(
      'INSERT INTO assets (project_id, type, hook, file_path, warnings) VALUES (?, ?, ?, ?, ?)',
    ).run(project.id, 'copy', hook, relPath, JSON.stringify(warnings))
    results.push({ assetId: Number(info.lastInsertRowid), type: 'copy', filePath: relPath, warnings })
    onProgress(`第 ${i}/${n} 篇完成: ${relPath}${warnings.length ? `（⚠ ${warnings.join('；')}）` : ''}`)

    // —— Task 8 追加：封面渲染（失败降级为 warning，不阻断文案产出）——
    if (renderCovers) {
      onProgress(`渲染封面第 ${i}/${n} 篇…`)
      const coverName = `${hook}-${stamp}-${i}-${rand}.png`
      const coverRel = path.join(slug, 'covers', coverName)
      try {
        const { renderCover } = await import('./cover')
        await renderCover({
          templatesDir: ctx.config.paths.templates,
          template: coverShot ? 'annotate' : 'bigtext', // 有产品截图用截图+标注型，无则大字报
          main: doc.cover.main, sub: doc.cover.sub,
          shotDataUri: coverShot ?? undefined,
          outPath: path.join(ctx.config.paths.workspace, coverRel),
        })
        const cInfo = ctx.db.prepare(
          'INSERT INTO assets (project_id, type, hook, file_path, warnings) VALUES (?, ?, ?, ?, ?)',
        ).run(project.id, 'cover', hook, coverRel, '[]')
        results.push({ assetId: Number(cInfo.lastInsertRowid), type: 'cover', filePath: coverRel, warnings: [] })
        onProgress(`封面完成: ${coverRel}`)
      } catch (err) {
        onProgress(`⚠ 封面渲染失败（文案不受影响）: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }
  if (results.length) advanceStage(ctx.db, project.id, 'producing')
  return results
}
