# 对标视频拆解 → 模板库 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 上传对标视频 → 自动拆解节奏 → LLM 设计一个新 HyperFrames 模板并校验合法 → 存入全局"模板库" → 任何项目都能在「出视频」tab 选中它，用当前项目文案渲染视频；新模板支持竖屏/横屏选择（现有 5 个内置模板不变）。

**Architecture:** 新增 `packages/studio/src/benchmark.ts`（纯规则拆解节奏）+ `packages/studio/src/custom-template.ts`（LLM 设计模板 + 两道校验 + 落库编排 + 渲染期分段填充的纯函数）；`custom_templates` 新表存模板元数据 + 拆解节奏 JSON；模板 HTML 落 `templates/hf/custom/<id>.html`（全局共享，不挂项目）；`generate.ts` 按 `tpl` 前缀 `custom-<id>` 分流到新渲染分支，复用现有 TTS/BGM/字幕注入管线；Web 做内容页新增「模板库」tab 负责上传拆解，「出视频」tab 下拉框合并展示。

**Tech Stack:** 沿用现状（Hono + React + SQLite + HyperFrames CLI + ffmpeg/ffprobe）。

**Spec:** `docs/superpowers/specs/2026-08-25-benchmark-template-library-design.md`

## Global Constraints

- 每个命令前先 `export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH"`。
- mock 模式绝不调用 `ctx.llm`（fixture）——仓库铁律。
- 拆解（`analyzeBenchmark`）纯 fail-soft，**绝不抛错**：探测失败一律回退默认三段均分（呼应 review.ts 的 `probeDuration` fail-soft 风格）。
- LLM 产出校验（占位符契约 + `hyperframes check`）失败重试一次，仍失败**整批抛错，不落库**——`hyperframes check` 这道结构校验只在 **live LLM 模式**下跑（mock 模式的 fixture 是我们自己写的、信任合法，不花成本起 Chromium）。
- 现有 5 个内置模板（flash/story/demo/changelog/insight）保持固定竖屏不动，本次不改。
- 新模板内容仍来自当前项目文案的 TTS cue，不是照抄对标视频说了什么。
- 测试用 `fs.mkdtempSync` 临时目录；db/server 测试沿用 `loadConfig(root, {})` + `openDb` + `createLlmClient` 组合（见 `packages/studio/test/retro.test.ts`、`packages/server/test/shoot-review.test.ts` 先例）。
- 提交信息结尾带 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`。

---

### Task 1: 拆解节奏 `analyzeBenchmark`（studio）

**Files:**
- Create: `packages/studio/src/benchmark.ts`
- Create: `packages/studio/test/benchmark.test.ts`
- Modify: `packages/studio/src/index.ts`（补 `export * from './benchmark'`）

**Interfaces:**
- Produces: `interface PacingSegment { start: number; end: number }`；`interface Pacing { durationSec: number; segments: PacingSegment[] }`；`interface BenchmarkDeps { probe?: (path: string) => Promise<number | null>; detect?: (path: string) => Promise<number[]> }`；`analyzeBenchmark(videoPath: string, deps?: BenchmarkDeps): Promise<Pacing>`；常量 `MIN_SEGMENTS = 2`、`MAX_SEGMENTS = 8`、`DEFAULT_DURATION_SEC = 15`。Task 3/4/5 都消费 `Pacing`。

- [ ] **Step 1: 写失败测试**

`packages/studio/test/benchmark.test.ts`：

```ts
import { describe, expect, it } from 'vitest'
import { analyzeBenchmark, MAX_SEGMENTS, MIN_SEGMENTS } from '../src/benchmark'

