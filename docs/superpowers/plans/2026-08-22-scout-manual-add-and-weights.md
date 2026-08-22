# 找项目板块：手动投喂URL前端入口 + 评分权重可配置 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 找项目页加一个"+ 投喂"弹窗手动添加 GitHub 仓库；评分三维上限从硬编码改成设置页可调（各自独立，不要求总和100）。

**Architecture:** 六个任务，前三个是后端/核心层从下往上（config→settings→score.ts→server路由），中间穿插一个纯前端任务（投喂弹窗，跟权重功能完全独立），最后两个是权重功能的前端消费方（设置页表单、候选卡片评分条）。`heuristicScore`/`parseScoreJson` 从纯函数改成接收 `weights` 参数，调用方 `scoreCandidate` 统一从 `ctx.config.scout.weights` 取值传入——不新建权重存取的封装层，直接读 `ctx.config`。

**Tech Stack:** TypeScript, Vitest（后端测试），Hono（server 路由），React + TanStack Query（前端，不加自动化测试）。

## Global Constraints

- **权重三维各自独立调整，不要求总和100分**——三个独立设置项，互不联动。
- **改权重后不自动/不提示重新评分老候选**——老分数原样保留，权重只影响以后新评的候选。
- **不做权重范围硬性上限校验**——只挡 `NaN`/负数（沿用现有 `applyStoredSettings` 的 `put()` 非空才覆盖模式，额外加数字合法性判断），不限制"最大能设多少"。
- **不新增弹窗组件库依赖**——投喂对话框就地写最小实现（`fixed inset-0` 遮罩+居中卡片）。
- **不改候选评分排序逻辑**——`GET /api/candidates` 排序规则不变，权重只影响总分怎么算出来。
- **投喂URL功能零后端改动**——`POST /api/candidates/add` 已存在且完整，本计划这部分只加前端 UI。
- 参考 spec：`docs/superpowers/specs/2026-08-21-scout-manual-add-and-weights-design.md`。

---

### Task 1: 投喂 URL 弹窗（纯前端，独立功能）

**Files:**
- Modify: `apps/web/src/pages/ScoutPage.tsx`

**Interfaces:**
- Consumes: `POST /api/candidates/add`（已存在，body `{url: string}`，返回 `{taskId: string}`）；`subscribeTask`（已从 `../api` 导入，现有 `scout()` 等函数已在用）。
- 本任务与 Task 2-6（评分权重）完全独立，无接口耦合，可先做/后做/穿插做均可。

- [ ] **Step 1: 加状态与提交函数**

`apps/web/src/pages/ScoutPage.tsx` 里，在现有 `backfillCats` 函数定义结束之后（`const rows = candidates.data ?? []` 之前），新增：

```ts
  const [addUrlOpen, setAddUrlOpen] = useState(false)
  const [addUrl, setAddUrl] = useState('')
  async function addUrlSubmit() {
    const url = addUrl.trim()
    if (!url) return
    setAddUrlOpen(false); setAddUrl(''); setLogs([])
    try {
      const { taskId } = await api<{ taskId: string }>('/api/candidates/add', { method: 'POST', body: JSON.stringify({ url }) })
      subscribeTask(taskId, (e) => {
        setLogs((l) => [...l, e.message]); logRef.current?.scrollTo({ top: 999999 })
        if (e.type === 'done' || e.type === 'error') qc.invalidateQueries({ queryKey: ['candidates'] })
      })
    } catch (err) { setLogs((l) => [...l, `❌ ${err instanceof Error ? err.message : String(err)}`]) }
  }
```

- [ ] **Step 2: 加按钮**

现有"补中文简介"按钮（`disabled={scanning || scanningBreakouts || rescoringAll || backfillingSummary}` 那个）之后紧接着加：

```tsx
        <button className="btn-ink px-4 py-2 text-sm disabled:opacity-50" disabled={scanning || scanningBreakouts || rescoringAll || backfillingSummary} onClick={() => setAddUrlOpen(true)}>
          + 投喂
        </button>
```

- [ ] **Step 3: 加弹窗**

在现有 `{detail && (<CandidateDrawer .../>)}` 块之后（`</div>` 关闭主容器之前），新增：

