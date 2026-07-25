# 看板领域分类 / 筛选 实施计划（看板改进 C）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给候选打领域标签（LLM 主 + 启发式兜底 + 回填现有），看板加类别 chip 单选筛选 + 卡片徽章。

**Architecture:** scout 加 CATEGORIES + categorizeHeuristic + ScoreDetail.category（评分两路都填）+ backfillCategories → server 加回填路由 → web 看板类别筛选 + 卡片徽章 + 回填按钮。

**Tech Stack:** TypeScript + pnpm monorepo + vitest + Hono(server) + React/react-query(web)。

## Global Constraints

- `CATEGORIES`（顺序=启发式优先级，先具体后 AI 后其它）：`['客服/IM','CRM/销售','电商/商城','仪表盘/BI','表单/问卷','文档/知识库','建站/CMS','项目/协作','财务/发票','预约/排期','AI助手/Agent','其它']`。
- category 三路：LLM 评分出（不在表内→启发式兜底）；heuristicScore 用启发式；backfill 用启发式给缺分类的候选（无 score_detail 的跳过）。
- 前端类别筛选**单选**、只统计/筛可商用（`license_ok===1`）；卡片徽章 category 非空且非「其它」才显示。
- 中文注释、中文提交、严格 TDD、Node22（`nvm use 22.23.1`，pnpm 用 `corepack pnpm`）。

---

### Task 1: scout 领域分类逻辑 + 接入评分

**Files:**
- Modify: `packages/scout/src/types.ts`（ScoreDetail 加 category）
- Modify: `packages/scout/src/score.ts`（CATEGORIES + categorizeHeuristic + 两路填 category）
- Test: `packages/scout/test/score.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `CATEGORIES: readonly string[]`（score.ts 导出）
  - `categorizeHeuristic(repo: string, text: string, techStack: string[]): string`
  - `ScoreDetail.category: string`

- [ ] **Step 1: 写失败测试**

追加到 `packages/scout/test/score.test.ts`（导入处补 `categorizeHeuristic`；`scoreCandidate` 应已导入）：

```typescript
describe('categorizeHeuristic 领域分类', () => {
  it('关键词→领域；无命中→其它；领域优先于 AI', () => {
    expect(categorizeHeuristic('foo/chatwoot', 'live chat helpdesk support', [])).toBe('客服/IM')
    expect(categorizeHeuristic('foo/x', 'invoice billing accounting', [])).toBe('财务/发票')
    expect(categorizeHeuristic('foo/x', 'admin dashboard analytics', [])).toBe('仪表盘/BI')
    expect(categorizeHeuristic('foo/x', 'llm agent assistant rag', [])).toBe('AI助手/Agent')
    expect(categorizeHeuristic('foo/x', 'just some random utility', [])).toBe('其它')
    expect(categorizeHeuristic('foo/x', 'ai powered crm for sales', [])).toBe('CRM/销售') // 领域先于 AI
  })
})

describe('scoreCandidate category（mock 走启发式）', () => {
  it('mock 评分产出启发式 category', async () => {
    const d = await scoreCandidate(ctx, { repo: 'x/chat', url: 'u', description: null, license: 'MIT', stars: 1, lastCommit: '2026-01-01', topics: [] }, 'live chat helpdesk')
    expect(d.category).toBe('客服/IM')
  })
})
```

（注：`ctx` 在该测试文件 beforeEach 已建，`config = loadConfig(root, {})` 即 llm mock。`RepoMeta` 字段以 `packages/scout/src/types.ts` 为准，上面构造已含 repo/url/description/license/stars/lastCommit/topics——若字段名不符按实际调整。）

- [ ] **Step 2: 跑测试确认失败**

Run: `corepack pnpm --filter @forgecast/scout test score`
Expected: FAIL —— `categorizeHeuristic` 未导出 / `d.category` undefined。

- [ ] **Step 3: 实现**

`packages/scout/src/types.ts` 的 `ScoreDetail` 接口加一行：

```typescript
  category: string // 领域标签，取自 CATEGORIES
