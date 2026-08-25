# 换皮自动执行（rebrand-exec）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增 `forgecast rebrand-exec <slug>` 命令：clone 开源项目源码 → 无头 Claude Code 按 `rebrand-plan.md` 品牌层清单（1品牌替换/2删除项/3中文化）自动改代码 → 跑 build 验证失败自动重试（≤3轮）→ 出报告。

**Architecture:** 新文件都落在既有 `packages/rebrand` 包内，延续它"读输入 → mock/live 分支 → 写产物文件"的既有结构（参照 `rebrand.ts`）。核心状态机 `rebrandExec()` 全部依赖通过 `deps` 参数注入（`clone`/`runAgent`/`runBuild`），单测不碰真实网络/子进程；`mock` 模式下的默认 deps 走固定 fixture，`live` 模式下的默认 deps 才是真实 `git clone` / `spawn claude` / 检测并跑项目 build 脚本。

**Tech Stack:** Node 22 + TypeScript，`node:child_process` spawn，vitest。

**Spec:** `docs/superpowers/specs/2026-08-26-rebrand-exec-design.md`

## Global Constraints

- 新增子命令跟现有 `rebrand`/`analyze` CLI 命令保持同样风格：`onProgress` 回调打印进度，异常直接 throw 给 CLI 顶层捕获。
- 所有子进程调用都要有超时（沿用项目里"卡死进程不能挂住任务队列"的既有原则），超时值可用环境变量覆盖。
- mock 模式（默认）下不允许发起任何真实网络请求或 spawn 真实 `git`/`claude` 子进程——CI 跑不了这些。
- `deps` 全部可选注入点：不传时用真实（live）实现；测试永远显式传 fake `deps`，不依赖全局 mock 模式去绕过子进程。
- 报错信息要含义清晰、可定位（照抄现有 `rebrand.ts` 风格：`项目不存在: ${slug}`、`缺少 xxx: ${path}`）。
- README.md 要在本 plan 完成后同步更新（新增 CLI 命令说明 + 新环境变量行），这是收尾任务，不单独起一个 task。

---

### Task 1: Config 新增 `rebrandExec.mode` 开关

**Files:**
- Modify: `packages/core/src/config.ts`
- Test: `packages/core/test/config.test.ts`

**Interfaces:**
- Produces: `ForgecastConfig.rebrandExec: { mode: 'mock' | 'live' }`，`export type RebrandExecMode = 'mock' | 'live'`（后续任务从 `@forgecast/core` import 这个类型和 `config.rebrandExec.mode`）

- [ ] **Step 1: 写失败测试**

在 `packages/core/test/config.test.ts` 里找到现有 `video.mode` 相关的 `describe`/`it` 块（约第 44 行 `loadConfig('/tmp/x', { FORGECAST_VIDEO_MODE: 'stub' })...`），紧邻着加两个新用例：

```ts
  it('FORGECAST_REBRAND_EXEC_MODE 未设置或非 live → 默认 mock', () => {
    expect(loadConfig('/tmp/x', {}).rebrandExec).toEqual({ mode: 'mock' })
    expect(loadConfig('/tmp/x', { FORGECAST_REBRAND_EXEC_MODE: 'whatever' }).rebrandExec).toEqual({ mode: 'mock' })
  })
  it('FORGECAST_REBRAND_EXEC_MODE=live → live', () => {
    expect(loadConfig('/tmp/x', { FORGECAST_REBRAND_EXEC_MODE: 'live' }).rebrandExec).toEqual({ mode: 'live' })
  })
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm --filter @forgecast/core test
```

预期：新增的两个用例失败，报错是 `rebrandExec` 为 `undefined`（因为 `ForgecastConfig` 还没有这个字段），不是别的语法错误。

- [ ] **Step 3: 实现**

`packages/core/src/config.ts`：

在 `export type VideoMode = ...` 那几行类型声明旁边加：

```ts
export type RebrandExecMode = 'mock' | 'live'
```

在 `ForgecastConfig` interface 里，`video: {...}` 那一行后面加一行：

```ts
  rebrandExec: { mode: RebrandExecMode }
```

在 `loadConfig` 函数体里，`const videoMode: VideoMode = ...` 那一行旁边加：

```ts
  const rebrandExecMode: RebrandExecMode = env.FORGECAST_REBRAND_EXEC_MODE === 'live' ? 'live' : 'mock'
```

在返回对象里，`video: {...}` 那个字段块后面加：

```ts
    rebrandExec: { mode: rebrandExecMode },
```

- [ ] **Step 4: 跑测试确认通过**

```bash
pnpm --filter @forgecast/core test
```

预期：全部通过，包括新增的 2 个用例。

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/config.ts packages/core/test/config.test.ts
git commit -m "feat(core): 加 rebrandExec.mode 配置开关（FORGECAST_REBRAND_EXEC_MODE）"
```

---

### Task 2: `spawnCapture` 子进程工具（完整捕获 stdout/stderr）

**Files:**
- Create: `packages/rebrand/src/spawn-capture.ts`
- Test: `packages/rebrand/test/spawn-capture.test.ts`

**Interfaces:**
- Produces: `export function spawnCapture(cmd: string, args: string[], opts: { cwd?: string; timeoutMs: number; label: string }): Promise<{ code: number; stdout: string; stderr: string }>`——跟 `studio/hyperframes.ts` 的 `spawnWithTimeout` 不同：永远 resolve（不因非 0 退出码 reject），把完整 stdout/stderr 都收集返回；只有 spawn 本身报错（如命令不存在）或超时才 reject。

- [ ] **Step 1: 写失败测试**

创建 `packages/rebrand/test/spawn-capture.test.ts`：

```ts
import { describe, expect, it } from 'vitest'
import { spawnCapture } from '../src/spawn-capture'

