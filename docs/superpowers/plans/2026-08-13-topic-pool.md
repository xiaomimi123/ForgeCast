# 选题库 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增"选题库"能力：手动导入同赛道爆款笔记数据 → 按播放/粉丝比筛选 → LLM 提炼标题结构/情绪类型/选题聚类 → 生成文案时作为风格参考注入 prompt。

**Architecture:** 新包 `packages/topics`（3 张新表的 CRUD + 导入 + LLM 提炼，mock 模式走独立 fixture 绝不碰 `ctx.llm`）→ CLI 四个子命令（`topics add-source/import-notes/extract/list-patterns`，抓取数据本身由 agent 会话手动完成后写成 JSON 文件走 `import-notes` 导入）→ server 6 个只读+轻量写路由（不含抓取，抓取只能走 CLI）→ `packages/copywriter` 生成文案时查询选题库、格式化成参考风格文本拼进 prompt → 前端新增"选题库"管理页（目标账号清单 + 选题库列表）。

**Tech Stack:** TypeScript, pnpm monorepo, better-sqlite3, Hono, vitest, React + @tanstack/react-query。

## Global Constraints

- Node 22：跑任何 pnpm 命令前 `export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH"`（better-sqlite3 ABI）。
- 每个 LLM 能力必须自带 mock，mock 分支绝不调用 `ctx.llm`——`extractPatterns` 的 mock 分支走独立的 `packages/topics/src/fixtures/topic-fixture.ts`。
- LLM 提炼结果校验失败（缺字段）**整批抛错，不写入部分脏数据**——跟 `generateCandidateIntro`/`regenerateCover` 现有"生成失败不写脏缓存"的规矩一致。
- `packages/topics` **不依赖** `packages/copywriter`（依赖方向只能是 `copywriter` → `topics`，避免循环依赖）。
- 抓取笔记数据这一步永远不在代码里实现——`importNotes`/CLI `import-notes` 只接受已经写好的 JSON 文件，不做任何浏览器自动化/HTTP 抓取。
- server 路由顺序红线：新路由必须注册在 `app.get('/*', …)` 静态托管兜底之前。
- CLI 二级子命令用 `rest.find((a) => !a.startsWith('--'))` 取 sub（`knowledge` 命令现有写法），不要用 `rest[0]`（`tailor` 命令那种写法在 flag 提前时会取错）。
- 每个后端任务 TDD：先写失败测试再实现；web 无单测惯例（`tsc --noEmit` + `vite build` 验证）。
- `topic_patterns` 取参考风格只做"按 hook_type 查最新一条"的最简单版本，不做智能匹配排序；查不到时 `patternsMd` 为空串，`assemblePrompt` 现有的 `.filter(Boolean)` 会自动跳过，不改变没有选题库数据时的现有生成行为。
- 中文注释；commit message 末尾带 `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`。

---

## Task 1: `packages/topics` 包骨架 + 建表 + 目标账号 CRUD

**Files:**
- Create: `packages/topics/package.json`
- Create: `packages/topics/tsconfig.json`
- Create: `packages/topics/src/sources.ts`
- Create: `packages/topics/src/index.ts`
- Create: `packages/topics/test/sources.test.ts`
- Modify: `packages/core/src/db.ts`（新增 3 张表）
- Modify: `package.json`（根，加 `@forgecast/topics` 依赖，供 `cli.ts` 引用）

**Interfaces:**
- Produces：
  - `export type Platform = 'douyin' | 'xiaohongshu'`
  - `export interface TopicSource { id: number; platform: Platform; handle: string; display_name: string | null; follower_count: number | null; note: string | null; created_at: string }`
  - `export function addSource(ctx: CoreCtx, input: { platform: Platform; handle: string; displayName?: string; followerCount?: number; note?: string }): { id: number }`
  - `export function listSources(ctx: CoreCtx): TopicSource[]`
  - `export type SourcePatch = Partial<{ followerCount: number; note: string }>`
  - `export function updateSource(ctx: CoreCtx, id: number, patch: SourcePatch): void`
  - `export function deleteSource(ctx: CoreCtx, id: number): void`

- [ ] **Step 1: 建表** — `packages/core/src/db.ts`，在 `db.exec(\`...\`)` 模板字符串里、`CREATE TABLE IF NOT EXISTS settings (...)`（第 96-99 行）之后、`CREATE VIRTUAL TABLE IF NOT EXISTS atoms_fts ...`（第 100 行）之前插入：

```sql
CREATE TABLE IF NOT EXISTS topic_sources (
  id INTEGER PRIMARY KEY,
  platform TEXT NOT NULL,
  handle TEXT NOT NULL,
  display_name TEXT,
  follower_count INTEGER,
  note TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(platform, handle)
);
CREATE TABLE IF NOT EXISTS viral_notes (
  id INTEGER PRIMARY KEY,
  source_id INTEGER REFERENCES topic_sources(id),
  platform TEXT NOT NULL,
  note_id TEXT NOT NULL,
  title TEXT NOT NULL,
  play_count INTEGER NOT NULL,
  like_count INTEGER NOT NULL,
  collect_count INTEGER,
  follower_count_at_scrape INTEGER,
  ratio REAL,
  scraped_at TEXT NOT NULL,
  raw_json TEXT NOT NULL,
  UNIQUE(platform, note_id)
);
CREATE TABLE IF NOT EXISTS topic_patterns (
  id INTEGER PRIMARY KEY,
  hook_type TEXT NOT NULL,
  title_patterns TEXT NOT NULL,
  emotion_type TEXT NOT NULL,
  topic_clusters TEXT NOT NULL,
  recommended_topics TEXT NOT NULL,
  sample_note_ids TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
```

- [ ] **Step 2: 包 boilerplate** — `packages/topics/package.json`

```json
{
  "name": "@forgecast/topics",
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

`packages/topics/tsconfig.json`：

```json
{ "extends": "../../tsconfig.base.json", "include": ["src", "test"] }
```

根目录 `package.json` 的 `dependencies` 块（现按字母序排列 analyst/copywriter/core/ops/rebrand/scout/studio/tailor，`@forgecast/topics` 字母序排在 `@forgecast/tailor` 之后、是新的最后一项）加一行：

```json
    "@forgecast/tailor": "workspace:*",
    "@forgecast/topics": "workspace:*",
```

（`@forgecast/tailor` 已存在，只新增 `@forgecast/topics` 这一行，插在它后面保持字母序。）

- [ ] **Step 3: 写失败测试** — `packages/topics/test/sources.test.ts`

```ts
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadConfig, openDb, type CoreCtx } from '@forgecast/core'
import { beforeEach, describe, expect, it } from 'vitest'
import { addSource, deleteSource, listSources, updateSource } from '../src/sources'

let ctx: CoreCtx
beforeEach(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-topics-'))
  const config = loadConfig(root, {})
  ctx = { db: openDb(config.paths.db), config, llm: undefined as any }
})

describe('topic_sources CRUD', () => {
  it('addSource 落库，listSources 倒序返回', () => {
    const a = addSource(ctx, { platform: 'xiaohongshu', handle: 'a' })
    addSource(ctx, { platform: 'douyin', handle: 'b', displayName: 'B号', followerCount: 10000, note: '同赛道头部' })
    const rows = listSources(ctx)
    expect(rows.length).toBe(2)
    expect(rows[0].handle).toBe('b')
    expect(rows[0].display_name).toBe('B号')
    expect(rows[0].follower_count).toBe(10000)
    expect(rows[1].id).toBe(a.id)
  })
  it('handle 为空抛错', () => {
    expect(() => addSource(ctx, { platform: 'douyin', handle: ' ' })).toThrow()
  })
  it('platform 非法抛错', () => {
    expect(() => addSource(ctx, { platform: 'x' as any, handle: 'a' })).toThrow()
  })
  it('同 platform+handle 重复添加抛错', () => {
    addSource(ctx, { platform: 'douyin', handle: 'dup' })
    expect(() => addSource(ctx, { platform: 'douyin', handle: 'dup' })).toThrow(/已存在/)
  })
  it('updateSource 只更新传入字段，不存在抛错', () => {
    const { id } = addSource(ctx, { platform: 'douyin', handle: 'c', followerCount: 100 })
    updateSource(ctx, id, { followerCount: 200 })
    expect(listSources(ctx)[0].follower_count).toBe(200)
    updateSource(ctx, id, { note: '更新备注' })
    const row = listSources(ctx)[0]
    expect(row.note).toBe('更新备注')
    expect(row.follower_count).toBe(200) // 只传 note 不影响 followerCount
    expect(() => updateSource(ctx, 999, { note: 'x' })).toThrow(/不存在/)
  })
  it('deleteSource 删除后 listSources 不再返回', () => {
    const { id } = addSource(ctx, { platform: 'douyin', handle: 'd' })
    deleteSource(ctx, id)
    expect(listSources(ctx).find((r) => r.id === id)).toBeUndefined()
  })
})
```

- [ ] **Step 4: 跑测试确认失败**

Run: `export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH" && pnpm install && pnpm --filter @forgecast/topics test`
Expected: FAIL（`Cannot find module '../src/sources'`；`pnpm install` 先跑一遍是因为新增了包，需要 workspace 链接才能被其它包 import）

