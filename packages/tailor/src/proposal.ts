import fs from 'node:fs'
import path from 'node:path'
import type { CoreCtx } from '@forgecast/core'
import { getRequestDetail } from './requests'
import type { TailorRequestDetail } from './types'

const DECISION_LABEL: Record<string, string> = { wheel: '用轮子', self_build: '自研', dropped: '不做' }

/** mock：从已决策数据确定性渲染方案书骨架（占位提示 live；绝不走 ctx.llm） */
export function renderProposalMock(detail: TailorRequestDetail): string {
  const { request, capabilities } = detail
  const shown = capabilities.filter((c) => c.decision !== 'dropped')
  const rows = shown.map((c) => {
    const wheel = c.decision === 'wheel' ? c.wheels.find((w) => w.repo === c.chosen_repo) : undefined
    return `| ${c.name} | ${DECISION_LABEL[c.decision] ?? c.decision} | ${wheel ? `[${wheel.repo}](${wheel.url})` : '—'} | ${wheel?.license ?? '—'} | ${wheel?.stars ?? '—'} |`
  })
  const gplRisk = shown.some((c) => c.decision === 'wheel' && c.wheels.find((w) => w.repo === c.chosen_repo)?.license_ok === 0)
  return [
    `# ${request.title} 拼装方案书`,
    `> 占位方案书——配好 live 大模型后可生成完整工作量估计 / 风险 / 报价。`,
    `## 需求概述`, request.raw_need,
    `## 选型总表`, ['| 能力 | 决策 | 轮子 | 协议 | stars |', '|---|---|---|---|---|', ...rows].join('\n'),
    `## 胶水层工作量`, '待 live 大模型生成',
    `## 风险`, gplRisk ? '⚠ 选型含协议非白名单轮子（GPL 系等）：仅限客户内部部署场景，交付前需与客户确认分发边界' : '待 live 大模型生成',
    `## 报价参考`, '待 live 大模型生成',
  ].join('\n\n')
}

/** 生成方案书：决策未完成(有 pending)抛错；写 workspace/tailor/<id>/proposal.md；status → proposed。live 内容过短重试一次。 */
export async function generateProposal(ctx: CoreCtx, requestId: number, opts: { onProgress?: (m: string) => void } = {}): Promise<{ path: string }> {
  const log = opts.onProgress ?? (() => {})
  const detail = getRequestDetail(ctx, requestId) // 不存在则抛
  if (!detail.capabilities.length) throw new Error('没有能力清单，先拆解需求')
  const pending = detail.capabilities.filter((c) => c.decision === 'pending')
  if (pending.length) throw new Error(`还有 ${pending.length} 项能力未决策（选轮子/自研/不做），决策完才能出方案书`)

  let md: string
  if (ctx.config.llm.mode === 'mock') {
    log('mock 模式：生成占位方案书')
    md = renderProposalMock(detail)
  } else {
    const tpl = fs.readFileSync(path.join(ctx.config.paths.templates, 'prompts', 'tailor-proposal.md'), 'utf8')
    const system = '你是软件外包项目的技术负责人，输出 Markdown 方案书，不要输出方案书以外的内容。'
    const capsJson = JSON.stringify(detail.capabilities.map((c) => ({
      name: c.name, detail: c.detail, decision: c.decision,
      wheel: c.decision === 'wheel' ? (c.wheels.find((w) => w.repo === c.chosen_repo) ?? null) : null,
    })), null, 2)
    const prompt = `${tpl}\n\n---\n\n客户需求：\n${detail.request.raw_need}\n\n能力清单与选型（JSON）：\n${capsJson}`
    let out: string | null = null
    let lastErr: unknown = new Error('方案书生成内容过短')
    for (let attempt = 0; attempt <= 1 && !out; attempt++) {
      try {
        const t = await ctx.llm.complete({ model: ctx.config.llm.models.analysis, system, prompt })
        if (t.trim().length >= 200) out = t
        else if (attempt === 0) log('方案书内容过短，重试一次…')
      } catch (err) {
        lastErr = err
        if (attempt === 0) log('方案书生成失败，重试一次…')
      }
    }
    if (!out) throw lastErr
    md = out
  }

  const rel = path.join('tailor', String(requestId), 'proposal.md')
  const abs = path.join(ctx.config.paths.workspace, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, md)
  ctx.db.prepare("UPDATE tailor_requests SET status = 'proposed', proposal_path = ? WHERE id = ?").run(rel, requestId)
  log(`方案书完成: workspace/${rel}`)
  return { path: rel }
}
