# 需求×项目匹配 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 对单条需求信号一键「找项目」：LLM 生成搜索关键词 → GitHub 现搜 → wheelScore 规则评分排序 → LLM 生成轻资产商业模式建议 → 落 `demand_matches` 表，Web 卡片内嵌展示并可一键入候选池。

**Architecture:** 全部新逻辑放 `packages/demand/src/match.ts`，复用 `@forgecast/scout` 的 `createGithubClient`/`isLicenseOk` 与 `@forgecast/tailor` 的 `wheelScore`（纯函数，不改这两个包）。两次 LLM 调用各一个提示词模板，mock 走 fixture 绝不调 ctx.llm。

**Tech Stack:** TypeScript + better-sqlite3 + Hono + React/Vite + vitest（全沿用现状）。

**Spec:** `docs/superpowers/specs/2026-08-14-demand-match-design.md`

## Global Constraints

- 每个命令前先 `export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH"`。
- mock 模式绝不调用 `ctx.llm`（fixture 直接返回固定数据）——仓库铁律。
- `demand-match-plan.md` 提示词必须含真实感红线：bizPlan 不编造任何数字。
- LLM#2 输出校验（repo 在本批、bizMode 在枚举、bizPlan 非空）——任一非法整批抛错，事务写表不留脏数据；status→matched 也在同一事务内。
- 不动 `packages/scout` / `packages/tailor` 任何代码（只 import）。
- 测试全部用 `fs.mkdtempSync` 临时目录建库；GitHub client 用注入的假 client（`opts.gh`），测试不发真实网络请求。
- 提交信息结尾带 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`。

---

### Task 1: demand_matches 表 + match.ts + fixture + 两个提示词模板

**Files:**
- Modify: `packages/core/src/db.ts`（`demand_signals` 建表语句之后、`CREATE VIRTUAL TABLE ... atoms_fts` 之前插入）
- Modify: `packages/demand/package.json`（dependencies 补 `"@forgecast/scout": "workspace:*"` 与 `"@forgecast/tailor": "workspace:*"`）
- Create: `packages/demand/src/match.ts`
- Create: `packages/demand/src/fixtures/match-fixture.ts`
- Modify: `packages/demand/src/index.ts`（补 `export * from './match'`）
- Create: `templates/prompts/demand-match-keywords.md`
- Create: `templates/prompts/demand-match-plan.md`
- Create: `packages/demand/test/match.test.ts`

**Interfaces:**
- Consumes: `@forgecast/scout` 的 `createGithubClient(cfg)`/`isLicenseOk(spdx)`/`GithubClient`/`RepoMeta`；`@forgecast/tailor` 的 `wheelScore(meta, keywords)`；`demand_signals` 表。
- Produces: `matchSignal(ctx, signalId, opts?: {onProgress?, gh?}) => Promise<{matched: number}>`；`listMatches(ctx, signalId) => DemandMatch[]`；类型 `DemandMatch`/`BizMode`/`MatchPlanDraft`。

- [ ] **Step 1: db.ts 加表**

在 `demand_signals` 的建表语句之后插入：

```sql
CREATE TABLE IF NOT EXISTS demand_matches (
  id INTEGER PRIMARY KEY,
  signal_id INTEGER REFERENCES demand_signals(id),
  repo TEXT NOT NULL,
  url TEXT NOT NULL,
  description TEXT,
  license TEXT,
  license_ok INTEGER,
  stars INTEGER,
  last_commit TEXT,
  score REAL,
  score_detail TEXT,
  biz_mode TEXT,
  biz_plan TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
```

- [ ] **Step 2: package.json 补依赖 + pnpm install**

`packages/demand/package.json` dependencies 改为：

```json
  "dependencies": {
    "@forgecast/core": "workspace:*",
    "@forgecast/scout": "workspace:*",
    "@forgecast/tailor": "workspace:*"
  },
```

Run: `pnpm install`

- [ ] **Step 3: 写失败测试**

`packages/demand/test/match.test.ts`：

```ts
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createLlmClient, loadConfig, openDb, type CoreCtx } from '@forgecast/core'
import type { GithubClient, RepoMeta } from '@forgecast/scout'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { listMatches, matchSignal } from '../src/match'
import { importSignals, listSignals } from '../src/signals'

let ctx: CoreCtx
let root: string
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-dmatch-'))
  const config = loadConfig(root, {}) // llm mock
  ctx = { db: openDb(config.paths.db), config, llm: createLlmClient(config.llm) }
  importSignals(ctx, { source: 'douyin_hot', signals: [{ title: '用AI给朋友做专属小游戏', summary: 'AI 定制小游戏送礼', heat: 9 }] })
})

