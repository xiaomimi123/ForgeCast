import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { advanceStage, type CoreCtx } from '@forgecast/core'
import { formatRetroMd } from './assemble'
import { mockShootScript } from './fixtures/script-fixture'
import { parseCopyOutput } from './parser'

export interface ShootScriptResult { assetId: number; filePath: string }

/** 拍摄条件：screen=仅录屏+口播（默认，用户真实制作条件）/ live=真人出镜实拍 / mixed=混合 */
export type ShootMode = 'screen' | 'live' | 'mixed'
export const SHOOT_MODES: ShootMode[] = ['screen', 'live', 'mixed']

/** 各拍摄条件注入提示词的硬约束文本：分镜与准备清单不得超出该条件允许的手段 */
export const SHOOT_MODE_CONSTRAINTS: Record<ShootMode, string> = {
  screen: '创作者仅有「录屏 + 口播配音」的制作条件：画面只能安排 电脑/手机录屏、产品界面截图、静态图、文字卡、图表动画；声音为口播配音（可后期录）。绝对不得出现真人出镜、实景场地、手持实拍、实体道具（如打印图纸/咖啡杯）；开拍前准备只列真实需要的项（录屏软件、麦克风、要录的界面清单、截图素材整理），不列摄影设备/场地/道具。',
  live: '创作者可真人出镜实拍：可安排机位、景别、实景场地、实体道具与出镜表演。',
  mixed: '创作者可真人出镜也可录屏：口播/出镜段与录屏演示段结合，注明每镜用哪种方式。',
}

/**
 * 从指定/最新 copy 素材扩展生成可执行拍摄脚本（分镜表+开拍准备清单），写 workspace/<slug>/scripts/
 * 并登记 type='script' 素材（hook 继承 copy）。mock 走 fixture（口播稿逐段搬进骨架，绝不调 ctx.llm）。
 * 台词一律原样照搬口播稿——脚本是执行指导，不是二次创作（提示词红线）。
 * mode 缺省 screen（录屏+口播）：分镜不得要求用户做不到的拍摄手段。
 */
export async function generateShootScript(
  ctx: CoreCtx,
  input: { slug: string; assetId?: number; mode?: ShootMode; onProgress?: (msg: string) => void },
): Promise<ShootScriptResult> {
  const { slug, mode = 'screen', onProgress = () => {} } = input
  if (!SHOOT_MODES.includes(mode)) throw new Error(`非法拍摄条件: ${mode}`)
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
    // 上一条复盘注入（闭环）：查本项目最新一条带 retro 的成片，拍摄层面参考；没有则跳过
    const retroRow: any = ctx.db.prepare(
      "SELECT retro FROM assets WHERE project_id = ? AND type = 'video' AND retro IS NOT NULL ORDER BY id DESC LIMIT 1",
    ).get(project.id)
    const retroMd = retroRow ? formatRetroMd(JSON.parse(retroRow.retro)) : ''
    const prompt = [
      tpl,
      `【拍摄条件（硬约束，分镜与准备清单绝不得超出）】\n${SHOOT_MODE_CONSTRAINTS[mode]}`,
      retroMd ? `【上一条复盘（拍摄层面参考，不必逐条照做）】\n${retroMd}` : '',
      `【口播脚本】\n${doc.douyinScript}`,
    ].filter(Boolean).join('\n\n---\n\n')
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
