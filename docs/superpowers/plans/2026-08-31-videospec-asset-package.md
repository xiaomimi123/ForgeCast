# 素材包（VideoSpec）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把「文案 → HTML 字符串」的一步到位管线，改造成「文案 → 语义层 → 图层层(VideoSpec) → HTML」，让 VideoSpec 成为持久化、可编辑、渲染器无关的中间表示。

**Architecture:** 三个新纯函数层（`buildSemantic` / `lower` / `renderSpecToHtml`）取代散在 `props.ts` + `hyperframes.ts` 里的模板专用逻辑。渲染仍走 HyperFrames——本次是重构，要求**视觉等价**。

**Tech Stack:** TypeScript · vitest · HyperFrames 0.7.68（外部 CLI，`npx --yes` 调用）

**Spec:** `docs/superpowers/specs/2026-08-31-videospec-asset-package-design.md`

## Global Constraints

- **本次是重构，验收核心是「视觉等价」**：同一份 `CopyDoc`，改造前后生成的 HTML 中 clip 的
  `id` / `data-start` / `data-duration` / `data-track-index` 集合必须**完全一致**。Task 1 先采集基线。
- **`<audio>` 必须是合成根节点的直接子元素**（HyperFrames 硬约束，违反则静默静音，commit `65c47f8` 刚踩过）。
  `renderSpecToHtml` 生成的音轨不得被包进 `#cam` 或任何中间容器。
- **只能动 transform / opacity**，动效必须挂暂停主时间线 `tl`；禁止 CSS `@keyframes`、禁止裸 `gsap.to`、禁止 `repeat: -1`。
- **同一 `data-track-index` 上的 clip 不得时间重叠**（HyperFrames 硬规则）。
- **禁止 `Math.random()`**；一切随机走种子化 PRNG。
- **不改 TTS / ASR / BGM / 卡点算法本身**，只消费它们的产物。
- **不做 Remotion、不做剪辑台 UI、不做视频合成**——那是子项目②③④。`Layer.kind` 预留 `'video'` 但本次不渲染它。
- `apps/web` **不引入单测框架**（`"test": "echo 'web: 人工验收，无单测'"` 是既定约定）。
- **测试须用 Node ≥22**：本机 nvm 默认 v20，`better-sqlite3` ABI 不匹配会假红。先
  `export NVM_DIR="$HOME/.nvm" && source "$NVM_DIR/nvm.sh" && nvm use 22.23.2`，再 `npx pnpm ...`。
- **不得用 `pkill` / `killall`**——用户 dev server 在 5173/4321，曾被误杀整套栈。只能按 PID 关自己起的。
- `hyperframes` 命令一律 pin：`npx --yes hyperframes@0.7.68 <sub>`；`snapshot --at` 是**逗号分隔单参数**。

---

### Task 1: 等价性基线采集 + VideoSpec 类型定义

**先采集基线，再动任何代码。** 基线一旦被改造污染就再也拿不到了。

**Files:**
- Create: `packages/studio/src/videospec.ts`（纯类型 + 常量，无逻辑）
- Create: `packages/studio/test/equivalence-baseline.json`（基线快照，进 git）
- Create: `packages/studio/test/equivalence.test.ts`

**Interfaces:**
- Consumes: 无
- Produces: `VideoSpec` / `Semantic` / `Section` / `Layer` / `LayerContent` / `LayerStyle` / `Effect` / `AudioSpec` 类型；一份记录改造前 clip 时间轴的基线

- [ ] **Step 1: 写类型定义**

创建 `packages/studio/src/videospec.ts`，内容按 spec §3.2 逐字实现（`VideoSpec`/`Semantic`/`Section`/
`Layer`/`LayerContent`/`LayerStyle`/`Effect`/`AudioSpec` 八个 interface + `version: 1`）。
**本文件只有类型，不要写任何函数**——它被后续每个 Task 引用，必须零副作用。

同时导出各模板的最短时长常量表（消除 `generate.ts` 里五处硬编码魔数）：

