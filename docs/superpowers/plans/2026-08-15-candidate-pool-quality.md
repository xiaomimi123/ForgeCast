# 候选池质量提升（低分淘汰 + 中文简介）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 找项目面板候选池自动淘汰低分（<50 分）候选（标记 dismissed，不删除），并给候选卡片补上中文一句话简介（复用评分 LLM 调用，零额外成本）。

**Architecture:** 两个独立小改动共用同一批文件（`packages/scout` 评分/清理逻辑、`apps/web` 候选卡片/列表页），按 spec 拆两组任务顺序执行：Task 1-2 做中文简介（评分链路先改，因为清理链路的"补评分"复用同一个 `rescoreCandidate`，两组任务在 `score.ts` 上没有冲突可以任意顺序，这里选先做简介再做清理，因为清理任务的测试会用到真实评分结果，顺序更自然）；Task 3-4 做低分淘汰（`scout.ts` 新函数 + `scheduler.ts` 接入）；Task 5-6 做前端（卡片显示中文简介 + 淘汰候选折叠区）。

**Tech Stack:** TypeScript, Vitest（后端测试），better-sqlite3，Hono，React + TanStack Query（前端，不加自动化测试）。

## Global Constraints

- 阈值固定 50 分，硬编码在 `cleanupCandidates` 默认值里，**不做设置页可调项**。
- 淘汰是标记 `status='dismissed'`，**绝不删除行**。
- 已淘汰候选之后再被扫描到（repo 已存在于 `candidates` 表）按现有 `onlyNew` 逻辑视为"已存在"跳过，**不会**重新计入"新增"或被重新扫描——这是已确认的设计取舍，不是 bug。
- **不做**"取消淘汰/恢复"按钮，已淘汰列表纯展示（view-only）。
- **不改**手动"抓取候选"按钮对应的 `POST /api/scout` 路径（直接调 `scoutCandidates`，不经过 `runAutoScout`）。
- **不批量回填**已有候选的中文简介，也不批量回填已有候选的淘汰判定之外的字段。
- **不改** `apps/web/src/pages/board/CandidateDrawer.tsx`（详情抽屉），本轮只动卡片列表（`CandidateCard.tsx`）与看板页（`ScoutPage.tsx`）。
- mock 模式下 `summaryZh` 留空串，不编造翻译（`heuristicScore` 没有 LLM 可用，和现有 `targetBuyer`/`painPoint` 的 mock 留空约定一致）。
- 参考 spec：`docs/superpowers/specs/2026-08-15-candidate-cleanup-design.md`、`docs/superpowers/specs/2026-08-15-candidate-card-zh-summary-design.md`。

---

### Task 1: ScoreDetail 加 summaryZh 字段（types + score.ts + 测试）

**Files:**
- Modify: `packages/scout/src/types.ts:16-25`（`ScoreDetail` interface）
- Modify: `packages/scout/src/score.ts:31-50`（`scoreCandidate` live prompt）
- Modify: `packages/scout/src/score.ts:52-66`（`heuristicScore`，mock 分支）
- Modify: `packages/scout/src/score.ts:68-84`（`parseScoreJson`）
- Test: `packages/scout/test/score.test.ts`

**Interfaces:**
- Produces: `ScoreDetail.summaryZh: string`——后续 Task 5（`CandidateCard.tsx`）读取此字段。

- [ ] **Step 1: 写失败测试——mock 模式 summaryZh 留空串**

在 `packages/scout/test/score.test.ts` 的 `describe('scoreCandidate mock', ...)` 块内追加一条 `it`：

```ts
  it('mock 下 summaryZh 留空串（无 LLM，不编造翻译）', async () => {
    const ctx = ctxWith({})
    const d = await scoreCandidate(ctx, meta, 'React + Node + Docker 的 CRM，含 dashboard、screenshot 与 demo。'.repeat(3))
    expect(d.summaryZh).toBe('')
  })
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/scout && npx vitest run test/score.test.ts -t "summaryZh"`
Expected: FAIL（`summaryZh` 属性不存在于返回对象类型上，或 TS 编译错误提示 `Property 'summaryZh' does not exist`）

- [ ] **Step 3: 改 `ScoreDetail` interface**

`packages/scout/src/types.ts` 里 `ScoreDetail` 加一行（放在 `painPoint` 之后、`category` 之前）：

