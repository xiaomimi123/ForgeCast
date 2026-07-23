# 项目看板改版 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 候选池从窄表格改成信息完整的卡片列表——项目简介、三维评分说明、目标群体、行业痛点都能一眼看到。

**Architecture:** 一半是数据采集问题：`description` 从 GitHub API 补采并落库，`targetBuyer`/`painPoint` 并入现有的 `scoreCandidate` LLM 调用（不新增请求），存进 `score_detail` JSON。立项后的深度信息由 `analysis.md` 解析而来。另一半是展示：`BoardPage.tsx` 拆成三个文件，候选区改卡片。

**Tech Stack:** TypeScript、pnpm workspace、vitest、better-sqlite3、Hono、React 18 + TanStack Query + Tailwind。

## Global Constraints

- 设计文档：`docs/superpowers/specs/2026-07-23-board-page-redesign-design.md`，与本计划冲突时以设计文档为准。
- **mock 模式绝不编造 `targetBuyer`/`painPoint`**，一律空串。本仓库既有约定：每个 LLM 能力自带 mock，不共用别人的 fixture。
- 数据库迁移一律走 `packages/core/src/db.ts` 里既有的 `ensureColumn`（幂等、可重跑），不写一次性脚本。
- 旧数据兼容：`score_detail` 里没有新字段的老行，读出来必须不崩。
- 中文注释与提交信息，跟随仓库既有风格。
- 每个任务结束后跑 `pnpm -r test`，全绿才提交。

---

### Task 1: 采集并落库 GitHub `description`

**Files:**
- Modify: `packages/scout/src/types.ts`
- Modify: `packages/scout/src/github.ts:38-46`（live `searchRepos` 的 `seen.set`）
- Modify: `packages/scout/src/fixtures/candidate-fixtures.ts`（5 个 fixture 各加一行）
- Modify: `packages/core/src/db.ts:75`（`ensureColumn` 区）
- Modify: `packages/scout/src/scout.ts:11-33`（`UPSERT` 常量与 `ingest`）
- Test: `packages/scout/test/scout.test.ts`

**Interfaces:**
- Consumes: 无（首个任务）
- Produces: `RepoMeta.description: string | null`；`candidates` 表新增 `description TEXT` 列；`CandidateFixture` 因继承 `RepoMeta` 同步获得该字段。

- [ ] **Step 1: 写失败测试**

追加到 `packages/scout/test/scout.test.ts` 末尾：

```typescript
describe('description 采集', () => {
  it('fixture 的 description 落库（与 LLM 模式无关）', async () => {
    await scoutCandidates(ctx)
    const row: any = ctx.db.prepare('SELECT description FROM candidates WHERE repo = ?').get('chatwoot/chatwoot')
    expect(row.description).toBe('开源多渠道在线客服平台')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @forgecast/scout test`
Expected: FAIL —— `no such column: description`

- [ ] **Step 3: 加字段与迁移**

`packages/scout/src/types.ts` 的 `RepoMeta` 加一行：

```typescript
export interface RepoMeta {
  repo: string // owner/name
  url: string
  description: string | null // GitHub 仓库简介，一句话
  license: string | null // SPDX id
  stars: number
  lastCommit: string | null
  topics: string[]
}
```

`packages/core/src/db.ts` 在 `ensureColumn(db, 'assets', 'published_url', 'TEXT')` 那一行下面加：

```typescript
  ensureColumn(db, 'candidates', 'description', 'TEXT')
```

- [ ] **Step 4: live 抓取捕获 description**

`packages/scout/src/github.ts` 的 `searchRepos` 里，`seen.set(...)` 改为：

```typescript
          seen.set(it.full_name, {
            repo: it.full_name, url: it.html_url, description: it.description ?? null,
            license: it.license?.spdx_id ?? null,
            stars: it.stargazers_count ?? 0, lastCommit: it.pushed_at ?? null, topics: it.topics ?? [],
          })
```

同文件 mock 分支的 `searchRepos` 改为：

```typescript
      async searchRepos() {
        return candidateFixtures.map((f) => ({
          repo: f.repo, url: f.url, description: f.description, license: f.license,
          stars: f.stars, lastCommit: f.lastCommit, topics: f.topics,
        }))
      },
```

- [ ] **Step 5: fixtures 补 description**

`packages/scout/src/fixtures/candidate-fixtures.ts`，5 个 fixture 各加一个 `description` 字段（放在 `url` 后面）。按 repo 对应填：

```typescript
  // chatwoot/chatwoot
  description: '开源多渠道在线客服平台',
  // invoiceninja/invoiceninja
  description: '开源发票与报价系统，面向小商户开账单',
  // formbricks/formbricks
  description: '开源表单与问卷平台，Next.js 自部署',
  // twentyhq/twenty
  description: '开源 CRM，React 前端与现代 dashboard',
  // gpl-example/copyleft-tool
  description: '开源库存管理工具（GPL，用于触发协议 gate）',
```

