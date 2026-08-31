import type { CopyDoc } from '@forgecast/copywriter'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  buildChangelogSections, buildDemoSections, buildFlashSections,
  buildInsightSections, buildStorySections,
} from '../src/hyperframes'
import { lower, type LowerOpts } from '../src/lower'
import { renderSpecToHtml } from '../src/render-html'
import { buildSemantic } from '../src/semantic'

/**
 * 这份基线是整个 VideoSpec 重构（copy → semantic → layers → HTML）的**唯一验收门禁**：
 * 后续每个 Task 改造管线时，本测试比对「改造后生成的 clip 时间轴指纹」与这份改造前基线是否一致，
 * 一致即视为视觉等价。
 *
 * 如果你是后续某个 Task 的执行者、看到本测试变红：**不要删掉/重新生成基线让它变绿**。
 * 那等于把「验证重构没破坏东西」变成「重构声称自己没破坏东西」，会让一次真实的回归静默过关。
 * 变红说明你的改动改变了 clip 时间轴，先去核实这是不是预期内的语义变更；只有在人工确认「基线本身
 * 需要更新」之后，才用下面的 FORGECAST_REGEN_BASELINE=1 显式重建，并在提交里说明原因。
 *
 * 本文件完全是从「改造前」的 build*Sections 原样重建出来的，不含任何手工改动。
 *
 * `changelog.clCta.twCount=2`（原版同时渲 `brand`品牌名与 `tag`CTA 文案两个 `.tw` 元素，
 * hyperframes.ts:638）曾在 Fix round 1 被误判成"VideoSpec 没有 brandName 字段、凑不出第二行"、
 * 靠一条显式豁免放过去——协调者指出诊断错了：`LowerOpts.brandName` 早就声明了，只是 lower.ts
 * 从没读过它。Fix round 2 把 brandName 烧进 clCta 的 layer 文本（不是在渲染层读 opts 补——spec
 * 要能脱离原始 opts 单独存盘、被剪辑台子项目独立重渲，品牌名必须跟其余文案一样材料化进 layer），
 * 现在 22/22 个 `.tw` 元素全部对上，**没有任何豁免**。
 */
const REGEN = process.env.FORGECAST_REGEN_BASELINE === '1'

const BASELINE = path.join(fileURLToPath(new URL('.', import.meta.url)), 'equivalence-baseline.json')

/**
 * 从生成的 sections HTML 里抽出 clip 的时间轴指纹——这是「视觉等价」的可断言部分。
 *
 * 注意属性顺序在各模板间不一致（已实测）：flash/story/changelog 是 `<div id=... class="clip"`，
 * demo/insight 是 `<div class="clip" id=...`，changelog 还是 `class="clip fill pad"`。
 * 所以**不能**用 `/<div class="clip"/` 去匹配——那样只能抓到 5 个里的 2 个，另外 3 个静默为空。
 * 这里先抓所有 div 的属性串，再按 class 含 clip 过滤。
 *
 * **Fix round 1 扩容**：原指纹只看 id/start/dur/track——完全看不见「这个 clip 有没有做逐字解码」
 * 「这个 clip 有没有强调动画」。这是一个真实的验收漏洞：VideoSpec 重构可以在这条指纹全绿的情况下
 * 把全部 16 处 `.tw` 逐字解码和几乎全部强调动画悄悄丢光——因为指纹从没检查过它们。补两个字段：
 * - `twCount`：该 clip 渲染出的 HTML 块内，有多少个元素的 class 含独立单词 `tw`
 *   （不比较具体类名组合——只关心"有没有解码"这个真正影响观感的信号，用计数足够、
 *   且对类名漂移免疫）。
 * - `accentCount`：`accents` 里有多少行强调动画的目标选择器落在这个 clip 自己的 id 或它内部嵌套
 *   的某个 id 上（扫 `id="..."` 找嵌套 id，不预设任何命名约定——旧版 story 气泡用完全独立的
 *   `storyBubble0` 这类 id、新版用 `storyChat-l0` 这类前缀 id，两种命名都能被"块内有哪些 id"
 *   这个通用扫描找到，不需要各自特判）。
 *
 * 两个新字段都是**计数**、不是逐字匹配 GSAP 调用文本——避免把"引号风格/参数顺序"这类纯格式差异
 * 误判成语义差异。
 */
