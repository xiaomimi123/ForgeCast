import fs from 'node:fs'
import path from 'node:path'
import type { CoreCtx } from '@forgecast/core'
import { mockRetroReport, type RetroDraft } from './fixtures/retro-fixture'

export type { RetroDraft } from './fixtures/retro-fixture'

export interface RetroReport extends RetroDraft { generatedAt: string; hadPerf: boolean }

function stripFence(raw: string): string {
  return raw.trim().replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/```\s*$/, '').trim()
}

function parseRetroJson(raw: string): RetroDraft {
  const v = JSON.parse(stripFence(raw))
  const bad: string[] = []
  if (typeof v?.verdict !== 'string' || !v.verdict.trim()) bad.push('verdict')
  if (!Array.isArray(v?.keep) || !v.keep.length) bad.push('keep')
  if (!Array.isArray(v?.change) || !v.change.length) bad.push('change')
  if (typeof v?.focus !== 'string' || !v.focus.trim()) bad.push('focus')
  if (bad.length) throw new Error(`复盘输出非法（缺 ${bad.join('、')}）: ${raw.slice(0, 120)}`)
  return { verdict: v.verdict, keep: v.keep.map(String), change: v.change.map(String), focus: v.focus }
}

/**
 * 复盘：审片报告（必须已有，否则抛错）× perf（可选，缺省降级纯内容复盘并在 prompt 注明）
 * → LLM 输出 总评/保持/改进/最优先（校验失败整批抛错不写库）→ 覆盖写 assets.retro。
 * mock 走 fixture 绝不调 ctx.llm。生成的复盘会被下一次文案/拍摄脚本生成自动引用（闭环）。
 */
export async function generateRetro(
  ctx: CoreCtx, videoAssetId: number,
  opts: { onProgress?: (msg: string) => void } = {},
): Promise<RetroReport> {
  const { onProgress = () => {} } = opts
  const asset: any = ctx.db.prepare("SELECT * FROM assets WHERE id = ? AND type = 'video'").get(videoAssetId)
  if (!asset) throw new Error(`视频素材不存在: #${videoAssetId}`)
  if (!asset.review) throw new Error(`该成片还没审片，先审片再复盘: #${videoAssetId}`)
  const review = JSON.parse(asset.review)
  const perf = asset.perf ? JSON.parse(asset.perf) : null

  // 对照基准沿用审片时记的 scriptAssetId；读不到（被删等）直接跳过，不阻断
  let baseline = ''
  if (review.scriptAssetId) {
    const s: any = ctx.db.prepare("SELECT * FROM assets WHERE id = ? AND type = 'script'").get(review.scriptAssetId)
    if (s) { try { baseline = fs.readFileSync(path.join(ctx.config.paths.workspace, s.file_path), 'utf8') } catch { baseline = '' } }
  }

  onProgress('生成复盘…')
  let draft: RetroDraft
  if (ctx.config.llm.mode === 'mock') {
    draft = mockRetroReport()
  } else {
    const tpl = fs.readFileSync(path.join(ctx.config.paths.templates, 'prompts', 'video-retro.md'), 'utf8')
    const system = '你是短视频运营复盘教练，只输出给定 JSON 结构，不要多余文字。'
    const s = review.scores
    const reviewBlock = [
      `分数：钩子${s.hook}/节奏${s.pacing}/贴合${s.fidelity}/CTA${s.cta}/总分${s.overall}`,
      `审片建议：\n${(review.suggestions ?? []).map((x: string) => `- ${x}`).join('\n')}`,
      review.transcript ? `转写摘要：${String(review.transcript).slice(0, 300)}` : '',
      review.degraded ? `（${review.degraded}）` : '',
    ].filter(Boolean).join('\n')
    const perfBlock = perf
      ? `曝光 ${perf.views ?? 0}｜赞 ${perf.likes ?? 0}｜询单 ${perf.leads ?? 0}（回填于 ${perf.recordedAt ?? '未知'}）`
      : '（暂无发布数据——只基于内容审片复盘，不得假装有市场反馈）'
    const prompt = [
      tpl,
      `【审片报告】\n${reviewBlock}`,
      `【发布数据】\n${perfBlock}`,
      baseline ? `【拍摄脚本基准】\n${baseline.slice(0, 3000)}` : '',
    ].filter(Boolean).join('\n\n---\n\n')
    draft = parseRetroJson(await ctx.llm.complete({ model: ctx.config.llm.models.copy, system, prompt }))
  }

  const report: RetroReport = { ...draft, generatedAt: new Date().toISOString(), hadPerf: !!perf }
  ctx.db.prepare('UPDATE assets SET retro = ? WHERE id = ?').run(JSON.stringify(report), videoAssetId)
  onProgress('复盘完成')
  return report
}