```

`packages/scout/src/score.ts`：顶部（TECHS 附近）加 CATEGORIES + 关键词表 + categorizeHeuristic：

```typescript
/** 领域类别闭集（顺序=启发式匹配优先级：先具体领域，AI 靠后，最后其它）。 */
export const CATEGORIES = ['客服/IM', 'CRM/销售', '电商/商城', '仪表盘/BI', '表单/问卷', '文档/知识库', '建站/CMS', '项目/协作', '财务/发票', '预约/排期', 'AI助手/Agent', '其它'] as const

const CATEGORY_KW: Array<[string, RegExp]> = [
  ['客服/IM', /chat|chatbot|chatwoot|helpdesk|support|客服|messaging|\bim\b/],
  ['CRM/销售', /crm|sales|lead|pipeline|销售|客户管理/],
  ['电商/商城', /ecommerce|commerce|shop|store|cart|\bpos\b|saleor|电商|商城/],
  ['仪表盘/BI', /dashboard|admin|analytics|\bbi\b|metabase|report|仪表盘|报表/],
  ['表单/问卷', /form|survey|questionnaire|poll|表单|问卷/],
  ['文档/知识库', /docs|wiki|knowledge|notion|markdown|文档|知识库/],
  ['建站/CMS', /\bcms\b|website|landing|wordpress|strapi|建站/],
  ['项目/协作', /project|task|kanban|todo|collaborat|项目管理|看板/],
  ['财务/发票', /invoice|accounting|finance|billing|payment|expense|财务|发票/],
  ['预约/排期', /booking|appointment|schedul|calendar|reservation|预约|排期/],
  ['AI助手/Agent', /\bai\b|\bllm\b|agent|\brag\b|gpt|assistant|langchain|智能|大模型/],
]

/** 启发式领域分类：repo+文本+techStack 拼小写，按 CATEGORY_KW 顺序首个命中的类；都不中→其它。 */
export function categorizeHeuristic(repo: string, text: string, techStack: string[]): string {
  const hay = `${repo} ${text} ${techStack.join(' ')}`.toLowerCase()
  for (const [cat, re] of CATEGORY_KW) if (re.test(hay)) return cat
  return '其它'
}
```

`heuristicScore` 的 return 加 `category`（`techStack` 变量在其作用域内已算好）：

```typescript
  return {
    rebrandCost, buyerClarity, visualAppeal, techStack: [...new Set(techStack)],
    rationale: `离线启发式评分：${meta.repo}`,
    targetBuyer: '', painPoint: '',
    category: categorizeHeuristic(meta.repo, readme, techStack),
  }
```

`parseScoreJson` 的 return 加 `category`（读 LLM 的，缺则空串——收尾由 scoreCandidate 校验）：

```typescript
    painPoint: typeof o.painPoint === 'string' ? o.painPoint : '',
    category: typeof o.category === 'string' ? o.category : '',
```

`scoreCandidate` 的 LLM 分支：prompt 的输出 JSON 那行末尾加 `,"category":"从下列类别选一个最贴切的"`，并在 prompt 数组里加一行 `` `类别（选一个）：${CATEGORIES.join(' / ')}` ``；`const raw = await ctx.llm.complete(...)` 之后改为：

```typescript
  const detail = parseScoreJson(raw)
  // LLM 给的类别不在闭集内 → 启发式兜底，杜绝表外标签
  detail.category = (CATEGORIES as readonly string[]).includes(detail.category) ? detail.category : categorizeHeuristic(meta.repo, readme, detail.techStack)
  return detail
