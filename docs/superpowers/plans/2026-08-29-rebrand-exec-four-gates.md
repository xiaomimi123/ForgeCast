# 拆解页四关验收 + 盖章（子项目③）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在已有 `rebrandExec`（构建关）基础上扩展启动/健康检查/截图三关，结果落库，"拆解"页新增待验收/已完成区块，项目详情抽屉加触发入口。

**Architecture:** 三个新验证工具（`healthcheck.ts`/`screenshot.ts`/`kill-port.ts`）各自独立、可单测；`rebrandExec` 主状态机新增可选依赖字段，只在 agent 自报"启动成功"时才触发后三关，未触发时行为与现在完全一致（已有 8 个测试零改动继续通过）。数据落地走"整块 JSON 塞 TEXT 列"的既有模式（`candidates.score_detail` 同款），不建子表。前端只加不改——新组件 `AcceptanceSection.tsx` 挂在 `ProjectGroups` 下面，`ProjectDrawer.tsx` 加一个按钮，均复用现成的任务队列/SSE/mutation 基础设施。

**Tech Stack:** TypeScript + vitest（`packages/rebrand`/`packages/core`/`packages/server`）；React + Tailwind v4（`apps/web`，无单测，人工过一遍）。

**Spec:** `docs/superpowers/specs/2026-08-29-rebrand-exec-four-gates-design.md`

## Global Constraints

- 现有 `rebrandExec` 的 8 个测试（`packages/rebrand/test/rebrand-exec.test.ts`）一个字都不改，必须全部继续通过——新逻辑只在 `lastAgent.serverStarted` 为真值时才触发，现有测试的 mock `AgentResult` 都没这个字段（`undefined` 即假值），天然不会碰到新代码路径。
- `status` 字段语义不变（仍只反映"构建是否通过"），`gates`/`screenshotPath` 是新增的、独立的可选字段。
- 不新增打包/部署能力；"打开演示站"只用已有 `projects.demo_url`，为空不显示按钮。
- 不改 `ProjectGroups.tsx` 本身（现有分析/换皮泳道逻辑），新区块是挂在它下面的独立组件。
- `apps/web` 无单测，验收方式是 `tsc --noEmit` + 人工过浏览器，不是伪造测试。
- 真实 Playwright/进程测试（Task 2/3）用真实子进程/真实 chromium，不 mock——这是本仓库对这类基础设施代码的既有惯例（`packages/server/test/cover-regenerate.test.ts` 同款风格），比伪造依赖注入更能捕捉真实故障模式。

---

### Task 1: `waitForPort` 健康检查（`packages/rebrand/src/healthcheck.ts`）

**Files:**
- Create: `packages/rebrand/src/healthcheck.ts`
- Test: `packages/rebrand/test/healthcheck.test.ts`

**Interfaces:**
- Produces：`export function waitForPort(port: number, opts: { timeoutMs: number; intervalMs?: number; fetchImpl?: typeof fetch }): Promise<boolean>`

- [ ] **Step 1: 写失败测试**

创建 `packages/rebrand/test/healthcheck.test.ts`：

```ts
import { describe, expect, it, vi } from 'vitest'
import { waitForPort } from '../src/healthcheck'

describe('waitForPort', () => {
  it('第一次就连上 → true，只调用一次', async () => {
    const fetchImpl = vi.fn(async () => new Response())
    const ok = await waitForPort(3000, { timeoutMs: 5000, fetchImpl: fetchImpl as any })
    expect(ok).toBe(true)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(fetchImpl).toHaveBeenCalledWith('http://127.0.0.1:3000', expect.anything())
  })
  it('一直连不上 → 超时后 false，期间重试了不止一次', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('ECONNREFUSED') })
    const ok = await waitForPort(3000, { timeoutMs: 300, intervalMs: 100, fetchImpl: fetchImpl as any })
    expect(ok).toBe(false)
    expect(fetchImpl.mock.calls.length).toBeGreaterThan(1)
  })
  it('前几次失败、之后连上 → true', async () => {
    let calls = 0
    const fetchImpl = vi.fn(async () => { calls++; if (calls < 3) throw new Error('refused'); return new Response() })
    const ok = await waitForPort(3000, { timeoutMs: 2000, intervalMs: 50, fetchImpl: fetchImpl as any })
    expect(ok).toBe(true)
    expect(calls).toBe(3)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH"
cd /Users/lizhishaoniange/Documents/开源变现内容工厂
pnpm --filter @forgecast/rebrand test healthcheck
```

预期：`Cannot find module '../src/healthcheck'`。

- [ ] **Step 3: 实现**

创建 `packages/rebrand/src/healthcheck.ts`：

```ts
/** 探测 http://127.0.0.1:<port>，成功=拿到任意 HTTP 响应（不要求 200——很多脚手架首页会 30x/404，
 *  能连上说明服务确实起来了）。轮询直到超时，给服务一点启动缓冲时间。 */
export async function waitForPort(
  port: number,
  opts: { timeoutMs: number; intervalMs?: number; fetchImpl?: typeof fetch },
): Promise<boolean> {
  const interval = opts.intervalMs ?? 1000
  const fetchFn = opts.fetchImpl ?? fetch
  const deadline = Date.now() + opts.timeoutMs
  while (Date.now() < deadline) {
    try {
      await fetchFn(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(2000) })
      return true
    } catch {
      // 连不上，继续轮询
    }
    await new Promise((r) => setTimeout(r, interval))
  }
  return false
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
pnpm --filter @forgecast/rebrand test healthcheck
```

- [ ] **Step 5: 提交**

```bash
git add packages/rebrand/src/healthcheck.ts packages/rebrand/test/healthcheck.test.ts
git commit -m "feat(rebrand): waitForPort——健康检查关，轮询探测端口直到超时"
```

---

### Task 2: `captureScreenshot` 截图（`packages/rebrand/src/screenshot.ts`）

**Files:**
- Modify: `packages/rebrand/package.json`（加 `playwright` 依赖）
- Create: `packages/rebrand/src/screenshot.ts`
- Test: `packages/rebrand/test/screenshot.test.ts`

**Interfaces:**
- Produces：`export async function captureScreenshot(port: number, outPath: string): Promise<boolean>`

