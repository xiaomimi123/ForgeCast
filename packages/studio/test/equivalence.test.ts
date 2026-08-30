import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  buildChangelogSections, buildDemoSections, buildFlashSections,
  buildInsightSections, buildStorySections,
} from '../src/hyperframes'

/**
 * 这份基线是整个 VideoSpec 重构（copy → semantic → layers → HTML）的**唯一验收门禁**：
 * 后续每个 Task 改造管线时，本测试比对「改造后生成的 clip 时间轴指纹」与这份改造前基线是否一致，
 * 一致即视为视觉等价。
 *
 * 如果你是后续某个 Task 的执行者、看到本测试变红：**不要删掉/重新生成基线让它变绿**。
 * 那等于把「验证重构没破坏东西」变成「重构声称自己没破坏东西」，会让一次真实的回归静默过关。
 * 变红说明你的改动改变了 clip 时间轴，先去核实这是不是预期内的语义变更；只有在人工确认「基线本身
 * 需要更新」之后，才用下面的 FORGECAST_REGEN_BASELINE=1 显式重建，并在提交里说明原因。
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
 */
export function clipFingerprint(html: string): Array<{ id: string; start: number; dur: number; track: number }> {
  return [...html.matchAll(/<div\s([^>]*)>/g)]
    .map((m) => m[1])
    .filter((a) => /class="[^"]*\bclip\b/.test(a))
    .map((a) => ({
      id: /\bid="([^"]*)"/.exec(a)?.[1] ?? '',
      start: Number(/data-start="([\d.]+)"/.exec(a)?.[1] ?? -1),
      dur: Number(/data-duration="([\d.]+)"/.exec(a)?.[1] ?? -1),
      track: Number(/data-track-index="(\d+)"/.exec(a)?.[1] ?? -1),
    }))
    .sort((x, y) => x.start - y.start || x.track - y.track || x.id.localeCompare(y.id))
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
      Object.entries(FIXTURES).map(([k, fn]) => [k, clipFingerprint(fn().html)]),
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