- [ ] **Step 5: 实现** — `packages/topics/src/sources.ts`

```ts
import type { CoreCtx } from '@forgecast/core'

export type Platform = 'douyin' | 'xiaohongshu'

export interface TopicSource {
  id: number
  platform: Platform
  handle: string
  display_name: string | null
  follower_count: number | null
  note: string | null
  created_at: string
}

/** 新增目标账号（选题库爆款笔记来源，手动维护，不做隐式创建）。同 platform+handle 重复抛错。 */
export function addSource(
  ctx: CoreCtx,
  input: { platform: Platform; handle: string; displayName?: string; followerCount?: number; note?: string },
): { id: number } {
  if (input.platform !== 'douyin' && input.platform !== 'xiaohongshu') throw new Error('platform 必须是 douyin/xiaohongshu')
  if (!input.handle.trim()) throw new Error('handle 必填')
  try {
    const r = ctx.db.prepare(
      'INSERT INTO topic_sources (platform, handle, display_name, follower_count, note) VALUES (?, ?, ?, ?, ?)',
    ).run(input.platform, input.handle.trim(), input.displayName ?? null, input.followerCount ?? null, input.note ?? null)
    return { id: Number(r.lastInsertRowid) }
  } catch (err) {
    if (err instanceof Error && err.message.includes('UNIQUE')) throw new Error(`账号已存在: ${input.platform}/${input.handle}`)
    throw err
  }
}

export function listSources(ctx: CoreCtx): TopicSource[] {
  return ctx.db.prepare('SELECT * FROM topic_sources ORDER BY id DESC').all() as TopicSource[]
}

export type SourcePatch = Partial<{ followerCount: number; note: string }>

/** 部分字段更新（同 tailor 的 updateCapability 写法）：只传的字段会被更新，不存在抛错。 */
export function updateSource(ctx: CoreCtx, id: number, patch: SourcePatch): void {
  if (!ctx.db.prepare('SELECT id FROM topic_sources WHERE id = ?').get(id)) throw new Error(`目标账号不存在: ${id}`)
  const sets: string[] = []
  const vals: unknown[] = []
  if (patch.followerCount !== undefined) { sets.push('follower_count = ?'); vals.push(patch.followerCount) }
  if (patch.note !== undefined) { sets.push('note = ?'); vals.push(patch.note) }
  if (!sets.length) return
  ctx.db.prepare(`UPDATE topic_sources SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id)
}

export function deleteSource(ctx: CoreCtx, id: number): void {
  ctx.db.prepare('DELETE FROM topic_sources WHERE id = ?').run(id)
}
```

`packages/topics/src/index.ts`：

```ts
export * from './sources'
```

- [ ] **Step 6: 跑测试确认通过**

Run: `export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH" && pnpm --filter @forgecast/topics test`
Expected: PASS（6 个用例全绿）

- [ ] **Step 7: 提交**

```bash
git add packages/core/src/db.ts packages/topics package.json pnpm-lock.yaml
git commit -m "feat(topics): 选题库建表 + 包骨架 + 目标账号 CRUD"
```

---

## Task 2: 导入爆款笔记（`importNotes`）

**Files:**
- Create: `packages/topics/src/notes.ts`
- Create: `packages/topics/test/notes.test.ts`
- Modify: `packages/topics/src/index.ts`

**Interfaces:**
- Consumes：Task 1 的 `topic_sources` 表（查 `id`/`follower_count`）。
- Produces：
  - `export interface RawNote { noteId: string; title: string; playCount: number; likeCount: number; collectCount?: number }`
  - `export interface ViralNote { id: number; source_id: number; platform: Platform; note_id: string; title: string; play_count: number; like_count: number; collect_count: number | null; follower_count_at_scrape: number | null; ratio: number | null; scraped_at: string; raw_json: string }`
  - `export function importNotes(ctx: CoreCtx, input: { sourceHandle: string; platform: Platform; notes: RawNote[] }): { imported: number; updated: number }`
  - `export function listNotes(ctx: CoreCtx, sourceId?: number): ViralNote[]`

- [ ] **Step 1: 写失败测试** — `packages/topics/test/notes.test.ts`

```ts
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadConfig, openDb, type CoreCtx } from '@forgecast/core'
import { beforeEach, describe, expect, it } from 'vitest'
import { addSource } from '../src/sources'
import { importNotes, listNotes } from '../src/notes'

let ctx: CoreCtx
beforeEach(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-topics-notes-'))
  const config = loadConfig(root, {})
  ctx = { db: openDb(config.paths.db), config, llm: undefined as any }
})

describe('importNotes', () => {
  it('未知账号抛错', () => {
    expect(() => importNotes(ctx, { sourceHandle: 'nope', platform: 'douyin', notes: [] }))
      .toThrow(/未知账号/)
  })
  it('有粉丝数时正确算比值并落库', () => {
    addSource(ctx, { platform: 'douyin', handle: 'a', followerCount: 1000 })
    const r = importNotes(ctx, {
      sourceHandle: 'a', platform: 'douyin',
      notes: [{ noteId: 'n1', title: '标题1', playCount: 5000, likeCount: 100, collectCount: 20 }],
    })
    expect(r).toEqual({ imported: 1, updated: 0 })
    const notes = listNotes(ctx)
    expect(notes.length).toBe(1)
    expect(notes[0].ratio).toBeCloseTo(5)
    expect(notes[0].follower_count_at_scrape).toBe(1000)
    expect(notes[0].collect_count).toBe(20)
  })
  it('账号无粉丝数时 ratio 存 null，笔记仍入库', () => {
    addSource(ctx, { platform: 'douyin', handle: 'b' })
    importNotes(ctx, { sourceHandle: 'b', platform: 'douyin', notes: [{ noteId: 'n2', title: 't', playCount: 100, likeCount: 1 }] })
    expect(listNotes(ctx)[0].ratio).toBeNull()
  })
  it('同 platform+note_id 重复导入更新而不重复插入', () => {
    addSource(ctx, { platform: 'douyin', handle: 'c', followerCount: 100 })
    importNotes(ctx, { sourceHandle: 'c', platform: 'douyin', notes: [{ noteId: 'n3', title: '旧标题', playCount: 10, likeCount: 1 }] })
    const r2 = importNotes(ctx, { sourceHandle: 'c', platform: 'douyin', notes: [{ noteId: 'n3', title: '新标题', playCount: 999, likeCount: 5 }] })
    expect(r2).toEqual({ imported: 0, updated: 1 })
    const notes = listNotes(ctx)
    expect(notes.length).toBe(1)
    expect(notes[0].title).toBe('新标题')
    expect(notes[0].play_count).toBe(999)
  })
  it('listNotes 按 source_id 过滤', () => {
    const a = addSource(ctx, { platform: 'douyin', handle: 'd', followerCount: 100 })
    addSource(ctx, { platform: 'douyin', handle: 'e', followerCount: 100 })
    importNotes(ctx, { sourceHandle: 'd', platform: 'douyin', notes: [{ noteId: 'n4', title: 't', playCount: 1, likeCount: 1 }] })
    importNotes(ctx, { sourceHandle: 'e', platform: 'douyin', notes: [{ noteId: 'n5', title: 't', playCount: 1, likeCount: 1 }] })
    expect(listNotes(ctx, a.id).length).toBe(1)
    expect(listNotes(ctx).length).toBe(2)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH" && pnpm --filter @forgecast/topics test notes`
Expected: FAIL（`Cannot find module '../src/notes'`）

- [ ] **Step 3: 实现** — `packages/topics/src/notes.ts`