```

- [ ] **Step 4: 跑测试 + tsc**

Run: `corepack pnpm --filter @forgecast/scout test score`、`npx tsc -p packages/scout/tsconfig.json --noEmit`
Expected: 全绿、tsc 无输出。（ScoreDetail 加了必填 category，heuristicScore/parseScoreJson 两处都已填，tsc 应过；若别处构造 ScoreDetail 报缺 category，补 category）。

- [ ] **Step 5: 提交**

```bash
git add packages/scout
git commit -m "feat(scout): 领域分类 CATEGORIES/categorizeHeuristic + 评分产出 category"
```

---

### Task 2: scout.backfillCategories 回填现有候选

**Files:**
- Modify: `packages/scout/src/scout.ts`
- Test: `packages/scout/test/scout.test.ts`

**Interfaces:**
- Consumes: `CATEGORIES`/`categorizeHeuristic`（Task1，从 `./score` import）
- Produces: `backfillCategories(ctx: CoreCtx): number`

- [ ] **Step 1: 写失败测试**

追加到 `packages/scout/test/scout.test.ts`（导入处补 `backfillCategories`）：

```typescript
describe('backfillCategories', () => {
  it('给缺/非法 category 的候选写启发式类；已有合法的不动；无 score_detail 跳过；返回更新数', () => {
    const ins = ctx.db.prepare("INSERT INTO candidates (repo,url,description,license_ok,score,score_detail,status) VALUES (?,?,?,1,50,?, 'candidate')")
    ins.run('a/chat', 'u1', 'live chat helpdesk', JSON.stringify({ rebrandCost: 10, techStack: [] }))       // 缺 category → 回填
    ins.run('a/inv', 'u2', 'invoice billing', JSON.stringify({ category: '不在表内', techStack: [] }))       // 非法 → 回填
    ins.run('a/keep', 'u3', 'whatever', JSON.stringify({ category: 'CRM/销售', techStack: [] }))             // 合法 → 不动
    ins.run('a/none', 'u4', 'x', null)                                                                        // 无 detail → 跳过
    const n = backfillCategories(ctx)
    expect(n).toBe(2)
    const cat = (repo: string) => JSON.parse((ctx.db.prepare('SELECT score_detail FROM candidates WHERE repo=?').get(repo) as any).score_detail).category
    expect(cat('a/chat')).toBe('客服/IM')
    expect(cat('a/inv')).toBe('财务/发票')
    expect(cat('a/keep')).toBe('CRM/销售') // 未被改
    expect((ctx.db.prepare("SELECT score_detail FROM candidates WHERE repo='a/none'").get() as any).score_detail).toBeNull()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `corepack pnpm --filter @forgecast/scout test scout`
Expected: FAIL —— `backfillCategories` 未导出。

- [ ] **Step 3: 实现**

`packages/scout/src/scout.ts`：顶部 import 补 `import { CATEGORIES, categorizeHeuristic } from './score'`（若已从 './score' import 别的，合并）。加函数：

```typescript
/** 回填现有候选的领域标签：score_detail 里 category 缺/非法的，用 categorizeHeuristic 算并写回。无 score_detail 跳过。返回更新条数。 */
export function backfillCategories(ctx: CoreCtx): number {
  const rows = ctx.db.prepare('SELECT id, repo, description, score_detail FROM candidates').all() as Array<{ id: number; repo: string; description: string | null; score_detail: string | null }>
  const upd = ctx.db.prepare('UPDATE candidates SET score_detail = ? WHERE id = ?')
  let n = 0
  for (const r of rows) {
    if (!r.score_detail) continue
    let d: any
    try { d = JSON.parse(r.score_detail) } catch { continue }
    if (d.category && (CATEGORIES as readonly string[]).includes(d.category)) continue
    d.category = categorizeHeuristic(r.repo, r.description ?? '', Array.isArray(d.techStack) ? d.techStack : [])
    upd.run(JSON.stringify(d), r.id); n++
  }
  return n
}
```

- [ ] **Step 4: 跑测试 + tsc**

Run: `corepack pnpm --filter @forgecast/scout test scout`、`npx tsc -p packages/scout/tsconfig.json --noEmit`
Expected: 全绿、tsc 无输出。

- [ ] **Step 5: 提交**

```bash
git add packages/scout
git commit -m "feat(scout): backfillCategories 回填现有候选领域标签"
```

---

### Task 3: 后端 POST /api/candidates/backfill-categories

**Files:**
- Modify: `packages/server/src/app.ts`
- Test: `packages/server/test/backfill-cat.test.ts`（新建）

**Interfaces:**
- Consumes: `backfillCategories`（scout，Task2）
- Produces: REST `POST /api/candidates/backfill-categories` → `{ updated: number }`

- [ ] **Step 1: 写失败测试**

新建 `packages/server/test/backfill-cat.test.ts`：

```typescript
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'
import { createLlmClient, loadConfig, openDb, type CoreCtx } from '@forgecast/core'
import { beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/app'
import { createTaskQueue } from '../src/tasks'

let ctx: CoreCtx, app: ReturnType<typeof createApp>
beforeEach(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-bfc-'))
  ctx = { db: openDb(loadConfig(root, {}).paths.db), config: loadConfig(root, {}), llm: createLlmClient(loadConfig(root, {}).llm) }
  ctx.db.prepare("INSERT INTO candidates (repo,url,description,license_ok,score,score_detail,status) VALUES ('a/chat','u','live chat helpdesk',1,50,?, 'candidate')")
    .run(JSON.stringify({ rebrandCost: 10, techStack: [] })) // 缺 category
  app = createApp(ctx, createTaskQueue())
})

describe('POST /api/candidates/backfill-categories', () => {
  it('回填缺分类候选 → 返 {updated} 且 category 写入', async () => {
    const r = await (await app.request('/api/candidates/backfill-categories', { method: 'POST' })).json() as any
    expect(r.updated).toBe(1)
    const cat = JSON.parse((ctx.db.prepare("SELECT score_detail FROM candidates WHERE repo='a/chat'").get() as any).score_detail).category
    expect(cat).toBe('客服/IM')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `corepack pnpm --filter @forgecast/server test backfill-cat`
Expected: FAIL —— 路由不存在。

- [ ] **Step 3: 实现路由**

`packages/server/src/app.ts`：line 9 的 `import { ... } from '@forgecast/scout'` 追加 `backfillCategories`。在候选路由区（如 `/api/candidates/rescore-all` 附近）加：

```typescript
  app.post('/api/candidates/backfill-categories', (c) => {
    return c.json({ updated: backfillCategories(ctx) })
  })
```

- [ ] **Step 4: 跑测试 + tsc + 全量 server 不回归**

Run: `corepack pnpm --filter @forgecast/server test backfill-cat`、`corepack pnpm --filter @forgecast/server test`、`npx tsc -p packages/server/tsconfig.json --noEmit`
Expected: 全绿、tsc 无输出。

- [ ] **Step 5: 提交**

```bash
git add packages/server
git commit -m "feat(server): POST /api/candidates/backfill-categories 回填领域标签"
```

---

### Task 4: Web 类别徽章 + 看板筛选 + 回填按钮

**Files:**
- Modify: `apps/web/src/pages/board/CandidateCard.tsx`（Detail 加 category + 徽章）
- Modify: `apps/web/src/pages/BoardPage.tsx`（类别 chip 筛选 + 回填按钮）
- 手动浏览器走查（主控里程碑）

**Interfaces:**
- Consumes: REST `POST /api/candidates/backfill-categories`（Task3）
- Produces: 无

- [ ] **Step 1: CandidateCard 加 category 徽章**

`apps/web/src/pages/board/CandidateCard.tsx`：
1. `Detail` 接口加 `category: string`。
2. `parseDetail` 的 return 加 `category: str(o.category)`。
3. 标题行 license badge 之后、`ml-auto` 分数之前，加类别徽章：

```tsx
        <span className="rounded bg-green-50 px-1.5 py-0.5 text-xs text-green-700">{c.license ?? '—'}</span>
        {d?.category && d.category !== '其它' && (
          <span className="rounded bg-indigo-50 px-1.5 py-0.5 text-xs text-indigo-700">{d.category}</span>
        )}
        <span className="ml-auto text-sm font-semibold">{c.score ?? '—'}</span>
```

- [ ] **Step 2: BoardPage 类别 chip 筛选 + 回填按钮**

`apps/web/src/pages/BoardPage.tsx`：
1. 加 `useState` import（已有）；组件内加：

```tsx
  const [cat, setCat] = useState<string | null>(null)
  const catOf = (c: { score_detail: string | null }): string => {
    try { return (c.score_detail && (JSON.parse(c.score_detail) as any)?.category) || '' } catch { return '' }
  }
  async function backfillCats() {
    try {
      const r = await api<{ updated: number }>('/api/candidates/backfill-categories', { method: 'POST' })
      alert(`已回填 ${r.updated} 个候选的领域分类`); qc.invalidateQueries({ queryKey: ['candidates'] })
    } catch (e) { alert('回填失败：' + (e instanceof Error ? e.message : String(e))) }
  }
```

2. `const ok = rows.filter(...)` 之后加类别聚合 + 过滤：

```tsx
  const catCounts = new Map<string, number>()
  for (const c of ok) { const k = catOf(c); if (k) catCounts.set(k, (catCounts.get(k) ?? 0) + 1) }
  const okShown = cat ? ok.filter((c) => catOf(c) === cat) : ok
```

3. 顶部按钮行加「分类回填」按钮（`全部重新评分` 按钮之后）：

```tsx
        <button className="rounded border px-4 py-2 text-sm disabled:opacity-50" disabled={scanning || rescoringAll} onClick={backfillCats}>
          分类回填
        </button>
```

4. 在「共 N 个候选」那行之下、候选网格之上，加类别筛选条（有分类数据才显示）：

```tsx
      {catCounts.size > 0 && (
        <div className="flex flex-wrap gap-2 text-xs">
          <button className={`rounded-full border px-3 py-1 ${cat === null ? 'bg-blue-600 text-white' : 'bg-white'}`} onClick={() => setCat(null)}>全部 ({ok.length})</button>
          {[...catCounts.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => (
            <button key={k} className={`rounded-full border px-3 py-1 ${cat === k ? 'bg-blue-600 text-white' : 'bg-white'}`} onClick={() => setCat(k)}>{k} ({n})</button>
          ))}
        </div>
      )}
```

5. 候选网格的 `ok.map(...)` 改成 `okShown.map(...)`（`rank={i + 1}` 不变，按过滤后重新编号）。

- [ ] **Step 3: 构建校验**

Run: `corepack pnpm --filter web build`
Expected: 构建成功、无 TS 报错。

- [ ] **Step 4: 提交**

```bash
git add apps/web
git commit -m "feat(web): 看板领域类别筛选 + 卡片徽章 + 分类回填按钮"
```

- [ ] **Step 5: 手动浏览器走查（主控里程碑）**

主控起 dev：看板点「分类回填」→ alert 回填数 → 类别 chip 出现（带计数）+ 卡片显示类别徽章 → 点某 chip 只看该类、点「全部」恢复。

---

## 完成标准
- `categorizeHeuristic`/`backfillCategories`/评分 category/backfill 路由 有测试全绿；tsc 干净；全量 server/scout 不回归。
- web 构建过；看板回填后有类别 chip 筛选 + 卡片徽章，单选过滤生效。

## 已知非纯代码成本
- Task4 Step5 主控手动走查。
- 启发式分类对长 README 会偏"客服/AI"（chat/ai 关键词常见）——LLM 重评分会修正；本轮可接受。
