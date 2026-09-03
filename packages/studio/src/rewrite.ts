/**
 * 剪辑台「重写这段」。设计裁决（spec §10）：只换该段文本图层的 text，不重跑 lower()——
 * lower() 需要的 cues 不在本次 spec 范围内；且旁白是旧文案合成的，重排时间轴无意义。
 * 纯变换不落盘，落盘在端点层（packages/server/src/spec-routes.ts）。
 *
 * 支持判定（@forgecast/editing 的 Task 5 有同一份判定，两侧测试都钉住它，改动需两侧同步）：
 * section 是 text 型（有 text 字段且无 dialogue/stat/shots）且 layers 中
 * from===sectionId && content.kind==='text' 的图层恰好一层。
 */
import type { CoreCtx } from '@forgecast/core'
import type { Layer, Section, VideoSpec } from './videospec'

export class RewriteUnsupportedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RewriteUnsupportedError'
  }
}

/** 剥掉 LLM 习惯性包的 markdown 代码围栏（```…```），并 trim 首尾空白。剥完为空交给调用方判断（那边会 throw）。 */
export function stripCodeFence(text: string): string {
  return text
    .trim()
    .replace(/^```[a-z]*\n?/i, '')
    .replace(/\n?```$/, '')
    .trim()
}

/** 判定某 section 是否支持「重写这段」——不满足则给出具体理由，供端点/调用方展示。 */
export function findRewritableTarget(spec: VideoSpec, sectionId: string): { section: Section; layer: Layer } {
  const section = spec.semantic.sections.find((s) => s.id === sectionId)
  if (!section) throw new RewriteUnsupportedError(`段「${sectionId}」不存在`)
  if (section.text === undefined || section.dialogue || section.stat || section.shots) {
    throw new RewriteUnsupportedError(`段「${sectionId}」不是纯文本段，暂不支持重写`)
  }
  const textLayers = spec.layers.filter((l) => l.from === sectionId && l.content.kind === 'text')
  if (textLayers.length !== 1) {
    throw new RewriteUnsupportedError(`段「${sectionId}」对应 ${textLayers.length} 个文本图层，暂不支持重写`)
  }
  return { section, layer: textLayers[0] }
}

export async function rewriteSection(
  ctx: CoreCtx,
  spec: VideoSpec,
  sectionId: string,
  instruction?: string,
): Promise<{ spec: VideoSpec; newText: string }> {
  const { section, layer } = findRewritableTarget(spec, sectionId)
  const originalText = section.text as string

  let newText: string
  if (ctx.config.llm.mode === 'mock') {
    // 铁律：mock 绝不调 ctx.llm（那返回文案 fixture，不是重写变体）
    newText = `${originalText}（重写版）`
  } else {
    const system = '你是短视频文案编辑，请在保持原意与风格的前提下重写这段文案，只输出新文案本身，不要解释。'
    const prompt = instruction ? `${originalText}\n\n改写要求：${instruction}` : originalText
    const result = await ctx.llm.complete({ model: ctx.config.llm.models.copy, system, prompt })
    const stripped = stripCodeFence(result ?? '')
    if (!stripped) throw new Error('LLM 重写返回内容为空')
    newText = stripped
  }

  const warningText = `「${sectionId}」已重写，旁白仍为旧文案，语音与画面文案可能不一致`
  const out: VideoSpec = {
    ...spec,
    semantic: {
      ...spec.semantic,
      sections: spec.semantic.sections.map((s) => (s.id === sectionId ? { ...s, text: newText } : s)),
    },
    layers: spec.layers.map((l) =>
      l.id === layer.id ? { ...l, content: { kind: 'text', text: newText } } : l,
    ),
    warnings: [...spec.warnings.filter((w) => w !== warningText), warningText],
  }

  return { spec: out, newText }
}
