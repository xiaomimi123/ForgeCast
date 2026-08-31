/**
 * lower()：语义层（Semantic）下沉为图层层（Layer[]），拼成完整 VideoSpec。
 *
 * 现有 hyperframes.ts 里 build*Sections 五个函数中「算时间/分组/轨道」的逻辑全部迁到这里，
 * 拼 HTML 的部分留给 Task 4（渲染器只读 layers，不再自己算时间）。
 *
 * from 字段约定（schema 定义：「来源 section id」——不是「来源某种数据」）：
 * - 字面来自某个 Section 文本/items/dialogue 字段的图层：from = 该 section 的 id。
 * - 字面来自旁白 cue（不对应任何 Section，如 flash/changelog 的流动字幕、insight 数据卡）
 *   或来自 opts.shots（demo 轮播图，同样不对应任何 Section）：from = null。
 *   这两类图层确实不属于任何语义 section（cue 来自 TTS，shots 来自截图目录），塞一个
 *   看起来像 section id 实则不存在的字符串（如曾经用过的 'cues'）是悬空引用——
 *   剪辑台子项目会拿 from 去 semantic.sections 里找对应 section 决定「文案重新生成时哪些图层
 *   要被替换」，查不到的假 id 会在那里出错。null 就是诚实的答案。
 */
import type { BeatGrid, Shot } from './hyperframes'
import { gridBeats, planCutTimes, snapStarts } from './hyperframes'
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

/** from 只能指向真实存在的 section id——即便按约定应该有这个 id，若 semantic.sections 里实际
 *  没有，也必须回落 null，不能留一个查不到的悬空引用（剪辑台靠 from 反查 section 决定重生成时
 *  哪些图层要被替换，假 id 会在那里出错）。 */
function fromId(sections: Section[], id: string): string | null {
  return sections.some((s) => s.id === id) ? id : null
}
/** 多个候选 id 里取第一个真实存在的（changelog 标题块同时糅合了 pain/body 两个 section 的内容，
 *  只能记一个 from，优先记 pain）。 */
function firstFromId(sections: Section[], ids: string[]): string | null {
  for (const id of ids) if (sections.some((s) => s.id === id)) return id
  return null
}

function beatsFor(opts: LowerOpts): number[] | undefined {
  return opts.beatGrid ? gridBeats(opts.beatGrid, opts.durationSec) : undefined
}

/** 整层解码：不带 params.line 的 `decode` effect——渲染器（render-html.ts）读到它时，把
 *  content.text 按 '\n' 拆出的每一行都套 `.tw`。绝大多数 textLayer 都是单行文本，这就是
 *  「整个 div 都解码」的旧版观感；仅 changelog 的 clTitle 是例外（三行合一层、只有两行该解码），
 *  那处改用 DECODE_LINE() 显式指定行号，见 lowerChangelog。 */
const DECODE_ALL: Effect[] = [{ type: 'decode' }]
function DECODE_LINE(line: number): Effect { return { type: 'decode', params: { line } } }

function textLayer(
  id: string, from: string | null, start: number, duration: number, track: number, text: string, cssClass?: string,
  effects: Effect[] = [],
): Layer {
  return {
    id, kind: 'text', from, overridden: false,
    start: +start.toFixed(4), duration: +Math.max(0, duration).toFixed(4), track,
    content: { kind: 'text', text } as LayerContent,
    style: cssClass ? { cssClass } : {},
    effects,
  }
}