describe('spawnCapture', () => {
  it('退出码 0：resolve 完整 stdout', async () => {
    const r = await spawnCapture('node', ['-e', 'console.log("hello")'], { timeoutMs: 5000, label: 'test' })
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('hello')
  })
  it('非 0 退出码：仍 resolve（不 reject），code/stderr 如实返回', async () => {
    const r = await spawnCapture('node', ['-e', 'console.error("boom"); process.exit(2)'], { timeoutMs: 5000, label: 'test' })
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('boom')
  })
  it('超时：kill 进程并 reject', async () => {
    await expect(
      spawnCapture('node', ['-e', 'setTimeout(() => {}, 10000)'], { timeoutMs: 200, label: 'slow' }),
    ).rejects.toThrow(/slow.*超时/)
  })
  it('命令不存在：reject', async () => {
    await expect(
      spawnCapture('__forgecast_no_such_cmd__', [], { timeoutMs: 2000, label: 'missing' }),
    ).rejects.toThrow()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm --filter @forgecast/rebrand test spawn-capture
```

预期：`Cannot find module '../src/spawn-capture'`（文件还不存在）。

- [ ] **Step 3: 实现**

创建 `packages/rebrand/src/spawn-capture.ts`：

```ts
import { spawn } from 'node:child_process'

/** 带超时的 spawn，完整捕获 stdout/stderr，非 0 退出码不 reject（调用方自己判断 code）。 */
export function spawnCapture(
  cmd: string,
  args: string[],
  opts: { cwd?: string; timeoutMs: number; label: string },
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      settled = true
      p.kill('SIGKILL')
      reject(new Error(`${opts.label} 超时（${opts.timeoutMs}ms）已终止`))
    }, opts.timeoutMs)
    p.stdout.on('data', (d) => { stdout += d.toString() })
    p.stderr.on('data', (d) => { stderr += d.toString() })
    p.on('error', (e) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(e)
    })
    p.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code: code ?? -1, stdout, stderr })
    })
  })
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
pnpm --filter @forgecast/rebrand test spawn-capture
```

预期：4 个用例全过。

- [ ] **Step 5: 提交**

```bash
git add packages/rebrand/src/spawn-capture.ts packages/rebrand/test/spawn-capture.test.ts
git commit -m "feat(rebrand): 加 spawnCapture——完整捕获 stdout/stderr 的子进程工具"
```

---

### Task 3: mock 模式 fixture deps（clone/runAgent/runBuild）

**Files:**
- Create: `packages/rebrand/src/fixtures/rebrand-exec-fixture.ts`
- Test: `packages/rebrand/test/rebrand-exec-fixture.test.ts`

**Interfaces:**
- Consumes: 无（纯文件系统操作 + 固定返回值，不依赖 Task 1/2 的产物）
- Produces:
  - `export interface AgentResult { status: 'done' | 'blocked'; summary: string; changedFiles: string[] }`
  - `export function mockClone(url: string, dir: string): Promise<void>`——在 `dir` 下写一个占位 `package.json`（`{"name":"original-project","scripts":{"build":"echo ok"}}`）和一个占位 `README.md`，模拟"clone 完成"
  - `export function mockRunAgent(prompt: string, cwd: string): Promise<AgentResult>`——把 `cwd` 下 `package.json` 里的 `name` 字段改成 `"rebranded"`（模拟品牌替换），返回 `{ status: 'done', summary: '已完成品牌替换/删除项/中文化（mock）', changedFiles: ['package.json'] }`
  - `export function mockRunBuild(cwd: string): Promise<{ ok: boolean; output: string }>`——固定返回 `{ ok: true, output: 'mock build ok' }`

- [ ] **Step 1: 写失败测试**

创建 `packages/rebrand/test/rebrand-exec-fixture.test.ts`：

```ts
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { mockClone, mockRunAgent, mockRunBuild } from '../src/fixtures/rebrand-exec-fixture'

let dir: string
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-rbx-fix-')) })

describe('mockClone', () => {
  it('写占位 package.json + README.md，不发真实请求', async () => {
    await mockClone('https://github.com/x/y', dir)
    expect(fs.existsSync(path.join(dir, 'package.json'))).toBe(true)
    expect(fs.existsSync(path.join(dir, 'README.md'))).toBe(true)
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
    expect(pkg.name).toBe('original-project')
    expect(pkg.scripts.build).toBeTruthy()
  })
})

describe('mockRunAgent', () => {
  it('把 package.json name 改成 rebranded，返回 done 状态', async () => {
    await mockClone('https://github.com/x/y', dir)
    const result = await mockRunAgent('随便什么 prompt', dir)
    expect(result.status).toBe('done')
    expect(result.changedFiles).toContain('package.json')
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
    expect(pkg.name).toBe('rebranded')
  })
})