```tsx
      {addUrlOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setAddUrlOpen(false)}>
          <div className="w-full max-w-md rounded-lg border-2 border-ink bg-paper p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="mb-3 font-bold text-ink">投喂一个 repo</div>
            <input
              className="w-full rounded-md border-[1.5px] border-ink bg-card px-3 py-2 text-sm"
              placeholder="https://github.com/owner/repo 或 owner/repo"
              value={addUrl}
              autoFocus
              onChange={(e) => setAddUrl(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') addUrlSubmit() }}
            />
            <div className="mt-3 flex justify-end gap-2">
              <button className="btn-ink px-3 py-1.5 text-sm" onClick={() => setAddUrlOpen(false)}>取消</button>
              <button className="btn-fire px-3 py-1.5 text-sm disabled:opacity-50" disabled={!addUrl.trim()} onClick={addUrlSubmit}>投喂</button>
            </div>
          </div>
        </div>
      )}
```

- [ ] **Step 4: 类型检查**

Run: `cd "/Users/lizhishaoniange/Documents/开源变现内容工厂" && pnpm --filter web exec tsc --noEmit`
Expected: 无新增类型错误

- [ ] **Step 5: 浏览器人工走查**

1. `export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH"`
2. 重启 dev server（本仓库无 watch 模式：`lsof -ti :4321 | xargs -r kill; lsof -ti :5173 | xargs -r kill; npx tsx cli.ts dev &`）
3. 浏览器打开找项目页，点"+ 投喂"，确认弹窗出现，输入一个真实 repo（如 `sindresorhus/is`），点"投喂"，确认弹窗关闭、日志区出现进度、候选池刷新后能找到新条目
4. 确认空输入时"投喂"按钮禁用，点遮罩/点"取消"能关闭弹窗

- [ ] **Step 6: Commit**

```bash
cd "/Users/lizhishaoniange/Documents/开源变现内容工厂"
git add apps/web/src/pages/ScoutPage.tsx
git commit -m "feat(web): 找项目页加「+ 投喂」弹窗，手动添加 GitHub 仓库"
```

---

### Task 2: 评分权重配置层（config + settings）

**Files:**
- Modify: `packages/core/src/config.ts`
- Modify: `packages/core/src/settings.ts`
- Test: `packages/core/test/settings.test.ts`

**Interfaces:**
- Produces: `ForgecastConfig.scout.weights: { rebrandCost: number; buyerClarity: number; visualAppeal: number }`（默认 `{30,40,30}`）；`SETTING_KEYS` 新增 `scout_weight_rebrand`/`scout_weight_buyer`/`scout_weight_visual`；`applyStoredSettings` 读取这三个 key 覆盖 `config.scout.weights`。Task 3（score.ts）、Task 4（server 路由）都依赖 `ctx.config.scout.weights` 这个读取路径。

- [ ] **Step 1: 写失败测试**

在 `packages/core/test/settings.test.ts` 的 `describe('applyStoredSettings', ...)` 块内追加：

```ts
  it('scout_weight_* 非空数字覆盖默认权重', () => {
    const config = loadConfig(root, {})
    expect(config.scout.weights).toEqual({ rebrandCost: 30, buyerClarity: 40, visualAppeal: 30 })
    setSettings(db, { scout_weight_rebrand: '20', scout_weight_buyer: '50', scout_weight_visual: '15' })
    applyStoredSettings(config, db)
    expect(config.scout.weights).toEqual({ rebrandCost: 20, buyerClarity: 50, visualAppeal: 15 })
  })
  it('scout_weight_* 非法值（NaN/负数/空白）不覆盖，保留默认', () => {
    const config = loadConfig(root, {})
    setSettings(db, { scout_weight_rebrand: 'abc', scout_weight_buyer: '-5', scout_weight_visual: '   ' })
    applyStoredSettings(config, db)
    expect(config.scout.weights).toEqual({ rebrandCost: 30, buyerClarity: 40, visualAppeal: 30 })
  })
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/core && npx vitest run test/settings.test.ts -t "scout_weight"`
Expected: FAIL（`config.scout` 是 `undefined`，访问 `.weights` 报错）