export function clipFingerprint(html: string, accents = ''): Array<{
  id: string; start: number; dur: number; track: number; twCount: number; accentCount: number
}> {
  const allDivOpens = [...html.matchAll(/<div\s([^>]*)>/g)]
  const clipOpens = allDivOpens
    .map((m) => ({ attrs: m[1], index: m.index as number, len: m[0].length }))
    .filter((d) => /class="[^"]*\bclip\b/.test(d.attrs))
  const accentLines = accents.split('\n').map((l) => l.trim()).filter(Boolean)

  return clipOpens.map((clip, i) => {
    // clip 之间是同级兄弟节点（不互相嵌套，已核对全部 build*Sections 与 render-html.ts 的拼接方式），
    // 所以「这个 clip 自己的内容块」= 从它开标签结束到下一个 clip 开标签开始（或到字符串末尾）。
    const blockStart = clip.index + clip.len
    const blockEnd = i + 1 < clipOpens.length ? clipOpens[i + 1].index : html.length
    const block = html.slice(blockStart, blockEnd)
    const twCount = (block.match(/class="[^"]*\btw\b[^"]*"/g) ?? []).length
    const id = /\bid="([^"]*)"/.exec(clip.attrs)?.[1] ?? ''
    const nestedIds = [...block.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1])
    const relevantIds = id ? [id, ...nestedIds] : nestedIds
    // 匹配目标选择器时不要求引号里恰好只有 "#id"——旧版 changelog 有一条形如
    // `"#clTitle .label"` 的复合选择器（打 clTitle 内部一个没有自己 id 的 class 子元素），
    // 前缀匹配（后面跟引号/空白/点号）才能既认出这种复合选择器、又不会把 "#flashHook2"
    // 误判成命中 "#flashHook"。
    const relevantRe = relevantIds.map((rid) => new RegExp(`["']#${rid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:["'\\s.])`))
    const accentCount = accentLines.filter((l) => relevantRe.some((re) => re.test(l))).length
    return {
      id,
      start: Number(/data-start="([\d.]+)"/.exec(clip.attrs)?.[1] ?? -1),
      dur: Number(/data-duration="([\d.]+)"/.exec(clip.attrs)?.[1] ?? -1),
      track: Number(/data-track-index="(\d+)"/.exec(clip.attrs)?.[1] ?? -1),
      twCount,
      accentCount,
    }
  }).sort((x, y) => x.start - y.start || x.track - y.track || x.id.localeCompare(y.id))
}

