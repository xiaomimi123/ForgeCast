# 卡点编辑界面 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** demo 视频的截图轮播卡点抽成可编辑的 `cutplan.json`，Web 面板改（每几拍/偏移/挪刀/换图）→ 保存 → 渲染按方案来；无方案则完全同现在。

**Architecture:** 纯逻辑层 `autoCutPlan`/`planCutTimes` 生成/解析方案；`buildDemoSections` 加可选 `plan` 参消费；`generate` demo 分支查 `cutplan.json` 有则钉曲+用方案；server 加 4 个 REST；web 加 `CutPlanEditor`。全程 fail-soft，无方案向后兼容。

**Tech Stack:** TypeScript + pnpm monorepo + vitest + Hono(server) + Vite/React/react-query(web)。

## Global Constraints

- 只做 demo 模板。方案存 `workspace/<slug>/cutplan.json`（文件，非 DB）。
- 某刀时间 = `grid.t0 + offsetSec + beat × grid.T`。轮播窗口 `[6, durationSec-6]`（`carStart=6`，`carEnd=Math.max(7, durationSec-6)`）。
- 无 `cutplan.json` → 渲染完全同现在（selectBgm 情绪选曲 + 自动 cadence）。向后兼容不可回归。
- 方案 `grid` 存完整分析结果（含 `strongBeats`/`duration`），渲染钉曲后**不重跑 librosa**（分析已在编辑时做过）。
- fail-soft：方案曲失效/字段缺 → 降级为无方案 + onProgress ⚠；`shot` 越界钳到 `[0, shotCount-1]`。
- 中文注释、中文提交、严格 TDD、频繁提交。
- 分析卡点依赖 `FORGECAST_BEAT_PYTHON`（librosa，同现有卡点渲染）；缺失时 analyze 接口报错、面板提示。

---

### Task 1: 卡点方案纯逻辑 autoCutPlan + planCutTimes

**Files:**
- Modify: `packages/studio/src/hyperframes.ts`
- Test: `packages/studio/test/hyperframes.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `autoCutPlan(grid: { t0: number; T: number }, shotCount: number, durationSec: number, cadence: number): Array<{ beat: number; shot: number }>`
  - `planCutTimes(plan: { grid: { t0: number; T: number }; offsetSec: number; cuts: Array<{ beat: number; shot: number }> }, shotCount: number): Array<{ start: number; shot: number }>`

- [ ] **Step 1: 写失败测试**

追加到 `packages/studio/test/hyperframes.test.ts`（导入处补 `autoCutPlan, planCutTimes`）：

```typescript
describe('autoCutPlan 自动卡点方案', () => {
  const grid = { t0: 0, T: 0.5 } // 拍在 0,0.5,1,...
  it('每 cadence 拍一刀，图循环 k%shotCount', () => {
    // duration=30 → 窗口 [6,24)；cadence=4 → beat 12,16,20,...(t0=0 时 beat=时间/0.5)
    const cuts = autoCutPlan(grid, 2, 30, 4)
    expect(cuts[0].beat).toBe(12)          // 6s / 0.5 = 12
    expect(cuts[1].beat).toBe(16)          // +4 拍
    expect(cuts[0].shot).toBe(0); expect(cuts[1].shot).toBe(1); expect(cuts[2].shot).toBe(0) // 循环
    // 都 < 窗口末 24s → beat < 48
    expect(cuts.every((c) => c.beat < 48)).toBe(true)
  })
  it('cadence=2 更密', () => {
    expect(autoCutPlan(grid, 3, 30, 2).length).toBeGreaterThan(autoCutPlan(grid, 3, 30, 4).length)
  })
  it('shotCount<=0 返空', () => {
    expect(autoCutPlan(grid, 0, 30, 4)).toEqual([])
  })
})