- [ ] **Step 3: `ForgecastConfig` 加 `scout` 段**

`packages/core/src/config.ts` 里 `ForgecastConfig` 接口，在 `github: { mode: GithubMode; token: string }` 那一行之后加：

```ts
  scout: { weights: { rebrandCost: number; buyerClarity: number; visualAppeal: number } }
```

`loadConfig()` 的返回对象里，在 `github: { mode: githubMode, token: env.FORGECAST_GITHUB_TOKEN ?? '' },` 那一行之后加：

```ts
    scout: { weights: { rebrandCost: 30, buyerClarity: 40, visualAppeal: 30 } },
```

- [ ] **Step 4: `SETTING_KEYS` 加三个 key**

`packages/core/src/settings.ts` 的 `SETTING_KEYS` 数组，在 `'github_mode', 'github_token',` 那一行之后加：

```ts
  'scout_weight_rebrand', 'scout_weight_buyer', 'scout_weight_visual',
```

- [ ] **Step 5: `applyStoredSettings` 读取并覆盖**

`packages/core/src/settings.ts` 的 `applyStoredSettings` 函数，在 `put(s.github_token, (v) => { config.github.token = v })` 那一行之后加：

```ts
  const putWeight = (v: string | undefined, apply: (n: number) => void) => {
    if (!v || !v.trim()) return
    const n = Number(v.trim())
    if (!Number.isFinite(n) || n < 0) return
    apply(n)
  }
  putWeight(s.scout_weight_rebrand, (n) => { config.scout.weights.rebrandCost = n })
  putWeight(s.scout_weight_buyer, (n) => { config.scout.weights.buyerClarity = n })
  putWeight(s.scout_weight_visual, (n) => { config.scout.weights.visualAppeal = n })
```

- [ ] **Step 6: 跑测试确认通过**

Run: `cd packages/core && npx vitest run test/settings.test.ts`
Expected: PASS（全部用例，含新增的 2 条）

- [ ] **Step 7: 跑 core 包全部测试确认无回归**

Run: `cd packages/core && npx vitest run`
Expected: PASS（全部测试）

- [ ] **Step 8: Commit**

```bash
cd "/Users/lizhishaoniange/Documents/开源变现内容工厂"
git add packages/core/src/config.ts packages/core/src/settings.ts packages/core/test/settings.test.ts
git commit -m "feat(core): ForgecastConfig 加 scout.weights 可配置评分权重"
```

---

### Task 3: score.ts 消费可配置权重

**Files:**
- Modify: `packages/scout/src/score.ts`
- Test: `packages/scout/test/score.test.ts`

**Interfaces:**
- Consumes: `ctx.config.scout.weights: { rebrandCost: number; buyerClarity: number; visualAppeal: number }`（Task 2 产出）。
- Produces: `heuristicScore(meta, readme, weights)`、`parseScoreJson(text, weights)` 签名变化——两者仍是模块内部函数（未导出），不影响其它包的调用方；`scoreCandidate(ctx, meta, readme)` 对外签名不变，内部改为把 `ctx.config.scout.weights` 传给这两个函数。

- [ ] **Step 1: 写失败测试**

在 `packages/scout/test/score.test.ts` 文件末尾新增：

