# AI 生成演示图（demo 视频模板配图）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 项目详情页新增「AI 生成演示图」按钮，让 LLM 现写 3 份完整 HTML（仪表盘/列表/详情三种常见后台页面），Playwright 截图后落进 `workspace/<slug>/shots/`，免去用户手动准备 demo 视频模板配图。

**Architecture:** 复用 `packages/copywriter/src/cover.ts` 已验证的「LLM 写 HTML → Playwright 截图」技术路线；新增 `packages/copywriter/src/screens.ts` 承载生成逻辑，新增 `POST /api/projects/:slug/screens` 走既有任务队列 SSE 模式（与 `/analyze`、`/rebrand` 完全同构），前端按钮镜像 `ProjectDetailPage.tsx` 里已有的 `analyze()`/`rebrand()` 写法。

**Tech Stack:** TypeScript, pnpm monorepo, Playwright（复用 `@forgecast/copywriter` 已有依赖），Hono，vitest，React + @tanstack/react-query。

**Spec:** `docs/superpowers/specs/2026-08-12-ai-demo-screens-design.md`

## Global Constraints

- **Node 22**：跑任何 pnpm 命令前 `export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH"`（better-sqlite3 ABI）。
- **每个 LLM 能力必须自带 mock，mock 分支绝不能调用 `ctx.llm`**——`createLlmClient` 的 mock 分支是写死返回文案 fixture 的（按 `【钩子类型】` 正则匹配），对本功能完全不适用，必须走独立的 `screens-fixture.ts`。
- **LLM 输出必须是完整自包含 HTML**：不引用任何外部资源/CDN/图片 URL，只用内联 `<style>`——保证 Playwright 离线渲染稳定。
- **固定文件名**：`ai-01-dashboard.png` / `ai-02-list.png` / `ai-03-detail.png`，加 `ai-` 前缀避免和用户手动上传的 shots 撞名；每次点按钮覆盖这 3 个文件，不累加。
- **单张失败不阻断整体**：3 张各自独立 try/catch，失败的跳过+警告；只有 3 张全失败才向上抛错。
- **server 路由顺序红线**：新路由必须注册在 `app.get('/*', …)` 静态托管兜底之前。
- 后端每个任务 TDD：先写失败测试再实现；web 无单测惯例（`tsc --noEmit` + `vite build` 验证）。
- 中文 UI 文案；注释风格跟随现有文件；commit message 末尾带 `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`。

---

## Task 1: mock fixture（3 种页面类型的固定 HTML）

**Files:**
- Create: `packages/copywriter/src/fixtures/screens-fixture.ts`
- Test: `packages/copywriter/test/screens-fixture.test.ts`

**Interfaces:**
- Produces: `export type ScreenType = 'dashboard' | 'list' | 'detail'`、`export function mockScreenHtml(type: ScreenType, brandName: string): string`（返回完整自包含 HTML 字符串，含 `<html>`...`</html>`，品牌名做字符串插值）

- [ ] **Step 1: 写失败测试**

创建 `packages/copywriter/test/screens-fixture.test.ts`：

```ts
import { describe, expect, it } from 'vitest'
import { mockScreenHtml } from '../src/fixtures/screens-fixture'

describe('mockScreenHtml', () => {
  it('三种类型都返回完整自包含 HTML，含品牌名', () => {
    for (const type of ['dashboard', 'list', 'detail'] as const) {
      const html = mockScreenHtml(type, '快客通')
      expect(html.toLowerCase()).toContain('<html')
      expect(html.toLowerCase()).toContain('</html>')
      expect(html).toContain('快客通')
      expect(html).not.toContain('<link') // 不引用外部资源
      expect(html).not.toContain('<script src')
    }
  })
  it('三种类型内容互不相同', () => {
    const a = mockScreenHtml('dashboard', 'X')
    const b = mockScreenHtml('list', 'X')
    const c = mockScreenHtml('detail', 'X')
    expect(a).not.toBe(b)
    expect(b).not.toBe(c)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/copywriter && pnpm exec vitest run test/screens-fixture.test.ts`
Expected: FAIL（`../src/fixtures/screens-fixture` 模块不存在）

- [ ] **Step 3: 实现**

创建 `packages/copywriter/src/fixtures/screens-fixture.ts`：

```ts
export type ScreenType = 'dashboard' | 'list' | 'detail'

/** 离线 mock 演示页：三种固定 HTML 套品牌名，不调 LLM（每个 LLM 能力必须自带 mock 的既有规矩） */
export function mockScreenHtml(type: ScreenType, brandName: string): string {
  if (type === 'dashboard') {
    return `<!doctype html>
