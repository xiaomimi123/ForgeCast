# 找项目页双轨评分 + 热点雷达（子项目②）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给候选评分加"利润款/引流款"分轨（LLM 一次调用完成），前端新增"双轨评分" tab 展示选型总纲卡+热点雷达+两张分轨榜单。

**Architecture:** 新字段全部作为 `ScoreDetail`/`Detail` 的可选属性追加，不改现有三维评分字段和 `score` 列，不新建 SQL 列（存进已有的 `score_detail` JSON 文本）。后端只改 `packages/scout/src/types.ts`+`score.ts`；前端只加一个新组件 `DualTrackView.tsx`+`ScoutPage.tsx`/`CandidateCard.tsx` 的小段扩展。不碰 `packages/server`（`GET /api/candidates` 已经把整个 `score_detail` 原样返回，前端直接解析新字段即可）。

**Tech Stack:** TypeScript + vitest（`packages/scout`）；React + Tailwind v4（`apps/web`，无单元测试，人工过一遍）。

**Spec:** `docs/superpowers/specs/2026-08-28-scout-dual-track-design.md`

## Global Constraints

- `rebrandCost`/`buyerClarity`/`visualAppeal`/`score` 字段和现有"全部/已收藏/每日新增/自主投喂"四个 tab 的行为一律不改。
- 新字段全部可选（`track?`/`gapScore?`/`threshold?`/`exitRoutes?`/`emotionScore?`/`wowScore?`），缺失时保持 `undefined`，不给默认值/不编造假数据。
- `exitRoutes` 只接受 `['托管','定制','一键包']` 子集，非法值一律丢弃，不新增自由文本白名单外的值。
- 不新增后端接口、不新增 SQL 列/迁移、不碰 `packages/server`。
- 热点雷达直接用页面已经在用的 `candidates` 查询结果做前端筛选，不触发新的抓取/LLM 调用。
- `apps/web` 没有单元测试（`package.json` 的 `test` 脚本是 `echo`），验收方式是 `tsc --noEmit` + 人工过浏览器，不是伪造测试。`packages/scout` 有正常单测，照 TDD 走。

---

### Task 1: `ScoreDetail`/`Track` 类型扩展 + 打分逻辑分轨（`packages/scout`）

**Files:**
- Modify: `packages/scout/src/types.ts`
- Modify: `packages/scout/src/score.ts`
- Test: `packages/scout/test/score.test.ts`

**Interfaces:**
- Produces：`export type Track = 'profit' | 'traffic'`；`ScoreDetail` 新增可选字段 `track?: Track; gapScore?: number; threshold?: number; exitRoutes?: string[]; emotionScore?: number; wowScore?: number`。

- [ ] **Step 1: 写失败测试**

编辑 `packages/scout/test/score.test.ts`，在文件已有的 `describe('scoreCandidate mock', ...)` 块后面（`})` 之后）新增两个 describe 块：