function meta(repo: string, stars: number, daysAgo = 10): RepoMeta {
  return {
    repo, url: `https://github.com/${repo}`, description: `${repo} game generator`,
    license: 'MIT', stars, lastCommit: new Date(Date.now() - daysAgo * 86400000).toISOString(), topics: [],
  }
}
function fakeGh(repos: RepoMeta[]): GithubClient {
  return {
    searchRepos: async () => [], searchByKeywords: async () => repos,
    fetchReadme: async () => '', fetchTree: async () => [],
  }
}
function sigId(): number { return listSignals(ctx)[0].id }

describe('matchSignal mock', () => {
  it('全流程：搜 8 个取 top5、按 score 降序落库、status→matched、不调 ctx.llm', async () => {
    const repos = Array.from({ length: 8 }, (_, i) => meta(`o/r${i}`, (i + 1) * 500))
    const spy = vi.spyOn(ctx.llm, 'complete')
    const r = await matchSignal(ctx, sigId(), { gh: fakeGh(repos) })
    expect(r.matched).toBe(5)
    expect(spy).not.toHaveBeenCalled()
    const rows = listMatches(ctx, sigId())
    expect(rows).toHaveLength(5)
    expect(rows[0].score).toBeGreaterThanOrEqual(rows[4].score)
    expect(rows[0].biz_plan.length).toBeGreaterThan(0)
    expect(['shop', 'custom', 'both']).toContain(rows[0].biz_mode)
    expect(listSignals(ctx)[0].status).toBe('matched')
  })
  it('搜索 0 结果：不写表、status 不变、matched=0', async () => {
    const r = await matchSignal(ctx, sigId(), { gh: fakeGh([]) })
    expect(r.matched).toBe(0)
    expect(listMatches(ctx, sigId())).toHaveLength(0)
    expect(listSignals(ctx)[0].status).toBe('new')
  })
  it('重复匹配删旧插新', async () => {
    await matchSignal(ctx, sigId(), { gh: fakeGh([meta('a/x', 100)]) })
    await matchSignal(ctx, sigId(), { gh: fakeGh([meta('b/y', 200)]) })
    const rows = listMatches(ctx, sigId())
    expect(rows).toHaveLength(1)
    expect(rows[0].repo).toBe('b/y')
  })
  it('信号不存在抛错', async () => {
    await expect(matchSignal(ctx, 9999, { gh: fakeGh([]) })).rejects.toThrow(/不存在/)
  })
})

describe('matchSignal live（假 LLM）', () => {
  it('LLM#2 输出非法 bizMode → 整批抛错、表无脏数据、status 不变', async () => {
    const config = loadConfig(root, { FORGECAST_LLM_MODE: 'live', FORGECAST_LLM_KEY: 'k' })
    config.paths.templates = path.resolve(__dirname, '../../../templates')
    const complete = vi.fn()
      .mockResolvedValueOnce(JSON.stringify({ keywords: ['game', 'generator'] }))
      .mockResolvedValueOnce(JSON.stringify([{ repo: 'a/x', bizMode: 'bogus', bizPlan: 'x' }]))
    const lctx: CoreCtx = { db: ctx.db, config, llm: { complete } as any }
    await expect(matchSignal(lctx, sigId(), { gh: fakeGh([meta('a/x', 100)]) })).rejects.toThrow(/非法/)
    expect(listMatches(ctx, sigId())).toHaveLength(0)
    expect(listSignals(ctx)[0].status).toBe('new')
  })
  it('LLM 合法输出 → 正常落库', async () => {
    const config = loadConfig(root, { FORGECAST_LLM_MODE: 'live', FORGECAST_LLM_KEY: 'k' })
    config.paths.templates = path.resolve(__dirname, '../../../templates')
    const complete = vi.fn()
      .mockResolvedValueOnce(JSON.stringify({ keywords: ['game'] }))
      .mockResolvedValueOnce(JSON.stringify([{ repo: 'a/x', bizMode: 'custom', bizPlan: '接单定制小游戏交付' }]))
    const lctx: CoreCtx = { db: ctx.db, config, llm: { complete } as any }
    const r = await matchSignal(lctx, sigId(), { gh: fakeGh([meta('a/x', 100)]) })
    expect(r.matched).toBe(1)
    expect(listMatches(ctx, sigId())[0].biz_mode).toBe('custom')
  })
})
```

- [ ] **Step 4: 跑测试确认失败**

Run: `pnpm --filter @forgecast/demand test`
Expected: FAIL（match.ts 不存在）

- [ ] **Step 5: 实现 fixture**

`packages/demand/src/fixtures/match-fixture.ts`：

```ts
import type { DemandSignal } from '../signals'

export interface MatchPlanDraft { repo: string; bizMode: 'shop' | 'custom' | 'both'; bizPlan: string }