<html><head><meta charset="utf-8"><title>${brandName} 仪表盘</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, "PingFang SC", sans-serif; }
  body { width: 1600px; height: 1000px; background: #f5f6fa; color: #1f2430; display: flex; }
  .nav { width: 220px; background: #1f2430; color: #fff; padding: 24px 16px; }
  .nav .brand { font-size: 18px; font-weight: 700; margin-bottom: 24px; }
  .nav .item { padding: 10px 12px; border-radius: 6px; font-size: 14px; margin-bottom: 4px; opacity: .75; }
  .nav .item.on { background: #3b5bfd; opacity: 1; }
  .main { flex: 1; padding: 28px; }
  .topbar { font-size: 20px; font-weight: 700; margin-bottom: 20px; }
  .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; margin-bottom: 20px; }
  .stat { background: #fff; border-radius: 10px; padding: 20px; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
  .stat .n { font-size: 28px; font-weight: 700; color: #3b5bfd; }
  .stat .l { font-size: 13px; color: #6b7280; margin-top: 6px; }
  .chart { background: #fff; border-radius: 10px; height: 480px; box-shadow: 0 1px 3px rgba(0,0,0,.08); display: flex; align-items: flex-end; padding: 24px; gap: 12px; }
  .bar { flex: 1; background: linear-gradient(180deg,#3b5bfd,#8aa0ff); border-radius: 6px 6px 0 0; }
</style></head>
<body>
  <div class="nav"><div class="brand">${brandName}</div>
    <div class="item on">数据概览</div><div class="item">客户管理</div><div class="item">订单</div><div class="item">设置</div>
  </div>
  <div class="main">
    <div class="topbar">数据概览</div>
    <div class="grid">
      <div class="stat"><div class="n">1,284</div><div class="l">今日活跃用户</div></div>
      <div class="stat"><div class="n">¥86,420</div><div class="l">本月收入</div></div>
      <div class="stat"><div class="n">342</div><div class="l">待处理工单</div></div>
      <div class="stat"><div class="n">98.6%</div><div class="l">系统可用率</div></div>
    </div>
    <div class="chart">
      <div class="bar" style="height:40%"></div><div class="bar" style="height:65%"></div><div class="bar" style="height:50%"></div>
      <div class="bar" style="height:80%"></div><div class="bar" style="height:60%"></div><div class="bar" style="height:90%"></div>
      <div class="bar" style="height:70%"></div><div class="bar" style="height:55%"></div>
    </div>
  </div>
</body></html>`
  }
  if (type === 'list') {
    return `<!doctype html>
<html><head><meta charset="utf-8"><title>${brandName} 列表</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, "PingFang SC", sans-serif; }
  body { width: 1600px; height: 1000px; background: #f5f6fa; color: #1f2430; display: flex; }
  .nav { width: 220px; background: #1f2430; color: #fff; padding: 24px 16px; }
  .nav .brand { font-size: 18px; font-weight: 700; margin-bottom: 24px; }
  .nav .item { padding: 10px 12px; border-radius: 6px; font-size: 14px; margin-bottom: 4px; opacity: .75; }
  .nav .item.on { background: #3b5bfd; opacity: 1; }
  .main { flex: 1; padding: 28px; }
  .topbar { font-size: 20px; font-weight: 700; margin-bottom: 20px; }
  table { width: 100%; border-collapse: collapse; background: #fff; border-radius: 10px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
  th, td { text-align: left; padding: 14px 18px; font-size: 14px; border-bottom: 1px solid #eef0f4; }
  th { background: #fafbfc; color: #6b7280; font-weight: 600; }
  .tag { display: inline-block; padding: 3px 10px; border-radius: 999px; font-size: 12px; background: #e8f5e9; color: #2e7d32; }
</style></head>
<body>
  <div class="nav"><div class="brand">${brandName}</div>
    <div class="item">数据概览</div><div class="item on">客户管理</div><div class="item">订单</div><div class="item">设置</div>
  </div>
  <div class="main">
    <div class="topbar">客户列表</div>
    <table>
      <tr><th>客户名称</th><th>联系人</th><th>套餐</th><th>状态</th><th>到期时间</th></tr>
      <tr><td>杭州速达电商</td><td>王经理</td><td>专业版</td><td><span class="tag">正常</span></td><td>2026-12-01</td></tr>
      <tr><td>深圳美好家居</td><td>李总</td><td>标准版</td><td><span class="tag">正常</span></td><td>2026-09-15</td></tr>
      <tr><td>成都优品汇</td><td>张经理</td><td>专业版</td><td><span class="tag">正常</span></td><td>2027-01-20</td></tr>
      <tr><td>广州鑫源贸易</td><td>陈总</td><td>标准版</td><td><span class="tag">正常</span></td><td>2026-10-08</td></tr>
      <tr><td>武汉万家便利</td><td>刘经理</td><td>基础版</td><td><span class="tag">正常</span></td><td>2026-11-30</td></tr>
    </table>
  </div>
</body></html>`
  }
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${brandName} 设置</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, "PingFang SC", sans-serif; }
  body { width: 1600px; height: 1000px; background: #f5f6fa; color: #1f2430; display: flex; }
  .nav { width: 220px; background: #1f2430; color: #fff; padding: 24px 16px; }
  .nav .brand { font-size: 18px; font-weight: 700; margin-bottom: 24px; }
  .nav .item { padding: 10px 12px; border-radius: 6px; font-size: 14px; margin-bottom: 4px; opacity: .75; }
  .nav .item.on { background: #3b5bfd; opacity: 1; }
  .main { flex: 1; padding: 28px; max-width: 720px; }
  .topbar { font-size: 20px; font-weight: 700; margin-bottom: 20px; }
  .card { background: #fff; border-radius: 10px; padding: 24px; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
  .row { display: flex; justify-content: space-between; align-items: center; padding: 14px 0; border-bottom: 1px solid #eef0f4; }
  .row:last-child { border-bottom: none; }
  .row .l { font-size: 14px; color: #374151; }
  .row .v { font-size: 14px; color: #6b7280; }
  .btn { background: #3b5bfd; color: #fff; border: none; border-radius: 6px; padding: 8px 18px; font-size: 13px; }
</style></head>
<body>
  <div class="nav"><div class="brand">${brandName}</div>
    <div class="item">数据概览</div><div class="item">客户管理</div><div class="item">订单</div><div class="item on">设置</div>
  </div>
  <div class="main">
    <div class="topbar">账户设置</div>
    <div class="card">
      <div class="row"><span class="l">企业名称</span><span class="v">${brandName} 企业版</span></div>
      <div class="row"><span class="l">当前套餐</span><span class="v">专业版 · 20 席位</span></div>
      <div class="row"><span class="l">到期时间</span><span class="v">2026-12-31</span></div>
      <div class="row"><span class="l">数据备份</span><span class="v">每日自动备份</span></div>
      <div class="row"><span class="l">操作</span><button class="btn">升级套餐</button></div>
    </div>
  </div>
</body></html>`
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd packages/copywriter && pnpm exec vitest run test/screens-fixture.test.ts`
Expected: PASS（2 tests）

- [ ] **Step 5: Commit**

```bash
git add packages/copywriter/src/fixtures/screens-fixture.ts packages/copywriter/test/screens-fixture.test.ts
git commit -m "feat(copywriter): AI 演示图 mock fixture（三种页面类型固定 HTML）

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 2: `screens.ts` 核心生成逻辑

**Files:**
- Modify: `packages/copywriter/package.json`（加 `@forgecast/analyst` 依赖，复用 `parseAnalysisSummary`）
- Create: `packages/copywriter/src/screens.ts`
- Test: `packages/copywriter/test/screens.test.ts`

**Interfaces:**
- Consumes: `mockScreenHtml(type, brandName)` from Task 1；`parseAnalysisSummary(md): {targetBuyer, painPoint}` from `@forgecast/analyst`
- Produces:
  - `export function validateScreenHtml(html: string): boolean`
  - `export interface ScreenContext { brandName: string; targetUser: string; painPoint: string; keptFeatures: string }`
  - `export function buildScreenContext(ctx: CoreCtx, slug: string): ScreenContext`
  - `export interface GenerateDemoScreensOptions { onProgress?: (msg: string) => void }`
  - `export interface DemoScreensResult { ok: string[]; failed: string[] }`
  - `export async function generateDemoScreens(ctx: CoreCtx, slug: string, opts?: GenerateDemoScreensOptions): Promise<DemoScreensResult>`

- [ ] **Step 1: 加依赖**

编辑 `packages/copywriter/package.json`，`dependencies` 里加一行（保持字母序无所谓，跟在 `@forgecast/core` 后面即可）：

```json
  "dependencies": {
    "@forgecast/analyst": "workspace:*",
    "@forgecast/core": "workspace:*",
    "playwright": "^1.49.0"
  },
```

Run: `pnpm install`（repo 根目录，刷新 workspace 软链接）

- [ ] **Step 2: 写失败测试**

创建 `packages/copywriter/test/screens.test.ts`：

```ts
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createLlmClient, loadConfig, openDb, type CoreCtx } from '@forgecast/core'
import { beforeEach, describe, expect, it } from 'vitest'
import { buildScreenContext, generateDemoScreens, validateScreenHtml } from '../src/screens'

describe('validateScreenHtml', () => {
  it('含完整 <html>...</html> 且非空 → true', () => {
    expect(validateScreenHtml('<html><body>x</body></html>')).toBe(true)
    expect(validateScreenHtml('<!doctype html>\n<HTML><BODY>x</BODY></HTML>')).toBe(true) // 大小写不敏感
  })
  it('缺 </html>、或过短、或空 → false', () => {
    expect(validateScreenHtml('<html><body>x</body>')).toBe(false)
    expect(validateScreenHtml('hi')).toBe(false)
    expect(validateScreenHtml('')).toBe(false)
  })
})

let ctx: CoreCtx
let root: string
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-screens-'))
  const config = loadConfig(root, {}) // mock 模式
  ctx = { db: openDb(config.paths.db), config, llm: createLlmClient(config.llm) }
})

describe('buildScreenContext', () => {
  it('有 analysis.md → 取其目标买家画像/痛点清单首行', () => {
    ctx.db.prepare("INSERT INTO projects (slug, brand_name) VALUES ('demo', '快客通')").run()
    const dir = path.join(root, 'workspace/demo')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'analysis.md'), '## 目标买家画像\n- 主攻：中小商家\n\n## 痛点清单\n1. 回消息熬夜\n')
    const sctx = buildScreenContext(ctx, 'demo')
    expect(sctx.brandName).toBe('快客通')
    expect(sctx.targetUser).toBe('主攻：中小商家')
    expect(sctx.painPoint).toBe('回消息熬夜')
  })
  it('没有 analysis.md、有候选 intro_detail → 回退到 intro_detail', () => {
    ctx.db.prepare(
      "INSERT INTO candidates (repo, url, intro_detail) VALUES ('a/b', 'u', ?)",
    ).run(JSON.stringify({ targetUser: '连锁门店店长', painPoint: '库存对不上账', features: [], summary: '', rebrandIdea: '', generatedAt: '' }))
    const candId = (ctx.db.prepare("SELECT id FROM candidates WHERE repo='a/b'").get() as any).id
    ctx.db.prepare('INSERT INTO projects (slug, candidate_id) VALUES (?, ?)').run('demo2', candId)
    const sctx = buildScreenContext(ctx, 'demo2')
    expect(sctx.targetUser).toBe('连锁门店店长')
    expect(sctx.painPoint).toBe('库存对不上账')
  })
  it('都没有 → 通用兜底文案，不抛错；brand_name 为空则回退 slug', () => {
    ctx.db.prepare("INSERT INTO projects (slug) VALUES ('demo3')").run()
    const sctx = buildScreenContext(ctx, 'demo3')
    expect(sctx.brandName).toBe('demo3')
    expect(sctx.targetUser).not.toBe('')
    expect(sctx.painPoint).not.toBe('')
  })
})

describe('generateDemoScreens (mock 模式，真实 Playwright 渲染)', () => {
  it('产出 3 个固定文件名的 PNG，ok=3 failed=0', async () => {
    ctx.db.prepare("INSERT INTO projects (slug, brand_name) VALUES ('demo', '快客通')").run()
    const result = await generateDemoScreens(ctx, 'demo')
    expect(result.ok.sort()).toEqual(['ai-01-dashboard.png', 'ai-02-list.png', 'ai-03-detail.png'])
    expect(result.failed).toEqual([])
    const shotsDir = path.join(ctx.config.paths.workspace, 'demo', 'shots')
    for (const f of result.ok) expect(fs.existsSync(path.join(shotsDir, f))).toBe(true)
  }, 20000)
  it('重新生成会覆盖同名文件（不累加）', async () => {
    ctx.db.prepare("INSERT INTO projects (slug, brand_name) VALUES ('demo', '快客通')").run()
    await generateDemoScreens(ctx, 'demo')
    const shotsDir = path.join(ctx.config.paths.workspace, 'demo', 'shots')
    const before = fs.readdirSync(shotsDir).sort()
    await generateDemoScreens(ctx, 'demo')
    const after = fs.readdirSync(shotsDir).sort()
    expect(after).toEqual(before) // 文件名集合不变，说明是覆盖不是新增
  }, 30000)
  it('项目不存在 → 抛错', async () => {
    await expect(generateDemoScreens(ctx, 'nope')).rejects.toThrow(/项目不存在/)
  })
  it('进度回调收到三张的完成消息', async () => {
    ctx.db.prepare("INSERT INTO projects (slug, brand_name) VALUES ('demo', '快客通')").run()
    const logs: string[] = []
    await generateDemoScreens(ctx, 'demo', { onProgress: (m) => logs.push(m) })
    expect(logs.some((l) => l.includes('仪表盘'))).toBe(true)
    expect(logs.some((l) => l.includes('列表'))).toBe(true)
    expect(logs.some((l) => l.includes('详情'))).toBe(true)
  }, 20000)
})
```

- [ ] **Step 3: 跑测试确认失败**

Run: `cd packages/copywriter && pnpm exec vitest run test/screens.test.ts`
Expected: FAIL（`../src/screens` 模块不存在）

- [ ] **Step 4: 实现**

创建 `packages/copywriter/src/screens.ts`：

```ts
import fs from 'node:fs'
import path from 'node:path'
import { parseAnalysisSummary } from '@forgecast/analyst'
import type { CoreCtx } from '@forgecast/core'
import { mockScreenHtml, type ScreenType } from './fixtures/screens-fixture'

interface ScreenDef { type: ScreenType; file: string; label: string }

const SCREEN_DEFS: ScreenDef[] = [
  { type: 'dashboard', file: 'ai-01-dashboard.png', label: '数据概览仪表盘' },
  { type: 'list', file: 'ai-02-list.png', label: '核心业务列表页' },
  { type: 'detail', file: 'ai-03-detail.png', label: '详情/设置页' },
]

/** LLM 输出是否是一份看起来合法的完整 HTML：非空、含 <html>...</html>（大小写不敏感） */
export function validateScreenHtml(html: string): boolean {
  if (!html || html.trim().length < 20) return false
  const lower = html.toLowerCase()
  return lower.includes('<html') && lower.includes('</html>')
}

export interface ScreenContext { brandName: string; targetUser: string; painPoint: string; keptFeatures: string }

/**
 * 组装喂给 LLM 的项目上下文：三级回退——analysis.md → 候选期 intro_detail → 通用兜底。
 * 与 ProjectDetailPage.tsx「未分析时展示继承的产品说明书」是同一套回退逻辑，这里是后端版本。
 */
export function buildScreenContext(ctx: CoreCtx, slug: string): ScreenContext {
  const row: any = ctx.db.prepare(`
    SELECT p.brand_name, c.intro_detail
    FROM projects p LEFT JOIN candidates c ON c.id = p.candidate_id
    WHERE p.slug = ?
  `).get(slug)
  const brandName = row?.brand_name || slug

  const analysisPath = path.join(ctx.config.paths.workspace, slug, 'analysis.md')
  const analysisMd = fs.existsSync(analysisPath) ? fs.readFileSync(analysisPath, 'utf8') : ''
  const summary = parseAnalysisSummary(analysisMd)
  let targetUser = summary.targetBuyer
  let painPoint = summary.painPoint

  if (!targetUser && !painPoint && row?.intro_detail) {
    try {
      const intro = JSON.parse(row.intro_detail)
      targetUser = intro.targetUser ?? ''
      painPoint = intro.painPoint ?? ''
    } catch { /* 坏 JSON 按无数据处理 */ }
  }
  if (!targetUser) targetUser = '中小团队的日常业务管理者'
  if (!painPoint) painPoint = '现在靠人工/表格管理，效率低、容易出错'

  const rebrandPath = path.join(ctx.config.paths.workspace, slug, 'rebrand-plan.md')
  let keptFeatures = ''
  if (fs.existsSync(rebrandPath)) {
    const md = fs.readFileSync(rebrandPath, 'utf8')
    keptFeatures = (md.match(/留[：:]\s*(.+)/)?.[1] ?? '').trim()
  }

  return { brandName, targetUser, painPoint, keptFeatures }
}

function buildPrompt(def: ScreenDef, sctx: ScreenContext): { system: string; prompt: string } {
  const system = '你是资深 SaaS 后台产品的前端工程师，只输出一份完整、自包含的 HTML（含内联 <style>，不引用任何外部资源/CDN/图片链接），用于生成产品演示截图。不要输出任何解释文字或 markdown 代码块围栏，只输出 HTML 本身。'
  const prompt = [
    `生成一张「${def.label}」页面的完整 HTML，风格是常见 SaaS 管理后台。`,
    `产品名：${sctx.brandName}`,
    `目标用户：${sctx.targetUser}`,
    `核心痛点：${sctx.painPoint}`,
    sctx.keptFeatures ? `保留的核心功能（体现在页面内容里）：${sctx.keptFeatures}` : '',
    '要求：1600x1000 视口下要撑满、排版整齐；用真实感的中文示例数据（不要写"示例/placeholder"字样）；只用内联 <style>，不要任何外部 <link>/<script src>/图片 URL；要有侧边导航或顶栏，体现是一个真实产品；输出必须是单份完整 <html>...</html>，不要 markdown 代码块包裹、不要额外说明文字。',
  ].filter(Boolean).join('\n')
  return { system, prompt }
}

async function renderScreen(html: string, outPath: string): Promise<void> {
  const { chromium } = await import('playwright')
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
    await page.setContent(html, { waitUntil: 'load' })
    fs.mkdirSync(path.dirname(outPath), { recursive: true })
    await page.screenshot({ path: outPath })
  } finally {
    await browser.close()
  }
}

export interface GenerateDemoScreensOptions { onProgress?: (msg: string) => void }
export interface DemoScreensResult { ok: string[]; failed: string[] }

/**
 * 生成 3 张 AI 演示截图（仪表盘/列表/详情），落进 workspace/<slug>/shots/。
 * 固定文件名、每次覆盖；单张失败 fail-soft（跳过+警告），3 张全失败才抛错。
 */
export async function generateDemoScreens(ctx: CoreCtx, slug: string, opts: GenerateDemoScreensOptions = {}): Promise<DemoScreensResult> {
  const onProgress = opts.onProgress ?? (() => {})
  if (!ctx.db.prepare('SELECT id FROM projects WHERE slug = ?').get(slug)) throw new Error(`项目不存在: ${slug}`)

  const sctx = buildScreenContext(ctx, slug)
  const shotsDir = path.join(ctx.config.paths.workspace, slug, 'shots')
  const result: DemoScreensResult = { ok: [], failed: [] }

  for (const def of SCREEN_DEFS) {
    onProgress(`生成「${def.label}」（${ctx.config.llm.mode} 模式）…`)
    try {
      let html: string
      if (ctx.config.llm.mode === 'mock') {
        html = mockScreenHtml(def.type, sctx.brandName)
      } else {
        const { system, prompt } = buildPrompt(def, sctx)
        html = await ctx.llm.complete({ model: ctx.config.llm.models.analysis, system, prompt })
      }
      if (!validateScreenHtml(html)) throw new Error('LLM 输出不是合法 HTML')
      await renderScreen(html, path.join(shotsDir, def.file))
      result.ok.push(def.file)
      onProgress(`「${def.label}」完成: ${def.file}`)
    } catch (err) {
      result.failed.push(def.file)
      onProgress(`⚠ 「${def.label}」失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  if (result.ok.length === 0) throw new Error('三张演示图全部生成失败')
  return result
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `cd packages/copywriter && pnpm exec vitest run test/screens.test.ts`
Expected: PASS（全部用例；含真实 Playwright 渲染，单个 it 大约 1-3 秒，已加 timeout）

- [ ] **Step 6: 加包导出**

编辑 `packages/copywriter/src/index.ts`，在末尾加一行：

```ts
export * from './parser'
export * from './banned-words'
export * from './knowledge'
export * from './assemble'
export * from './generate'
export * from './cover'
export * from './screens'
```

- [ ] **Step 7: 跑整个 copywriter 包测试确认没有破坏其他用例**

Run: `cd packages/copywriter && pnpm exec vitest run`
Expected: 全部 PASS

- [ ] **Step 8: Commit**

```bash
git add packages/copywriter/package.json packages/copywriter/src/screens.ts packages/copywriter/src/index.ts packages/copywriter/test/screens.test.ts pnpm-lock.yaml
git commit -m "feat(copywriter): AI 生成演示图核心逻辑（LLM 写 HTML + Playwright 截图）

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 3: server 路由

**Files:**
- Modify: `packages/server/src/app.ts`
- Test: `packages/server/test/screens.test.ts`

**Interfaces:**
- Consumes: `generateDemoScreens(ctx, slug, opts)` from Task 2 (`@forgecast/copywriter`)
- Produces: `POST /api/projects/:slug/screens` → `{ taskId: string }`（404 若项目不存在）

- [ ] **Step 1: 写失败测试**

创建 `packages/server/test/screens.test.ts`（照抄 `packages/server/test/cover-regenerate.test.ts` 的 `runTask` 轮询模式）：

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
async function runTask(taskId: string) {
  for (let i = 0; i < 200; i++) {
    await wait(50)
    const t = queue.get(taskId)!
    if (t.status === 'done') return
    if (t.status === 'failed') throw new Error(t.events.at(-1)!.message)
  }
  throw new Error('任务超时')
}

beforeEach(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-screens-srv-'))
  const config = loadConfig(root, {})
  ctx = { db: openDb(config.paths.db), config, llm: createLlmClient(config.llm) }
  ctx.db.prepare("INSERT INTO projects (slug, brand_name) VALUES ('demo', '快客通')").run()
  queue = createTaskQueue()
  app = createApp(ctx, queue)
})

describe('POST /api/projects/:slug/screens', () => {
  it('未知项目 → 404', async () => {
    expect((await app.request('/api/projects/nope/screens', { method: 'POST' })).status).toBe(404)
  })
  it('真实项目 → 200 + taskId，任务完成后 shots/ 出现 3 个文件', async () => {
    const res = await app.request('/api/projects/demo/screens', { method: 'POST' })
    expect(res.status).toBe(200)
    const { taskId } = await res.json() as any
    await runTask(taskId)
    const { files } = await (await app.request('/api/projects/demo/shots')).json() as any
    expect(files.sort()).toEqual(['ai-01-dashboard.png', 'ai-02-list.png', 'ai-03-detail.png'])
  }, 20000)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/server && pnpm exec vitest run test/screens.test.ts`
Expected: FAIL（路由不存在，两个用例都拿到非预期状态码/一直 404）

- [ ] **Step 3: 实现——加 import + 路由**

在 `packages/server/src/app.ts` 顶部找到：

```ts
import { generateCopy, regenerateCover } from '@forgecast/copywriter'
```

改成：

```ts
import { generateCopy, generateDemoScreens, regenerateCover } from '@forgecast/copywriter'
```

然后找到 `POST /api/projects/:slug/shots` 路由（上一轮加的），紧跟着的 `GET /api/projects/:slug/shots` 之后插入新路由：

```ts
  app.get('/api/projects/:slug/shots', (c) => {
    const dir = path.join(ctx.config.paths.workspace, c.req.param('slug'), 'shots')
    return c.json({ files: fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [] })
  })

  // AI 生成演示图：LLM 写 3 份完整 HTML（仪表盘/列表/详情）+ Playwright 截图，落进 shots/
  app.post('/api/projects/:slug/screens', async (c) => {
    const slug = c.req.param('slug')
    if (!ctx.db.prepare('SELECT id FROM projects WHERE slug = ?').get(slug)) return c.json({ error: '项目不存在' }, 404)
    const taskId = queue.enqueue((log) => generateDemoScreens(ctx, slug, { onProgress: log }))
    return c.json({ taskId })
  })
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd packages/server && pnpm exec vitest run test/screens.test.ts`
Expected: PASS（2 tests；第二条含真实 Playwright 渲染，约 1-3 秒）

- [ ] **Step 5: 跑整个 server 包测试确认没有破坏其他用例**

Run: `cd packages/server && pnpm exec vitest run`
Expected: 全部 PASS

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/app.ts packages/server/test/screens.test.ts
git commit -m "feat(server): POST /api/projects/:slug/screens——AI 生成演示图路由

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 4: 前端按钮

**Files:**
- Modify: `apps/web/src/pages/ProjectDetailPage.tsx`

**Interfaces:**
- Consumes: `POST /api/projects/:slug/screens` → `{taskId}`（Task 3）；`api`、`subscribeTask` from `../api`（已在文件顶部导入，不用改 import）

- [ ] **Step 1: 加 state + 生成函数**

在 `ProjectDetailPage.tsx` 里找到：

```ts
  const [rebranding, setRebranding] = useState(false)
  const [rebrandLog, setRebrandLog] = useState<string[]>([])
  const [copied, setCopied] = useState(false)
```

改成：

```ts
  const [rebranding, setRebranding] = useState(false)
  const [rebrandLog, setRebrandLog] = useState<string[]>([])
  const [copied, setCopied] = useState(false)
  const [screensBusy, setScreensBusy] = useState(false)
  const [screensLog, setScreensLog] = useState<string[]>([])
```

然后在 `rebrand()` 函数结束的 `}` 之后（`copyRebrandMd` 函数之前）插入新函数：

```ts
  async function generateScreens() {
    if (screensBusy) return
    setScreensBusy(true)
    setScreensLog([])
    try {
      const { taskId } = await api<{ taskId: string }>(`/api/projects/${slug}/screens`, { method: 'POST' })
      subscribeTask(taskId, (e) => {
        setScreensLog((l) => [...l, `${e.type === 'error' ? '❌ ' : ''}${e.message}`])
        if (e.type === 'done' || e.type === 'error') {
          setScreensBusy(false)
          qc.invalidateQueries({ queryKey: ['shots', slug] })
        }
      })
    } catch (err) {
      setScreensLog((l) => [...l, `❌ ${err instanceof Error ? err.message : String(err)}`])
      setScreensBusy(false)
    }
  }
```

- [ ] **Step 2: shots 卡片加按钮 + 日志**

找到 shots 卡片这一块：

```tsx
        <div className="card-forge p-4 space-y-2">
          <h3 className="font-semibold">shots（demo 视频模板用）</h3>
          <p className="text-xs text-faint">文件名前缀控制播放顺序，如 01-xxx.png</p>
          <input type="file" accept="image/png,image/jpeg,image/webp" className="text-sm"
            onChange={(e) => e.target.files?.[0] && uploadShot(e.target.files[0])} />
          <ul className="text-sm text-sub space-y-1">
            {shots.data?.files.map((f) => (
              <li key={f}><a className="text-fire" href={`/files/${slug}/shots/${f}`} target="_blank" rel="noreferrer">{f}</a></li>
            ))}
            {shots.data?.files.length === 0 && <li className="text-faint">暂无</li>}
          </ul>
        </div>
```

改成：

```tsx
        <div className="card-forge p-4 space-y-2">
          <h3 className="font-semibold">shots（demo 视频模板用）</h3>
          <p className="text-xs text-faint">文件名前缀控制播放顺序，如 01-xxx.png</p>
          <input type="file" accept="image/png,image/jpeg,image/webp" className="text-sm"
            onChange={(e) => e.target.files?.[0] && uploadShot(e.target.files[0])} />
          <button className="btn-ink w-full py-1.5 text-sm disabled:opacity-50"
            disabled={screensBusy} onClick={generateScreens}>
            {screensBusy ? '生成中…' : 'AI 生成演示图'}
          </button>
          <p className="text-xs text-faint">会调用 3 次大模型 + 渲染，约十几秒到 1 分钟；生成 3 张固定文件名的图，重新点会覆盖</p>
          {screensLog.length > 0 && (
            <div className="rounded bg-neutral-900 p-2 text-xs text-green-400 font-mono max-h-24 overflow-y-auto space-y-1">
              {screensLog.map((l, i) => <div key={i}>{l}</div>)}
            </div>
          )}
          <ul className="text-sm text-sub space-y-1">
            {shots.data?.files.map((f) => (
              <li key={f}><a className="text-fire" href={`/files/${slug}/shots/${f}`} target="_blank" rel="noreferrer">{f}</a></li>
            ))}
            {shots.data?.files.length === 0 && <li className="text-faint">暂无</li>}
          </ul>
        </div>
```

- [ ] **Step 3: 类型检查 + 构建**

Run: `export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH" && cd apps/web && pnpm exec tsc --noEmit`
Expected: 无输出（通过）

Run: `pnpm exec vite build`
Expected: `✓ built in ...`，无报错

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/pages/ProjectDetailPage.tsx
git commit -m "feat(web): 项目详情页加「AI 生成演示图」按钮

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 5: 全仓验证 + 浏览器端到端 + 文档同步

- [ ] **Step 1: 全仓测试 + 类型检查 + 构建**

```bash
export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH"
pnpm test
pnpm --filter web exec tsc --noEmit
pnpm --filter web build
```
Expected: 全部通过

- [ ] **Step 2: 重启 dev server（后端改动需要重启才生效）**

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
Expected: 看到 `已启动 http://127.0.0.1:4321` 和 `VITE ... ready`

- [ ] **Step 3: 浏览器手工验收**

打开任意一个已立项项目的详情页（如 `/projects/ant-design-pro`），点「AI 生成演示图」，等它跑完，确认：
- shots 卡片文件列表出现 `ai-01-dashboard.png`、`ai-02-list.png`、`ai-03-detail.png` 三个链接，点开能看到像样的后台截图
- 回「做内容」页选 demo 模板生成视频，视频里能看到这几张图轮播

- [ ] **Step 4: 文档同步**

在 `README.md` 里找到这一行（做内容板块描述）：

```
/ 做内容 `/workshop`（文案+视频生成；视频可选模板/BGM/情绪/背景/字幕，封面可独立选模板+raw 图重新生成，素材审核/发布数据展示齐全，见 docs/superpowers/specs/2026-08-11-workshop-panel-design.md；含卡点编辑器） / 分发营销 `/market` / 定制项目 `/tailor`）；
```

改成：

```
/ 做内容 `/workshop`（文案+视频生成；视频可选模板/BGM/情绪/背景/字幕，封面可独立选模板+raw 图重新生成，素材审核/发布数据展示齐全，见 docs/superpowers/specs/2026-08-11-workshop-panel-design.md；含卡点编辑器；项目详情页可一键 AI 生成 demo 模板配图，见 docs/superpowers/specs/2026-08-12-ai-demo-screens-design.md） / 分发营销 `/market` / 定制项目 `/tailor`）；
```

在 `开源变现内容工厂-开发文档.md` 里找到「素材工坊」那一行末尾，补一句（原句末尾是 `。项目详情页新增 shots/ 上传入口（demo 模板依赖，2026-08-11）`），改成：

```
。项目详情页新增 shots/ 上传入口 + 「AI 生成演示图」一键生成 3 张后台截图（LLM 写 HTML + Playwright 截图，demo 模板依赖，2026-08-11/2026-08-12）
```

- [ ] **Step 5: Commit**

```bash
git add README.md "开源变现内容工厂-开发文档.md"
git commit -m "docs: 同步 AI 生成演示图功能说明

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```
