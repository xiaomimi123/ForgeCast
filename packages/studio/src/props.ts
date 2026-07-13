import type { CopyDoc } from '@forgecast/copywriter'

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