```ts
/** 各模板的最短成片时长（秒）。原先硬编码散落在 generate.ts 五个分支里。 */
export const MIN_DURATION: Record<string, number> = {
  flash: 12, story: 14, demo: 14, insight: 16, changelog: 12, custom: 6,
}
```

- [ ] **Step 2: 写基线采集脚本并跑出基线**

创建 `packages/studio/test/equivalence.test.ts`。它有两个用途：本 Task 里**生成**基线，后续 Task 里**校验**。

```ts
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
  demo: () => buildDemoSections({
    hookTitle: '钩子', painPoints: ['痛点一', '痛点二'], priceAnchor: '报价', cta: '行动', brandName: '品牌',
    shots: [], durationSec: 30, beats: BEATS,
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
```

`demo` 传 `shots: []`（无截图）是刻意的：截图文件不进 git，fixture 必须自包含。
`buildDemoSections` 对空 shots 有兜底路径，基线记录的就是该路径。

- [ ] **Step 3: 跑测试生成基线，人工 review 后提交**

```bash
export NVM_DIR="$HOME/.nvm" && source "$NVM_DIR/nvm.sh" && nvm use 22.23.2
npx pnpm --filter @forgecast/studio test -- equivalence 2>&1 | tail -20
```

第一次跑会写出 `equivalence-baseline.json` 并 warn。**打开这个文件人工核对**：
五个模板都有条目、每个条目的 clip 数量与 id 看起来合理（不是空数组、不是全 `id: ""`）。
若某模板指纹为空，说明 fixture 参数构造错了——修好再重新生成，**不要把错的基线提交进去**。

- [ ] **Step 4: 再跑一次确认基线校验通过**

```bash
npx pnpm --filter @forgecast/studio test -- equivalence 2>&1 | tail -10
```

预期：通过（这次走的是比对分支，不是写入分支）。

- [ ] **Step 5: 提交**

```bash
git add packages/studio/src/videospec.ts packages/studio/test/equivalence.test.ts packages/studio/test/equivalence-baseline.json
git commit -m "feat(studio): VideoSpec 类型定义 + 改造前 clip 时间轴基线（等价性回归用）"
```

---

### Task 2: `buildSemantic` —— 语义层，并修掉两个上屏文案缺陷

**Files:**
- Create: `packages/studio/src/semantic.ts`
- Modify: `packages/studio/src/props.ts`（保留现有导出，内部改为委托 `buildSemantic`；不删除公开函数以免打断既有测试）
- Test: `packages/studio/test/semantic.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `Semantic` / `Section` 类型
- Produces: `buildSemantic(doc: CopyDoc, template: string, opts?: { brandName?: string; cues?: Cue[] }): Semantic`
  （insight 的数据卡来自 cues，故 cues 必须可传；其余模板忽略它）

**背景（实测数据）**：五个模板的取值**全部经由 `buildFlashProps`**（`props.ts:41/75/92/120/127` 都调它），
所以下面第一个缺陷影响**全部五个模板**，不只 flash。

- [ ] **Step 1: 写失败测试**

创建 `packages/studio/test/semantic.test.ts`：

```ts
import { describe, expect, it } from 'vitest'
import { buildSemantic } from '../src/semantic'

const doc: any = {
  titles: ['标题一', '标题二'],
  cover: { main: '封面主', sub: '封面副' },
  xhsBody: '第一句痛点。第二句痛点。第三句痛点。',
  douyinScript: [
    '【0-3s 钩子】（画面：手机聊天记录）接外包的兄弟，这句话你熟不熟？',
    '【40-50s 报价】（画面：报价单特写）外面做要几万，我这套成本一顿火锅钱',
    '【52-60s CTA】（画面：手机弹出评论通知，光标闪烁）想要同款？评论区扣1，链接自己去接',
  ].join('\n'),
  comments: { questions: ['多久能做好'], replies: ['一天'] },
  hook: 'pain',
}

