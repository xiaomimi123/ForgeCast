/**
 * lower()：语义层（Semantic）下沉为图层层（Layer[]），拼成完整 VideoSpec。
 *
 * 现有 hyperframes.ts 里 build*Sections 五个函数中「算时间/分组/轨道」的逻辑全部迁到这里，
 * 拼 HTML 的部分留给 Task 4（渲染器只读 layers，不再自己算时间）。
 *
 * from 字段约定：
 * - 字面来自某个 Section 文本/items/dialogue 字段的图层：from = 该 section 的 id。
 * - 字面来自旁白 cue（不对应任何 Section，如 flash/changelog 的流动字幕、insight 数据卡）：
 *   from = 'cues'（诚实标注来源，不是真正的 section id，但绝不为 null——null 专留给
 *   kind: 'caption' 的字幕轨图层与真正手工新建的图层）。
 * - 字面来自 opts.shots（demo 轮播图，不对应任何 Section）：from = null
 *   （的确不来自 section；也没有任何测试要求非空——见 task-3-report.md 的说明）。
 */
import type { BeatGrid, Shot } from './hyperframes'
import { autoCutPlan, gridBeats, planCutTimes, snapStarts } from './hyperframes'
import type { Cue } from './tts'
import type { AudioSpec, Effect, Layer, LayerContent, Section, Semantic, VideoSpec } from './videospec'

export interface LowerPlan {
  grid: { t0: number; T: number }
  offsetSec: number
  cuts: Array<{ beat: number; shot: number }>
}

export interface LowerOpts {
  videoId: string
  slug: string
  template: string
  canvas: { width: number; height: number }
  durationSec: number
  cues: Cue[]
  beatGrid?: BeatGrid | null
  shots?: Shot[]
  plan?: LowerPlan | null
  audio: AudioSpec
  brandName?: string
}

// ---- section 查找辅助：与 props.ts 里同样的「按稳定 id 查」路径，缺失时给安全默认值，不抛错 ----
function textOf(sections: Section[], id: string): string {
  return sections.find((s) => s.id === id)?.text ?? ''
}
function itemsOf(sections: Section[], id: string, fallback: string[] = []): string[] {
  const items = sections.find((s) => s.id === id)?.items
  return items && items.length ? items : fallback
}
function dialogueOf(sections: Section[], id: string): Array<{ who: 'them' | 'me'; text: string }> {
  return sections.find((s) => s.id === id)?.dialogue ?? []
}

function beatsFor(opts: LowerOpts): number[] | undefined {
  return opts.beatGrid ? gridBeats(opts.beatGrid, opts.durationSec) : undefined
}

function textLayer(
  id: string, from: string | null, start: number, duration: number, track: number, text: string, cssClass?: string,
): Layer {
  return {
    id, kind: 'text', from, overridden: false,
    start: +start.toFixed(4), duration: +Math.max(0, duration).toFixed(4), track,
    content: { kind: 'text', text } as LayerContent,
    style: cssClass ? { cssClass } : {},
    effects: [],
  }
}

function captionLayers(cues: Cue[]): Layer[] {
  return cues.map((c, i) => {
    const dur = Math.max(0.5, c.end - c.start)
    return {
      id: `cap${i}`, kind: 'caption', from: null, overridden: false,
      start: +c.start.toFixed(4), duration: +dur.toFixed(4), track: 9,
      content: { kind: 'caption', text: c.text } as LayerContent,
      style: {},
      effects: [],
    }
  })
}

// ---- demo 轮播卡点：opts.plan 提供则 planCutTimes；否则有 beatGrid 就 autoCutPlan 兜底；都没有则空 ----
function demoCutTimes(opts: LowerOpts, shotCount: number): Array<{ start: number; shot: number }> {
  if (shotCount <= 0) return []
  if (opts.plan) return planCutTimes(opts.plan, shotCount)
  if (opts.beatGrid) {
    const grid = { t0: opts.beatGrid.t0, T: opts.beatGrid.T }
    const cuts = autoCutPlan(grid, shotCount, opts.durationSec, 4)
    return planCutTimes({ grid, offsetSec: 0, cuts }, shotCount)
  }
  return []
}