/** mock 关键词：title+opportunity 简单切词取前 3，切不出则兜底固定词。绝不调用 ctx.llm（仓库铁律）。 */
export function mockMatchKeywords(signal: Pick<DemandSignal, 'title' | 'opportunity'>): string[] {
  const words = `${signal.title} ${signal.opportunity ?? ''}`
    .split(/[\s，。、：:；;（）()/|·]+/).map((w) => w.trim()).filter((w) => w.length >= 2)
  return words.length ? words.slice(0, 3) : ['open', 'source']
}

/** mock 商业模式建议：每个 repo 固定 both + 占位话术。 */
export function mockMatchPlans(repos: string[]): MatchPlanDraft[] {
  return repos.map((repo) => ({
    repo, bizMode: 'both' as const,
    bizPlan: '可开店卖标准化交付，也可私域接单做定制（mock 示例）',
  }))
}
```

- [ ] **Step 6: 实现 match.ts**

`packages/demand/src/match.ts`：

```ts
import fs from 'node:fs'
import path from 'node:path'
import type { CoreCtx } from '@forgecast/core'
import { createGithubClient, isLicenseOk, type GithubClient } from '@forgecast/scout'
import { wheelScore } from '@forgecast/tailor'
import { mockMatchKeywords, mockMatchPlans, type MatchPlanDraft } from './fixtures/match-fixture'
import type { DemandSignal } from './signals'

export type { MatchPlanDraft } from './fixtures/match-fixture'

export type BizMode = 'shop' | 'custom' | 'both'
const BIZ_MODES: BizMode[] = ['shop', 'custom', 'both']

export interface DemandMatch {
  id: number
  signal_id: number
  repo: string
  url: string
  description: string | null
  license: string | null
  license_ok: number
  stars: number
  last_commit: string | null
  score: number
  /** JSON 串：WheelScoreDetail，自行解析 */
  score_detail: string
  biz_mode: BizMode
  biz_plan: string
  created_at: string
}