```ts
export interface ScoreDetail {
  rebrandCost: number // 0-30 换皮成本
  buyerClarity: number // 0-40 买家清晰度
  visualAppeal: number // 0-30 内容可视性
  techStack: string[]
  rationale: string
  targetBuyer: string // 什么老板会掏钱，一句话；mock 下为空串（不编造）
  painPoint: string // 解决的行业痛点，一句话；mock 下为空串
  summaryZh: string // 这个项目是做什么的，一句话中文说明；mock 下为空串（不编造翻译）
  category: string // 领域标签，取自 CATEGORIES
}
```

- [ ] **Step 4: 改 `heuristicScore`（mock 分支）留空串**

`packages/scout/src/score.ts` 的 `heuristicScore` 返回对象里，在 `targetBuyer: '', painPoint: '',` 那一行后加 `summaryZh: '',`：

```ts
  return {
    rebrandCost, buyerClarity, visualAppeal, techStack: [...new Set(techStack)],
    rationale: `离线启发式评分：${meta.repo}`,
    // mock 不编造买家与痛点——关键词拼出来的假数据比空着更坏
    targetBuyer: '', painPoint: '', summaryZh: '',
    category: categorizeHeuristic(meta.repo, readme, techStack),
  }
```

- [ ] **Step 5: 改 live prompt JSON 契约**

`packages/scout/src/score.ts` 里 `scoreCandidate` 的 `prompt` 数组，把这一行：

```ts
    `输出 JSON：{"rebrandCost":n,"buyerClarity":n,"visualAppeal":n,"techStack":["..."],"rationale":"一句话","targetBuyer":"什么老板会掏钱，一句话（行业+规模）","painPoint":"解决的行业痛点，一句话，注明现状成本","category":"从下列类别选一个最贴切的"}`,
```

改成（在 `painPoint` 后加 `summaryZh`）：

```ts
    `输出 JSON：{"rebrandCost":n,"buyerClarity":n,"visualAppeal":n,"techStack":["..."],"rationale":"一句话","targetBuyer":"什么老板会掏钱，一句话（行业+规模）","painPoint":"解决的行业痛点，一句话，注明现状成本","summaryZh":"这个项目是做什么的，一句话，中文","category":"从下列类别选一个最贴切的"}`,
```

- [ ] **Step 6: 改 `parseScoreJson` 解析**

`packages/scout/src/score.ts` 的 `parseScoreJson` 返回对象里，在 `painPoint: typeof o.painPoint === 'string' ? o.painPoint : '',` 后加一行：

```ts
  return {
    rebrandCost: clamp(o.rebrandCost, 30),
    buyerClarity: clamp(o.buyerClarity, 40),
    visualAppeal: clamp(o.visualAppeal, 30),
    techStack: Array.isArray(o.techStack) ? o.techStack.map(String) : [],
    rationale: typeof o.rationale === 'string' ? o.rationale : '',
    targetBuyer: typeof o.targetBuyer === 'string' ? o.targetBuyer : '',
    painPoint: typeof o.painPoint === 'string' ? o.painPoint : '',
    summaryZh: typeof o.summaryZh === 'string' ? o.summaryZh : '',
    category: typeof o.category === 'string' ? o.category : '',
  }
```

- [ ] **Step 7: 跑测试确认通过**

Run: `cd packages/scout && npx vitest run test/score.test.ts`
Expected: PASS（全部用例，含新加的一条）

- [ ] **Step 8: 补一条 live 分支解析兜底测试**

live 分支目前测试文件里没有专门测 `parseScoreJson` 的用例（现有测试都在 mock 分支）。在 `packages/scout/test/score.test.ts` 文件末尾新增一个 `describe` 块，直接测 `scoreCandidate` 的 live 分支（用 `vi.spyOn` 打桩 `ctx.llm.complete`，仿 copywriter 包里 `script.test.ts` 对 live 分支的测法）：