```ts
import type { CoreCtx } from '@forgecast/core'
import type { Platform } from './sources'

export interface RawNote {
  noteId: string
  title: string
  playCount: number
  likeCount: number
  collectCount?: number
}

export interface ViralNote {
  id: number
  source_id: number
  platform: Platform
  note_id: string
  title: string
  play_count: number
  like_count: number
  collect_count: number | null
  follower_count_at_scrape: number | null
  ratio: number | null
  scraped_at: string
  raw_json: string
}

/**
 * 导入一批爆款笔记原始数据（由 agent 会话手动抓取后写成 JSON，本函数不做任何抓取）。
 * 账号必须已在 topic_sources 存在，不隐式创建；用账号当前 follower_count 作为这批笔记的
 * follower_count_at_scrape 快照，据此算 ratio（账号无粉丝数时 ratio 存 null，笔记仍正常入库）。
 * 同 (platform, note_id) 重复导入视为数据更新（覆盖旧值），不重复插入。
 */
export function importNotes(
  ctx: CoreCtx,
  input: { sourceHandle: string; platform: Platform; notes: RawNote[] },
): { imported: number; updated: number } {
  const source = ctx.db.prepare('SELECT id, follower_count FROM topic_sources WHERE platform = ? AND handle = ?')
    .get(input.platform, input.sourceHandle) as { id: number; follower_count: number | null } | undefined
  if (!source) throw new Error(`未知账号，请先在选题库页面添加目标账号: ${input.platform}/${input.sourceHandle}`)

  const now = new Date().toISOString()
  const findExisting = ctx.db.prepare('SELECT id FROM viral_notes WHERE platform = ? AND note_id = ?')
  const upsert = ctx.db.prepare(`
    INSERT INTO viral_notes (source_id, platform, note_id, title, play_count, like_count, collect_count, follower_count_at_scrape, ratio, scraped_at, raw_json)
    VALUES (@source_id, @platform, @note_id, @title, @play_count, @like_count, @collect_count, @follower_count_at_scrape, @ratio, @scraped_at, @raw_json)
    ON CONFLICT(platform, note_id) DO UPDATE SET
      title = excluded.title, play_count = excluded.play_count, like_count = excluded.like_count,
      collect_count = excluded.collect_count, follower_count_at_scrape = excluded.follower_count_at_scrape,
      ratio = excluded.ratio, scraped_at = excluded.scraped_at, raw_json = excluded.raw_json
  `)

  let imported = 0
  let updated = 0
  for (const n of input.notes) {
    const exists = findExisting.get(input.platform, n.noteId)
    const ratio = source.follower_count ? n.playCount / source.follower_count : null
    upsert.run({
      source_id: source.id, platform: input.platform, note_id: n.noteId, title: n.title,
      play_count: n.playCount, like_count: n.likeCount, collect_count: n.collectCount ?? null,
      follower_count_at_scrape: source.follower_count, ratio, scraped_at: now, raw_json: JSON.stringify(n),
    })
    if (exists) updated++; else imported++
  }
  return { imported, updated }
}

export function listNotes(ctx: CoreCtx, sourceId?: number): ViralNote[] {
  if (sourceId !== undefined) {
    return ctx.db.prepare('SELECT * FROM viral_notes WHERE source_id = ? ORDER BY id DESC').all(sourceId) as ViralNote[]
  }
  return ctx.db.prepare('SELECT * FROM viral_notes ORDER BY id DESC').all() as ViralNote[]
}
```

`packages/topics/src/index.ts` 追加一行：

```ts
export * from './notes'
```

- [ ] **Step 4: 跑测试确认通过**

Run: `export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH" && pnpm --filter @forgecast/topics test notes`
Expected: PASS（5 个用例全绿）

- [ ] **Step 5: 跑 topics 全量确认无回归**

Run: `export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH" && pnpm --filter @forgecast/topics test`
Expected: PASS（全绿）

- [ ] **Step 6: 提交**

```bash
git add packages/topics/src/notes.ts packages/topics/src/index.ts packages/topics/test/notes.test.ts
git commit -m "feat(topics): importNotes 导入爆款笔记 + 播放/粉丝比计算"
```

---

## Task 3: LLM 提炼选题模式（`extractPatterns`）+ mock fixture + prompt 模板

**Files:**
- Create: `packages/topics/src/fixtures/topic-fixture.ts`
- Create: `packages/topics/src/patterns.ts`
- Create: `templates/prompts/topic-pattern-extract.md`
- Create: `packages/topics/test/patterns.test.ts`
- Modify: `packages/topics/src/index.ts`

**Interfaces:**
- Consumes：Task 2 的 `viral_notes` 表；`CoreCtx`（`ctx.config.llm.mode`/`ctx.config.llm.models.analysis`/`ctx.llm.complete`/`ctx.config.paths.templates`）。
- Produces：
  - `export interface TopicPattern { id: number; hook_type: HookType; title_patterns: string; emotion_type: string; topic_clusters: string; recommended_topics: string; sample_note_ids: string; created_at: string }`（JSON 字段存字符串，调用方自行 `JSON.parse`，跟仓库里 `Asset.perf`/`Candidate.score_detail` 的既有约定一致）
  - `export async function extractPatterns(ctx: CoreCtx, opts?: { topN?: number; minRatio?: number; onProgress?: (msg: string) => void }): Promise<TopicPattern[]>`
  - `export function listPatterns(ctx: CoreCtx, hookType?: HookType): TopicPattern[]`（本 Task 一并实现，跟 `extractPatterns` 同文件，供 Task 4 CLI 与 Task 6 生成流程使用）

- [ ] **Step 1: 写失败测试** — `packages/topics/test/patterns.test.ts`

```ts
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createLlmClient, loadConfig, openDb, type CoreCtx } from '@forgecast/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { addSource } from '../src/sources'
import { importNotes } from '../src/notes'
import { extractPatterns, listPatterns } from '../src/patterns'

let ctx: CoreCtx
let root: string
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-topics-patterns-'))
  const config = loadConfig(root, {}) // mock
  ctx = { db: openDb(config.paths.db), config, llm: createLlmClient(config.llm) }
  addSource(ctx, { platform: 'douyin', handle: 'a', followerCount: 1000 })
})

function seedNotes(n: number) {
  const notes = Array.from({ length: n }, (_, i) => ({ noteId: `n${i}`, title: `标题${i}`, playCount: (i + 1) * 100, likeCount: 1 }))
  importNotes(ctx, { sourceHandle: 'a', platform: 'douyin', notes })
}

describe('extractPatterns mock 模式', () => {
  it('无笔记时返回空数组，不调用 ctx.llm', async () => {
    const spy = vi.spyOn(ctx.llm, 'complete')
    const r = await extractPatterns(ctx)
    expect(r).toEqual([])
    expect(spy).not.toHaveBeenCalled()
  })
  it('有笔记时产出固定 fixture 结果，写入 topic_patterns，不调用 ctx.llm', async () => {
    seedNotes(3)
    const spy = vi.spyOn(ctx.llm, 'complete')
    const r = await extractPatterns(ctx)
    expect(r.length).toBeGreaterThan(0)
    expect(spy).not.toHaveBeenCalled()
    expect(listPatterns(ctx).length).toBe(r.length)
    for (const p of r) {
      expect(JSON.parse(p.title_patterns).length).toBeGreaterThan(0)
      expect(JSON.parse(p.sample_note_ids).length).toBe(3)
    }
  })
  it('topN 限制参与提炼的笔记数（按 ratio 降序取前 N）', async () => {
    seedNotes(5)
    const r = await extractPatterns(ctx, { topN: 2 })
    expect(JSON.parse(r[0].sample_note_ids).length).toBe(2)
  })
  it('minRatio 过滤低于阈值的笔记', async () => {
    seedNotes(5) // ratio 分别是 0.1,0.2,0.3,0.4,0.5
    const r = await extractPatterns(ctx, { minRatio: 0.35 })
    expect(JSON.parse(r[0].sample_note_ids).length).toBe(2) // 只有 0.4、0.5 达标
  })
  it('已被引用过的笔记不重复参与下一次提炼', async () => {
    seedNotes(3)
    await extractPatterns(ctx) // 第一次把 3 条全用掉
    const spy = vi.spyOn(ctx.llm, 'complete')
    const r2 = await extractPatterns(ctx) // 第二次没有新笔记可用
    expect(r2).toEqual([])
    expect(spy).not.toHaveBeenCalled()
  })
  it('onProgress 收到进度消息', async () => {
    seedNotes(1)
    const msgs: string[] = []
    await extractPatterns(ctx, { onProgress: (m) => msgs.push(m) })
    expect(msgs.length).toBeGreaterThan(0)
  })
})

describe('extractPatterns live 模式', () => {
  function liveCtx(): CoreCtx {
    const config = loadConfig(root, { FORGECAST_LLM_MODE: 'live', FORGECAST_LLM_KEY: 'k' })
    return { db: ctx.db, config, llm: createLlmClient(config.llm) }
  }
  const GOOD = '```json\n[{"hookType":"pain","titlePatterns":["标题结构A"],"emotionType":"同行吐槽","topicClusters":["聚类A"],"recommendedTopics":["选题A"]}]\n```'

  it('成功解析 LLM 返回并写库', async () => {
    seedNotes(2)
    const lctx = liveCtx()
    lctx.llm.complete = vi.fn(async () => GOOD)
    const r = await extractPatterns(lctx)
    expect(r.length).toBe(1)
    expect(r[0].hook_type).toBe('pain')
    expect(JSON.parse(r[0].title_patterns)).toEqual(['标题结构A'])
  })

  it('LLM 返回缺字段 → 整批抛错，不写入部分脏数据', async () => {
    seedNotes(2)
    const lctx = liveCtx()
    lctx.llm.complete = vi.fn(async () => '```json\n[{"hookType":"pain","titlePatterns":["a"]}]\n```') // 缺 emotionType/topicClusters/recommendedTopics
    await expect(extractPatterns(lctx)).rejects.toThrow(/缺字段/)
    expect(listPatterns(lctx).length).toBe(0)
  })

  it('LLM 返回非法 JSON → 抛错，不写库', async () => {
    seedNotes(2)
    const lctx = liveCtx()
    lctx.llm.complete = vi.fn(async () => 'not json at all')
    await expect(extractPatterns(lctx)).rejects.toThrow()
    expect(listPatterns(lctx).length).toBe(0)
  })
})

describe('listPatterns', () => {
  it('按 hookType 过滤，不传返回全部，按 created_at 倒序', async () => {
    seedNotes(3)
    await extractPatterns(ctx) // mock fixture 含 pain 和 sideline 两类
    expect(listPatterns(ctx, 'pain').every((p) => p.hook_type === 'pain')).toBe(true)
    expect(listPatterns(ctx).length).toBeGreaterThanOrEqual(listPatterns(ctx, 'pain').length)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH" && pnpm --filter @forgecast/topics test patterns`