- [ ] **Step 6: `addRepo` 的兜底 meta 补字段**

`packages/scout/src/scout.ts` 的 `addRepo` 里那个 `?? { ... }` 兜底对象加 `description: null`：

```typescript
  const meta = all.find((m) => m.repo === repo)
    ?? { repo, url: `https://github.com/${repo}`, description: null, license: null, stars: 0, lastCommit: null, topics: [] }
```

- [ ] **Step 7: UPSERT 写入 description**

`packages/scout/src/scout.ts` 的 `UPSERT` 常量改为：

```typescript
const UPSERT = `INSERT INTO candidates (repo, url, description, license, license_ok, stars, last_commit, tech_stack, score, score_detail, status)
VALUES (@repo, @url, @description, @license, @license_ok, @stars, @last_commit, @tech_stack, @score, @score_detail, 'candidate')
ON CONFLICT(repo) DO UPDATE SET url=excluded.url, description=excluded.description, license=excluded.license, license_ok=excluded.license_ok,
  stars=excluded.stars, last_commit=excluded.last_commit, tech_stack=excluded.tech_stack,
  score=excluded.score, score_detail=excluded.score_detail`
```

`ingest` 里的 `.run({...})` 加一项：

```typescript
    repo: meta.repo, url: meta.url, description: meta.description, license: meta.license, license_ok: ok ? 1 : 0,
```

- [ ] **Step 8: 跑测试确认通过**

Run: `pnpm --filter @forgecast/scout test`
Expected: PASS，全部 scout 用例绿（含既有的 15 个）

- [ ] **Step 9: 全量测试 + 提交**

Run: `pnpm -r test`
Expected: 全部包 PASS

```bash
git add packages/scout packages/core/src/db.ts
git commit -m "feat(scout): 采集 GitHub description 并落库候选表"
```

---

### Task 2: 评分产出 targetBuyer / painPoint

**Files:**
- Modify: `packages/scout/src/types.ts`（`ScoreDetail`）
- Modify: `packages/scout/src/score.ts`（prompt、`parseScoreJson`、`heuristicScore`）
- Modify: `packages/scout/src/scout.ts`（`ingest` 里 `scoreDetail` 的 JSON.stringify）
- Test: `packages/scout/test/score.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `RepoMeta.description`
- Produces: `ScoreDetail` 新增 `targetBuyer: string` 与 `painPoint: string`（mock 下为 `''`）；两者随 `score_detail` JSON 落库。

- [ ] **Step 1: 写失败测试**

追加到 `packages/scout/test/score.test.ts`。注意 live 测试用假 `LlmClient`，参考 `packages/analyst/test/analyze.test.ts:53` 的手搓 ctx 写法：

```typescript
describe('targetBuyer / painPoint', () => {
  it('mock 模式两字段为空串，不编造', async () => {
    const meta = { repo: 'a/b', url: 'u', description: 'd', license: 'MIT', stars: 100, lastCommit: null, topics: [] }
    const d = await scoreCandidate(ctx, meta, 'react docker dashboard screenshot crm')
    expect(d.targetBuyer).toBe('')
    expect(d.painPoint).toBe('')
  })

  it('live 模式从 LLM JSON 解析出两字段', async () => {
    const llm = {
      complete: async () => JSON.stringify({
        rebrandCost: 20, buyerClarity: 30, visualAppeal: 20, techStack: ['react'],
        rationale: '理由', targetBuyer: '做外贸的中小电商老板', painPoint: '客户散在多个入口，漏回消息',
      }),
    }
    const config = loadConfig(root, { FORGECAST_LLM_MODE: 'live', FORGECAST_LLM_KEY: 'k' })
    const lctx: CoreCtx = { db: openDb(config.paths.db), config, llm: llm as any }
    const meta = { repo: 'a/b', url: 'u', description: 'd', license: 'MIT', stars: 100, lastCommit: null, topics: [] }
    const d = await scoreCandidate(lctx, meta, 'readme')
    expect(d.targetBuyer).toBe('做外贸的中小电商老板')
    expect(d.painPoint).toBe('客户散在多个入口，漏回消息')
  })

  it('LLM 漏返这两个字段时按空串处理，不抛错', async () => {
    const llm = { complete: async () => JSON.stringify({ rebrandCost: 10, buyerClarity: 10, visualAppeal: 10 }) }
    const config = loadConfig(root, { FORGECAST_LLM_MODE: 'live', FORGECAST_LLM_KEY: 'k' })
    const lctx: CoreCtx = { db: openDb(config.paths.db), config, llm: llm as any }
    const meta = { repo: 'a/b', url: 'u', description: 'd', license: 'MIT', stars: 100, lastCommit: null, topics: [] }
    const d = await scoreCandidate(lctx, meta, 'readme')
    expect(d.targetBuyer).toBe('')
    expect(d.painPoint).toBe('')
  })
})
```

