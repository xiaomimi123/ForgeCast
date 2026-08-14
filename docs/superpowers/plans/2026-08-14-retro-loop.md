# 复盘闭环 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 审片报告 × 发布数据（perf）→ LLM 复盘（总评/保持/改进/最优先）存 `assets.retro` → 自动注入下一次文案与拍摄脚本生成，闭环收官。

**Architecture:** `packages/studio/src/retro.ts`（复盘生成，紧邻 reviewVideo）；`packages/copywriter` 的 assemble/generate/script 注入可选【上一条复盘】块（同 patternsMd 模式）；`assets` 表 ensureColumn 加 `retro` 列。

**Tech Stack:** 全沿用现状。

**Spec:** `docs/superpowers/specs/2026-08-14-retro-loop-design.md`

## Global Constraints

- 每个命令前先 `export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH"`。
- mock 模式绝不调用 `ctx.llm`（fixture）——仓库铁律。
- `video-retro.md` 提示词含真实感红线：不编数据断言；perf 缺失时不得假装有市场反馈。
- 复盘前置条件：必须已有 review（否则抛错）；perf 可选（缺省降级为纯内容复盘并在 prompt 里注明）。
- LLM 输出校验（verdict/keep/change/focus 四字段齐全非空）失败整批抛错，不写 `assets.retro`。
- 测试用 `fs.mkdtempSync` 临时库。
- 提交信息结尾带 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`。

---

### Task 1: assets.retro 迁移 + generateRetro（studio）

**Files:**
- Modify: `packages/core/src/db.ts`（迁移段 `ensureColumn(db, 'assets', 'review', 'TEXT')` 之后追加一行）
- Create: `packages/studio/src/retro.ts`
- Create: `packages/studio/src/fixtures/retro-fixture.ts`
- Modify: `packages/studio/src/index.ts`（补 `export * from './retro'`）
- Create: `templates/prompts/video-retro.md`
- Create: `packages/studio/test/retro.test.ts`

**Interfaces:**
- Consumes: `assets` 表（video 行的 review/perf 列、script 行）。
- Produces: `generateRetro(ctx, videoAssetId, {onProgress?}) => Promise<RetroReport>`；类型 `RetroReport`/`RetroDraft`。

- [ ] **Step 1: db.ts 迁移**

`ensureColumn(db, 'assets', 'review', 'TEXT')` 之后追加：

```ts
  ensureColumn(db, 'assets', 'retro', 'TEXT')
```

- [ ] **Step 2: 写失败测试**

`packages/studio/test/retro.test.ts`：

```ts
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createLlmClient, loadConfig, openDb, type CoreCtx } from '@forgecast/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { generateRetro } from '../src/retro'

let ctx: CoreCtx
let root: string
const REVIEW = JSON.stringify({
  scores: { hook: 70, pacing: 65, fidelity: 75, cta: 60, overall: 68 },
  suggestions: ['前3秒直接抛痛点'], transcript: '接外包的兄弟这句话你熟不熟',
  metrics: { durationSec: 30, charCount: 12, charsPerSec: 0.4 }, reviewedAt: '2026-08-14T00:00:00Z',
})
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-retro-'))
  const config = loadConfig(root, {}) // llm mock
  ctx = { db: openDb(config.paths.db), config, llm: createLlmClient(config.llm) }
  ctx.db.prepare("INSERT INTO projects (slug) VALUES ('demo')").run()
  ctx.db.prepare("INSERT INTO assets (project_id, type, file_path, origin, review) VALUES (1, 'video', 'demo/uploads/a.mp4', 'upload', ?)").run(REVIEW)
})
const vid = () => (ctx.db.prepare("SELECT id FROM assets WHERE type='video'").get() as any).id