```ts
describe('scoreCandidate live（假 LLM）', () => {
  it('summaryZh 缺失/非字符串时按空串兜底', async () => {
    const config = loadConfig('/tmp/fc-score-live', { FORGECAST_LLM_MODE: 'live', FORGECAST_LLM_KEY: 'k' })
    const lctx: CoreCtx = {
      db: openDb(config.paths.db), config,
      llm: { complete: vi.fn(async () => JSON.stringify({
        rebrandCost: 20, buyerClarity: 30, visualAppeal: 20, techStack: ['react'],
        rationale: 'r', targetBuyer: 't', painPoint: 'p', category: 'CRM/销售',
        // summaryZh 缺失
      })) } as any,
    }
    const d = await scoreCandidate(lctx, meta, 'readme')
    expect(d.summaryZh).toBe('')
  })
  it('summaryZh 是字符串时原样透传', async () => {
    const config = loadConfig('/tmp/fc-score-live2', { FORGECAST_LLM_MODE: 'live', FORGECAST_LLM_KEY: 'k' })
    const lctx: CoreCtx = {
      db: openDb(config.paths.db), config,
      llm: { complete: vi.fn(async () => JSON.stringify({
        rebrandCost: 20, buyerClarity: 30, visualAppeal: 20, techStack: ['react'],
        rationale: 'r', targetBuyer: 't', painPoint: 'p', summaryZh: '开源客服平台', category: 'CRM/销售',
      })) } as any,
    }
    const d = await scoreCandidate(lctx, meta, 'readme')
    expect(d.summaryZh).toBe('开源客服平台')
  })
})
```

注意：这两条新测试需要在文件顶部已有的 `import` 里确认 `openDb`、`vi` 已引入（现有文件顶部已 `import { createLlmClient, loadConfig, openDb, type CoreCtx } from '@forgecast/core'` 和 `import { beforeEach, describe, expect, it, vi } from 'vitest'`，两者都已存在，无需改动 import）。

- [ ] **Step 9: 跑全部测试确认通过**

Run: `cd packages/scout && npx vitest run test/score.test.ts`
Expected: PASS（全部用例，含 mock + live 共 6+ 条）

- [ ] **Step 10: Commit**

```bash
cd "/Users/lizhishaoniange/Documents/开源变现内容工厂"
git add packages/scout/src/types.ts packages/scout/src/score.ts packages/scout/test/score.test.ts
git commit -m "feat(scout): ScoreDetail 加 summaryZh 中文简介字段"
```

---

### Task 2: candidatesNeedingRescore 用不用管 summaryZh？（确认，无代码改动）

**Files:**
- 无文件改动，仅确认一件事并记录，供后续任务参照。

**Interfaces:**
- 无新增接口。

- [ ] **Step 1: 确认 `candidatesNeedingRescore` 判定逻辑不受影响**

`packages/scout/src/scout.ts` 里 `candidatesNeedingRescore` 的判定标准是 `score_detail` 缺 `targetBuyer`（"还没真评过"的定义）。这个函数**不需要改**——`summaryZh` 是否为空不影响"是否算真评过"的判定标准（一个候选可能 `targetBuyer` 有值但 `summaryZh` 因为是老数据而缺失，这种情况不强制重评，用户手动点"全部重新评分"或 Task 4 的自动清理补评分流程会自然覆盖到）。此任务不产生代码 diff，跳过 commit，直接进入 Task 3。

---

### Task 3: cleanupCandidates 核心逻辑（scout.ts + 测试）

**Files:**
- Modify: `packages/scout/src/scout.ts`（新增导出函数，放在 `rescoreCandidate` 之后、`backfillCategories` 之前）
- Test: `packages/scout/test/scout.test.ts`

**Interfaces:**
- Consumes: `rescoreCandidate(ctx: CoreCtx, id: number): Promise<void>`（已存在于同文件，`packages/scout/src/scout.ts` 现有函数，直接调用不用改）
- Produces: `cleanupCandidates(ctx: CoreCtx, opts?: { threshold?: number }): Promise<{ rescored: number; dismissed: number }>`——Task 4（`scheduler.ts`）依赖此函数签名。

- [ ] **Step 1: 写失败测试——已评分且低于阈值 → dismissed，达到阈值不变**

在 `packages/scout/test/scout.test.ts` 文件末尾新增：