```ts
describe('scoreCandidate mock 分轨', () => {
  it('有明确垂直场景关键词（crm等）→ track=profit，带 gapScore/threshold/exitRoutes，不带 traffic 字段', async () => {
    const ctx = ctxWith({})
    const d = await scoreCandidate(ctx, meta, 'React Node Docker CRM dashboard screenshot demo'.repeat(3))
    expect(d.track).toBe('profit')
    expect(d.gapScore).toBeGreaterThan(0)
    expect(d.gapScore).toBeLessThanOrEqual(100)
    expect(d.threshold).toBeGreaterThan(0)
    expect(d.threshold).toBeLessThanOrEqual(100)
    expect(d.exitRoutes).toEqual(['托管'])
    expect(d.emotionScore).toBeUndefined()
    expect(d.wowScore).toBeUndefined()
  })
  it('无垂直场景关键词 → track=traffic，带 emotionScore/wowScore，不带 profit 字段', async () => {
    const ctx = ctxWith({})
    const d = await scoreCandidate(ctx, meta, 'a cli tool for terminal theming with cool demo screenshot')
    expect(d.track).toBe('traffic')
    expect(d.emotionScore).toBeGreaterThanOrEqual(0)
    expect(d.emotionScore).toBeLessThanOrEqual(100)
    expect(d.wowScore).toBeGreaterThanOrEqual(0)
    expect(d.gapScore).toBeUndefined()
    expect(d.exitRoutes).toBeUndefined()
  })
})

describe('scoreCandidate live 分轨', () => {
  it('LLM 返回 track=profit + gapScore/threshold/exitRoutes → 解析并夹取上限，exitRoutes 过滤非法值', async () => {
    const config = loadConfig('/tmp/fc-score-dual1', { FORGECAST_LLM_MODE: 'live', FORGECAST_LLM_KEY: 'k' })
    const llm = { complete: vi.fn(async () => JSON.stringify({
      rebrandCost: 20, buyerClarity: 30, visualAppeal: 20, techStack: [], rationale: 'ok',
      track: 'profit', gapScore: 150, threshold: 80, exitRoutes: ['托管', '定制', '瞎编'],
    })) }
    const ctx: CoreCtx = { db: openDb(config.paths.db), config, llm: llm as any }
    const d = await scoreCandidate(ctx, meta, 'readme')
    expect(d.track).toBe('profit')
    expect(d.gapScore).toBe(100)
    expect(d.threshold).toBe(80)
    expect(d.exitRoutes).toEqual(['托管', '定制'])
    expect(d.emotionScore).toBeUndefined()
  })
  it('LLM 返回 track=traffic + emotionScore/wowScore → 解析', async () => {
    const config = loadConfig('/tmp/fc-score-dual2', { FORGECAST_LLM_MODE: 'live', FORGECAST_LLM_KEY: 'k' })
    const llm = { complete: vi.fn(async () => JSON.stringify({
      rebrandCost: 10, buyerClarity: 10, visualAppeal: 25, techStack: [], rationale: 'ok',
      track: 'traffic', emotionScore: 90, wowScore: 95,
    })) }
    const ctx: CoreCtx = { db: openDb(config.paths.db), config, llm: llm as any }
    const d = await scoreCandidate(ctx, meta, 'readme')
    expect(d.track).toBe('traffic')
    expect(d.emotionScore).toBe(90)
    expect(d.wowScore).toBe(95)
    expect(d.gapScore).toBeUndefined()
  })
  it('LLM 返回非法 track 值 → 分轨相关字段全部 undefined', async () => {
    const config = loadConfig('/tmp/fc-score-dual3', { FORGECAST_LLM_MODE: 'live', FORGECAST_LLM_KEY: 'k' })
    const llm = { complete: vi.fn(async () => JSON.stringify({
      rebrandCost: 10, buyerClarity: 10, visualAppeal: 10, techStack: [], rationale: 'ok',
      track: 'nonsense',
    })) }
    const ctx: CoreCtx = { db: openDb(config.paths.db), config, llm: llm as any }
    const d = await scoreCandidate(ctx, meta, 'readme')
    expect(d.track).toBeUndefined()
    expect(d.gapScore).toBeUndefined()
    expect(d.emotionScore).toBeUndefined()
  })
})
```

不要额外添加"旧用例仍通过"的 it 块——文件里已有的 `describe('scoreCandidate live', ...)` 那条 `toEqual` 六字段严格匹配的用例本身就会在跑全量测试时自然覆盖这个回归点，Step 4 会验证它没被改坏，不需要重复写一条新用例。

- [ ] **Step 2: 跑测试确认失败**

```bash
export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH"
cd /Users/lizhishaoniange/Documents/开源变现内容工厂
pnpm --filter @forgecast/scout test score.test
```

预期：新增的用例失败（`d.track` 是 `undefined` 但测试期望 `'profit'`/`'traffic'`），不是语法错误。

- [ ] **Step 3: 实现**

编辑 `packages/scout/src/types.ts`，在 `ScoreDetail` interface 定义处（文件末尾）追加：

```ts
export type Track = 'profit' | 'traffic'
```

