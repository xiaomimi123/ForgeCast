import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  buildChangelogSections, buildDemoSections, buildFlashSections,
  buildInsightSections, buildStorySections,
} from '../src/hyperframes'

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
      fs.writeFileSync(BASELINE, JSON.stringify(current, null, 2))
      console.warn('基线不存在，已写入。请 review 后提交，再重跑本测试。')
      return
    }
    expect(current).toEqual(JSON.parse(fs.readFileSync(BASELINE, 'utf8')))
  })
})