若该测试文件当前没有 `root` 变量或 `CoreCtx`/`loadConfig`/`openDb` 的 import，按 `packages/scout/test/scout.test.ts:1-13` 的写法补上（`beforeEach` 里 `root = fs.mkdtempSync(...)`，`root` 提升为模块级 `let`）。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @forgecast/scout test score`
Expected: FAIL —— `targetBuyer` 是 `undefined` 而非 `''`

- [ ] **Step 3: 扩展 ScoreDetail 类型**

`packages/scout/src/types.ts`：

```typescript
export interface ScoreDetail {
  rebrandCost: number // 0-30 换皮成本
  buyerClarity: number // 0-40 买家清晰度
  visualAppeal: number // 0-30 内容可视性
  techStack: string[]
  rationale: string
  targetBuyer: string // 什么老板会掏钱，一句话；mock 下为空串（不编造）
  painPoint: string // 解决的行业痛点，一句话；mock 下为空串
}
```

- [ ] **Step 4: live prompt 加两个输出字段**

`packages/scout/src/score.ts` 的 `prompt` 数组里，把输出 JSON 那一行替换为：

```typescript
    `输出 JSON：{"rebrandCost":n,"buyerClarity":n,"visualAppeal":n,"techStack":["..."],"rationale":"一句话","targetBuyer":"什么老板会掏钱，一句话（行业+规模）","painPoint":"解决的行业痛点，一句话，注明现状成本"}`,
```

- [ ] **Step 5: 解析与 mock 分支**

`parseScoreJson` 的 return 加两行：

```typescript
    rationale: typeof o.rationale === 'string' ? o.rationale : '',
    targetBuyer: typeof o.targetBuyer === 'string' ? o.targetBuyer : '',
    painPoint: typeof o.painPoint === 'string' ? o.painPoint : '',
```

`heuristicScore` 的 return 加两行（**保持空串，这是有意为之**）：

```typescript
  return {
    rebrandCost, buyerClarity, visualAppeal, techStack: [...new Set(techStack)],
    rationale: `离线启发式评分：${meta.repo}`,
    // mock 不编造买家与痛点——关键词拼出来的假数据比空着更坏
    targetBuyer: '', painPoint: '',
  }
```

- [ ] **Step 6: 落库带上新字段**

`packages/scout/src/scout.ts` 的 `ingest` 里：

```typescript
    scoreDetail = JSON.stringify({
      rebrandCost: d.rebrandCost, buyerClarity: d.buyerClarity, visualAppeal: d.visualAppeal,
      rationale: d.rationale, targetBuyer: d.targetBuyer, painPoint: d.painPoint,
    })
```

- [ ] **Step 7: 跑测试确认通过**

Run: `pnpm --filter @forgecast/scout test`
Expected: PASS

- [ ] **Step 8: 全量测试 + 提交**

Run: `pnpm -r test`

```bash
git add packages/scout
git commit -m "feat(scout): 评分并出目标群体与行业痛点（mock 留空不编造）"
```

---

### Task 3: 单个候选重新评分

**Files:**
- Modify: `packages/scout/src/scout.ts`（导出 `rescoreCandidate`）
- Modify: `packages/scout/src/index.ts`（导出）
- Modify: `packages/server/src/app.ts`（`/api/candidates` 路由区，约 240-255 行）
- Test: `packages/server/test/candidates.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `ScoreDetail.targetBuyer/painPoint`；`ingest`
- Produces: `rescoreCandidate(ctx, id): Promise<void>`，id 不存在时抛 `Error('候选不存在: <id>')`；`POST /api/candidates/:id/rescore` → `{ ok: true, mode: 'mock' | 'live' }`，不存在返回 404。

- [ ] **Step 1: 写失败测试**

追加到 `packages/server/test/candidates.test.ts`：