```ts
describe('自定义权重', () => {
  it('mock 模式：heuristicScore 封顶值跟着自定义 weights 变', async () => {
    const config = loadConfig('/tmp/fc-score-weights', {})
    config.scout.weights = { rebrandCost: 5, buyerClarity: 5, visualAppeal: 5 }
    const wctx: CoreCtx = { db: openDb(config.paths.db), config, llm: createLlmClient(config.llm) }
    const d = await scoreCandidate(wctx, meta, 'React + Node + Docker 的 CRM，含 dashboard、screenshot 与 demo。'.repeat(3))
    expect(d.rebrandCost).toBeLessThanOrEqual(5)
    expect(d.buyerClarity).toBeLessThanOrEqual(5)
    expect(d.visualAppeal).toBeLessThanOrEqual(5)
  })
  it('live 模式：parseScoreJson 按自定义 weights 夹取，而非硬编码 30/40/30', async () => {
    const config = loadConfig('/tmp/fc-score-weights-live', { FORGECAST_LLM_MODE: 'live', FORGECAST_LLM_KEY: 'k' })
    config.scout.weights = { rebrandCost: 5, buyerClarity: 5, visualAppeal: 5 }
    const llm = { complete: vi.fn(async () => JSON.stringify({
      rebrandCost: 20, buyerClarity: 20, visualAppeal: 20, techStack: [], rationale: 'r',
    })) }
    const lctx: CoreCtx = { db: openDb(config.paths.db), config, llm: llm as any }
    const d = await scoreCandidate(lctx, meta, 'readme')
    expect(d.rebrandCost).toBe(5) // LLM 返回20，但自定义上限5，夹到5
    expect(d.buyerClarity).toBe(5)
    expect(d.visualAppeal).toBe(5)
  })
  it('live 模式：prompt 文案里的维度上限数字跟着自定义 weights 变', async () => {
    const config = loadConfig('/tmp/fc-score-weights-prompt', { FORGECAST_LLM_MODE: 'live', FORGECAST_LLM_KEY: 'k' })
    config.scout.weights = { rebrandCost: 15, buyerClarity: 25, visualAppeal: 35 }
    const llm = { complete: vi.fn(async () => JSON.stringify({ rebrandCost: 1, buyerClarity: 1, visualAppeal: 1, techStack: [], rationale: 'r' })) }
    const lctx: CoreCtx = { db: openDb(config.paths.db), config, llm: llm as any }
    await scoreCandidate(lctx, meta, 'readme')
    const prompt = llm.complete.mock.calls[0][0].prompt as string
    expect(prompt).toContain('0-15')
    expect(prompt).toContain('0-25')
    expect(prompt).toContain('0-35')
  })
  it('默认权重（30/40/30）时行为跟改动前完全一致', async () => {
    const config = loadConfig('/tmp/fc-score-weights-default', {})
    const wctx: CoreCtx = { db: openDb(config.paths.db), config, llm: createLlmClient(config.llm) }
    const d = await scoreCandidate(wctx, meta, 'React + Node + Docker 的 CRM，含 dashboard、screenshot 与 demo。'.repeat(3))
    expect(d.rebrandCost).toBeLessThanOrEqual(30)
    expect(d.buyerClarity).toBeLessThanOrEqual(40)
    expect(d.visualAppeal).toBeLessThanOrEqual(30)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/scout && npx vitest run test/score.test.ts -t "自定义权重"`
Expected: FAIL（`heuristicScore`/`parseScoreJson` 还没读 `ctx.config.scout.weights`，封顶值/prompt文案仍是硬编码 30/40/30）

- [ ] **Step 3: 改 `heuristicScore` 签名与实现**

`packages/scout/src/score.ts` 的 `heuristicScore` 函数：

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

- [ ] **Step 4: 改 `parseScoreJson` 签名与实现**

`packages/scout/src/score.ts` 的 `parseScoreJson` 函数：

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

- [ ] **Step 5: 改 `scoreCandidate` 传入权重 + prompt 文案插值**

`packages/scout/src/score.ts` 的 `scoreCandidate` 函数：

```ts
export async function scoreCandidate(ctx: CoreCtx, meta: RepoMeta, readme: string): Promise<ScoreDetail> {
  const weights = ctx.config.scout.weights
  if (ctx.config.llm.mode === 'mock') return heuristicScore(meta, readme, weights)

  const system = '你是开源项目商业化评估专家。只输出 JSON，不要多余文字。'
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
  const raw = await ctx.llm.complete({ model: ctx.config.llm.models.analysis, system, prompt })
  const detail = parseScoreJson(raw, weights)
  // LLM 给的类别不在闭集内 → 启发式兜底，杜绝表外标签
  detail.category = (CATEGORIES as readonly string[]).includes(detail.category) ? detail.category : categorizeHeuristic(meta.repo, readme, detail.techStack)
  return detail
}
```

- [ ] **Step 6: 跑测试确认通过**

