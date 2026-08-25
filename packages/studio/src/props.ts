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
  // CTA 段落内常见"画面：.../台词：..."分行写法（画面是拍摄指示不是口播文案），
  // 优先取"台词："那句；没有台词行则退回段落第一行（兼容 CTA 就一行文字的旧写法）
  const ctaSection = doc.douyinScript.match(/【[^】]*CTA[^】]*】([\s\S]*?)(?=【|$)/)?.[1] ?? ''
  const ctaLine = ctaSection.match(/台词[：:]\s*(.+)/)?.[1] ?? ctaSection.trim().split('\n')[0]
  const cta = (ctaLine || doc.comments.replies[0] || '想要同款？评论区扣1').trim()
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

/**
 * 从文案生成故事模板参数（气泡为模板化对话，卖点/CTA 复用 flash 抽取）。
 * 中段插入评论区运营里预埋的真实问答对（questions[i]/replies[i] 配对，缺回复的问题不插入防孤问），
 * 让长视频的中段对话不再是空转的三句通用填充——同时也是内容更贴项目实际的一种展现形式。
 */
export function buildStoryProps(doc: CopyDoc, brandName = 'forgecast'): StoryProps {
  const flash = buildFlashProps(doc, brandName)
  // 最多取 1 组问答（2 条气泡）：真渲验证过，横屏画布只有 1080px 高，开头2+问答对+结尾1
  // 超过 5 条气泡时顶部/底部气泡会被顶出画面裁切（竖屏画布高裕量更大，但统一按横屏这个更紧的上限来）
  const qaPairs = doc.comments.questions
    .map((q, i) => ({ q, r: doc.comments.replies[i] }))
    .filter((p): p is { q: string; r: string } => !!p.r)
    .slice(0, 1)
    .flatMap((p) => [{ who: 'them' as const, text: p.q }, { who: 'me' as const, text: p.r }])
  return {
    bubbles: [
      { who: 'them', text: doc.titles[0] || '能做个这个吗？' },
      { who: 'me', text: '可以，等我一天' },
      ...qaPairs,
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
  // 同 CTA 段一样，报价锚点段常见"画面：xxx / 台词：xxx"分行写法，取台词那句（见 buildFlashProps 同类修复）
  const anchorSection = doc.douyinScript.match(/【[^】]*报价[^】]*】([\s\S]*?)(?=【|$)/)?.[1] ?? ''
  const anchorLine = anchorSection.match(/台词[：:]\s*(.+)/)?.[1] ?? anchorSection.trim().split('\n')[0]
  const priceAnchor = (anchorLine || '外面做要几万，我这套成本一顿火锅钱').trim()
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