```typescript
describe('rescore', () => {
  it('重新评分改写 score_detail 且幂等；模式随响应返回', async () => {
    const { taskId } = await (await app.request('/api/candidates/add', {
      method: 'POST', body: JSON.stringify({ url: 'https://github.com/chatwoot/chatwoot' }),
    })).json() as any
    await runTask(taskId)
    const row: any = ctx.db.prepare('SELECT id, score_detail FROM candidates WHERE repo = ?').get('chatwoot/chatwoot')

    const r = await app.request(`/api/candidates/${row.id}/rescore`, { method: 'POST' })
    expect(r.status).toBe(200)
    const body = await r.json() as any
    expect(body.ok).toBe(true)
    expect(body.mode).toBe('mock')

    const after: any = ctx.db.prepare('SELECT score_detail FROM candidates WHERE id = ?').get(row.id)
    expect(JSON.parse(after.score_detail).targetBuyer).toBe('') // mock 不编造
    expect(after.score_detail).toBe(row.score_detail) // mock 确定性评分 → 幂等
  })

  it('候选不存在返回 404', async () => {
    const r = await app.request('/api/candidates/9999/rescore', { method: 'POST' })
    expect(r.status).toBe(404)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @forgecast/server test candidates`
Expected: FAIL —— 404（路由不存在）导致第一个用例 `expect(r.status).toBe(200)` 失败

- [ ] **Step 3: 实现 rescoreCandidate**

`packages/scout/src/scout.ts` 末尾加（`ingest` 已在同文件内，直接复用）：

```typescript
/** 重新评分单个候选：按 id 取回元数据 → 重抓 README → 重跑评分 → upsert 回写 */
export async function rescoreCandidate(ctx: CoreCtx, id: number): Promise<void> {
  const row = ctx.db.prepare(
    'SELECT repo, url, description, license, stars, last_commit FROM candidates WHERE id = ?',
  ).get(id) as any
  if (!row) throw new Error(`候选不存在: ${id}`)
  const gh = createGithubClient(ctx.config.github)
  // topics 不入库，重评分时按空处理。只影响 tech_stack 里来自 topic 的那部分，
  // 三个维度分数与 targetBuyer/painPoint 都只依赖 README，不受影响。
  await ingest(ctx, gh, {
    repo: row.repo, url: row.url, description: row.description,
    license: row.license, stars: row.stars, lastCommit: row.last_commit, topics: [],
  }, true)
}
```

确认 `packages/scout/src/index.ts` 导出了 `./scout`（既有 `export * from './scout'` 即可，无需改动；若没有则补上）。

- [ ] **Step 4: 加 REST 路由**

`packages/server/src/app.ts`，在 `/api/candidates/pick` 路由后面加：

```typescript
  app.post('/api/candidates/:id/rescore', async (c) => {
    const id = Number(c.req.param('id'))
    if (!Number.isInteger(id)) return c.json({ error: '非法 id' }, 400)
    try {
      await rescoreCandidate(ctx, id)
      // 带上模式：mock 下不会产生痛点/目标群体，前端据此提示
      return c.json({ ok: true, mode: ctx.config.llm.mode })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return c.json({ error: msg }, msg.startsWith('候选不存在') ? 404 : 400)
    }
  })
```

同文件顶部 import 补 `rescoreCandidate`：

```typescript
import { addRepo, pickCandidate, rescoreCandidate, scoutCandidates } from '@forgecast/scout'
```

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm --filter @forgecast/server test candidates`
Expected: PASS

- [ ] **Step 6: 全量测试 + 提交**

Run: `pnpm -r test`

```bash
git add packages/scout packages/server
git commit -m "feat(scout): 单个候选重新评分 + REST 端点"
```

---

### Task 4: analysis.md 摘要解析

**Files:**
- Create: `packages/analyst/src/summary.ts`
- Modify: `packages/analyst/src/index.ts`
- Modify: `packages/server/src/app.ts:21-23`（`GET /api/projects`）
- Test: `packages/analyst/test/summary.test.ts`

**Interfaces:**
- Consumes: 无
- Produces: `parseAnalysisSummary(md: string): { targetBuyer: string; painPoint: string }`，缺段/空串一律返回 `{ targetBuyer: '', painPoint: '' }`；`GET /api/projects` 每项附 `analysis_summary`。

- [ ] **Step 1: 写失败测试**

新建 `packages/analyst/test/summary.test.ts`：

```typescript
import { describe, expect, it } from 'vitest'
import { parseAnalysisSummary } from '../src/summary'

const FULL = `# demo 商业化分析

## 一句话：这是给谁的什么
给中小老板的工具

## 目标买家画像（主攻1个，备选2个）
- 主攻：需要该工具但没技术团队的中小商家（1-5人）
- 备选1：做外包接单的开发者

## 痛点清单（按付费意愿排序，每条注明"现状成本"）
1. 现在用通用工具凑合，效率低（现状成本：每天额外若干小时）
2. 商用 SaaS 年费高

## 风险
无
`