describe('planCutTimes 方案→时间', () => {
  const plan = { grid: { t0: 0.5, T: 0.5 }, offsetSec: 0, cuts: [{ beat: 12, shot: 0 }, { beat: 16, shot: 5 }] }
  it('beat+offset+grid 算时间，shot 越界钳制，升序', () => {
    const t = planCutTimes(plan, 3)
    expect(t[0].start).toBeCloseTo(0.5 + 12 * 0.5, 5)   // 6.5
    expect(t[1].start).toBeCloseTo(0.5 + 16 * 0.5, 5)   // 8.5
    expect(t[1].shot).toBe(2)                            // 5 钳到 shotCount-1=2
  })
  it('offsetSec 平移所有刀', () => {
    const t = planCutTimes({ ...plan, offsetSec: 0.2 }, 3)
    expect(t[0].start).toBeCloseTo(6.7, 5)
  })
  it('shotCount<=0 返空', () => {
    expect(planCutTimes(plan, 0)).toEqual([])
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @forgecast/studio test hyperframes`（若 pnpm 不在 PATH：`corepack pnpm ...`）
Expected: FAIL —— `autoCutPlan`/`planCutTimes` 未导出。

- [ ] **Step 3: 实现**

`packages/studio/src/hyperframes.ts`，加在 `buildDemoSections` 之前：

```typescript
/** 自动卡点方案：轮播窗口 [6, durationSec-6) 内每隔 cadence 拍取一刀，beat=拍序号，shot=k%shotCount。 */
export function autoCutPlan(grid: { t0: number; T: number }, shotCount: number, durationSec: number, cadence: number): Array<{ beat: number; shot: number }> {
  if (shotCount <= 0 || !(grid.T > 0)) return []
  const carStart = 6, carEnd = Math.max(7, durationSec - 6)
  const nStart = Math.max(0, Math.ceil((carStart - grid.t0) / grid.T - 1e-9))
  const cuts: Array<{ beat: number; shot: number }> = []
  let k = 0
  for (let n = nStart; grid.t0 + n * grid.T < carEnd; n += cadence) {
    cuts.push({ beat: n, shot: k % shotCount }); k++
  }
  return cuts
}

/** 方案每刀 → 时间：start = t0 + offsetSec + beat×T；shot 钳到 [0,shotCount-1]；按 start 升序。 */
export function planCutTimes(plan: { grid: { t0: number; T: number }; offsetSec: number; cuts: Array<{ beat: number; shot: number }> }, shotCount: number): Array<{ start: number; shot: number }> {
  if (shotCount <= 0) return []
  return plan.cuts
    .map((c) => ({ start: plan.grid.t0 + plan.offsetSec + c.beat * plan.grid.T, shot: Math.max(0, Math.min(shotCount - 1, c.shot)) }))
    .sort((a, b) => a.start - b.start)
}
```

- [ ] **Step 4: 跑测试 + tsc**

Run: `pnpm --filter @forgecast/studio test hyperframes`、`npx tsc -p packages/studio/tsconfig.json --noEmit`
Expected: 全绿、tsc 无输出。

- [ ] **Step 5: 提交**

```bash
git add packages/studio
git commit -m "feat(studio): 卡点方案纯逻辑 autoCutPlan + planCutTimes"
```

---

### Task 2: buildDemoSections 消费方案 cuts

**Files:**
- Modify: `packages/studio/src/hyperframes.ts`（`buildDemoSections` 加 `plan` 参）
- Test: `packages/studio/test/hyperframes.test.ts`

**Interfaces:**
- Consumes: 无（`buildDemoSections` 已存在，返回 `{ html, accents }`）
- Produces:
  - `buildDemoSections` opts 加可选 `plan?: { cuts: Array<{ start: number; shot: number }> }`——给了且 `cuts.length` 则用方案 cuts（时间 + 配图 index，过滤掉 `start >= carEnd` 的），否则走现有自动 cadence。

- [ ] **Step 1: 写失败测试**

追加到 `packages/studio/test/hyperframes.test.ts`（`buildDemoSections` 已导入）：

```typescript
describe('buildDemoSections 消费卡点方案', () => {
  const base = {
    hookTitle: '钩子', painPoints: ['痛1'], priceAnchor: '¥99', cta: '扣1', brandName: 'demo',
    shots: [{ rel: '01.png', orientation: 'portrait' as const }, { rel: '02.png', orientation: 'landscape' as const }],
  }
  it('给 plan 用方案 cuts（时间+配图），不再自动 cadence', () => {
    // 方案：两刀 8s(图1)、12s(图0)
    const r = buildDemoSections({ ...base, durationSec: 30, plan: { cuts: [{ start: 8, shot: 1 }, { start: 12, shot: 0 }] } })
    // car0 落在 8s、car1 落在 12s
    expect(r.html).toMatch(/id="car0" data-start="8/)
    expect(r.html).toMatch(/id="car1" data-start="12/)
    // 每刀一条图片弹跳
    expect(r.accents).toContain('tl.to("#car0"'); expect(r.accents).toContain('tl.to("#car1"')
  })
  it('plan cuts 超过窗口末(carEnd=dur-6)的被过滤', () => {
    // dur=30 → carEnd=24；一刀在 26s 应被丢
    const r = buildDemoSections({ ...base, durationSec: 30, plan: { cuts: [{ start: 8, shot: 0 }, { start: 26, shot: 1 }] } })
    expect((r.html.match(/id="car\d+"/g) || []).length).toBe(1)
  })
  it('不传 plan 行为不变（回归：无 beats 按图数均分）', () => {
    const r = buildDemoSections({ ...base, durationSec: 30 })
    expect((r.html.match(/id="car\d+"/g) || []).length).toBe(base.shots.length)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @forgecast/studio test hyperframes`
Expected: FAIL —— `plan` 参未实现（方案 cuts 未生效）。

- [ ] **Step 3: 实现**

`packages/studio/src/hyperframes.ts` 的 `buildDemoSections`：
1. opts 类型加 `plan?: { cuts: Array<{ start: number; shot: number }> }`，解构里加 `plan`。
2. 在 `const carStart = 6, carEnd = ...` 之后、`const hasBeats = ...` 之前，插入方案分支——**若有 plan 且 cuts 非空**，直接据 plan 构 `carClips` 并跳过自动 cutStarts 计算：

```typescript
  const { hookTitle, painPoints, priceAnchor, cta, brandName, shots, durationSec, beats, plan } = opts
  // ...（clip / carStart / carEnd 不变）...
  let carClips: Array<{ id: string; start: number; dur: number; shot: Shot }>
  if (plan && plan.cuts.length) {
    // 方案模式：用方案 cuts（过滤超出窗口末的），时长到下一刀/carEnd
    const pc = plan.cuts.filter((c) => c.start < carEnd).sort((a, b) => a.start - b.start)
    carClips = pc.map((c, k) => ({
      id: `car${k}`, start: c.start, dur: (pc[k + 1]?.start ?? carEnd) - c.start,
      shot: shots[Math.max(0, Math.min(shots.length - 1, c.shot))],
    }))
  } else {
    // 自动模式（现有逻辑）：每 4 拍一刀 / 图数均分
    const hasBeats = !!(beats && beats.length)
    let cutStarts: number[] = []
    if (hasBeats) {
      const win = beats!.filter((b) => b >= carStart && b < carEnd)
      cutStarts = win.filter((_, i) => i % 4 === 0)
    }
    if (cutStarts.length < 2) {
      const per = shots.length ? (carEnd - carStart) / shots.length : 0
      cutStarts = shots.map((_, i) => carStart + i * per)
    }
    carClips = cutStarts.map((start, k) => ({
      id: `car${k}`, start, dur: (cutStarts[k + 1] ?? carEnd) - start, shot: shots[k % shots.length],
    }))
  }
```

（下方 `painHtml` / `segs` / `snapStarts` / `shotBody` / `carHtml` / `html` / `accents` 全部不变——它们只依赖 `carClips`。）

- [ ] **Step 4: 跑测试 + tsc**

Run: `pnpm --filter @forgecast/studio test hyperframes`、`npx tsc -p packages/studio/tsconfig.json --noEmit`
Expected: 全绿（含既有 demo 轮播测试仍绿）。

- [ ] **Step 5: 提交**

```bash
git add packages/studio
git commit -m "feat(studio): buildDemoSections 消费卡点方案 cuts（有 plan 用方案，无则自动）"
```

---

### Task 3: generate demo 消费 cutplan.json

**Files:**
- Modify: `packages/studio/src/generate.ts`（demo 分支）
- Test: `packages/studio/test/generate.test.ts`

**Interfaces:**
- Consumes: `planCutTimes`(Task1)、`buildDemoSections` plan 参(Task2)、`pickBgm`(已有)
- Produces: 无（内部行为）

- [ ] **Step 1: 写失败测试**

追加到 `packages/studio/test/generate.test.ts` 的 demo describe 块内（`generateVideo demo (HyperFrames stub)`）。前置：stub 模式、放两张 shots、写一个 `cutplan.json`：

```typescript
  it('有 cutplan.json：按方案渲染（钉曲 + 方案 cuts），不重跑选曲', async () => {
    const shotsDir = path.join(root, 'workspace/demo/shots')
    fs.mkdirSync(shotsDir, { recursive: true })
    fs.writeFileSync(path.join(shotsDir, '01.png'), pngOf(1080, 1920))
    fs.writeFileSync(path.join(shotsDir, '02.png'), pngOf(1080, 1920))
    // 曲库放一首 tense 曲 + 写方案钉住它
    const bgmDir = path.join(root, 'templates/bgm/tense'); fs.mkdirSync(bgmDir, { recursive: true })
    fs.writeFileSync(path.join(bgmDir, 'x.mp3'), 'fake')
    fs.writeFileSync(path.join(root, 'workspace/demo/cutplan.json'), JSON.stringify({
      bgm: 'tense/x.mp3', grid: { t0: 0, T: 0.5, bpm: 120, strongBeats: [], duration: 24 },
      cadence: 4, offsetSec: 0, cuts: [{ beat: 16, shot: 0 }, { beat: 20, shot: 1 }],
    }))
    const config = loadConfig(root, { FORGECAST_VIDEO_MODE: 'stub', FORGECAST_TTS_MODE: 'stub' })
    const dctx: CoreCtx = { db: ctx.db, config, llm: ctx.llm }
    const r = await generateVideo(dctx, { slug: 'demo', tpl: 'demo', onProgress: () => {} })
    expect(r.filePath).toContain('demo-')
    const html = fs.readFileSync(path.join(dctx.config.paths.workspace, 'demo', 'hf', 'index.html'), 'utf8')
    // 方案 cuts：16 拍 ×0.5 = 8s、20 拍 = 10s
    expect(html).toMatch(/id="car0" data-start="8/)
    expect(html).toMatch(/id="car1" data-start="10/)
  })
  it('cutplan.json 曲子不存在 → 降级自动（不崩）', async () => {
    const shotsDir = path.join(root, 'workspace/demo/shots'); fs.mkdirSync(shotsDir, { recursive: true })
    fs.writeFileSync(path.join(shotsDir, '01.png'), pngOf(1080, 1920))
    fs.writeFileSync(path.join(root, 'workspace/demo/cutplan.json'), JSON.stringify({
      bgm: 'tense/missing.mp3', grid: { t0: 0, T: 0.5, bpm: 120, strongBeats: [], duration: 24 }, cadence: 4, offsetSec: 0, cuts: [{ beat: 16, shot: 0 }],
    }))
    const config = loadConfig(root, { FORGECAST_VIDEO_MODE: 'stub', FORGECAST_TTS_MODE: 'stub' })
    const dctx: CoreCtx = { db: ctx.db, config, llm: ctx.llm }
    const r = await generateVideo(dctx, { slug: 'demo', tpl: 'demo', onProgress: () => {} })
    expect(r.filePath).toContain('demo-') // 仍出片
  })
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @forgecast/studio test generate`
Expected: FAIL —— 方案未被消费（car0 时间不是 8s）。

- [ ] **Step 3: 实现**

`packages/studio/src/generate.ts` 顶部 import 补 `planCutTimes`（与 `buildDemoSections` 同 import 追加）。demo 分支里，把 `const { grid, audioMix } = await selectBgm(ctx, duration, onProgress, copy.hook)` 这一行替换为下面这段（注意：`demoPlan` 的构造在 `mode!=='stub'` gate **之外**——cuts 只影响 HTML、不 spawn，这样 stub 测试也能验证方案 cuts 进 HTML；只有真混音 `audioMix` 在 gate 内）：

```typescript
    // 有 cutplan.json 则按方案渲染（钉曲 + 方案 cuts，不重跑选曲/分析）；否则自动
    const planPath = path.join(ctx.config.paths.workspace, slug, 'cutplan.json')
    let cutPlan: any = null
    if (fs.existsSync(planPath)) { try { cutPlan = JSON.parse(fs.readFileSync(planPath, 'utf8')) } catch { cutPlan = null } }
    let grid: import('./hyperframes').BeatGrid | null = null
    let audioMix: { bgmPath: string; sfxPath: string | null; strongBeats: number[]; durationSec: number } | undefined
    let demoPlan: { cuts: Array<{ start: number; shot: number }> } | undefined
    if (cutPlan?.bgm && cutPlan?.grid && fs.existsSync(path.join(ctx.config.paths.templates, 'bgm', cutPlan.bgm))) {
      grid = cutPlan.grid
      demoPlan = { cuts: planCutTimes(cutPlan, shots.length) }
      if (ctx.config.video.mode !== 'stub') {
        const bgmAbs = path.join(ctx.config.paths.templates, 'bgm', cutPlan.bgm)
        const sfxPath = pickBgm(path.join(ctx.config.paths.templates, 'sfx'))
        audioMix = { bgmPath: bgmAbs, sfxPath, strongBeats: cutPlan.grid.strongBeats ?? [], durationSec: duration }
      }
    } else {
      if (cutPlan?.bgm) onProgress('⚠ 卡点方案曲子不存在，改用自动卡点')
      const sel = await selectBgm(ctx, duration, onProgress, copy.hook)
      grid = sel.grid; audioMix = sel.audioMix
    }
```

然后把紧接着的 `const demo = buildDemoSections({ ...s, shots, durationSec: duration, beats: grid ? gridBeats(grid, duration) : undefined })` 改为（无方案才传 beats 走自动，有方案传 plan）：

```typescript
    const demo = buildDemoSections({ ...s, shots, durationSec: duration, beats: (!demoPlan && grid) ? gridBeats(grid, duration) : undefined, plan: demoPlan })
```

- [ ] **Step 4: 跑测试 + tsc**

Run: `pnpm --filter @forgecast/studio test`、`npx tsc -p packages/studio/tsconfig.json --noEmit`
Expected: 全绿。既有「无 BGM 曲库正常出片」「stub 不跑 librosa」仍绿（无 cutplan.json → else 分支）。

- [ ] **Step 5: 提交**

```bash
git add packages/studio
git commit -m "feat(studio): generate demo 消费 cutplan.json（有方案钉曲+方案cuts，无则自动）"
```

---

### Task 4: 后端 4 个 cutplan REST

**Files:**
- Modify: `packages/server/src/app.ts`（加 4 路由）
- Test: `packages/server/test/cutplan.test.ts`（新建）

**Interfaces:**
- Consumes: `chooseBgmPath`/`analyzeBeats`/`autoCutPlan`/`readShots`（`@forgecast/studio` 导出）
- Produces: REST `POST …/cutplan/analyze`、`GET/PUT/DELETE …/cutplan`

- [ ] **Step 1: 写失败测试**

新建 `packages/server/test/cutplan.test.ts`（仿 `video.test.ts` 的 app 装配）。**注意**：analyze 的成功路径要真跑 librosa，无法在单测里稳定 mock（跨包 spy 在 workspace 里可能拦不住），故本层只测 analyze 的**错误路径** + GET/PUT/DELETE 的 CRUD；analyze 成功路径（真 grid→cuts）由主控 Task5 Step5 真跑验证，`autoCutPlan` 本身已在 Task1 单测。

```typescript
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'
import { createLlmClient, loadConfig, openDb, type CoreCtx } from '@forgecast/core'
import { beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/app'
import { createTaskQueue } from '../src/tasks'

let ctx: CoreCtx, app: ReturnType<typeof createApp>, root: string
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-cp-'))
  const config = loadConfig(root, { FORGECAST_VIDEO_MODE: 'stub', FORGECAST_BEAT_PYTHON: '/fake/py' })
  ctx = { db: openDb(config.paths.db), config, llm: createLlmClient(config.llm) }
  ctx.db.prepare("INSERT INTO projects (slug) VALUES ('demo')").run()
  fs.mkdirSync(path.join(root, 'workspace/demo/shots'), { recursive: true })
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]); const ihdr = Buffer.alloc(25)
  ihdr.writeUInt32BE(13, 0); ihdr.write('IHDR', 4); ihdr.writeUInt32BE(1080, 8); ihdr.writeUInt32BE(1920, 12)
  fs.writeFileSync(path.join(root, 'workspace/demo/shots/01.png'), Buffer.concat([sig, ihdr]))
  fs.mkdirSync(path.join(root, 'templates/bgm/tense'), { recursive: true })
  fs.writeFileSync(path.join(root, 'templates/bgm/tense/x.mp3'), 'fake')
  app = createApp(ctx, createTaskQueue())
})

describe('cutplan API', () => {
  it('GET 无方案 → null', async () => {
    expect(await (await app.request('/api/projects/demo/cutplan')).json()).toBeNull()
  })
  it('PUT 存盘 → GET 读回 → DELETE 删', async () => {
    const plan = { bgm: 'tense/x.mp3', grid: { t0: 0, T: 0.5, bpm: 120, strongBeats: [], duration: 24 }, cadence: 4, offsetSec: 0, cuts: [{ beat: 12, shot: 0 }] }
    expect((await app.request('/api/projects/demo/cutplan', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ plan }) })).status).toBe(200)
    const got = await (await app.request('/api/projects/demo/cutplan')).json() as any
    expect(got.cadence).toBe(4)
    expect(got.cuts[0].beat).toBe(12)
    expect((await app.request('/api/projects/demo/cutplan', { method: 'DELETE' })).status).toBe(200)
    expect(await (await app.request('/api/projects/demo/cutplan')).json()).toBeNull()
  })
  it('PUT 非法方案 → 400', async () => {
    expect((await app.request('/api/projects/demo/cutplan', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ plan: { bgm: 'x' } }) })).status).toBe(400)
  })
  it('analyze 无 beatPython → 400', async () => {
    ctx.config.video.beatPython = ''
    expect((await app.request('/api/projects/demo/cutplan/analyze', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(400)
  })
  it('analyze 无 shots → 400（beatPython 有，但无截图）', async () => {
    fs.rmSync(path.join(root, 'workspace/demo/shots'), { recursive: true })
    const res = await app.request('/api/projects/demo/cutplan/analyze', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    expect(res.status).toBe(400) // 顺序：beatPython 通过 → readShots 空 → 400；未触达 analyzeBeats，不 spawn
  })
  it('未知项目 → 404', async () => {
    expect((await app.request('/api/projects/nope/cutplan')).status).toBe(404)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @forgecast/server test cutplan`
Expected: FAIL —— 路由不存在（404）。

- [ ] **Step 3: 实现路由**

`packages/server/src/app.ts`：顶部 import 补 `chooseBgmPath, analyzeBeats, autoCutPlan, readShots`（从 `@forgecast/studio`，与现有 studio import 合并）。在 `/api/projects/:slug/video` 路由之后加：

```typescript
  // —— 卡点方案（cutplan）——
  const cutplanPath = (slug: string) => path.join(ctx.config.paths.workspace, slug, 'cutplan.json')
  const projExists = (slug: string) => !!ctx.db.prepare('SELECT id FROM projects WHERE slug = ?').get(slug)

  app.post('/api/projects/:slug/cutplan/analyze', async (c) => {
    const slug = c.req.param('slug')
    if (!projExists(slug)) return c.json({ error: '项目不存在' }, 404)
    if (!ctx.config.video.beatPython) return c.json({ error: '需配置 FORGECAST_BEAT_PYTHON（librosa）才能分析卡点' }, 400)
    const body = await c.req.json().catch(() => ({} as any))
    const shots = readShots(path.join(ctx.config.paths.workspace, slug, 'shots'))
    if (!shots.length) return c.json({ error: 'demo 需要 workspace/<slug>/shots/ 里的截图' }, 400)
    const copyRow: any = ctx.db.prepare("SELECT hook FROM assets WHERE project_id = (SELECT id FROM projects WHERE slug=?) AND type='copy' ORDER BY id DESC LIMIT 1").get(slug)
    const bgmDir = path.join(ctx.config.paths.templates, 'bgm')
    const bgmPath = chooseBgmPath(bgmDir, { bgm: body.bgm ?? '', mood: body.mood ?? ctx.config.video.mood, hook: copyRow?.hook ?? '' }, Math.random)
    if (!bgmPath) return c.json({ error: '曲库为空（templates/bgm 无曲）' }, 400)
    const grid = await analyzeBeats(bgmPath, ctx.config.video.beatPython)
    if (!grid) return c.json({ error: '节拍分析失败（librosa）' }, 500)
    const rel = path.relative(bgmDir, bgmPath)
    const cadence = 4
    const cuts = autoCutPlan(grid, shots.length, grid.duration, cadence)
    return c.json({ bgm: rel, grid, cadence, offsetSec: 0, cuts, shots: shots.map((s) => ({ rel: s.rel })) })
  })

  app.get('/api/projects/:slug/cutplan', (c) => {
    const slug = c.req.param('slug')
    if (!projExists(slug)) return c.json({ error: '项目不存在' }, 404)
    const p = cutplanPath(slug)
    if (!fs.existsSync(p)) return c.json(null)
    try { return c.json(JSON.parse(fs.readFileSync(p, 'utf8'))) } catch { return c.json(null) }
  })

  app.put('/api/projects/:slug/cutplan', async (c) => {
    const slug = c.req.param('slug')
    if (!projExists(slug)) return c.json({ error: '项目不存在' }, 404)
    const { plan } = await c.req.json().catch(() => ({} as any))
    const ok = plan && typeof plan.bgm === 'string' && plan.grid && typeof plan.grid.t0 === 'number' && typeof plan.grid.T === 'number'
      && typeof plan.cadence === 'number' && typeof plan.offsetSec === 'number' && Array.isArray(plan.cuts)
    if (!ok) return c.json({ error: '方案字段非法' }, 400)
    fs.mkdirSync(path.dirname(cutplanPath(slug)), { recursive: true })
    fs.writeFileSync(cutplanPath(slug), JSON.stringify(plan, null, 2))
    return c.json({ ok: true })
  })

  app.delete('/api/projects/:slug/cutplan', (c) => {
    const slug = c.req.param('slug')
    if (!projExists(slug)) return c.json({ error: '项目不存在' }, 404)
    const p = cutplanPath(slug)
    if (fs.existsSync(p)) fs.rmSync(p)
    return c.json({ ok: true })
  })
```

（`fs`/`path` 在 app.ts 顶部已 import——若无则补 `import fs from 'node:fs'` / `import path from 'node:path'`，先 grep 确认。）

- [ ] **Step 4: 跑测试 + tsc**

Run: `pnpm --filter @forgecast/server test cutplan`、`npx tsc -p packages/server/tsconfig.json --noEmit`
Expected: 全绿、tsc 无输出。

- [ ] **Step 5: 提交**

```bash
git add packages/server
git commit -m "feat(server): 卡点方案 REST（analyze/get/put/delete cutplan）"
```

---

### Task 5: Web 卡点编辑器 CutPlanEditor

**Files:**
- Create: `apps/web/src/pages/CutPlanEditor.tsx`
- Modify: `apps/web/src/pages/ProjectDetailPage.tsx`（有 shots 时挂载编辑器）
- 手动浏览器走查（无单测，纯前端消费 API，同项目既有 Web 页约定）

**Interfaces:**
- Consumes: REST（Task4）：`POST …/cutplan/analyze`、`GET/PUT/DELETE …/cutplan`
- Produces: 无

**方案类型（前端本地）**：`{ bgm: string; grid: { t0: number; T: number; bpm: number; strongBeats: number[]; duration: number }; cadence: number; offsetSec: number; cuts: Array<{ beat: number; shot: number }>; shots?: Array<{ rel: string }> }`

- [ ] **Step 1: 建 CutPlanEditor 组件**

Create `apps/web/src/pages/CutPlanEditor.tsx`：

```tsx
import { useEffect, useState } from 'react'
import { api } from '../api'

type Cut = { beat: number; shot: number }
type Plan = { bgm: string; grid: { t0: number; T: number; bpm: number; strongBeats: number[]; duration: number }; cadence: number; offsetSec: number; cuts: Cut[]; shots?: { rel: string }[] }

function cutTime(p: Plan, c: Cut) { return p.grid.t0 + p.offsetSec + c.beat * p.grid.T }

export default function CutPlanEditor({ slug }: { slug: string }) {
  const [plan, setPlan] = useState<Plan | null>(null)
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)

  // 挂载时载入已保存方案（否则保存后重开页面会丢，且再点分析会重置）
  useEffect(() => {
    api<Plan | null>(`/api/projects/${slug}/cutplan`).then((p) => { if (p) { setPlan(p); setMsg('已载入保存的方案') } }).catch(() => {})
  }, [slug])

  async function analyze() {
    setBusy(true); setMsg('分析节拍中…')
    try {
      const p = await api<Plan | { error: string }>(`/api/projects/${slug}/cutplan/analyze`, { method: 'POST', body: '{}' })
      if ('error' in p) { setMsg('⚠ ' + p.error); setPlan(null) }
      else { setPlan(p); setMsg(`已分析：${p.grid.bpm.toFixed(1)} BPM，${p.cuts.length} 刀`) }
    } catch (e) { setMsg('⚠ ' + (e instanceof Error ? e.message : String(e))) }
    setBusy(false)
  }
  // 改 cadence：本地重算 cuts（窗口 [6, duration-6]）
  function setCadence(cad: number) {
    if (!plan) return
    const { t0, T, duration } = plan.grid
    const carStart = 6, carEnd = Math.max(7, duration - 6)
    const nStart = Math.max(0, Math.ceil((carStart - t0) / T - 1e-9))
    const cuts: Cut[] = []; let k = 0
    for (let n = nStart; t0 + n * T < carEnd; n += cad) { cuts.push({ beat: n, shot: k % (plan.shots?.length || 1) }); k++ }
    setPlan({ ...plan, cadence: cad, cuts })
  }
  function nudge(i: number, dir: 1 | -1) {
    if (!plan) return
    const cuts = plan.cuts.map((c) => ({ ...c }))
    const next = cuts[i].beat + dir
    const lo = i > 0 ? cuts[i - 1].beat + 1 : 0
    const hi = i < cuts.length - 1 ? cuts[i + 1].beat - 1 : Number.MAX_SAFE_INTEGER
    cuts[i].beat = Math.max(lo, Math.min(hi, next)) // 钳制不越邻刀
    setPlan({ ...plan, cuts })
  }
  function setShot(i: number, shot: number) {
    if (!plan) return
    const cuts = plan.cuts.map((c, j) => (j === i ? { ...c, shot } : c)); setPlan({ ...plan, cuts })
  }
  async function save() {
    if (!plan) return
    setBusy(true)
    try { await api(`/api/projects/${slug}/cutplan`, { method: 'PUT', body: JSON.stringify({ plan }) }); setMsg('已保存，生成视频时按此方案') }
    catch (e) { setMsg('⚠ 保存失败：' + (e instanceof Error ? e.message : String(e))) }
    setBusy(false)
  }
  async function clear() {
    setBusy(true)
    try { await api(`/api/projects/${slug}/cutplan`, { method: 'DELETE' }); setPlan(null); setMsg('已清除，恢复自动卡点') }
    catch (e) { setMsg('⚠ ' + (e instanceof Error ? e.message : String(e))) }
    setBusy(false)
  }

  return (
    <section className="space-y-3 rounded-lg border bg-white p-4">
      <div className="flex items-center justify-between">
        <h3 className="font-medium">卡点编辑（demo）</h3>
        <button className="rounded border px-3 py-1 text-sm disabled:opacity-50" disabled={busy} onClick={analyze}>{plan ? '重新分析' : '分析卡点'}</button>
      </div>
      {msg && <div className="text-xs text-neutral-600">{msg}</div>}
      {plan && (
        <>
          <div className="text-xs text-neutral-500">曲子：{plan.bgm}</div>
          <div className="flex items-center gap-4 text-sm">
            <label>每几拍切
              <select className="ml-1 rounded border px-2 py-1" value={plan.cadence} onChange={(e) => setCadence(Number(e.target.value))}>
                <option value={2}>2 拍</option><option value={4}>4 拍</option><option value={8}>8 拍</option>
              </select>
            </label>
            <label className="flex items-center gap-2">整体偏移 {plan.offsetSec.toFixed(2)}s
              <input type="range" min={-0.3} max={0.3} step={0.02} value={plan.offsetSec} onChange={(e) => setPlan({ ...plan, offsetSec: Number(e.target.value) })} />
            </label>
          </div>
          {/* 节拍刻度条：每刀落点按时间比例定位 */}
          <div className="relative h-8 rounded bg-neutral-100">
            {plan.cuts.map((c, i) => (
              <div key={i} title={`#${i + 1} ${cutTime(plan, c).toFixed(2)}s 图${c.shot + 1}`}
                className="absolute top-0 h-8 w-0.5 bg-blue-500"
                style={{ left: `${(cutTime(plan, c) / plan.grid.duration) * 100}%` }} />
            ))}
          </div>
          {/* 卡点列表 */}
          <div className="max-h-64 space-y-1 overflow-auto text-sm">
            {plan.cuts.map((c, i) => (
              <div key={i} className="flex items-center gap-2">
                <span className="w-8 text-neutral-400">#{i + 1}</span>
                <span className="w-16 tabular-nums">{cutTime(plan, c).toFixed(2)}s</span>
                <select className="rounded border px-1 py-0.5" value={c.shot} onChange={(e) => setShot(i, Number(e.target.value))}>
                  {(plan.shots || []).map((s, si) => <option key={si} value={si}>图{si + 1}</option>)}
                </select>
                <button className="rounded border px-2" onClick={() => nudge(i, -1)}>←</button>
                <button className="rounded border px-2" onClick={() => nudge(i, 1)}>→</button>
              </div>
            ))}
          </div>
          <div className="flex gap-2">
            <button className="rounded bg-blue-600 px-4 py-1.5 text-sm text-white disabled:opacity-50" disabled={busy} onClick={save}>保存方案</button>
            <button className="rounded border px-4 py-1.5 text-sm disabled:opacity-50" disabled={busy} onClick={clear}>清除(回自动)</button>
          </div>
        </>
      )}
    </section>
  )
}
```

- [ ] **Step 2: 挂载到 ProjectDetailPage**

`apps/web/src/pages/ProjectDetailPage.tsx`：import `CutPlanEditor`，在 raw 素材块附近（有截图的项目才有意义，但简单起见对所有项目显示，编辑器内部靠"分析卡点"按需触发）加：

```tsx
<CutPlanEditor slug={slug} />
```

（放在 return 的合适位置，如 raw 素材块之后。`slug` 变量在该组件已有。）

- [ ] **Step 3: 构建校验（前端无单测，验证能编译）**

Run: `pnpm --filter web build`（或 `corepack pnpm --filter web build`）
Expected: 构建成功、无 TS 报错。

- [ ] **Step 4: 提交**

```bash
git add apps/web
git commit -m "feat(web): 卡点编辑器 CutPlanEditor（分析/改cadence·offset·挪刀·换图/存清）"
```

- [ ] **Step 5: 手动浏览器走查（主控，里程碑）**

主控起 dev（`pnpm dev`，Node22 + melo venv 有 librosa）+ 一个有 shots 的项目：分析卡点 → 改每几拍/偏移/挪刀/换图 → 保存 → 生成视频确认按方案渲染（抽帧看切点/配图与方案一致）；清除 → 恢复自动。

---

## 完成标准
- studio 纯逻辑（autoCutPlan/planCutTimes）+ buildDemoSections plan + generate 消费 cutplan.json 全绿有测试。
- server 4 REST 有测试（analyze mock librosa）。
- web CutPlanEditor 能分析/编辑/存清，`pnpm --filter web build` 过。
- 无 cutplan.json 时渲染完全同现在（向后兼容不回归）。
- 主控真渲一条「按方案」的 demo，抽帧确认切点/配图与方案一致。

## 已知非纯代码成本 / 限制
- 主控 Step 5 手动走查 + 真渲需 Node22 + melo venv（librosa）+ ffmpeg。
- 编辑器自动方案窗口用 BGM 时长（`grid.duration`）；真实视频时长由旁白定，二者不同时，渲染 `planCutTimes` 按 beat 算时间、`buildDemoSections` 按 carEnd 过滤——超出的刀被丢、视频更长则尾部图停留（可接受，非 bug）。
- 方案 grid 在编辑时分析一次并存盘；渲染钉曲后不重跑 librosa（更快，且渲染环境无需 librosa）。