/**
 * flash：钩子/CTA 时长按片长比例 clamp（不再是写死各 4s，视频多长内容就铺多长）；
 * 中段流动字幕取 cue.start/cue.end 并钳进中段窗口，避开高亮卡片窗口（同屏叠字看不清）。
 * 迁自 buildFlashSections（hyperframes.ts:542-593），时间计算逐行保留，仅把「拼 HTML」换成「造 Layer」。
 */
function lowerFlash(sections: Section[], opts: LowerOpts): Layer[] {
  const { cues, durationSec } = opts
  const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v))
  const painTitle = textOf(sections, 'pain')
  const sellingPoint = textOf(sections, 'body')
  const cta = textOf(sections, 'cta')

  let hookDur = clamp(durationSec * 0.15, 2.5, 4)
  let ctaDur = clamp(durationSec * 0.12, 2.5, 4)
  if (hookDur + ctaDur >= durationSec) {
    const scale = Math.max(0, durationSec * 0.8) / (hookDur + ctaDur)
    hookDur *= scale
    ctaDur *= scale
  }
  const midStart = hookDur
  const midEnd = Math.max(midStart, durationSec - ctaDur)

  const layers: Layer[] = []
  layers.push(textLayer('flashHook', 'pain', 0, hookDur, 1, painTitle, 'painT'))

  // 高亮卡片先算窗口：流动字幕要避开这段（两者都满屏居中，叠一起看不清）
  const highlightStart = midStart + (midEnd - midStart) * 0.4
  const highlightDur = Math.min(2.5, Math.max(0.5, midEnd - highlightStart))
  const highlightEnd = highlightStart + highlightDur

  const midCues = cues
    .map((c) => ({ start: Math.max(c.start, midStart), end: Math.min(c.end, midEnd), text: c.text }))
    .filter((c) => c.end - c.start > 0.1)
    .filter((c) => c.end <= highlightStart || c.start >= highlightEnd)
  midCues.forEach((c, i) => {
    layers.push(textLayer(`flashCap${i}`, 'cues', c.start, c.end - c.start, 2, c.text, 'flowCap'))
  })

  layers.push(textLayer('flashHighlight', 'body', highlightStart, highlightDur, 3, sellingPoint, 'highlightCard'))
  layers.push(textLayer('flashCta', 'cta', midEnd, ctaDur, 1, cta, 'cta'))
  return layers
}

/**
 * changelog：与 flash 同构（钩子/CTA 比例 clamp + 中段按 cue 铺），只是钩子段换成
 * label+title+subtitle 三行拼一块（原版三者本就渲在同一个 clip 里，故仍是一个 Layer）。
 * 迁自 buildChangelogSections（hyperframes.ts:602-642）。
 */
function lowerChangelog(sections: Section[], opts: LowerOpts): Layer[] {
  const { cues, durationSec } = opts
  const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v))
  const title = textOf(sections, 'pain')
  const subtitle = textOf(sections, 'body')
  const cta = textOf(sections, 'cta')
  const label = '本周更新'

  let titleDur = clamp(durationSec * 0.15, 3, 5)
  let ctaDur = clamp(durationSec * 0.12, 2.5, 4)
  if (titleDur + ctaDur >= durationSec) {
    const scale = Math.max(0, durationSec * 0.8) / (titleDur + ctaDur)
    titleDur *= scale
    ctaDur *= scale
  }
  const midStart = titleDur
  const midEnd = Math.max(midStart, durationSec - ctaDur)

  const layers: Layer[] = []
  layers.push(textLayer('clTitle', 'pain', 0, titleDur, 1, [label, title, subtitle].filter(Boolean).join('\n'), 'title'))

  const midCues = cues
    .map((c) => ({ start: Math.max(c.start, midStart), end: Math.min(c.end, midEnd), text: c.text }))
    .filter((c) => c.end - c.start > 0.1)
  midCues.forEach((c, i) => {
    layers.push(textLayer(`clCap${i}`, 'cues', c.start, c.end - c.start, 2, c.text, 'tag'))
  })

  layers.push(textLayer('clCta', 'cta', midEnd, ctaDur, 1, cta, 'brand'))
  return layers
}