describe('mockRunBuild', () => {
  it('固定返回 ok:true', async () => {
    const r = await mockRunBuild(dir)
    expect(r.ok).toBe(true)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm --filter @forgecast/rebrand test rebrand-exec-fixture
```

预期：`Cannot find module '../src/fixtures/rebrand-exec-fixture'`。

- [ ] **Step 3: 实现**

创建 `packages/rebrand/src/fixtures/rebrand-exec-fixture.ts`：

```ts
import fs from 'node:fs'
import path from 'node:path'

/** 换皮执行 agent 的最终结构化结果（真实实现来自 claude --json-schema 输出，mock 版本手写固定值）。 */
export interface AgentResult { status: 'done' | 'blocked'; summary: string; changedFiles: string[] }

/** mock clone：不发真实网络请求，落一个占位 package.json + README.md 模拟"已 clone"。 */
export async function mockClone(_url: string, dir: string): Promise<void> {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'original-project', scripts: { build: 'echo ok' } }, null, 2),
    'utf8',
  )
  fs.writeFileSync(path.join(dir, 'README.md'), '# original-project\n', 'utf8')
}

/** mock agent：不调真实 claude，直接把 package.json.name 改成 rebranded 模拟品牌替换。 */
export async function mockRunAgent(_prompt: string, cwd: string): Promise<AgentResult> {
  const pkgPath = path.join(cwd, 'package.json')
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
  pkg.name = 'rebranded'
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2), 'utf8')
  return { status: 'done', summary: '已完成品牌替换/删除项/中文化（mock）', changedFiles: ['package.json'] }
}

