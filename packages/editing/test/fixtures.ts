import type { Layer, VideoSpec } from '@forgecast/studio'

/** 用例数据刻意抄自 packages/studio/test/rewrite.test.ts 的同名工厂——
 *  rewritable 判定要与 studio findRewritableTarget 同口径，输入相同才能保证漂移时至少一侧红。 */
// 注意 from 用 `'from' in over` 而不是 `??`：手工图层的 from 就是 null，`null ?? 'sec-hook'` 会把它吞掉。
export const textLayer = (over: Partial<Layer> = {}): Layer => ({
  id: over.id ?? 'l-hook', kind: over.kind ?? 'text', from: 'from' in over ? (over.from as string | null) : 'sec-hook', overridden: over.overridden ?? false,
  start: over.start ?? 0, duration: over.duration ?? 3, track: over.track ?? 1,
  content: over.content ?? { kind: 'text', text: '原文案' }, style: over.style ?? {}, effects: over.effects ?? [],
})

export const captionLayer = (over: Partial<Layer> = {}): Layer => ({
  id: over.id ?? 'l-caption', kind: 'caption', from: 'from' in over ? (over.from as string | null) : 'sec-hook', overridden: over.overridden ?? false,
  start: over.start ?? 0, duration: over.duration ?? 3, track: over.track ?? 2,
  content: over.content ?? { kind: 'caption', text: '字幕' }, style: over.style ?? {}, effects: over.effects ?? [],
})

export const baseSpec = (over: Partial<VideoSpec> = {}): VideoSpec => ({
  version: 1, videoId: 'deadbeef01', slug: 's1', template: 'flash', createdAt: '',
  semantic: {
    hook: null, sourceAssetId: null,
    sections: [{ id: 'sec-hook', role: 'hook', text: '原文案' }, { id: 'sec-other', role: 'body', text: '别的段' }],
  },
  canvas: { width: 1080, height: 1920 }, durationSec: 12,
  layers: [textLayer(), captionLayer(), textLayer({ id: 'l-other', from: 'sec-other', start: 5, duration: 4, track: 3, content: { kind: 'text', text: '别的图层文案' } })],
  audio: { narration: null, bgm: null, beatGrid: null, captionsEnabled: false }, warnings: [],
  ...over,
})

/** 深拷贝快照，用于「原对象未变」断言。 */
export const snapshot = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T