/** 固定输入。签名已按 hyperframes.ts 实际定义核对过——注意 story/demo 不吃 cues，吃 beats */
const CUES = [
  { start: 2, end: 6, text: '返工率高达 30%，每单多花 3 个工作日' },
  { start: 8, end: 12, text: '工期要 2-4周，一单多烧人力' },
  { start: 15, end: 19, text: '外面报价 5 万起' },
]
const BEATS = [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30]
export const FIXTURES = {
  flash: () => buildFlashSections({
    cues: CUES, durationSec: 30, painTitle: '标题', sellingPoint: '卖点', cta: '行动', brandName: '品牌',
  }),
  story: () => buildStorySections({
    bubbles: [{ who: 'them', text: '能做吗' }, { who: 'me', text: '可以，等我一天' }, { who: 'them', text: '太好了' }],
    sellingPoint: '卖点', cta: '行动', brandName: '品牌', durationSec: 30, beats: BEATS,
  }),
  changelog: () => buildChangelogSections({
    cues: CUES, durationSec: 30, label: '本周更新', title: '标题', subtitle: '副标', cta: '行动', brandName: '品牌',
  }),
  // beats 不传：hasBeats=false 时，shots:[] 才走真正的「无轮播」兜底路径（cutStarts 保持空数组）。
  // 若像最初写法那样连 beats 一起传，hasBeats=true 会让 buildDemoSections 试图对空 shots 数组取模
  // 索引（`shots[k % shots.length]`），得到 undefined 并在 shotBody 里读 `.rel` 时抛错——已实测复现，
  // 故这里对 brief 原始 fixture 做了修正（brief 假设的「兜底路径」实际只在无节拍网格时触发）。
  demo: () => buildDemoSections({
    hookTitle: '钩子', painPoints: ['痛点一', '痛点二'], priceAnchor: '报价', cta: '行动', brandName: '品牌',
    shots: [], durationSec: 30,
  }),
  // 自动切点分支：有节拍网格、无 plan。carStart=6/carEnd=durationSec-6，durationSec 拉到 40
  // 保证窗口够宽（28s），配合较密的 beats 网格，产出多张 car* 轮播 clip，覆盖 hasBeats 自动分支。
  demoCarousel: () => buildDemoSections({
    hookTitle: '钩子', painPoints: ['痛点一', '痛点二'], priceAnchor: '报价', cta: '行动', brandName: '品牌',
    shots: [
      { rel: 's1.jpg', orientation: 'portrait' },
      { rel: 's2.jpg', orientation: 'landscape' },
      { rel: 's3.jpg', orientation: 'portrait' },
    ],
    durationSec: 40,
    beats: Array.from({ length: 21 }, (_, i) => i * 2), // 0..40 步长 2
  }),
  // cutplan 分支：显式传 plan.cuts，cuts 必须落在 [carStart, carEnd) 内才不会被过滤掉。
  // durationSec=30 时 carStart=6/carEnd=24，这里的三个 cut 都落在窗口内。
  demoPlan: () => buildDemoSections({
    hookTitle: '钩子', painPoints: ['痛点一', '痛点二'], priceAnchor: '报价', cta: '行动', brandName: '品牌',
    shots: [
      { rel: 's1.jpg', orientation: 'portrait' },
      { rel: 's2.jpg', orientation: 'landscape' },
      { rel: 's3.jpg', orientation: 'portrait' },
    ],
    durationSec: 30,
    plan: { cuts: [{ start: 8, shot: 0 }, { start: 14, shot: 1 }, { start: 20, shot: 2 }] },
  }),
  insight: () => buildInsightSections({
    cues: CUES, durationSec: 30, painTitle: '标题', cta: '行动', brandName: '品牌',
  }),
}

describe('改造前后视觉等价（clip 时间轴指纹）', () => {
  it('五个模板的指纹与基线一致', () => {
    const current = Object.fromEntries(
      Object.entries(FIXTURES).map(([k, fn]) => {
        const r = fn()
        return [k, clipFingerprint(r.html, r.accents)]
      }),
    )
    if (!fs.existsSync(BASELINE)) {
      if (!REGEN) {
        throw new Error(
          '等价性基线缺失。这是整轮重构的唯一验收门禁，不会自动重新生成——\n' +
          '若确需重建（例如刻意变更了时间轴语义并已人工确认），显式运行：\n' +
          '  FORGECAST_REGEN_BASELINE=1 npx pnpm --filter @forgecast/studio test -- equivalence',
        )
      }
      fs.writeFileSync(BASELINE, JSON.stringify(current, null, 2))
      console.warn('已按 FORGECAST_REGEN_BASELINE=1 重新生成基线，请人工 review 后提交。')
      return
    }
    expect(current).toEqual(JSON.parse(fs.readFileSync(BASELINE, 'utf8')))
  })
})