```ts
describe('cleanupCandidates (mock)', () => {
  it('已评分：低于阈值 → dismissed；达到阈值 → 保持 candidate', async () => {
    await scoutCandidates(ctx) // 先把 fixtures 全部入池（含评分）
    // 手动改两行的分数到确定值，规避 heuristicScore 具体数值不可控的问题
    ctx.db.prepare("UPDATE candidates SET score = 30 WHERE repo = 'formbricks/formbricks'").run()
    ctx.db.prepare("UPDATE candidates SET score = 80 WHERE repo = 'chatwoot/chatwoot'").run()
    const r = await cleanupCandidates(ctx, { threshold: 50 })
    expect(r.dismissed).toBeGreaterThanOrEqual(1)
    const low: any = ctx.db.prepare("SELECT status FROM candidates WHERE repo = 'formbricks/formbricks'").get()
    expect(low.status).toBe('dismissed')
    const high: any = ctx.db.prepare("SELECT status FROM candidates WHERE repo = 'chatwoot/chatwoot'").get()
    expect(high.status).toBe('candidate')
  })

  it('license_ok=0 或 status=picked 的候选不受阈值判定影响', async () => {
    await scoutCandidates(ctx)
    ctx.db.prepare("UPDATE candidates SET score = 0 WHERE repo = 'twentyhq/twenty'").run()
    ctx.db.prepare("UPDATE candidates SET status = 'picked' WHERE repo = 'twentyhq/twenty'").run()
    await cleanupCandidates(ctx, { threshold: 50 })
    const picked: any = ctx.db.prepare("SELECT status FROM candidates WHERE repo = 'twentyhq/twenty'").get()
    expect(picked.status).toBe('picked') // 没被 dismiss 覆盖
    const gpl: any = ctx.db.prepare("SELECT status, score FROM candidates WHERE repo = 'gpl-example/copyleft-tool'").get()
    expect(gpl.score).toBeNull() // license_ok=0 本就不评分，不该被"补评分"逻辑碰到
    expect(gpl.status).toBe('candidate') // 也不该被 dismiss（license gate 已经在別处标记不可商用）
  })

  it('未评分（score IS NULL）候选先被补评分，再按补评后的分数判定', async () => {
    // 手动插入一条协议 OK 但从未评分的候选（不经过 scoutCandidates，模拟"曾入库但超出评分 limit 未被评"的历史行）
    ctx.db.prepare(`
      INSERT INTO candidates (repo, url, description, license, license_ok, stars, last_commit, status)
      VALUES ('chatwoot/chatwoot', 'https://github.com/chatwoot/chatwoot', null, 'MIT', 1, 100, null, 'candidate')
    `).run()
    const before: any = ctx.db.prepare("SELECT score FROM candidates WHERE repo = 'chatwoot/chatwoot'").get()
    expect(before.score).toBeNull()
    const r = await cleanupCandidates(ctx, { threshold: 50 })
    expect(r.rescored).toBe(1)
    const after: any = ctx.db.prepare("SELECT score FROM candidates WHERE repo = 'chatwoot/chatwoot'").get()
    expect(after.score).not.toBeNull() // 补评分后一定有分数（chatwoot fixture README 信息丰富，mock 启发式分数会较高，不会被后续阈值判定淘汰）
    expect(after.score).toBeGreaterThanOrEqual(50)
  })

  it('单个候选补评分失败不中断整批：其余候选仍正常清理', async () => {
    await scoutCandidates(ctx)
    // 插入一条 repo 不在 fixtures 里的候选（mock 的 fetchReadme 对未知 repo 返回空串 ''，
    // rescoreCandidate 不会抛错——用一条真实会抛错的场景：repo 本身在 candidates 表里但已被删除的场景不易构造，
    // 这里改用「readme 为空」验证 rescoreCandidate 对未知 repo 是 fail-soft（返回低分而非抛错），
    // 顺带验证 cleanupCandidates 处理完这条后其它候选依旧被正确判定
    ctx.db.prepare(`
      INSERT INTO candidates (repo, url, description, license, license_ok, stars, last_commit, status)
      VALUES ('unknown/not-in-fixtures', 'https://github.com/unknown/not-in-fixtures', null, 'MIT', 1, 10, null, 'candidate')
    `).run()
    ctx.db.prepare("UPDATE candidates SET score = 30 WHERE repo = 'formbricks/formbricks'").run()
    const r = await cleanupCandidates(ctx, { threshold: 50 })
    expect(r.rescored).toBeGreaterThanOrEqual(1) // unknown repo 也会被"补评分"尝试（不抛错，只是分数低）
    const low: any = ctx.db.prepare("SELECT status FROM candidates WHERE repo = 'formbricks/formbricks'").get()
    expect(low.status).toBe('dismissed') // 不受 unknown repo 那条影响，正常判定
  })
})
```

