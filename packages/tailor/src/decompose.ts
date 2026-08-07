import fs from 'node:fs'
import path from 'node:path'
import type { CoreCtx } from '@forgecast/core'
import type { DecomposedCapability, TailorRequest } from './types'

/** mock：按行/句确定性切分出能力项占位（离线可测；绝不走 ctx.llm——它返回的是文案 fixture） */
export function heuristicDecompose(rawNeed: string): DecomposedCapability[] {
  const lines = rawNeed.split(/[\n。；;]/).map((s) => s.trim()).filter((s) => s.length >= 4).slice(0, 8)
  const caps = lines.map((line) => ({
    name: line.slice(0, 20),
    detail: `${line}（占位拆解——配好 live 大模型后可生成完整能力说明）`,
    keywords: [line.slice(0, 12)],
  }))
  if (caps.length) return caps
  return [{ name: '核心功能', detail: `${rawNeed.slice(0, 100)}（占位拆解）`, keywords: [rawNeed.slice(0, 12) || '待补充'] }]
}

/** 剥 ```json 围栏 → JSON.parse（malformed/非数组抛）→ 字段类型兜底 */
export function parseDecomposeJson(raw: string): DecomposedCapability[] {
  const cleaned = raw.trim().replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/```\s*$/, '').trim()
  const arr = JSON.parse(cleaned)
  if (!Array.isArray(arr)) throw new Error('拆解结果不是 JSON 数组')
  return arr.map((o: any) => ({
    name: typeof o?.name === 'string' ? o.name : '',
    detail: typeof o?.detail === 'string' ? o.detail : '',
    keywords: Array.isArray(o?.keywords) ? o.keywords.filter((x: unknown): x is string => typeof x === 'string' && !!x.trim()) : [],
  }))
}

/** 返回不合格原因（空数组=通过）：至少 1 项；每项 name 非空 + keywords ≥1 */
export function validateDecompose(caps: DecomposedCapability[]): string[] {
  const bad: string[] = []
  if (!caps.length) bad.push('能力项为空')
  caps.forEach((c, i) => {
    if (!c.name.trim()) bad.push(`第${i + 1}项缺 name`)
    if (!c.keywords.length) bad.push(`第${i + 1}项缺 keywords`)
  })
  return bad
}

/** 拆解需求：覆盖写入能力清单（连带清旧轮子；是否重拆的确认由调用方 UI 负责），status → decomposed。live 解析失败重试一次。 */
export async function decomposeRequest(ctx: CoreCtx, requestId: number, opts: { onProgress?: (m: string) => void } = {}): Promise<{ count: number }> {
  const log = opts.onProgress ?? (() => {})
  const req = ctx.db.prepare('SELECT * FROM tailor_requests WHERE id = ?').get(requestId) as TailorRequest | undefined
  if (!req) throw new Error(`定制需求不存在: ${requestId}`)

  let caps: DecomposedCapability[]
  if (ctx.config.llm.mode === 'mock') {
    log('mock 模式：启发式拆解（配好 live 大模型可得完整拆解）')
    caps = heuristicDecompose(req.raw_need)
  } else {
    const tpl = fs.readFileSync(path.join(ctx.config.paths.templates, 'prompts', 'tailor-decompose.md'), 'utf8')
    const system = '你是软件项目架构师，只输出 JSON 数组，不要多余文字。'
    const prompt = `${tpl}\n\n---\n\n客户需求：\n${req.raw_need}`
    let parsed: DecomposedCapability[] | null = null
    let lastErr: unknown
    for (let attempt = 0; attempt <= 1 && !parsed; attempt++) {
      try {
        parsed = parseDecomposeJson(await ctx.llm.complete({ model: ctx.config.llm.models.analysis, system, prompt }))
      } catch (err) {
        lastErr = err
        if (attempt === 0) log('拆解 JSON 解析失败，重试一次…')
      }
    }
    if (!parsed) throw lastErr
    caps = parsed
  }

  const bad = validateDecompose(caps)
  if (bad.length) throw new Error(`拆解结果不合格: ${bad.join('、')}`)

  ctx.db.transaction(() => {
    ctx.db.prepare('DELETE FROM tailor_wheels WHERE capability_id IN (SELECT id FROM tailor_capabilities WHERE request_id = ?)').run(requestId)
    ctx.db.prepare('DELETE FROM tailor_capabilities WHERE request_id = ?').run(requestId)
    const ins = ctx.db.prepare('INSERT INTO tailor_capabilities (request_id, name, detail, keywords, sort) VALUES (?, ?, ?, ?, ?)')
    caps.forEach((c, i) => ins.run(requestId, c.name.trim(), c.detail, JSON.stringify(c.keywords), i + 1))
    ctx.db.prepare("UPDATE tailor_requests SET status = 'decomposed' WHERE id = ?").run(requestId)
  })()
  log(`拆解出 ${caps.length} 项能力`)
  return { count: caps.length }
}
