/**
 * 一次性 fixture 生成脚本 —— 内容断言门禁（test/content.test.tsx）的输入来源。
 *
 * **重生成方式**（仓库根目录，Node ≥22）：
 *   export NVM_DIR="$HOME/.nvm" && source "$NVM_DIR/nvm.sh" && nvm use 22.23.2 \
 *     && npx tsx packages/compositions/test/fixtures/generate.ts
 *
 * 为什么是这批输入：前七组（flash / story / changelog / demo / demoCarousel / demoPlan /
 * insight）**逐字对齐** `packages/studio/test/equivalence.test.ts` 里 `DOC_FIXTURE` +
 * `NEW_PIPELINE_OPTS` 的同名条目——子项目①的时间轴等价门禁盯的就是这批输入，两边盯同一批输入，
 * ①的时间轴基线与②的内容断言可以互相印证。**改这里之前先去看那个文件**；那边变了，这里要跟着变。
 * （NEW_PIPELINE_OPTS 没有从 equivalence.test.ts 导出，且该文件是①的门禁、②期间只读不写，
 * 所以这里是照抄一份而不是 import。）
 *
 * 后两组是②独有的**补洞** fixture，因为①那七组存在两个盲区，会让本门禁的两条断言恒真：
 * - `flashCaptions`：①的七组 `audio.captionsEnabled` 全是 false，于是一个 `cap` 图层都没有，
 *   「字幕类图层渲不出来」这种历史回归（`.cap` 类名丢失）在那批 fixture 上根本无从暴露。
 * - `demoSpacedShots`：①的 shots 文件名是 `s1.jpg` 这种纯 ASCII 无空格名，
 *   `encodePathForUrl` 退化成恒等函数时产出完全相同的 src，「路径未编码」的断言会恒真
 *   （这正是历史上溜过去的第 4、5 个内容回归）。故这一组的文件名带空格、中文、`#`、`?`。
 * 两组都只是**追加**，不改动那七组的任何输入。
 */
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { CopyDoc } from '../../../copywriter/src/parser'
import { buildSemantic } from '../../../studio/src/semantic'
import { lower, type LowerOpts } from '../../../studio/src/lower'

// ---- 以下 CUES / DOC_FIXTURE / AUDIO_OFF / CANVAS / grid2 / DEMO_SHOTS 均照抄 equivalence.test.ts ----
const CUES = [
  { start: 2, end: 6, text: '返工率高达 30%，每单多花 3 个工作日' },
  { start: 8, end: 12, text: '工期要 2-4周，一单多烧人力' },
  { start: 15, end: 19, text: '外面报价 5 万起' },
]

const DOC_FIXTURE: CopyDoc = {
  titles: ['标题1', '标题2'],
  xhsBody: '痛点一。痛点二。',
  douyinScript: '【报价】\n台词：报价锚点\n【CTA】\n台词：行动号召',
  cover: { main: '标题', sub: '卖点' },
  comments: { questions: [], replies: [] },
}

const AUDIO_OFF = { narration: null, bgm: null, beatGrid: null, captionsEnabled: false }
const AUDIO_CAPTIONS = { narration: null, bgm: null, beatGrid: null, captionsEnabled: true }
const CANVAS = { width: 1080, height: 1920 }

function grid2(duration: number) {
  return { t0: 0, T: 2, bpm: 30, beats: [] as number[], strongBeats: [] as number[], duration }
}

const DEMO_SHOTS: Array<{ rel: string; orientation: 'portrait' | 'landscape' }> = [
  { rel: 's1.jpg', orientation: 'portrait' },
  { rel: 's2.jpg', orientation: 'landscape' },
  { rel: 's3.jpg', orientation: 'portrait' },
]

/** 需要 URL 编码的文件名：空格 / 中文 / `#` / `?`——后两个正是 encodeURI 会放过、
 *  浏览器会当成 fragment/query 截断的字符，所以 Image.tsx 用的是逐段 encodeURIComponent。 */
const SPACED_SHOTS: Array<{ rel: string; orientation: 'portrait' | 'landscape' }> = [
  { rel: 'shots 2026/首页 截图 #1.jpg', orientation: 'portrait' },
  { rel: 'shots 2026/详情页 ?草稿.png', orientation: 'landscape' },
  { rel: 'shots 2026/结算 页.jpg', orientation: 'portrait' },
]

const SPECS: Record<string, () => LowerOpts> = {
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
  // ---- ②独有的补洞 fixture（见文件头注释）----
  flashCaptions: () => ({
    videoId: 'v1', slug: 's', template: 'flash', canvas: CANVAS, durationSec: 30, cues: CUES,
    brandName: '品牌', audio: AUDIO_CAPTIONS,
  }),
  demoSpacedShots: () => ({
    videoId: 'v1', slug: 's', template: 'demo', canvas: CANVAS, durationSec: 40, cues: CUES,
    shots: SPACED_SHOTS, beatGrid: grid2(40), brandName: '品牌', audio: AUDIO_CAPTIONS,
  }),
}

const OUT_DIR = dirname(fileURLToPath(import.meta.url))
/** lower() 会写 `new Date().toISOString()`，直接落盘会让每次重生成都产生无意义 diff。钉死。 */
const FIXED_CREATED_AT = '2026-08-31T00:00:00.000Z'

for (const [name, optsFn] of Object.entries(SPECS)) {
  const opts = optsFn()
  const semantic = buildSemantic(DOC_FIXTURE, opts.template, { cues: CUES })
  const spec = { ...lower(semantic, opts), createdAt: FIXED_CREATED_AT }
  writeFileSync(join(OUT_DIR, `${name}.json`), `${JSON.stringify(spec, null, 2)}\n`)
  console.log(`${name}.json  layers=${spec.layers.length}`)
}