同时把文件顶部 import 改成加 `cleanupCandidates`：

```ts
import { addRepo, backfillCategories, candidatesNeedingRescore, cleanupCandidates, scoutCandidates } from '../src/scout'
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/scout && npx vitest run test/scout.test.ts -t "cleanupCandidates"`
Expected: FAIL（`cleanupCandidates` 未从 `../src/scout` 导出，报 import 找不到该名字）

- [ ] **Step 3: 实现 `cleanupCandidates`**

在 `packages/scout/src/scout.ts` 里，`rescoreCandidate` 函数定义结束之后（`backfillCategories` 定义之前）插入：

```ts
/** 候选池低分自动淘汰：先给协议可商用但从未评过分的候选补评分（复用 rescoreCandidate），
 *  再把补评分后仍低于阈值的标记为 status='dismissed'（不删除、只改状态，保留记录可查）。
 *  单个候选补评分失败不中断整批——跳过该条，留到下次自动清理再补。 */
export async function cleanupCandidates(
  ctx: CoreCtx,
  opts: { threshold?: number } = {},
): Promise<{ rescored: number; dismissed: number }> {
  const threshold = opts.threshold ?? 50
  const unscored = ctx.db.prepare(
    "SELECT id FROM candidates WHERE license_ok = 1 AND status = 'candidate' AND score IS NULL",
  ).all() as Array<{ id: number }>
  let rescored = 0
  for (const { id } of unscored) {
    try {
      await rescoreCandidate(ctx, id)
      rescored++
    } catch { /* 单个候选补评分失败：跳过，留到下次自动清理再补 */ }
  }
  const low = ctx.db.prepare(
    "SELECT id FROM candidates WHERE license_ok = 1 AND status = 'candidate' AND score < ?",
  ).all(threshold) as Array<{ id: number }>
  const dismiss = ctx.db.prepare("UPDATE candidates SET status = 'dismissed' WHERE id = ?")
  for (const { id } of low) dismiss.run(id)
  return { rescored, dismissed: low.length }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd packages/scout && npx vitest run test/scout.test.ts`
Expected: PASS（全部用例，含新加的 4 条 `cleanupCandidates` 用例）

- [ ] **Step 5: Commit**

```bash
cd "/Users/lizhishaoniange/Documents/开源变现内容工厂"
git add packages/scout/src/scout.ts packages/scout/test/scout.test.ts
git commit -m "feat(scout): 新增 cleanupCandidates 低分候选自动淘汰"
```

---

### Task 4: runAutoScout 接入 cleanupCandidates（scheduler.ts + 测试）

**Files:**
- Modify: `packages/server/src/scheduler.ts`
- Test: `packages/server/test/scheduler.test.ts`

**Interfaces:**
- Consumes: `cleanupCandidates(ctx: CoreCtx, opts?: { threshold?: number }): Promise<{ rescored: number; dismissed: number }>`（Task 3 产出，从 `@forgecast/scout` 导入）
- Produces: `runAutoScout` 签名新增第三个可选参数 `cleanup`（依赖注入，供测试打桩），`auto_scout_last_result` JSON 新增 `rescored`/`dismissed`（成功时）或 `cleanupError`（清理失败时）字段。

**关键约束**：清理阶段失败不能掩盖抓取阶段的成功结果——`r`（抓取结果）必须始终写入 `auto_scout_last_result`，清理失败只追加 `cleanupError`，不覆盖/丢弃 `found`/`scored`/`rejected`/`added`。

- [ ] **Step 1: 检查 `@forgecast/scout` 包导出**

先确认 `cleanupCandidates` 已经从 `packages/scout/src/index.ts`（包的公开导出入口）导出，`packages/server` 才能 `import { cleanupCandidates } from '@forgecast/scout'`：

Run: `grep -n "scoutCandidates\|cleanupCandidates" "/Users/lizhishaoniange/Documents/开源变现内容工厂/packages/scout/src/index.ts"`

若 `cleanupCandidates` 没出现在该文件里，在 `index.ts` 里找到 `export { ..., scoutCandidates, ... } from './scout'`（或类似的具名导出行）那一行，把 `cleanupCandidates` 加进同一个导出列表（和 `scoutCandidates` 挨着，从同一个 `./scout` 模块导出）。