/** 剥 ```json 围栏 */
function stripFence(raw: string): string {
  return raw.trim().replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/```\s*$/, '').trim()
}

function parseKeywordsJson(raw: string): string[] {
  const v = JSON.parse(stripFence(raw))
  const arr = Array.isArray(v) ? v : v?.keywords
  if (!Array.isArray(arr) || !arr.length) throw new Error('关键词输出不是非空数组')
  return arr.map(String).map((s) => s.trim()).filter(Boolean).slice(0, 5)
}

function parsePlansJson(raw: string): MatchPlanDraft[] {
  const arr = JSON.parse(stripFence(raw))
  if (!Array.isArray(arr)) throw new Error('建议输出不是数组')
  return arr
}

/**
 * 对单条需求信号「找项目」：LLM 生成搜索关键词 → GitHub 现搜（perPage 8）→ wheelScore
 * 规则评分排序取 top5 → LLM 逐项目生成轻资产商业模式建议 → 事务写 demand_matches
 * （同信号删旧插新）+ 信号 status→matched。搜索 0 结果时不写表不改 status。
 * mock 模式两次 LLM 调用都走 fixture，绝不调 ctx.llm。`opts.gh` 可注入假 client（测试用）。
 */
export async function matchSignal(
  ctx: CoreCtx, signalId: number,
  opts: { onProgress?: (msg: string) => void; gh?: GithubClient } = {},
): Promise<{ matched: number }> {
  const { onProgress = () => {} } = opts
  const signal = ctx.db.prepare('SELECT * FROM demand_signals WHERE id = ?').get(signalId) as DemandSignal | undefined
  if (!signal) throw new Error(`信号不存在: #${signalId}`)

  onProgress('生成搜索关键词…')
  let keywords: string[]
  if (ctx.config.llm.mode === 'mock') {
    keywords = mockMatchKeywords(signal)
  } else {
    const tpl = fs.readFileSync(path.join(ctx.config.paths.templates, 'prompts', 'demand-match-keywords.md'), 'utf8')
    const system = '你是开源项目搜索专家，只输出给定 JSON 结构，不要多余文字。'
    const prompt = [tpl, `【需求信号】\n标题：${signal.title}\n说明：${signal.summary ?? ''}\n可承接方向：${signal.opportunity ?? ''}`].join('\n\n---\n\n')
    keywords = parseKeywordsJson(await ctx.llm.complete({ model: ctx.config.llm.models.analysis, system, prompt }))
  }
  onProgress(`关键词：${keywords.join(' / ')}`)

  onProgress('搜索 GitHub…')
  const gh = opts.gh ?? createGithubClient(ctx.config.github)
  const repos = await gh.searchByKeywords(keywords, { perPage: 8 })
  if (!repos.length) {
    onProgress('没搜到合适项目，换个信号或稍后再试')
    return { matched: 0 }
  }

  const scored = repos
    .map((meta) => ({ meta, ...wheelScore(meta, keywords) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)

  onProgress(`为 ${scored.length} 个项目生成商业模式建议…`)
  let plans: MatchPlanDraft[]
  if (ctx.config.llm.mode === 'mock') {
    plans = mockMatchPlans(scored.map((s) => s.meta.repo))
  } else {
    const tpl = fs.readFileSync(path.join(ctx.config.paths.templates, 'prompts', 'demand-match-plan.md'), 'utf8')
    const system = '你是轻资产商业模式顾问，只输出给定 JSON 结构，不要多余文字。'
    const repoBlock = scored.map((s) => `- ${s.meta.repo}（${s.meta.stars} star, ${s.meta.license ?? '无协议'}）：${s.meta.description ?? ''}`).join('\n')
    const prompt = [
      tpl,
      `【需求信号】\n标题：${signal.title}\n说明：${signal.summary ?? ''}\n可承接方向：${signal.opportunity ?? ''}`,
      `【候选项目】\n${repoBlock}`,
    ].join('\n\n---\n\n')
    plans = parsePlansJson(await ctx.llm.complete({ model: ctx.config.llm.models.analysis, system, prompt }))
  }

  // 校验：repo 在本批、bizMode 在枚举、bizPlan 非空——任一非法整批抛错，不写脏数据
  const repoSet = new Set(scored.map((s) => s.meta.repo))
  const planMap = new Map<string, MatchPlanDraft>()
  for (const p of plans) {
    const bad: string[] = []
    if (!repoSet.has(p.repo)) bad.push('repo')
    if (!BIZ_MODES.includes(p.bizMode)) bad.push('bizMode')
    if (typeof p.bizPlan !== 'string' || !p.bizPlan.trim()) bad.push('bizPlan')
    if (bad.length) throw new Error(`建议结果非法（${bad.join('、')}）: ${JSON.stringify(p)}`)
    planMap.set(p.repo, p)
  }

  onProgress('写入匹配结果…')
  const ins = ctx.db.prepare(`
    INSERT INTO demand_matches (signal_id, repo, url, description, license, license_ok, stars, last_commit, score, score_detail, biz_mode, biz_plan)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  let inserted = 0
  const tx = ctx.db.transaction(() => {
    ctx.db.prepare('DELETE FROM demand_matches WHERE signal_id = ?').run(signalId)
    for (const s of scored) {
      const p = planMap.get(s.meta.repo)
      if (!p) continue // LLM 少给某个 repo 的建议：跳过该条，不算整体失败
      ins.run(
        signalId, s.meta.repo, s.meta.url, s.meta.description ?? null, s.meta.license ?? null,
        isLicenseOk(s.meta.license) ? 1 : 0, s.meta.stars, s.meta.lastCommit ?? null,
        s.score, JSON.stringify(s.detail), p.bizMode, p.bizPlan,
      )
      inserted++
    }
    ctx.db.prepare("UPDATE demand_signals SET status = 'matched' WHERE id = ?").run(signalId)
  })
  tx()
  onProgress(`匹配完成：${inserted} 个项目`)
  return { matched: inserted }
}

export function listMatches(ctx: CoreCtx, signalId: number): DemandMatch[] {
  return ctx.db.prepare('SELECT * FROM demand_matches WHERE signal_id = ? ORDER BY score DESC, id').all(signalId) as DemandMatch[]
}
```

`packages/demand/src/index.ts` 改为：

```ts
export * from './signals'
export * from './extract'
export * from './match'
```

- [ ] **Step 7: 两个提示词模板**

`templates/prompts/demand-match-keywords.md`：

```markdown
你是开源项目搜索专家。根据下方需求信号，生成 3-5 个适合在 GitHub 搜索开源项目的关键词。

【要求】
- 优先英文技术词（GitHub 搜索对英文更友好），中文概念转译成对应英文（如"头像生成"→ avatar generator）
- 关键词面向"能承接这个需求的工具/系统/模板"，不是信号原文复述
- 只输出 JSON，不要任何其他文字：{"keywords": ["...", "..."]}
```

`templates/prompts/demand-match-plan.md`：

```markdown
你是轻资产商业模式顾问。下方是一条需求信号和一批候选开源项目，请为每个候选项目给出承接这个需求的轻资产商业模式建议。

【模式定义】
- shop（开店卖货）：标准化交付，做成可复制售卖的产品/服务（模板/成品/电商上架）
- custom（私人定制）：服务型交付，私域接单一对一定制
- both：两者皆可

【输出格式】只输出 JSON 数组，不要任何其他文字，repo 必须来自候选列表：
[{ "repo": "<owner/name>", "bizMode": "shop|custom|both", "bizPlan": "<两三句：怎么用这个项目承接该需求、交付形态是什么、为什么这个需求配这个项目>" }]

【真实感红线】bizPlan 不得编造市场规模/销量/收入/价格等任何数字，只写模式与交付思路。
```

- [ ] **Step 8: 跑测试确认通过 + 全仓回归 + 提交**

Run: `pnpm --filter @forgecast/demand test`（预期 3 个测试文件共 15 条全绿：signals 5 + extract 4 + match 6）
Run: `pnpm test`（全仓回归）

```bash
git add packages/core/src/db.ts packages/demand templates/prompts/demand-match-keywords.md templates/prompts/demand-match-plan.md pnpm-lock.yaml
git commit -m "feat(demand): matchSignal 需求×项目匹配（GitHub 现搜+wheelScore+商业模式建议）

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: CLI match/matches 子命令

**Files:**
- Modify: `cli.ts`（demand case 内追加两个分支 + usage 串更新）

**Interfaces:**
- Consumes: Task 1 的 `matchSignal`/`listMatches`。

- [ ] **Step 1: 改 import 与 case**

`cli.ts` 的 `@forgecast/demand` import 行改为：

```ts
import { extractSignals, importSignals, listMatches, listSignals, matchSignal, requestCollect, setSignalStatus } from '@forgecast/demand'
```

demand case 的 usage 串改为：

```ts
      const usage = '用法: forgecast demand <import|list|extract|star|dismiss|request|match|matches>'
```

在 `} else if (sub === 'request') {` 分支之前插入：

```ts
      } else if (sub === 'match') {
        const id = rest.filter((a) => !a.startsWith('--'))[1]
        if (!id) { console.error('用法: forgecast demand match <id>'); process.exit(1) }
        const { matched } = await matchSignal(ctx, Number(id), { onProgress: (m) => console.log(`  ${m}`) })
        console.log(`匹配完成：${matched} 个项目`)
      } else if (sub === 'matches') {
        const id = rest.filter((a) => !a.startsWith('--'))[1]
        if (!id) { console.error('用法: forgecast demand matches <id>'); process.exit(1) }
        const rows = listMatches(ctx, Number(id))
        console.log(`信号 #${id} 匹配 ${rows.length} 条:`)
        for (const m of rows) {
          console.log(`  ${m.repo} ★${m.stars} [${m.license ?? '-'}] ${m.score}分 ${m.biz_mode}\n      ↳ ${m.biz_plan}`)
        }
```

- [ ] **Step 2: 真实冒烟（live，产品数据保留）**

对真实库里一条 starred/已有信号跑一次（会真调 LLM 两次 + GitHub 搜索一次，已授权）：

```bash
pnpm exec tsx cli.ts demand list --status=starred   # 找一条 starred 信号的 id（当前 #1）
pnpm exec tsx cli.ts demand match 1
pnpm exec tsx cli.ts demand matches 1
```

Expected: 匹配出真实项目并打印建议；这是产品数据，**不清理**。若 GitHub 搜索限流失败，等 1 分钟重试一次；仍失败则改用 mock 验证（`FORGECAST_LLM_MODE=mock pnpm exec tsx cli.ts demand match 1` 不可行——settings 表优先级高于 env，直接在报告里注明限流即可，不阻塞提交）。

- [ ] **Step 3: 提交**

```bash
git add cli.ts
git commit -m "feat(cli): demand match/matches 子命令

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: server 两个路由

**Files:**
- Modify: `packages/server/src/app.ts`（demand 路由块内追加）
- Modify: `packages/server/test/demand.test.ts`（追加用例）

**Interfaces:**
- Produces: `POST /api/demand/signals/:id/match`（任务队列 `{taskId}`）、`GET /api/demand/signals/:id/matches`。

- [ ] **Step 1: 追加失败测试**

`packages/server/test/demand.test.ts` 末尾（最后一个 `it` 之后、`})` 之前）追加：

```ts
  it('match 任务（mock github+llm）→ matches 列表非空、信号 status=matched', async () => {
    await app.request('/api/demand/import', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'xhs', signals: [{ title: '在线客服系统需求' }] }),
    })
    const [s] = await (await app.request('/api/demand/signals')).json() as any[]
    const { taskId } = await (await app.request(`/api/demand/signals/${s.id}/match`, { method: 'POST' })).json() as any
    await runTask(taskId)
    const matches = await (await app.request(`/api/demand/signals/${s.id}/matches`)).json() as any[]
    expect(matches.length).toBeGreaterThan(0)
    expect(matches[0].repo).toBeTruthy()
    expect(matches[0].biz_plan).toBeTruthy()
    const [after] = await (await app.request('/api/demand/signals')).json() as any[]
    expect(after.status).toBe('matched')
  })
  it('match 不存在的信号 → 任务失败', async () => {
    const { taskId } = await (await app.request('/api/demand/signals/9999/match', { method: 'POST' })).json() as any
    await expect(runTask(taskId)).rejects.toThrow(/不存在/)
  })
```

（mock 模式下 `createGithubClient` 的 `searchByKeywords` 返回 candidateFixtures，确定性、不发网络。）

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @forgecast/server exec vitest run test/demand.test.ts`
Expected: 新增 2 条 FAIL（404）

- [ ] **Step 3: 实现路由**

`packages/server/src/app.ts`：demand import 行补 `listMatches, matchSignal`（合并进现有 `@forgecast/demand` import）。`app.get('/api/demand/collect-status', ...)` 之后追加：

```ts
  app.post('/api/demand/signals/:id/match', (c) => {
    const id = Number(c.req.param('id'))
    const taskId = queue.enqueue((log) => matchSignal(ctx, id, { onProgress: log }))
    return c.json({ taskId })
  })
  app.get('/api/demand/signals/:id/matches', (c) => c.json(listMatches(ctx, Number(c.req.param('id')))))
```

- [ ] **Step 4: 跑测试确认通过 + 提交**

Run: `pnpm --filter @forgecast/server exec vitest run test/demand.test.ts`（6 条全绿）

```bash
git add packages/server/src/app.ts packages/server/test/demand.test.ts
git commit -m "feat(server): /api/demand/signals/:id/match 与 matches 路由

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Web 界面（找项目按钮 + 匹配结果展开区 + 入候选池）

**Files:**
- Modify: `apps/web/src/api.ts`（`DemandCollectStatus` 之后追加类型）
- Modify: `apps/web/src/pages/DemandPage.tsx`（信号卡片抽成 SignalCard 子组件并加匹配功能）

**Interfaces:**
- Consumes: Task 3 的两个路由 + 已有 `POST /api/candidates/add`（body `{url}`，任务队列）。

- [ ] **Step 1: api.ts 补类型**

`DemandCollectStatus` 接口之后追加：

```ts
/** 需求×项目匹配结果（demand_matches 行）。score_detail 是 JSON 串自行解析 */
export interface DemandMatch {
  id: number; signal_id: number; repo: string; url: string; description: string | null
  license: string | null; license_ok: number; stars: number; last_commit: string | null
  score: number; score_detail: string; biz_mode: 'shop' | 'custom' | 'both'; biz_plan: string
  created_at: string
}
```

- [ ] **Step 2: DemandPage 改造**

`apps/web/src/pages/DemandPage.tsx` 整体结构调整：卡片渲染抽成同文件内 `SignalCard` 子组件（含匹配状态/展开区），`DemandPage` 主体的筛选/采集/提炼逻辑不变。完整新文件内容：

```tsx
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { api, subscribeTask, type DemandCollectStatus, type DemandMatch, type DemandSignal } from '../api'

const KIND_CHIPS = [
  { value: '', label: '全部' },
  { value: 'traffic', label: '热点流量' },
  { value: 'emotional', label: '情绪价值' },
  { value: 'supply', label: '供给热度' },
]
const SOURCE_LABELS: Record<string, string> = {
  douyin_hot: '抖音热点', xhs: '小红书', github_trending: 'GitHub', ecommerce: '电商榜单',
}
const KIND_LABELS: Record<string, string> = { traffic: '热点流量', emotional: '情绪价值', supply: '供给热度' }
const BIZ_LABELS: Record<string, string> = { shop: '开店卖货', custom: '私人定制', both: '皆可' }

/** evidence JSON 里挖出 http 链接（对象值/数组元素里的字符串），最多取 2 条 */
function evidenceLinks(evidence: string | null): string[] {
  if (!evidence) return []
  try {
    const v = JSON.parse(evidence)
    const strs = (Array.isArray(v) ? v : Object.values(v as Record<string, unknown>))
      .filter((x): x is string => typeof x === 'string' && x.startsWith('http'))
    return strs.slice(0, 2)
  } catch { return [] }
}

/** 匹配结果单行：repo 元数据 + 模式徽章 + 建议 + 入候选池（任务队列，per-row busy） */
function MatchRow({ m }: { m: DemandMatch }) {
  const [adding, setAdding] = useState(false)
  const [added, setAdded] = useState(false)
  async function addToPool() {
    if (adding || added) return
    setAdding(true)
    try {
      const { taskId } = await api<{ taskId: string }>('/api/candidates/add', {
        method: 'POST', body: JSON.stringify({ url: m.url }),
      })
      subscribeTask(taskId, (e) => {
        if (e.type === 'done' || e.type === 'error') {
          setAdding(false)
          if (e.type === 'error') alert('入池失败：' + e.message)
          else setAdded(true)
        }
      })
    } catch (err) {
      setAdding(false)
      alert('入池失败：' + (err instanceof Error ? err.message : String(err)))
    }
  }
  return (
    <div className="space-y-1 border-t border-hairline pt-2">
      <div className="flex items-center justify-between gap-2">
        <a className="truncate text-sm font-bold text-fire" href={m.url} target="_blank" rel="noreferrer">{m.repo}</a>
        <div className="flex shrink-0 items-center gap-1.5 text-xs text-sub">
          <span>★{m.stars}</span>
          <span>{m.license ?? '无协议'}</span>
          <span>{Math.round(m.score)}分</span>
          <span className="rounded-full bg-fire-soft px-2 py-0.5 font-bold text-fire">{BIZ_LABELS[m.biz_mode]}</span>
        </div>
      </div>
      {m.description && <div className="truncate text-xs text-faint">{m.description}</div>}
      <div className="text-sm">{m.biz_plan}</div>
      <button className="btn-ink px-2 py-0.5 text-xs disabled:opacity-50" disabled={adding || added} onClick={addToPool}>
        {added ? '已入候选池' : adding ? '入池中…' : '入候选池'}
      </button>
    </div>
  )
}

/** 单张需求信号卡片：状态操作 + 找项目（任务队列+SSE）+ 匹配结果展开区 */
function SignalCard({ s, onStatus }: { s: DemandSignal; onStatus: (id: number, status: string) => void }) {
  const qc = useQueryClient()
  const [matching, setMatching] = useState(false)
  const [open, setOpen] = useState(s.status === 'matched')
  const matches = useQuery({
    queryKey: ['demand-matches', s.id],
    queryFn: () => api<DemandMatch[]>(`/api/demand/signals/${s.id}/matches`),
    enabled: s.status === 'matched',
  })
  async function runMatch() {
    if (matching) return
    setMatching(true)
    try {
      const { taskId } = await api<{ taskId: string }>(`/api/demand/signals/${s.id}/match`, { method: 'POST' })
      subscribeTask(taskId, (e) => {
        if (e.type === 'done' || e.type === 'error') {
          setMatching(false)
          qc.invalidateQueries({ queryKey: ['demand'] })
          qc.invalidateQueries({ queryKey: ['demand-matches', s.id] })
          if (e.type === 'error') alert('匹配失败：' + e.message)
          else setOpen(true)
        }
      })
    } catch (err) {
      setMatching(false)
      alert('匹配失败：' + (err instanceof Error ? err.message : String(err)))
    }
  }
  return (
    <div className={`card-forge space-y-2 p-3 ${s.status === 'dismissed' ? 'opacity-50' : ''}`}>
      <div className="flex items-start justify-between gap-2">
        <div className={`font-bold ${s.status === 'starred' ? 'text-fire' : ''}`}>{s.title}</div>
        <div className="flex shrink-0 items-center gap-1.5">
          <button className="btn-fire px-2 py-0.5 text-xs disabled:opacity-50" disabled={matching} onClick={runMatch}>
            {matching ? '匹配中…' : s.status === 'matched' ? '重新匹配' : '找项目'}
          </button>
          {s.status !== 'starred' && s.status !== 'matched' && (
            <button className="btn-ink px-2 py-0.5 text-xs" onClick={() => onStatus(s.id, 'starred')}>看好</button>
          )}
          {s.status !== 'dismissed' && (
            <button className="rounded-md border-[1.5px] border-hairline px-2 py-0.5 text-xs text-sub"
              onClick={() => onStatus(s.id, 'dismissed')}>忽略</button>
          )}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs text-sub">
        <span className="rounded-full border-[1.5px] border-hairline px-2 py-0.5">{SOURCE_LABELS[s.source] ?? s.source}</span>
        {s.kind && <span className="rounded-full border-[1.5px] border-hairline px-2 py-0.5">{KIND_LABELS[s.kind]}</span>}
        {s.heat != null && <span>热度 {s.heat}</span>}
        {s.status === 'starred' && <span className="rounded-full bg-fire-soft px-2 py-0.5 font-bold text-fire">已看好</span>}
        {s.status === 'matched' && <span className="rounded-full bg-fire-soft px-2 py-0.5 font-bold text-fire">已匹配</span>}
      </div>
      {s.summary && <div className="text-sm text-sub">{s.summary}</div>}
      {s.opportunity && <div className="border-t border-hairline pt-2 text-sm">💡 {s.opportunity}</div>}
      {evidenceLinks(s.evidence).map((url) => (
        <a key={url} className="block truncate text-xs text-fire" href={url} target="_blank" rel="noreferrer">{url}</a>
      ))}
      {s.status === 'matched' && (
        <button className="text-xs text-sub underline" onClick={() => setOpen(!open)}>
          {open ? '收起匹配结果' : `展开匹配结果（${matches.data?.length ?? '…'}）`}
        </button>
      )}
      {open && matches.data?.map((m) => <MatchRow key={m.id} m={m} />)}
    </div>
  )
}

export default function DemandPage() {
  const qc = useQueryClient()
  const [kind, setKind] = useState('')
  const [extracting, setExtracting] = useState(false)
  const signals = useQuery({
    queryKey: ['demand', kind],
    queryFn: () => api<DemandSignal[]>(`/api/demand/signals${kind ? `?kind=${kind}` : ''}`),
  })
  const collect = useQuery({ queryKey: ['demand-collect'], queryFn: () => api<DemandCollectStatus>('/api/demand/collect-status') })
  const setStatus = useMutation({
    mutationFn: ({ id, status }: { id: number; status: string }) =>
      api(`/api/demand/signals/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['demand'] }),
  })
  const requestCollect = useMutation({
    mutationFn: () => api('/api/demand/request-collect', { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['demand-collect'] }),
  })

  async function extract() {
    if (extracting) return
    setExtracting(true)
    try {
      const { taskId } = await api<{ taskId: string }>('/api/demand/extract', { method: 'POST' })
      subscribeTask(taskId, (e) => {
        if (e.type === 'done' || e.type === 'error') {
          setExtracting(false)
          qc.invalidateQueries({ queryKey: ['demand'] })
          if (e.type === 'error') alert('提炼失败：' + e.message)
        }
      })
    } catch (err) {
      setExtracting(false)
      alert('提炼失败：' + (err instanceof Error ? err.message : String(err)))
    }
  }

  const pendingCount = (signals.data ?? []).filter((s) => !s.kind).length
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {KIND_CHIPS.map((k) => (
          <button key={k.value}
            className={`rounded-full border-[1.5px] px-3 py-1 text-sm ${kind === k.value ? 'border-fire bg-fire-soft font-bold text-fire' : 'border-hairline text-sub'}`}
            onClick={() => setKind(k.value)}>{k.label}</button>
        ))}
        <div className="ml-auto flex items-center gap-3">
          <span className="text-xs text-faint">
            {collect.data?.requestedAt
              ? `待采集（请求于 ${collect.data.requestedAt.slice(0, 16).replace('T', ' ')}）`
              : collect.data?.lastCollectedAt
                ? `上次采集：${collect.data.lastCollectedAt.slice(0, 16).replace('T', ' ')}`
                : '从未采集'}
          </span>
          <button className="btn-ink px-3 py-1 text-sm" onClick={() => requestCollect.mutate()}>请求采集</button>
          <button className="btn-fire px-3 py-1 text-sm disabled:opacity-50" disabled={extracting || pendingCount === 0} onClick={extract}>
            {extracting ? '提炼中…' : `提炼分类${pendingCount ? `（${pendingCount} 条待分）` : ''}`}
          </button>
        </div>
      </div>
      {signals.data?.length === 0 && (
        <div className="text-sm text-faint">暂无需求信号。点「请求采集」打标记，然后在对话里喊 Claude 用 ego-browser 采一轮。</div>
      )}
      <div className="grid grid-cols-2 gap-4 2xl:grid-cols-3">
        {signals.data?.map((s) => (
          <SignalCard key={s.id} s={s} onStatus={(id, status) => setStatus.mutate({ id, status })} />
        ))}
      </div>
    </div>
  )
}
```

- [ ] **Step 3: 类型/构建验证 + 提交**

Run: `pnpm --filter web exec tsc --noEmit && pnpm --filter web build`

```bash
git add apps/web/src/api.ts apps/web/src/pages/DemandPage.tsx
git commit -m "feat(web): 需求信号卡片加找项目按钮+匹配结果展开区+入候选池

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: README + 全仓回归

