import fs from 'node:fs'
import path from 'node:path'
import { HOOKS, type CoreCtx, type HookType } from '@forgecast/core'
import { mockTopicPatterns, type TopicPatternDraft } from './fixtures/topic-fixture'

export interface TopicPattern {
  id: number
  hook_type: HookType
  title_patterns: string
  emotion_type: string
  topic_clusters: string
  recommended_topics: string
  sample_note_ids: string
  created_at: string
}

function validateDraft(d: any): string[] {
  const bad: string[] = []
  if (!HOOKS.includes(d.hookType)) bad.push('hookType')
  if (!Array.isArray(d.titlePatterns) || !d.titlePatterns.length) bad.push('titlePatterns')
  if (typeof d.emotionType !== 'string' || !d.emotionType.trim()) bad.push('emotionType')
  if (!Array.isArray(d.topicClusters) || !d.topicClusters.length) bad.push('topicClusters')
  if (!Array.isArray(d.recommendedTopics) || !d.recommendedTopics.length) bad.push('recommendedTopics')
  return bad
}

/** 剥 ```json 围栏 → JSON.parse（malformed 直接抛）→ 必须是数组。 */
function parsePatternsJson(raw: string): TopicPatternDraft[] {
  const cleaned = raw.trim().replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/```\s*$/, '').trim()
  const arr = JSON.parse(cleaned)
  if (!Array.isArray(arr)) throw new Error('LLM 输出不是数组')
  return arr
}

/**
 * 从 viral_notes 里按 ratio 取一批（NULL 排最后）尚未被引用过的笔记 → mock 走固定 fixture /
 * live 调 LLM 提炼 → 校验（缺字段整批抛错，不写脏数据）→ 写入 topic_patterns。
 * 无候选笔记时直接返回空数组，不调用 LLM。
 */
export async function extractPatterns(
  ctx: CoreCtx,
  opts: { topN?: number; minRatio?: number; onProgress?: (msg: string) => void } = {},
): Promise<TopicPattern[]> {
  const { topN = 30, minRatio, onProgress = () => {} } = opts

  const used = new Set<number>()
  for (const row of ctx.db.prepare('SELECT sample_note_ids FROM topic_patterns').all() as { sample_note_ids: string }[]) {
    for (const id of JSON.parse(row.sample_note_ids) as number[]) used.add(id)
  }
  onProgress('筛选候选笔记…')
  let notes = ctx.db.prepare('SELECT * FROM viral_notes ORDER BY (ratio IS NULL), ratio DESC').all() as Array<{ id: number; platform: string; title: string; play_count: number; ratio: number | null }>
  notes = notes.filter((n) => !used.has(n.id))
  if (minRatio !== undefined) notes = notes.filter((n) => n.ratio !== null && n.ratio >= minRatio)
  notes = notes.slice(0, topN)
  if (!notes.length) { onProgress('没有可用于提炼的新笔记'); return [] }

  let drafts: TopicPatternDraft[]
  if (ctx.config.llm.mode === 'mock') {
    onProgress('mock 模式：使用固定选题模式示例…')
    drafts = mockTopicPatterns()
  } else {
    onProgress(`调用大模型提炼 ${notes.length} 条笔记…`)
    const tpl = fs.readFileSync(path.join(ctx.config.paths.templates, 'prompts', 'topic-pattern-extract.md'), 'utf8')
    const system = '你是短视频/图文内容选题分析专家，只输出给定 JSON 结构，不要多余文字。'
    const notesBlock = notes.map((n, i) => `${i + 1}. [${n.platform}] ${n.title}（播放 ${n.play_count}，比值 ${n.ratio?.toFixed(2) ?? '—'}）`).join('\n')
    const prompt = [tpl, `以下是本批爆款笔记：\n${notesBlock}`].join('\n\n---\n\n')
    drafts = parsePatternsJson(await ctx.llm.complete({ model: ctx.config.llm.models.analysis, system, prompt }))
  }

  for (const d of drafts) {
    const bad = validateDraft(d)
    if (bad.length) throw new Error(`选题模式提炼结果缺字段: ${bad.join('、')}`)
  }

  onProgress('写入选题库…')
  const sampleIds = notes.map((n) => n.id)
  const insert = ctx.db.prepare(`
    INSERT INTO topic_patterns (hook_type, title_patterns, emotion_type, topic_clusters, recommended_topics, sample_note_ids)
    VALUES (?, ?, ?, ?, ?, ?)
  `)
  const results: TopicPattern[] = []
  for (const d of drafts) {
    const r = insert.run(d.hookType, JSON.stringify(d.titlePatterns), d.emotionType, JSON.stringify(d.topicClusters), JSON.stringify(d.recommendedTopics), JSON.stringify(sampleIds))
    results.push(ctx.db.prepare('SELECT * FROM topic_patterns WHERE id = ?').get(Number(r.lastInsertRowid)) as TopicPattern)
  }
  onProgress(`提炼完成：新增 ${results.length} 条选题模式`)
  return results
}

export function listPatterns(ctx: CoreCtx, hookType?: HookType): TopicPattern[] {
  if (hookType) return ctx.db.prepare('SELECT * FROM topic_patterns WHERE hook_type = ? ORDER BY created_at DESC').all(hookType) as TopicPattern[]
  return ctx.db.prepare('SELECT * FROM topic_patterns ORDER BY created_at DESC').all() as TopicPattern[]
}