describe('generateRetro mock', () => {
  it('全链路：写 assets.retro、hadPerf=false（无 perf）、不调 ctx.llm', async () => {
    const spy = vi.spyOn(ctx.llm, 'complete')
    const r = await generateRetro(ctx, vid())
    expect(spy).not.toHaveBeenCalled()
    expect(r.verdict.length).toBeGreaterThan(0)
    expect(r.keep.length).toBeGreaterThan(0)
    expect(r.change.length).toBeGreaterThan(0)
    expect(r.focus.length).toBeGreaterThan(0)
    expect(r.hadPerf).toBe(false)
    const row: any = ctx.db.prepare('SELECT retro FROM assets WHERE id = ?').get(vid())
    expect(JSON.parse(row.retro).focus).toBe(r.focus)
  })
  it('有 perf → hadPerf=true', async () => {
    ctx.db.prepare("UPDATE assets SET perf = ? WHERE id = ?")
      .run(JSON.stringify({ views: 1200, likes: 40, leads: 2, recordedAt: '2026-08-14' }), vid())
    const r = await generateRetro(ctx, vid())
    expect(r.hadPerf).toBe(true)
  })
  it('无 review → 抛错提示先审片；素材不存在 → 抛错', async () => {
    ctx.db.prepare("INSERT INTO assets (project_id, type, file_path, origin) VALUES (1, 'video', 'demo/uploads/b.mp4', 'upload')").run()
    const noReview = (ctx.db.prepare("SELECT id FROM assets WHERE review IS NULL AND type='video'").get() as any).id
    await expect(generateRetro(ctx, noReview)).rejects.toThrow(/先审片/)
    await expect(generateRetro(ctx, 9999)).rejects.toThrow(/不存在/)
  })
})

describe('generateRetro live（假 LLM）', () => {
  function liveCtx(out: string): CoreCtx {
    const config = loadConfig(root, { FORGECAST_LLM_MODE: 'live', FORGECAST_LLM_KEY: 'k' })
    config.paths.templates = path.resolve(__dirname, '../../../templates')
    return { db: ctx.db, config, llm: { complete: vi.fn(async () => out) } as any }
  }
  it('合法输出 → 落库', async () => {
    const r = await generateRetro(liveCtx(JSON.stringify({ verdict: '钩子偏弱', keep: ['节奏'], change: ['前3秒'], focus: '改钩子' })), vid())
    expect(r.verdict).toBe('钩子偏弱')
  })
  it('缺 focus → 整批抛错不写列', async () => {
    await expect(generateRetro(liveCtx(JSON.stringify({ verdict: 'x', keep: ['a'], change: ['b'] })), vid())).rejects.toThrow(/非法/)
    const row: any = ctx.db.prepare('SELECT retro FROM assets WHERE id = ?').get(vid())
    expect(row.retro).toBeNull()
  })
})
```

Run: `pnpm --filter @forgecast/studio exec vitest run test/retro.test.ts` → FAIL

- [ ] **Step 3: fixture**

`packages/studio/src/fixtures/retro-fixture.ts`：

```ts
export interface RetroDraft { verdict: string; keep: string[]; change: string[]; focus: string }

/** mock 复盘：固定总评/保持/改进/最优先。绝不调用 ctx.llm（仓库铁律）。 */
export function mockRetroReport(): RetroDraft {
  return {
    verdict: '结构完整但钩子偏弱（mock 示例）',
    keep: ['录屏演示节奏清晰'],
    change: ['前3秒直接抛痛点', 'CTA 停顿一拍再说'],
    focus: '下一条优先把前3秒钩子改成直给痛点',
  }
}
```

- [ ] **Step 4: retro.ts**

`packages/studio/src/retro.ts`：

```ts
import fs from 'node:fs'
import path from 'node:path'
import type { CoreCtx } from '@forgecast/core'
import { mockRetroReport, type RetroDraft } from './fixtures/retro-fixture'

export type { RetroDraft } from './fixtures/retro-fixture'

export interface RetroReport extends RetroDraft { generatedAt: string; hadPerf: boolean }

