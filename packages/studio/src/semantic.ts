import type { CopyDoc } from '@forgecast/copywriter'
import type { Section, Semantic } from './videospec'
import type { Cue } from './tts'
import { cleanNarrationText } from './tts'

export interface BuildSemanticOpts {
  brandName?: string
  cues?: Cue[]
}

/**
 * 中文数字识别版数据卡正则：数字部分在阿拉伯数字之外，扩展了中文数字字符
 * （一二三四五六七八九十百千万亿两几），单位部分沿用原 hyperframes.ts 的 INSIGHT_STAT_RE。
 * 见 hyperframes.ts:648——那份只认阿拉伯数字，中文口播（"三到五天"/"几万块"）全部落空，
 * 是"中文口播渲出空数据卡片"这个缺陷的根因；这里新增一份供 semantic 层用，不动原正则
 * （buildInsightSections 仍用原正则，等价性基线不受影响）。
 */
const CN_NUM = '(?:[\\d.]+|[一二三四五六七八九十百千万亿两几]+)'
const PERCENT_MULT = '(?:%|％|万|亿|倍|折)'
const UNIT = '(?:天|周|月|年|个|人|元|次|轮|小时|分钟|工作日|块)'
export const INSIGHT_STAT_RE_CN = new RegExp(`${CN_NUM}\\s*${PERCENT_MULT}|${CN_NUM}(?:-${CN_NUM})?\\s*${UNIT}`)

/** 提取 CTA 段口播文案：优先取"台词："那句（旧格式兼容，实际几乎不命中），
 *  否则退回段落第一行——两条路径都过 cleanNarrationText 去掉括号里的拍摄指示。 */
function extractCta(doc: CopyDoc): string {
  const ctaSection = doc.douyinScript.match(/【[^】]*CTA[^】]*】([\s\S]*?)(?=【|$)/)?.[1] ?? ''
  const ctaLine = ctaSection.match(/台词[：:]\s*(.+)/)?.[1] ?? ctaSection.trim().split('\n')[0]
  return firstNonEmpty(ctaLine, doc.comments.replies[0], '想要同款？评论区扣1')
}

/** 提取报价锚点段口播文案：同 CTA 段一样常见"画面/台词"分行写法，同一套清洗规则。 */
function extractPriceAnchor(doc: CopyDoc): string {
  const anchorSection = doc.douyinScript.match(/【[^】]*报价[^】]*】([\s\S]*?)(?=【|$)/)?.[1] ?? ''
  const anchorLine = anchorSection.match(/台词[：:]\s*(.+)/)?.[1] ?? anchorSection.trim().split('\n')[0]
  return firstNonEmpty(anchorLine, '外面做要几万，我这套成本一顿火锅钱')
}

/** 按顺序清洗候选文案，取第一个清洗后非空的。 */
function firstNonEmpty(...candidates: Array<string | undefined>): string {
  for (const c of candidates) {
    const cleaned = cleanNarrationText((c ?? '').trim())
    if (cleaned) return cleaned
  }
  return ''
}

/** 从旁白 cue 里挖数据卡（insight 模板专用），中文数字/阿拉伯数字均可命中。 */
function extractInsightStats(cues: Cue[]): Array<{ value: string; label: string }> {
  const out: Array<{ value: string; label: string }> = []
  for (const c of cues) {
    const m = INSIGHT_STAT_RE_CN.exec(c.text)
    if (!m) continue
    const label = (c.text.slice(0, m.index) + c.text.slice(m.index + m[0].length)).trim().slice(0, 24)
    out.push({ value: m[0].trim(), label })
  }
  return out
}

/**
 * 语义层构建：把解析后的 CopyDoc 转成模板无关的「这条视频在讲什么」。
 * 所有 role='pain'/'body' 相关取值全部经由本函数的 firstNonEmpty + cleanNarrationText，
 * 修掉"括号拍摄指示被当文案上屏"的缺陷（影响 flash/story/demo/changelog/insight 五个模板，
 * 因为它们的 painTitle/sellingPoint/cta 原先都经由 buildFlashProps 同一套逻辑）。
 *
 * section.id 用 `<role>` 或 `<role>-<序号>`：每个 role 第一次出现用裸 role 名，
 * 同 role 第二次及以后用 `role-1`、`role-2`……全小写连字符，禁止随机/时间戳。
 */
export function buildSemantic(doc: CopyDoc, template: string, opts: BuildSemanticOpts = {}): Semantic {
  const painTitle = doc.cover.main || doc.titles[0] || ''
  const sellingPoint = doc.cover.sub || doc.titles[1] || ''
  const cta = extractCta(doc)

  const roleCounts = new Map<string, number>()
  const sections: Section[] = []
  const push = (partial: Omit<Section, 'id'>) => {
    const n = roleCounts.get(partial.role) ?? 0
    roleCounts.set(partial.role, n + 1)
    const id = n === 0 ? partial.role : `${partial.role}-${n}`
    sections.push({ id, ...partial })
  }

  push({ role: 'pain', text: painTitle })
  push({ role: 'body', text: sellingPoint })

  if (template === 'demo') {
    const painPoints = doc.xhsBody.split(/[。！？\n]+/).map((s) => s.trim()).filter(Boolean).slice(0, 3)
    push({ role: 'pain', items: painPoints.length ? painPoints : [painTitle] })
    push({ role: 'body', text: extractPriceAnchor(doc) })
  }

  if (template === 'story') {
    const qaPairs = doc.comments.questions
      .map((q, i) => ({ q, r: doc.comments.replies[i] }))
      .filter((p): p is { q: string; r: string } => !!p.r)
      .slice(0, 1)
      .flatMap((p) => [{ who: 'them' as const, text: p.q }, { who: 'me' as const, text: p.r }])
    const bubbles = [
      { who: 'them' as const, text: doc.titles[0] || '能做个这个吗？' },
      { who: 'me' as const, text: '可以，等我一天' },
      ...qaPairs,
      { who: 'them' as const, text: '太好了，等你消息' },
    ]
    // Section.items 是 string[]，对话轮次（who+text）用 JSON 编码存进去，
    // props.ts 里 JSON.parse 还原——比拿冒号切分安全（文案本身可能含冒号）。
    push({ role: 'body', items: bubbles.map((b) => JSON.stringify(b)) })
  }

  if (template === 'insight') {
    const stats = extractInsightStats(opts.cues ?? [])
    for (const stat of stats) push({ role: 'stat', stat })
  }

  push({ role: 'cta', text: cta })

  return {
    hook: (doc as { hook?: string }).hook ?? null,
    sourceAssetId: null,
    sections,
  }
}
