import type { CopyDoc } from '@forgecast/copywriter'
import type { Cue } from './tts'

export interface FlashProps {
  painTitle: string
  sellingPoint: string
  cta: string
  brandName: string
}

/** 从解析后的文案取 flash 三段文字（均有兜底，不抛错） */
export function buildFlashProps(doc: CopyDoc, brandName = 'forgecast'): FlashProps {
  const ctaMatch = doc.douyinScript.match(/【[^】]*CTA[^】]*】\s*(.+)/)
  const cta = (ctaMatch?.[1] ?? doc.comments.replies[0] ?? '想要同款？评论区扣1').trim()
  return {
    painTitle: doc.cover.main || doc.titles[0] || '',
    sellingPoint: doc.cover.sub || doc.titles[1] || '',
    cta,
    brandName,
  }
}

export interface StoryProps {
  bubbles: Array<{ who: 'them' | 'me'; text: string }>
  sellingPoint: string
  cta: string
  brandName: string
  audioSrc?: string
  cues?: Cue[]
}

/** 从文案生成故事模板参数（气泡为模板化对话，卖点/CTA 复用 flash 抽取） */
export function buildStoryProps(doc: CopyDoc, brandName = 'forgecast'): StoryProps {
  const flash = buildFlashProps(doc, brandName)
  return {
    bubbles: [
      { who: 'them', text: doc.titles[0] || '能做个这个吗？' },
      { who: 'me', text: '可以，等我一天' },
      { who: 'them', text: '太好了，等你消息' },
    ],
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
  const painPoints = doc.xhsBody.split(/[。！？\n]+/).map((s) => s.trim()).filter(Boolean).slice(0, 3)
  const anchorMatch = doc.douyinScript.match(/【[^】]*报价[^】]*】\s*(.+)/)
  const priceAnchor = (anchorMatch?.[1] ?? '外面做要几万，我这套成本一顿火锅钱').trim()
  return {
    painTitle: flash.painTitle,
    painPoints: painPoints.length ? painPoints : [flash.painTitle],
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
