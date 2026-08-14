import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { advanceStage, type CoreCtx } from '@forgecast/core'
import { mockShootScript } from './fixtures/script-fixture'
import { parseCopyOutput } from './parser'

export interface ShootScriptResult { assetId: number; filePath: string }

/**
 * 从指定/最新 copy 素材扩展生成可执行拍摄脚本（分镜表+开拍准备清单），写 workspace/<slug>/scripts/
 * 并登记 type='script' 素材（hook 继承 copy）。mock 走 fixture（口播稿逐段搬进骨架，绝不调 ctx.llm）。
 * 台词一律原样照搬口播稿——脚本是执行指导，不是二次创作（提示词红线）。
 */
export async function generateShootScript(
  ctx: CoreCtx,
  input: { slug: string; assetId?: number; onProgress?: (msg: string) => void },
): Promise<ShootScriptResult> {
  const { slug, onProgress = () => {} } = input
  const project: any = ctx.db.prepare('SELECT * FROM projects WHERE slug = ?').get(slug)
  if (!project) throw new Error(`项目不存在: ${slug}`)
  const copy: any = input.assetId
    ? ctx.db.prepare("SELECT * FROM assets WHERE id = ? AND project_id = ? AND type = 'copy'").get(input.assetId, project.id)
    : ctx.db.prepare("SELECT * FROM assets WHERE project_id = ? AND type = 'copy' ORDER BY id DESC LIMIT 1").get(project.id)
  if (!copy) throw new Error(`没有可用的文案素材（先生成文案）: ${slug}`)

  onProgress('解析文案…')
  const doc = parseCopyOutput(fs.readFileSync(path.join(ctx.config.paths.workspace, copy.file_path), 'utf8'))

  let md: string
  if (ctx.config.llm.mode === 'mock') {
    onProgress('mock 模式：使用固定拍摄脚本骨架…')
    md = mockShootScript(doc.douyinScript)
  } else {
    onProgress('生成拍摄脚本（live 模式）…')
    const tpl = fs.readFileSync(path.join(ctx.config.paths.templates, 'prompts', 'shoot-script.md'), 'utf8')
    const system = '你是短视频拍摄导演，输出可直接照着拍的拍摄脚本，只输出 markdown。'
    const prompt = [tpl, `【口播脚本】\n${doc.douyinScript}`].join('\n\n---\n\n')
    md = await ctx.llm.complete({ model: ctx.config.llm.models.copy, system, prompt })
    if (md.trim().length < 100) throw new Error('拍摄脚本输出过短，疑似生成失败')
  }

  const dir = path.join(ctx.config.paths.workspace, slug, 'scripts')
  fs.mkdirSync(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const fileName = `${copy.hook ?? 'script'}-${stamp}-${randomBytes(4).toString('hex')}.md`
  const relPath = path.join(slug, 'scripts', fileName)
  fs.writeFileSync(path.join(dir, fileName), md, 'utf8')
  const info = ctx.db.prepare(
    'INSERT INTO assets (project_id, type, hook, file_path, warnings) VALUES (?, ?, ?, ?, ?)',
  ).run(project.id, 'script', copy.hook, relPath, '[]')
  advanceStage(ctx.db, project.id, 'producing')
  onProgress(`拍摄脚本完成: ${relPath}`)
  return { assetId: Number(info.lastInsertRowid), filePath: relPath }
}