Expected: FAIL（`Cannot find module '../src/patterns'`）

- [ ] **Step 3: 建 mock fixture** — `packages/topics/src/fixtures/topic-fixture.ts`

```ts
import type { HookType } from '@forgecast/core'

export interface TopicPatternDraft {
  hookType: HookType
  titlePatterns: string[]
  emotionType: string
  topicClusters: string[]
  recommendedTopics: string[]
}

/** mock：写死 2 条不同 hook_type 的选题模式，离线可测，绝不走 ctx.llm。 */
export function mockTopicPatterns(): TopicPatternDraft[] {
  return [
    {
      hookType: 'pain',
      titlePatterns: ['做XX的还在手动XX？这个工具直接把效率翻X倍', 'XX还在用原始方式干活，同行早就换了'],
      emotionType: '同行吐槽+效率焦虑',
      topicClusters: ['提效工具安利', '行业老办法吐槽'],
      recommendedTopics: ['接单效率翻倍的3个工具', '同行都在用但我才知道的省时神器'],
    },
    {
      hookType: 'sideline',
      titlePatterns: ['下班后靠这个副业月入XX', '不用离职也能做的XX副业'],
      emotionType: '结果炫耀+身份认同',
      topicClusters: ['副业变现路径', '低门槛技能变现'],
      recommendedTopics: ['程序员下班后的副业清单', '技术人如何靠开源项目变现'],
    },
  ]
}
```

- [ ] **Step 4: 建 prompt 模板** — `templates/prompts/topic-pattern-extract.md`

```markdown
你是短视频/图文内容选题分析专家。下面是一批同赛道爆款笔记（已按播放/粉丝比降序），
请提炼出可复用的选题模式，帮助后续创作时套用这套结构写新内容。

严格只输出如下 JSON 数组（不要多余文字、不要 markdown 说明）：
[
  {
    "hookType": "pain 或 sideline 或 infogap 或 story 之一，按笔记内容倾向判断",
    "titlePatterns": ["标题结构模板，用 XX 代表可替换的具体内容，2-5 条"],
    "emotionType": "这批笔记的情绪类型，如同行吐槽/结果炫耀/身份认同",
    "topicClusters": ["选题聚类描述，1-3 条"],
    "recommendedTopics": ["基于这批笔记推荐的具体选题方向，3-7 条"]
  }
]

要求：可以识别出多个 hookType 类别就拆成多条数组元素；所有字段用中文；不得编造笔记里没有的内容。
```

- [ ] **Step 5: 实现** — `packages/topics/src/patterns.ts`

```ts
import fs from 'node:fs'
import path from 'node:path'
import { HOOKS, type CoreCtx, type HookType } from '@forgecast/core'
import { mockTopicPatterns, type TopicPatternDraft } from './fixtures/topic-fixture'

export interface TopicPattern {
  id: number
  hook_type: HookType
  title_patterns: string
  emotion_type: string
  topic_clusters: string
  recommended_topics: string
  sample_note_ids: string
  created_at: string
}

function validateDraft(d: any): string[] {
  const bad: string[] = []
  if (!HOOKS.includes(d.hookType)) bad.push('hookType')
  if (!Array.isArray(d.titlePatterns) || !d.titlePatterns.length) bad.push('titlePatterns')
  if (typeof d.emotionType !== 'string' || !d.emotionType.trim()) bad.push('emotionType')
  if (!Array.isArray(d.topicClusters) || !d.topicClusters.length) bad.push('topicClusters')
  if (!Array.isArray(d.recommendedTopics) || !d.recommendedTopics.length) bad.push('recommendedTopics')
  return bad
}

/** 剥 ```json 围栏 → JSON.parse（malformed 直接抛）→ 必须是数组。 */
function parsePatternsJson(raw: string): TopicPatternDraft[] {
  const cleaned = raw.trim().replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/```\s*$/, '').trim()
  const arr = JSON.parse(cleaned)
  if (!Array.isArray(arr)) throw new Error('LLM 输出不是数组')
  return arr
}

/**
 * 从 viral_notes 里按 ratio 取一批（NULL 排最后）尚未被引用过的笔记 → mock 走固定 fixture /
 * live 调 LLM 提炼 → 校验（缺字段整批抛错，不写脏数据）→ 写入 topic_patterns。
 * 无候选笔记时直接返回空数组，不调用 LLM。
 */
export async function extractPatterns(
  ctx: CoreCtx,
  opts: { topN?: number; minRatio?: number; onProgress?: (msg: string) => void } = {},
): Promise<TopicPattern[]> {
  const { topN = 30, minRatio, onProgress = () => {} } = opts

  const used = new Set<number>()
  for (const row of ctx.db.prepare('SELECT sample_note_ids FROM topic_patterns').all() as { sample_note_ids: string }[]) {
    for (const id of JSON.parse(row.sample_note_ids) as number[]) used.add(id)
  }
  onProgress('筛选候选笔记…')
  let notes = ctx.db.prepare('SELECT * FROM viral_notes ORDER BY (ratio IS NULL), ratio DESC').all() as Array<{ id: number; platform: string; title: string; play_count: number; ratio: number | null }>
  notes = notes.filter((n) => !used.has(n.id))
  if (minRatio !== undefined) notes = notes.filter((n) => n.ratio !== null && n.ratio >= minRatio)
  notes = notes.slice(0, topN)
  if (!notes.length) { onProgress('没有可用于提炼的新笔记'); return [] }

  let drafts: TopicPatternDraft[]
  if (ctx.config.llm.mode === 'mock') {
    onProgress('mock 模式：使用固定选题模式示例…')
    drafts = mockTopicPatterns()
  } else {
    onProgress(`调用大模型提炼 ${notes.length} 条笔记…`)
    const tpl = fs.readFileSync(path.join(ctx.config.paths.templates, 'prompts', 'topic-pattern-extract.md'), 'utf8')
    const system = '你是短视频/图文内容选题分析专家，只输出给定 JSON 结构，不要多余文字。'
    const notesBlock = notes.map((n, i) => `${i + 1}. [${n.platform}] ${n.title}（播放 ${n.play_count}，比值 ${n.ratio?.toFixed(2) ?? '—'}）`).join('\n')
    const prompt = [tpl, `以下是本批爆款笔记：\n${notesBlock}`].join('\n\n---\n\n')
    drafts = parsePatternsJson(await ctx.llm.complete({ model: ctx.config.llm.models.analysis, system, prompt }))
  }

  for (const d of drafts) {
    const bad = validateDraft(d)
    if (bad.length) throw new Error(`选题模式提炼结果缺字段: ${bad.join('、')}`)
  }

  onProgress('写入选题库…')
  const sampleIds = notes.map((n) => n.id)
  const insert = ctx.db.prepare(`
    INSERT INTO topic_patterns (hook_type, title_patterns, emotion_type, topic_clusters, recommended_topics, sample_note_ids)
    VALUES (?, ?, ?, ?, ?, ?)
  `)
  const results: TopicPattern[] = []
  for (const d of drafts) {
    const r = insert.run(d.hookType, JSON.stringify(d.titlePatterns), d.emotionType, JSON.stringify(d.topicClusters), JSON.stringify(d.recommendedTopics), JSON.stringify(sampleIds))
    results.push(ctx.db.prepare('SELECT * FROM topic_patterns WHERE id = ?').get(Number(r.lastInsertRowid)) as TopicPattern)
  }
  onProgress(`提炼完成：新增 ${results.length} 条选题模式`)
  return results
}

export function listPatterns(ctx: CoreCtx, hookType?: HookType): TopicPattern[] {
  if (hookType) return ctx.db.prepare('SELECT * FROM topic_patterns WHERE hook_type = ? ORDER BY created_at DESC').all(hookType) as TopicPattern[]
  return ctx.db.prepare('SELECT * FROM topic_patterns ORDER BY created_at DESC').all() as TopicPattern[]
}
```

`packages/topics/src/index.ts` 追加一行：

```ts
export * from './patterns'
```

- [ ] **Step 6: 跑测试确认通过**

Run: `export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH" && pnpm --filter @forgecast/topics test patterns`
Expected: PASS（11 个用例全绿）

- [ ] **Step 7: 跑 topics 全量确认无回归**

Run: `export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH" && pnpm --filter @forgecast/topics test`
Expected: PASS（全绿）

- [ ] **Step 8: 提交**

```bash
git add packages/topics/src/fixtures/topic-fixture.ts packages/topics/src/patterns.ts packages/topics/src/index.ts packages/topics/test/patterns.test.ts templates/prompts/topic-pattern-extract.md
git commit -m "feat(topics): extractPatterns LLM 提炼选题模式 + mock fixture + listPatterns 查询"
```

---

## Task 4: CLI 四个子命令

**Files:**
- Modify: `cli.ts`

**Interfaces:**
- Consumes：Task 1-3 的 `addSource`/`importNotes`/`extractPatterns`/`listPatterns`（均从 `@forgecast/topics` 导入）。

- [ ] **Step 1: 加 import** — `cli.ts` 顶部 import 区，在 `import { addRequest, ... } from '@forgecast/tailor'`（第 10 行）之后加：

```ts
import { addSource, extractPatterns, importNotes, listPatterns } from '@forgecast/topics'
```

同时在文件顶部加（`cli.ts` 目前没有 `node:fs` import，`import-notes` 子命令要读 JSON 文件）：

```ts
import fs from 'node:fs'
```

（插在第 1 行 `#!/usr/bin/env tsx` 之后、`import { spawn } from 'node:child_process'` 之前，按 node 内置模块在前的既有顺序。）

- [ ] **Step 2: 加 `topics` 子命令 dispatch** — `cli.ts` 的 `switch (cmd) { ... }` 块内，在 `case 'tailor': { ... break }`（第 195-226 行）之后、`case 'knowledge':`（第 227 行）之前插入：

```ts
    case 'topics': {
      const sub = rest.find((a) => !a.startsWith('--'))
      const ctx = ctxWithNotes()
      const usage = '用法: forgecast topics <add-source|import-notes|extract|list-patterns>'
      if (sub === 'add-source') {
        const platform = arg('platform')
        const handle = arg('handle')
        if (platform !== 'douyin' && platform !== 'xiaohongshu') {
          console.error('用法: forgecast topics add-source --platform=<douyin|xiaohongshu> --handle=<handle> [--name=<display_name>] [--followers=<N>] [--note=<text>]')
          process.exit(1)
        }
        if (!handle) { console.error('缺少 --handle'); process.exit(1) }
        const followers = arg('followers')
        const { id } = addSource(ctx, {
          platform, handle, displayName: arg('name'),
          followerCount: followers ? Number(followers) : undefined, note: arg('note'),
        })
        console.log(`已添加目标账号 #${id}`)
      } else if (sub === 'import-notes') {
        const source = arg('source')
        const platform = arg('platform')
        const file = arg('file')
        if (!source || (platform !== 'douyin' && platform !== 'xiaohongshu') || !file) {
          console.error('用法: forgecast topics import-notes --source=<handle> --platform=<douyin|xiaohongshu> --file=<notes.json>')
          process.exit(1)
        }
        const notes = JSON.parse(fs.readFileSync(file, 'utf8'))
        const { imported, updated } = importNotes(ctx, { sourceHandle: source, platform, notes })
        console.log(`导入完成：新增 ${imported} 条，更新 ${updated} 条`)
      } else if (sub === 'extract') {
        const top = arg('top')
        const minRatio = arg('min-ratio')
        const patterns = await extractPatterns(ctx, {
          topN: top ? Number(top) : undefined,
          minRatio: minRatio ? Number(minRatio) : undefined,
          onProgress: (m) => console.log(`  ${m}`),
        })
        console.log(`提炼完成：新增 ${patterns.length} 条选题模式`)
      } else if (sub === 'list-patterns') {
        const hook = arg('hook')
        const patterns = listPatterns(ctx, hook as any)
        console.log(`选题库共 ${patterns.length} 条:`)
        for (const p of patterns) console.log(`  [${p.hook_type}] ${(JSON.parse(p.title_patterns)[0] ?? '')}`)
      } else {
        console.error(usage)
        process.exit(1)
      }
      break
    }