/** mock build：固定通过，不真的跑 npm/pnpm。 */
export async function mockRunBuild(_cwd: string): Promise<{ ok: boolean; output: string }> {
  return { ok: true, output: 'mock build ok' }
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
pnpm --filter @forgecast/rebrand test rebrand-exec-fixture
```

- [ ] **Step 5: 提交**

```bash
git add packages/rebrand/src/fixtures/rebrand-exec-fixture.ts packages/rebrand/test/rebrand-exec-fixture.test.ts
git commit -m "feat(rebrand): rebrand-exec mock fixture（clone/agent/build 三个占位 deps）"
```

---

### Task 4: `detectAndRunBuild`——检测项目 build 脚本并跑（live 默认 runBuild）

**Files:**
- Create: `packages/rebrand/src/detect-build.ts`
- Test: `packages/rebrand/test/detect-build.test.ts`

**Interfaces:**
- Consumes: `spawnCapture` (Task 2, `../src/spawn-capture`)
- Produces: `export function detectAndRunBuild(cwd: string, opts?: { run?: typeof spawnCapture }): Promise<{ ok: boolean; output: string } | null>`——`null` 表示"没找到可跑的 build/typecheck/lint 脚本，跳过外层验证"；`opts.run` 是测试注入点，默认用真实 `spawnCapture`

**逻辑：**
1. `cwd` 下没有 `package.json` → 返回 `null`
2. 有 `package.json` 但 `scripts` 里没有 `build`/`typecheck`/`lint` 任何一个 → 返回 `null`
3. 按 `build` → `typecheck` → `lint` 顺序取第一个存在的 script 名
4. 按 `pnpm-lock.yaml`/`yarn.lock`/都没有 三选一判定包管理器（pnpm/yarn/npm）
5. `cwd` 下没有 `node_modules` → 先跑 `<pm> install`（用注入的 `run`，超时 300000ms）
6. 跑 `<pm> run <script>`（用注入的 `run`，超时 300000ms），返回 `{ ok: code===0, output: (stdout+stderr).slice(0,4000) }`

- [ ] **Step 1: 写失败测试**

创建 `packages/rebrand/test/detect-build.test.ts`：

```ts
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { detectAndRunBuild } from '../src/detect-build'

let dir: string
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-rbx-build-')) })

describe('detectAndRunBuild', () => {
  it('无 package.json → null', async () => {
    expect(await detectAndRunBuild(dir)).toBeNull()
  })
  it('有 package.json 但无 build/typecheck/lint script → null', async () => {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', scripts: { start: 'x' } }))
    expect(await detectAndRunBuild(dir)).toBeNull()
  })
  it('有 build script + node_modules 已存在 → 只跑 build，不跑 install', async () => {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', scripts: { build: 'echo hi' } }))
    fs.mkdirSync(path.join(dir, 'node_modules'))
    const run = vi.fn(async (cmd: string, args: string[]) => ({ code: 0, stdout: 'built', stderr: '' }))
    const r = await detectAndRunBuild(dir, { run: run as any })
    expect(r).toEqual({ ok: true, output: 'built' })
    expect(run).toHaveBeenCalledTimes(1)
    expect(run).toHaveBeenCalledWith('npm', ['run', 'build'], expect.objectContaining({ cwd: dir }))
  })
  it('无 node_modules → 先 install 再跑 build', async () => {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', scripts: { build: 'echo hi' } }))
    const calls: string[] = []
    const run = vi.fn(async (cmd: string, args: string[]) => { calls.push(`${cmd} ${args.join(' ')}`); return { code: 0, stdout: '', stderr: '' } })
    await detectAndRunBuild(dir, { run: run as any })
    expect(calls).toEqual(['npm install', 'npm run build'])
  })
  it('有 pnpm-lock.yaml → 用 pnpm', async () => {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', scripts: { build: 'echo hi' } }))
    fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), '')
    fs.mkdirSync(path.join(dir, 'node_modules'))
    const run = vi.fn(async () => ({ code: 0, stdout: '', stderr: '' }))
    await detectAndRunBuild(dir, { run: run as any })
    expect(run).toHaveBeenCalledWith('pnpm', ['run', 'build'], expect.anything())
  })
  it('非 0 退出码 → ok:false，output 含 stderr', async () => {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', scripts: { build: 'exit 1' } }))
    fs.mkdirSync(path.join(dir, 'node_modules'))
    const run = vi.fn(async () => ({ code: 1, stdout: '', stderr: 'type error at line 5' }))
    const r = await detectAndRunBuild(dir, { run: run as any })
    expect(r).toEqual({ ok: false, output: 'type error at line 5' })
  })
  it('没有 build 但有 typecheck → 用 typecheck', async () => {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', scripts: { typecheck: 'tsc' } }))
    fs.mkdirSync(path.join(dir, 'node_modules'))
    const run = vi.fn(async () => ({ code: 0, stdout: '', stderr: '' }))
    await detectAndRunBuild(dir, { run: run as any })
    expect(run).toHaveBeenCalledWith('npm', ['run', 'typecheck'], expect.anything())
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm --filter @forgecast/rebrand test detect-build
```

预期：`Cannot find module '../src/detect-build'`。

- [ ] **Step 3: 实现**

创建 `packages/rebrand/src/detect-build.ts`：

```ts
import fs from 'node:fs'
import path from 'node:path'
import { spawnCapture } from './spawn-capture'

const BUILD_TIMEOUT_MS = 300_000

/** 检测项目自带的 build/typecheck/lint 脚本并跑；找不到可跑脚本返回 null（外层调用方视为"跳过验证"）。 */
export async function detectAndRunBuild(
  cwd: string,
  opts: { run?: typeof spawnCapture } = {},
): Promise<{ ok: boolean; output: string } | null> {
  const run = opts.run ?? spawnCapture
  const pkgPath = path.join(cwd, 'package.json')
  if (!fs.existsSync(pkgPath)) return null

  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
  const script = ['build', 'typecheck', 'lint'].find((s) => pkg.scripts?.[s])
  if (!script) return null

  const pm = fs.existsSync(path.join(cwd, 'pnpm-lock.yaml')) ? 'pnpm'
    : fs.existsSync(path.join(cwd, 'yarn.lock')) ? 'yarn'
    : 'npm'

  if (!fs.existsSync(path.join(cwd, 'node_modules'))) {
    await run(pm, ['install'], { cwd, timeoutMs: BUILD_TIMEOUT_MS, label: `${pm} install` })
  }

  const { code, stdout, stderr } = await run(pm, ['run', script], { cwd, timeoutMs: BUILD_TIMEOUT_MS, label: `${pm} run ${script}` })
  return { ok: code === 0, output: (stdout + stderr).slice(0, 4000) }
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
pnpm --filter @forgecast/rebrand test detect-build
```

- [ ] **Step 5: 提交**

```bash
git add packages/rebrand/src/detect-build.ts packages/rebrand/test/detect-build.test.ts
git commit -m "feat(rebrand): detectAndRunBuild——自动识别 pnpm/yarn/npm + build/typecheck/lint 脚本并跑"
```

---

### Task 5: 核心状态机 `rebrandExec`（precheck + clone-or-skip + 重试循环 + 报告）

**Files:**
- Create: `packages/rebrand/src/rebrand-exec.ts`
- Test: `packages/rebrand/test/rebrand-exec.test.ts`

**Interfaces:**
- Consumes:
  - `AgentResult` from `./fixtures/rebrand-exec-fixture`（Task 3）
  - `CoreCtx` from `@forgecast/core`（已有）
- Produces:
  - `export interface RebrandExecOptions { onProgress?: (msg: string) => void; fresh?: boolean; deps?: { clone?: (url: string, dir: string) => Promise<void>; runAgent?: (prompt: string, cwd: string) => Promise<AgentResult>; runBuild?: (cwd: string) => Promise<{ ok: boolean; output: string } | null> } }`
  - `export interface RebrandExecResult { status: 'done' | 'build-failed' | 'no-buildscript'; rounds: number; reportPath: string }`
  - `export async function rebrandExec(ctx: CoreCtx, slug: string, opts?: RebrandExecOptions): Promise<RebrandExecResult>`

本任务**只用注入的 `deps`**，不接真实 clone/claude/build（那是 Task 6）。三个 `deps` 字段在本任务里是**必需**语义上可选、但真正跑到会抛错的占位——测试永远显式传全部三个 fake。

**核心逻辑：**
1. `workspace/<slug>/rebrand-plan.md` 不存在 → `throw new Error('先跑 forgecast rebrand ' + slug + ' 生成改造清单')`
2. `projects` 表查不到 `candidate_id` 对应的 `candidates.url` → `throw new Error('项目 ' + slug + ' 缺少候选来源，无法获取仓库地址')`
3. `workspace/<slug>/source-full/` 已存在且 `!opts.fresh` → 跳过 clone，`onProgress('复用已有 clone: source-full/')`；否则调 `deps.clone(url, dir)`
4. 循环 `round = 1..3`：
   - `deps.runAgent(prompt, dir)` 拿 `AgentResult`
   - `deps.runBuild(dir)` 拿 `build`
   - `build === null` → `status = 'no-buildscript'`，跳出循环（不重试）
   - `build.ok` → `status = 'done'`，跳出循环
   - 否则：`round === 3` → `status = 'build-failed'`，跳出循环；否则 `round++` 继续（下一轮 prompt 要带上 `build.output`，但本任务只需保证"重试确实发生"，prompt 具体文案在 Task 6 通过真实 `runAgent` 默认实现体现——本任务的 fake `runAgent` 不需要真的读 prompt 内容）
5. 写报告到 `workspace/<slug>/rebrand-exec-report.md`，内容含状态/轮数/耗时/agent summary/changedFiles/build.output（如有）
6. 返回 `{ status, rounds: round, reportPath }`

- [ ] **Step 1: 写失败测试**

创建 `packages/rebrand/test/rebrand-exec.test.ts`：

```ts
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadConfig, openDb, type CoreCtx } from '@forgecast/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentResult } from '../src/fixtures/rebrand-exec-fixture'
import { rebrandExec } from '../src/rebrand-exec'

let ctx: CoreCtx
let root: string

function seedProject(slug: string, opts: { withPlan?: boolean; withCandidate?: boolean } = {}) {
  const { withPlan = true, withCandidate = true } = opts
  let candidateId: number | null = null
  if (withCandidate) {
    const info = ctx.db.prepare(
      "INSERT INTO candidates (repo, url, license_ok) VALUES (?, ?, 1)",
    ).run(`owner/${slug}`, `https://github.com/owner/${slug}`)
    candidateId = Number(info.lastInsertRowid)
  }
  ctx.db.prepare('INSERT INTO projects (slug, candidate_id) VALUES (?, ?)').run(slug, candidateId)
  const dir = path.join(root, 'workspace', slug)
  fs.mkdirSync(dir, { recursive: true })
  if (withPlan) fs.writeFileSync(path.join(dir, 'rebrand-plan.md'), '# demo 换皮改造清单\n## 1. 品牌替换\n- x')
}

function ok(): AgentResult { return { status: 'done', summary: '改完了', changedFiles: ['a.ts'] } }

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-rbx-'))
  const config = loadConfig(root, {})
  ctx = { db: openDb(config.paths.db), config, llm: null as any }
})

describe('rebrandExec 前置检查', () => {
  it('无 rebrand-plan.md → 抛错', async () => {
    seedProject('demo', { withPlan: false })
    await expect(rebrandExec(ctx, 'demo', { deps: { clone: vi.fn(), runAgent: vi.fn(), runBuild: vi.fn() } }))
      .rejects.toThrow(/先跑 forgecast rebrand/)
  })
  it('项目无关联 candidate（拿不到仓库地址）→ 抛错', async () => {
    seedProject('demo', { withCandidate: false })
    await expect(rebrandExec(ctx, 'demo', { deps: { clone: vi.fn(), runAgent: vi.fn(), runBuild: vi.fn() } }))
      .rejects.toThrow(/缺少候选来源/)
  })
})

describe('rebrandExec clone 幂等', () => {
  it('source-full/ 已存在且未传 fresh → 不调 clone', async () => {
    seedProject('demo')
    fs.mkdirSync(path.join(root, 'workspace', 'demo', 'source-full'), { recursive: true })
    const clone = vi.fn(async () => {})
    const runAgent = vi.fn(async () => ok())
    const runBuild = vi.fn(async () => ({ ok: true, output: '' }))
    await rebrandExec(ctx, 'demo', { deps: { clone, runAgent, runBuild } })
    expect(clone).not.toHaveBeenCalled()
  })
  it('--fresh → 即使已存在也重新 clone', async () => {
    seedProject('demo')
    fs.mkdirSync(path.join(root, 'workspace', 'demo', 'source-full'), { recursive: true })
    const clone = vi.fn(async () => {})
    const runAgent = vi.fn(async () => ok())
    const runBuild = vi.fn(async () => ({ ok: true, output: '' }))
    await rebrandExec(ctx, 'demo', { fresh: true, deps: { clone, runAgent, runBuild } })
    expect(clone).toHaveBeenCalledWith(`https://github.com/owner/demo`, path.join(root, 'workspace', 'demo', 'source-full'))
  })
})

describe('rebrandExec 重试状态机', () => {
  it('首轮 build 就过 → status=done，rounds=1', async () => {
    seedProject('demo')
    const runBuild = vi.fn(async () => ({ ok: true, output: '' }))
    const r = await rebrandExec(ctx, 'demo', { deps: { clone: vi.fn(async () => {}), runAgent: vi.fn(async () => ok()), runBuild } })
    expect(r).toEqual(expect.objectContaining({ status: 'done', rounds: 1 }))
    expect(runBuild).toHaveBeenCalledTimes(1)
  })
  it('第一轮失败、第二轮成功 → status=done，rounds=2', async () => {
    seedProject('demo')
    let call = 0
    const runBuild = vi.fn(async () => { call++; return call === 1 ? { ok: false, output: 'err1' } : { ok: true, output: '' } })
    const r = await rebrandExec(ctx, 'demo', { deps: { clone: vi.fn(async () => {}), runAgent: vi.fn(async () => ok()), runBuild } })
    expect(r).toEqual(expect.objectContaining({ status: 'done', rounds: 2 }))
  })
  it('三轮全失败 → status=build-failed，rounds=3', async () => {
    seedProject('demo')
    const runBuild = vi.fn(async () => ({ ok: false, output: 'still broken' }))
    const runAgent = vi.fn(async () => ok())
    const r = await rebrandExec(ctx, 'demo', { deps: { clone: vi.fn(async () => {}), runAgent, runBuild } })
    expect(r).toEqual(expect.objectContaining({ status: 'build-failed', rounds: 3 }))
    expect(runAgent).toHaveBeenCalledTimes(3)
    expect(runBuild).toHaveBeenCalledTimes(3)
  })
  it('runBuild 返回 null（无可用验证脚本）→ status=no-buildscript，不重试', async () => {
    seedProject('demo')
    const runAgent = vi.fn(async () => ok())
    const runBuild = vi.fn(async () => null)
    const r = await rebrandExec(ctx, 'demo', { deps: { clone: vi.fn(async () => {}), runAgent, runBuild } })
    expect(r).toEqual(expect.objectContaining({ status: 'no-buildscript', rounds: 1 }))
    expect(runAgent).toHaveBeenCalledTimes(1)
  })
})

describe('rebrandExec 报告', () => {
  it('写 rebrand-exec-report.md，含状态/轮数/summary/changedFiles', async () => {
    seedProject('demo')
    const r = await rebrandExec(ctx, 'demo', {
      deps: {
        clone: vi.fn(async () => {}),
        runAgent: vi.fn(async () => ({ status: 'done', summary: '品牌名换成了 Demo', changedFiles: ['package.json', 'src/App.tsx'] })),
        runBuild: vi.fn(async () => ({ ok: true, output: '' })),
      },
    })
    expect(r.reportPath).toBe(path.join('demo', 'rebrand-exec-report.md'))
    const report = fs.readFileSync(path.join(root, 'workspace', r.reportPath), 'utf8')
    expect(report).toContain('状态：done')
    expect(report).toContain('轮数：1')
    expect(report).toContain('品牌名换成了 Demo')
    expect(report).toContain('package.json')
    expect(report).toContain('src/App.tsx')
  })
  it('build-failed 时报告里含最后一次 build 输出', async () => {
    seedProject('demo')
    await rebrandExec(ctx, 'demo', {
      deps: {
        clone: vi.fn(async () => {}),
        runAgent: vi.fn(async () => ok()),
        runBuild: vi.fn(async () => ({ ok: false, output: 'TypeError: xxx is not a function' })),
      },
    })
    const report = fs.readFileSync(path.join(root, 'workspace', 'demo', 'rebrand-exec-report.md'), 'utf8')
    expect(report).toContain('build-failed')
    expect(report).toContain('TypeError: xxx is not a function')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm --filter @forgecast/rebrand test rebrand-exec.test
```

预期：`Cannot find module '../src/rebrand-exec'`。

- [ ] **Step 3: 实现**

创建 `packages/rebrand/src/rebrand-exec.ts`：

```ts
import fs from 'node:fs'
import path from 'node:path'
import type { CoreCtx } from '@forgecast/core'
import type { AgentResult } from './fixtures/rebrand-exec-fixture'

export interface RebrandExecDeps {
  clone: (url: string, dir: string) => Promise<void>
  runAgent: (prompt: string, cwd: string) => Promise<AgentResult>
  runBuild: (cwd: string) => Promise<{ ok: boolean; output: string } | null>
}
export interface RebrandExecOptions { onProgress?: (msg: string) => void; fresh?: boolean; deps: RebrandExecDeps }
export interface RebrandExecResult { status: 'done' | 'build-failed' | 'no-buildscript'; rounds: number; reportPath: string }

const MAX_ROUNDS = 3

/** 换皮自动执行：clone → agent 按 rebrand-plan.md 品牌层清单改代码 → build 验证失败自动重试（≤3 轮）→ 出报告。 */
export async function rebrandExec(ctx: CoreCtx, slug: string, opts: RebrandExecOptions): Promise<RebrandExecResult> {
  const onProgress = opts.onProgress ?? (() => {})
  const projectDir = path.join(ctx.config.paths.workspace, slug)
  const planPath = path.join(projectDir, 'rebrand-plan.md')
  if (!fs.existsSync(planPath)) throw new Error(`先跑 forgecast rebrand ${slug} 生成改造清单`)

  const row = ctx.db.prepare(
    'SELECT c.url AS url FROM projects p JOIN candidates c ON p.candidate_id = c.id WHERE p.slug = ?',
  ).get(slug) as { url: string } | undefined
  if (!row) throw new Error(`项目 ${slug} 缺少候选来源，无法获取仓库地址`)

  const sourceDir = path.join(projectDir, 'source-full')
  if (opts.fresh || !fs.existsSync(sourceDir)) {
    onProgress('clone 源码…')
    await opts.deps.clone(row.url, sourceDir)
  } else {
    onProgress('复用已有 clone: source-full/')
  }

  const startedAt = Date.now()
  let round = 1
  let status: RebrandExecResult['status'] = 'build-failed'
  let lastAgent: AgentResult = { status: 'blocked', summary: '', changedFiles: [] }
  let lastBuild: { ok: boolean; output: string } | null = null
  while (round <= MAX_ROUNDS) {
    onProgress(`第 ${round} 轮改造…`)
    const prompt = round === 1
      ? buildInitialPrompt(slug, planPath, sourceDir)
      : buildRetryPrompt(lastBuild?.output ?? '')
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
}

function buildInitialPrompt(slug: string, planPath: string, sourceDir: string): string {
  return [
    `你在 ${sourceDir} 这个目录里工作，这是一个开源项目的本地克隆。`,
    '只允许修改这个目录内的文件，不要碰目录外的任何东西。',
    '',
    `读 ${planPath}，只执行其中「1. 品牌替换」「2. 删除项」「3. 中文化」三段列出的改动，忽略「4. 本土化新增功能」及之后的段落。`,
    `品牌名统一用「${slug}」。`,
    '',
    '改完后：',
    '1. 找到并运行这个项目自己的 build/lint/typecheck 命令自检，修到能过为止（如果确实没有可运行的验证命令，在 summary 里说明）',
    '2. 按给定的 JSON schema 输出最终结果',
  ].join('\n')
}

function buildRetryPrompt(buildOutput: string): string {
  return `上一轮改完后跑外层验证失败，报错如下，请修复：\n${buildOutput.slice(0, 4000)}`
}

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

- [ ] **Step 4: 跑测试确认通过**

```bash
pnpm --filter @forgecast/rebrand test rebrand-exec.test
```

- [ ] **Step 5: 提交**

```bash
git add packages/rebrand/src/rebrand-exec.ts packages/rebrand/test/rebrand-exec.test.ts
git commit -m "feat(rebrand): rebrandExec 核心状态机——precheck+clone幂等+build失败重试≤3轮+出报告"
```

---

### Task 6: live 默认 deps（真实 git clone / claude 无头模式）+ mode 分支装配 + 导出

**Files:**
- Modify: `packages/rebrand/src/rebrand-exec.ts`（加真实默认 deps 实现 + 按 `ctx.config.rebrandExec.mode` 选 mock/live deps 的便捷入口）
- Modify: `packages/rebrand/src/index.ts`
- Test: `packages/rebrand/test/rebrand-exec-live-deps.test.ts`

**Interfaces:**
- Consumes: `spawnCapture`（Task 2）、`mockClone`/`mockRunAgent`/`mockRunBuild`（Task 3）、`detectAndRunBuild`（Task 4）
- Produces: `export function rebrandExecAuto(ctx: CoreCtx, slug: string, opts?: { onProgress?: (msg: string) => void; fresh?: boolean }): Promise<RebrandExecResult>`——不需要调用方自己传 `deps`，内部按 `ctx.config.rebrandExec.mode` 自动选 mock fixture 或真实实现，是给 CLI 用的对外入口（Task 5 的 `rebrandExec` 仍保留、继续要求显式 `deps`，专供单测用）

**真实 deps 实现（只在 `mode==='live'` 时才会被用到，测试里通过给 `spawnCapture` 传 fake `run` 来验证参数拼接是否正确，不真的碰网络/claude）：**

```ts
async function gitClone(url: string, dir: string): Promise<void> {
  const { code, stderr } = await spawnCapture('git', ['clone', '--depth', '1', url, dir], { timeoutMs: 300_000, label: 'git clone' })
  if (code !== 0) throw new Error(`git clone 失败: ${stderr.slice(0, 400)}`)
}

async function runClaudeHeadless(prompt: string, cwd: string): Promise<AgentResult> {
  const timeoutMs = Number(process.env.FORGECAST_REBRAND_EXEC_TIMEOUT_MS) || 1_200_000
  const schema = JSON.stringify({
    type: 'object', required: ['status', 'summary', 'changedFiles'],
    properties: { status: { enum: ['done', 'blocked'] }, summary: { type: 'string' }, changedFiles: { type: 'array', items: { type: 'string' } } },
  })
  const { code, stdout, stderr } = await spawnCapture('claude', [
    '-p', prompt, '--dangerously-skip-permissions', '--output-format', 'json', '--json-schema', schema,
  ], { cwd, timeoutMs, label: 'claude rebrand-exec' })
  if (code !== 0) throw new Error(`claude 无头模式执行失败: ${stderr.slice(0, 400)}`)
  const parsed = JSON.parse(stdout)
  return (typeof parsed.result === 'string' ? JSON.parse(parsed.result) : parsed.result) as AgentResult
}
```

**装配：**

```ts
export function rebrandExecAuto(ctx: CoreCtx, slug: string, opts: { onProgress?: (msg: string) => void; fresh?: boolean } = {}): Promise<RebrandExecResult> {
  const deps: RebrandExecDeps = ctx.config.rebrandExec.mode === 'live'
    ? { clone: gitClone, runAgent: runClaudeHeadless, runBuild: detectAndRunBuild }
    : { clone: mockClone, runAgent: mockRunAgent, runBuild: mockRunBuild }
  return rebrandExec(ctx, slug, { ...opts, deps })
}
```

- [ ] **Step 1: 写失败测试**

创建 `packages/rebrand/test/rebrand-exec-live-deps.test.ts`（**只测参数拼接是否正确，不碰真实网络/claude**——通过给内部 `gitClone`/`runClaudeHeadless` 间接测试的唯一方式是走 `rebrandExecAuto` 的 mock 分支验证装配逻辑本身；真实 live 分支的参数拼接改用直接单测 `detectAndRunBuild` 已在 Task 4 覆盖，这里额外补一个**mode 装配路由**的测试）：

```ts
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadConfig, openDb, type CoreCtx } from '@forgecast/core'
import { beforeEach, describe, expect, it } from 'vitest'
import { rebrandExecAuto } from '../src/rebrand-exec'

let ctx: CoreCtx
let root: string

function seedProject(slug: string) {
  const info = ctx.db.prepare("INSERT INTO candidates (repo, url, license_ok) VALUES (?, ?, 1)").run(`owner/${slug}`, `https://github.com/owner/${slug}`)
  ctx.db.prepare('INSERT INTO projects (slug, candidate_id) VALUES (?, ?)').run(slug, Number(info.lastInsertRowid))
  const dir = path.join(root, 'workspace', slug)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'rebrand-plan.md'), '# demo 换皮改造清单\n## 1. 品牌替换\n- x')
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-rbx-auto-'))
})

describe('rebrandExecAuto mode 装配', () => {
  it('config.rebrandExec.mode=mock（默认）→ 走 mock fixture，不碰网络，跑完 status=done', async () => {
    const config = loadConfig(root, {})
    ctx = { db: openDb(config.paths.db), config, llm: null as any }
    seedProject('demo')
    const r = await rebrandExecAuto(ctx, 'demo')
    expect(r.status).toBe('done')
    expect(r.rounds).toBe(1)
    // mock clone 落的占位 package.json 应该被 mock agent 改了 name
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'workspace', 'demo', 'source-full', 'package.json'), 'utf8'))
    expect(pkg.name).toBe('rebranded')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm --filter @forgecast/rebrand test rebrand-exec-live-deps
```

预期：`rebrandExecAuto is not a function`（还没导出）。

- [ ] **Step 3: 实现**

在 `packages/rebrand/src/rebrand-exec.ts` 顶部 import 区新增：

```ts
import { spawnCapture } from './spawn-capture'
import { detectAndRunBuild } from './detect-build'
import { mockClone, mockRunAgent, mockRunBuild } from './fixtures/rebrand-exec-fixture'
```

在文件末尾追加上面「真实 deps 实现」和「装配」两段代码（`gitClone`/`runClaudeHeadless`/`rebrandExecAuto`）。

修改 `packages/rebrand/src/index.ts`，在末尾加一行：

```ts
export * from './rebrand-exec'
export * from './detect-build'
export * from './spawn-capture'
```

（`fixtures/rebrand-exec-fixture` 不导出到包对外 API——mock 细节是实现细节，不是公开接口，跟现有 `fixtures/rebrand-fixture` 是个例外——检查一下：现有 `index.ts` 确实 `export * from './fixtures/rebrand-fixture'`，为保持一致本任务也把 `rebrand-exec-fixture` 加进去）：

```ts
export * from './fixtures/rebrand-exec-fixture'
```

- [ ] **Step 4: 跑测试确认通过**

```bash
pnpm --filter @forgecast/rebrand test
```

预期：整个包全部测试通过（含前面几个 Task 的测试文件）。

- [ ] **Step 5: 提交**

```bash
git add packages/rebrand/src/rebrand-exec.ts packages/rebrand/src/index.ts packages/rebrand/test/rebrand-exec-live-deps.test.ts
git commit -m "feat(rebrand): rebrandExecAuto——按 config.rebrandExec.mode 自动装配 mock/live deps"
```

---

### Task 7: CLI 命令 `forgecast rebrand-exec <slug> [--fresh]` + README 更新

**Files:**
- Modify: `cli.ts`
- Modify: `README.md`

本任务是 CLI 接线 + 文档收尾，没有独立单元测试（跟现有 `pick`/`analyze`/`rebrand` 命令一致，`cli.ts` 本身没有测试文件，靠 Task 1-6 的库层测试保证正确性）。

- [ ] **Step 1: 加 CLI 命令**

在 `cli.ts` 顶部 import 区，找到 `import { rebrandPlan } from '@forgecast/rebrand'`，改成：

```ts
import { rebrandExecAuto, rebrandPlan } from '@forgecast/rebrand'
```

在 `case 'rebrand': { ... break }` 块后面紧接着加一个新 case：

```ts
    case 'rebrand-exec': {
      const slug = rest.find((a) => !a.startsWith('--'))
      if (!slug) { console.error('用法: forgecast rebrand-exec <slug> [--fresh]'); process.exit(1) }
      const fresh = rest.includes('--fresh')
      const r = await rebrandExecAuto(ctxWithNotes(), slug, { fresh, onProgress: (m) => console.log(`  ${m}`) })
      console.log(`执行完成: ${r.status}（${r.rounds} 轮）→ workspace/${r.reportPath}`)
      if (r.status === 'build-failed') process.exitCode = 1
      break
    }
```

在文件底部帮助文本（`analyze <slug>` / `rebrand <slug>` 那几行附近，约第 449-450 行）追加一行：

```
  rebrand-exec <slug> [--fresh]    执行换皮改造清单里的品牌层部分（1品牌替换/2删除项/3中文化）：clone 源码→claude 无头模式改代码→build 验证失败自动重试≤3轮→出报告（--fresh 强制重新 clone）
```

- [ ] **Step 2: 更新 README**

在 README「环境变量（.env）」表格里，`FORGECAST_VIDEO_MODE` 那一行附近加一行：

```
| FORGECAST_REBRAND_EXEC_MODE | `mock`（默认，CI/测试用，不碰真实网络/claude）/ `live`（真实 git clone + 调用本机已登录的 claude CLI 无头模式改代码） |
| FORGECAST_REBRAND_EXEC_TIMEOUT_MS | live 模式下单轮 claude 无头执行超时（默认 1200000ms=20min） |
```

在 README「CLI」代码块里，`forgecast rebrand <slug>` 那一行后面加一行：

```
forgecast rebrand-exec <slug> [--fresh]     执行换皮清单的品牌层（品牌替换/删除项/中文化）：clone→claude 无头模式改代码→build验证失败重试≤3轮→报告（live 模式需本机已装并登录 claude CLI）
```

- [ ] **Step 3: 手动验证（mock 模式，无需真实网络/claude）**

```bash
export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH"
rm -rf /tmp/fc-manual-check && mkdir -p /tmp/fc-manual-check
pnpm exec tsx cli.ts scout --add=https://github.com/octocat/Hello-World 2>&1 | tail -3
pnpm exec tsx cli.ts pick octocat/Hello-World
pnpm exec tsx cli.ts analyze hello-world
pnpm exec tsx cli.ts rebrand hello-world
pnpm exec tsx cli.ts rebrand-exec hello-world
cat workspace/hello-world/rebrand-exec-report.md
```

预期：最后一步打印 `执行完成: done（1 轮）→ workspace/hello-world/rebrand-exec-report.md`，`rebrand-exec-report.md` 内容含"状态：done"。跑完清理：`rm -rf workspace/hello-world`（这是手动验证产生的测试数据，不提交）。

- [ ] **Step 4: 提交**

```bash
git add cli.ts README.md
git commit -m "feat(cli): 加 forgecast rebrand-exec 命令 + README 文档"
```

---

### Task 8: 全量回归

**Files:** 无改动，纯验证

- [ ] **Step 1: 跑全量测试**

```bash
export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH"
pnpm test
```

预期：所有包全绿，`packages/rebrand` 测试数比 Task 1 开始前多出 Task 2-6 新增的用例。

- [ ] **Step 2: 跑 web 类型检查**

```bash
pnpm --filter web exec tsc --noEmit
```

预期：无输出（无错误）。

- [ ] **Step 3: 确认无遗留手动验证产物**

```bash
git status --porcelain
```

预期：干净（Task 7 Step 3 的 `workspace/hello-world/` 已在该步骤清理），只有已提交的历史。