describe('buildSemantic 上屏文案清洗', () => {
  it('CTA 不得包含括号里的拍摄指示（回归：曾把「（画面：…）」当文案打上屏）', () => {
    const s = buildSemantic(doc, 'flash')
    const cta = s.sections.find((x) => x.role === 'cta')!.text!
    expect(cta).not.toContain('画面')
    expect(cta).not.toContain('（')
    expect(cta).toContain('评论区扣1')
  })

  it('报价锚点同样不得包含拍摄指示', () => {
    const s = buildSemantic(doc, 'demo')
    const stat = s.sections.find((x) => x.role === 'stat' || x.role === 'body')
    const all = JSON.stringify(s.sections)
    expect(all).not.toContain('（画面')
    void stat
  })

  it('语义层带稳定 section id，同输入两次结果一致', () => {
    const a = buildSemantic(doc, 'flash')
    const b = buildSemantic(doc, 'flash')
    expect(a).toEqual(b)
    expect(a.sections.every((x) => x.id && /^[a-z0-9-]+$/.test(x.id))).toBe(true)
  })
})

describe('中文数字识别（回归：中文口播曾渲出空片）', () => {
  it('「三到五天」「几万块」能被识别成数据卡', () => {
    const cues = [
      { start: 2, end: 6, text: '工期要三到五天，一单多烧人力' },
      { start: 8, end: 12, text: '外面报价几万块起' },
    ]
    const s = buildSemantic({ ...doc }, 'insight', { cues: cues as any })
    const stats = s.sections.filter((x) => x.role === 'stat')
    expect(stats.length).toBeGreaterThanOrEqual(2)
  })
  it('阿拉伯数字仍然识别（不得回归）', () => {
    const cues = [{ start: 2, end: 6, text: '返工率高达 30%' }]
    const s = buildSemantic({ ...doc }, 'insight', { cues: cues as any })
    expect(s.sections.filter((x) => x.role === 'stat').length).toBe(1)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
npx pnpm --filter @forgecast/studio test -- semantic 2>&1 | tail -20
```

预期：`buildSemantic` 未定义而全部失败。

- [ ] **Step 3: 实现 `buildSemantic`**

新建 `packages/studio/src/semantic.ts`。要点：

1. **所有上屏文案一律过 `cleanNarrationText`**（从 `./tts` 导入）。已验证它能剥掉
   `（画面：…）`：输入 `（画面：手机弹出评论通知，光标闪烁）想要同款？…` → 输出 `想要同款？…`。
   保留现有的「优先取『台词：』行」分支做旧格式兼容，但**不再依赖它**——
   `templates/prompts/_format.md:13` 明确要求 LLM 不加该标签，所以它实际永不命中。
2. **中文数字扩展**：现有 `INSIGHT_STAT_RE`（`hyperframes.ts:648`）只认阿拉伯数字。
   在 `semantic.ts` 里定义新的识别式，数字部分改为 `(?:[\d.]+|[一二三四五六七八九十百千万亿两几]+)`，
   单位部分沿用现有的 `%／万／亿／倍／折／天／周／月／年／个／人／元／次／轮／小时／分钟／工作日／块`。
   **保留 0 命中时的兜底**（spec §6.2），它是最后防线。
3. `section.id` 用 `<role>` 或 `<role>-<序号>` 生成，全小写连字符，**禁止随机/时间戳**。
4. 提取逻辑从 `props.ts` 迁移过来。`props.ts` 的公开函数**保留**，内部改为调用 `buildSemantic`
   再映射回原返回结构——既不打断既有测试，也保证两条路径产出一致。

- [ ] **Step 4: 跑测试确认通过 + 既有测试不破**

```bash
npx pnpm --filter @forgecast/studio test 2>&1 | grep -E "FAIL|Test Files|Tests  "
```

预期：全绿。若 `props.test.ts` 因清洗后文案变化而失败——**那正是本次要修的缺陷**，
按新的正确输出更新断言，并在提交信息里说明。

- [ ] **Step 5: 提交**

```bash
git add packages/studio/src/semantic.ts packages/studio/src/props.ts packages/studio/test/semantic.test.ts
git commit -m "feat(studio): buildSemantic 语义层 + 修 CTA/报价把拍摄指示当文案上屏 + 中文数字识别"
```

---

### Task 3: `lower()` —— 语义层下沉为图层层

**Files:**
- Create: `packages/studio/src/lower.ts`
- Test: `packages/studio/test/lower.test.ts`

**Interfaces:**
- Consumes: Task 1 的类型、Task 2 的 `Semantic`
- Produces: `lower(semantic, opts): VideoSpec`，其中
  `opts: { videoId, slug, template, canvas, durationSec, cues, beatGrid?, shots?, audio }`

**这是本计划的核心。** 现有 `build*Sections` 里**算时间/分组/轨道**的逻辑全部迁到这里，
**拼 HTML 的部分留给 Task 4**。

- [ ] **Step 1: 写失败测试**

```ts
import { describe, expect, it } from 'vitest'
import { lower } from '../src/lower'

const base = {
  videoId: 'v1', slug: 's', canvas: { width: 1080, height: 1920 },
  durationSec: 30, cues: [{ start: 2, end: 6, text: 'a' }],
  audio: { narration: null, bgm: null, beatGrid: null, captionsEnabled: false },
}
const sem = (sections: any[]) => ({ hook: 'pain', sourceAssetId: null, sections })

describe('lower 通用不变量（五个模板都必须满足）', () => {
  for (const template of ['flash', 'story', 'demo', 'changelog', 'insight']) {
    it(`${template}: 同 track 上的图层不得时间重叠`, () => {
      const spec = lower(sem([
        { id: 'hook', role: 'hook', text: '钩子' },
        { id: 'cta', role: 'cta', text: '行动' },
      ]), { ...base, template } as any)
      const byTrack = new Map<number, Array<{ s: number; e: number }>>()
      for (const l of spec.layers) {
        const arr = byTrack.get(l.track) ?? []
        arr.push({ s: l.start, e: l.start + l.duration })
        byTrack.set(l.track, arr)
      }
      for (const arr of byTrack.values()) {
        arr.sort((a, b) => a.s - b.s)
        for (let i = 1; i < arr.length; i++) expect(arr[i].s).toBeGreaterThanOrEqual(arr[i - 1].e - 1e-6)
      }
    })

    it(`${template}: 每个图层都有稳定非空 id，且两次 lower 结果一致`, () => {
      const s1 = lower(sem([{ id: 'hook', role: 'hook', text: 'x' }]), { ...base, template } as any)
      const s2 = lower(sem([{ id: 'hook', role: 'hook', text: 'x' }]), { ...base, template } as any)
      expect(s1.layers.map((l) => l.id)).toEqual(s2.layers.map((l) => l.id))
      expect(s1.layers.every((l) => l.id.length > 0)).toBe(true)
    })

    it(`${template}: 图层不超出片长`, () => {
      const spec = lower(sem([{ id: 'hook', role: 'hook', text: 'x' }]), { ...base, template } as any)
      for (const l of spec.layers) expect(l.start + l.duration).toBeLessThanOrEqual(base.durationSec + 1e-6)
    })

    it(`${template}: 每个来自 section 的图层都带 from 且 overridden=false`, () => {
      const spec = lower(sem([{ id: 'hook', role: 'hook', text: 'x' }]), { ...base, template } as any)
      const fromSection = spec.layers.filter((l) => l.kind !== 'caption')
      expect(fromSection.every((l) => l.from !== null && l.overridden === false)).toBe(true)
    })
  }
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
npx pnpm --filter @forgecast/studio test -- lower 2>&1 | tail -20
```

- [ ] **Step 3: 实现 `lower()`**

按模板分派到五个内部函数（`lowerFlash` / `lowerStory` / `lowerDemo` / `lowerChangelog` / `lowerInsight`），
**逐个从对应的 `build*Sections` 迁移时间计算逻辑**，包括：

- flash / changelog：钩子与 CTA 时长按片长比例 clamp，中段时间点取 `cue.start`/`cue.end` 并钳进中段窗口。
- story / demo：先算 `{start, dur}` 窗口再过 `snapStarts(segs, beats)` 吸附节拍（`hyperframes.ts:99-110`）。
- demo：消费 `cutplan.json`（若 opts 提供了 plan 则用 `planCutTimes`，否则 `autoCutPlan`）。
- insight：**完整迁移**分组（每组 ≤3）、`2 + idx` 轨道分配、驻留上限只在**有后继卡时**生效
  （组内最后一张不设上限，持续到 `sceneEnd`）、hero 跟随「当前是否独播」而非组内下标。
  这几条都是前一轮踩过坑修出来的，**必须原样保留语义**。

字幕图层（`kind: 'caption'`）由 cues 生成，`from: null`，固定 `track: 9`（沿用现值）。
音轨不进 `layers`，走 `spec.audio`。

- [ ] **Step 4: 跑测试确认通过**

```bash
npx pnpm --filter @forgecast/studio test 2>&1 | grep -E "FAIL|Test Files|Tests  "
```

- [ ] **Step 5: 提交**

```bash
git add packages/studio/src/lower.ts packages/studio/test/lower.test.ts
git commit -m "feat(studio): lower() 语义层下沉为图层层（时间轴/分组/轨道逻辑集中于此）"
```

---

### Task 4: `renderSpecToHtml` + 等价性验证

**Files:**
- Create: `packages/studio/src/render-html.ts`
- Test: `packages/studio/test/render-html.test.ts`
- Modify: `packages/studio/test/equivalence.test.ts`（增加「新管线 vs 基线」断言）

**Interfaces:**
- Consumes: Task 1 类型、Task 3 的 `VideoSpec`
- Produces: `renderSpecToHtml(spec: VideoSpec): { html: string; accents: string }`

**这是本计划风险最高的一步**（spec §8）：五个模板的 HTML 拼装各有细节，统一成「遍历 layers」很可能产出细微差异。

- [ ] **Step 1: 写失败测试**

```ts
import { describe, expect, it } from 'vitest'
import { renderSpecToHtml } from '../src/render-html'

const spec: any = {
  version: 1, videoId: 'v1', slug: 's', template: 'flash', createdAt: '',
  semantic: { hook: null, sourceAssetId: null, sections: [] },
  canvas: { width: 1080, height: 1920 }, durationSec: 30,
  audio: { narration: null, bgm: null, beatGrid: null, captionsEnabled: false },
  warnings: [],
  layers: [
    { id: 'flash-hook', kind: 'text', from: 'hook', overridden: false, start: 0, duration: 4, track: 1,
      content: { kind: 'text', text: '钩子<script>' }, style: { cssClass: 'painT' }, effects: [{ type: 'decode' }] },
  ],
}

describe('renderSpecToHtml', () => {
  it('图层的 id/时间/轨道原样落到 clip 属性上', () => {
    const { html } = renderSpecToHtml(spec)
    expect(html).toContain('id="flash-hook"')
    expect(html).toContain('data-start="0"')
    expect(html).toContain('data-duration="4"')
    expect(html).toContain('data-track-index="1"')
  })
  it('文本经 HTML 转义，防注入', () => {
    const { html } = renderSpecToHtml(spec)
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })
  it('decode 特效落成 .tw 类（供 DECODE_RUNTIME 消费）', () => {
    const { html } = renderSpecToHtml(spec)
    expect(html).toMatch(/class="[^"]*\btw\b/)
  })
  it('音轨不在 layers 里，故 html 不含 audio 标签（由 injectAudioCaptions 负责）', () => {
    const { html } = renderSpecToHtml(spec)
    expect(html).not.toContain('<audio')
  })
})
```

在 `equivalence.test.ts` 追加：

```ts
describe('新管线与基线等价', () => {
  it('五个模板经 buildSemantic→lower→renderSpecToHtml 后，clip 指纹与基线一致', () => {
    const baseline = JSON.parse(fs.readFileSync(BASELINE, 'utf8'))
    for (const [template, oldFn] of Object.entries(FIXTURES)) {
      // 新管线：用与基线**完全相同**的输入，只是走 semantic→lower→render 三层
      const sem = buildSemantic(DOC_FIXTURE, template, { cues: CUES })
      const spec = lower(sem, {
        videoId: 'v1', slug: 's', template,
        canvas: { width: 1080, height: 1920 }, durationSec: 30,
        cues: CUES, beats: BEATS, shots: [],
        audio: { narration: null, bgm: null, beatGrid: null, captionsEnabled: false },
      } as any)
      const got = clipFingerprint(renderSpecToHtml(spec).html)
      expect(got, `模板 ${template} 的时间轴指纹与改造前不一致`).toEqual(baseline[template])
      void oldFn
    }
  })
})
```

**注意**：这条断言的输入必须与 Task 1 基线用的**完全相同**，否则比较无意义。
`DOC_FIXTURE` 是能推导出与基线同样文字内容的 `CopyDoc`——它得由实现者在 Task 2 完成后按
`buildSemantic` 的真实取值路径反推构造，并从 `equivalence.test.ts` 导出复用。
若某模板的文字内容无法通过 `CopyDoc` 精确复现，**允许该模板直接构造 `Semantic` 传给 `lower`**
（跳过 `buildSemantic`）——本断言要证的是**时间轴**没变，不是文案提取，后者由 Task 2 的用例覆盖。

- [ ] **Step 2: 跑测试确认失败**

```bash
npx pnpm --filter @forgecast/studio test -- render-html 2>&1 | tail -20
```

- [ ] **Step 3: 实现**

统一遍历 `spec.layers` 生成 `<div class="clip" id=... data-start=... data-duration=... data-track-index=...>`，
内层按 `kind` 与 `style.cssClass` 生成内容节点。`effects` 中的 `decode` 落成 `.tw` 类，
其余特效落成 accents 行（`tl.to(...)`，挂主时间线）。

**若某模板确实无法统一**（如 demo 的手机外框、story 的气泡结构），允许保留该模板专用的
`renderXxxLayers` 分支，**但时间轴必须来自 `spec.layers`，不得回退到自己算**。这是本任务的底线。

- [ ] **Step 4: 跑等价性测试——本任务的真正门禁**

```bash
npx pnpm --filter @forgecast/studio test 2>&1 | grep -E "FAIL|Test Files|Tests  "
```

等价性用例失败 = 重构改变了时间轴语义，**必须修到一致**，不得修改基线来迁就实现。
唯一允许改基线的情况：Task 2 修复的文案清洗导致 clip **文本**变化——但那不影响
指纹（指纹只含 id/时间/轨道），所以指纹仍应一致。

- [ ] **Step 5: 提交**

```bash
git add packages/studio/src/render-html.ts packages/studio/test/render-html.test.ts packages/studio/test/equivalence.test.ts
git commit -m "feat(studio): renderSpecToHtml —— VideoSpec 统一出 HTML，等价性回归通过"
```

---

### Task 5: 管线接入 + 目录改造 + warnings 落库

**Files:**
- Modify: `packages/studio/src/generate.ts`
- Modify: `packages/core/src/db.ts`（`ensureColumn` 加 `assets.spec_path`）
- Test: `packages/studio/test/generate.test.ts`、`packages/core/test/db.test.ts`

**Interfaces:**
- Consumes: Task 2/3/4 的三个函数
- Produces: 每条视频落 `workspace/<slug>/specs/<videoId>.json`；`hf/<videoId>/` 目录；`assets.spec_path` 列

- [ ] **Step 1: 写失败测试**

`packages/core/test/db.test.ts` 追加：

```ts
  it('assets.spec_path 列存在，默认 NULL', () => {
    const db = openDb(tmpDbPath())
    db.prepare("INSERT INTO projects (slug) VALUES ('a')").run()
    db.prepare("INSERT INTO assets (project_id, type, file_path) VALUES (1,'video','a/v.mp4')").run()
    const row = db.prepare('SELECT spec_path FROM assets WHERE id = 1').get() as any
    expect(row.spec_path).toBeNull()
  })
```

`packages/studio/test/generate.test.ts` 追加（stub 模式）：

```ts
  it('生成后落 VideoSpec 文件，且 assets.spec_path 指向它', async () => {
    const r = await generateVideo(ctx, { slug, tpl: 'flash' })
    const row: any = ctx.db.prepare('SELECT spec_path FROM assets WHERE id = ?').get(r.assetId)
    expect(row.spec_path).toBeTruthy()
    const abs = path.join(ctx.config.paths.workspace, row.spec_path)
    expect(fs.existsSync(abs)).toBe(true)
    const spec = JSON.parse(fs.readFileSync(abs, 'utf8'))
    expect(spec.version).toBe(1)
    expect(spec.layers.length).toBeGreaterThan(0)
    expect(spec.canvas).toEqual({ width: 1080, height: 1920 })
  })

  it('hf 目录按 videoId 分开，不再互相覆盖', async () => {
    const a = await generateVideo(ctx, { slug, tpl: 'flash' })
    const b = await generateVideo(ctx, { slug, tpl: 'flash' })
    const specOf = (id: number) => (ctx.db.prepare('SELECT spec_path FROM assets WHERE id=?').get(id) as any).spec_path
    expect(specOf(a.assetId)).not.toBe(specOf(b.assetId))
    // 两条视频的 hf 目录都还在
    const dirs = fs.readdirSync(path.join(ctx.config.paths.workspace, slug, 'hf'))
    expect(dirs.length).toBeGreaterThanOrEqual(2)
  })

  it('TTS 降级时 warnings 落库（回归：原先硬编码 "[]"，信号只进内存日志）', async () => {
    // 触发方式：把 tts.mode 设成 live 但不给 key —— synthesizeVoice 的 degrade() 分支会命中，
    // 返回 degraded 原因并写静音占位 wav。实现者若发现该配置不触发，改用其它必然降级的配置，
    // 但**不要**改成直接构造 spec 断言——那样测不到 generate→落库这条真实链路。
    const r = await generateVideo({ ...ctx, config: { ...ctx.config, tts: { ...ctx.config.tts, mode: 'live', apiKey: '' } } } as any, { slug, tpl: 'flash' })
    const row: any = ctx.db.prepare('SELECT warnings FROM assets WHERE id = ?').get(r.assetId)
    const w = JSON.parse(row.warnings)
    expect(Array.isArray(w)).toBe(true)
    expect(w.length).toBeGreaterThan(0)
    expect(w.join(' ')).toMatch(/TTS|降级/)
  })
```

- [ ] **Step 2: 跑测试确认失败**

```bash
npx pnpm --filter @forgecast/core --filter @forgecast/studio test 2>&1 | grep -E "FAIL|Tests  "
```

- [ ] **Step 3: 实现**

1. `db.ts` 末尾按既有 `ensureColumn` 先例加：
   ```ts
   // 迁移：视频素材包路径（VideoSpec JSON，workspace 相对路径），供剪辑台定位可编辑的视频
   ensureColumn(db, 'assets', 'spec_path', 'TEXT')
   ```
2. `generate.ts` 入口生成一次 `videoId = randomUUID()`，贯穿：
   - `hfDir = path.join(workspace, slug, 'hf', videoId)`
   - spec 落 `workspace/<slug>/specs/<videoId>.json`
   - 视频文件名的 uuid 段改用 `videoId.slice(0,6)`
3. 五个模板分支统一成一条管线：`buildSemantic → lower → renderSpecToHtml → fillTemplate/inject* → scaffold → render`。
   时长下限读 Task 1 的 `MIN_DURATION` 表，删掉五处硬编码魔数。
   `renderCustomTemplate` 里的第六份重复一并合并。
4. `renderAndRegister` 的 INSERT 把写死的 `'[]'` 改成 `JSON.stringify(spec.warnings)`，并写入 `spec_path`。
   TTS 降级 / BGM 混音失败 / 节拍分析失败三处的 `onProgress` **保留**（实时可见），
   同时把原因 push 进 `spec.warnings`。

- [ ] **Step 4: 跑全量 + 合成产物检查**

```bash
npx pnpm test 2>&1 | grep -E "FAIL|Test Files|Tests  "
```

再对一份真实生成的合成产物：

```bash
cd workspace/<slug>/hf/<videoId>
npx --yes hyperframes@0.7.68 check 2>&1 | tail -30
```

预期：**lint 0 error**。特别确认 `<audio>` 仍是 `#root` 直接子元素（未被包进 `#cam`）。

- [ ] **Step 5: 提交**

```bash
git add packages/studio/src/generate.ts packages/core/src/db.ts packages/studio/test/generate.test.ts packages/core/test/db.test.ts
git commit -m "feat(studio): 管线接入 VideoSpec + hf 按视频分目录 + 降级原因落 assets.warnings"
```

---

### Task 6: 前端适配 + 全量回归 + 真渲染

**Files:**
- Modify: `apps/web/src/api.ts`（`Asset` 接口加 `spec_path`）
- Modify: `apps/web/src/pages/workshop/PreviewTab.tsx`
- Modify: `README.md`（仅当有需要同步的段落）

**Interfaces:**
- Consumes: Task 5 的 `spec_path` 列与新目录结构
- Produces: 无

- [ ] **Step 1: 前端适配**

`api.ts` 的 `Asset` 接口加 `spec_path: string | null`。
**不需要新增 API**：`GET /api/projects/:slug/assets` 用的是 `SELECT *`（`app.ts:231`），新列自动下发。

`PreviewTab` 现在硬编码 `/files/${slug}/hf/index.html`，目录改造后会 404。改为：
从已有的 assets 查询里取该项目**最近一条 `type==='video'` 且 `spec_path` 非空**的素材，
从其 `spec_path` 解出 `videoId`，预览 `/files/${slug}/hf/${videoId}/index.html`；
取不到则显示既有的「没读到合成时间线」提示（历史视频没有素材包，属预期）。

- [ ] **Step 2: 类型检查**

```bash
cd apps/web && npx tsc --noEmit
```

- [ ] **Step 3: 全量回归**

```bash
export NVM_DIR="$HOME/.nvm" && source "$NVM_DIR/nvm.sh" && nvm use 22.23.2
npx pnpm test 2>&1 | grep -E "FAIL|Test Files|Tests  "
cd apps/web && npx tsc --noEmit && npx vite build
```

已知并行满载 flake：`packages/studio` 的 `tts.test.ts`、`packages/rebrand` 的 `kill-port`/`screenshot`。
命中则单独重跑该文件确认，并在报告里说明。

- [ ] **Step 4: 抽帧核对与真渲染**

对一条新生成的视频：

```bash
cd workspace/<slug>/hf/<videoId>
npx --yes hyperframes@0.7.68 snapshot --at 5,14,22,30,40,50 --no-end
```

（`--at` 是**逗号分隔单参数**，重复 flag 只有最后一个生效。）
人眼核对：**与改造前观感一致**——这是本次重构的核心验收，等价性测试只能保证时间轴一致，
观感要靠看。特别检查 CTA 卡片上**不再出现「（画面：…）」**。

再真渲一条 MP4，并测音轨：

```bash
ffmpeg -i <mp4> -af volumedetect -f null - 2>&1 | grep mean_volume
```

`mean_volume` 接近 −91dB 说明静音——本项目有过「全程无报错但产物静音」的先例，
且 `<audio>` 位置约束刚踩过一次，**必须实测**。若本机 TTS 不可用导致无法验证，如实说明，不要假称已验。

- [ ] **Step 5: 浏览器验收**

确认 dev server 在跑（不在则从仓库根 `npx pnpm dev`）。打开做内容 → 预览 tab，
确认能加载新目录结构下的合成产物、播放与拖动正常。

- [ ] **Step 6: 提交**

```bash
git add apps/web/src/api.ts apps/web/src/pages/workshop/PreviewTab.tsx
git commit -m "feat(web): 预览 tab 适配按视频分目录的素材包"
```