Run: `cd packages/scout && npx vitest run test/score.test.ts`
Expected: PASS（全部用例，含新增的 4 条，且原有用例——包括 L47-56 那条用 `toEqual` 断言完整对象形状的——不受影响，因为默认 `loadConfig` 权重就是 `{30,40,30}`）

- [ ] **Step 7: 跑 scout 包全部测试确认无回归**

Run: `cd packages/scout && npx vitest run`
Expected: PASS（全部测试）

- [ ] **Step 8: Commit**

```bash
cd "/Users/lizhishaoniange/Documents/开源变现内容工厂"
git add packages/scout/src/score.ts packages/scout/test/score.test.ts
git commit -m "feat(scout): 评分三维上限从硬编码改为读 ctx.config.scout.weights"
```

---

### Task 4: server 路由暴露权重配置

**Files:**
- Modify: `packages/server/src/app.ts`
- Modify: `apps/web/src/api.ts`
- Test: `packages/server/test/settings.test.ts`

**Interfaces:**
- Consumes: `ctx.config.scout.weights`（Task 2 产出）。
- Produces: `GET /api/settings` 响应体新增 `scout.weights` 字段；`SettingsView` TS 类型同步新增——Task 5（设置页表单）、Task 6（候选卡片）依赖这个字段读到当前权重。

- [ ] **Step 1: 写失败测试**

在 `packages/server/test/settings.test.ts` 的 `describe('settings API', ...)` 块内追加：

```ts
  it('GET 返回体含 scout.weights，默认 30/40/30', async () => {
    const v = await (await app.request('/api/settings')).json() as any
    expect(v.scout.weights).toEqual({ rebrandCost: 30, buyerClarity: 40, visualAppeal: 30 })
  })
  it('PUT scout_weight_* 后 GET 能读到新值', async () => {
    await app.request('/api/settings', J({ scout_weight_rebrand: '15', scout_weight_buyer: '55', scout_weight_visual: '10' }))
    const v = await (await app.request('/api/settings')).json() as any
    expect(v.scout.weights).toEqual({ rebrandCost: 15, buyerClarity: 55, visualAppeal: 10 })
  })
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/server && npx vitest run test/settings.test.ts -t "scout.weights|scout_weight"`
Expected: FAIL（`v.scout` 是 `undefined`）

- [ ] **Step 3: 改 `settingsView()`**

`packages/server/src/app.ts` 的 `settingsView()` 函数，在 `github: { mode: cfg.github.mode, token_set: !!cfg.github.token, token_masked: maskKey(cfg.github.token) },` 那一段之后加：

```ts
      scout: { weights: { ...cfg.scout.weights } },
```

`PUT /api/settings` 路由本身不需要改——它现有的循环 `for (const k of SETTING_KEYS) { ... kv[k] = body[k] }` 是通用白名单机制，Task 2 加进 `SETTING_KEYS` 的三个新 key 会被这个循环自动接收，不需要新增分支逻辑。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd packages/server && npx vitest run test/settings.test.ts`
Expected: PASS（全部用例，含新增的 2 条）

- [ ] **Step 5: 前端类型同步**

`apps/web/src/api.ts` 的 `SettingsView` 接口，在 `github: { mode: 'live' | 'mock'; token_set: boolean; token_masked: string }` 那一行之后加：

```ts
  scout: { weights: { rebrandCost: number; buyerClarity: number; visualAppeal: number } }
```

- [ ] **Step 6: 跑 server 包全部测试确认无回归**

Run: `cd packages/server && npx vitest run`
Expected: PASS（全部测试）

- [ ] **Step 7: Commit**

```bash
cd "/Users/lizhishaoniange/Documents/开源变现内容工厂"
git add packages/server/src/app.ts apps/web/src/api.ts packages/server/test/settings.test.ts
git commit -m "feat(server): GET/PUT /api/settings 暴露评分权重配置"
```

---

### Task 5: 设置页「评分权重」卡片

**Files:**
- Modify: `apps/web/src/pages/SettingsPage.tsx`

**Interfaces:**
- Consumes: `SettingsView.scout.weights`（Task 4 产出）；现有 `PUT /api/settings` 接口（`Draft` 对象整体 JSON 提交，`SETTING_KEYS` 白名单自动过滤）。

- [ ] **Step 1: 加 `Draft` 字段与默认值**

`apps/web/src/pages/SettingsPage.tsx` 的 `Draft` 接口，在 `github_mode: string; github_token: string` 那一行之后加：

```ts
  scout_weight_rebrand: string; scout_weight_buyer: string; scout_weight_visual: string