function stripFence(raw: string): string {
  return raw.trim().replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/```\s*$/, '').trim()
}

function parseRetroJson(raw: string): RetroDraft {
  const v = JSON.parse(stripFence(raw))
  const bad: string[] = []
  if (typeof v?.verdict !== 'string' || !v.verdict.trim()) bad.push('verdict')
  if (!Array.isArray(v?.keep) || !v.keep.length) bad.push('keep')
  if (!Array.isArray(v?.change) || !v.change.length) bad.push('change')
  if (typeof v?.focus !== 'string' || !v.focus.trim()) bad.push('focus')
  if (bad.length) throw new Error(`复盘输出非法（缺 ${bad.join('、')}）: ${raw.slice(0, 120)}`)
  return { verdict: v.verdict, keep: v.keep.map(String), change: v.change.map(String), focus: v.focus }
}

/**
 * 复盘：审片报告（必须已有，否则抛错）× perf（可选，缺省降级纯内容复盘并在 prompt 注明）
 * → LLM 输出 总评/保持/改进/最优先（校验失败整批抛错不写库）→ 覆盖写 assets.retro。
 * mock 走 fixture 绝不调 ctx.llm。生成的复盘会被下一次文案/拍摄脚本生成自动引用（闭环）。
 */
export async function generateRetro(
  ctx: CoreCtx, videoAssetId: number,
  opts: { onProgress?: (msg: string) => void } = {},
): Promise<RetroReport> {
  const { onProgress = () => {} } = opts
  const asset: any = ctx.db.prepare("SELECT * FROM assets WHERE id = ? AND type = 'video'").get(videoAssetId)
  if (!asset) throw new Error(`视频素材不存在: #${videoAssetId}`)
  if (!asset.review) throw new Error(`该成片还没审片，先审片再复盘: #${videoAssetId}`)
  const review = JSON.parse(asset.review)
  const perf = asset.perf ? JSON.parse(asset.perf) : null

  // 对照基准沿用审片时记的 scriptAssetId；读不到（被删等）直接跳过，不阻断
  let baseline = ''
  if (review.scriptAssetId) {
    const s: any = ctx.db.prepare("SELECT * FROM assets WHERE id = ? AND type = 'script'").get(review.scriptAssetId)
    if (s) { try { baseline = fs.readFileSync(path.join(ctx.config.paths.workspace, s.file_path), 'utf8') } catch { baseline = '' } }
  }

  onProgress('生成复盘…')
  let draft: RetroDraft
  if (ctx.config.llm.mode === 'mock') {
    draft = mockRetroReport()
  } else {
    const tpl = fs.readFileSync(path.join(ctx.config.paths.templates, 'prompts', 'video-retro.md'), 'utf8')
    const system = '你是短视频运营复盘教练，只输出给定 JSON 结构，不要多余文字。'
    const s = review.scores
    const reviewBlock = [
      `分数：钩子${s.hook}/节奏${s.pacing}/贴合${s.fidelity}/CTA${s.cta}/总分${s.overall}`,
      `审片建议：\n${(review.suggestions ?? []).map((x: string) => `- ${x}`).join('\n')}`,
      review.transcript ? `转写摘要：${String(review.transcript).slice(0, 300)}` : '',
      review.degraded ? `（${review.degraded}）` : '',
    ].filter(Boolean).join('\n')
    const perfBlock = perf
      ? `曝光 ${perf.views ?? 0}｜赞 ${perf.likes ?? 0}｜询单 ${perf.leads ?? 0}（回填于 ${perf.recordedAt ?? '未知'}）`
      : '（暂无发布数据——只基于内容审片复盘，不得假装有市场反馈）'
    const prompt = [
      tpl,
      `【审片报告】\n${reviewBlock}`,
      `【发布数据】\n${perfBlock}`,
      baseline ? `【拍摄脚本基准】\n${baseline.slice(0, 3000)}` : '',
    ].filter(Boolean).join('\n\n---\n\n')
    draft = parseRetroJson(await ctx.llm.complete({ model: ctx.config.llm.models.copy, system, prompt }))
  }

  const report: RetroReport = { ...draft, generatedAt: new Date().toISOString(), hadPerf: !!perf }
  ctx.db.prepare('UPDATE assets SET retro = ? WHERE id = ?').run(JSON.stringify(report), videoAssetId)
  onProgress('复盘完成')
  return report
}
```

`packages/studio/src/index.ts` 追加 `export * from './retro'`。

- [ ] **Step 5: 提示词模板**

`templates/prompts/video-retro.md`：

```markdown
你是短视频运营复盘教练。根据审片报告与发布数据，为这条视频写复盘，并给下一条视频的行动建议。

【思路】
- 内容分数高但发布数据差 → 问题可能在选题/封面/发布时机，不在制作层
- 内容分数低 → 先修内容问题（审片建议是线索）
- 暂无发布数据时只基于内容复盘，明确不做市场层面的判断

【输出格式】只输出 JSON，不要任何其他文字：
{ "verdict": "<一句话总评>", "keep": ["<下一条要保持的做法，1-3条>"], "change": ["<下一条要改的做法，2-4条>"], "focus": "<下一条最优先改进的一件事，一句话>" }

