import type { CopyDoc } from '@forgecast/copywriter'
import { buildSemantic } from './semantic'
import type { Cue } from './tts'

export interface FlashProps {
  painTitle: string
  sellingPoint: string
  cta: string
  brandName: string
}

/**
 * 从解析后的文案取 flash 三段文字（均有兜底，不抛错）。
 * 内部委托 buildSemantic 再映射回原返回结构——语义抽取逻辑（含 CTA 清洗）统一在 semantic.ts，
 * 这里只做 Section[] → FlashProps 的映射，保持既有导出签名不变以免打断既有测试。
 */
export function buildFlashProps(doc: CopyDoc, brandName = 'forgecast'): FlashProps {
  const s = buildSemantic(doc, 'flash')
  const painTitle = s.sections.find((x) => x.id === 'pain')?.text ?? ''
  const sellingPoint = s.sections.find((x) => x.id === 'body')?.text ?? ''
  const cta = s.sections.find((x) => x.id === 'cta')?.text ?? ''
  return { painTitle, sellingPoint, cta, brandName }
}

export interface StoryProps {
  bubbles: Array<{ who: 'them' | 'me'; text: string }>
  sellingPoint: string
  cta: string
  brandName: string
  audioSrc?: string
  cues?: Cue[]
}

/**
 * 从文案生成故事模板参数（气泡为模板化对话，卖点/CTA 复用 flash 抽取）。
 * 中段插入评论区运营里预埋的真实问答对（questions[i]/replies[i] 配对，缺回复的问题不插入防孤问），
 * 让长视频的中段对话不再是空转的三句通用填充——同时也是内容更贴项目实际的一种展现形式。
 */
export function buildStoryProps(doc: CopyDoc, brandName = 'forgecast'): StoryProps {
  const flash = buildFlashProps(doc, brandName)
  // 对话轮次（最多 1 组问答/2 条气泡，见 buildSemantic 里的同段注释）由 buildSemantic
  // 以 JSON 编码字符串存进 body-1 section 的 items，这里原样解码回来。
  const dialog = buildSemantic(doc, 'story').sections.find((x) => x.id === 'body-1')?.items ?? []
  const bubbles = dialog.map((x) => JSON.parse(x) as { who: 'them' | 'me'; text: string })
  return {
    bubbles,
    sellingPoint: flash.sellingPoint,
    cta: flash.cta,
    brandName,
  }
}

export interface DemoProps {
  painTitle: string
  painPoints: string[]
  demoVideoSrc?: string
  priceAnchor: string
  cta: string
  brandName: string
  audioSrc?: string
  cues?: Cue[]
}

/** 从文案生成演示模板参数（痛点从正文切句，报价从口播锚点段抽取，均兜底） */
export function buildDemoProps(doc: CopyDoc, brandName = 'forgecast'): DemoProps {
  const flash = buildFlashProps(doc, brandName)
  const s = buildSemantic(doc, 'demo')
  // 同 CTA 段一样，报价锚点段常见"画面：xxx / 台词：xxx"分行写法，取台词那句并清洗掉画面指示
  // （见 semantic.ts 的 extractPriceAnchor——回归：曾把括号里的拍摄指示当报价文案上屏）
  const painPoints = s.sections.find((x) => x.id === 'pain-1')?.items ?? [flash.painTitle]
  const priceAnchor = s.sections.find((x) => x.id === 'body-1')?.text ?? ''
  return {
    painTitle: flash.painTitle,
    painPoints,
    priceAnchor,
    cta: flash.cta,
    brandName,
  }
}

/** changelog 模板 slot：全 string（HTML 填槽）。数据来自封面文案/标题，CTA 复用 flash 抽取。 */
export function buildChangelogProps(doc: CopyDoc, brandName = 'forgecast'): Record<string, string> {
  const flash = buildFlashProps(doc, brandName)
  return {
    label: '本周更新',
    title: doc.cover.main || doc.titles[0] || '本周更新',
    subtitle: doc.cover.sub || doc.titles[1] || '',
    cta: flash.cta,
    brandName,
  }
}

/** demo 模板文本片段（HyperFrames 版）：钩子/痛点/报价/CTA，均兜底。截图段由 generate 组装。 */
export function buildDemoSlots(doc: CopyDoc, brandName = 'forgecast'): {
  hookTitle: string; painPoints: string[]; priceAnchor: string; cta: string; brandName: string
} {
  const dp = buildDemoProps(doc, brandName)
  return { hookTitle: dp.painTitle, painPoints: dp.painPoints, priceAnchor: dp.priceAnchor, cta: dp.cta, brandName }
}

/** story 模板数据（HyperFrames 版）：气泡对话 + 卖点 + CTA。复用 buildStoryProps 的气泡。 */
export function buildStorySlots(doc: CopyDoc, brandName = 'forgecast'): {
  bubbles: Array<{ who: 'them' | 'me'; text: string }>; sellingPoint: string; cta: string; brandName: string
} {
  const sp = buildStoryProps(doc, brandName)
  return { bubbles: sp.bubbles, sellingPoint: sp.sellingPoint, cta: sp.cta, brandName }
}

/** flash 模板 slot（HyperFrames 版）：纯文字三段，全 string。 */
export function buildFlashSlots(doc: CopyDoc, brandName = 'forgecast'): Record<string, string> {
  const f = buildFlashProps(doc, brandName)
  return { painTitle: f.painTitle, sellingPoint: f.sellingPoint, cta: f.cta, brandName }
}

/** insight 模板 slot：开场大字标题 + 结尾 CTA，复用 flash 的取值规则。数据卡片本身由
 *  generate.ts 从 TTS cue 文本直接挖（见 buildInsightSections），不在这里处理。 */
export function buildInsightSlots(doc: CopyDoc, brandName = 'forgecast'): { painTitle: string; cta: string; brandName: string } {
  const f = buildFlashProps(doc, brandName)
  return { painTitle: f.painTitle, cta: f.cta, brandName }
}
