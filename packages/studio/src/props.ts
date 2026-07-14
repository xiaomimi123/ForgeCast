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