- [ ] **Step 2: 写失败测试——成功路径带 rescored/dismissed**

在 `packages/server/test/scheduler.test.ts` 的 `describe('runAutoScout', ...)` 块内追加：

```ts
  it('成功：cleanup 结果合并进 last_result（rescored/dismissed）', async () => {
    await runAutoScout(
      ctx,
      async () => ({ found: 5, scored: 2, rejected: 1, added: 2 }),
      async () => ({ rescored: 3, dismissed: 1 }),
    )
    const s = getAllSettings(ctx.db)
    const result = JSON.parse(s.auto_scout_last_result!)
    expect(result).toMatchObject({ added: 2, rescored: 3, dismissed: 1 })
  })
  it('清理失败：抓取结果（found/added）仍保留，附加 cleanupError', async () => {
    await runAutoScout(
      ctx,
      async () => ({ found: 5, scored: 2, rejected: 1, added: 2 }),
      async () => { throw new Error('清理挂了') },
    )
    const s = getAllSettings(ctx.db)
    const result = JSON.parse(s.auto_scout_last_result!)
    expect(result).toMatchObject({ found: 5, added: 2 })
    expect(result.cleanupError).toMatch(/清理挂了/)
  })
```

- [ ] **Step 3: 跑测试确认失败**

Run: `cd packages/server && npx vitest run test/scheduler.test.ts -t "cleanup"`
Expected: FAIL（`runAutoScout` 目前只接受两个参数，第三个 `cleanup` 参数不存在，TS 编译错误或运行时被忽略导致 `result` 里没有 `rescored`/`dismissed`/`cleanupError` 字段，断言失败）

- [ ] **Step 4: 改 `runAutoScout` 实现**

`packages/server/src/scheduler.ts` 顶部 import 加 `cleanupCandidates`：

```ts
import { cleanupCandidates, scoutCandidates } from '@forgecast/scout'
```

`ScoutFn` 类型定义下方新增 `CleanupFn` 类型：

```ts
type ScoutFn = (ctx: CoreCtx, opts: { onlyNew: boolean }) => Promise<{ found: number; scored: number; rejected: number; added: number }>
type CleanupFn = (ctx: CoreCtx, opts: { threshold?: number }) => Promise<{ rescored: number; dismissed: number }>
```

`runAutoScout` 整个函数体替换为：

```ts
/** 跑一次每日抓取（onlyNew）+ 低分候选自动清理。失败也把 last_run 标为今天——整天每分钟重试只会连续打限流，次日再试。
 *  清理阶段单独 try/catch：清理失败不能掩盖抓取本身的成功结果，last_result 里 found/added 等字段始终保留，
 *  清理失败只追加 cleanupError。 */
export async function runAutoScout(
  ctx: CoreCtx,
  scout: ScoutFn = scoutCandidates,
  cleanup: CleanupFn = cleanupCandidates,
): Promise<void> {
  const started = new Date()
  try {
    const r = await scout(ctx, { onlyNew: true })
    let cleanupResult: { rescored: number; dismissed: number } | { cleanupError: string }
    try {
      cleanupResult = await cleanup(ctx, { threshold: 50 })
    } catch (err) {
      cleanupResult = { cleanupError: err instanceof Error ? err.message : String(err) }
    }
    setSettings(ctx.db, {
      auto_scout_last_run: localDate(started),
      auto_scout_last_result: JSON.stringify({ at: started.toISOString(), ...r, ...cleanupResult }),
    })
    console.log(`[forgecast] 每日自动抓取完成：发现 ${r.found}，新增 ${r.added}`)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    setSettings(ctx.db, {
      auto_scout_last_run: localDate(started),
      auto_scout_last_result: JSON.stringify({ at: started.toISOString(), error: msg }),
    })
    console.error(`[forgecast] ⚠ 每日自动抓取失败：${msg}（明天自动重试）`)
  }
}
```

（只有函数签名的第三个参数和 try 块内部变了，catch 块——抓取本身失败的分支——原样不动。）

- [ ] **Step 5: 跑测试确认通过**