```

`emptyDraft` 常量，在 `github_mode: 'mock', github_token: '',` 那一段之后加：

```ts
  scout_weight_rebrand: '30', scout_weight_buyer: '40', scout_weight_visual: '30',
```

- [ ] **Step 2: 回填逻辑**

`useEffect` 里回填 `setD({...})` 那个对象字面量，在 `github_mode: s.github_mode, github_token: '',` 那一行之后加（**注意**：权重字段不是敏感字段，直接回填当前数字转字符串，不用 LLM key 那种"留空显示打码占位"逻辑）：

```ts
      scout_weight_rebrand: String(s.scout.weights.rebrandCost), scout_weight_buyer: String(s.scout.weights.buyerClarity), scout_weight_visual: String(s.scout.weights.visualAppeal),
```

- [ ] **Step 3: 加"评分权重"卡片区块**

在现有"GitHub"卡片区块（`</section>` 结尾）之后、保存按钮 `<div className="flex items-center gap-3">` 之前，新增：

```tsx
      {/* 评分权重 */}
      <section className="space-y-3 card-forge p-4">
        <h3 className="font-medium">评分权重（三维各自独立，不要求总和100）</h3>
        <div className="grid grid-cols-3 gap-2">
          <Field label="换皮成本上限"><input type="number" min={0} className={inputCls} value={d.scout_weight_rebrand} onChange={(e) => set({ scout_weight_rebrand: e.target.value })} /></Field>
          <Field label="买家清晰度上限"><input type="number" min={0} className={inputCls} value={d.scout_weight_buyer} onChange={(e) => set({ scout_weight_buyer: e.target.value })} /></Field>
          <Field label="内容可视性上限"><input type="number" min={0} className={inputCls} value={d.scout_weight_visual} onChange={(e) => set({ scout_weight_visual: e.target.value })} /></Field>
        </div>
        <p className="text-xs text-faint">改了权重不会自动重新评分老候选，想让老候选按新权重重评，去「找项目」页点「全部重新评分」。</p>
      </section>