【真实感红线】不得编造任何数据类断言；发布数据缺失时不得假装有市场反馈。
```

- [ ] **Step 6: 跑测试 + 全仓回归 + 提交**

```bash
git add packages/core/src/db.ts packages/studio/src/retro.ts packages/studio/src/fixtures/retro-fixture.ts packages/studio/src/index.ts templates/prompts/video-retro.md packages/studio/test/retro.test.ts
git commit -m "feat(studio): generateRetro 复盘（审片×发布数据→下一条行动建议）+ assets.retro 迁移

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: 复盘注入下一次生成（copywriter）

**Files:**
- Modify: `packages/copywriter/src/assemble.ts`（`AssembleInput` 加 `retroMd?`、prompt 数组插块、新导出 `formatRetroMd`）
- Modify: `packages/copywriter/src/generate.ts`（查最新带 retro 的 video 素材并格式化传入）
- Modify: `packages/copywriter/src/script.ts`（同样注入拍摄脚本 prompt）
- Modify: `packages/copywriter/test/generate.test.ts`、`packages/copywriter/test/script.test.ts`（各补用例）

**Interfaces:**
- Consumes: `assets.retro` JSON（Task 1 的 RetroReport 形状）。
- Produces: `formatRetroMd(r) => string`（assemble.ts 导出）。

- [ ] **Step 1: 写失败测试**

`packages/copywriter/test/generate.test.ts` 追加（该文件现有测试全部 `renderCovers: false` 模式；沿用其 beforeEach 的 ctx/seed）：

```ts
  it('项目有带 retro 的成片 → live prompt 注入【上一条复盘】块；没有则不出现', async () => {
    const config = loadConfig(root, { FORGECAST_LLM_MODE: 'live', FORGECAST_LLM_KEY: 'k' })
    config.paths.templates = path.resolve(__dirname, '../../../templates')
    const complete = vi.fn(async () => copyFixtures.pain)
    const lctx: CoreCtx = { db: ctx.db, config, llm: { complete } as any }
    await generateCopy(lctx, { slug: 'demo', hook: 'pain', renderCovers: false })
    expect(complete.mock.calls[0][0].prompt).not.toContain('【上一条复盘')
    ctx.db.prepare("INSERT INTO assets (project_id, type, file_path, origin, retro) VALUES (1, 'video', 'demo/uploads/a.mp4', 'upload', ?)")
      .run(JSON.stringify({ verdict: '钩子偏弱', keep: ['节奏清晰'], change: ['前3秒直给'], focus: '改钩子', generatedAt: 'x', hadPerf: false }))
    await generateCopy(lctx, { slug: 'demo', hook: 'pain', renderCovers: false })
    const p = complete.mock.calls[1][0].prompt
    expect(p).toContain('【上一条复盘')
    expect(p).toContain('最优先：改钩子')
  })
```

（若该测试文件的 beforeEach 变量名/种子与上述不完全一致，按现有文件实际结构对齐——断言目标不变：无 retro 不含块、有 retro 含块且含 focus 文本。）

`packages/copywriter/test/script.test.ts` 的 live describe 追加：

```ts
  it('项目有带 retro 的成片 → 拍摄脚本 prompt 注入复盘块', async () => {
    ctx.db.prepare("INSERT INTO assets (project_id, type, file_path, origin, retro) VALUES (1, 'video', 'demo/uploads/a.mp4', 'upload', ?)")
      .run(JSON.stringify({ verdict: 'v', keep: ['k1'], change: ['c1'], focus: '改钩子', generatedAt: 'x', hadPerf: false }))
    const config = loadConfig(root, { FORGECAST_LLM_MODE: 'live', FORGECAST_LLM_KEY: 'k' })
    config.paths.templates = path.resolve(__dirname, '../../../templates')
    const complete = vi.fn(async () => '# 拍摄脚本\n' + 'x'.repeat(120))
    const lctx: CoreCtx = { db: ctx.db, config, llm: { complete } as any }
    await generateShootScript(lctx, { slug: 'demo' })
    expect(complete.mock.calls[0][0].prompt).toContain('【上一条复盘')
  })
```

- [ ] **Step 2: assemble.ts**

`AssembleInput` 加 `retroMd?: string`；prompt 数组在 `patternsMd` 行之后插：

```ts
    i.retroMd ? `【上一条复盘（参考改进，不必逐条照做）】\n${i.retroMd}` : '',
```