function captionLayers(cues: Cue[]): Layer[] {
  return cues.map((c, i) => {
    const dur = Math.max(0.5, c.end - c.start)
    return {
      id: `cap${i}`, kind: 'caption', from: null, overridden: false,
      start: +c.start.toFixed(4), duration: +dur.toFixed(4), track: 9,
      content: { kind: 'caption', text: c.text } as LayerContent,
      style: { cssClass: 'cap' },
      effects: [],
    }
  })
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

  // 逐字解码（.tw）+ 入场淡入迁移：buildFlashSections 里 painT/flowCap/sell/cta 四类文字全部套
  // `.tw`（hyperframes.ts:566,580,585,589），且各自紧跟一条 `tl.from(...)` 入场强调
  // （hyperframes.ts:567,581,586,590）。数值原样保留：hook/cta 是 y:20/duration:.4，
  // flowCap 是 y:16/duration:.35，highlight 是**缩放**淡入 scale:.9/duration:.35（不是位移）。
  // 每条 accent 都在各自 layer 起点触发（原版就是 clip 出现的同一刻），故 at 全部相对偏移 0。
  const layers: Layer[] = []
  layers.push(textLayer('flashHook', fromId(sections, 'pain'), 0, hookDur, 1, painTitle, 'painT',
    [...DECODE_ALL, { type: 'fadeIn', at: 0, duration: 0.4 }]))

  // 高亮卡片先算窗口：流动字幕要避开这段（两者都满屏居中，叠一起看不清）
  const highlightStart = midStart + (midEnd - midStart) * 0.4
  const highlightDur = Math.min(2.5, Math.max(0.5, midEnd - highlightStart))
  const highlightEnd = highlightStart + highlightDur

  const midCues = cues
    .map((c) => ({ start: Math.max(c.start, midStart), end: Math.min(c.end, midEnd), text: c.text }))
    .filter((c) => c.end - c.start > 0.1)
    .filter((c) => c.end <= highlightStart || c.start >= highlightEnd)
  midCues.forEach((c, i) => {
    layers.push(textLayer(`flashCap${i}`, null, c.start, c.end - c.start, 2, c.text, 'flowCap',
      [...DECODE_ALL, { type: 'fadeIn', at: 0, duration: 0.35, params: { y: 16 } }]))
  })

  layers.push(textLayer('flashHighlight', fromId(sections, 'body'), highlightStart, highlightDur, 3, sellingPoint, 'highlightCard',
    [...DECODE_ALL, { type: 'fadeIn', at: 0, duration: 0.35, params: { scale: 0.9 } }]))
  // flashCta 原版同时渲 cta（.tw）与品牌名（无 tw，hyperframes.ts:589）两行——见 lowerChangelog
  // 顶部同类注释：brandName 不能靠渲染层读 opts 去补，必须在这里就烧进 layer 文本。
  // 缺失/空则退化成只有 cta 一行（不凑一行空品牌名）。
  const flashCtaText = opts.brandName ? `${cta}\n@${opts.brandName}` : cta
  const flashCtaEffects: Effect[] = opts.brandName
    ? [DECODE_LINE(0), { type: 'fadeIn', at: 0, duration: 0.4 }]
    : [...DECODE_ALL, { type: 'fadeIn', at: 0, duration: 0.4 }]
  layers.push(textLayer('flashCta', fromId(sections, 'cta'), midEnd, ctaDur, 1, flashCtaText, 'cta', flashCtaEffects))
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

  // clTitle 是三行拼一层（label+title+subtitle），但只有 title/subtitle 该解码——原版
  // buildChangelogSections 里 label 是纯 `<span class="label">`（没有 tw），title/sub 才是
  // `.tw`（hyperframes.ts:624）。label 永远非空（写死常量），title/subtitle 则可能因内容缺失被
  // `.filter(Boolean)` 挤掉、导致拼出来的行号跟着变——所以先按「谁该解码」标记好，再一起 filter，
  // decode 的行号从 filter 之后的最终数组下标算，不能直接写死 1/2。
  const titleLines = [
    { text: label, decode: false },
    { text: title, decode: true },
    { text: subtitle, decode: true },
  ].filter((l) => l.text)
  const titleText = titleLines.map((l) => l.text).join('\n')
  // label（永远是第 0 行——它写死非空，filter 不会把它挤掉）另有一条入场强调：
  // `tl.from("#clTitle .label", { opacity: 0, y: -30, duration: .5 }, 0.1)`（hyperframes.ts:625）。
  // 原版目标是 class 选择器 `.label`，这里用 line0 的可寻址子元素 id 精确等价地打同一个元素。
  const titleEffects: Effect[] = [
    ...titleLines.map((l, i) => (l.decode ? DECODE_LINE(i) : null)).filter((e): e is Effect => e !== null),
    { type: 'fadeIn', at: 0.1, duration: 0.5, params: { line: 0, y: -30 } },
  ]

  const layers: Layer[] = []
  layers.push(textLayer('clTitle', firstFromId(sections, ['pain', 'body']), 0, titleDur, 1, titleText, 'title', titleEffects))

  const midCues = cues
    .map((c) => ({ start: Math.max(c.start, midStart), end: Math.min(c.end, midEnd), text: c.text }))
    .filter((c) => c.end - c.start > 0.1)
  midCues.forEach((c, i) => {
    layers.push(textLayer(`clCap${i}`, null, c.start, c.end - c.start, 2, c.text, 'tag',
      [...DECODE_ALL, { type: 'fadeIn', at: 0, duration: 0.35, params: { y: 16 } }]))
  })

  // clCta 原版同时渲 brand 与 cta 两行、都 `.tw`（hyperframes.ts:638）。Fix round 1 误判成
  // "VideoSpec 没有 brandName 字段、物理上凑不出第二行"——协调者指出诊断错了：`LowerOpts.brandName`
  // 早就声明了（lower.ts:38），只是这个文件从没读过它。品牌名不能靠渲染层读 opts 去补——spec 要能
  // 脱离原始 opts 单独存盘、重渲（剪辑台子项目会加载存盘的 spec 独立重渲），所以品牌名必须在这里
  // 就烧进 layer 的文本里，跟其余所有文案一样。brandName 缺失/空则退化成只有 cta 一行（不editorial
  // 出一行空 brand 文本去凑数）。
  const clCtaText = opts.brandName ? `${opts.brandName}\n${cta}` : cta
  const clCtaEffects: Effect[] = opts.brandName
    ? [DECODE_LINE(0), DECODE_LINE(1), { type: 'fadeIn', at: 0, duration: 0.4 }]
    : [...DECODE_ALL, { type: 'fadeIn', at: 0, duration: 0.4 }]
  layers.push(textLayer('clCta', fromId(sections, 'cta'), midEnd, ctaDur, 1, clCtaText, 'brand', clCtaEffects))
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

  // 气泡逐条淡入：原版 buildStorySections 给每个气泡单独一条 accent（hyperframes.ts:518-522），
  // `t = st[0] + Math.min(chatDur-1, i*step)`——Task 3 把多轮对话揉进了一个 layer（没有各自的
  // data-start），所以这份逐条时机现在只能落在 storyChat 这一个 layer 的 effects[] 里，靠
  // `params.line` 指认「渲染出来的第几行」（render-html.ts 按 '\n' 拆行、行号从 0 开始，
  // 与这里的 bubbles 下标一一对应）。offset 是相对 storyChat.start 的偏移量（Effect.at 的约定），
  // 这里直接照抄原公式，不需要再加 st[0]——effect.at 本就已经是"相对图层起点"。
  // 气泡本身不解码（原版 bubble div 没有 tw 类，跟其余四个模板的大字标题不同）。
  const step = bubbles.length > 1 ? Math.max(2.5, (chatDur - 1) / (bubbles.length - 1)) : 0
  const bubbleReveal: Effect[] = bubbles.map((_, i) => ({
    type: 'slideUp', at: +Math.min(chatDur - 1, i * step).toFixed(4), duration: 0.5, params: { line: i },
  }))

  // storySell/storyCta 各带一条入场淡入（原样保留数值：y:20/duration:.4，hyperframes.ts:523-524）。
  const entranceFadeIn: Effect = { type: 'fadeIn', at: 0, duration: 0.4 }
  // storyCta 原版同时渲 cta（.tw）与品牌名（无 tw，hyperframes.ts:527）两行——同 lowerFlash 顶部
  // 同类注释：brandName 必须在这里烧进 layer 文本，缺失/空则退化成只有 cta 一行。
  const storyCtaText = opts.brandName ? `${cta}\n@${opts.brandName}` : cta
  const storyCtaEffects: Effect[] = opts.brandName
    ? [DECODE_LINE(0), entranceFadeIn]
    : [...DECODE_ALL, entranceFadeIn]
  return [
    textLayer('storyChat', fromId(sections, 'body-1'), st[0], chatDur, 1, chatText, 'chat', bubbleReveal),
    textLayer('storySell', fromId(sections, 'body'), st[1], 3, 1, sellingPoint, 'sell', [...DECODE_ALL, entranceFadeIn]),
    textLayer('storyCta', fromId(sections, 'cta'), st[2], 3, 1, storyCtaText, 'cta', storyCtaEffects),
  ]
}