```

- [ ] **Step 3: 补帮助文本** — `cli.ts` 的 `default:` 分支（help 输出，原第 251-274 行附近）里，找到 `tailor add ...`/`knowledge sync ...` 那几行帮助文本，在 `knowledge list` 那一行之后加：

```
forgecast topics add-source --platform=<douyin|xiaohongshu> --handle=<handle> [--name=..] [--followers=N] [--note=..]  # 加选题库目标账号
forgecast topics import-notes --source=<handle> --platform=<douyin|xiaohongshu> --file=<notes.json>  # 导入抓到的爆款笔记（数据来源：agent 会话手动抓取后写文件）
forgecast topics extract [--top=N] [--min-ratio=R]          # LLM 提炼选题模式（按播放/粉丝比取前 N 条尚未提炼过的笔记）
forgecast topics list-patterns [--hook=<pain|sideline|infogap|story>]  # 列出选题库
```

- [ ] **Step 4: 类型检查**

Run: `export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH" && pnpm exec tsc --noEmit -p tsconfig.json 2>&1 || true`

（`cli.ts` 不属于任何 workspace 包的独立 tsc 目标，仓库现有做法是靠 `tsx` 运行时校验；此步跑一次 `pnpm exec tsx cli.ts` 无参数，确认能正常打印 help 文本、无导入报错即可，命令见下一步。）

- [ ] **Step 5: 手工冒烟测试**

```bash
export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH"
pnpm exec tsx cli.ts topics add-source --platform=douyin --handle=test1 --followers=1000
pnpm exec tsx cli.ts topics list-patterns
```

Expected: 第一条打印"已添加目标账号 #1"；第二条打印"选题库共 0 条:"（mock 模式下还没导入笔记，属正常）。

- [ ] **Step 6: 提交**

```bash
git add cli.ts
git commit -m "feat(cli): topics 子命令（add-source/import-notes/extract/list-patterns）"
```

---

## Task 5: server 路由

**Files:**
- Modify: `packages/server/package.json`（加 `@forgecast/topics` 依赖）
- Modify: `packages/server/src/app.ts`
- Create: `packages/server/test/topics.test.ts`

**Interfaces:**
- Consumes：`@forgecast/topics` 的 `addSource`/`listSources`/`updateSource`/`deleteSource`/`listPatterns`/`extractPatterns`。
- Produces：
  - `GET /api/topics/sources` → `TopicSource[]`
  - `POST /api/topics/sources` body `{ platform, handle, displayName?, followerCount?, note? }` → `{ id }` 或 400
  - `PUT /api/topics/sources/:id` body `{ followerCount?, note? }` → `{ ok: true }` 或 404
  - `DELETE /api/topics/sources/:id` → `{ ok: true }`
  - `GET /api/topics/patterns?hook=<type>` → `TopicPattern[]`
  - `POST /api/topics/extract` body `{ top?, minRatio? }` → `{ taskId }`（走任务队列 SSE，同 `/analyze`）

- [ ] **Step 1: 加依赖** — `packages/server/package.json` 的 `dependencies` 块，`@forgecast/tailor` 之后加：

```json
    "@forgecast/tailor": "workspace:*",
    "@forgecast/topics": "workspace:*",
```

- [ ] **Step 2: 写失败测试** — `packages/server/test/topics.test.ts`

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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-topics-route-'))
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