文件末尾新增导出：

```ts
/** 把 assets.retro 的 JSON 格式化成注入提示词的参考文本（copy 与拍摄脚本共用） */
export function formatRetroMd(r: { verdict: string; keep: string[]; change: string[]; focus: string }): string {
  return [
    `总评：${r.verdict}`,
    `保持：\n${r.keep.map((s) => `- ${s}`).join('\n')}`,
    `改进：\n${r.change.map((s) => `- ${s}`).join('\n')}`,
    `最优先：${r.focus}`,
  ].join('\n')
}
```

- [ ] **Step 3: generate.ts**

import 区 `assemblePrompt` 处补 `formatRetroMd`。`patternsMd` 计算之后加：

```ts
  // 上一条复盘注入（闭环）：查本项目最新一条带 retro 的成片，把 保持/改进/最优先 作为改进参考；没有则跳过
  const retroRow: any = ctx.db.prepare(
    "SELECT retro FROM assets WHERE project_id = ? AND type = 'video' AND retro IS NOT NULL ORDER BY id DESC LIMIT 1",
  ).get(project.id)
  const retroMd = retroRow ? formatRetroMd(JSON.parse(retroRow.retro)) : ''
```

`assemblePrompt({ ... })` 调用补 `retroMd`。

- [ ] **Step 4: script.ts**

import 补 `formatRetroMd`（from './assemble'）。live 分支组装 prompt 前加同款 retroRow/retroMd 查询（用 `project.id`），prompt 数组在拍摄条件块之后插：

```ts
      retroMd ? `【上一条复盘（拍摄层面参考，不必逐条照做）】\n${retroMd}` : '',
```

（记得 `.filter(Boolean)` 已有则沿用；若当前 join 无 filter，改为 `[...].filter(Boolean).join('\n\n---\n\n')`。）

- [ ] **Step 5: 跑测试 + 提交**

```bash
git add packages/copywriter
git commit -m "feat(copywriter): 上一条复盘自动注入文案与拍摄脚本生成（闭环）

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: server 路由 + CLI

**Files:**
- Modify: `packages/server/src/app.ts`（`POST /api/assets/:id/review` 之后追加 retro 路由；`@forgecast/studio` import 补 `generateRetro`）
- Modify: `packages/server/test/shoot-review.test.ts`（追加 2 用例）
- Modify: `cli.ts`（`case 'review-video':` 之后加 `case 'retro':`；studio import 补 `generateRetro`）

- [ ] **Step 1: 追加失败测试**

`shoot-review.test.ts` 末尾追加：

```ts
  it('retro 任务：先审片再复盘 → assets.retro 写入（mock）', async () => {
    const up = await (await app.request('/api/projects/demo/upload-video', { method: 'POST', body: fakeVideoForm('take3.mp4') })).json() as any
    const rv = await (await app.request(`/api/assets/${up.assetId}/review`, { method: 'POST', body: '{}' })).json() as any
    await runTask(rv.taskId)
    const { taskId } = await (await app.request(`/api/assets/${up.assetId}/retro`, { method: 'POST' })).json() as any
    await runTask(taskId)
    const row: any = ctx.db.prepare('SELECT retro FROM assets WHERE id = ?').get(up.assetId)
    expect(JSON.parse(row.retro).focus.length).toBeGreaterThan(0)
  })
  it('未审片直接复盘 → 任务失败', async () => {
    const up = await (await app.request('/api/projects/demo/upload-video', { method: 'POST', body: fakeVideoForm('take4.mp4') })).json() as any
    const { taskId } = await (await app.request(`/api/assets/${up.assetId}/retro`, { method: 'POST' })).json() as any
    await expect(runTask(taskId)).rejects.toThrow(/先审片/)
  })
```

- [ ] **Step 2: 路由**

```ts
  app.post('/api/assets/:id/retro', (c) => {
    const id = Number(c.req.param('id'))
    const taskId = queue.enqueue((log) => generateRetro(ctx, id, { onProgress: log }))
    return c.json({ taskId })
  })