/**
 * DOC_FIXTURE：能推导出与 buildSemantic 真实取值路径一致文案的 CopyDoc。内容本身对下面这条断言
 * 无关紧要——七个 fixture 的 clip 时间轴全部只依赖 durationSec/cues/beatGrid/shots/plan，不依赖
 * 文案字面值（各 lowerXxx 函数逐行核对过：durations/starts/tracks 无一处读 section.text 的长度或
 * 内容）。之所以仍要给出一份看起来合理的 CopyDoc，只是让 buildSemantic 能顺利跑完不必要地触发
 * 提取失败的兜底分支——douyinScript 按 buildSemantic 里 extractCta/extractPriceAnchor 的正则
 * 取值路径写了 【报价】/【CTA】 两个分段。
 */
export const DOC_FIXTURE: CopyDoc = {
  titles: ['标题1', '标题2'],
  // 只写 2 句：buildSemantic 的 demo 分支会切出至多 3 条 painPoints，FIXTURES.demo/demoCarousel/
  // demoPlan 三个固定 fixture 用的都是 2 条（['痛点一','痛点二']）——句数得对齐，否则 demo-pain
  // 这个 layer 渲出来的 tw 元素个数（twCount）会因为句子数量不同而跟基线对不上，跟时间轴无关但
  // 会让等价性断言误报。
  xhsBody: '痛点一。痛点二。',
  douyinScript: '【报价】\n台词：报价锚点\n【CTA】\n台词：行动号召',
  cover: { main: '标题', sub: '卖点' },
  // comments 留空：buildSemantic 的 story 分支会用 questions/replies 配对出额外的对话轮次
  // （qaPairs），非空会让气泡数超过 FIXTURES.story 固定用的 3 条——气泡数会驱动 storyChat 这个
  // layer 上挂多少条 slideUp reveal effect（每条气泡一条），数量得跟基线对齐，同样是内容无关但
  // 会让 accentCount 误报的坑。
  comments: { questions: [], replies: [] },
}

const AUDIO_OFF = { narration: null, bgm: null, beatGrid: null, captionsEnabled: false }
const CANVAS = { width: 1080, height: 1920 }

/** story / demoCarousel 复用同一套 t0=0,T=2 的线性拍点网格——gridBeats(grid, durationSec) 展开出的
 *  0,2,4,...,durationSec 序列，分别与本文件 BEATS（30s 场景）、demoCarousel fixture 用的
 *  Array.from({length:21},(_,i)=>i*2)（40s 场景）逐项相等（已核对：两者都是 t0=0/T=2 的等差数列，
 *  仅上界随 durationSec 变化）。用同一个 grid 构造函数复用，不必为两个场景分别手写数组。 */
function grid2(duration: number) {
  return { t0: 0, T: 2, bpm: 30, beats: [] as number[], strongBeats: [] as number[], duration }
}

const DEMO_SHOTS: Array<{ rel: string; orientation: 'portrait' | 'landscape' }> = [
  { rel: 's1.jpg', orientation: 'portrait' },
  { rel: 's2.jpg', orientation: 'landscape' },
  { rel: 's3.jpg', orientation: 'portrait' },
]

/**
 * 新管线（buildSemantic → lower → renderSpecToHtml）每个 fixture 对应的 LowerOpts——必须与
 * equivalence-baseline.json 对应模板的固定输入（本文件顶部 FIXTURES）逐项对齐：
 * - flash/changelog/insight：只吃 cues + durationSec，直接照抄 CUES/30。
 * - story：老函数直接传 beats 数组（BEATS），新管线改吃 beatGrid，用 grid2(30) 展开出同一份数组。
 * - demo：无节拍/无图（老 FIXTURES.demo 用 shots:[]，未传 beats）。
 * - demoCarousel：3 图 + durationSec 40 + grid2(40)（展开为老 fixture 手写的 0..40 步长 2 网格）。
 * - demoPlan：3 图 + 显式 plan——老 plan.cuts 直接给 {start,shot}，新 LowerPlan 用 {grid,offsetSec,cuts:{beat,shot}}
 *   表达同一组绝对时间；这里取 grid={t0:0,T:1}、offsetSec:0，让 beat 数值本身就等于秒数（8/14/20）。
 */