**Files:**
- Modify: `README.md`

- [ ] **Step 1: README**

CLI 段的 `forgecast demand ...` 行更新为包含 match/matches：

```
forgecast demand <import|list|extract|star|dismiss|request|match|matches>  # 需求信号库：agent 会话内 ego-browser 采集后导入、LLM 分类提炼、star 标记看好；match=对单条信号 GitHub 现搜+评分+轻资产商业模式建议（开店卖货/私人定制），Web 端信号卡片可一键找项目/入候选池
```

- [ ] **Step 2: 全仓回归 + 提交**

Run: `pnpm test && pnpm --filter web exec tsc --noEmit && pnpm --filter web build`

```bash
git add README.md
git commit -m "docs: README 补 demand match 需求×项目匹配说明

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## 端到端验证（实施完成后，主会话手动执行）

1. 重启 dev server。
2. 浏览器进 `/scout?tab=demand`：对一条真实信号（如 starred 的 `cathrynlavery/diagram-design` 或抖音的"用AI给朋友做个专属小游戏"）点「找项目」→ SSE 完成后卡片展开匹配结果：真实 GitHub 项目、star/协议/评分、模式徽章、建议文本无编造数字。
3. 点一条匹配的「入候选池」→ 切到项目池 tab 确认该候选出现（含评分）。
4. `forgecast demand matches <id>` CLI 输出与页面一致。
5. 真实匹配结果保留（产品数据）；仅清理测试造的假数据（若有）。