```

- [ ] **Step 3: CLI**

```ts
    case 'retro': {
      const id = rest.find((a) => !a.startsWith('--'))
      if (!id) { console.error('用法: forgecast retro <videoAssetId>'); process.exit(1) }
      const ctx = ctxWithNotes()
      const r = await generateRetro(ctx, Number(id), { onProgress: (m) => console.log(`  ${m}`) })
      console.log(`总评：${r.verdict}${r.hadPerf ? '' : '（暂无发布数据）'}`)
      console.log(`保持：${r.keep.join('；')}`)
      console.log(`改进：${r.change.join('；')}`)
      console.log(`下一条优先：${r.focus}`)
      break
    }
```

- [ ] **Step 4: 测试 + 提交**

```bash
git add packages/server cli.ts
git commit -m "feat(server,cli): 复盘路由与 retro 子命令

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Web（UploadCard 复盘）+ README + 全仓回归

**Files:**
- Modify: `apps/web/src/api.ts`（Asset 加 `retro: string | null`）
- Modify: `apps/web/src/pages/workshop/UploadTab.tsx`（UploadCard 加生成复盘按钮与展示）
- Modify: `README.md`

- [ ] **Step 1: api.ts**

`review` 字段之后加：

```ts
  /** JSON 字符串复盘 {verdict,keep,change,focus,generatedAt,hadPerf}，自行解析 */
  retro: string | null
```

- [ ] **Step 2: UploadCard**

`UploadTab.tsx` 顶部 `ReviewReport` 接口之后加：

```tsx
interface RetroReport { verdict: string; keep: string[]; change: string[]; focus: string; generatedAt: string; hadPerf: boolean }
```

`UploadCard` 内（`report` 解析之后）加：

```tsx
  const [retroing, setRetroing] = useState(false)
  let retro: RetroReport | null = null
  if (asset.retro) { try { retro = JSON.parse(asset.retro) } catch { retro = null } }
  async function runRetro() {
    if (retroing) return
    setRetroing(true)
    try {
      const { taskId } = await api<{ taskId: string }>(`/api/assets/${asset.id}/retro`, { method: 'POST' })
      subscribeTask(taskId, (e) => {
        if (e.type === 'done' || e.type === 'error') {
          setRetroing(false)
          qc.invalidateQueries({ queryKey: ['assets'] })
          if (e.type === 'error') alert('复盘失败：' + e.message)
        }
      })
    } catch (err) {
      setRetroing(false)
      alert('复盘失败：' + (err instanceof Error ? err.message : String(err)))
    }
  }
```

报告展示区（`{report && (...)}` 块内、建议列表之后）加：

```tsx
            <button className="btn-ink px-2 py-0.5 text-xs disabled:opacity-50" disabled={retroing} onClick={runRetro}>
              {retroing ? '复盘中…' : retro ? '重新复盘' : '生成复盘（结合发布数据）'}
            </button>
            {retro && (
              <div className="space-y-1 border-t border-hairline pt-2 text-xs">
                <div className="font-bold">复盘：{retro.verdict}{retro.hadPerf ? '' : '（暂无发布数据）'}</div>
                <div className="text-sub">保持：{retro.keep.join('；')}</div>
                <div className="text-sub">改进：{retro.change.join('；')}</div>
                <div className="rounded bg-fire-soft px-2 py-1 font-bold text-fire">下一条优先：{retro.focus}</div>
              </div>
            )}
```

- [ ] **Step 3: README**

CLI 段 `forgecast review-video ...` 行之后加：

```
forgecast retro <videoAssetId>                    # 复盘：审片报告×发布数据→下一条行动建议；下一次生成文案/拍摄脚本会自动引用
```

- [ ] **Step 4: 全仓回归 + 提交**

Run: `pnpm test && pnpm --filter web exec tsc --noEmit && pnpm --filter web build`

```bash
git add apps/web/src/api.ts apps/web/src/pages/workshop/UploadTab.tsx README.md
git commit -m "feat(web): 成片卡片生成复盘按钮与展示 + README 补 retro 说明

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## 端到端验证（主会话手动执行）

1. 重启 dev server。
2. 成片 tab 上传一条测试视频 → 审片 → 「生成复盘」→ 展示总评/保持/改进/最优先（"暂无发布数据"标注正确）。
3. 给该素材回填一条 perf（分发营销复盘页或 CLI perf）→ 重新复盘 → 报告体现发布数据（hadPerf）。
4. 生成一条新文案（live）→ 任务日志/输出可确认注入了复盘参考（或直接观察生成内容采纳 focus 方向）。
5. 测试假数据清理，真实产物保留。