/**
 * story：先算三段 {start,dur} 窗口（聊天场→卖点→CTA），再过 snapStarts 顺序吸附节拍
 * （snapStarts 保证吸附后不早于前一段结束，见 hyperframes.ts:99-110，防止吸附把相邻段拉到
 * 同一拍/倒序）。聊天场内的多轮对话原版渲在同一个 clip 里（仅靠 accent 逐条淡入，没有各自的
 * data-start/data-duration），故这里仍是一个 Layer，对话内容整体拼进 content.text。
 * 迁自 buildStorySections（hyperframes.ts:501-532）。
 */
function lowerStory(sections: Section[], opts: LowerOpts): Layer[] {
  const { durationSec } = opts
  const bubbles = dialogueOf(sections, 'body-1')
  const sellingPoint = textOf(sections, 'body')
  const cta = textOf(sections, 'cta')
  const chatDur = Math.max(1, durationSec - 6)
  const beats = beatsFor(opts)
  const st = snapStarts([
    { start: 0, dur: chatDur },
    { start: durationSec - 6, dur: 3 },
    { start: durationSec - 3, dur: 3 },
  ], beats)

  const chatText = bubbles.map((b) => `${b.who === 'them' ? '对方' : '我'}：${b.text}`).join('\n')
  return [
    textLayer('storyChat', 'body-1', st[0], chatDur, 1, chatText, 'chat'),
    textLayer('storySell', 'body', st[1], 3, 1, sellingPoint, 'sell'),
    textLayer('storyCta', 'cta', st[2], 3, 1, cta, 'cta'),
  ]
}

/**
 * demo：钩子/痛点/报价/CTA 固定 3s，轮播窗口 [6, dur-6) 内的切点靠 demoCutTimes 给出
 * （opts.plan 提供则钉曲用方案 cuts；否则有节拍网格就 autoCutPlan 兜底生成；都没有则空——
 * 无轮播时钩子/痛点/报价/CTA 仍固定在原位，只是中段空档不铺图）。
 * 五段一次性 snapStarts 顺序吸附节拍，与原版一致（防止相邻段吸到同一拍/倒序）。
 * 迁自 buildDemoSections（hyperframes.ts:412-490）。
 */
function lowerDemo(sections: Section[], opts: LowerOpts): Layer[] {
  const { durationSec } = opts
  const shots = opts.shots ?? []
  const painTitle = textOf(sections, 'pain')
  const painPoints = itemsOf(sections, 'pain-1', [painTitle])
  const priceAnchor = textOf(sections, 'body-1')
  const cta = textOf(sections, 'cta')

  const carStart = 6, carEnd = Math.max(carStart + 1, durationSec - 6)
  const cutTimes = demoCutTimes(opts, shots.length)
    .filter((c) => c.start >= carStart && c.start < carEnd)
    .sort((a, b) => a.start - b.start)
  const carItems = cutTimes.map((c, k) => ({
    id: `demoCar${k}`, start: c.start, dur: (cutTimes[k + 1]?.start ?? carEnd) - c.start, shot: shots[c.shot],
  }))

  const segs = [
    { start: 0, dur: 3 },
    { start: 3, dur: 3 },
    ...carItems.map((c) => ({ start: c.start, dur: c.dur })),
    { start: durationSec - 6, dur: 3 },
    { start: durationSec - 3, dur: 3 },
  ]
  const st = snapStarts(segs, beatsFor(opts))

  const layers: Layer[] = []
  layers.push(textLayer('demo-hook', 'pain', st[0], 3, 1, painTitle, 'hookT'))
  layers.push(textLayer('demo-pain', 'pain-1', st[1], 3, 1, painPoints.join('\n'), 'painWrap'))

  carItems.forEach((c, k) => {
    layers.push({
      id: c.id, kind: 'image', from: null, overridden: false,
      start: +st[2 + k].toFixed(4), duration: +c.dur.toFixed(4), track: 2,
      content: { kind: 'image', src: c.shot ? `assets/${c.shot.rel}` : '' } as LayerContent,
      style: { cssClass: c.shot?.orientation === 'portrait' ? 'phoneWrap' : 'wideWrap' },
      effects: [],
    })
  })

  const nCar = carItems.length
  layers.push(textLayer('demo-price', 'body-1', st[2 + nCar], 3, 1, priceAnchor, 'price'))
  layers.push(textLayer('demo-cta', 'cta', st[2 + nCar + 1], 3, 1, cta, 'cta'))
  return layers
}