describe('/api/topics/sources', () => {
  it('GET 空列表；POST 新增；PUT 更新；DELETE 删除', async () => {
    expect(await (await app.request('/api/topics/sources')).json()).toEqual([])
    const created = await (await app.request('/api/topics/sources', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ platform: 'douyin', handle: 'a', followerCount: 100 }),
    })).json() as any
    expect(created.id).toBeTypeOf('number')
    const list = await (await app.request('/api/topics/sources')).json() as any[]
    expect(list.length).toBe(1)
    expect(list[0].follower_count).toBe(100)

    const putRes = await app.request(`/api/topics/sources/${created.id}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ followerCount: 200 }),
    })
    expect(putRes.status).toBe(200)
    const list2 = await (await app.request('/api/topics/sources')).json() as any[]
    expect(list2[0].follower_count).toBe(200)

    const delRes = await app.request(`/api/topics/sources/${created.id}`, { method: 'DELETE' })
    expect(delRes.status).toBe(200)
    expect(await (await app.request('/api/topics/sources')).json()).toEqual([])
  })
  it('POST platform 非法 → 400', async () => {
    const res = await app.request('/api/topics/sources', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ platform: 'x', handle: 'a' }),
    })
    expect(res.status).toBe(400)
  })
  it('PUT 不存在的账号 → 404', async () => {
    const res = await app.request('/api/topics/sources/999', {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ note: 'x' }),
    })
    expect(res.status).toBe(404)
  })
})

describe('/api/topics/patterns + extract', () => {
  it('GET 支持 hook 过滤；POST extract 走任务队列，mock 模式无笔记时新增 0 条', async () => {
    const res = await app.request('/api/topics/extract', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    })
    const { taskId } = await res.json() as any
    await runTask(taskId)
    const patterns = await (await app.request('/api/topics/patterns')).json() as any[]
    expect(patterns).toEqual([])
    const filtered = await (await app.request('/api/topics/patterns?hook=pain')).json() as any[]
    expect(filtered).toEqual([])
  })
})
```

- [ ] **Step 3: 跑测试确认失败**

Run: `export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH" && pnpm install && pnpm --filter @forgecast/server test topics`
Expected: FAIL（路由不存在，返回 404 / undefined）

- [ ] **Step 4: 实现** — `packages/server/src/app.ts`

`@forgecast/tailor` import 块（第 11-14 行）之后、`import { Hono } from 'hono'`（第 15 行）之前加：

```ts
import { addSource, deleteSource, extractPatterns, listPatterns, listSources, updateSource } from '@forgecast/topics'
```

在 `app.post('/api/leads/:id/to-tailor', ...)`（原第 666-673 行）之后、"静态托管"注释（原第 675 行）之前插入：

```ts
  // —— 选题库 ——
  app.get('/api/topics/sources', (c) => c.json(listSources(ctx)))
  app.post('/api/topics/sources', async (c) => {
    const body = await c.req.json().catch(() => ({}))
    if (body.platform !== 'douyin' && body.platform !== 'xiaohongshu') return c.json({ error: 'platform 必须是 douyin/xiaohongshu' }, 400)
    if (typeof body.handle !== 'string' || !body.handle.trim()) return c.json({ error: '缺少 handle' }, 400)
    try {
      return c.json(addSource(ctx, {
        platform: body.platform, handle: body.handle,
        displayName: body.displayName, followerCount: body.followerCount, note: body.note,
      }))
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400)
    }
  })
  app.put('/api/topics/sources/:id', async (c) => {
    const id = Number(c.req.param('id'))
    const body = await c.req.json().catch(() => ({}))
    try {
      updateSource(ctx, id, { followerCount: body.followerCount, note: body.note })
      return c.json({ ok: true })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return c.json({ error: msg }, msg.includes('不存在') ? 404 : 400)
    }
  })
  app.delete('/api/topics/sources/:id', (c) => {
    deleteSource(ctx, Number(c.req.param('id')))
    return c.json({ ok: true })
  })
  app.get('/api/topics/patterns', (c) => {
    const hook = c.req.query('hook')
    return c.json(listPatterns(ctx, hook as any))
  })
  app.post('/api/topics/extract', async (c) => {
    const body = await c.req.json().catch(() => ({}))
    const taskId = queue.enqueue((log) => extractPatterns(ctx, {
      topN: typeof body.top === 'number' ? body.top : undefined,
      minRatio: typeof body.minRatio === 'number' ? body.minRatio : undefined,
      onProgress: log,
    }))
    return c.json({ taskId })
  })

```

- [ ] **Step 5: 跑测试确认通过**

Run: `export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH" && pnpm --filter @forgecast/server test topics`
Expected: PASS（5 个用例全绿）

- [ ] **Step 6: 跑 server 全量确认无回归（尤其路由顺序）**

Run: `export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH" && pnpm --filter @forgecast/server test`
Expected: PASS（全绿）

- [ ] **Step 7: 提交**

```bash
git add packages/server/package.json packages/server/src/app.ts packages/server/test/topics.test.ts pnpm-lock.yaml
git commit -m "feat(server): /api/topics/* 路由（账号 CRUD + 选题库查询 + 提炼任务）"
```

---

## Task 6: 接入文案生成流程（选题风格参考注入 prompt）

**Files:**
- Modify: `packages/copywriter/package.json`（加 `@forgecast/topics` 依赖）
- Modify: `packages/copywriter/src/assemble.ts`
- Modify: `packages/copywriter/src/generate.ts`
- Modify: `packages/copywriter/test/assemble.test.ts`
- Modify: `packages/copywriter/test/generate.test.ts`

**Interfaces:**
- Consumes：`@forgecast/topics` 的 `listPatterns(ctx, hookType?)`。
- Produces：`AssembleInput` 新增可选字段 `patternsMd?: string`；`assemblePrompt` 的 `prompt` 数组新增一段（无数据时为空串，被现有 `.filter(Boolean)` 自动跳过）。

- [ ] **Step 1: 加依赖** — `packages/copywriter/package.json` 的 `dependencies` 块（现含 `@forgecast/analyst`/`@forgecast/core`/`playwright`），按字母序插入：

```json
  "dependencies": {
    "@forgecast/analyst": "workspace:*",
    "@forgecast/core": "workspace:*",
    "@forgecast/topics": "workspace:*",
    "playwright": "^1.49.0"
  },
```

- [ ] **Step 2: 写 `assemble.ts` 失败测试** — `packages/copywriter/test/assemble.test.ts` 现有结构：文件顶部（第 4-11 行）已有一个模块级 `base` 对象（`{ hook: 'pain', hookTemplate, formatSpec, knowledgeMd, atoms: [...], analysis }`，无 `feedback`/`patternsMd`），所有用例在 `describe('assemblePrompt', () => { ... })` 内（第 13-31 行），第二条既有用例"feedback 存在时追加在末尾"结束于第 30 行 `})`，describe 收尾 `})` 在第 31 行。

在第 30 行之后、第 31 行之前插入新用例（复用文件顶部已有的 `base`，不重新声明一份）：

```ts
  it('patternsMd 有值时拼进 prompt，无值/未传时不出现该段落', () => {
    const withPatterns = assemblePrompt({ ...base, patternsMd: '标题结构示例' })
    expect(withPatterns.prompt).toContain('【选题风格参考】')
    expect(withPatterns.prompt).toContain('标题结构示例')
    const without = assemblePrompt({ ...base, patternsMd: '' })
    expect(without.prompt).not.toContain('【选题风格参考】')
    const untouched = assemblePrompt(base)
    expect(untouched.prompt).not.toContain('【选题风格参考】')
  })
```

- [ ] **Step 3: 跑测试确认失败**

Run: `export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH" && pnpm --filter @forgecast/copywriter test assemble`
Expected: FAIL（`patternsMd` 不是 `AssembleInput` 已知属性 / prompt 不含该段落）

- [ ] **Step 4: 实现 `assemble.ts`**

`AssembleInput` 接口（现有）：

```ts
export interface AssembleInput {
  hook: HookType
  hookTemplate: string
  formatSpec: string
  knowledgeMd: string
  atoms: Atom[]
  analysis: string
  feedback?: string
}
```

改成（新增 `patternsMd?`，放在 `formatSpec` 之后、`knowledgeMd` 之前，语义上跟"格式规范"更近）：

```ts
export interface AssembleInput {
  hook: HookType
  hookTemplate: string
  formatSpec: string
  patternsMd?: string
  knowledgeMd: string
  atoms: Atom[]
  analysis: string
  feedback?: string
}
```

`prompt` 数组（现有）：

```ts
  const prompt = [
    `【钩子类型】${i.hook}`,
    i.hookTemplate,
    i.formatSpec,
    `【方法论要点】\n${atomsBlock}`,
    `【商业化分析报告】\n${i.analysis}`,
    i.feedback ? `【用户修改意见，必须遵守】\n${i.feedback}` : '',
  ].filter(Boolean).join('\n\n---\n\n')
```

改成（在 `formatSpec` 之后插入 `patternsMd` 段落，跟 `feedback` 一样用三元表达式做"有值才出现"）：

```ts
  const prompt = [
    `【钩子类型】${i.hook}`,
    i.hookTemplate,
    i.formatSpec,
    i.patternsMd ? `【选题风格参考】\n${i.patternsMd}` : '',
    `【方法论要点】\n${atomsBlock}`,
    `【商业化分析报告】\n${i.analysis}`,
    i.feedback ? `【用户修改意见，必须遵守】\n${i.feedback}` : '',
  ].filter(Boolean).join('\n\n---\n\n')
```

- [ ] **Step 5: 跑测试确认通过**

Run: `export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH" && pnpm --filter @forgecast/copywriter test assemble`
Expected: PASS

- [ ] **Step 6: 写 `generate.ts` 失败测试** — `packages/copywriter/test/generate.test.ts` 现有结构：顶部 `import { generateCopy } from '../src/generate'`（第 6 行），`beforeEach` 建好一个 slug 为 `'demo-project'` 的项目 + `analysis.md`（第 11-22 行），所有测试用例都在同一个 `describe('generateCopy', () => { ... })` 块里（第 24-80 行），最后一条用例"同秒内连续两次生成不覆盖"结束于第 79 行 `})`，describe 收尾 `})` 在第 80 行。

顶部 import 区（第 6 行 `import { generateCopy } from '../src/generate'` 之后）加一行：

```ts
import { addSource, extractPatterns, importNotes } from '@forgecast/topics'
```

在第 79 行（最后一条用例的 `})`）之后、第 80 行 describe 收尾 `})` 之前插入两条新用例：

```ts
  it('topic_patterns 有匹配 hook 的记录时，prompt 里出现选题风格参考段落', async () => {
    addSource(ctx, { platform: 'douyin', handle: 'gt', followerCount: 100 })
    importNotes(ctx, { sourceHandle: 'gt', platform: 'douyin', notes: [{ noteId: 'gt1', title: 't', playCount: 50, likeCount: 1 }] })
    await extractPatterns(ctx) // mock fixture 含 pain 类型

    const capturedPrompts: string[] = []
    const real = ctx.llm.complete.bind(ctx.llm)
    ctx.llm.complete = async (req) => { capturedPrompts.push(req.prompt ?? ''); return real(req) }

    await generateCopy(ctx, { slug: 'demo-project', hook: 'pain', n: 1, renderCovers: false })
    expect(capturedPrompts[0]).toContain('【选题风格参考】')
  })
  it('topic_patterns 没有匹配记录时，prompt 里不出现该段落，生成流程不受影响', async () => {
    const capturedPrompts: string[] = []
    const real = ctx.llm.complete.bind(ctx.llm)
    ctx.llm.complete = async (req) => { capturedPrompts.push(req.prompt ?? ''); return real(req) }

    const results = await generateCopy(ctx, { slug: 'demo-project', hook: 'pain', n: 1, renderCovers: false })
    expect(capturedPrompts[0]).not.toContain('【选题风格参考】')
    expect(results.length).toBeGreaterThan(0) // 生成流程照常成功
  })
```

（`ctx.llm.complete` 截获调用参数这个写法，文件里第 48-59/60-66 行两条既有用例（"已 sync 时用检索原子"/"未 sync 时回落整包知识 dump"）已经在用，本 Task 只是照抄同款写法，不是新增手法。）

- [ ] **Step 7: 跑测试确认失败**

Run: `export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH" && pnpm --filter @forgecast/copywriter test generate`
Expected: FAIL（`prompt` 里没有选题风格参考段落，因为 `generate.ts` 还没接线）

- [ ] **Step 8: 实现 `generate.ts`**

顶部 import 区（现有 `import { assemblePrompt } from './assemble'` 等）加一行：

```ts
import { listPatterns } from '@forgecast/topics'
```

`generateCopy` 函数体内，现有构造 `hookTemplate`/`formatSpec`/`atoms`/`knowledgeMd` 那一段（`assemblePrompt({ hook, hookTemplate, formatSpec, knowledgeMd, atoms, analysis, feedback })` 调用之前），在 `assemblePrompt(...)` 调用前加：

```ts
  // 选题库风格参考：查当前 hook 类型最新一条提炼结果，格式化成参考文本；没有则跳过，不影响生成
  const patterns = listPatterns(ctx, hook)
  const patternsMd = patterns.length ? formatPatternsMd(patterns[0]) : ''
```

把原来的：

```ts
  const { system, prompt } = assemblePrompt({ hook, hookTemplate, formatSpec, knowledgeMd, atoms, analysis, feedback })
```

改成：

```ts
  const { system, prompt } = assemblePrompt({ hook, hookTemplate, formatSpec, patternsMd, knowledgeMd, atoms, analysis, feedback })
```

在文件顶部靠近 `readIfExists` 辅助函数（现有）的位置，加一个新的格式化辅助函数：

```ts
/** 把选题库提炼结果格式化成参考风格文本：标题结构示例 + 情绪类型 + 可参考的选题方向。 */
function formatPatternsMd(p: { title_patterns: string; emotion_type: string; recommended_topics: string }): string {
  const titles = (JSON.parse(p.title_patterns) as string[]).map((t) => `- ${t}`).join('\n')
  const topics = (JSON.parse(p.recommended_topics) as string[]).map((t) => `- ${t}`).join('\n')
  return `参考同赛道爆款提炼的标题结构：\n${titles}\n\n情绪类型：${p.emotion_type}\n\n可参考的选题方向：\n${topics}`
}
```

- [ ] **Step 9: 跑测试确认通过**

Run: `export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH" && pnpm --filter @forgecast/copywriter test generate`
Expected: PASS

- [ ] **Step 10: 跑 copywriter 全量确认无回归**

Run: `export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH" && pnpm --filter @forgecast/copywriter test`
Expected: PASS（全绿）

- [ ] **Step 11: 提交**

```bash
git add packages/copywriter/package.json packages/copywriter/src/assemble.ts packages/copywriter/src/generate.ts packages/copywriter/test/assemble.test.ts packages/copywriter/test/generate.test.ts pnpm-lock.yaml
git commit -m "feat(copywriter): 生成文案时注入选题库风格参考"
```

---

## Task 7: 前端"选题库"页面

**Files:**
- Modify: `apps/web/src/api.ts`
- Create: `apps/web/src/pages/TopicsPage.tsx`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/Sidebar.tsx`

**Interfaces:**
- Consumes：Task 5 的 6 个 `/api/topics/*` 路由。
- Produces：`TopicSource`/`ViralNote`/`TopicPattern` TypeScript 接口（`apps/web/src/api.ts`）；`/topics` 路由 + 导航项。

> 前端无单测惯例（同仓库其它页面），本 Task 验证 = `tsc --noEmit` + `vite build` 通过 + 浏览器走查。

- [ ] **Step 1: `api.ts` 加类型** — 文件末尾（`TailorDetail` 接口之后）追加：

```ts
export interface TopicSource {
  id: number; platform: 'douyin' | 'xiaohongshu'; handle: string
  display_name: string | null; follower_count: number | null; note: string | null; created_at: string
}
export interface TopicPattern {
  id: number; hook_type: 'pain' | 'sideline' | 'infogap' | 'story'
  title_patterns: string; emotion_type: string; topic_clusters: string
  recommended_topics: string; sample_note_ids: string; created_at: string
}
```

- [ ] **Step 2: 建页面** — `apps/web/src/pages/TopicsPage.tsx`

```tsx
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { api, subscribeTask, type TopicPattern, type TopicSource } from '../api'

const HOOK_LABEL: Record<TopicPattern['hook_type'], string> = {
  pain: '行业痛点型', sideline: '副业型', infogap: '信息差型', story: '接单故事型',
}
const HOOK_ORDER: TopicPattern['hook_type'][] = ['pain', 'sideline', 'infogap', 'story']

export default function TopicsPage() {
  const qc = useQueryClient()
  const sources = useQuery({ queryKey: ['topics', 'sources'], queryFn: () => api<TopicSource[]>('/api/topics/sources') })
  const patterns = useQuery({ queryKey: ['topics', 'patterns'], queryFn: () => api<TopicPattern[]>('/api/topics/patterns') })

  const [form, setForm] = useState<{ platform: 'douyin' | 'xiaohongshu'; handle: string; name: string; followers: string; note: string }>(
    { platform: 'douyin', handle: '', name: '', followers: '', note: '' },
  )
  const addSource = useMutation({
    mutationFn: () => api('/api/topics/sources', {
      method: 'POST',
      body: JSON.stringify({
        platform: form.platform, handle: form.handle, displayName: form.name || undefined,
        followerCount: form.followers ? Number(form.followers) : undefined, note: form.note || undefined,
      }),
    }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['topics', 'sources'] }); setForm({ platform: 'douyin', handle: '', name: '', followers: '', note: '' }) },
    onError: (e) => alert(e instanceof Error ? e.message : String(e)),
  })
  async function removeSource(id: number) {
    if (!window.confirm('删除该目标账号？（已导入的笔记数据不会一并删除）')) return
    try {
      await api(`/api/topics/sources/${id}`, { method: 'DELETE' })
      qc.invalidateQueries({ queryKey: ['topics', 'sources'] })
    } catch (e) { alert(e instanceof Error ? e.message : String(e)) }
  }

  const [extracting, setExtracting] = useState(false)
  const [extractLog, setExtractLog] = useState('')
  async function extract() {
    setExtracting(true); setExtractLog('')
    try {
      const { taskId } = await api<{ taskId: string }>('/api/topics/extract', { method: 'POST', body: '{}' })
      subscribeTask(taskId, (e) => {
        setExtractLog((s) => `${s}${e.message}\n`)
        if (e.type === 'done') { setExtracting(false); qc.invalidateQueries({ queryKey: ['topics', 'patterns'] }) }
        if (e.type === 'error') setExtracting(false)
      })
    } catch (e) { alert(e instanceof Error ? e.message : String(e)); setExtracting(false) }
  }

  const inp = 'rounded-md border-[1.5px] border-ink bg-card px-2 py-1 text-sm'
  const grouped = HOOK_ORDER.map((h) => ({ hook: h, items: (patterns.data ?? []).filter((p) => p.hook_type === h) }))

  return (
    <div className="space-y-6">
      <div className="card-forge p-4">
        <div className="mb-2 font-semibold">目标账号清单</div>
        <table className="w-full text-sm">
          <thead><tr className="text-left text-faint"><th>平台</th><th>账号</th><th>粉丝数</th><th>备注</th><th /></tr></thead>
          <tbody>
            {sources.data?.map((s) => (
              <tr key={s.id} className="border-t border-hairline">
                <td>{s.platform === 'douyin' ? '抖音' : '小红书'}</td>
                <td>{s.display_name ? `${s.display_name}（${s.handle}）` : s.handle}</td>
                <td>{s.follower_count ?? '—'}</td>
                <td className="text-faint">{s.note ?? ''}</td>
                <td><button className="text-xs text-red-600" onClick={() => removeSource(s.id)}>删除</button></td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="mt-3 flex flex-wrap gap-2">
          <select className={inp} value={form.platform} onChange={(e) => setForm((f) => ({ ...f, platform: e.target.value as any }))}>
            <option value="douyin">抖音</option>
            <option value="xiaohongshu">小红书</option>
          </select>
          <input className={inp} placeholder="账号 handle" value={form.handle} onChange={(e) => setForm((f) => ({ ...f, handle: e.target.value }))} />
          <input className={inp} placeholder="显示名（可选）" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
          <input className={inp} placeholder="粉丝数（可选）" value={form.followers} onChange={(e) => setForm((f) => ({ ...f, followers: e.target.value }))} />
          <input className={inp} placeholder="备注（可选）" value={form.note} onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))} />
          <button className="btn-fire px-3 py-1 text-sm disabled:opacity-50" disabled={addSource.isPending || !form.handle.trim()} onClick={() => addSource.mutate()}>
            添加账号
          </button>
        </div>
      </div>

      <div className="card-forge p-4">
        <div className="mb-2 flex items-center justify-between">
          <div className="font-semibold">选题库</div>
          <div>
            <button className="btn-ink px-3 py-1 text-sm disabled:opacity-50" disabled={extracting} onClick={extract}>
              {extracting ? '提炼中…' : '重新提炼'}
            </button>
          </div>
        </div>
        <p className="mb-3 text-xs text-faint">抓取笔记数据需要在对话里让 Claude 帮你跑一次，这里只能对已导入的数据重新提炼。</p>
        {extractLog && <pre className="mb-3 whitespace-pre-wrap rounded bg-black/5 p-2 text-xs">{extractLog}</pre>}
        <div className="grid grid-cols-2 gap-4">
          {grouped.map(({ hook, items }) => (
            <div key={hook} className="rounded-md border-[1.5px] border-ink p-3">
              <div className="mb-2 text-sm font-bold">{HOOK_LABEL[hook]}（{items.length}）</div>
              {items.map((p) => (
                <div key={p.id} className="mb-2 rounded bg-card p-2 text-xs">
                  <div className="font-medium">标题结构：</div>
                  <ul className="list-disc pl-4">{(JSON.parse(p.title_patterns) as string[]).map((t, i) => <li key={i}>{t}</li>)}</ul>
                  <div className="mt-1">情绪类型：{p.emotion_type}</div>
                  <div className="mt-1 font-medium">推荐选题：</div>
                  <ul className="list-disc pl-4">{(JSON.parse(p.recommended_topics) as string[]).map((t, i) => <li key={i}>{t}</li>)}</ul>
                  <div className="mt-1 text-faint">基于 {(JSON.parse(p.sample_note_ids) as number[]).length} 条笔记提炼于 {p.created_at}</div>
                </div>
              ))}
              {items.length === 0 && <div className="text-xs text-faint">暂无</div>}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 3: 路由接线** — `apps/web/src/App.tsx`

`import`区（现有第 2-9 行）加一行（按字母序插在 `TailorDetailPage`/`WorkshopPage` 之间）：

```tsx
import TopicsPage from './pages/TopicsPage'
```

`<Routes>` 里（现有 `<Route path="/settings" ...>` 之后、`<Route path="/projects/:slug" ...>` 之前，或任意非重定向路由之间均可，插入位置不影响功能）加：

```tsx
          <Route path="/topics" element={<TopicsPage />} />
```

- [ ] **Step 4: 导航项** — `apps/web/src/Sidebar.tsx`

在现有 `TailorIcon`（第 47-51 行）之后加一个新图标：

```tsx
const TopicsIcon = () => (
  <Icon>
    <path d="M4 5h16M4 12h10M4 19h13" />
  </Icon>
)
```

`NAV` 数组（现有，第 63-69 行）在 `{ to: '/tailor', label: '定制项目', icon: TailorIcon }` 之后加一项：

```tsx
  { to: '/topics', label: '选题库', icon: TopicsIcon },
```

- [ ] **Step 5: 构建确认**

Run:
```bash
export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH"
pnpm --filter web exec tsc --noEmit
pnpm --filter web build
```
Expected: 均通过，无 TS 报错。

- [ ] **Step 6: 浏览器走查**（dev server 需重启一次让后端拿到 Task 5 的新路由；具体重启+走查步骤见 Task 8）

- [ ] **Step 7: 提交**

```bash
git add apps/web/src/api.ts apps/web/src/pages/TopicsPage.tsx apps/web/src/App.tsx apps/web/src/Sidebar.tsx
git commit -m "feat(web): 选题库管理页（目标账号清单 + 选题库列表 + 重新提炼）"
```

---

## Task 8: 文档 + 全仓验证

**Files:**
- Modify: `README.md`
- Modify: `开源变现内容工厂-开发文档.md`

- [ ] **Step 1: 全仓测试 + 类型检查 + 构建**

```bash
export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH"
pnpm test
pnpm --filter web exec tsc --noEmit
pnpm --filter web build
```
Expected: 全部通过。

- [ ] **Step 2: README 更新**

`README.md` 的 CLI 命令清单（`forgecast tailor add|list|decompose|search|proposal` 那一行之后）加：

```
forgecast topics add-source --platform=<douyin|xiaohongshu> --handle=<handle> [--name=..] [--followers=N] [--note=..]  # 选题库：加目标账号
forgecast topics import-notes --source=<handle> --platform=<douyin|xiaohongshu> --file=<notes.json>  # 导入抓到的爆款笔记（抓取本身需在对话里让 Claude 用浏览器工具手动跑）
forgecast topics extract [--top=N] [--min-ratio=R]           # LLM 提炼选题模式（标题结构/情绪类型/推荐选题）
forgecast topics list-patterns [--hook=<pain|sideline|infogap|story>]  # 列出选题库
```

目录结构章节（`packages/` 描述那一行）里，`packages/tailor` 之后加一句提及 `packages/topics`：

```
`packages/topics` 选题库（目标账号+爆款笔记+LLM 提炼的选题模式，生成文案时作为风格参考注入）；
```

（拼接进现有那一行的 `packages/` 枚举里，保持原句式，不要另起一段。）

导航板块描述那一行（"定制项目 `/tailor`" 之后）加：

```
/ 选题库 `/topics`（目标账号清单 + 同赛道爆款笔记导入 + LLM 提炼标题结构/情绪类型，生成文案时自动引用，见 docs/superpowers/specs/2026-08-13-topic-pool-design.md）
```

- [ ] **Step 3: 开发文档更新** — `开源变现内容工厂-开发文档.md` 找一处板块清单表格（跟"素材工坊"同结构的那张表），加一行新板块说明：

```
| **选题库** | 目标账号清单（手动维护）+ 爆款笔记导入（CLI，抓取由 agent 会话手动完成）+ LLM 提炼标题结构/情绪类型/推荐选题；生成文案时按 hook 类型自动查最新一条提炼结果拼进 prompt 作参考风格；无数据时不影响现有生成流程（2026-08-13） | M4 |
```

- [ ] **Step 4: 重启 dev server**

```bash
pkill -9 -f "cli.ts dev" 2>&1
lsof -ti tcp:4321 2>/dev/null | xargs -r kill -9
lsof -ti tcp:5173 2>/dev/null | xargs -r kill -9
sleep 1
export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH"
(nohup pnpm dev > /tmp/forgecast-dev.log 2>&1 & echo $! > /tmp/forgecast-dev.pid)
sleep 5
tail -15 /tmp/forgecast-dev.log
```
Expected: 看到 `已启动 http://127.0.0.1:4321` 和 `VITE ... ready`。

- [ ] **Step 5: 浏览器端到端走查**

打开 `/topics`：
- 目标账号清单能添加/删除。
- 点「重新提炼」（mock 模式下无笔记会提示"新增 0 条选题模式"，属预期——先用 CLI `topics import-notes` 或直接建几条 `viral_notes` 测试数据再点）。
- 回「做内容」板块，选一个有选题库数据的 hook 类型生成文案，确认功能整体不报错（prompt 是否真的拼了参考风格文本，靠 Task 6 的单测已验证，这里走查的是端到端 UI 链路不崩）。

- [ ] **Step 6: 提交**

```bash
git add README.md "开源变现内容工厂-开发文档.md"
git commit -m "docs: 选题库功能说明"
```