describe('parseAnalysisSummary', () => {
  it('取目标买家与痛点各首条，去掉列表符号', () => {
    const s = parseAnalysisSummary(FULL)
    expect(s.targetBuyer).toBe('主攻：需要该工具但没技术团队的中小商家（1-5人）')
    expect(s.painPoint).toBe('现在用通用工具凑合，效率低（现状成本：每天额外若干小时）')
  })

  it('缺段返回空串，不抛错', () => {
    const s = parseAnalysisSummary('# 标题\n\n## 风险\n无\n')
    expect(s).toEqual({ targetBuyer: '', painPoint: '' })
  })

  it('空输入返回空串', () => {
    expect(parseAnalysisSummary('')).toEqual({ targetBuyer: '', painPoint: '' })
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @forgecast/analyst test summary`
Expected: FAIL —— 找不到模块 `../src/summary`

- [ ] **Step 3: 实现解析**

新建 `packages/analyst/src/summary.ts`：

```typescript
export interface AnalysisSummary { targetBuyer: string; painPoint: string }

/** 取某个 ## 标题下的首个非空正文行，去掉列表符号（- / 1. ）。找不到返回空串 */
function firstItem(md: string, heading: string): string {
  const lines = md.split('\n')
  const start = lines.findIndex((l) => l.startsWith('## ') && l.includes(heading))
  if (start < 0) return ''
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]
    if (line.startsWith('## ')) break // 撞到下一段仍没内容
    const t = line.trim()
    if (t) return t.replace(/^[-*]\s*/, '').replace(/^\d+[.、]\s*/, '')
  }
  return ''
}

/**
 * 从 analysis.md 抽两条摘要给看板泳道卡片用。
 * analysis.md 由 M2 生成、结构已被 validateAnalysis 校验过；但这里对缺段一律 fail-soft ——
 * 立项后尚未跑分析是常态，不该让整个项目列表接口报错。
 */
export function parseAnalysisSummary(md: string): AnalysisSummary {
  if (!md) return { targetBuyer: '', painPoint: '' }
  return {
    targetBuyer: firstItem(md, '目标买家画像'),
    painPoint: firstItem(md, '痛点清单'),
  }
}
```

`packages/analyst/src/index.ts` 加一行：

```typescript
export * from './summary'
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @forgecast/analyst test summary`
Expected: PASS（3 个用例）

- [ ] **Step 5: 项目列表接口附摘要**

`packages/server/src/app.ts` 的 `GET /api/projects` 改为：

```typescript
  app.get('/api/projects', (c) => {
    const rows = ctx.db.prepare('SELECT * FROM projects ORDER BY id').all() as any[]
    // 附上 analysis.md 摘要给看板泳道卡片；没跑过分析的项目为空对象，不报错
    return c.json(rows.map((r) => {
      const p = path.join(ctx.config.paths.workspace, r.slug, 'analysis.md')
      const md = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : ''
      return { ...r, analysis_summary: parseAnalysisSummary(md) }
    }))
  })
```

同文件 import 补：

```typescript
import { analyzeProject, parseAnalysisSummary } from '@forgecast/analyst'
```

- [ ] **Step 6: 写接口测试**

追加到 `packages/server/test/projects.test.ts`（该文件已有建项目的 helper，沿用它建一个项目再写 analysis.md）：

```typescript
it('项目列表附 analysis_summary；没有 analysis.md 时为空串', async () => {
  ctx.db.prepare("INSERT INTO projects (slug, brand_name, stage) VALUES ('demo', '演示', 'analysis')").run()
  const before = await (await app.request('/api/projects')).json() as any[]
  expect(before.find((p) => p.slug === 'demo').analysis_summary).toEqual({ targetBuyer: '', painPoint: '' })

  const dir = path.join(ctx.config.paths.workspace, 'demo')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'analysis.md'),
    '## 目标买家画像\n- 主攻：中小商家\n\n## 痛点清单\n1. 效率低\n', 'utf8')

  const after = await (await app.request('/api/projects')).json() as any[]
  expect(after.find((p) => p.slug === 'demo').analysis_summary).toEqual({
    targetBuyer: '主攻：中小商家', painPoint: '效率低',
  })
})
```

- [ ] **Step 7: 跑测试确认通过**

Run: `pnpm --filter @forgecast/server test projects`
Expected: PASS

- [ ] **Step 8: 全量测试 + 提交**

Run: `pnpm -r test`

```bash
git add packages/analyst packages/server
git commit -m "feat(analyst): analysis.md 摘要解析 + 项目列表附目标买家/痛点"
```

---

### Task 5: 候选卡片列表（前端）

**Files:**
- Create: `apps/web/src/pages/board/CandidateCard.tsx`
- Modify: `apps/web/src/api.ts:38-41`（`Candidate` 类型）
- Modify: `apps/web/src/pages/BoardPage.tsx`（候选表格整段换掉）
- Test: 无单测（本仓库前端无测试基建），以构建 + 浏览器走查为准

**Interfaces:**
- Consumes: Task 1 的 `description` 列、Task 2 的 `score_detail.targetBuyer/painPoint`、Task 3 的 `POST /api/candidates/:id/rescore`
- Produces: `CandidateCard` 组件，props `{ c: Candidate; rank: number; onPick: (repo: string) => void; onRescore: (id: number) => void; picking: boolean; rescoring: boolean }`

- [ ] **Step 1: 扩展前端类型**

`apps/web/src/api.ts` 的 `Candidate` 改为：

```typescript
export interface Candidate {
  id: number; repo: string; url: string; description: string | null
  license: string | null; license_ok: number
  stars: number; tech_stack: string | null; score: number | null; score_detail: string | null; status: string
}
```

同文件 `Project` 加一行（Task 6 会用到，一并加）：

```typescript
export interface Project {
  id: number; slug: string; brand_name: string | null; target_buyer: string | null
  demo_url: string | null; price_deploy: number | null; price_custom: number | null
  stage: string; analysisMd?: string
  analysis_summary?: { targetBuyer: string; painPoint: string }
}
```

- [ ] **Step 2: 写 CandidateCard 组件**

新建 `apps/web/src/pages/board/CandidateCard.tsx`：

```tsx
import type { Candidate } from '../../api'