// insight 数据卡正则/配色：与 buildInsightSections 完全同一份，equivalence 基线仍指向 hyperframes.ts
// 的原函数不变——这里独立复制一份是为了不牵动 Task 4 之前的既有代码路径。
const INSIGHT_STAT_RE = /\d+(?:\.\d+)?\s*[%％]|\d+(?:\.\d+)?\s*(?:万|亿|倍|折)|\d+(?:\.\d+)?(?:-\d+(?:\.\d+)?)?\s*(?:天|周|月|年|个|人|元|次|轮|小时|分钟|工作日|块)/
const INSIGHT_PALETTE = ['#ffd54f', '#2dd4bf', '#34d399', '#60a5fa', '#a78bfa', '#fb7185']
const CARD_DWELL_CAP = 8
const CARD_MIN_DUR = 0.5

interface InsightCard { stat: string; label: string; start: number }

/**
 * insight：**完整迁移**分组/轨道/驻留上限/hero 逻辑，一字不改语义（迁自 buildInsightSections，
 * hyperframes.ts:658-758）——这三条都是前一轮真实踩过的坑：
 *
 * 1. 同组卡片各占独立 track（2+idx）：它们是"累加共存"语义，故意允许时间重叠，不能靠缩短
 *    时长"修复"重叠——那会悄悄删掉累加效果。
 * 2. 组内最后一张卡不设驻留上限：无后继卡时直接撑到 sceneEnd；只有"还有后继卡"时才封顶
 *    CARD_DWELL_CAP——封顶的目的是逼内容推进，不是逼空画面。
 * 3. hero（demote 效果）跟随"此刻是否独播"而非组内下标：新卡进场时若上一位仍在播（重叠）
 *    才降级上一位；若上一位早播完（接力式独播）则新卡直接是主视觉，不产生 demote 效果。
 *
 * 卡片时机直接取 cue.start（与 buildInsightSections 一致，不经过 semantic 的 stat section——
 * 后者用的是 CN 数字正则、服务于文案抽取，这里仍用原版阿拉伯数字正则服务于时间轴，两者用途不同，
 * 见 semantic.ts 顶部注释）。
 */