本任务用**真实 Playwright**（不 mock），跟 `packages/server/test/cover-regenerate.test.ts` 同款风格——本机已装 chromium（README 里 `pnpm --filter @forgecast/copywriter exec playwright install chromium` 这一步）。

- [ ] **Step 1: 加依赖**

编辑 `packages/rebrand/package.json`，在 `dependencies` 里加一行（对齐 `packages/copywriter/package.json` 里的版本号）：

```json
  "dependencies": { "@forgecast/core": "workspace:*", "playwright": "^1.49.0" },
```

```bash
export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH"
cd /Users/lizhishaoniange/Documents/开源变现内容工厂
pnpm install
```

- [ ] **Step 2: 写失败测试**

创建 `packages/rebrand/test/screenshot.test.ts`：

```ts
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { captureScreenshot } from '../src/screenshot'

describe('captureScreenshot（真实 Playwright）', () => {
  it('对本地 HTTP 服务截图，产出非空 PNG 文件', async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<h1>hi</h1>')
    })
    await new Promise<void>((resolve) => server.listen(0, resolve))
    const port = (server.address() as { port: number }).port
    const outPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fc-shot-')), 'shot.png')
    try {
      const ok = await captureScreenshot(port, outPath)
      expect(ok).toBe(true)
      expect(fs.existsSync(outPath)).toBe(true)
      expect(fs.statSync(outPath).size).toBeGreaterThan(0)
    } finally {
      server.close()
    }
  }, 20000)

  it('端口没有服务监听 → 返回 false，不抛错', async () => {
    const outPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fc-shot-')), 'shot.png')
    const ok = await captureScreenshot(59999, outPath)
    expect(ok).toBe(false)
  }, 20000)
})
```

- [ ] **Step 3: 跑测试确认失败**

```bash
pnpm --filter @forgecast/rebrand test screenshot
```

预期：`Cannot find module '../src/screenshot'`。

- [ ] **Step 4: 实现**

创建 `packages/rebrand/src/screenshot.ts`：

```ts
/** 对 http://127.0.0.1:<port> 截图存到 outPath。跟 packages/copywriter/src/cover.ts 同样的 chromium.launch() 用法。 */
export async function captureScreenshot(port: number, outPath: string): Promise<boolean> {
  const { chromium } = await import('playwright')
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage()
    await page.goto(`http://127.0.0.1:${port}`, { waitUntil: 'load', timeout: 15000 })
    await page.screenshot({ path: outPath })
    return true
  } catch {
    return false
  } finally {
    await browser.close()
  }
}
```

- [ ] **Step 5: 跑测试确认通过**

```bash
pnpm --filter @forgecast/rebrand test screenshot
```

如果第二个用例（端口没有服务）耗时接近 20s 超时导致 flaky，检查 `page.goto` 的 `timeout: 15000` 是否生效（Playwright 连不上时应在 15s 内抛错，不会挂到测试自己的 20s 超时）。

- [ ] **Step 6: 提交**

```bash
git add packages/rebrand/package.json pnpm-lock.yaml packages/rebrand/src/screenshot.ts packages/rebrand/test/screenshot.test.ts
git commit -m "feat(rebrand): captureScreenshot——截图关，复用 copywriter 同款 Playwright 用法"
```

---

### Task 3: `killByPort` 端口级进程收尾（`packages/rebrand/src/kill-port.ts`）

**Files:**
- Create: `packages/rebrand/src/kill-port.ts`
- Test: `packages/rebrand/test/kill-port.test.ts`

**Interfaces:**
- Consumes：`spawnCapture` from `./spawn-capture`（已有）
- Produces：`export async function killByPort(port: number): Promise<void>`

本任务用真实子进程验证（macOS `lsof`/`kill`），不 mock。**测试安全性要点**：绝不能对当前测试运行进程自身监听的端口调用 `killByPort`（会把 vitest worker 自己杀掉）——必须另起一个真实子进程来监听端口，`killByPort` 杀的是那个子进程，不是测试进程本身。

- [ ] **Step 1: 写失败测试**

创建 `packages/rebrand/test/kill-port.test.ts`：

```ts
import { spawn } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { killByPort } from '../src/kill-port'