// 三个评分维度各自的满分（§3 四维模型，协议为一票否决不计分）
const DIMS = [
  { key: 'rebrandCost', label: '换皮', max: 30 },
  { key: 'buyerClarity', label: '买家', max: 40 },
  { key: 'visualAppeal', label: '可视', max: 30 },
] as const

interface Detail {
  rebrandCost: number; buyerClarity: number; visualAppeal: number
  rationale: string; targetBuyer: string; painPoint: string
}
/** 旧行可能没有 targetBuyer/painPoint，一律按空串兜底 */
function parseDetail(sd: string | null): Detail | null {
  if (!sd) return null
  try {
    const o = JSON.parse(sd)
    return {
      rebrandCost: o.rebrandCost ?? 0, buyerClarity: o.buyerClarity ?? 0, visualAppeal: o.visualAppeal ?? 0,
      rationale: o.rationale ?? '', targetBuyer: o.targetBuyer ?? '', painPoint: o.painPoint ?? '',
    }
  } catch { return null }
}

function Bar({ label, value, max }: { label: string; value: number; max: number }) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100))
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="w-8 shrink-0 text-neutral-500">{label}</span>
      <div className="h-1.5 w-24 shrink-0 rounded bg-neutral-200">
        <div className="h-1.5 rounded bg-blue-500" style={{ width: `${pct}%` }} />
      </div>
      <span className="tabular-nums text-neutral-400">{value}/{max}</span>
    </div>
  )
}

function Row({ icon, label, value, muted }: { icon: string; label: string; value: string; muted?: boolean }) {
  return (
    <div className="flex gap-2 text-xs">
      <span className="shrink-0">{icon}</span>
      <span className="w-14 shrink-0 text-neutral-500">{label}</span>
      <span className={muted ? 'text-neutral-400 italic' : 'text-neutral-700'}>{value}</span>
    </div>
  )
}