Run: `cd packages/server && npx vitest run test/scheduler.test.ts`
Expected: PASS（全部用例，包含原有的 `runAutoScout`/`startAutoScout` 用例——它们没传 `cleanup` 参数，会走默认值 `cleanupCandidates`，属于真实集成路径，需要确认这些原有用例仍然通过：例如"默认走真 scoutCandidates（mock 全链路）：候选入库"这条不会因为新增的默认清理步骤报错）

- [ ] **Step 6: Commit**

```bash
cd "/Users/lizhishaoniange/Documents/开源变现内容工厂"
git add packages/server/src/scheduler.ts packages/server/test/scheduler.test.ts packages/scout/src/index.ts
git commit -m "feat(server): runAutoScout 接入低分候选自动清理"
```

---

### Task 5: CandidateCard 显示中文简介

**Files:**
- Modify: `apps/web/src/pages/board/CandidateCard.tsx`

**Interfaces:**
- Consumes: `ScoreDetail.summaryZh`（Task 1 产出，通过 `score_detail` JSON 字符串传到前端，前端自己的 `Detail`/`parseDetail` 是独立的解析实现，不共享后端类型）

- [ ] **Step 1: 改 `Detail` 接口加 `summaryZh`**

`apps/web/src/pages/board/CandidateCard.tsx` 里 `Detail` 接口：

```ts
export interface Detail {
  rebrandCost: number; buyerClarity: number; visualAppeal: number
  rationale: string; targetBuyer: string; painPoint: string
  summaryZh: string
  category: string
}
```

- [ ] **Step 2: 改 `parseDetail` 解析 `summaryZh`**

`parseDetail` 函数里 `return` 对象加一行（用文件里已有的 `str()` 兜底函数）：

```ts
export function parseDetail(sd: string | null): Detail | null {
  if (!sd) return null
  try {
    const o = JSON.parse(sd)
    return {
      rebrandCost: num(o.rebrandCost), buyerClarity: num(o.buyerClarity), visualAppeal: num(o.visualAppeal),
      rationale: str(o.rationale), targetBuyer: str(o.targetBuyer), painPoint: str(o.painPoint),
      summaryZh: str(o.summaryZh),
      category: str(o.category),
    }
  } catch { return null }
}
```

- [ ] **Step 3: 改卡片描述行**

把这一行：

```tsx
      <div className="line-clamp-2 min-h-[2.5rem] text-xs leading-relaxed text-sub">{c.description ?? ''}</div>
```

改成：

```tsx
      <div className="line-clamp-2 min-h-[2.5rem] text-xs leading-relaxed text-sub">{d?.summaryZh || c.description || ''}</div>
```

- [ ] **Step 4: 类型检查**

Run: `cd "/Users/lizhishaoniange/Documents/开源变现内容工厂" && pnpm --filter web exec tsc --noEmit`
Expected: 无新增类型错误（`Detail`/`parseDetail` 改动前后字段都齐全，`d?.summaryZh` 是 `string`，`||` 短路对 `string | null` 的 `c.description` 类型兼容）

- [ ] **Step 5: Commit**

```bash
cd "/Users/lizhishaoniange/Documents/开源变现内容工厂"
git add apps/web/src/pages/board/CandidateCard.tsx
git commit -m "feat(web): 候选卡片优先显示中文简介，回落英文原文"
```

---

### Task 6: ScoutPage 过滤已淘汰候选 + 只读折叠区

**Files:**
- Modify: `apps/web/src/pages/ScoutPage.tsx`

**Interfaces:**
- Consumes: `Candidate.status`（已存在于 `apps/web/src/api.ts:79` 的 `Candidate` interface，`status: string`，无需改类型定义）

- [ ] **Step 1: 改 `ok`/新增 `dismissed` 派生列表**

`apps/web/src/pages/ScoutPage.tsx` 第 113-114 行：

```ts
  const ok = rows.filter((c) => c.license_ok === 1)
  const blocked = rows.filter((c) => c.license_ok !== 1)
```

改成：

```ts
  const ok = rows.filter((c) => c.license_ok === 1 && c.status !== 'dismissed')
  const blocked = rows.filter((c) => c.license_ok !== 1)
  const dismissed = rows.filter((c) => c.license_ok === 1 && c.status === 'dismissed')
```

（`ok` 是"全部"/"已收藏"/"每日新增"三个 tab 共同的派生基础，改这一处三个 tab 自动都排除已淘汰候选，不用逐个 tab 改。）