并把 `ScoreDetail` interface 改成：

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
  // 分轨（可选，缺失=老候选未分轨）
  track?: Track
  gapScore?: number // profit 专属：差价分 0-100
  threshold?: number // profit 专属：安装/使用门槛 0-100
  exitRoutes?: string[] // profit 专属：交付方式，['托管','定制','一键包'] 子集
  emotionScore?: number // traffic 专属：情绪值 0-100
  wowScore?: number // traffic 专属：爽感 0-100
}
```

编辑 `packages/scout/src/score.ts`：

在文件顶部 import 区，把 `import type { RepoMeta, ScoreDetail } from './types'` 改成：

```ts
import type { RepoMeta, ScoreDetail, Track } from './types'
```

在 `CATEGORIES`/`CATEGORY_KW` 声明附近加一个新常量（放在 `const TECHS = [...]` 下面）：

```ts
const EXIT_ROUTES = ['托管', '定制', '一键包']
```

修改 `scoreCandidate` 函数里 live 分支的 prompt 数组，在 `输出 JSON：{...}` 那一行**之前**插入分轨要求（保持原有三维打分那几行不变），把：

```ts
  const prompt = [
    `评估这个开源项目能否"换皮"成面向中国中小老板的付费产品，给三维打分（各维不超上限）：`,
    `- rebrandCost 换皮成本(0-${weights.rebrandCost})：技术栈(React/Node/Next 高)、有无 Docker、i18n、UI 可主题化`,
    `- buyerClarity 买家清晰度(0-${weights.buyerClarity})：能否一句话说清"什么老板会掏钱"，越垂直越高`,
    `- visualAppeal 内容可视性(0-${weights.visualAppeal})：有无好看可演示的 UI（纯 CLI/后端低分）`,
    `输出 JSON：{"rebrandCost":n,"buyerClarity":n,"visualAppeal":n,"techStack":["..."],"rationale":"一句话","targetBuyer":"什么老板会掏钱，一句话（行业+规模）","painPoint":"解决的行业痛点，一句话，注明现状成本","summaryZh":"这个项目是做什么的，一句话，中文","category":"从下列类别选一个最贴切的"}`,
    `类别（选一个）：${CATEGORIES.join(' / ')}`,
    `项目：${meta.repo}（topics: ${meta.topics.join(',')}, stars: ${meta.stars}）`,
    `README:\n${readme.slice(0, 6000)}`,
  ].join('\n')
```

改成：

```ts
  const prompt = [
    `评估这个开源项目能否"换皮"成面向中国中小老板的付费产品，给三维打分（各维不超上限）：`,
    `- rebrandCost 换皮成本(0-${weights.rebrandCost})：技术栈(React/Node/Next 高)、有无 Docker、i18n、UI 可主题化`,
    `- buyerClarity 买家清晰度(0-${weights.buyerClarity})：能否一句话说清"什么老板会掏钱"，越垂直越高`,
    `- visualAppeal 内容可视性(0-${weights.visualAppeal})：有无好看可演示的 UI（纯 CLI/后端低分）`,
    `再判断这个项目更适合两条路线中的哪一条，输出 track 字段：`,
    `- "profit"（利润款/交付线）：能改造成商业产品直接卖给中小老板，走"立项→换皮→交付"流程`,
    `- "traffic"（引流款/仅内容线）：技术含量普通老板看不懂用不上，但演示效果强，适合拍视频引流吸粉，不适合真的卖给客户`,
    `如果 track 是 "profit"，额外输出：`,
    `- gapScore 差价分(0-100)：普通人搞不定、但换皮后低成本能搞定的差价空间有多大`,
    `- threshold 门槛(0-100)：这东西对非技术人员的安装/使用门槛`,
    `- exitRoutes：从 ["托管","定制","一键包"] 里选出适合的交付方式，可多选，输出数组`,
    `如果 track 是 "traffic"，额外输出：`,
    `- emotionScore 情绪值(0-100)：内容传播情绪强度（惊讶/爽感/焦虑等能带来转发的情绪）`,
    `- wowScore 爽感(0-100)：3秒内能不能看懂效果、够不够炫`,
    `输出 JSON：{"rebrandCost":n,"buyerClarity":n,"visualAppeal":n,"techStack":["..."],"rationale":"一句话","targetBuyer":"什么老板会掏钱，一句话（行业+规模）","painPoint":"解决的行业痛点，一句话，注明现状成本","summaryZh":"这个项目是做什么的，一句话，中文","category":"从下列类别选一个最贴切的","track":"profit 或 traffic","gapScore":n,"threshold":n,"exitRoutes":["..."],"emotionScore":n,"wowScore":n}`,
    `类别（选一个）：${CATEGORIES.join(' / ')}`,
    `项目：${meta.repo}（topics: ${meta.topics.join(',')}, stars: ${meta.stars}）`,
    `README:\n${readme.slice(0, 6000)}`,
  ].join('\n')