export default function CandidateCard({ c, rank, onPick, onRescore, picking, rescoring }: {
  c: Candidate; rank: number
  onPick: (repo: string) => void; onRescore: (id: number) => void
  picking: boolean; rescoring: boolean
}) {
  const d = parseDetail(c.score_detail)
  const empty = '未生成 — 配好 key 后点「重新评分」'

  return (
    <div className="rounded-lg border bg-white p-3 hover:border-blue-300">
      <div className="flex items-baseline gap-2">
        <span className="text-xs text-neutral-400">#{rank}</span>
        <a className="font-medium text-blue-600" href={c.url} target="_blank" rel="noreferrer">{c.repo}</a>
        <span className="text-xs text-neutral-400">★{c.stars.toLocaleString()}</span>
        <span className="rounded bg-green-50 px-1.5 py-0.5 text-xs text-green-700">{c.license ?? '—'}</span>
        <span className="ml-auto text-sm font-semibold">{c.score ?? '—'}</span>
      </div>

      {c.description && <div className="mt-1 text-xs text-neutral-500">{c.description}</div>}

      {d && (
        <div className="mt-2 space-y-1">
          {DIMS.map((dim) => <Bar key={dim.key} label={dim.label} value={d[dim.key]} max={dim.max} />)}
        </div>
      )}

      <div className="mt-2 space-y-1">
        <Row icon="👤" label="目标群体" value={d?.targetBuyer || empty} muted={!d?.targetBuyer} />
        <Row icon="💢" label="行业痛点" value={d?.painPoint || empty} muted={!d?.painPoint} />
        {d?.rationale && <Row icon="💡" label="评分说明" value={d.rationale} />}
      </div>

      <div className="mt-2 flex items-center gap-2">
        {c.status === 'picked'
          ? <span className="text-xs text-green-600">已立项</span>
          : <button className="rounded border px-2 py-1 text-xs disabled:opacity-50"
              disabled={picking} onClick={() => onPick(c.repo)}>立项</button>}
        <button className="rounded border px-2 py-1 text-xs text-neutral-500 disabled:opacity-50"
          disabled={rescoring} onClick={() => onRescore(c.id)}>{rescoring ? '评分中…' : '重新评分'}</button>
      </div>
    </div>
  )
}
```

- [ ] **Step 3: BoardPage 用卡片替换表格**

`apps/web/src/pages/BoardPage.tsx`：删掉 `dims()` 和 `rationale()` 两个函数（逻辑已搬进 `CandidateCard`），删掉整个 `<div className="overflow-x-auto rounded-lg border bg-white">...</div>` 表格块，换成：

```tsx
      {/* 候选卡片：协议可商用的排前面，不可商用的折叠到底部 */}
      <div className="grid gap-3 md:grid-cols-2">
        {ok.map((c, i) => (
          <CandidateCard key={c.id} c={c} rank={i + 1}
            onPick={(repo) => pick.mutate(repo)} onRescore={(id) => rescore.mutate(id)}
            picking={pick.isPending} rescoring={rescore.isPending && rescoreId === c.id} />
        ))}
      </div>
      {rows.length === 0 && <div className="rounded-lg border p-6 text-center text-neutral-400">暂无候选，点「抓取候选」</div>}
      {blocked.length > 0 && (
        <details className="rounded-lg border bg-neutral-50 p-3 text-sm text-neutral-500">
          <summary className="cursor-pointer">另有 {blocked.length} 个协议不可商用（GPL/AGPL 系），点开查看</summary>
          <div className="mt-2 space-y-1">
            {blocked.map((c) => (
              <div key={c.id} className="flex gap-2 text-xs">
                <a className="text-neutral-600" href={c.url} target="_blank" rel="noreferrer">{c.repo}</a>
                <span className="text-neutral-400">{c.license ?? '无协议'}</span>
              </div>
            ))}
          </div>
        </details>
      )}
```

在 `const rows = candidates.data ?? []` 下面加分组：

```tsx
  const ok = rows.filter((c) => c.license_ok === 1)
  const blocked = rows.filter((c) => c.license_ok !== 1)
```

加 rescore mutation（放在 `moveStage` 后面）：

```tsx
  const [rescoreId, setRescoreId] = useState<number | null>(null)
  const rescore = useMutation({
    mutationFn: (id: number) => { setRescoreId(id); return api<{ ok: boolean; mode: string }>(`/api/candidates/${id}/rescore`, { method: 'POST' }) },
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['candidates'] })
      if (r.mode === 'mock') alert('当前是 mock 模式，评分不会产生目标群体/行业痛点。去「设置」把大模型切到 live 并填 key。')
    },
    onError: (e) => alert(`重新评分失败: ${e instanceof Error ? e.message : String(e)}`),
    onSettled: () => setRescoreId(null),
  })
```

顶部 import 加：

```tsx
import CandidateCard from './board/CandidateCard'
```

- [ ] **Step 4: 类型检查 + 构建**

Run: `cd apps/web && npx tsc --noEmit -p tsconfig.json && npx vite build`
Expected: 无错误，构建产出 dist

- [ ] **Step 5: 提交**

```bash
git add apps/web
git commit -m "feat(web): 候选池改卡片列表（简介/评分色条/目标群体/痛点）"
```

---

### Task 6: 泳道卡片 + 文件拆分 + 浏览器走查

**Files:**
- Create: `apps/web/src/pages/board/StageLanes.tsx`
- Modify: `apps/web/src/pages/BoardPage.tsx`（泳道整段搬走）

**Interfaces:**
- Consumes: Task 4 的 `Project.analysis_summary`、Task 5 的 `CandidateCard`
- Produces: `StageLanes` 组件，props `{ projects: Project[]; onMove: (slug: string, stage: string) => void }`

- [ ] **Step 1: 抽出 StageLanes 组件**

新建 `apps/web/src/pages/board/StageLanes.tsx`，把 `BoardPage.tsx` 里 `{/* 立项项目 stage 泳道 */}` 整块搬过来，改成独立组件，并在卡片上加两行摘要：

```tsx
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { Project } from '../../api'