- [ ] **Step 2: 加只读折叠区**

在现有"另有 N 个协议不可商用"折叠区（`tab === 'all'` 分支里，`{blocked.length > 0 && (...)}` 那一块，大约在文件的 192-204 行）后面，紧跟着加一个结构相同的折叠区：

```tsx
          {blocked.length > 0 && (
            <details className="rounded-lg bg-transparent border-[1.5px] border-hairline p-3 text-sm text-sub">
              <summary className="cursor-pointer">另有 {blocked.length} 个协议不可商用（GPL/AGPL 系），点开查看</summary>
              <div className="mt-2 space-y-1">
                {blocked.map((c) => (
                  <div key={c.id} className="flex gap-2 text-xs">
                    <a className="text-sub" href={c.url} target="_blank" rel="noreferrer">{c.repo}</a>
                    <span className="text-faint">{c.license ?? '无协议'}</span>
                  </div>
                ))}
              </div>
            </details>
          )}
          {dismissed.length > 0 && (
            <details className="rounded-lg bg-transparent border-[1.5px] border-hairline p-3 text-sm text-sub">
              <summary className="cursor-pointer">另有 {dismissed.length} 个已淘汰（低分），点开查看</summary>
              <div className="mt-2 space-y-1">
                {dismissed.map((c) => (
                  <div key={c.id} className="flex gap-2 text-xs">
                    <a className="text-sub" href={c.url} target="_blank" rel="noreferrer">{c.repo}</a>
                    <span className="text-faint">{c.score ?? '—'} 分</span>
                  </div>
                ))}
              </div>
            </details>
          )}
```

- [ ] **Step 3: 类型检查**

Run: `cd "/Users/lizhishaoniange/Documents/开源变现内容工厂" && pnpm --filter web exec tsc --noEmit`
Expected: 无新增类型错误

- [ ] **Step 4: 浏览器人工走查**

1. `export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH"`
2. 手动把某个协议 OK 的候选在 DB 里改成低分再改状态验证展示，或者等下一次真实"抓取候选"+后续 Task 3/4 的清理逻辑跑一轮自然产生 `dismissed` 数据：
   `sqlite3 db/forgecast.db "UPDATE candidates SET status='dismissed' WHERE repo='formbricks/formbricks'"`（若该 repo 存在于本地库，用任意一个 license_ok=1 的候选替代）
3. `pnpm dev` 启动，浏览器打开找项目页，确认："全部" tab 候选总数减少（该候选从卡片网格消失）、页面下方出现"另有 1 个已淘汰（低分），点开查看"折叠区，点开能看到 repo 名 + 分数 + GitHub 外链。
4. 确认"每日新增"/"已收藏" tab 也不会出现这个已淘汰的候选（如果它本来会落在这两个 tab 的筛选条件里）。
5. 测试完把该行 UPDATE 回 `status='candidate'`（不留测试脏数据）：
   `sqlite3 db/forgecast.db "UPDATE candidates SET status='candidate' WHERE repo='formbricks/formbricks'"`

- [ ] **Step 5: Commit**

```bash
cd "/Users/lizhishaoniange/Documents/开源变现内容工厂"
git add apps/web/src/pages/ScoutPage.tsx
git commit -m "feat(web): 找项目页过滤已淘汰候选 + 已淘汰只读折叠区"
```

---

## 验证（全部任务完成后）

1. `export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH"`
2. `pnpm test` 全仓回归（重点看 `@forgecast/scout`、`@forgecast/server`）
3. `pnpm --filter web exec tsc --noEmit` + `pnpm --filter web build`
4. 浏览器端到端：`pnpm dev` → 找项目页 → 点"全部重新评分"，确认重新评分后的候选卡片描述行显示中文（mock 模式下会是空串回落英文，若想看到真实中文效果需要 `live` LLM 模式——当前项目按用户决定保持 mock，此步骤在 mock 下只需确认"不报错、正常回落英文"即可，不强求看到中文）。
5. 手动跑一次 `runAutoScout`（例如通过 CLI 或临时脚本调用，或直接等下一次每日调度触发）确认 `auto_scout_last_result` 里出现 `rescored`/`dismissed` 字段（`sqlite3 db/forgecast.db "SELECT value FROM settings WHERE key='auto_scout_last_result'"`）。