```

- [ ] **Step 4: 类型检查**

Run: `cd "/Users/lizhishaoniange/Documents/开源变现内容工厂" && pnpm --filter web exec tsc --noEmit`
Expected: 无新增类型错误

- [ ] **Step 5: 浏览器人工走查**

1. 重启 dev server（同 Task 1 Step 5 的重启方式）
2. 打开设置页，确认"评分权重"卡片显示当前值（默认 30/40/30）
3. 改其中一个数字（如换皮成本改成 20），点保存，刷新页面确认改动生效并持久化
4. 改成负数或清空再保存，确认后端不会把权重改坏（GET 返回值应保留上次的合法值，不会变成 `NaN` 或负数）

- [ ] **Step 6: Commit**

```bash
cd "/Users/lizhishaoniange/Documents/开源变现内容工厂"
git add apps/web/src/pages/SettingsPage.tsx
git commit -m "feat(web): 设置页加「评分权重」可调卡片"
```

---

### Task 6: 候选卡片评分条读取当前权重

**Files:**
- Modify: `apps/web/src/pages/board/CandidateCard.tsx`
- Modify: `apps/web/src/pages/board/CandidateDrawer.tsx`

**Interfaces:**
- Consumes: `SettingsView.scout.weights`（Task 4 产出，通过 `useQuery(['settings'], ...)` 获取，与 `SettingsPage.tsx` 共享同一个 query key，React Query 自动去重缓存不会重复发请求）。
- Produces: `buildDims(weights: {rebrandCost:number;buyerClarity:number;visualAppeal:number}): Array<{key:'rebrandCost'|'buyerClarity'|'visualAppeal'; label:string; max:number}>`——替代原来的常量 `DIMS`。

- [ ] **Step 1: `CandidateCard.tsx` 把 `DIMS` 常量改成 `buildDims` 函数**

把：

```ts
// 三个评分维度各自的满分（§3 四维模型，协议为一票否决不计分）
export const DIMS = [
  { key: 'rebrandCost', label: '换皮', max: 30 },
  { key: 'buyerClarity', label: '买家', max: 40 },
  { key: 'visualAppeal', label: '可视', max: 30 },
] as const
```

改成：

```ts
/** 三个评分维度的展示定义，max 读当前配置的权重（不再硬编码 30/40/30） */
export function buildDims(weights: { rebrandCost: number; buyerClarity: number; visualAppeal: number }) {
  return [
    { key: 'rebrandCost' as const, label: '换皮', max: weights.rebrandCost },
    { key: 'buyerClarity' as const, label: '买家', max: weights.buyerClarity },
    { key: 'visualAppeal' as const, label: '可视', max: weights.visualAppeal },
  ]
}
```

（`Bar` 组件、`parseDetail`、`Detail` 接口都不用改——`Bar` 的 `Math.min(100, (value/max)*100)` 已经天然封顶，老候选实际值超过新设更低上限时条形图直接顶满100%，不会溢出。）

- [ ] **Step 2: `CandidateDrawer.tsx` 拿权重传给 `buildDims`**

顶部 import 现状是四行：

```ts
import { useEffect, useState } from 'react'
import { api, type Candidate, type IntroResponse } from '../../api'
import { Bar, DIMS, parseDetail } from './CandidateCard'
import IntroSections from './IntroSections'
```

**注意 `api` 已经从 `'../../api'` 导入过一次**（第2行），不要再加一行重复 import `api`——改成在第2行的具名导入列表里追加 `type SettingsView`，并单独新增一行 `useQuery` 的 import。改成：

```ts
import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api, type Candidate, type IntroResponse, type SettingsView } from '../../api'
import { Bar, buildDims, parseDetail } from './CandidateCard'
import IntroSections from './IntroSections'
```

函数体内，在 `const d = parseDetail(candidate.score_detail)` 那一行之后加：

```ts
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => api<SettingsView>('/api/settings') })
  const dims = buildDims(settings.data?.scout.weights ?? { rebrandCost: 30, buyerClarity: 40, visualAppeal: 30 })
```

评分条渲染那一行，把：

```tsx
              {DIMS.map((dim) => <Bar key={dim.key} label={dim.label} value={d[dim.key]} max={dim.max} />)}
```

改成：

```tsx
              {dims.map((dim) => <Bar key={dim.key} label={dim.label} value={d[dim.key]} max={dim.max} />)}
```

- [ ] **Step 3: 类型检查**

Run: `cd "/Users/lizhishaoniange/Documents/开源变现内容工厂" && pnpm --filter web exec tsc --noEmit`
Expected: 无新增类型错误

- [ ] **Step 4: 浏览器人工走查**

1. 重启 dev server
2. 在设置页把某个维度权重改小（比如买家清晰度改成 20），保存
3. 回到找项目页，点开一个已评分候选的详情抽屉，确认评分条的"满分"数字（`value/max` 里的 max）变成了新设的 20，且如果该候选历史买家清晰度分数（比如35）超过新上限20，条形图视觉上顶满 100% 而不是溢出或显示异常

- [ ] **Step 5: Commit**

```bash
cd "/Users/lizhishaoniange/Documents/开源变现内容工厂"
git add apps/web/src/pages/board/CandidateCard.tsx apps/web/src/pages/board/CandidateDrawer.tsx
git commit -m "feat(web): 候选详情评分条读当前配置权重，不再硬编码满分"
```

---

## 验证（全部任务完成后）

1. `export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH"`
2. `pnpm test` 全仓回归（重点看 `@forgecast/core`、`@forgecast/scout`、`@forgecast/server`）
3. `pnpm --filter web exec tsc --noEmit` + `pnpm --filter web build`
4. 浏览器端到端：重启 dev server → 找项目页"+ 投喂"走一遍真实 repo → 设置页改评分权重保存 → 找项目页详情抽屉确认评分条 max 跟着变
