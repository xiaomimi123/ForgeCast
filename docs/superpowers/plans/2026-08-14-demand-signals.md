# 需求信号库 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增"需求信号库"板块——采集需求侧信号（热点流量/情绪价值/供给热度）入库、LLM 分类提炼、找项目页加需求信号 tab，为后续"需求×项目匹配"提供数据地基。

**Architecture:** 新包 `packages/demand`（同构于 `packages/topics`）：signals CRUD/upsert + extract LLM 分类；`demand_signals` 单表；采集本身不写任何代码（agent 会话内用 ego-browser 人工触发采集后经 CLI/API 导入）；Web 端 ScoutPage 外套 ?tab= 壳（同 MarketPage 模式）。

**Tech Stack:** TypeScript + better-sqlite3 + Hono + React/Vite + vitest（全部沿用仓库现状）。

**Spec:** `docs/superpowers/specs/2026-08-14-demand-signals-design.md`

## Global Constraints

- 每个命令前先 `export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH"`（better-sqlite3 ABI 需要 Node 22）。
- 系统代码里零抓取逻辑——不引入任何 HTTP 抓取/浏览器自动化依赖；采集由 agent 会话完成后导入。
- mock 模式绝不调用 `ctx.llm`（fixture 直接返回固定数据）——仓库既有铁律。
- `demand-extract.md` 提示词必须包含真实感红线：opportunity 不编造数字。
- settings 表的 `demand_collect_requested_at` / `demand_last_collected_at` 两个键**直接用 SQL 写**，不加入 `SETTING_KEYS` 白名单（那是用户配置项的 PUT 白名单，采集标记不属于它）。
- 不动 `packages/topics` 任何代码。
- 测试全部用 `fs.mkdtempSync` 临时目录建库，不碰真实 `db/forgecast.db`。
- 提交信息结尾带 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`。

---

### Task 1: demand_signals 表 + packages/demand 包骨架（signals.ts）

**Files:**
- Modify: `packages/core/src/db.ts`（`CREATE VIRTUAL TABLE ... atoms_fts` 行之前插入建表语句）
- Create: `packages/demand/package.json`
- Create: `packages/demand/src/index.ts`
- Create: `packages/demand/src/signals.ts`
- Create: `packages/demand/test/signals.test.ts`
- Modify: `package.json`（根，dependencies 加 `"@forgecast/demand": "workspace:*"`，紧邻 `"@forgecast/topics"` 行）
- Modify: `packages/server/package.json`（dependencies 同上加一行）

**Interfaces:**
- Produces: `importSignals(ctx, {source, signals}) => {imported, updated}`；`listSignals(ctx, filter?) => DemandSignal[]`；`setSignalStatus(ctx, id, status)`；`requestCollect(ctx)`；`collectStatus(ctx) => {requestedAt, lastCollectedAt}`；类型 `DemandSignal` / `DemandSource` / `DemandKind` / `DemandStatus` / `RawSignal`。

- [ ] **Step 1: db.ts 加表**

在 `packages/core/src/db.ts` 的 `CREATE VIRTUAL TABLE IF NOT EXISTS atoms_fts` 行之前插入：

```sql
CREATE TABLE IF NOT EXISTS demand_signals (
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL,
  kind TEXT,
  title TEXT NOT NULL,
  summary TEXT,
  evidence TEXT,
  heat REAL,
  opportunity TEXT,
  status TEXT DEFAULT 'new',
  captured_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(source, title)
);
```

- [ ] **Step 2: 包骨架**

`packages/demand/package.json`（照抄 topics 的结构）：

```json
{
  "name": "@forgecast/demand",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "scripts": { "test": "vitest run --passWithNoTests" },
  "dependencies": { "@forgecast/core": "workspace:*" },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.11",
    "@types/node": "^20.11.0",
    "vitest": "^2.1.0"
  }
}
```

`packages/demand/src/index.ts`（本任务只导出 signals，Task 2 再补 extract 行）：

```ts
export * from './signals'
```

- [ ] **Step 3: 写失败测试**

`packages/demand/test/signals.test.ts`：

```ts
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createLlmClient, loadConfig, openDb, type CoreCtx } from '@forgecast/core'
import { beforeEach, describe, expect, it } from 'vitest'
import { collectStatus, importSignals, listSignals, requestCollect, setSignalStatus } from '../src/signals'

let ctx: CoreCtx
beforeEach(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-demand-'))
  const config = loadConfig(root, {})
  ctx = { db: openDb(config.paths.db), config, llm: createLlmClient(config.llm) }
})