```

修改 `heuristicScore` 函数（在文件下半部分），从：

```ts
function heuristicScore(meta: RepoMeta, readme: string, weights: { rebrandCost: number; buyerClarity: number; visualAppeal: number }): ScoreDetail {
  const r = readme.toLowerCase()
  const has = (re: RegExp) => re.test(r)
  const rebrandCost = Math.min(weights.rebrandCost, 12 + (has(/docker/) ? 9 : 0) + (has(/react|next|vue|node/) ? 9 : 0))
  const buyerClarity = Math.min(weights.buyerClarity, 18 + (readme.length > 200 ? 10 : 0) + (has(/crm|invoice|chat|booking|shop|commerce|pos|survey|form/) ? 12 : 0))
  const visualAppeal = Math.min(weights.visualAppeal, 8 + (has(/screenshot|demo|preview/) ? 12 : 0) + (has(/dashboard|ui|interface/) ? 10 : 0))
  const techStack = TECHS.filter((t) => r.includes(t)).concat(meta.topics)
  return {
    rebrandCost, buyerClarity, visualAppeal, techStack: [...new Set(techStack)],
    rationale: `离线启发式评分：${meta.repo}`,
    // mock 不编造买家与痛点——关键词拼出来的假数据比空着更坏
    targetBuyer: '', painPoint: '', summaryZh: '',
    category: categorizeHeuristic(meta.repo, readme, techStack),
  }
}
```

改成：

```ts
function heuristicScore(meta: RepoMeta, readme: string, weights: { rebrandCost: number; buyerClarity: number; visualAppeal: number }): ScoreDetail {
  const r = readme.toLowerCase()
  const has = (re: RegExp) => re.test(r)
  const hasVertical = has(/crm|invoice|chat|booking|shop|commerce|pos|survey|form/)
  const rebrandCost = Math.min(weights.rebrandCost, 12 + (has(/docker/) ? 9 : 0) + (has(/react|next|vue|node/) ? 9 : 0))
  const buyerClarity = Math.min(weights.buyerClarity, 18 + (readme.length > 200 ? 10 : 0) + (hasVertical ? 12 : 0))
  const visualAppeal = Math.min(weights.visualAppeal, 8 + (has(/screenshot|demo|preview/) ? 12 : 0) + (has(/dashboard|ui|interface/) ? 10 : 0))
  const techStack = TECHS.filter((t) => r.includes(t)).concat(meta.topics)
  const base = {
    rebrandCost, buyerClarity, visualAppeal, techStack: [...new Set(techStack)],
    rationale: `离线启发式评分：${meta.repo}`,
    // mock 不编造买家与痛点——关键词拼出来的假数据比空着更坏
    targetBuyer: '', painPoint: '', summaryZh: '',
    category: categorizeHeuristic(meta.repo, readme, techStack),
  }
  // 分轨：复用 buyerClarity 已经算过的垂直场景关键词命中——有明确垂直场景关键词 → profit，否则 → traffic
  const track: Track = hasVertical ? 'profit' : 'traffic'
  if (track === 'profit') {
    return {
      ...base, track,
      gapScore: Math.round((buyerClarity / (weights.buyerClarity || 1)) * 100),
      threshold: Math.round((rebrandCost / (weights.rebrandCost || 1)) * 100),
      exitRoutes: ['托管'], // mock 不编造多选组合，固定给一个保守值
    }
  }
  return {
    ...base, track,
    emotionScore: Math.round((visualAppeal / (weights.visualAppeal || 1)) * 100),
    wowScore: Math.round((visualAppeal / (weights.visualAppeal || 1)) * 100),
  }
}
```

修改 `parseScoreJson` 函数，从：

```ts
function parseScoreJson(text: string, weights: { rebrandCost: number; buyerClarity: number; visualAppeal: number }): ScoreDetail {
  const m = text.match(/\{[\s\S]*\}/)
  if (!m) throw new Error('评分 LLM 未返回 JSON')
  const o = JSON.parse(m[0])
  const clamp = (v: any, max: number) => Math.max(0, Math.min(max, Number(v) || 0))
  return {
    rebrandCost: clamp(o.rebrandCost, weights.rebrandCost),
    buyerClarity: clamp(o.buyerClarity, weights.buyerClarity),
    visualAppeal: clamp(o.visualAppeal, weights.visualAppeal),
    techStack: Array.isArray(o.techStack) ? o.techStack.map(String) : [],
    rationale: typeof o.rationale === 'string' ? o.rationale : '',
    targetBuyer: typeof o.targetBuyer === 'string' ? o.targetBuyer : '',
    painPoint: typeof o.painPoint === 'string' ? o.painPoint : '',
    summaryZh: typeof o.summaryZh === 'string' ? o.summaryZh : '',
    category: typeof o.category === 'string' ? o.category : '',
  }
}
```

改成：

```ts
function parseScoreJson(text: string, weights: { rebrandCost: number; buyerClarity: number; visualAppeal: number }): ScoreDetail {
  const m = text.match(/\{[\s\S]*\}/)
  if (!m) throw new Error('评分 LLM 未返回 JSON')
  const o = JSON.parse(m[0])
  const clamp = (v: any, max: number) => Math.max(0, Math.min(max, Number(v) || 0))
  const clamp100 = (v: any) => clamp(v, 100)
  const track: Track | undefined = o.track === 'profit' || o.track === 'traffic' ? o.track : undefined
  const exitRoutes = track === 'profit' && Array.isArray(o.exitRoutes)
    ? o.exitRoutes.filter((x: unknown) => EXIT_ROUTES.includes(x as string))
    : undefined
  return {
    rebrandCost: clamp(o.rebrandCost, weights.rebrandCost),
    buyerClarity: clamp(o.buyerClarity, weights.buyerClarity),
    visualAppeal: clamp(o.visualAppeal, weights.visualAppeal),
    techStack: Array.isArray(o.techStack) ? o.techStack.map(String) : [],
    rationale: typeof o.rationale === 'string' ? o.rationale : '',
    targetBuyer: typeof o.targetBuyer === 'string' ? o.targetBuyer : '',
    painPoint: typeof o.painPoint === 'string' ? o.painPoint : '',
    summaryZh: typeof o.summaryZh === 'string' ? o.summaryZh : '',
    category: typeof o.category === 'string' ? o.category : '',
    track,
    gapScore: track === 'profit' ? clamp100(o.gapScore) : undefined,
    threshold: track === 'profit' ? clamp100(o.threshold) : undefined,
    exitRoutes,
    emotionScore: track === 'traffic' ? clamp100(o.emotionScore) : undefined,
    wowScore: track === 'traffic' ? clamp100(o.wowScore) : undefined,
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH"
cd /Users/lizhishaoniange/Documents/开源变现内容工厂
pnpm --filter @forgecast/scout test
```

预期：全部通过，包括本任务新增用例和文件里原有的所有用例（尤其是那条 `toEqual` 六字段严格匹配的老 live 测试——vitest 的 `toEqual` 会忽略值为 `undefined` 的多余字段，新加的 `track`/`gapScore` 等字段值为 `undefined` 时不会让老断言失败；如果失败了说明某处给了非 `undefined` 的默认值，回去检查）。

- [ ] **Step 5: 提交**

```bash
git add packages/scout/src/types.ts packages/scout/src/score.ts packages/scout/test/score.test.ts
git commit -m "feat(scout): 评分加利润款/引流款分轨——LLM 一次调用完成，mock 用现成关键词命中启发式推断"
```

---

### Task 2: 前端 `Detail`/`parseDetail` 扩展（`apps/web/src/pages/board/CandidateCard.tsx`）

**Files:**
- Modify: `apps/web/src/pages/board/CandidateCard.tsx`

**Interfaces:**
- Produces：`export type Track = 'profit' | 'traffic'`（前端本地声明，不跨包导入）；`Detail` interface 新增可选字段，`parseDetail` 解析对应值（缺失/非法一律 `undefined`，不给默认值）。

本任务无自动化测试（`apps/web` 无单测），下一个任务的手动浏览器验证会一并覆盖这里的解析正确性。

- [ ] **Step 1: 编辑文件**

在文件顶部（`import type { Candidate } from '../../api'` 那一行下面）加一行：

```ts
export type Track = 'profit' | 'traffic'
```

把 `Detail` interface：

```ts
export interface Detail {
  rebrandCost: number; buyerClarity: number; visualAppeal: number
  rationale: string; targetBuyer: string; painPoint: string
  summaryZh: string
  category: string
}
```

改成：

```ts
export interface Detail {
  rebrandCost: number; buyerClarity: number; visualAppeal: number
  rationale: string; targetBuyer: string; painPoint: string
  summaryZh: string
  category: string
  track?: Track
  gapScore?: number
  threshold?: number
  exitRoutes?: string[]
  emotionScore?: number
  wowScore?: number
}
```

在 `num`/`str` 两个兜底函数下面加两个新的兜底函数（`track`/`gapScore` 等缺失时要保持 `undefined`，不能像 `num`/`str` 那样给 0/空串默认值，所以不能直接复用）：

```ts
/** 分轨专属数值字段：非 number/NaN/Infinity 或压根没给 → undefined（不像 num() 那样兜底成 0——0 是有效差价分，undefined 才代表"没打过这个分") */
function optNum(x: unknown): number | undefined {
  return typeof x === 'number' && Number.isFinite(x) ? x : undefined
}
/** exitRoutes 专属：必须是纯字符串数组，否则 undefined */
function optStrArr(x: unknown): string[] | undefined {
  return Array.isArray(x) && x.every((v) => typeof v === 'string') ? x : undefined
}
/** track 专属：只接受两个合法值，否则 undefined（老候选/坏数据一律按"未分轨"处理） */
function optTrack(x: unknown): Track | undefined {
  return x === 'profit' || x === 'traffic' ? x : undefined
}
```

把 `parseDetail` 函数里 `return { ... }` 对象字面量：

```ts
    return {
      rebrandCost: num(o.rebrandCost), buyerClarity: num(o.buyerClarity), visualAppeal: num(o.visualAppeal),
      rationale: str(o.rationale), targetBuyer: str(o.targetBuyer), painPoint: str(o.painPoint),
      summaryZh: str(o.summaryZh),
      category: str(o.category),
    }
```

改成：

```ts
    return {
      rebrandCost: num(o.rebrandCost), buyerClarity: num(o.buyerClarity), visualAppeal: num(o.visualAppeal),
      rationale: str(o.rationale), targetBuyer: str(o.targetBuyer), painPoint: str(o.painPoint),
      summaryZh: str(o.summaryZh),
      category: str(o.category),
      track: optTrack(o.track),
      gapScore: optNum(o.gapScore),
      threshold: optNum(o.threshold),
      exitRoutes: optStrArr(o.exitRoutes),
      emotionScore: optNum(o.emotionScore),
      wowScore: optNum(o.wowScore),
    }
```

- [ ] **Step 2: 验证**

```bash
export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH"
cd /Users/lizhishaoniange/Documents/开源变现内容工厂
pnpm --filter web exec tsc --noEmit
```

预期无输出。

- [ ] **Step 3: 提交**

```bash
git add apps/web/src/pages/board/CandidateCard.tsx
git commit -m "feat(web): Detail/parseDetail 加分轨字段解析——缺失一律 undefined，不编造默认值"
```

---

### Task 3: 新建 `DualTrackView.tsx` + `ScoutPage.tsx` 加"双轨评分" tab

**Files:**
- Create: `apps/web/src/pages/board/DualTrackView.tsx`
- Modify: `apps/web/src/pages/ScoutPage.tsx`

**Interfaces:**
- Consumes: Task 2 的 `parseDetail`/`Detail`（从 `./CandidateCard` import）
- Produces: `export default function DualTrackView(props: { candidates: Candidate[]; onOpenDetail: (c: Candidate) => void; onPick: (repo: string) => void; picking: Set<string> })`

- [ ] **Step 1: 新建 `DualTrackView.tsx`**

创建 `apps/web/src/pages/board/DualTrackView.tsx`：

```tsx
import { useState } from 'react'
import type { Candidate } from '../../api'
import { parseDetail } from './CandidateCard'

/** SQLite datetime('now') 的无时区 UTC 串 → 解析成 Date（跟 ScoutPage.tsx 的 localDay 同一套解析方式） */
function toDate(utc: string | null): Date | null {
  if (!utc) return null
  const d = new Date(utc.includes('T') ? utc : utc.replace(' ', 'T') + 'Z')
  return Number.isNaN(d.getTime()) ? null : d
}
function hoursSince(utc: string | null): number | null {
  const d = toDate(utc)
  return d ? (Date.now() - d.getTime()) / 3_600_000 : null
}

/** 找项目页"双轨评分" tab：选型总纲说明卡 + 热点雷达预警卡 + 利润款/引流款两张榜单。
 *  只读 candidates 已有数据做前端筛选/分组，不发起任何新请求。 */
export default function DualTrackView({ candidates, onOpenDetail, onPick, picking }: {
  candidates: Candidate[]
  onOpenDetail: (c: Candidate) => void
  onPick: (repo: string) => void
  picking: Set<string>
}) {
  const rows = candidates.map((c) => ({ c, d: parseDetail(c.score_detail) }))
  const profitRows = rows.filter((r) => r.d?.track === 'profit').sort((a, b) => (b.d?.gapScore ?? 0) - (a.d?.gapScore ?? 0))
  const trafficRows = rows.filter((r) => r.d?.track === 'traffic').sort((a, b) => (b.d?.emotionScore ?? 0) - (a.d?.emotionScore ?? 0))

  const [dismissedHotId, setDismissedHotId] = useState<number | null>(null)
  const hot = candidates
    .filter((c) => c.source === 'scout' && c.id !== dismissedHotId)
    .map((c) => ({ c, hrs: hoursSince(c.created_at) }))
    .filter((x): x is { c: Candidate; hrs: number } => x.hrs != null && x.hrs <= 48 && x.c.stars >= 2000)
    .sort((a, b) => b.c.stars - a.c.stars)[0]?.c

  return (
    <div className="space-y-4">
      <section className="card p-4">
        <span className="eyebrow">选型总纲</span>
        <div className="mt-2 flex flex-wrap items-center gap-2.5">
          <span className="text-lg font-black text-fire">差价</span>
          <span className="text-sub">=</span>
          <span className="rounded border border-hairline-strong bg-paper px-3.5 py-1.5 font-bold">需求热度</span>
          <span className="text-sub">×</span>
          <span className="rounded border border-hairline-strong bg-paper px-3.5 py-1.5 font-bold">安装门槛</span>
          <span className="text-sub">×</span>
          <span className="rounded border border-hairline-strong bg-paper px-3.5 py-1.5 font-bold">受众小白度</span>
        </div>
        <p className="mt-2.5 text-sm text-sub">官方已出一键安装包的项目自动降权——差价被官方吃掉了。GPL / AGPL 一票否决。</p>
      </section>

      {hot && (
        <section className="card border-l-[3px] border-fire bg-fire-soft p-4">
          <span className="eyebrow text-fire">热点雷达 · 快反窗口开启</span>
          <div className="mt-1.5 flex flex-wrap items-baseline gap-2.5">
            <b>{hot.repo}</b>
            <time className="text-xs text-sub">发现于 {Math.round(hoursSince(hot.created_at) ?? 0)} 小时前 · ⭐{hot.stars}</time>
          </div>
          <div className="mt-2 flex items-center gap-2">
            <span className="text-xs font-semibold text-fire">建议 48h 内评估</span>
            <button className="btn ml-auto px-3 py-1 text-sm" onClick={() => onOpenDetail(hot)}>评估开跑</button>
            <button className="btn ghost px-3 py-1 text-sm" onClick={() => setDismissedHotId(hot.id)}>忽略</button>
          </div>
        </section>
      )}

      <section className="card p-4">
        <h3 className="mb-2 flex items-center gap-2 font-bold">利润款榜 <span className="chip">PROFIT · 交付线</span></h3>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-hairline-strong text-left text-xs text-faint">
              <th className="py-1.5">项目</th><th>差价分</th><th>门槛</th><th>出口</th><th />
            </tr>
          </thead>
          <tbody>
            {profitRows.map(({ c, d }) => {
              const blocked = c.license_ok !== 1
              return (
                <tr key={c.id} className="border-b border-hairline">
                  <td className="py-2">
                    <div className="font-bold">{c.repo}</div>
                    <div className="text-xs text-faint">{c.license ?? '无协议'}</div>
                  </td>
                  <td className="font-mono font-bold" style={{ color: blocked ? 'var(--color-faint)' : 'var(--color-fire)' }}>
                    {blocked ? '—' : (d?.gapScore ?? '—')}
                  </td>
                  <td>
                    <div className="h-1 w-16 rounded bg-hairline">
                      <div className="h-1 rounded bg-ink" style={{ width: `${blocked ? 0 : (d?.threshold ?? 0)}%` }} />
                    </div>
                  </td>
                  <td>
                    {blocked
                      ? <span className="chip veto">已淘汰</span>
                      : (d?.exitRoutes ?? []).map((r) => <span key={r} className="chip mr-1">{r}</span>)}
                  </td>
                  <td>
                    {!blocked && (
                      <button className="btn px-3 py-1 text-xs" disabled={picking.has(c.repo)} onClick={() => onPick(c.repo)}>
                        {picking.has(c.repo) ? '立项中…' : '立项'}
                      </button>
                    )}
                  </td>
                </tr>
              )
            })}
            {profitRows.length === 0 && (
              <tr><td colSpan={5} className="py-4 text-center text-faint">暂无已分轨的利润款候选</td></tr>
            )}
          </tbody>
        </table>
      </section>

      <section className="card p-4">
        <h3 className="mb-2 flex items-center gap-2 font-bold">引流款榜 <span className="chip">TRAFFIC · 仅内容线</span></h3>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-hairline-strong text-left text-xs text-faint">
              <th className="py-1.5">项目</th><th>情绪值</th><th>爽感</th><th />
            </tr>
          </thead>
          <tbody>
            {trafficRows.map(({ c, d }) => (
              <tr key={c.id} className="border-b border-hairline">
                <td className="py-2"><div className="font-bold">{c.repo}</div></td>
                <td className="font-mono font-bold text-fire">{d?.emotionScore ?? '—'}</td>
                <td>
                  <div className="h-1 w-16 rounded bg-hairline">
                    <div className="h-1 rounded bg-fire" style={{ width: `${d?.wowScore ?? 0}%` }} />
                  </div>
                </td>
                <td><button className="btn ghost px-3 py-1 text-xs" onClick={() => onOpenDetail(c)}>出内容角度</button></td>
              </tr>
            ))}
            {trafficRows.length === 0 && (
              <tr><td colSpan={4} className="py-4 text-center text-faint">暂无已分轨的引流款候选</td></tr>
            )}
          </tbody>
        </table>
        <p className="mt-2.5 text-sm text-sub">红线：不碰真人肖像 / 擦边 / 灰产。引流款不进交付排期。</p>
      </section>
    </div>
  )
}
```

- [ ] **Step 2: 编辑 `ScoutPage.tsx`**

在文件顶部 import 区加一行（放在 `import CandidateDrawer from './board/CandidateDrawer'` 后面）：

```tsx
import DualTrackView from './board/DualTrackView'
```

把 `Tab` 类型和 `TABS` 数组：

```tsx
type Tab = 'all' | 'fav' | 'daily' | 'manual'
const TABS: Array<{ key: Tab; label: string }> = [
  { key: 'all', label: '全部' }, { key: 'fav', label: '已收藏' }, { key: 'daily', label: '每日新增' }, { key: 'manual', label: '自主投喂' },
]
```

改成：

```tsx
type Tab = 'all' | 'fav' | 'daily' | 'manual' | 'dual'
const TABS: Array<{ key: Tab; label: string }> = [
  { key: 'all', label: '全部' }, { key: 'fav', label: '已收藏' }, { key: 'daily', label: '每日新增' }, { key: 'manual', label: '自主投喂' },
  { key: 'dual', label: '双轨评分' },
]
```

在 `{tab === 'manual' && (...)}` 这个 JSX 块后面（`{tab === 'daily' && (...)}` 前面或后面均可，建议紧接在 `manual` 块后）加：

```tsx
      {tab === 'dual' && (
        <DualTrackView candidates={rows} onOpenDetail={(c) => setDetailId(c.id)}
          onPick={(repo) => pick.mutate(repo)} picking={pickingRepos} />
      )}
```

（`rows`/`pick`/`pickingRepos`/`setDetailId` 都是 `ScoutPage.tsx` 里已经存在的变量，不需要新建。）

- [ ] **Step 3: 验证**

```bash
export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH"
cd /Users/lizhishaoniange/Documents/开源变现内容工厂
pnpm --filter web exec tsc --noEmit
```

预期无输出。

浏览器手动验证（复用之前建立的流程：dev server 已经在跑就直接用 `localhost:5173`，否则按之前 session 的方式在 `5174` 起一个）：
1. 找项目工位（或独立打开 `/`）点"双轨评分" tab，能看到选型总纲卡；
2. 如果候选池里有 `source='scout'` 且 48 小时内创建、star≥2000 的候选，能看到热点雷达卡（当前候选池大概率没有这种数据，卡片不出现是正常的，不算 bug）；
3. 因为现有候选都是子项目②开发前评分的，`score_detail` 里没有 `track` 字段，两张榜单预期都显示"暂无已分轨的候选"——这是正确行为，不是 bug；
4. 想验证有数据的效果，可以手动跑一次 `全部重新评分`（mock 模式）或对单个候选点"重新评分"，让它按新逻辑重新分轨，然后回到"双轨评分" tab 确认出现在对应榜单里、"立项"/"出内容角度"按钮可点。

- [ ] **Step 4: 提交**

```bash
git add apps/web/src/pages/board/DualTrackView.tsx apps/web/src/pages/ScoutPage.tsx
git commit -m "feat(web): 找项目页加「双轨评分」tab——选型总纲+热点雷达+利润款/引流款两张榜单"
```

---

### Task 4: 全量回归

**Files:** 无改动，纯验证

- [ ] **Step 1: 全量测试**

```bash
export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH"
cd /Users/lizhishaoniange/Documents/开源变现内容工厂
pnpm test 2>&1 | grep -E "Test Files|Tests |FAIL"
```

预期：全绿，`packages/scout` 测试数比 Task 1 之前多 7 个（4 个 mock/live 分轨新用例 + 3 个已在文件内的分轨相关新增用例，具体数字以实际写入的用例数为准，只要求"全绿且不比改动前少"）。

- [ ] **Step 2: web 类型检查**

```bash
pnpm --filter web exec tsc --noEmit
```

预期无输出。

- [ ] **Step 3: 确认无遗留改动**

```bash
git status --porcelain
```

预期：干净。
