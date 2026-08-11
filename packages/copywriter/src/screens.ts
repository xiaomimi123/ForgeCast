import fs from 'node:fs'
import path from 'node:path'
import { parseAnalysisSummary } from '@forgecast/analyst'
import type { CoreCtx } from '@forgecast/core'
import { mockScreenHtml, type ScreenType } from './fixtures/screens-fixture'

interface ScreenDef { type: ScreenType; file: string; label: string }

const SCREEN_DEFS: ScreenDef[] = [
  { type: 'dashboard', file: 'ai-01-dashboard.png', label: '数据概览仪表盘' },
  { type: 'list', file: 'ai-02-list.png', label: '核心业务列表页' },
  { type: 'detail', file: 'ai-03-detail.png', label: '详情/设置页' },
]

/** LLM 输出是否是一份看起来合法的完整 HTML：非空、含 <html>...</html>（大小写不敏感） */
export function validateScreenHtml(html: string): boolean {
  if (!html || html.trim().length < 20) return false
  const lower = html.toLowerCase()
  return lower.includes('<html') && lower.includes('</html>')
}

export interface ScreenContext { brandName: string; targetUser: string; painPoint: string; keptFeatures: string }

/**
 * 组装喂给 LLM 的项目上下文：三级回退——analysis.md → 候选期 intro_detail → 通用兜底。
 * 与 ProjectDetailPage.tsx「未分析时展示继承的产品说明书」是同一套回退逻辑，这里是后端版本。
 */
export function buildScreenContext(ctx: CoreCtx, slug: string): ScreenContext {
  const row: any = ctx.db.prepare(`
    SELECT p.brand_name, c.intro_detail
    FROM projects p LEFT JOIN candidates c ON c.id = p.candidate_id
    WHERE p.slug = ?
  `).get(slug)
  const brandName = row?.brand_name || slug

  const analysisPath = path.join(ctx.config.paths.workspace, slug, 'analysis.md')
  const analysisMd = fs.existsSync(analysisPath) ? fs.readFileSync(analysisPath, 'utf8') : ''
  const summary = parseAnalysisSummary(analysisMd)
  let targetUser = summary.targetBuyer
  let painPoint = summary.painPoint

  if (!targetUser && !painPoint && row?.intro_detail) {
    try {
      const intro = JSON.parse(row.intro_detail)
      targetUser = intro.targetUser ?? ''
      painPoint = intro.painPoint ?? ''
    } catch { /* 坏 JSON 按无数据处理 */ }
  }
  if (!targetUser) targetUser = '中小团队的日常业务管理者'
  if (!painPoint) painPoint = '现在靠人工/表格管理，效率低、容易出错'

  const rebrandPath = path.join(ctx.config.paths.workspace, slug, 'rebrand-plan.md')
  let keptFeatures = ''
  if (fs.existsSync(rebrandPath)) {
    const md = fs.readFileSync(rebrandPath, 'utf8')
    keptFeatures = (md.match(/留[：:]\s*(.+)/)?.[1] ?? '').trim()
  }

  return { brandName, targetUser, painPoint, keptFeatures }
}

function buildPrompt(def: ScreenDef, sctx: ScreenContext): { system: string; prompt: string } {
  const system = '你是资深 SaaS 后台产品的前端工程师，只输出一份完整、自包含的 HTML（含内联 <style>，不引用任何外部资源/CDN/图片链接），用于生成产品演示截图。不要输出任何解释文字或 markdown 代码块围栏，只输出 HTML 本身。'
  const prompt = [
    `生成一张「${def.label}」页面的完整 HTML，风格是常见 SaaS 管理后台。`,
    `产品名：${sctx.brandName}`,
    `目标用户：${sctx.targetUser}`,
    `核心痛点：${sctx.painPoint}`,
    sctx.keptFeatures ? `保留的核心功能（体现在页面内容里）：${sctx.keptFeatures}` : '',
    '要求：1600x1000 视口下要撑满、排版整齐；用真实感的中文示例数据（不要写"示例/placeholder"字样）；只用内联 <style>，不要任何外部 <link>/<script src>/图片 URL；要有侧边导航或顶栏，体现是一个真实产品；输出必须是单份完整 <html>...</html>，不要 markdown 代码块包裹、不要额外说明文字。',
  ].filter(Boolean).join('\n')
  return { system, prompt }
}

async function renderScreen(html: string, outPath: string): Promise<void> {
  const { chromium } = await import('playwright')
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
    await page.setContent(html, { waitUntil: 'load' })
    fs.mkdirSync(path.dirname(outPath), { recursive: true })
    await page.screenshot({ path: outPath })
  } finally {
    await browser.close()
  }
}

export interface GenerateDemoScreensOptions { onProgress?: (msg: string) => void }
export interface DemoScreensResult { ok: string[]; failed: string[] }

/**
 * 生成 3 张 AI 演示截图（仪表盘/列表/详情），落进 workspace/<slug>/shots/。
 * 固定文件名、每次覆盖；单张失败 fail-soft（跳过+警告），3 张全失败才抛错。
 */
export async function generateDemoScreens(ctx: CoreCtx, slug: string, opts: GenerateDemoScreensOptions = {}): Promise<DemoScreensResult> {
  const onProgress = opts.onProgress ?? (() => {})
  if (!ctx.db.prepare('SELECT id FROM projects WHERE slug = ?').get(slug)) throw new Error(`项目不存在: ${slug}`)

  const sctx = buildScreenContext(ctx, slug)
  const shotsDir = path.join(ctx.config.paths.workspace, slug, 'shots')
  const result: DemoScreensResult = { ok: [], failed: [] }

  for (const def of SCREEN_DEFS) {
    onProgress(`生成「${def.label}」（${ctx.config.llm.mode} 模式）…`)
    try {
      let html: string
      if (ctx.config.llm.mode === 'mock') {
        html = mockScreenHtml(def.type, sctx.brandName)
      } else {
        const { system, prompt } = buildPrompt(def, sctx)
        html = await ctx.llm.complete({ model: ctx.config.llm.models.analysis, system, prompt })
      }
      if (!validateScreenHtml(html)) throw new Error('LLM 输出不是合法 HTML')
      await renderScreen(html, path.join(shotsDir, def.file))
      result.ok.push(def.file)
      onProgress(`「${def.label}」完成: ${def.file}`)
    } catch (err) {
      result.failed.push(def.file)
      onProgress(`⚠ 「${def.label}」失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  if (result.ok.length === 0) throw new Error('三张演示图全部生成失败')
  return result
}