describe('killByPort', () => {
  it('杀掉真实监听某端口的子进程，该子进程随后退出', async () => {
    // 子进程绑定随机端口(0)并把实际分配到的端口打印到 stdout，避免固定端口号冲突
    const child = spawn('node', ['-e', `
      const s = require('http').createServer().listen(0, () => { console.log(s.address().port) })
    `])
    const port = await new Promise<number>((resolve) => {
      child.stdout.once('data', (d) => resolve(Number(d.toString().trim())))
    })
    await killByPort(port)
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null) return resolve()
      child.on('exit', () => resolve())
    })
    expect(child.exitCode).not.toBeNull()
  }, 10000)

  it('端口没有占用者 → 不抛错，直接返回', async () => {
    await expect(killByPort(58733)).resolves.toBeUndefined()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm --filter @forgecast/rebrand test kill-port
```

预期：`Cannot find module '../src/kill-port'`。

- [ ] **Step 3: 实现**

创建 `packages/rebrand/src/kill-port.ts`：

```ts
import { spawnCapture } from './spawn-capture'

/** 按端口强杀占用进程（macOS/Linux：lsof -ti:<port> | xargs kill -9）。找不到占用进程视为已经退出，不算失败。 */
export async function killByPort(port: number): Promise<void> {
  const { code, stdout } = await spawnCapture('lsof', ['-ti', `:${port}`], { timeoutMs: 5000, label: 'lsof' })
  if (code !== 0 || !stdout.trim()) return
  const pids = stdout.trim().split('\n')
  await spawnCapture('kill', ['-9', ...pids], { timeoutMs: 5000, label: 'kill' })
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
pnpm --filter @forgecast/rebrand test kill-port
```

- [ ] **Step 5: 提交**

```bash
git add packages/rebrand/src/kill-port.ts packages/rebrand/test/kill-port.test.ts
git commit -m "feat(rebrand): killByPort——按端口强杀进程，agent 自启动服务的收尾"
```

---

### Task 4: `rebrandExec` 主流程整合四关

**Files:**
- Modify: `packages/rebrand/src/fixtures/rebrand-exec-fixture.ts`（`AgentResult` 扩字段 + mock 新增三个函数 + `mockRunAgent` 补字段）
- Modify: `packages/rebrand/src/rebrand-exec.ts`（`RebrandExecDeps`/`RebrandExecResult` 扩字段、主循环整合、prompt 追加、`renderReport` 追加四关展示、`rebrandExecAuto` 装配新 deps）
- Test: `packages/rebrand/test/rebrand-exec.test.ts`（新增用例，**不改**任何现有用例）

**Interfaces:**
- Consumes：Task 1 的 `waitForPort`、Task 2 的 `captureScreenshot`、Task 3 的 `killByPort`
- Produces：`RebrandExecDeps` 新增可选 `waitForPort?/captureScreenshot?/killByPort?`；`RebrandExecResult` 新增可选 `gates?: { build: boolean; start: boolean; health: boolean; screenshot: boolean }`、`screenshotPath?: string`；`AgentResult` 新增可选 `serverStarted?/serverPort?/startCommand?`

- [ ] **Step 1: 写失败测试**

编辑 `packages/rebrand/test/rebrand-exec.test.ts`，在文件末尾（最后一个 `describe` 块后面）追加新 `describe`：

```ts
describe('rebrandExec 四关验收（构建之后的启动/健康检查/截图）', () => {
  it('四关全绿：build 过 + agent 自报启动成功 + 健康检查通过 + 截图成功', async () => {
    seedProject('demo')
    const waitForPort = vi.fn(async () => true)
    const captureScreenshot = vi.fn(async () => true)
    const killByPort = vi.fn(async () => {})
    const r = await rebrandExec(ctx, 'demo', {
      deps: {
        clone: vi.fn(async () => {}),
        runAgent: vi.fn(async () => ({ status: 'done', summary: 'ok', changedFiles: [], serverStarted: true, serverPort: 4567, startCommand: 'npm start' })),
        runBuild: vi.fn(async () => ({ ok: true, output: '' })),
        waitForPort, captureScreenshot, killByPort,
      },
    })
    expect(r.gates).toEqual({ build: true, start: true, health: true, screenshot: true })
    expect(r.screenshotPath).toBe(path.join('demo', 'rebrand-exec-screenshot.png'))
    expect(waitForPort).toHaveBeenCalledWith(4567, expect.anything())
    expect(captureScreenshot).toHaveBeenCalledWith(4567, expect.stringContaining('rebrand-exec-screenshot.png'))
    expect(killByPort).toHaveBeenCalledWith(4567)
  })

  it('agent 自报启动失败 → 后三关都不跑，gates 只有 build 为真', async () => {
    seedProject('demo')
    const waitForPort = vi.fn(async () => true)
    const captureScreenshot = vi.fn(async () => true)
    const killByPort = vi.fn(async () => {})
    const r = await rebrandExec(ctx, 'demo', {
      deps: {
        clone: vi.fn(async () => {}),
        runAgent: vi.fn(async () => ({ status: 'done', summary: 'ok', changedFiles: [], serverStarted: false })),
        runBuild: vi.fn(async () => ({ ok: true, output: '' })),
        waitForPort, captureScreenshot, killByPort,
      },
    })
    expect(r.gates).toEqual({ build: true, start: false, health: false, screenshot: false })
    expect(r.screenshotPath).toBeUndefined()
    expect(waitForPort).not.toHaveBeenCalled()
    expect(captureScreenshot).not.toHaveBeenCalled()
    expect(killByPort).not.toHaveBeenCalled()
  })

  it('健康检查失败 → 截图关不跑，但仍然收尾杀进程', async () => {
    seedProject('demo')
    const waitForPort = vi.fn(async () => false)
    const captureScreenshot = vi.fn(async () => true)
    const killByPort = vi.fn(async () => {})
    const r = await rebrandExec(ctx, 'demo', {
      deps: {
        clone: vi.fn(async () => {}),
        runAgent: vi.fn(async () => ({ status: 'done', summary: 'ok', changedFiles: [], serverStarted: true, serverPort: 9000 })),
        runBuild: vi.fn(async () => ({ ok: true, output: '' })),
        waitForPort, captureScreenshot, killByPort,
      },
    })
    expect(r.gates).toEqual({ build: true, start: true, health: false, screenshot: false })
    expect(captureScreenshot).not.toHaveBeenCalled()
    expect(killByPort).toHaveBeenCalledWith(9000)
  })

  it('没有传新 deps（老调用方式）→ agent 自报启动成功也不会报错，gates 未定义', async () => {
    seedProject('demo')
    const r = await rebrandExec(ctx, 'demo', {
      deps: {
        clone: vi.fn(async () => {}),
        runAgent: vi.fn(async () => ({ status: 'done', summary: 'ok', changedFiles: [], serverStarted: true, serverPort: 1234 })),
        runBuild: vi.fn(async () => ({ ok: true, output: '' })),
      },
    })
    expect(r.status).toBe('done')
    expect(r.gates).toBeUndefined()
  })

  it('报告里含四关展示', async () => {
    seedProject('demo')
    const r = await rebrandExec(ctx, 'demo', {
      deps: {
        clone: vi.fn(async () => {}),
        runAgent: vi.fn(async () => ({ status: 'done', summary: 'ok', changedFiles: [], serverStarted: true, serverPort: 4567 })),
        runBuild: vi.fn(async () => ({ ok: true, output: '' })),
        waitForPort: vi.fn(async () => true),
        captureScreenshot: vi.fn(async () => true),
        killByPort: vi.fn(async () => {}),
      },
    })
    const report = fs.readFileSync(path.join(root, 'workspace', r.reportPath), 'utf8')
    expect(report).toContain('四关验收')
    expect(report).toContain('构建：✅')
    expect(report).toContain('启动：✅')
    expect(report).toContain('健康检查：✅')
    expect(report).toContain('截图：✅')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH"
cd /Users/lizhishaoniange/Documents/开源变现内容工厂
pnpm --filter @forgecast/rebrand test rebrand-exec.test
```

预期：新增用例失败（`r.gates` 是 `undefined`，或类型报错 `deps` 对象不认识 `waitForPort` 等属性——先跑一次感受具体报错，两种都是"功能未实现"导致，不是笔误）。

- [ ] **Step 3: 实现**

**3a. 编辑 `packages/rebrand/src/fixtures/rebrand-exec-fixture.ts`**：

把 `AgentResult` interface：

```ts
export interface AgentResult { status: 'done' | 'blocked'; summary: string; changedFiles: string[] }
```

改成：

```ts
export interface AgentResult {
  status: 'done' | 'blocked'; summary: string; changedFiles: string[]
  // 启动关专属，全部可选——agent 没试启动/试了失败都可能缺失
  serverStarted?: boolean
  serverPort?: number
  startCommand?: string
}
```

在 `mockRunAgent` 函数里，把返回值：

```ts
  return { status: 'done', summary: '已完成品牌替换/删除项/中文化（mock）', changedFiles: ['package.json'] }
```

改成：

```ts
  return {
    status: 'done', summary: '已完成品牌替换/删除项/中文化（mock）', changedFiles: ['package.json'],
    serverStarted: true, serverPort: 0, startCommand: 'echo mock-start',
  }
```

在文件末尾（`mockRunBuild` 后面）追加三个新 mock 函数：

```ts
/** mock 健康检查：不发真实网络请求，固定通过。 */
export async function mockWaitForPort(_port: number): Promise<boolean> { return true }

/** mock 截图：不调真实 Playwright，落一个占位文件模拟"已截图"。 */
export async function mockCaptureScreenshot(_port: number, outPath: string): Promise<boolean> {
  fs.writeFileSync(outPath, 'MOCK_PNG')
  return true
}

/** mock 进程收尾：不真的杀进程，空操作。 */
export async function mockKillByPort(_port: number): Promise<void> {}
```

**3b. 编辑 `packages/rebrand/src/rebrand-exec.ts`**：

在 import 区，把：

```ts
import { detectAndRunBuild } from './detect-build'
import type { AgentResult } from './fixtures/rebrand-exec-fixture'
import { mockClone, mockRunAgent, mockRunBuild } from './fixtures/rebrand-exec-fixture'
import { spawnCapture } from './spawn-capture'
```

改成：

```ts
import { detectAndRunBuild } from './detect-build'
import type { AgentResult } from './fixtures/rebrand-exec-fixture'
import { mockCaptureScreenshot, mockClone, mockKillByPort, mockRunAgent, mockRunBuild, mockWaitForPort } from './fixtures/rebrand-exec-fixture'
import { captureScreenshot } from './screenshot'
import { killByPort } from './kill-port'
import { waitForPort } from './healthcheck'
import { spawnCapture } from './spawn-capture'
```

把 `RebrandExecDeps` interface：

```ts
export interface RebrandExecDeps {
  clone: (url: string, dir: string) => Promise<void>
  runAgent: (prompt: string, cwd: string) => Promise<AgentResult>
  runBuild: (cwd: string) => Promise<{ ok: boolean; output: string } | null>
}
```

改成：

```ts
export interface RebrandExecDeps {
  clone: (url: string, dir: string) => Promise<void>
  runAgent: (prompt: string, cwd: string) => Promise<AgentResult>
  runBuild: (cwd: string) => Promise<{ ok: boolean; output: string } | null>
  // 四关的后三关，全部可选——不传时（老调用方式）这三关直接跳过，status/build 关行为不变
  waitForPort?: (port: number, opts: { timeoutMs: number }) => Promise<boolean>
  captureScreenshot?: (port: number, outPath: string) => Promise<boolean>
  killByPort?: (port: number) => Promise<void>
}
```

把 `RebrandExecResult` interface：

```ts
export interface RebrandExecResult { status: 'done' | 'build-failed' | 'no-buildscript'; rounds: number; reportPath: string }
```

改成：

```ts
export interface RebrandExecResult {
  status: 'done' | 'build-failed' | 'no-buildscript'
  rounds: number
  reportPath: string
  gates?: { build: boolean; start: boolean; health: boolean; screenshot: boolean }
  screenshotPath?: string
}
```

在 `rebrandExec` 函数体内，找到：

```ts
  const startedAt = Date.now()
  let round = 1
  let status: RebrandExecResult['status'] = 'build-failed'
  let lastAgent: AgentResult = { status: 'blocked', summary: '', changedFiles: [] }
  let lastBuild: { ok: boolean; output: string } | null = null
  while (round <= MAX_ROUNDS) {
    onProgress(`第 ${round} 轮改造…`)
    const prompt = round === 1
      ? buildInitialPrompt(slug, planPath, sourceDir)
      : buildRetryPrompt(sourceDir, lastBuild?.output ?? '')
    lastAgent = await opts.deps.runAgent(prompt, sourceDir)
    lastBuild = await opts.deps.runBuild(sourceDir)
    if (lastBuild === null) { status = 'no-buildscript'; break }
    if (lastBuild.ok) { status = 'done'; break }
    if (round === MAX_ROUNDS) { status = 'build-failed'; break }
    round++
  }

  const reportRel = path.join(slug, 'rebrand-exec-report.md')
  const report = renderReport({ slug, status, rounds: round, elapsedMs: Date.now() - startedAt, agent: lastAgent, build: lastBuild })
  fs.writeFileSync(path.join(projectDir, 'rebrand-exec-report.md'), report, 'utf8')
  onProgress(`执行完成: ${status}（${round} 轮）`)

  return { status, rounds: round, reportPath: reportRel }
```

改成：

```ts
  const startedAt = Date.now()
  let round = 1
  let status: RebrandExecResult['status'] = 'build-failed'
  let lastAgent: AgentResult = { status: 'blocked', summary: '', changedFiles: [] }
  let lastBuild: { ok: boolean; output: string } | null = null
  let gates: RebrandExecResult['gates']
  let screenshotPath: string | undefined
  while (round <= MAX_ROUNDS) {
    onProgress(`第 ${round} 轮改造…`)
    const prompt = round === 1
      ? buildInitialPrompt(slug, planPath, sourceDir)
      : buildRetryPrompt(sourceDir, lastBuild?.output ?? '')
    lastAgent = await opts.deps.runAgent(prompt, sourceDir)
    lastBuild = await opts.deps.runBuild(sourceDir)
    if (lastBuild === null) { status = 'no-buildscript'; break }
    if (lastBuild.ok) {
      status = 'done'
      gates = { build: true, start: false, health: false, screenshot: false }
      if (lastAgent.serverStarted && lastAgent.serverPort != null && opts.deps.waitForPort) {
        const port = lastAgent.serverPort
        gates.start = true
        onProgress('健康检查…')
        gates.health = await opts.deps.waitForPort(port, { timeoutMs: 15000 })
        if (gates.health && opts.deps.captureScreenshot) {
          onProgress('截图…')
          const shotAbs = path.join(projectDir, 'rebrand-exec-screenshot.png')
          gates.screenshot = await opts.deps.captureScreenshot(port, shotAbs)
          if (gates.screenshot) screenshotPath = path.join(slug, 'rebrand-exec-screenshot.png')
        }
        if (opts.deps.killByPort) await opts.deps.killByPort(port)
      }
      break
    }
    if (round === MAX_ROUNDS) { status = 'build-failed'; break }
    round++
  }

  const reportRel = path.join(slug, 'rebrand-exec-report.md')
  const report = renderReport({ slug, status, rounds: round, elapsedMs: Date.now() - startedAt, agent: lastAgent, build: lastBuild, gates })
  fs.writeFileSync(path.join(projectDir, 'rebrand-exec-report.md'), report, 'utf8')
  onProgress(`执行完成: ${status}（${round} 轮）`)

  return { status, rounds: round, reportPath: reportRel, gates, screenshotPath }
```

把 `renderReport` 函数签名和函数体：

```ts
function renderReport(input: {
  slug: string; status: RebrandExecResult['status']; rounds: number; elapsedMs: number
  agent: AgentResult; build: { ok: boolean; output: string } | null
}): string {
  const { slug, status, rounds, elapsedMs, agent, build } = input
  const lines = [
    `# ${slug} 换皮执行报告`,
    '',
    `- 状态：${status}`,
    `- 轮数：${rounds}`,
    `- 耗时：${Math.round(elapsedMs / 1000)}s`,
    `- 生成时间：${new Date().toISOString()}`,
    '',
    '## Agent 变更摘要',
    agent.summary || '（无）',
    '',
    '## 改动文件',
    ...(agent.changedFiles.length ? agent.changedFiles.map((f) => `- ${f}`) : ['（无）']),
  ]
  if (build && !build.ok) {
    lines.push('', '## 最后一次 build 输出', '```', build.output, '```')
  }
  return `${lines.join('\n')}\n`
}
```

改成：

```ts
function renderReport(input: {
  slug: string; status: RebrandExecResult['status']; rounds: number; elapsedMs: number
  agent: AgentResult; build: { ok: boolean; output: string } | null
  gates?: RebrandExecResult['gates']
}): string {
  const { slug, status, rounds, elapsedMs, agent, build, gates } = input
  const lines = [
    `# ${slug} 换皮执行报告`,
    '',
    `- 状态：${status}`,
    `- 轮数：${rounds}`,
    `- 耗时：${Math.round(elapsedMs / 1000)}s`,
    `- 生成时间：${new Date().toISOString()}`,
    '',
    '## Agent 变更摘要',
    agent.summary || '（无）',
    '',
    '## 改动文件',
    ...(agent.changedFiles.length ? agent.changedFiles.map((f) => `- ${f}`) : ['（无）']),
  ]
  if (gates) {
    const mark = (b: boolean) => (b ? '✅' : '❌')
    lines.push(
      '', '## 四关验收',
      `- 构建：${mark(gates.build)}`,
      `- 启动：${mark(gates.start)}`,
      `- 健康检查：${mark(gates.health)}`,
      `- 截图：${mark(gates.screenshot)}`,
    )
  }
  if (build && !build.ok) {
    lines.push('', '## 最后一次 build 输出', '```', build.output, '```')
  }
  return `${lines.join('\n')}\n`
}
```

最后，把 `rebrandExecAuto` 函数：

```ts
export function rebrandExecAuto(ctx: CoreCtx, slug: string, opts: { onProgress?: (msg: string) => void; fresh?: boolean } = {}): Promise<RebrandExecResult> {
  const deps: RebrandExecDeps = ctx.config.rebrandExec.mode === 'live'
    ? { clone: gitClone, runAgent: runClaudeHeadless, runBuild: detectAndRunBuild }
    : { clone: mockClone, runAgent: mockRunAgent, runBuild: mockRunBuild }
  return rebrandExec(ctx, slug, { ...opts, deps })
}
```

改成：

```ts
export function rebrandExecAuto(ctx: CoreCtx, slug: string, opts: { onProgress?: (msg: string) => void; fresh?: boolean } = {}): Promise<RebrandExecResult> {
  const deps: RebrandExecDeps = ctx.config.rebrandExec.mode === 'live'
    ? { clone: gitClone, runAgent: runClaudeHeadless, runBuild: detectAndRunBuild, waitForPort, captureScreenshot, killByPort }
    : { clone: mockClone, runAgent: mockRunAgent, runBuild: mockRunBuild, waitForPort: mockWaitForPort, captureScreenshot: mockCaptureScreenshot, killByPort: mockKillByPort }
  return rebrandExec(ctx, slug, { ...opts, deps })
}
```

**3c. Prompt 追加启动指令**：在 `buildInitialPrompt` 函数里，把：

```ts
    '改完后：',
    '1. 找到并运行这个项目自己的 build/lint/typecheck 命令自检，修到能过为止（如果确实没有可运行的验证命令，在 summary 里说明）',
    '2. 按给定的 JSON schema 输出最终结果',
```

改成：

```ts
    '改完后：',
    '1. 找到并运行这个项目自己的 build/lint/typecheck 命令自检，修到能过为止（如果确实没有可运行的验证命令，在 summary 里说明）',
    '2. 尝试把这个项目的服务启动起来（如 npm start / pnpm dev 等，后台运行不要阻塞），',
    '   如果确实启动成功，在结果里报告 serverStarted:true、serverPort、startCommand；',
    '   如果启动失败或这个项目本来就不是一个可独立运行的服务，报告 serverStarted:false，不用勉强。',
    '3. 按给定的 JSON schema 输出最终结果',
```

**3d. JSON schema 扩展**：在 `runClaudeHeadless` 函数里，把：

```ts
  const schema = JSON.stringify({
    type: 'object', required: ['status', 'summary', 'changedFiles'],
    properties: { status: { enum: ['done', 'blocked'] }, summary: { type: 'string' }, changedFiles: { type: 'array', items: { type: 'string' } } },
  })
```

改成：

```ts
  const schema = JSON.stringify({
    type: 'object', required: ['status', 'summary', 'changedFiles'],
    properties: {
      status: { enum: ['done', 'blocked'] },
      summary: { type: 'string' },
      changedFiles: { type: 'array', items: { type: 'string' } },
      serverStarted: { type: 'boolean' },
      serverPort: { type: 'number' },
      startCommand: { type: 'string' },
    },
  })
```

- [ ] **Step 4: 跑测试确认通过**

```bash
export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH"
cd /Users/lizhishaoniange/Documents/开源变现内容工厂
pnpm --filter @forgecast/rebrand test
```

预期：全部通过，包括本任务新增的 5 个用例**和**文件里原有的全部旧用例（旧用例一个字没改，必须继续绿）。

- [ ] **Step 5: 提交**

```bash
git add packages/rebrand/src/fixtures/rebrand-exec-fixture.ts packages/rebrand/src/rebrand-exec.ts packages/rebrand/test/rebrand-exec.test.ts
git commit -m "feat(rebrand): rebrandExec 整合四关——build 通过后按 agent 自报启动情况跑健康检查+截图+进程收尾"
```

---

### Task 5: `projects.rebrand_exec_result` 列（`packages/core`）

**Files:**
- Modify: `packages/core/src/db.ts`
- Test: `packages/core/test/db.test.ts`

- [ ] **Step 1: 写失败测试**

编辑 `packages/core/test/db.test.ts`，在已有 `it('candidates.source 列存在且默认 scout', ...)` 用例后面追加：

```ts
  it('projects.rebrand_exec_result 列存在，默认 NULL', () => {
    const db = openDb(tmpDbPath())
    db.prepare("INSERT INTO projects (slug) VALUES ('a')").run()
    const row = db.prepare("SELECT rebrand_exec_result FROM projects WHERE slug = 'a'").get() as any
    expect(row.rebrand_exec_result).toBeNull()
  })
```

- [ ] **Step 2: 跑测试确认失败**

```bash
export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH"
cd /Users/lizhishaoniange/Documents/开源变现内容工厂
pnpm --filter @forgecast/core test db.test
```

预期：`SqliteError: no such column: rebrand_exec_result`。

- [ ] **Step 3: 实现**

编辑 `packages/core/src/db.ts`，在迁移区末尾（`ensureColumn(db, 'candidates', 'source', "TEXT DEFAULT 'scout'")` 那一行后面）追加：

```ts
  // 迁移：换皮四关验收结果（JSON blob，同 candidates.score_detail 先例），供拆解页待验收/已完成区块读取
  ensureColumn(db, 'projects', 'rebrand_exec_result', 'TEXT')
```

- [ ] **Step 4: 跑测试确认通过**

```bash
pnpm --filter @forgecast/core test
```

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/db.ts packages/core/test/db.test.ts
git commit -m "feat(core): projects 加 rebrand_exec_result 列——存四关验收结果 JSON"
```

---

### Task 6: Server 路由 `POST /api/projects/:slug/rebrand-exec`

**Files:**
- Modify: `packages/server/src/app.ts`
- Test: `packages/server/test/rebrand-exec.test.ts`（新建）

**Interfaces:**
- Consumes：`rebrandExecAuto`（`@forgecast/rebrand`，已在 `app.ts` 顶部 import：`import { rebrandExecAuto, rebrandPlan } from '@forgecast/rebrand'`，本任务不用改 import）

- [ ] **Step 1: 写失败测试**

创建 `packages/server/test/rebrand-exec.test.ts`：

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
let root: string
function wait(ms: number) { return new Promise((r) => setTimeout(r, ms)) }

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-rbx-srv-'))
  const config = loadConfig(root, {})
  ctx = { db: openDb(config.paths.db), config, llm: createLlmClient(config.llm) }
  const info = ctx.db.prepare(
    "INSERT INTO candidates (repo, url, license_ok) VALUES ('o/demo', 'https://github.com/o/demo', 1)",
  ).run()
  ctx.db.prepare('INSERT INTO projects (slug, candidate_id) VALUES (?, ?)').run('demo', Number(info.lastInsertRowid))
  fs.mkdirSync(path.join(root, 'workspace/demo'), { recursive: true })
  fs.writeFileSync(path.join(root, 'workspace/demo/rebrand-plan.md'), '# demo 换皮改造清单\n## 1. 品牌替换\n- x')
  queue = createTaskQueue()
  app = createApp(ctx, queue)
})
async function runTask(taskId: string) {
  for (let i = 0; i < 200; i++) {
    await wait(50)
    const t = queue.get(taskId)!
    if (t.status === 'done') return
    if (t.status === 'failed') throw new Error(t.events.at(-1)!.message)
  }
  throw new Error('任务超时')
}

describe('rebrand-exec API (mock)', () => {
  it('POST rebrand-exec → 任务完成 → projects.rebrand_exec_result 写入 done 状态', async () => {
    const { taskId } = await (await app.request('/api/projects/demo/rebrand-exec', { method: 'POST' })).json() as any
    await runTask(taskId)
    const row: any = ctx.db.prepare("SELECT rebrand_exec_result FROM projects WHERE slug = 'demo'").get()
    expect(row.rebrand_exec_result).toBeTruthy()
    const result = JSON.parse(row.rebrand_exec_result)
    expect(result.status).toBe('done')
    expect(result.reportPath).toBe(path.join('demo', 'rebrand-exec-report.md'))
  })
  it('未知项目 → 404', async () => {
    expect((await app.request('/api/projects/nope/rebrand-exec', { method: 'POST' })).status).toBe(404)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH"
cd /Users/lizhishaoniange/Documents/开源变现内容工厂
pnpm --filter @forgecast/server test rebrand-exec.test
```

预期：第一个用例超时/404（路由不存在）。

- [ ] **Step 3: 实现**

编辑 `packages/server/src/app.ts`，在现有 `app.post('/api/projects/:slug/rebrand', ...)` 路由块（`})`）后面追加：

```ts
  app.post('/api/projects/:slug/rebrand-exec', async (c) => {
    const slug = c.req.param('slug')
    if (!ctx.db.prepare('SELECT id FROM projects WHERE slug = ?').get(slug)) return c.json({ error: '项目不存在' }, 404)
    const taskId = queue.enqueue(async (log) => {
      const result = await rebrandExecAuto(ctx, slug, { onProgress: log })
      ctx.db.prepare('UPDATE projects SET rebrand_exec_result = ? WHERE slug = ?').run(JSON.stringify(result), slug)
      return result
    })
    return c.json({ taskId })
  })
```

- [ ] **Step 4: 跑测试确认通过**

```bash
pnpm --filter @forgecast/server test
```

预期：全部通过，包括本任务新文件和既有全部测试。

- [ ] **Step 5: 提交**

```bash
git add packages/server/src/app.ts packages/server/test/rebrand-exec.test.ts
git commit -m "feat(server): 加 POST /api/projects/:slug/rebrand-exec 路由——跑四关验收并写回 rebrand_exec_result"
```

---

### Task 7: 前端类型 + 项目详情抽屉触发按钮

**Files:**
- Modify: `apps/web/src/api.ts`
- Modify: `apps/web/src/drawers/ProjectDrawer.tsx`

本任务无自动化测试，验证靠 `tsc --noEmit` + Task 9 统一做浏览器验证。

- [ ] **Step 1: 加类型字段**

编辑 `apps/web/src/api.ts`，在 `Project` interface 的 `score_detail: string | null` 那一行后面加一行：

```ts
  rebrand_exec_result: string | null
```

- [ ] **Step 2: 加触发按钮**

编辑 `apps/web/src/drawers/ProjectDrawer.tsx`：

在 `useState` 声明区（`const [screensLog, setScreensLog] = useState<string[]>([])` 那一行后面）加两行：

```tsx
  const [execRunning, setExecRunning] = useState(false)
  const [execLog, setExecLog] = useState<string[]>([])
```

在 `rebrand` 函数定义后面（`generateScreens` 函数前面）加一个新函数：

```tsx
  async function runExec() {
    if (execRunning) return
    setExecRunning(true)
    setExecLog([])
    try {
      const { taskId } = await api<{ taskId: string }>(`/api/projects/${slug}/rebrand-exec`, { method: 'POST' })
      subscribeTask(taskId, (e) => {
        setExecLog((l) => [...l, `${e.type === 'error' ? '❌ ' : ''}${e.message}`])
        if (e.type === 'done' || e.type === 'error') {
          setExecRunning(false)
          qc.invalidateQueries({ queryKey: ['project', slug] })
          qc.invalidateQueries({ queryKey: ['projects'] })
        }
      })
    } catch (err) {
      setExecLog((l) => [...l, `❌ ${err instanceof Error ? err.message : String(err)}`])
      setExecRunning(false)
    }
  }
```

在 JSX 里，找到"换皮"tab 那个按钮块：

```tsx
              <>
                <button className="btn-fire px-3 py-1 text-sm disabled:opacity-50"
                  disabled={rebranding || !p.analysisMd} onClick={rebrand}>
                  {rebranding ? '生成中…' : (p.rebrandMd ? '重新生成换皮清单' : '生成换皮清单')}
                </button>
                <span className="text-xs text-faint">
                  {p.analysisMd ? '读 analysis.md 生成可执行 checklist' : '先在「分析」tab 生成分析报告'}
                </span>
              </>
```

改成：

```tsx
              <>
                <button className="btn-fire px-3 py-1 text-sm disabled:opacity-50"
                  disabled={rebranding || !p.analysisMd} onClick={rebrand}>
                  {rebranding ? '生成中…' : (p.rebrandMd ? '重新生成换皮清单' : '生成换皮清单')}
                </button>
                <button className="btn-ink px-3 py-1 text-sm disabled:opacity-50"
                  disabled={execRunning || !p.rebrandMd} onClick={runExec}>
                  {execRunning ? '验收中…' : '跑验收（构建+启动+健康检查+截图）'}
                </button>
                <span className="text-xs text-faint">
                  {p.analysisMd ? '读 analysis.md 生成可执行 checklist' : '先在「分析」tab 生成分析报告'}
                </span>
              </>
```

在 `docTab === 'analysis'` 分支渲染区块的合适位置（紧跟在 `rebrandLog.length > 0` 那个日志块后面，或者复用同样的展示逻辑）加一段执行日志展示——找到：

```tsx
            {rebrandLog.length > 0 && (
              <div className="mb-3 rounded bg-neutral-900 p-2 text-xs text-green-400 font-mono max-h-32 overflow-y-auto space-y-1">
                {rebrandLog.map((l, i) => <div key={i}>{l}</div>)}
              </div>
            )}
```

在这个块后面加：

```tsx
            {execLog.length > 0 && (
              <div className="mb-3 rounded bg-neutral-900 p-2 text-xs text-green-400 font-mono max-h-32 overflow-y-auto space-y-1">
                {execLog.map((l, i) => <div key={i}>{l}</div>)}
              </div>
            )}
```

- [ ] **Step 3: 验证**

```bash
export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH"
cd /Users/lizhishaoniange/Documents/开源变现内容工厂
pnpm --filter web exec tsc --noEmit
```

预期无输出。

- [ ] **Step 4: 提交**

```bash
git add apps/web/src/api.ts apps/web/src/drawers/ProjectDrawer.tsx
git commit -m "feat(web): 项目详情抽屉加「跑验收」按钮——触发四关验收任务"
```

---

### Task 8: "拆解"页新增待验收/已完成区块

**Files:**
- Create: `apps/web/src/pages/board/AcceptanceSection.tsx`
- Modify: `apps/web/src/pages/ProjectsPage.tsx`

**Interfaces:**
- Produces：`export default function AcceptanceSection(props: { projects: Project[]; onOpenProject: (slug: string) => void; onAdvance: (slug: string) => void })`

- [ ] **Step 1: 新建 `AcceptanceSection.tsx`**

创建 `apps/web/src/pages/board/AcceptanceSection.tsx`：

```tsx
import type { Project } from '../../api'

interface ExecResult {
  status: string
  rounds: number
  reportPath: string
  gates?: { build: boolean; start: boolean; health: boolean; screenshot: boolean }
  screenshotPath?: string
}

/** rebrand_exec_result 是我们自己写入的 JSON，不是 LLM 输出——解析失败按"没跑过"处理即可，不用逐字段兜底。 */
function parseExecResult(raw: string | null): ExecResult | null {
  if (!raw) return null
  try { return JSON.parse(raw) as ExecResult } catch { return null }
}

function GateDot({ label, ok, buildFailed }: { label: string; ok: boolean; buildFailed?: boolean }) {
  const color = buildFailed ? 'bg-fire' : ok ? 'bg-green-600' : 'bg-hairline-strong'
  return <i title={label} className={`inline-block h-2.5 w-2.5 rounded-full ${color}`} />
}

/** "拆解"页新增区块：待验收（stage=rebranding 且跑过四关）/ 已完成（stage 更靠后且跑过四关）。
 *  不改 ProjectGroups.tsx 本身，只读同一份 projects 数据换个角度展示。 */
export default function AcceptanceSection({ projects, onOpenProject, onAdvance }: {
  projects: Project[]
  onOpenProject: (slug: string) => void
  onAdvance: (slug: string) => void
}) {
  const withExec = projects
    .map((p) => ({ p, exec: parseExecResult(p.rebrand_exec_result) }))
    .filter((x): x is { p: Project; exec: ExecResult } => x.exec !== null)

  const pending = withExec.filter((x) => x.p.stage === 'rebranding')
  const done = withExec.filter((x) => ['producing', 'publishing', 'selling'].includes(x.p.stage))

  if (withExec.length === 0) return null

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <section className="card p-4">
        <h3 className="mb-2 flex items-center gap-2 font-bold">
          待验收 <span className="stamp pending" style={{ width: 40, height: 40, fontSize: '0.6rem' }}>待验</span>
        </h3>
        {pending.length === 0 && <div className="text-sm text-faint">暂无</div>}
        {pending.map(({ p, exec }) => {
          const buildFailed = exec.status === 'build-failed'
          return (
            <div key={p.slug} className="mb-2 flex items-center gap-3 rounded border border-hairline bg-paper p-3 text-sm">
              <div className="flex gap-1.5" title="构建 / 启动 / 健康检查 / 截图">
                <GateDot label="构建" ok={exec.gates?.build ?? false} buildFailed={buildFailed} />
                <GateDot label="启动" ok={exec.gates?.start ?? false} />
                <GateDot label="健康检查" ok={exec.gates?.health ?? false} />
                <GateDot label="截图" ok={exec.gates?.screenshot ?? false} />
              </div>
              <div className="flex-1">
                <b>{p.brand_name || p.slug}</b>
                <span className="ml-2 text-xs text-faint">{exec.status}（{exec.rounds} 轮）</span>
              </div>
              <button className="btn-ink px-3 py-1 text-xs" onClick={() => onOpenProject(p.slug)}>查看报告</button>
              <button className="btn-fire px-3 py-1 text-xs" onClick={() => onAdvance(p.slug)}>验收通过</button>
            </div>
          )
        })}
      </section>

      <section className="card p-4">
        <h3 className="mb-2 flex items-center gap-2 font-bold">
          已完成 <span className="stamp" style={{ width: 40, height: 40, fontSize: '0.6rem' }}>验讫</span>
        </h3>
        {done.length === 0 && <div className="text-sm text-faint">暂无</div>}
        {done.map(({ p }) => (
          <div key={p.slug} className="mb-2 flex items-center gap-3 rounded border border-hairline bg-paper p-3 text-sm">
            <div className="flex-1">
              <b>{p.brand_name || p.slug}</b>
              <span className="ml-2 text-xs text-faint">workspace/{p.slug}/source-full/</span>
            </div>
            <button className="btn-ink px-3 py-1 text-xs" onClick={() => onOpenProject(p.slug)}>查看报告</button>
            {p.demo_url && <a className="btn-ink px-3 py-1 text-xs" href={p.demo_url} target="_blank" rel="noreferrer">打开演示站</a>}
          </div>
        ))}
      </section>
    </div>
  )
}
```

- [ ] **Step 2: 编辑 `ProjectsPage.tsx`**

在 import 区加一行：

```tsx
import AcceptanceSection from './board/AcceptanceSection'
```

在 `<ProjectGroups .../>` 后面（`</div>` 闭合标签之前）加：

```tsx
      <AcceptanceSection
        projects={projects.data ?? []}
        onOpenProject={onOpenProject}
        onAdvance={(slug) => moveStage.mutate({ slug, stage: 'producing' })}
      />
```

- [ ] **Step 3: 验证**

```bash
export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH"
cd /Users/lizhishaoniange/Documents/开源变现内容工厂
pnpm --filter web exec tsc --noEmit
```

预期无输出。

浏览器手动验证（复用之前 session 建立的流程：dev server 起在 `5173`/`5174`）：
1. 找一个已经跑过 `forgecast rebrand <slug>`（生成了 rebrand-plan.md）的项目，进它的详情抽屉，点"跑验收"；
2. mock 模式下几秒内跑完，回到"拆解"页应该在"待验收"区块看到这个项目，四个圆点应该全绿（mock 全部返回成功）；
3. 点"验收通过"，项目从"待验收"消失，出现在"已完成"（因为 stage 被推到了 producing）；
4. 没有 `demo_url` 的项目"已完成"卡片里不显示"打开演示站"按钮，这是正确行为。

- [ ] **Step 4: 提交**

```bash
git add apps/web/src/pages/board/AcceptanceSection.tsx apps/web/src/pages/ProjectsPage.tsx
git commit -m "feat(web): 拆解页加待验收/已完成区块——四关灯+验收通过按钮，不改现有泳道"
```

---

### Task 9: 全量回归

**Files:** 无改动，纯验证

- [ ] **Step 1: 全量测试**

```bash
export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH"
cd /Users/lizhishaoniange/Documents/开源变现内容工厂
pnpm test 2>&1 | grep -E "Test Files|Tests |FAIL"
```

预期：全绿，`packages/rebrand` 测试数比 Task 1 开始前明显增加（新增 3 个测试文件+若干用例），`packages/core`/`packages/server` 各多 1-2 个用例，其余包数量不变。

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