// 立项项目阶段泳道（§8）：analysis→rebranding→producing→publishing→selling
const STAGES: Array<{ key: string; label: string }> = [
  { key: 'analysis', label: '分析' },
  { key: 'rebranding', label: '换皮' },
  { key: 'producing', label: '产素材' },
  { key: 'publishing', label: '发布' },
  { key: 'selling', label: '成交' },
]

export default function StageLanes({ projects, onMove }: {
  projects: Project[]; onMove: (slug: string, stage: string) => void
}) {
  const navigate = useNavigate()
  const [dragSlug, setDragSlug] = useState<string | null>(null)

  return (
    <div>
      <div className="mb-2 text-sm font-medium text-neutral-600">立项项目 · 拖拽卡片流转阶段</div>
      <div className="flex gap-3 overflow-x-auto pb-2">
        {STAGES.map((s) => {
          const items = projects.filter((p) => p.stage === s.key)
          return (
            <div key={s.key}
              className="min-w-[200px] flex-1 rounded-lg border bg-neutral-50 p-2"
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => { if (dragSlug) onMove(dragSlug, s.key); setDragSlug(null) }}>
              <div className="mb-2 flex items-center justify-between px-1 text-xs font-medium text-neutral-500">
                <span>{s.label}</span><span>{items.length}</span>
              </div>
              <div className="space-y-2">
                {items.map((p) => {
                  const sum = p.analysis_summary
                  return (
                    <div key={p.id} draggable
                      onDragStart={() => setDragSlug(p.slug)}
                      onDragEnd={() => setDragSlug(null)}
                      onClick={() => navigate(`/projects/${p.slug}`)}
                      className="cursor-grab rounded border bg-white p-2 text-sm shadow-sm hover:border-blue-400 active:cursor-grabbing">
                      <div className="font-medium">{p.brand_name || p.slug}</div>
                      <div className="text-xs text-neutral-400">{p.slug}</div>
                      {sum?.targetBuyer
                        ? <div className="mt-1 text-xs text-neutral-600">👤 {sum.targetBuyer}</div>
                        : <div className="mt-1 text-xs text-neutral-300">未分析 · 点开生成分析</div>}
                      {sum?.painPoint && <div className="text-xs text-neutral-600">💢 {sum.painPoint}</div>}
                    </div>
                  )
                })}
                {items.length === 0 && <div className="rounded border border-dashed p-3 text-center text-xs text-neutral-300">拖到此</div>}
              </div>
            </div>
          )
        })}
      </div>
      {projects.length === 0 && <div className="mt-1 text-xs text-neutral-400">暂无立项项目，先在候选表点「立项」</div>}
    </div>
  )
}
```

- [ ] **Step 2: BoardPage 改用组件**

`apps/web/src/pages/BoardPage.tsx`：删掉 `STAGES` 常量、`dragSlug` state、`useNavigate` import 和整个泳道 JSX 块，换成：

```tsx
      <StageLanes projects={projects.data ?? []} onMove={(slug, stage) => moveStage.mutate({ slug, stage })} />
```

import 加：

```tsx
import StageLanes from './board/StageLanes'
```

- [ ] **Step 3: 类型检查 + 构建**

Run: `cd apps/web && npx tsc --noEmit -p tsconfig.json && npx vite build`
Expected: 无错误。若报 `useNavigate`/`STAGES` 未使用，说明 Step 2 没删干净，删掉残留。

- [ ] **Step 4: 浏览器走查**

起服务：`pnpm exec tsx cli.ts dev`，打开 http://localhost:5173/board，逐项确认：

1. 候选卡片显示 repo / ★stars / 协议徽章 / 简介 / 三条色条 / 三行图标字段
2. 👤💢 两行是灰色斜体占位（mock 模式），文案为「未生成 — 配好 key 后点「重新评分」」
3. 点「重新评分」→ 弹出 mock 提示 → 卡片数据不变（mock 确定性评分）
4. 底部有「另有 N 个协议不可商用」折叠条，点开列出 GPL 项目
5. 泳道拖拽仍能改 stage（拖一张卡到下一列，刷新页面后仍在新列）

- [ ] **Step 5: 更新 README**

`README.md` 的功能描述里，若提到看板是表格，改成卡片；无相关描述则跳过此步。

- [ ] **Step 6: 全量测试 + 提交**

Run: `pnpm -r test`

```bash
git add apps/web README.md
git commit -m "feat(web): 泳道卡片显示目标买家/痛点 + BoardPage 拆分"
```

---

## 完成标准

- `pnpm -r test` 全绿（新增约 10 个用例）
- `cd apps/web && npx vite build` 通过
- 浏览器 `/board` 走查 5 项全过
- mock 模式下 👤💢 为占位而非假数据——这条是本次改动的核心约束，review 时重点看