// brandName: '品牌' 对齐 FIXTURES 同一个字段，for **every** template——不是只对齐 changelog。
// Fix round 1（第 5 次修复）之前，flash/story/demo/insight 四个模板的 NEW_PIPELINE_OPTS 都没传
// brandName，导致 lower() 里对应的 brandName 消费代码路径从未被这份等价性测试实际跑过：
// demo-cta/insight-outro 两处曾经完全没读 opts.brandName（真实内容回归，遗漏了 4 轮才被发现），
// flash/story 虽然在更早的轮次里已经把 brandName 接进 lower()，但同样从没被这里验证过。
// twCount 本身不会因为这处改动而变化（brand 行在 flash/story/demo/insight 里原版都不带 `.tw`，
// 只有 changelog 的 clCta 例外——两行都 `.tw`），这里补齐纯粹是为了让「内容回归」这条路径
// 真正被结构指纹测试覆盖到，而不是靠巧合蒙混过关。
const NEW_PIPELINE_OPTS: Record<keyof typeof FIXTURES, () => LowerOpts> = {
  flash: () => ({
    videoId: 'v1', slug: 's', template: 'flash', canvas: CANVAS, durationSec: 30, cues: CUES,
    brandName: '品牌', audio: AUDIO_OFF,
  }),
  story: () => ({
    videoId: 'v1', slug: 's', template: 'story', canvas: CANVAS, durationSec: 30, cues: CUES,
    beatGrid: grid2(30), brandName: '品牌', audio: AUDIO_OFF,
  }),
  changelog: () => ({
    videoId: 'v1', slug: 's', template: 'changelog', canvas: CANVAS, durationSec: 30, cues: CUES,
    brandName: '品牌', audio: AUDIO_OFF,
  }),
  demo: () => ({
    videoId: 'v1', slug: 's', template: 'demo', canvas: CANVAS, durationSec: 30, cues: CUES, shots: [],
    brandName: '品牌', audio: AUDIO_OFF,
  }),
  demoCarousel: () => ({
    videoId: 'v1', slug: 's', template: 'demo', canvas: CANVAS, durationSec: 40, cues: CUES,
    shots: DEMO_SHOTS, beatGrid: grid2(40), brandName: '品牌', audio: AUDIO_OFF,
  }),
  demoPlan: () => ({
    videoId: 'v1', slug: 's', template: 'demo', canvas: CANVAS, durationSec: 30, cues: CUES,
    shots: DEMO_SHOTS,
    plan: { grid: { t0: 0, T: 1 }, offsetSec: 0, cuts: [{ beat: 8, shot: 0 }, { beat: 14, shot: 1 }, { beat: 20, shot: 2 }] },
    brandName: '品牌', audio: AUDIO_OFF,
  }),
  insight: () => ({
    videoId: 'v1', slug: 's', template: 'insight', canvas: CANVAS, durationSec: 30, cues: CUES,
    brandName: '品牌', audio: AUDIO_OFF,
  }),
}

describe('新管线与基线等价', () => {
  it('七个 fixture 经 buildSemantic→lower→renderSpecToHtml 后，clip 时间轴指纹与基线一致', () => {
    const baseline = JSON.parse(fs.readFileSync(BASELINE, 'utf8'))
    for (const key of Object.keys(FIXTURES) as Array<keyof typeof FIXTURES>) {
      // 新管线：用与基线完全相同的时间轴输入（durationSec/cues/beatGrid/shots/plan），
      // 只是走 semantic→lower→render 三层，而不是直接调旧 build*Sections。
      const opts = NEW_PIPELINE_OPTS[key]()
      const sem = buildSemantic(DOC_FIXTURE, opts.template, { cues: CUES })
      const spec = lower(sem, opts)
      const rendered = renderSpecToHtml(spec)
      const got = clipFingerprint(rendered.html, rendered.accents)
      // Fix round 2 起不再有豁免：clCta 的 brandName 已经烧进 layer 文本，直接对基线严格比较。
      expect(got, `模板 ${key} 的时间轴指纹与改造前不一致`).toEqual(baseline[key])
    }
  })
})