describe('importSignals', () => {
  it('批量入库；同 (source,title) 重复导入为更新且保留 kind/status', () => {
    const r1 = importSignals(ctx, { source: 'douyin_hot', signals: [
      { title: '热点A', summary: '说明A', heat: 90, evidence: { url: 'https://x.com/a' } },
      { title: '热点B', heat: 80 },
    ] })
    expect(r1).toEqual({ imported: 2, updated: 0 })
    // 手工标记 kind/status 模拟 extract+star 后再重复导入
    ctx.db.prepare("UPDATE demand_signals SET kind = 'traffic', status = 'starred' WHERE title = '热点A'").run()
    const r2 = importSignals(ctx, { source: 'douyin_hot', signals: [{ title: '热点A', heat: 95 }] })
    expect(r2).toEqual({ imported: 0, updated: 1 })
    const a = listSignals(ctx).find((s) => s.title === '热点A')!
    expect(a.heat).toBe(95)
    expect(a.kind).toBe('traffic') // upsert 不覆盖 kind
    expect(a.status).toBe('starred') // 不覆盖 status
  })
  it('未知 source 抛错；空 title 跳过', () => {
    expect(() => importSignals(ctx, { source: 'nope' as any, signals: [] })).toThrow(/未知数据源/)
    const r = importSignals(ctx, { source: 'xhs', signals: [{ title: '  ' }, { title: '正常' }] })
    expect(r.imported).toBe(1)
  })
  it('导入成功清除采集请求标记并记录采集时间', () => {
    requestCollect(ctx)
    expect(collectStatus(ctx).requestedAt).toBeTruthy()
    importSignals(ctx, { source: 'github_trending', signals: [{ title: 'repo/x' }] })
    const s = collectStatus(ctx)
    expect(s.requestedAt).toBeNull()
    expect(s.lastCollectedAt).toBeTruthy()
  })
})

describe('listSignals / setSignalStatus', () => {
  it('按 source/kind/status 筛选，heat 降序（NULL 排后）', () => {
    importSignals(ctx, { source: 'xhs', signals: [{ title: '低', heat: 1 }, { title: '高', heat: 9 }, { title: '无热度' }] })
    const all = listSignals(ctx)
    expect(all.map((s) => s.title)).toEqual(['高', '低', '无热度'])
    expect(listSignals(ctx, { source: 'douyin_hot' })).toEqual([])
    setSignalStatus(ctx, all[0].id, 'starred')
    expect(listSignals(ctx, { status: 'starred' }).map((s) => s.title)).toEqual(['高'])
  })
  it('setSignalStatus：非法状态/不存在 id 抛错', () => {
    importSignals(ctx, { source: 'xhs', signals: [{ title: 'x' }] })
    const id = listSignals(ctx)[0].id
    expect(() => setSignalStatus(ctx, id, 'bogus' as any)).toThrow(/非法状态/)
    expect(() => setSignalStatus(ctx, 9999, 'starred')).toThrow(/不存在/)
  })
})
```

- [ ] **Step 4: 跑测试确认失败**

Run: `pnpm install && pnpm --filter @forgecast/demand test`
Expected: FAIL（signals.ts 不存在）

- [ ] **Step 5: 实现 signals.ts**

`packages/demand/src/signals.ts`：

```ts
import type { CoreCtx } from '@forgecast/core'

export type DemandSource = 'douyin_hot' | 'xhs' | 'github_trending' | 'ecommerce'
export type DemandKind = 'traffic' | 'emotional' | 'supply'
export type DemandStatus = 'new' | 'starred' | 'dismissed' | 'matched'
export const DEMAND_SOURCES: DemandSource[] = ['douyin_hot', 'xhs', 'github_trending', 'ecommerce']
const STATUSES: DemandStatus[] = ['new', 'starred', 'dismissed', 'matched']

export interface DemandSignal {
  id: number
  source: DemandSource
  kind: DemandKind | null
  title: string
  summary: string | null
  /** JSON 串：链接/热度值/榜位等原始证据，自行解析 */
  evidence: string | null
  heat: number | null
  opportunity: string | null
  status: DemandStatus
  captured_at: string | null
  created_at: string
}

export interface RawSignal { title: string; summary?: string; evidence?: unknown; heat?: number }