function lowerInsight(sections: Section[], opts: LowerOpts): Layer[] {
  const { cues, durationSec } = opts
  const painTitle = textOf(sections, 'pain')
  const cta = textOf(sections, 'cta')

  const cards: InsightCard[] = []
  for (const c of cues) {
    const m = INSIGHT_STAT_RE.exec(c.text)
    if (!m) continue
    const label = (c.text.slice(0, m.index) + c.text.slice(m.index + m[0].length)).trim().slice(0, 24)
    cards.push({ stat: m[0].trim(), label, start: c.start })
  }

  // 分组：每组最多 3 张；同组内相邻卡片间隔超 12s 强制开新组
  const groups: InsightCard[][] = []
  for (const card of cards) {
    const cur = groups.at(-1)
    if (cur && cur.length < 3 && card.start - cur.at(-1)!.start <= 12) cur.push(card)
    else groups.push([card])
  }

  const fallbackIntroEnd = Math.max(3, Math.min(4, durationSec - 3))
  const outroStart = Math.max(cards[0]?.start ?? fallbackIntroEnd, durationSec - 3)
  const introEnd = cards.length === 0 ? outroStart : (cards[0]?.start ?? fallbackIntroEnd)

  const layers: Layer[] = []
  layers.push(textLayer('insight-intro', 'pain', 0, introEnd, 1, painTitle, 'painT'))

  groups.forEach((group, gi) => {
    const sceneEnd = Math.min(outroStart, groups[gi + 1]?.[0]?.start ?? outroStart)
    const primaryColor = INSIGHT_PALETTE[gi % INSIGHT_PALETTE.length]
    const spans = group.map((card, idx) => {
      const isLast = idx === group.length - 1
      const dur = isLast
        ? Math.max(CARD_MIN_DUR, sceneEnd - card.start)
        : Math.max(CARD_MIN_DUR, Math.min(CARD_DWELL_CAP, sceneEnd - card.start))
      return { ...card, idx, dur, end: card.start + dur }
    })

    // hero 归属看"此刻谁最新"，不看 idx：新卡进场时若上一位主视觉此刻仍活着（重叠）才降级它；
    // 若上一位早播完了（接力式独播），新卡直接是主视觉，不产生 demote。
    let heroIdx = 0
    let heroEnd = spans[0].end
    const demotions: Array<{ idx: number; at: number }> = []
    for (let idx = 1; idx < spans.length; idx++) {
      if (spans[idx].start < heroEnd) demotions.push({ idx: heroIdx, at: spans[idx].start })
      heroIdx = idx
      heroEnd = spans[idx].end
    }

    spans.forEach((card) => {
      const id = `insCard${gi}_${card.idx}`
      const effects: Effect[] = demotions
        .filter((d) => d.idx === card.idx)
        .map((d) => ({ type: 'demote', at: +(d.at - card.start).toFixed(4), duration: 0.3 }))
      layers.push({
        id, kind: 'text', from: 'cues', overridden: false,
        start: +card.start.toFixed(4), duration: +card.dur.toFixed(4), track: 2 + card.idx,
        content: { kind: 'text', text: `${card.stat} ${card.label}`.trim() } as LayerContent,
        style: { cssClass: 'card', color: primaryColor },
        effects,
      })
    })
  })

  layers.push(textLayer('insight-outro', 'cta', outroStart, Math.max(0.5, durationSec - outroStart), 1, cta, 'cta'))
  return layers
}

/** lower：语义层 → 图层层，拼成完整 VideoSpec。字幕（kind:'caption'）由 cues 生成，from:null，
 *  固定 track:9（沿用现值）；仅在 audio.captionsEnabled 时才生成——与原版 injectAudioCaptions 的
 *  captions 开关语义一致。音轨不进 layers，走 spec.audio。 */
export function lower(semantic: Semantic, opts: LowerOpts): VideoSpec {
  const sections = semantic.sections
  let layers: Layer[]
  switch (opts.template) {
    case 'flash': layers = lowerFlash(sections, opts); break
    case 'story': layers = lowerStory(sections, opts); break
    case 'demo': layers = lowerDemo(sections, opts); break
    case 'changelog': layers = lowerChangelog(sections, opts); break
    case 'insight': layers = lowerInsight(sections, opts); break
    default: layers = lowerFlash(sections, opts)
  }
  if (opts.audio.captionsEnabled) layers = layers.concat(captionLayers(opts.cues))

  return {
    version: 1,
    videoId: opts.videoId,
    slug: opts.slug,
    template: opts.template,
    createdAt: new Date().toISOString(),
    semantic,
    canvas: opts.canvas,
    durationSec: opts.durationSec,
    layers,
    audio: opts.audio,
    warnings: [],
  }
}