describe('analyzeBenchmark', () => {
  it('正常场景：切镜时间点转成连续分段', async () => {
    const p = await analyzeBenchmark('/fake.mp4', {
      probe: async () => 12,
      detect: async () => [3, 6, 9],
    })
    expect(p.durationSec).toBe(12)
    expect(p.segments).toEqual([
      { start: 0, end: 3 }, { start: 3, end: 6 }, { start: 6, end: 9 }, { start: 9, end: 12 },
    ])
  })

  it('检测不到切镜（单镜头到底）→ 回退默认三段均分', async () => {
    const p = await analyzeBenchmark('/fake.mp4', { probe: async () => 9, detect: async () => [] })
    expect(p.segments).toHaveLength(3)
    expect(p.segments[0]).toEqual({ start: 0, end: 3 })
    expect(p.segments[2]).toEqual({ start: 6, end: 9 })
  })

  it('切镜过密（超过 MAX_SEGMENTS）→ 均匀抽样裁剪', async () => {
    const cuts = Array.from({ length: 20 }, (_, i) => i + 1) // 20 个切点，21 段
    const p = await analyzeBenchmark('/fake.mp4', { probe: async () => 21, detect: async () => cuts })
    expect(p.segments).toHaveLength(MAX_SEGMENTS)
    expect(p.segments[0].start).toBe(0)
    expect(p.segments.at(-1)!.end).toBe(21)
  })

  it('探测/ffprobe 失败（probe 返 null）→ fail-soft 回退默认时长三段，不抛错', async () => {
    const p = await analyzeBenchmark('/fake.mp4', { probe: async () => null, detect: async () => [] })
    expect(p.durationSec).toBe(15)
    expect(p.segments).toHaveLength(3)
  })

  it('detect 抛错也不冒泡（deps 假实现模拟 ffmpeg 崩溃）', async () => {
    const p = await analyzeBenchmark('/fake.mp4', {
      probe: async () => 10,
      detect: async () => { throw new Error('ffmpeg crashed') },
    })
    expect(p.segments.length).toBeGreaterThanOrEqual(MIN_SEGMENTS)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH" && pnpm --filter @forgecast/studio exec vitest run test/benchmark.test.ts`
Expected: FAIL（`../src/benchmark` 模块不存在）

- [ ] **Step 3: 实现 `benchmark.ts`**

```ts
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const pExecFile = promisify(execFile)
const FFPROBE_TIMEOUT_MS = 30_000
const FFMPEG_TIMEOUT_MS = 60_000

export const MIN_SEGMENTS = 2
export const MAX_SEGMENTS = 8
export const DEFAULT_DURATION_SEC = 15
const SCENE_THRESHOLD = 0.4

export interface PacingSegment { start: number; end: number }
export interface Pacing { durationSec: number; segments: PacingSegment[] }
export interface BenchmarkDeps {
  probe?: (videoPath: string) => Promise<number | null>
  detect?: (videoPath: string) => Promise<number[]>
}

/** ffprobe 读时长（秒）；失败/坏文件一律返 null（fail-soft，绝不抛错，同 review.ts 的 probeDuration）。 */
export async function probeBenchmarkDuration(videoPath: string): Promise<number | null> {
  try {
    const { stdout } = await pExecFile(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', videoPath],
      { timeout: FFPROBE_TIMEOUT_MS },
    )
    const v = Number(stdout.trim())
    return Number.isFinite(v) && v > 0 ? v : null
  } catch {
    return null
  }
}

/** ffmpeg 场景切换检测，解析 showinfo 的 pts_time 拿切镜时间点；失败/无输出返回空数组（fail-soft）。 */
export async function detectSceneCuts(videoPath: string): Promise<number[]> {
  try {
    const { stderr } = await pExecFile(
      'ffmpeg',
      ['-i', videoPath, '-vf', `select='gt(scene,${SCENE_THRESHOLD})',showinfo`, '-f', 'null', '-'],
      { timeout: FFMPEG_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 },
    )
    const matches = stderr.matchAll(/pts_time:(\d+\.?\d*)/g)
    return Array.from(matches, (m) => Number(m[1])).filter((n) => Number.isFinite(n))
  } catch {
    return []
  }
}

function evenSplit(durationSec: number, n: number): PacingSegment[] {
  const step = durationSec / n
  return Array.from({ length: n }, (_, i) => ({ start: i * step, end: i === n - 1 ? durationSec : (i + 1) * step }))
}

/**
 * 拆解对标视频节奏：ffprobe 时长 + ffmpeg 场景检测切镜时间点 → 连续分段。
 * 全程 fail-soft，绝不抛错：探测失败/检测不到切镜/切镜过密，均有对应回退规则。
 */
export async function analyzeBenchmark(videoPath: string, deps: BenchmarkDeps = {}): Promise<Pacing> {
  const probe = deps.probe ?? probeBenchmarkDuration
  const detect = deps.detect ?? detectSceneCuts
  const durationSec = (await probe(videoPath)) ?? DEFAULT_DURATION_SEC

  let cuts: number[] = []
  try {
    cuts = (await detect(videoPath)).filter((t) => t > 0 && t < durationSec).sort((a, b) => a - b)
  } catch {
    cuts = []
  }

  const boundaries = [0, ...cuts, durationSec]
  let segments: PacingSegment[] = []
  for (let i = 0; i < boundaries.length - 1; i++) {
    if (boundaries[i + 1] - boundaries[i] > 0.1) segments.push({ start: boundaries[i], end: boundaries[i + 1] })
  }

  if (segments.length < MIN_SEGMENTS) {
    segments = evenSplit(durationSec, 3)
  } else if (segments.length > MAX_SEGMENTS) {
    const step = segments.length / MAX_SEGMENTS
    const picked = Array.from({ length: MAX_SEGMENTS }, (_, i) => segments[Math.min(segments.length - 1, Math.floor(i * step))])
    segments = picked.map((seg, i) => ({ start: seg.start, end: i < picked.length - 1 ? picked[i + 1].start : durationSec }))
  }

  return { durationSec, segments }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @forgecast/studio exec vitest run test/benchmark.test.ts`
Expected: PASS（5 tests）

- [ ] **Step 5: 导出 + 提交**

`packages/studio/src/index.ts` 加一行：

```ts
export * from './benchmark'
```

```bash
git add packages/studio/src/benchmark.ts packages/studio/test/benchmark.test.ts packages/studio/src/index.ts
git commit -m "$(cat <<'EOF'
feat(studio): analyzeBenchmark 拆解对标视频节奏（ffprobe+ffmpeg 场景检测，fail-soft）

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: `custom_templates` 表

**Files:**
- Modify: `packages/core/src/db.ts`
- Modify: `packages/core/test/db.test.ts`

**Interfaces:**
- Produces: 表 `custom_templates(id, name, aspect_ratio, segment_count, style_note, benchmark_path, segments_json, created_at)`。`segments_json` 存整个 `Pacing`（`{durationSec, segments}`）JSON 串，不只是 segments 数组——渲染期 `computeSegmentWindows`（Task 3）需要 `durationSec` 做比例换算。Task 3/4/5 都读写这张表。

- [ ] **Step 1: 写失败测试**

`packages/core/test/db.test.ts` 追加（沿用现有 `describe('openDb', ...)` 块内）：

```ts
  it('custom_templates 表存在且可插入', () => {
    const db = openDb(tmpDbPath())
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='custom_templates'").get()
    expect(row).toBeTruthy()
    const pacing = JSON.stringify({ durationSec: 12, segments: [{ start: 0, end: 12 }] })
    const info = db.prepare(
      "INSERT INTO custom_templates (name, aspect_ratio, segment_count, style_note, benchmark_path, segments_json) VALUES ('对标A', 'portrait', 1, '科技感', '_templates/x/benchmark.mp4', ?)",
    ).run(pacing)
    const inserted: any = db.prepare('SELECT * FROM custom_templates WHERE id = ?').get(info.lastInsertRowid)
    expect(inserted.name).toBe('对标A')
    expect(inserted.aspect_ratio).toBe('portrait')
    expect(JSON.parse(inserted.segments_json).durationSec).toBe(12)
    expect(inserted.created_at).toBeTruthy()
  })
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @forgecast/core exec vitest run test/db.test.ts`
Expected: FAIL（`no such table: custom_templates`）

- [ ] **Step 3: 加表**

`packages/core/src/db.ts`：在 `demand_matches` 建表语句之后、`atoms_fts` 虚表之前插入：

```sql
CREATE TABLE IF NOT EXISTS custom_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  aspect_ratio TEXT NOT NULL,
  segment_count INTEGER NOT NULL,
  style_note TEXT,
  benchmark_path TEXT,
  segments_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @forgecast/core exec vitest run test/db.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/db.ts packages/core/test/db.test.ts
git commit -m "$(cat <<'EOF'
feat(core): custom_templates 表（模板库元数据 + 拆解节奏 JSON）

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: LLM 设计模板 `generateCustomTemplate` + 落库编排 `createCustomTemplate`

**Files:**
- Create: `templates/prompts/custom-template.md`
- Create: `packages/studio/src/fixtures/custom-template-fixture.ts`
- Create: `packages/studio/src/custom-template.ts`
- Create: `packages/studio/test/custom-template.test.ts`
- Modify: `packages/studio/src/hyperframes.ts`（把私有 `HF_VERSION` 常量改为 `export const`）
- Modify: `packages/studio/src/index.ts`（补 `export * from './custom-template'`）

**Interfaces:**
- Consumes: Task 1 的 `Pacing`/`PacingSegment`；`hyperframes.ts` 的 `fillTemplate`/`scaffoldHfProject`/`spawnWithTimeout`/`export const HF_VERSION`；`./tts` 的 `Cue`。
- Produces: `type AspectRatio = 'portrait' | 'landscape'`；`ASPECT_DIMENSIONS: Record<AspectRatio, {width:number;height:number}>`；`validateCustomTemplateHtml(html, segmentCount, width, height): string[]`；`generateCustomTemplate(ctx, {pacing, aspectRatio, styleNote?}, deps?): Promise<{html:string; segmentCount:number}>`；`customTemplateHtmlPath(ctx, id): string`；`computeSegmentWindows(segments, benchmarkDurationSec, targetDurationSec): {start:number;end:number}[]`；`bucketCuesBySegments(cues, windows): string[]`；`createCustomTemplate(ctx, {name, aspectRatio, styleNote?, benchmarkAbsPath, benchmarkRelPath, onProgress?}): Promise<{id:number; name:string}>`（写 `custom_templates` 行 + `templates/hf/custom/<id>.html`）。Task 4 的 server 路由、Task 5 的 `generate.ts` 都消费这些导出。

- [ ] **Step 1: 写提示词模板**

`templates/prompts/custom-template.md`：

```markdown
你是短视频模板设计师。根据一条对标视频拆解出的节奏数据，设计一个全新的 HyperFrames 竖屏/横屏视频模板（HTML+CSS+GSAP），供以后任何项目复用渲染。

【产出契约（必须严格遵守，逐条对照）】
1. 根节点：`<div id="root" data-composition-id="main" data-start="0" data-duration="{{duration}}" data-width="<W>" data-height="<H>">`，`<W>`/`<H>` 用下方给出的画布尺寸数字原样代入 `data-width`/`data-height`。
2. 恰好按给定的分段数 N，写 N 个分段 div，从 0 开始编号，每个必须是：
   `<div id="s<K>" class="clip" data-start="{{seg<K>_start}}" data-duration="{{seg<K>_dur}}" data-track-index="1"><div class="segText">{{seg<K>_text}}</div></div>`
   `<K>` 替换成段序号（0, 1, 2...N-1），`{{seg<K>_start}}`/`{{seg<K>_dur}}`/`{{seg<K>_text}}` 三个占位符原样输出（不要替换成数字，运行时代码会填）。
3. 分段 div 内必须恰好包含 `<!--HF_AUDIO-->` 和 `<!--HF_CAPTIONS-->` 两个 HTML 注释标记（各一次，不要自己写 `<audio>` 标签）。
4. 若要给字幕留视觉样式，定义一个 `.cap` CSS class（字幕条会以 `<div class="cap clip">` 形式注入，不需要你手写字幕内容）。
5. 引入 `<script src="gsap.min.js"></script>`；结尾必须有：
   ```
   <script>
     window.__timelines = window.__timelines || {};
     const tl = gsap.timeline({ paused: true });
     window.__timelines["main"] = tl;
   </script>
   ```
   动效一律挂在这条 `tl` 上（`tl.to(...)`/`tl.from(...)`），不要用 CSS `@keyframes`（HyperFrames 逐帧 seek 渲染，`@keyframes` 不会按预期播放）。
6. 只用内联 CSS/`<style>`，不引外链字体/图片/脚本（离线渲染环境没有网络）。不要出现 `<video>` 标签。
7. 只输出完整 HTML 文档本身，不要任何解释文字、不要 markdown 代码块包裹。

【视觉风格】CSS 配色/字体/背景/动效自由发挥，参考下方给出的风格描述（若提供）。分段的时长占比暗示了节奏快慢——占比小的段适合更简短有冲击力的文字处理，占比大的段可以有更多铺陈动效。
```

- [ ] **Step 2: `hyperframes.ts` 把 `HF_VERSION` 导出**

找到 `const HF_VERSION = '0.7.68'`（`// pin HyperFrames 版本` 注释下方），改成：

```ts
export const HF_VERSION = '0.7.68'
```

- [ ] **Step 3: 写 mock fixture**

`packages/studio/src/fixtures/custom-template-fixture.ts`：

```ts
/**
 * mock 模式固定模板骨架：纯色背景 + 居中文字，N 段动态数量，满足 generateCustomTemplate
 * 的占位符契约（見 custom-template.ts 的 validateCustomTemplateHtml）。绝不调用 ctx.llm。
 */
export function mockCustomTemplateHtml(segmentCount: number, width: number, height: number): string {
  const segs = Array.from({ length: segmentCount }, (_, i) => (
    `      <div id="s${i}" class="clip fill pad center" data-start="{{seg${i}_start}}" data-duration="{{seg${i}_dur}}" data-track-index="1">
        <div class="segText">{{seg${i}_text}}</div>
      </div>`
  )).join('\n')
  return `<!doctype html>
<html lang="zh">
  <head>
    <meta charset="UTF-8" />
    <script src="gsap.min.js"></script>
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      html, body { width: ${width}px; height: ${height}px; overflow: hidden; background: #101018; font-family: "Noto Sans CJK SC", "PingFang SC", sans-serif; }
      .fill { position: absolute; inset: 0; } .pad { padding: 80px; }
      .center { display: flex; flex-direction: column; justify-content: center; align-items: center; text-align: center; }
      .segText { font-size: 64px; font-weight: 800; color: #fff; line-height: 1.4; }
      .cap { position: absolute; left: 50%; bottom: 100px; transform: translateX(-50%); max-width: 90%; text-align: center; font-size: 36px; color: #fff; background: rgba(0,0,0,.7); padding: 14px 28px; border-radius: 12px; z-index: 5; }
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="main" data-start="0" data-duration="{{duration}}" data-width="${width}" data-height="${height}">
${segs}
      <!--HF_CAPTIONS-->
      <!--HF_AUDIO-->
    </div>
    <script>
      window.__timelines = window.__timelines || {};
      const tl = gsap.timeline({ paused: true });
      window.__timelines["main"] = tl;
    </script>
  </body>
</html>`
}
```

- [ ] **Step 4: 写失败测试**

`packages/studio/test/custom-template.test.ts`：

```ts
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createLlmClient, loadConfig, openDb, type CoreCtx } from '@forgecast/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mockCustomTemplateHtml } from '../src/fixtures/custom-template-fixture'
import {
  ASPECT_DIMENSIONS, bucketCuesBySegments, computeSegmentWindows, createCustomTemplate,
  customTemplateHtmlPath, generateCustomTemplate, validateCustomTemplateHtml,
} from '../src/custom-template'
import type { Pacing } from '../src/benchmark'

let ctx: CoreCtx
let root: string
const PACING: Pacing = { durationSec: 12, segments: [{ start: 0, end: 4 }, { start: 4, end: 8 }, { start: 8, end: 12 }] }

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-custom-tpl-'))
  const config = loadConfig(root, {})
  ctx = { db: openDb(config.paths.db), config, llm: createLlmClient(config.llm) }
})

describe('validateCustomTemplateHtml', () => {
  it('mock fixture 满足全部占位符契约', () => {
    const html = mockCustomTemplateHtml(3, 1080, 1920)
    expect(validateCustomTemplateHtml(html, 3, 1080, 1920)).toEqual([])
  })
  it('缺 seg1_text 占位符 → 报错列表非空', () => {
    const html = mockCustomTemplateHtml(3, 1080, 1920).replace('{{seg1_text}}', '写死文字')
    const errors = validateCustomTemplateHtml(html, 3, 1080, 1920)
    expect(errors.some((e) => e.includes('seg1_text'))).toBe(true)
  })
  it('data-width 不匹配 → 报错', () => {
    const html = mockCustomTemplateHtml(3, 1080, 1920)
    expect(validateCustomTemplateHtml(html, 3, 1920, 1080).some((e) => e.includes('data-width'))).toBe(true)
  })
})

describe('computeSegmentWindows / bucketCuesBySegments', () => {
  it('按比例把拆解节奏映射到目标时长', () => {
    const windows = computeSegmentWindows(PACING.segments, PACING.durationSec, 6)
    expect(windows).toEqual([{ start: 0, end: 2 }, { start: 2, end: 4 }, { start: 4, end: 6 }])
  })
  it('末段严格对齐目标时长（消除浮点误差）', () => {
    const windows = computeSegmentWindows(PACING.segments, PACING.durationSec, 7)
    expect(windows.at(-1)!.end).toBe(7)
  })
  it('cue 按时间点落进对应窗口', () => {
    const cues = [{ start: 0.5, end: 1.5, text: 'A' }, { start: 4.2, end: 5, text: 'B' }]
    const windows = [{ start: 0, end: 2 }, { start: 2, end: 4 }, { start: 4, end: 6 }]
    const texts = bucketCuesBySegments(cues, windows)
    expect(texts[0]).toBe('A')
    expect(texts[2]).toBe('B')
  })
  it('窗口没分到 cue 时回退用邻近 cue 文本，不留空串', () => {
    const cues = [{ start: 0.5, end: 1.5, text: '仅这一句' }]
    const windows = [{ start: 0, end: 2 }, { start: 2, end: 4 }]
    const texts = bucketCuesBySegments(cues, windows)
    expect(texts[1]).not.toBe('')
  })
})

describe('generateCustomTemplate mock', () => {
  it('mock 模式返回合法模板，不调用 ctx.llm，不做 hyperframes check', async () => {
    const spy = vi.spyOn(ctx.llm, 'complete')
    const checkSpy = vi.fn(async () => true)
    const r = await generateCustomTemplate(ctx, { pacing: PACING, aspectRatio: 'portrait' }, { checkComposition: checkSpy })
    expect(spy).not.toHaveBeenCalled()
    expect(checkSpy).not.toHaveBeenCalled()
    expect(r.segmentCount).toBe(3)
    expect(validateCustomTemplateHtml(r.html, 3, 1080, 1920)).toEqual([])
  })
})

describe('generateCustomTemplate live（假 LLM）', () => {
  function liveCtx(complete: (...args: any[]) => Promise<string>): CoreCtx {
    const config = loadConfig(fs.mkdtempSync(path.join(os.tmpdir(), 'fc-custom-tpl-live-')), { FORGECAST_LLM_MODE: 'live', FORGECAST_LLM_KEY: 'k' })
    // live 模式要读 templates/prompts/custom-template.md，临时目录里没有，指回仓库真实 templates/
    // （沿用 packages/copywriter/test/script.test.ts 的既有做法）
    config.paths.templates = path.resolve(__dirname, '../../../templates')
    return { db: openDb(config.paths.db), config, llm: { complete: vi.fn(complete) } as any }
  }

  it('首次产出缺占位符 → 重试一次，第二次合法则成功', async () => {
    let call = 0
    const lctx = liveCtx(async () => {
      call += 1
      return call === 1
        ? mockCustomTemplateHtml(3, 1080, 1920).replace('{{seg2_text}}', '写死')
        : mockCustomTemplateHtml(3, 1080, 1920)
    })
    const r = await generateCustomTemplate(lctx, { pacing: PACING, aspectRatio: 'portrait' }, { checkComposition: async () => true })
    expect(call).toBe(2)
    expect(validateCustomTemplateHtml(r.html, 3, 1080, 1920)).toEqual([])
  })

  it('两次都缺占位符 → 抛错，不返回', async () => {
    const lctx = liveCtx(async () => mockCustomTemplateHtml(3, 1080, 1920).replace('{{seg0_start}}', '0'))
    await expect(generateCustomTemplate(lctx, { pacing: PACING, aspectRatio: 'portrait' }, { checkComposition: async () => true }))
      .rejects.toThrow(/校验失败/)
    expect((lctx.llm.complete as any)).toHaveBeenCalledTimes(2)
  })

  it('占位符合法但 hyperframes check 未通过 → 重试一次仍失败则抛错', async () => {
    const lctx = liveCtx(async () => mockCustomTemplateHtml(2, 1920, 1080))
    let checks = 0
    await expect(generateCustomTemplate(
      lctx, { pacing: { durationSec: 8, segments: [{ start: 0, end: 4 }, { start: 4, end: 8 }] }, aspectRatio: 'landscape' },
      { checkComposition: async () => { checks += 1; return false } },
    )).rejects.toThrow(/hyperframes check/)
    expect(checks).toBe(2)
  })
})

describe('createCustomTemplate', () => {
  it('拆解→生成→落库+写模板文件，全链路（mock LLM + 假 probe/detect）', async () => {
    ctx.db.prepare('DELETE FROM custom_templates').run() // 表存在即可，无需预置数据
    const info = await createCustomTemplate(ctx, {
      name: '对标X', aspectRatio: 'portrait', benchmarkAbsPath: '/fake.mp4', benchmarkRelPath: '_templates/x/benchmark.mp4',
    })
    expect(info.name).toBe('对标X')
    const row: any = ctx.db.prepare('SELECT * FROM custom_templates WHERE id = ?').get(info.id)
    expect(row.aspect_ratio).toBe('portrait')
    expect(fs.existsSync(customTemplateHtmlPath(ctx, info.id))).toBe(true)
  })
})
```

- [ ] **Step 5: 跑测试确认失败**

Run: `pnpm --filter @forgecast/studio exec vitest run test/custom-template.test.ts`
Expected: FAIL（`../src/custom-template` 模块不存在）

- [ ] **Step 6: 实现 `custom-template.ts`**

```ts
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { CoreCtx } from '@forgecast/core'
import { analyzeBenchmark, type Pacing, type PacingSegment } from './benchmark'
import { mockCustomTemplateHtml } from './fixtures/custom-template-fixture'
import { fillTemplate, HF_VERSION, scaffoldHfProject, spawnWithTimeout } from './hyperframes'
import type { Cue } from './tts'

export type AspectRatio = 'portrait' | 'landscape'
export const ASPECT_DIMENSIONS: Record<AspectRatio, { width: number; height: number }> = {
  portrait: { width: 1080, height: 1920 },
  landscape: { width: 1920, height: 1080 },
}

export interface CustomTemplateInput { pacing: Pacing; aspectRatio: AspectRatio; styleNote?: string }
export interface CustomTemplateResult { html: string; segmentCount: number }
export interface CustomTemplateDeps { checkComposition?: (dir: string) => Promise<boolean> }

const CHECK_TIMEOUT_MS = 120_000
const MAX_ATTEMPTS = 2

/** 校验产出 HTML 满足占位符契约；返回缺失项描述数组，空数组=合法。 */
export function validateCustomTemplateHtml(html: string, segmentCount: number, width: number, height: number): string[] {
  const errors: string[] = []
  const count = (re: RegExp) => (html.match(re) ?? []).length
  if (count(/\{\{duration\}\}/g) < 1) errors.push('缺少 {{duration}} 占位符')
  if (count(/<!--HF_AUDIO-->/g) !== 1) errors.push('<!--HF_AUDIO--> 标记必须恰好出现一次')
  if (count(/<!--HF_CAPTIONS-->/g) !== 1) errors.push('<!--HF_CAPTIONS--> 标记必须恰好出现一次')
  if (!html.includes(`data-width="${width}"`)) errors.push(`缺少 data-width="${width}"`)
  if (!html.includes(`data-height="${height}"`)) errors.push(`缺少 data-height="${height}"`)
  for (let k = 0; k < segmentCount; k++) {
    if (count(new RegExp(`\\{\\{seg${k}_start\\}\\}`, 'g')) < 1) errors.push(`缺少 {{seg${k}_start}} 占位符`)
    if (count(new RegExp(`\\{\\{seg${k}_dur\\}\\}`, 'g')) < 1) errors.push(`缺少 {{seg${k}_dur}} 占位符`)
    if (count(new RegExp(`\\{\\{seg${k}_text\\}\\}`, 'g')) < 1) errors.push(`缺少 {{seg${k}_text}} 占位符`)
  }
  return errors
}

function fillSampleValues(html: string, segmentCount: number): string {
  const sampleDuration = Math.max(6, segmentCount * 3)
  const each = sampleDuration / segmentCount
  const slots: Record<string, string> = { duration: String(sampleDuration) }
  for (let k = 0; k < segmentCount; k++) {
    slots[`seg${k}_start`] = String(k * each)
    slots[`seg${k}_dur`] = String(each)
    slots[`seg${k}_text`] = '示例文字'
  }
  return fillTemplate(html, slots)
}

async function defaultCheckComposition(dir: string): Promise<boolean> {
  try {
    await spawnWithTimeout(['--yes', `hyperframes@${HF_VERSION}`, 'check', '.', '--json'], { cwd: dir, timeoutMs: CHECK_TIMEOUT_MS, label: 'hyperframes check' })
    return true
  } catch {
    return false
  }
}

function buildPrompt(pacing: Pacing, aspectRatio: AspectRatio, styleNote: string | undefined, priorErrors?: string[]): string {
  const { width, height } = ASPECT_DIMENSIONS[aspectRatio]
  const segCount = pacing.segments.length
  const ratios = pacing.segments.map((s) => (((s.end - s.start) / pacing.durationSec) * 100).toFixed(1))
  const lines = [
    `分段数：${segCount}`,
    `各段时长占比（%，从第0段到第${segCount - 1}段）：${ratios.join(', ')}`,
    `画布尺寸：${width}x${height}（${aspectRatio === 'portrait' ? '竖屏' : '横屏'}）`,
    styleNote ? `风格/调性参考：${styleNote}` : '风格/调性：未提供，自由发挥',
  ]
  if (priorErrors?.length) {
    lines.push(`上一次产出未通过校验，请修正以下问题后重新输出完整 HTML：\n${priorErrors.map((e) => `- ${e}`).join('\n')}`)
  }
  return lines.join('\n')
}

/**
 * 拆解节奏 + 风格描述 → LLM 设计一个新 HyperFrames 模板（mock 走固定 fixture，绝不调 ctx.llm）。
 * 校验两道：①占位符契约 regex ②hyperframes check 结构合法性（仅 live 模式跑，mock fixture 信任合法）。
 * 任一不过重试一次，仍不过抛错不落库。
 */
export async function generateCustomTemplate(
  ctx: CoreCtx, input: CustomTemplateInput, deps: CustomTemplateDeps = {},
): Promise<CustomTemplateResult> {
  const { pacing, aspectRatio, styleNote } = input
  const segmentCount = pacing.segments.length
  const { width, height } = ASPECT_DIMENSIONS[aspectRatio]
  const isMock = ctx.config.llm.mode === 'mock'
  const checkComposition = deps.checkComposition ?? defaultCheckComposition
  const systemPrompt = isMock ? '' : fs.readFileSync(path.join(ctx.config.paths.templates, 'prompts', 'custom-template.md'), 'utf8')

  let priorErrors: string[] | undefined
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const html = isMock
      ? mockCustomTemplateHtml(segmentCount, width, height)
      : await ctx.llm.complete({ model: ctx.config.llm.models.copy, system: systemPrompt, prompt: buildPrompt(pacing, aspectRatio, styleNote, priorErrors) })

    const tokenErrors = validateCustomTemplateHtml(html, segmentCount, width, height)
    if (tokenErrors.length) {
      if (attempt < MAX_ATTEMPTS) { priorErrors = tokenErrors; continue }
      throw new Error(`自定义模板校验失败（占位符契约）：${tokenErrors.join('；')}`)
    }

    if (!isMock) {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-custom-tpl-check-'))
      scaffoldHfProject(tmpDir, fillSampleValues(html, segmentCount))
      const ok = await checkComposition(tmpDir)
      if (!ok) {
        if (attempt < MAX_ATTEMPTS) { priorErrors = ['hyperframes check 未通过（结构不合法，请简化 CSS/避免超出画布）']; continue }
        throw new Error('自定义模板校验失败（hyperframes check 未通过）')
      }
    }
    return { html, segmentCount }
  }
  throw new Error('自定义模板生成失败')
}

/** 自定义模板 HTML 落盘路径（全局共享，不挂项目）：templates/hf/custom/<id>.html */
export function customTemplateHtmlPath(ctx: CoreCtx, id: number): string {
  return path.join(ctx.config.paths.templates, 'hf', 'custom', `${id}.html`)
}

/**
 * 把拆解出的相对节奏（相对对标视频时长的比例）映射到目标（实际配音）时长的绝对秒数窗口。
 * 末段强制对齐 targetDurationSec，消除浮点误差导致的尾部空隙。
 */
export function computeSegmentWindows(segments: PacingSegment[], benchmarkDurationSec: number, targetDurationSec: number): { start: number; end: number }[] {
  if (benchmarkDurationSec <= 0) throw new Error('benchmarkDurationSec 必须大于 0')
  const scale = targetDurationSec / benchmarkDurationSec
  const windows = segments.map((s) => ({ start: s.start * scale, end: s.end * scale }))
  windows[windows.length - 1].end = targetDurationSec
  return windows
}

/** 把 TTS cue 按时间窗口分桶拼成每段的文字；窗口没分到 cue 时回退用邻近 cue（按索引夹取），不留空串。 */
export function bucketCuesBySegments(cues: Cue[], windows: { start: number; end: number }[]): string[] {
  const buckets: string[][] = windows.map(() => [])
  for (const c of cues) {
    const mid = (c.start + c.end) / 2
    let idx = windows.findIndex((w) => mid >= w.start && mid < w.end)
    if (idx === -1) idx = windows.length - 1
    buckets[idx].push(c.text)
  }
  return buckets.map((texts, i) => (texts.length ? texts.join('') : (cues[Math.min(i, cues.length - 1)]?.text ?? '')))
}

export interface CreateCustomTemplateInput {
  name: string; aspectRatio: AspectRatio; styleNote?: string
  benchmarkAbsPath: string; benchmarkRelPath: string
  onProgress?: (msg: string) => void
}
export interface CreateCustomTemplateResult { id: number; name: string }

/** 拆解 → LLM 设计 → 落库 + 写模板文件。失败（拆解本身 fail-soft 不会失败；LLM 校验失败会）直接抛错，不落库。 */
export async function createCustomTemplate(ctx: CoreCtx, input: CreateCustomTemplateInput): Promise<CreateCustomTemplateResult> {
  const { name, aspectRatio, styleNote, benchmarkAbsPath, benchmarkRelPath, onProgress = () => {} } = input
  onProgress('拆解对标视频节奏…')
  const pacing = await analyzeBenchmark(benchmarkAbsPath)
  onProgress(`拆解出 ${pacing.segments.length} 段，设计模板中…`)
  const { html, segmentCount } = await generateCustomTemplate(ctx, { pacing, aspectRatio, styleNote })
  const info = ctx.db.prepare(
    'INSERT INTO custom_templates (name, aspect_ratio, segment_count, style_note, benchmark_path, segments_json) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(name, aspectRatio, segmentCount, styleNote ?? null, benchmarkRelPath, JSON.stringify(pacing))
  const id = Number(info.lastInsertRowid)
  const htmlPath = customTemplateHtmlPath(ctx, id)
  fs.mkdirSync(path.dirname(htmlPath), { recursive: true })
  fs.writeFileSync(htmlPath, html, 'utf8')
  onProgress(`模板「${name}」已生成`)
  return { id, name }
}
```

- [ ] **Step 7: 跑测试确认通过**

Run: `pnpm --filter @forgecast/studio exec vitest run test/custom-template.test.ts`
Expected: PASS（全部用例）

- [ ] **Step 8: 导出 + 全包测试 + 提交**

`packages/studio/src/index.ts` 加一行：

```ts
export * from './custom-template'
```

Run: `pnpm --filter @forgecast/studio test`
Expected: 全绿（含 Task 1）

```bash
git add templates/prompts/custom-template.md packages/studio/src/fixtures/custom-template-fixture.ts \
  packages/studio/src/custom-template.ts packages/studio/test/custom-template.test.ts \
  packages/studio/src/hyperframes.ts packages/studio/src/index.ts
git commit -m "$(cat <<'EOF'
feat(studio): generateCustomTemplate（LLM 设计模板+两道校验）+ createCustomTemplate 落库编排

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Server 路由 `POST/GET/DELETE /api/templates`

**Files:**
- Modify: `packages/server/src/app.ts`
- Create: `packages/server/test/templates.test.ts`

**Interfaces:**
- Consumes: Task 3 的 `createCustomTemplate`/`customTemplateHtmlPath`（经 `@forgecast/studio` 导出）。
- Produces: `POST /api/templates`（multipart：`file`+`aspectRatio`+`name`+可选 `styleNote`）→ `{taskId}`；`GET /api/templates` → 模板元数据数组；`DELETE /api/templates/:id` → `{ok:true}`。Task 6 前端消费这三个路由。

- [ ] **Step 1: 写失败测试**

`packages/server/test/templates.test.ts`：

```ts
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createLlmClient, loadConfig, openDb, type CoreCtx } from '@forgecast/core'
import { beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/app'
import { createTaskQueue } from '../src/tasks'

let ctx: CoreCtx
let app: ReturnType<typeof createApp>
let queue: ReturnType<typeof createTaskQueue>
function wait(ms: number) { return new Promise((r) => setTimeout(r, ms)) }

beforeEach(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-templates-'))
  const config = loadConfig(root, {})
  ctx = { db: openDb(config.paths.db), config, llm: createLlmClient(config.llm) }
  queue = createTaskQueue()
  app = createApp(ctx, queue)
})

async function runTask(taskId: string) {
  for (let i = 0; i < 300; i++) {
    await wait(20)
    const s = queue.get(taskId)!.status
    if (s === 'done') return
    if (s === 'failed') throw new Error(queue.get(taskId)!.events.at(-1)!.message)
  }
  throw new Error('任务超时')
}

function fakeForm(fields: Record<string, string>): FormData {
  const fd = new FormData()
  fd.append('file', new File(['FAKE_MP4_BYTES'], 'benchmark.mp4', { type: 'video/mp4' }))
  for (const [k, v] of Object.entries(fields)) fd.append(k, v)
  return fd
}

describe('模板库路由', () => {
  it('POST /api/templates：缺 file 400', async () => {
    expect((await app.request('/api/templates', { method: 'POST', body: new FormData() })).status).toBe(400)
  })
  it('POST /api/templates：缺 aspectRatio 400', async () => {
    const fd = new FormData()
    fd.append('file', new File(['x'], 'a.mp4', { type: 'video/mp4' }))
    fd.append('name', 't1')
    expect((await app.request('/api/templates', { method: 'POST', body: fd })).status).toBe(400)
  })
  it('POST /api/templates：缺 name 400', async () => {
    expect((await app.request('/api/templates', { method: 'POST', body: fakeForm({ aspectRatio: 'portrait' }) })).status).toBe(400)
  })
  it('坏扩展名 400', async () => {
    const fd = new FormData()
    fd.append('file', new File(['x'], 'a.txt', { type: 'text/plain' }))
    fd.append('aspectRatio', 'portrait')
    fd.append('name', 't1')
    expect((await app.request('/api/templates', { method: 'POST', body: fd })).status).toBe(400)
  })
  it('全链路：上传 → 任务完成 → 落库 + 模板文件写盘（garbage mp4 走 fail-soft 拆解回退）', async () => {
    const { taskId } = await (await app.request('/api/templates', {
      method: 'POST', body: fakeForm({ aspectRatio: 'portrait', name: '对标A' }),
    })).json() as any
    await runTask(taskId)
    const row: any = ctx.db.prepare('SELECT * FROM custom_templates').get()
    expect(row.name).toBe('对标A')
    expect(row.aspect_ratio).toBe('portrait')
    const htmlPath = path.join(ctx.config.paths.templates, 'hf', 'custom', `${row.id}.html`)
    expect(fs.existsSync(htmlPath)).toBe(true)
  })
  it('GET /api/templates：列出已创建模板', async () => {
    const { taskId } = await (await app.request('/api/templates', {
      method: 'POST', body: fakeForm({ aspectRatio: 'landscape', name: '对标B', styleNote: '搞笑' }),
    })).json() as any
    await runTask(taskId)
    const list = await (await app.request('/api/templates')).json() as any[]
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ name: '对标B', aspect_ratio: 'landscape', style_note: '搞笑' })
  })
  it('DELETE /api/templates/:id：删行+删模板文件', async () => {
    const { taskId } = await (await app.request('/api/templates', {
      method: 'POST', body: fakeForm({ aspectRatio: 'portrait', name: '对标C' }),
    })).json() as any
    await runTask(taskId)
    const row: any = ctx.db.prepare('SELECT * FROM custom_templates').get()
    const htmlPath = path.join(ctx.config.paths.templates, 'hf', 'custom', `${row.id}.html`)
    expect((await app.request(`/api/templates/${row.id}`, { method: 'DELETE' })).status).toBe(200)
    expect(ctx.db.prepare('SELECT * FROM custom_templates').get()).toBeUndefined()
    expect(fs.existsSync(htmlPath)).toBe(false)
  })
  it('DELETE 不存在的 id → 404', async () => {
    expect((await app.request('/api/templates/9999', { method: 'DELETE' })).status).toBe(404)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @forgecast/server exec vitest run test/templates.test.ts`
Expected: FAIL（路由不存在，404）

- [ ] **Step 3: 加路由**

`packages/server/src/app.ts`：

顶部 import 区加 `randomUUID`：

```ts
import { randomUUID } from 'node:crypto'
```

（放在现有 `import fs from 'node:fs'` 之前一行即可，任意位置只要在其他 import 之前。）

把 `@forgecast/studio` 的 import 行（现有 `import { analyzeBeats, autoCutPlan, chooseBgmPath, generateRetro, generateVideo, readShots, reviewVideo, synthesizeVoice } from '@forgecast/studio'`）追加 `createCustomTemplate`：

```ts
import { analyzeBeats, autoCutPlan, chooseBgmPath, createCustomTemplate, customTemplateHtmlPath, generateRetro, generateVideo, readShots, reviewVideo, synthesizeVoice } from '@forgecast/studio'
```

在 `upload-video` 路由（`app.post('/api/projects/:slug/upload-video', ...)`定义结束）之后插入三个新路由：

```ts
  app.post('/api/templates', async (c) => {
    const body = await c.req.parseBody()
    const file = body.file
    if (!(file instanceof File)) return c.json({ error: '缺少 file 字段' }, 400)
    const aspectRatio = body.aspectRatio === 'portrait' || body.aspectRatio === 'landscape' ? body.aspectRatio : null
    if (!aspectRatio) return c.json({ error: 'aspectRatio 必须是 portrait 或 landscape' }, 400)
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    if (!name) return c.json({ error: '缺少模板名称' }, 400)
    const safeName = path.basename(file.name)
    if (!/\.(mp4|mov|m4v)$/i.test(safeName)) return c.json({ error: '仅支持 mp4/mov/m4v' }, 400)
    const styleNote = typeof body.styleNote === 'string' && body.styleNote.trim() ? body.styleNote.trim() : undefined

    const dirId = randomUUID()
    const dir = path.join(ctx.config.paths.workspace, '_templates', dirId)
    fs.mkdirSync(dir, { recursive: true })
    const ext = path.extname(safeName) || '.mp4'
    const benchmarkAbsPath = path.join(dir, `benchmark${ext}`)
    fs.writeFileSync(benchmarkAbsPath, Buffer.from(await file.arrayBuffer()))
    const benchmarkRelPath = path.relative(ctx.config.paths.workspace, benchmarkAbsPath)

    const taskId = queue.enqueue((log) => createCustomTemplate(ctx, {
      name, aspectRatio, styleNote, benchmarkAbsPath, benchmarkRelPath, onProgress: log,
    }))
    return c.json({ taskId })
  })

  app.get('/api/templates', (c) => {
    const rows = ctx.db.prepare(
      'SELECT id, name, aspect_ratio, segment_count, style_note, created_at FROM custom_templates ORDER BY id DESC',
    ).all()
    return c.json(rows)
  })

  app.delete('/api/templates/:id', (c) => {
    const id = Number(c.req.param('id'))
    const row: any = ctx.db.prepare('SELECT * FROM custom_templates WHERE id = ?').get(id)
    if (!row) return c.json({ error: '模板不存在' }, 404)
    ctx.db.prepare('DELETE FROM custom_templates WHERE id = ?').run(id)
    const htmlPath = customTemplateHtmlPath(ctx, id)
    if (fs.existsSync(htmlPath)) fs.rmSync(htmlPath)
    if (row.benchmark_path) {
      const benchDir = path.dirname(path.join(ctx.config.paths.workspace, row.benchmark_path))
      if (fs.existsSync(benchDir)) fs.rmSync(benchDir, { recursive: true, force: true })
    }
    return c.json({ ok: true })
  })
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @forgecast/server exec vitest run test/templates.test.ts`
Expected: PASS（全部用例）

- [ ] **Step 5: 全包回归 + 提交**

Run: `pnpm --filter @forgecast/server test`
Expected: 全绿

```bash
git add packages/server/src/app.ts packages/server/test/templates.test.ts
git commit -m "$(cat <<'EOF'
feat(server): POST/GET/DELETE /api/templates（模板库上传拆解+列表+删除）

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: `generate.ts` 接入自定义模板渲染 + tpl 白名单放开

**Files:**
- Modify: `packages/studio/src/generate.ts`
- Modify: `packages/server/src/app.ts`
- Modify: `packages/studio/test/generate.test.ts`

**Interfaces:**
- Consumes: Task 3 的 `computeSegmentWindows`/`bucketCuesBySegments`/`customTemplateHtmlPath`/`Pacing`；`custom_templates` 表（Task 2）。
- Produces: `generateVideo` 新增对 `tpl` 形如 `custom-<id>` 的支持；`GenerateVideoInput.tpl` 类型从固定联合类型放宽为 `string`。Task 6 前端会传 `tpl=custom-<id>`。

- [ ] **Step 1: 写失败测试**

`packages/studio/test/generate.test.ts` 顶部 import 区追加：

```ts
import { mockCustomTemplateHtml } from '../src/fixtures/custom-template-fixture'
```

文件末尾（现有 `describe` 块之后）追加：

```ts
describe('generateVideo 自定义模板（stub）', () => {
  it('tpl=custom-<id> 走自定义模板分支，按拆解节奏比例填满全部占位符', async () => {
    const config = loadConfig(root, { FORGECAST_VIDEO_MODE: 'stub', FORGECAST_TTS_MODE: 'stub' })
    const cctx: CoreCtx = { db: ctx.db, config, llm: ctx.llm }
    const pacing = { durationSec: 12, segments: [{ start: 0, end: 4 }, { start: 4, end: 8 }, { start: 8, end: 12 }] }
    const info = cctx.db.prepare(
      "INSERT INTO custom_templates (name, aspect_ratio, segment_count, segments_json) VALUES ('对标A', 'portrait', 3, ?)",
    ).run(JSON.stringify(pacing))
    const id = Number(info.lastInsertRowid)
    const htmlDir = path.join(cctx.config.paths.templates, 'hf', 'custom')
    fs.mkdirSync(htmlDir, { recursive: true })
    fs.writeFileSync(path.join(htmlDir, `${id}.html`), mockCustomTemplateHtml(3, 1080, 1920), 'utf8')

    const out = await generateVideo(cctx, { slug: 'demo', tpl: `custom-${id}` })
    expect(out.filePath).toMatch(new RegExp(`demo/videos/custom-${id}-.*\\.mp4$`))
    const html = fs.readFileSync(path.join(cctx.config.paths.workspace, 'demo', 'hf', 'index.html'), 'utf8')
    expect(html).toContain('data-width="1080"')
    expect(html).not.toMatch(/\{\{seg\d_(start|dur|text)\}\}/)
    expect(html).toContain('data-start="0"')
    const row: any = ctx.db.prepare('SELECT * FROM assets WHERE id = ?').get(out.assetId)
    expect(row.type).toBe('video')
  })

  it('自定义模板 id 不存在 → 抛错', async () => {
    const config = loadConfig(root, { FORGECAST_VIDEO_MODE: 'stub', FORGECAST_TTS_MODE: 'stub' })
    const cctx: CoreCtx = { db: ctx.db, config, llm: ctx.llm }
    await expect(generateVideo(cctx, { slug: 'demo', tpl: 'custom-9999' })).rejects.toThrow('自定义模板不存在')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @forgecast/studio exec vitest run test/generate.test.ts`
Expected: FAIL（`custom-<id>` 分支不存在，走了 flash 回落逻辑或报错）

- [ ] **Step 3: 实现 generate.ts 分支**

`packages/studio/src/generate.ts`：

`GenerateVideoInput` 接口的 `tpl` 字段类型放宽：

```ts
export interface GenerateVideoInput {
  slug: string
  assetId?: number
  tpl?: string
```

（原来是 `tpl?: 'flash' | 'story' | 'demo' | 'changelog' | 'insight'`，直接替换成 `tpl?: string`。）

顶部 import 区追加：

```ts
import { bucketCuesBySegments, computeSegmentWindows, customTemplateHtmlPath } from './custom-template'
import type { Pacing } from './benchmark'
```

（`Pacing` 定义在 `benchmark.ts`，`custom-template.ts` 只是内部消费它、不重新导出——两处分开 import，不要从 `./custom-template` 导 `Pacing`，那里没有这个导出。）

在 `generateVideo` 函数内、`const brandName = project.brand_name ?? slug` 之后、`if (tpl === 'changelog') {` 之前插入新分支：

```ts
  if (tpl.startsWith('custom-')) {
    const id = Number(tpl.slice('custom-'.length))
    if (!Number.isFinite(id)) throw new Error(`非法自定义模板标识: ${tpl}`)
    const row: any = ctx.db.prepare('SELECT * FROM custom_templates WHERE id = ?').get(id)
    if (!row) throw new Error(`自定义模板不存在: ${tpl}`)
    return renderCustomTemplate(ctx, row, { slug, doc, hook: copy.hook, projectId: project.id, video, onProgress })
  }
```

在文件末尾（`renderAndRegister` 函数定义之后）追加新函数：

```ts
/** 自定义模板渲染：TTS→BGM 流程与 flash 一致，差异只在按拆解节奏比例填 N 个动态分段占位符。 */
async function renderCustomTemplate(
  ctx: CoreCtx, row: any,
  opts: { slug: string; doc: ReturnType<typeof parseCopyOutput>; hook: string; projectId: number; video: VideoCfg; onProgress: (m: string) => void },
): Promise<GeneratedVideo> {
  const { slug, doc, hook, projectId, video, onProgress } = opts
  const hfDir = path.join(ctx.config.paths.workspace, slug, 'hf')
  onProgress('TTS 配音…')
  const wavAbs = path.join(hfDir, 'assets', 'narration.wav')
  const voice = await synthesizeVoice(ctx, doc.douyinScript, wavAbs)
  if (voice.degraded) onProgress(`⚠ TTS 降级：${voice.degraded}`)
  const lastEnd = voice.cues.length ? voice.cues[voice.cues.length - 1].end : 0
  const duration = Math.max(6, Math.ceil(lastEnd))
  const { audioMix } = await selectBgm(ctx, video, duration, onProgress, hook)

  const pacing: Pacing = JSON.parse(row.segments_json)
  const windows = computeSegmentWindows(pacing.segments, pacing.durationSec, duration)
  const texts = bucketCuesBySegments(voice.cues, windows)
  const rawHtml = fs.readFileSync(customTemplateHtmlPath(ctx, row.id), 'utf8')
  const slots: Record<string, string> = { duration: String(duration) }
  windows.forEach((w, i) => {
    slots[`seg${i}_start`] = String(w.start)
    slots[`seg${i}_dur`] = String(Math.max(0.5, w.end - w.start))
    slots[`seg${i}_text`] = texts[i] ?? ''
  })
  let html = fillTemplate(rawHtml, slots)
  html = injectAudioCaptions(html, voice.audioRel, voice.cues, duration, video.captions)
  scaffoldHfProject(hfDir, html)
  return renderAndRegister(ctx, hfDir, slug, `custom-${row.id}`, hook, projectId, onProgress, audioMix)
}
```

- [ ] **Step 4: 放开 server tpl 白名单**

`packages/server/src/app.ts`：`app.post('/api/projects/:slug/video', ...)` 路由内，把

```ts
    const tpl = ['story', 'demo', 'changelog', 'insight'].includes(body.tpl) ? body.tpl : 'flash'
```

改成：

```ts
    const tpl = ['story', 'demo', 'changelog', 'insight'].includes(body.tpl) || /^custom-\d+$/.test(body.tpl)
      ? body.tpl : 'flash'
```

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm --filter @forgecast/studio exec vitest run test/generate.test.ts`
Expected: PASS（全部用例，含既有 flash/story/demo/changelog/insight 不受影响）

- [ ] **Step 6: 全包回归 + 提交**

Run: `pnpm --filter @forgecast/studio test && pnpm --filter @forgecast/server test`
Expected: 全绿

```bash
git add packages/studio/src/generate.ts packages/server/src/app.ts packages/studio/test/generate.test.ts
git commit -m "$(cat <<'EOF'
feat(studio,server): generateVideo 接入自定义模板渲染（tpl=custom-<id>）

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Web「模板库」tab + 「出视频」下拉框合并

**Files:**
- Modify: `apps/web/src/api.ts`
- Create: `apps/web/src/pages/workshop/TemplatesTab.tsx`
- Modify: `apps/web/src/pages/WorkshopPage.tsx`
- Modify: `apps/web/src/pages/workshop/VideoTab.tsx`

**Interfaces:**
- Consumes: Task 4 的三个路由。
- Produces: 「做内容」页新增「模板库」tab；「出视频」tab 模板下拉框合并展示内置+自定义模板。无自动化测试（前端惯例），走 `tsc --noEmit` + 人工点击验证。

- [ ] **Step 1: `api.ts` 加类型**

`apps/web/src/api.ts` 追加（放在 `BgmList` 接口附近即可）：

```ts
export interface CustomTemplate {
  id: number; name: string; aspect_ratio: 'portrait' | 'landscape'
  segment_count: number; style_note: string | null; created_at: string
}
```

- [ ] **Step 2: `TemplatesTab.tsx`**

`apps/web/src/pages/workshop/TemplatesTab.tsx`：

```tsx
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useRef, useState } from 'react'
import { api, subscribeTask, type CustomTemplate } from '../../api'

/** 模板库 tab：上传对标视频 → 拆解节奏 → LLM 设计模板 → 落库；列表展示已有自定义模板。 */
export default function TemplatesTab() {
  const qc = useQueryClient()
  const fileRef = useRef<HTMLInputElement>(null)
  const [aspectRatio, setAspectRatio] = useState<'portrait' | 'landscape'>('portrait')
  const [name, setName] = useState('')
  const [styleNote, setStyleNote] = useState('')
  const [running, setRunning] = useState(false)
  const [logs, setLogs] = useState<string[]>([])

  const templates = useQuery({ queryKey: ['templates'], queryFn: () => api<CustomTemplate[]>('/api/templates') })

  async function upload(file: File) {
    if (!name.trim()) { alert('请先填模板名称'); return }
    setRunning(true)
    setLogs([])
    try {
      const fd = new FormData()
      fd.append('file', file)
      fd.append('aspectRatio', aspectRatio)
      fd.append('name', name.trim())
      if (styleNote.trim()) fd.append('styleNote', styleNote.trim())
      const res = await fetch('/api/templates', { method: 'POST', body: fd })
      if (!res.ok) { setLogs((l) => [...l, `上传失败: ${await res.text()}`]); return }
      const { taskId } = await res.json() as { taskId: string }
      await new Promise<void>((resolve) => {
        subscribeTask(taskId, (e) => {
          setLogs((l) => [...l, e.message])
          if (e.type === 'done' || e.type === 'error') resolve()
        })
      })
      qc.invalidateQueries({ queryKey: ['templates'] })
      setName('')
      setStyleNote('')
    } finally {
      setRunning(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  async function remove(id: number) {
    if (!confirm('删除这个模板？已渲染过的视频不受影响。')) return
    await fetch(`/api/templates/${id}`, { method: 'DELETE' })
    qc.invalidateQueries({ queryKey: ['templates'] })
  }

  return (
    <div className="space-y-4">
      <div className="card-forge space-y-3 p-4">
        <h3 className="text-sm font-semibold">上传对标视频，拆解节奏生成新模板</h3>
        <input className="w-full rounded-md border-[1.5px] border-ink bg-card p-2 text-sm" placeholder="模板名称"
          value={name} onChange={(e) => setName(e.target.value)} disabled={running} />
        <div className="flex items-center gap-4 text-sm">
          <label className="flex items-center gap-1">
            <input type="radio" checked={aspectRatio === 'portrait'} onChange={() => setAspectRatio('portrait')} disabled={running} /> 竖屏 9:16
          </label>
          <label className="flex items-center gap-1">
            <input type="radio" checked={aspectRatio === 'landscape'} onChange={() => setAspectRatio('landscape')} disabled={running} /> 横屏 16:9
          </label>
        </div>
        <textarea className="w-full rounded-md border-[1.5px] border-ink bg-card p-2 text-sm" placeholder="风格/调性描述（选填，如：科技感、搞笑、严肃商务）"
          value={styleNote} onChange={(e) => setStyleNote(e.target.value)} disabled={running} rows={2} />
        <input ref={fileRef} type="file" accept=".mp4,.mov,.m4v" className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f) }} />
        <button className="btn-fire px-4 py-2 disabled:opacity-50" disabled={running}
          onClick={() => fileRef.current?.click()}>
          {running ? '拆解生成中…' : '上传对标视频（mp4/mov）'}
        </button>
        {logs.length > 0 && (
          <div className="max-h-32 overflow-y-auto rounded-md bg-ink/5 p-2 text-xs text-sub">
            {logs.map((l, i) => <div key={i}>{l}</div>)}
          </div>
        )}
      </div>
      <div className="grid grid-cols-3 gap-3">
        {templates.data?.map((t) => (
          <div key={t.id} className="card-forge space-y-1 p-3 text-sm">
            <div className="font-semibold">{t.name}</div>
            <div className="text-xs text-sub">{t.aspect_ratio === 'portrait' ? '竖屏' : '横屏'} · {t.segment_count} 段</div>
            {t.style_note && <div className="text-xs text-faint">{t.style_note}</div>}
            <button className="btn-ink mt-1 px-2 py-1 text-xs" onClick={() => remove(t.id)}>删除</button>
          </div>
        ))}
        {templates.data?.length === 0 && <p className="col-span-3 text-sm text-faint">还没有自定义模板，上传一条对标视频生成第一个。</p>}
      </div>
    </div>
  )
}
```

- [ ] **Step 3: `WorkshopPage.tsx` 接入 tab**

`apps/web/src/pages/WorkshopPage.tsx`：

`TABS` 常量追加一项（放在数组最后）：

```ts
const TABS = [
  { key: 'copy', label: '文案' },
  { key: 'script', label: '拍摄脚本' },
  { key: 'upload', label: '成片' },
  { key: 'video', label: '出视频' },
  { key: 'cut', label: '卡点' },
  { key: 'templates', label: '模板库' },
] as const
```

`normalizeTab` 函数放行新 key：

```ts
function normalizeTab(v: string | null): TabKey {
  return v === 'script' || v === 'upload' || v === 'video' || v === 'cut' || v === 'templates' ? v : 'copy'
}
```

顶部 import 区追加：

```ts
import TemplatesTab from './workshop/TemplatesTab'
```

找到渲染各 tab 内容的 JSX 分支（`{tab === 'cut' && <CutPlanEditor ... />}` 之类的位置），追加一支：

```tsx
{tab === 'templates' && <TemplatesTab />}
```

- [ ] **Step 4: `VideoTab.tsx` 合并下拉框**

`apps/web/src/pages/workshop/VideoTab.tsx`：

顶部 import 追加：

```tsx
import { useQuery } from '@tanstack/react-query'
import { api, type CustomTemplate } from '../../api'
```

`VIDEO_TPLS` 常量名不变（内置 5 个模板保留原样，作为渲染函数内部的基础列表），在 `VideoTab` 函数体最开始（`const chosenId = ...` 之前）加：

```tsx
  const templates = useQuery({ queryKey: ['templates'], queryFn: () => api<CustomTemplate[]>('/api/templates') })
  const tplOptions = [
    ...VIDEO_TPLS,
    ...(templates.data ?? []).map((t) => ({ value: `custom-${t.id}`, label: `${t.name}（对标拆解 · ${t.aspect_ratio === 'portrait' ? '竖屏' : '横屏'}）` })),
  ]
```

模板下拉框的 `<select>` 内部 `{VIDEO_TPLS.map(...)}` 改成 `{tplOptions.map(...)}`：

```tsx
        <div>
          <label className="text-sm text-sub">模板</label>
          <select className="mt-1 w-full rounded-md border-[1.5px] border-ink bg-card p-2 text-sm"
            value={vp.tpl} onChange={(e) => setVp({ ...vp, tpl: e.target.value })}>
            {tplOptions.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
          {vp.tpl === 'demo' && <p className="mt-1 text-xs text-faint">需先在项目详情页上传 shots/ 截图</p>}
        </div>
```

- [ ] **Step 5: 类型检查**

Run: `export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH" && pnpm --filter web exec tsc --noEmit`
Expected: 无报错

- [ ] **Step 6: 人工验证**

1. 重启 dev server：`pnpm dev`（或按项目既有重启方式，涉及 server 代码改动过需要重启才生效）。
2. 浏览器打开做内容页 → 「模板库」tab → 填模板名 + 选竖屏/横屏 + 上传一条 mp4（本地随便找一条短视频）→ 观察日志走完，列表出现新卡片。
3. 切到「出视频」tab → 模板下拉框能看到刚生成的自定义模板（带"对标拆解"标注）→ 选中它 → 点生成 → 确认渲染出的 mp4 能播放、画面按分段切换、旁白配音正常。
4. 回「模板库」tab 点删除 → 确认卡片消失、「出视频」下拉框里也不再出现。

- [ ] **Step 7: 提交**

```bash
git add apps/web/src/api.ts apps/web/src/pages/workshop/TemplatesTab.tsx \
  apps/web/src/pages/WorkshopPage.tsx apps/web/src/pages/workshop/VideoTab.tsx
git commit -m "$(cat <<'EOF'
feat(web): 做内容页新增「模板库」tab，出视频下拉框合并展示自定义模板

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

## 验证（全部任务完成后）

1. `export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH"`
2. `pnpm test` 全仓回归
3. `pnpm --filter web exec tsc --noEmit` + `pnpm --filter web build`
4. 浏览器端到端：Task 6 Step 6 的四步人工验证走一遍