/** settings 表直接写（采集标记不是用户配置项，不走 SETTING_KEYS 白名单） */
function setMeta(ctx: CoreCtx, key: string, value: string): void {
  ctx.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value)
}
function getMeta(ctx: CoreCtx, key: string): string | null {
  return (ctx.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? null
}

/**
 * 批量 upsert 一批采集到的原始信号（agent 会话内用 ego-browser 采集后导入，本函数不做任何抓取）。
 * 同 (source, title) 重复导入视为更新：summary/evidence/heat/captured_at 覆盖，
 * kind/opportunity/status 保留（分类和人工标记不被重复采集冲掉）。
 * 导入成功即清除「请求采集」标记并记录本次采集时间。
 */
export function importSignals(ctx: CoreCtx, input: { source: DemandSource; signals: RawSignal[] }): { imported: number; updated: number } {
  if (!DEMAND_SOURCES.includes(input.source)) throw new Error(`未知数据源: ${input.source}`)
  const now = new Date().toISOString()
  const findExisting = ctx.db.prepare('SELECT id FROM demand_signals WHERE source = ? AND title = ?')
  const upsert = ctx.db.prepare(`
    INSERT INTO demand_signals (source, title, summary, evidence, heat, captured_at)
    VALUES (@source, @title, @summary, @evidence, @heat, @captured_at)
    ON CONFLICT(source, title) DO UPDATE SET
      summary = excluded.summary, evidence = excluded.evidence,
      heat = excluded.heat, captured_at = excluded.captured_at
  `)
  let imported = 0
  let updated = 0
  for (const s of input.signals) {
    if (!s.title?.trim()) continue
    const exists = findExisting.get(input.source, s.title)
    upsert.run({
      source: input.source, title: s.title, summary: s.summary ?? null,
      evidence: s.evidence !== undefined ? JSON.stringify(s.evidence) : null,
      heat: s.heat ?? null, captured_at: now,
    })
    if (exists) updated++
    else imported++
  }
  setMeta(ctx, 'demand_last_collected_at', now)
  ctx.db.prepare("DELETE FROM settings WHERE key = 'demand_collect_requested_at'").run()
  return { imported, updated }
}

export function listSignals(ctx: CoreCtx, filter: { source?: string; kind?: string; status?: string } = {}): DemandSignal[] {
  const conds: string[] = []
  const args: string[] = []
  if (filter.source) { conds.push('source = ?'); args.push(filter.source) }
  if (filter.kind) { conds.push('kind = ?'); args.push(filter.kind) }
  if (filter.status) { conds.push('status = ?'); args.push(filter.status) }
  const where = conds.length ? ` WHERE ${conds.join(' AND ')}` : ''
  return ctx.db.prepare(`SELECT * FROM demand_signals${where} ORDER BY (heat IS NULL), heat DESC, id DESC`).all(...args) as DemandSignal[]
}

export function setSignalStatus(ctx: CoreCtx, id: number, status: DemandStatus): void {
  if (!STATUSES.includes(status)) throw new Error(`非法状态: ${status}`)
  const r = ctx.db.prepare('UPDATE demand_signals SET status = ? WHERE id = ?').run(status, id)
  if (r.changes === 0) throw new Error(`信号不存在: #${id}`)
}

/** Web「请求采集」按钮打标记；agent 会话导入后自动清除（见 importSignals） */
export function requestCollect(ctx: CoreCtx): void {
  setMeta(ctx, 'demand_collect_requested_at', new Date().toISOString())
}

export function collectStatus(ctx: CoreCtx): { requestedAt: string | null; lastCollectedAt: string | null } {
  return {
    requestedAt: getMeta(ctx, 'demand_collect_requested_at'),
    lastCollectedAt: getMeta(ctx, 'demand_last_collected_at'),
  }
}
```

本任务的 `packages/demand/src/index.ts` 只写：

```ts
export * from './signals'
```

- [ ] **Step 6: 跑测试确认通过**

Run: `pnpm --filter @forgecast/demand test`
Expected: PASS（6 条）

- [ ] **Step 7: 全仓回归 + 提交**

Run: `pnpm test`
Expected: 全绿（新表建在 db.ts，所有开库的测试都会隐式覆盖建表语句合法性）

```bash
git add packages/core/src/db.ts packages/demand package.json packages/server/package.json pnpm-lock.yaml
git commit -m "feat(demand): demand_signals 表 + packages/demand 包（导入/列表/状态/采集标记）

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: extract.ts（LLM 分类提炼）+ fixture + 提示词模板

**Files:**
- Create: `packages/demand/src/extract.ts`
- Create: `packages/demand/src/fixtures/demand-fixture.ts`
- Create: `templates/prompts/demand-extract.md`
- Modify: `packages/demand/src/index.ts`（补 `export * from './extract'`）
- Create: `packages/demand/test/extract.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `DemandKind`、`demand_signals` 表。
- Produces: `extractSignals(ctx, opts?: { batch?: number; onProgress?: (msg: string) => void }): Promise<number>`（返回更新条数）；`DemandExtractDraft` 类型。

- [ ] **Step 1: 写失败测试**

`packages/demand/test/extract.test.ts`：

```ts
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createLlmClient, loadConfig, openDb, type CoreCtx } from '@forgecast/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { extractSignals } from '../src/extract'
import { importSignals, listSignals } from '../src/signals'

let ctx: CoreCtx
let root: string
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-dext-'))
  const config = loadConfig(root, {}) // llm mock
  ctx = { db: openDb(config.paths.db), config, llm: createLlmClient(config.llm) }
})