/**
 * demo：钩子/痛点/报价/CTA 固定 3s，轮播窗口 [6, dur-6) 内的切点：
 * - opts.plan 提供 → 钉曲，直接用方案 cuts（`planCutTimes`），过滤落在窗口内的、按 start 排序。
 * - 否则 → **原样迁移** buildDemoSections 的密度启发式（hyperframes.ts:433-450），
 *   不是 autoCutPlan（那是 cutplan 编辑器的候选生成器，输入/输出都不同，硬套会让 equivalence
 *   基线里 demoCarousel 那条变红——已实测踩过一次）：
 *   在窗口内的拍点 `win` 里，按 `cutCount = min(win.length, max(shots.length, ceil(win.length/4)))`
 *   均匀抽取拍点做切点；若抽出的切点数不足 2 或不足图数（不够保证每张图至少播到一次），
 *   退回按图数把窗口均分——两个触发条件都要保留，任一命中就整体换成均分结果，不是叠加修正。
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
  const beats = beatsFor(opts)
  // 图片强拍弹跳的开关（迁自 buildDemoSections 的 `hasBeats` 判定，hyperframes.ts:422）：
  // 有节拍网格 **或** 用了显式 cutplan（方案本身就是卡点，同样按刀弹一下）——注意这跟下面
  // 密度启发式分支里同名的局部 hasBeats 不是一回事，那个只看 beats、不看 plan。
  const pulseEnabled = !!(beats && beats.length) || !!(opts.plan && opts.plan.cuts.length)

  let carItems: Array<{ id: string; start: number; dur: number; shot: Shot | undefined }>
  if (opts.plan && opts.plan.cuts.length) {
    const cutTimes = planCutTimes(opts.plan, shots.length)
      .filter((c) => c.start >= carStart && c.start < carEnd)
      .sort((a, b) => a.start - b.start)
    carItems = cutTimes.map((c, k) => ({
      // id 沿用原 buildDemoSections 的 `car${k}`（不加 demo 前缀）——equivalence 基线按这个字面量记录，
      // Task 4 接线时发现这里曾错写成 `demoCar${k}`，会让 demoCarousel/demoPlan 两条基线在 id 上失配。
      id: `car${k}`, start: c.start, dur: (cutTimes[k + 1]?.start ?? carEnd) - c.start, shot: shots[c.shot],
    }))
  } else {
    // 密度启发式（原样迁自 buildDemoSections 的 hasBeats 分支）
    const hasBeats = !!(beats && beats.length)
    let cutStarts: number[] = []
    if (hasBeats) {
      const win = beats!.filter((b) => b >= carStart && b < carEnd)
      // 切点数至少等于图数（保证每张图播到），但不超过窗口内拍数；否则按"每 4 拍一刀"的密度均匀取拍
      const cutCount = Math.min(win.length, Math.max(shots.length, Math.ceil(win.length / 4)))
      cutStarts = cutCount > 0 ? Array.from({ length: cutCount }, (_, i) => win[Math.floor((i * win.length) / cutCount)]) : []
    }
    if (cutStarts.length < 2 || cutStarts.length < shots.length) {
      // 无 BGM / 窗口内拍太少（不够切出每图至少一刀）：退回按图数均分（保证每张图都能播到）
      const per = shots.length ? (carEnd - carStart) / shots.length : 0
      cutStarts = shots.map((_, i) => carStart + i * per)
    }
    // 每刀循环取一张图；时长 = 到下一刀（末刀到 carEnd）
    carItems = cutStarts.map((start, k) => ({
      id: `car${k}`, start, dur: (cutStarts[k + 1] ?? carEnd) - start, shot: shots[k % shots.length],
    }))
  }

  const segs = [
    { start: 0, dur: 3 },
    { start: 3, dur: 3 },
    ...carItems.map((c) => ({ start: c.start, dur: c.dur })),
    { start: durationSec - 6, dur: 3 },
    { start: durationSec - 3, dur: 3 },
  ]
  const st = snapStarts(segs, beats)

  // demo-pain 原版每条痛点各自一个 `.pain.tw` div（hyperframes.ts:452）——每一行都解码，
  // 不是只解码整块里的第一行，DECODE_ALL（不带 params.line）就是"这一层渲出来的每一行都 tw"。
  const layers: Layer[] = []
  layers.push(textLayer('demo-hook', fromId(sections, 'pain'), st[0], 3, 1, painTitle, 'hookT', DECODE_ALL))
  layers.push(textLayer('demo-pain', fromId(sections, 'pain-1'), st[1], 3, 1, painPoints.join('\n'), 'painWrap', DECODE_ALL))

  carItems.forEach((c, k) => {
    layers.push({
      id: c.id, kind: 'image', from: null, overridden: false,
      start: +st[2 + k].toFixed(4), duration: +c.dur.toFixed(4), track: 2,
      content: { kind: 'image', src: c.shot ? `assets/${c.shot.rel}` : '' } as LayerContent,
      style: { cssClass: c.shot?.orientation === 'portrait' ? 'phoneWrap' : 'wideWrap' },
      // 图片弹跳：每张切进来时（吸附后的 start，与画面切同拍）scale 1→1.06→1.0 弹一下
      // （迁自 buildDemoSections，hyperframes.ts:484-488）——at:0 是相对本图层起点，与原版
      // "在图片自己出现的同一刻触发"完全一致。
      effects: pulseEnabled ? [{ type: 'pulse', at: 0 }] : [],
    })
  })

  const nCar = carItems.length
  layers.push(textLayer('demo-price', fromId(sections, 'body-1'), st[2 + nCar], 3, 1, priceAnchor, 'price', DECODE_ALL))
  layers.push(textLayer('demo-cta', fromId(sections, 'cta'), st[2 + nCar + 1], 3, 1, cta, 'cta', DECODE_ALL))
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
  layers.push(textLayer('insight-intro', fromId(sections, 'pain'), 0, introEnd, 1, painTitle, 'painT', DECODE_ALL))

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
      // 每张卡三类 accent 全部迁回来（原来只搬了 demote，entrance/exit 漏了——这两类在原版里
      // 每张卡都有、不看是否被降级，hyperframes.ts:733,738-741）：
      // 1. 入场淡入+上移（y:24, duration:.45），在卡片自己的起点触发（at:0，相对本层起点）。
      // 2. hero 降级（若适用）——已有逻辑不变。
      // 3. 退场：exitDur = min(.4, card.dur)，'exit' 一个 effect 就产出「缩小淡出+硬收尾」两行
      //    （render-html.ts 里读 layer.start+layer.duration 算退场终点，不在这里重算）。
      const effects: Effect[] = [
        { type: 'fadeIn', at: 0, duration: 0.45, params: { y: 24 } },
        ...demotions
          .filter((d) => d.idx === card.idx)
          .map((d): Effect => ({ type: 'demote', at: +(d.at - card.start).toFixed(4), duration: 0.3 })),
        { type: 'exit', duration: Math.min(0.4, card.dur) },
      ]
      layers.push({
        id, kind: 'text', from: null, overridden: false,
        start: +card.start.toFixed(4), duration: +card.dur.toFixed(4), track: 2 + card.idx,
        content: { kind: 'text', text: `${card.stat} ${card.label}`.trim() } as LayerContent,
        style: { cssClass: 'card', color: primaryColor },
        effects,
      })
    })
  })

  layers.push(textLayer('insight-outro', fromId(sections, 'cta'), outroStart, Math.max(0.5, durationSec - outroStart), 1, cta, 'cta', DECODE_ALL))
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