describe('extractSignals mock', () => {
  it('给 kind 为空的信号填 kind+opportunity，不调 ctx.llm；已分类的不动', async () => {
    importSignals(ctx, { source: 'douyin_hot', signals: [{ title: 'A' }, { title: 'B' }] })
    ctx.db.prepare("UPDATE demand_signals SET kind = 'supply', opportunity = '既有' WHERE title = 'B'").run()
    const spy = vi.spyOn(ctx.llm, 'complete')
    const n = await extractSignals(ctx)
    expect(n).toBe(1)
    expect(spy).not.toHaveBeenCalled()
    const a = listSignals(ctx).find((s) => s.title === 'A')!
    expect(a.kind).toBeTruthy()
    expect(a.opportunity).toBeTruthy()
    expect(listSignals(ctx).find((s) => s.title === 'B')!.opportunity).toBe('既有')
  })
  it('没有待分类信号 → 返回 0 不调 LLM', async () => {
    expect(await extractSignals(ctx)).toBe(0)
  })
})

describe('extractSignals live（假 LLM）', () => {
  function liveCtx(completeImpl: () => Promise<string>): CoreCtx {
    const config = loadConfig(root, { FORGECAST_LLM_MODE: 'live', FORGECAST_LLM_KEY: 'k' })
    config.paths.templates = path.resolve(__dirname, '../../../templates')
    return { db: ctx.db, config, llm: { complete: vi.fn(completeImpl) } as any }
  }
  it('合法 JSON → 回写 kind/opportunity', async () => {
    importSignals(ctx, { source: 'xhs', signals: [{ title: 'C' }] })
    const id = listSignals(ctx)[0].id
    const lctx = liveCtx(async () => JSON.stringify([{ id, kind: 'emotional', opportunity: '可做情绪陪伴类定制' }]))
    expect(await extractSignals(lctx)).toBe(1)
    expect(listSignals(ctx)[0].kind).toBe('emotional')
  })
  it('非法输出（错 id/错 kind/空 opportunity）→ 整批抛错不写脏数据', async () => {
    importSignals(ctx, { source: 'xhs', signals: [{ title: 'D' }] })
    const lctx = liveCtx(async () => JSON.stringify([{ id: 9999, kind: 'traffic', opportunity: 'x' }]))
    await expect(extractSignals(lctx)).rejects.toThrow(/非法/)
    expect(listSignals(ctx)[0].kind).toBeNull() // 没被写脏
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @forgecast/demand test`
Expected: FAIL（extract.ts 不存在）

- [ ] **Step 3: 实现 fixture**

`packages/demand/src/fixtures/demand-fixture.ts`：

```ts
export interface DemandExtractDraft { id: number; kind: 'traffic' | 'emotional' | 'supply'; opportunity: string }

const KINDS = ['traffic', 'emotional', 'supply'] as const

/** mock 固定分类：按序循环 kind，opportunity 固定话术。绝不调用 ctx.llm（仓库铁律）。 */
export function mockDemandExtract(ids: number[]): DemandExtractDraft[] {
  return ids.map((id, i) => ({
    id,
    kind: KINDS[i % KINDS.length],
    opportunity: '可承接：围绕该信号做轻资产定制交付（mock 示例）',
  }))
}
```

- [ ] **Step 4: 实现 extract.ts**

`packages/demand/src/extract.ts`：

```ts
import fs from 'node:fs'
import path from 'node:path'
import type { CoreCtx } from '@forgecast/core'
import { mockDemandExtract, type DemandExtractDraft } from './fixtures/demand-fixture'
import type { DemandKind } from './signals'

export type { DemandExtractDraft } from './fixtures/demand-fixture'

const KINDS: DemandKind[] = ['traffic', 'emotional', 'supply']

/** 剥 ```json 围栏 → JSON.parse（malformed 直接抛）→ 必须是数组。 */
function parseDraftsJson(raw: string): DemandExtractDraft[] {
  const cleaned = raw.trim().replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/```\s*$/, '').trim()
  const arr = JSON.parse(cleaned)
  if (!Array.isArray(arr)) throw new Error('LLM 输出不是数组')
  return arr
}

/**
 * 对 kind 为空的新信号批量分类（traffic/emotional/supply）+ 生成 opportunity（可承接方向）。
 * mock 走固定 fixture / live 调 LLM → 校验（id 必须在本批、kind 在枚举、opportunity 非空，
 * 任一条非法整批抛错不写脏数据）→ 事务回写。返回更新条数。
 */
export async function extractSignals(
  ctx: CoreCtx,
  opts: { batch?: number; onProgress?: (msg: string) => void } = {},
): Promise<number> {
  const { batch = 30, onProgress = () => {} } = opts
  onProgress('筛选未分类信号…')
  const pending = ctx.db.prepare('SELECT id, source, title, summary, heat FROM demand_signals WHERE kind IS NULL ORDER BY id LIMIT ?')
    .all(batch) as Array<{ id: number; source: string; title: string; summary: string | null; heat: number | null }>
  if (!pending.length) { onProgress('没有待分类的信号'); return 0 }

  let drafts: DemandExtractDraft[]
  if (ctx.config.llm.mode === 'mock') {
    onProgress('mock 模式：使用固定分类示例…')
    drafts = mockDemandExtract(pending.map((p) => p.id))
  } else {
    onProgress(`调用大模型分类 ${pending.length} 条信号…`)
    const tpl = fs.readFileSync(path.join(ctx.config.paths.templates, 'prompts', 'demand-extract.md'), 'utf8')
    const system = '你是消费趋势与产品机会分析专家，只输出给定 JSON 结构，不要多余文字。'
    const block = pending.map((p) => `- id=${p.id} [${p.source}] ${p.title}${p.summary ? `：${p.summary}` : ''}${p.heat != null ? `（热度 ${p.heat}）` : ''}`).join('\n')
    const prompt = [tpl, `以下是本批需求信号：\n${block}`].join('\n\n---\n\n')
    drafts = parseDraftsJson(await ctx.llm.complete({ model: ctx.config.llm.models.analysis, system, prompt }))
  }

  const idSet = new Set(pending.map((p) => p.id))
  for (const d of drafts) {
    const bad: string[] = []
    if (!idSet.has(d.id)) bad.push('id')
    if (!KINDS.includes(d.kind)) bad.push('kind')
    if (typeof d.opportunity !== 'string' || !d.opportunity.trim()) bad.push('opportunity')
    if (bad.length) throw new Error(`分类结果非法（${bad.join('、')}）: ${JSON.stringify(d)}`)
  }

  onProgress('写入分类结果…')
  const upd = ctx.db.prepare('UPDATE demand_signals SET kind = ?, opportunity = ? WHERE id = ?')
  const tx = ctx.db.transaction(() => { for (const d of drafts) upd.run(d.kind, d.opportunity, d.id) })
  tx()
  onProgress(`提炼完成：更新 ${drafts.length} 条`)
  return drafts.length
}
```

`packages/demand/src/index.ts` 改为：

```ts
export * from './signals'
export * from './extract'
```

- [ ] **Step 5: 提示词模板**

`templates/prompts/demand-extract.md`：

```markdown
你是消费趋势与产品机会分析专家。下面是一批从抖音热点榜/小红书热门/GitHub Trending/电商榜单采集的原始需求信号，请逐条判断类型并给出可承接的产品方向。

【类型定义】
- traffic（热点流量）：正在爆的话题/事件/流量热点，适合蹭流量做内容或快速上线周边工具
- emotional（情绪价值）：用户为情绪/身份认同/陪伴感买单的产品或话题（如解压、怀旧、宠物拟人、送礼场景）
- supply（供给热度）：开发者生态里正在升温的技术/开源项目（多为 GitHub 来源）

【输出格式】只输出 JSON 数组，不要任何其他文字：
[{ "id": <信号id>, "kind": "traffic|emotional|supply", "opportunity": "<一句话：这个信号可以承接什么轻资产产品方向，从开店卖货或私人定制的视角写>" }]

【真实感红线】opportunity 不得编造市场规模/销量/收入等任何数字，只描述方向和打法。
```

- [ ] **Step 6: 跑测试确认通过 + 提交**

Run: `pnpm --filter @forgecast/demand test`
Expected: PASS（10 条）

```bash
git add packages/demand templates/prompts/demand-extract.md
git commit -m "feat(demand): extractSignals LLM 分类提炼 + mock fixture + 提示词模板

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: CLI `forgecast demand`

**Files:**
- Modify: `cli.ts`

**Interfaces:**
- Consumes: Task 1/2 的 `importSignals`/`listSignals`/`setSignalStatus`/`extractSignals`/`requestCollect`。

- [ ] **Step 1: 加 import**

`cli.ts` 第 12 行 `import { ... } from '@forgecast/topics'` 之后加：

```ts
import { extractSignals, importSignals, listSignals, requestCollect, setSignalStatus } from '@forgecast/demand'
```

- [ ] **Step 2: 加 case**

在 `case 'topics':` 块之后插入：

```ts
    case 'demand': {
      const sub = rest.find((a) => !a.startsWith('--'))
      const ctx = ctxWithNotes()
      const usage = '用法: forgecast demand <import|list|extract|star|dismiss|request>'
      if (sub === 'import') {
        const source = arg('source')
        const file = arg('file')
        if (!source || !file) {
          console.error('用法: forgecast demand import --source=<douyin_hot|xhs|github_trending|ecommerce> --file=<signals.json>')
          process.exit(1)
        }
        const signals = JSON.parse(fs.readFileSync(file, 'utf8'))
        const { imported, updated } = importSignals(ctx, { source: source as any, signals })
        console.log(`导入完成：新增 ${imported} 条，更新 ${updated} 条`)
      } else if (sub === 'list') {
        const rows = listSignals(ctx, { source: arg('source'), kind: arg('kind'), status: arg('status') })
        console.log(`需求信号共 ${rows.length} 条:`)
        for (const s of rows) {
          console.log(`  #${s.id} [${s.source}] ${s.title}${s.kind ? ` (${s.kind})` : ''} — ${s.status}${s.opportunity ? `\n      ↳ ${s.opportunity}` : ''}`)
        }
      } else if (sub === 'extract') {
        const n = await extractSignals(ctx, { onProgress: (m) => console.log(`  ${m}`) })
        console.log(`提炼完成：更新 ${n} 条信号`)
      } else if (sub === 'star' || sub === 'dismiss') {
        const id = rest.filter((a) => !a.startsWith('--'))[1]
        if (!id) { console.error(`用法: forgecast demand ${sub} <id>`); process.exit(1) }
        setSignalStatus(ctx, Number(id), sub === 'star' ? 'starred' : 'dismissed')
        console.log(`#${id} → ${sub === 'star' ? 'starred' : 'dismissed'}`)
      } else if (sub === 'request') {
        requestCollect(ctx)
        console.log('已打「请求采集」标记（下次 agent 会话处理）')
      } else {
        console.error(usage)
        process.exit(1)
      }
      break
    }
```

- [ ] **Step 3: 冒烟验证（临时 JSON，用完即删）**

```bash
echo '[{"title":"冒烟测试信号","heat":1}]' > /tmp/fc-demand-smoke.json
pnpm exec tsx cli.ts demand import --source=xhs --file=/tmp/fc-demand-smoke.json
pnpm exec tsx cli.ts demand list
pnpm exec tsx cli.ts demand extract   # llm mock/live 由 .env 决定；live 会真调一次，能跑通即可
```

Expected: 三条命令都正常输出。然后清理真实库里的冒烟数据：

```bash
sqlite3 db/forgecast.db "DELETE FROM demand_signals WHERE title = '冒烟测试信号';"
sqlite3 db/forgecast.db "DELETE FROM settings WHERE key IN ('demand_collect_requested_at','demand_last_collected_at');"
rm /tmp/fc-demand-smoke.json
```

- [ ] **Step 4: 提交**

```bash
git add cli.ts
git commit -m "feat(cli): demand import/list/extract/star/dismiss/request 子命令

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: server API 路由

**Files:**
- Modify: `packages/server/src/app.ts`
- Create: `packages/server/test/demand.test.ts`

**Interfaces:**
- Produces: `GET /api/demand/signals`、`POST /api/demand/import`、`PATCH /api/demand/signals/:id`、`POST /api/demand/extract`（任务队列）、`POST /api/demand/request-collect`、`GET /api/demand/collect-status`。

- [ ] **Step 1: 写失败测试**

`packages/server/test/demand.test.ts`（beforeEach/runTask 照抄 `test/topics.test.ts` 头部模式，mkdtemp 前缀 `fc-demand-route-`）：

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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-demand-route-'))
  const config = loadConfig(root, {})
  ctx = { db: openDb(config.paths.db), config, llm: createLlmClient(config.llm) }
  queue = createTaskQueue()
  app = createApp(ctx, queue)
})

async function runTask(taskId: string) {
  for (let i = 0; i < 100; i++) {
    await wait(20)
    const s = queue.get(taskId)!.status
    if (s === 'done') return
    if (s === 'failed') throw new Error(queue.get(taskId)!.events.at(-1)!.message)
  }
  throw new Error('任务超时')
}

describe('/api/demand', () => {
  it('import 缺参 → 400；正常导入 → 列表可见', async () => {
    expect((await app.request('/api/demand/import', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(400)
    const r = await (await app.request('/api/demand/import', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'douyin_hot', signals: [{ title: '信号1', heat: 5 }] }),
    })).json() as any
    expect(r).toEqual({ imported: 1, updated: 0 })
    const list = await (await app.request('/api/demand/signals')).json() as any[]
    expect(list).toHaveLength(1)
    expect(list[0].title).toBe('信号1')
  })
  it('PATCH 状态：star 生效；不存在 id → 404', async () => {
    await app.request('/api/demand/import', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'xhs', signals: [{ title: 'x' }] }),
    })
    const [s] = await (await app.request('/api/demand/signals')).json() as any[]
    const ok = await app.request(`/api/demand/signals/${s.id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'starred' }),
    })
    expect(ok.status).toBe(200)
    const starred = await (await app.request('/api/demand/signals?status=starred')).json() as any[]
    expect(starred).toHaveLength(1)
    expect((await app.request('/api/demand/signals/9999', {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'starred' }),
    })).status).toBe(404)
  })
  it('request-collect 打标记 → collect-status 可见；import 后清除', async () => {
    await app.request('/api/demand/request-collect', { method: 'POST' })
    let st = await (await app.request('/api/demand/collect-status')).json() as any
    expect(st.requestedAt).toBeTruthy()
    await app.request('/api/demand/import', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'github_trending', signals: [{ title: 'r/x' }] }),
    })
    st = await (await app.request('/api/demand/collect-status')).json() as any
    expect(st.requestedAt).toBeNull()
    expect(st.lastCollectedAt).toBeTruthy()
  })
  it('extract 任务（mock）→ kind/opportunity 被填', async () => {
    await app.request('/api/demand/import', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'xhs', signals: [{ title: '待分类' }] }),
    })
    const { taskId } = await (await app.request('/api/demand/extract', { method: 'POST' })).json() as any
    await runTask(taskId)
    const [s] = await (await app.request('/api/demand/signals')).json() as any[]
    expect(s.kind).toBeTruthy()
    expect(s.opportunity).toBeTruthy()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @forgecast/server exec vitest run test/demand.test.ts`
Expected: FAIL（路由不存在，404）

- [ ] **Step 3: 实现路由**

`packages/server/src/app.ts`：import 区（`@forgecast/topics` 行之后）加：

```ts
import { collectStatus, extractSignals, importSignals, listSignals, requestCollect, setSignalStatus } from '@forgecast/demand'
```

topics 路由块（`app.post('/api/topics/extract', ...)` ）之后加：

```ts
  // —— 需求信号库（demand）。采集由 agent 会话完成后经 import 导入，服务端零抓取逻辑 ——
  app.get('/api/demand/signals', (c) => {
    const q = c.req.query()
    return c.json(listSignals(ctx, { source: q.source, kind: q.kind, status: q.status }))
  })
  app.post('/api/demand/import', async (c) => {
    const body = await c.req.json().catch(() => ({}))
    if (!body?.source || !Array.isArray(body?.signals)) return c.json({ error: 'source 与 signals 必填' }, 400)
    try {
      return c.json(importSignals(ctx, { source: body.source, signals: body.signals }))
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400)
    }
  })
  app.patch('/api/demand/signals/:id', async (c) => {
    const body = await c.req.json().catch(() => ({}))
    try {
      setSignalStatus(ctx, Number(c.req.param('id')), body.status)
      return c.json({ ok: true })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return c.json({ error: msg }, msg.includes('不存在') ? 404 : 400)
    }
  })
  app.post('/api/demand/extract', (c) => {
    const taskId = queue.enqueue((log) => extractSignals(ctx, { onProgress: log }))
    return c.json({ taskId })
  })
  app.post('/api/demand/request-collect', (c) => {
    requestCollect(ctx)
    return c.json({ ok: true })
  })
  app.get('/api/demand/collect-status', (c) => c.json(collectStatus(ctx)))
```

- [ ] **Step 4: 跑测试确认通过 + 提交**

Run: `pnpm --filter @forgecast/server exec vitest run test/demand.test.ts`
Expected: PASS（4 条）

```bash
git add packages/server/src/app.ts packages/server/test/demand.test.ts
git commit -m "feat(server): /api/demand 六个路由（列表/导入/状态/提炼/采集标记）

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Web 界面（找项目页套 tab + 需求信号页）

**Files:**
- Modify: `apps/web/src/api.ts`（追加类型）
- Create: `apps/web/src/pages/DemandPage.tsx`
- Create: `apps/web/src/pages/ScoutShellPage.tsx`
- Modify: `apps/web/src/App.tsx`（`/scout` 路由指到壳组件）

**Interfaces:**
- Consumes: Task 4 的六个 API。

- [ ] **Step 1: api.ts 补类型**

在 `apps/web/src/api.ts` 的 `BgmList` 接口之后追加：

```ts
/** 需求信号（demand_signals 行）。evidence 是 JSON 串自行解析 */
export interface DemandSignal {
  id: number; source: string; kind: 'traffic' | 'emotional' | 'supply' | null
  title: string; summary: string | null; evidence: string | null; heat: number | null
  opportunity: string | null; status: 'new' | 'starred' | 'dismissed' | 'matched'
  captured_at: string | null; created_at: string
}
export interface DemandCollectStatus { requestedAt: string | null; lastCollectedAt: string | null }
```

- [ ] **Step 2: DemandPage**

`apps/web/src/pages/DemandPage.tsx`：

```tsx
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { api, subscribeTask, type DemandCollectStatus, type DemandSignal } from '../api'

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
          <div key={s.id} className={`card-forge space-y-2 p-3 ${s.status === 'dismissed' ? 'opacity-50' : ''}`}>
            <div className="flex items-start justify-between gap-2">
              <div className={`font-bold ${s.status === 'starred' ? 'text-fire' : ''}`}>{s.title}</div>
              <div className="flex shrink-0 items-center gap-1.5">
                {s.status !== 'starred' && (
                  <button className="btn-ink px-2 py-0.5 text-xs" onClick={() => setStatus.mutate({ id: s.id, status: 'starred' })}>看好</button>
                )}
                {s.status !== 'dismissed' && (
                  <button className="rounded-md border-[1.5px] border-hairline px-2 py-0.5 text-xs text-sub"
                    onClick={() => setStatus.mutate({ id: s.id, status: 'dismissed' })}>忽略</button>
                )}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-xs text-sub">
              <span className="rounded-full border-[1.5px] border-hairline px-2 py-0.5">{SOURCE_LABELS[s.source] ?? s.source}</span>
              {s.kind && <span className="rounded-full border-[1.5px] border-hairline px-2 py-0.5">{KIND_LABELS[s.kind]}</span>}
              {s.heat != null && <span>热度 {s.heat}</span>}
              {s.status === 'starred' && <span className="rounded-full bg-fire-soft px-2 py-0.5 font-bold text-fire">已看好</span>}
            </div>
            {s.summary && <div className="text-sm text-sub">{s.summary}</div>}
            {s.opportunity && <div className="border-t border-hairline pt-2 text-sm">💡 {s.opportunity}</div>}
            {evidenceLinks(s.evidence).map((url) => (
              <a key={url} className="block truncate text-xs text-fire" href={url} target="_blank" rel="noreferrer">{url}</a>
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}
```

- [ ] **Step 3: ScoutShellPage + 路由**

`apps/web/src/pages/ScoutShellPage.tsx`（照抄 MarketPage 壳模式，组件不重写只套壳）：

```tsx
import { useSearchParams } from 'react-router-dom'
import DemandPage from './DemandPage'
import ScoutPage from './ScoutPage'

// 找项目板块：项目池（供给侧）+ 需求信号（需求侧）两个 tab
const TABS = [
  { key: 'pool', label: '项目池' },
  { key: 'demand', label: '需求信号' },
] as const
type TabKey = (typeof TABS)[number]['key']

function normalizeTab(v: string | null): TabKey {
  return v === 'demand' ? 'demand' : 'pool'
}

export default function ScoutShellPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const tab = normalizeTab(searchParams.get('tab'))
  return (
    <div className="space-y-4">
      <div className="seg-tabs">
        {TABS.map((t) => (
          <button key={t.key} className={tab === t.key ? 'on' : ''}
            onClick={() => setSearchParams({ tab: t.key }, { replace: true })}>{t.label}</button>
        ))}
      </div>
      {tab === 'pool' ? <ScoutPage /> : <DemandPage />}
    </div>
  )
}
```

`apps/web/src/App.tsx`：import 区把 `import ScoutPage from './pages/ScoutPage'` 换成 `import ScoutShellPage from './pages/ScoutShellPage'`，`<Route path="/scout" element={<ScoutPage />} />` 换成 `<Route path="/scout" element={<ScoutShellPage />} />`。

（注意：ScoutPage 内部自有一排 seg-tabs（全部/已收藏/每日新增），套壳后会出现两排 tab——与 ProjectDetailPage 的多层 tab 先例一致，可接受，不改 ScoutPage。）

- [ ] **Step 4: 类型/构建验证 + 提交**

Run: `pnpm --filter web exec tsc --noEmit && pnpm --filter web build`
Expected: 无错误

```bash
git add apps/web/src/api.ts apps/web/src/pages/DemandPage.tsx apps/web/src/pages/ScoutShellPage.tsx apps/web/src/App.tsx
git commit -m "feat(web): 找项目页拆项目池/需求信号两个 tab + 需求信号卡片页

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: 文档 + 全仓回归

**Files:**
- Modify: `README.md`

- [ ] **Step 1: README**

- CLI 段（`forgecast topics ...` 附近）加一行：
  `forgecast demand <import|list|extract|star|dismiss|request>  # 需求信号库：agent 会话内 ego-browser 采集后导入、LLM 分类提炼、star 标记看好（后续喂需求×项目匹配）`
- Web 板块描述若提到「找项目」，补一句"含 项目池/需求信号 两个 tab"。

- [ ] **Step 2: 全仓回归**

Run: `pnpm test && pnpm --filter web exec tsc --noEmit && pnpm --filter web build`
Expected: 全绿

- [ ] **Step 3: 提交**

```bash
git add README.md
git commit -m "docs: README 补 demand 需求信号库命令与页面说明

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## 端到端验证（实施完成后，主会话手动执行）

1. 重启 dev server（`pkill -9 -f "cli.ts dev"` → 清 4321/5173 端口 → `pnpm dev`）。
2. 浏览器进 `/scout`：确认两排 tab（项目池/需求信号），默认项目池、现有功能不变；切「需求信号」空态提示正常；点「请求采集」→ 状态变"待采集"。
3. 我用 ego-browser 实采一轮（抖音热点榜/小红书热门/GitHub Trending/电商榜单，电商采不到就跳过）→ `forgecast demand import` 入库 → 页面刷新出卡片、"待采集"标记被清除。
4. 点「提炼分类」→ SSE 完成后卡片出现 kind 徽标和 💡 opportunity。
5. star 一条 → 卡片高亮"已看好"；`forgecast demand list --status=starred` 能筛出。
6. 真实采集的数据保留（这就是产品数据）；如有测试造的假信号则清掉。
