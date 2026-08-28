# 拆解页四关验收 + 盖章（子项目③）设计

> 日期：2026-08-29　状态：设计已确认，待实施
>
> 设计稿：`~/Desktop/ForgeCast-UI设计稿.html`（同子项目①②）
>
> 全站重设计 4 个子项目：①视觉基础+导航壳（已完成）②找项目双轨评分（已完成）**③本 spec**④做内容/分发/定制视觉套用（未开始）

## 背景

设计稿"拆解"页展示"待验收/已完成"两个区块，每个待验收项目带"四关灯（构建/启动/健康检查/截图）"，全绿后人工点"验收通过"，通过的项目盖"验讫"章进入下一阶段。

这四关本质上是"换皮完代码后自动验证能不能跑起来"——跟已经开发并合并的 `rebrandExec`（`packages/rebrand`：clone→claude 无头模式改代码→build 验证失败重试→出报告）是同一件事的延伸。本 spec 直接在 `rebrandExec` 基础上扩展，从"只验构建"扩到"构建+启动+健康检查+截图"四关，不另起一套流程。

## 目标

1. `rebrandExec` 的验证阶段从单一"构建"扩展成四关：构建（已有，不变）→ 启动（agent 自报）→ 健康检查（ForgeCast 独立验证）→ 截图（ForgeCast 独立截图）。
2. 结果持久化到 `projects` 表，供"拆解"页读取展示。
3. "拆解"页新增"待验收/已完成"两个区块（不改现有分析/换皮两条泳道），带四关灯 + "验收通过"操作。
4. Web 端新增触发入口：项目详情抽屉里加"跑验收"按钮，调用 `rebrandExecAuto`。

## 非目标

- 不做真正的产物打包（zip/dist）或部署——"已完成"区块的"打开演示站"直接用现有 `projects.demo_url` 字段（未填不显示按钮），"下载产物包"改成"打开产物目录/查看报告"的本地路径信息，不新增打包能力。
- 不改现有分析/换皮两条泳道的展示逻辑（`ProjectGroups.tsx` 现状保留）。
- 不支持 Docker Compose 类多容器启动的进程收尾——启动关只对"agent 直接 spawn 一个监听某端口的进程"这种情况做端口级 kill；Docker 容器的启动/收尾这次不专门处理，agent 若用 Docker 启动、健康检查失败也会走超时收尾路径，只是不保证清理容器本身（已知局限，非本次目标）。
- 不新增独立的"验收状态"字段——待验收/已完成的判定复用已有的 `projects.stage`，不新建状态机。

## 1. `rebrandExec` 扩展（`packages/rebrand`）

### 1.1 Agent 结构化输出扩展（`AgentResult`）

```ts
export interface AgentResult {
  status: 'done' | 'blocked'
  summary: string
  changedFiles: string[]
  // 新增，启动关专属，全部可选——agent 没试启动/试了失败都可能缺失
  serverStarted?: boolean   // agent 自报：是否成功把服务跑起来
  serverPort?: number       // agent 自报：服务监听的端口（health/screenshot/kill 都靠这个）
  startCommand?: string     // agent 自报：实际用的启动命令，仅存档展示，不重新执行
}
```

### 1.2 Prompt 追加启动指令

在 `buildInitialPrompt` 的"改完后"清单里追加第 3 步（原有 1、2 步不变）：

```
3. 尝试把这个项目的服务启动起来（如 npm start / pnpm dev 等，后台运行不要阻塞），
   如果确实启动成功，在结果里报告 serverStarted:true、serverPort、startCommand；
   如果启动失败或这个项目本来就不是一个可独立运行的服务，报告 serverStarted:false，不用勉强。
```

JSON schema（`runClaudeHeadless` 里 `--json-schema` 那段）相应加 `serverStarted`(boolean)/`serverPort`(number)/`startCommand`(string) 三个可选属性。

### 1.3 健康检查（ForgeCast 独立验证，新文件 `packages/rebrand/src/healthcheck.ts`）

```ts
/** 探测 http://127.0.0.1:<port>，成功=拿到任意 HTTP 响应（不要求 200——很多脚手架首页会 30x/404，
 *  能连上说明服务确实起来了）。轮询直到超时，给服务一点启动缓冲时间。 */
export async function waitForPort(port: number, opts: { timeoutMs: number; intervalMs?: number; fetchImpl?: typeof fetch } = { timeoutMs: 15000 }): Promise<boolean> {
  const interval = opts.intervalMs ?? 1000
  const fetchFn = opts.fetchImpl ?? fetch
  const deadline = Date.now() + opts.timeoutMs
  while (Date.now() < deadline) {
    try {
      await fetchFn(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(2000) })
      return true
    } catch { /* 连不上，继续轮询 */ }
    await new Promise((r) => setTimeout(r, interval))
  }
  return false
}
```

### 1.4 截图（复用现有 Playwright 用法，新文件 `packages/rebrand/src/screenshot.ts`）

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

### 1.5 端口级进程收尾（新文件 `packages/rebrand/src/kill-port.ts`）

```ts
/** 按端口强杀占用进程（macOS/Linux：lsof -ti:<port> | xargs kill -9）。找不到占用进程视为已经退出，不算失败。 */
export async function killByPort(port: number): Promise<void> {
  const { code, stdout } = await spawnCapture('lsof', ['-ti', `:${port}`], { timeoutMs: 5000, label: 'lsof' })
  if (code !== 0 || !stdout.trim()) return // 没有占用者，直接返回
  const pids = stdout.trim().split('\n')
  await spawnCapture('kill', ['-9', ...pids], { timeoutMs: 5000, label: 'kill' })
}
```

### 1.6 主流程整合（`rebrandExec` 函数）

在现有 `while (round <= MAX_ROUNDS)` 循环里，`lastBuild.ok` 为真、准备 `status='done'` break 之前，追加四关的后 3 关：

```ts
let gates = { build: false, start: false, health: false, screenshot: false }
let screenshotPath: string | undefined
// ...原有循环，build 通过时：
if (lastBuild.ok) {
  gates.build = true
  status = 'done'
  if (lastAgent.serverStarted && lastAgent.serverPort) {
    gates.start = true
    onProgress('健康检查…')
    gates.health = await opts.deps.waitForPort(lastAgent.serverPort, { timeoutMs: 15000 })
    if (gates.health) {
      onProgress('截图…')
      const shotPath = path.join(projectDir, 'rebrand-exec-screenshot.png')
      gates.screenshot = await opts.deps.captureScreenshot(lastAgent.serverPort, shotPath)
      if (gates.screenshot) screenshotPath = path.join(slug, 'rebrand-exec-screenshot.png')
    }
    await opts.deps.killByPort(lastAgent.serverPort)
  }
  break
}
```

`RebrandExecDeps` 新增三个可选依赖字段（`waitForPort`/`captureScreenshot`/`killByPort`，默认值分别是 1.3/1.4/1.5 的真实实现，mock 模式下全部替换成固定返回值，不发真实网络/不真的截图/不真的杀进程）；`RebrandExecResult` 新增 `gates`/`screenshotPath`：

```ts
export interface RebrandExecResult {
  status: 'done' | 'build-failed' | 'no-buildscript'
  rounds: number
  reportPath: string
  gates?: { build: boolean; start: boolean; health: boolean; screenshot: boolean }
  screenshotPath?: string
}
```

`status` 语义不变（仍然只反映"构建是否通过"，向后兼容既有测试）；`gates` 只在 `status==='done'` 时才有意义，其余状态下省略。

### 1.7 mock 模式扩展（`packages/rebrand/src/fixtures/rebrand-exec-fixture.ts`）

`mockRunAgent` 追加返回 `serverStarted: true, serverPort: 0, startCommand: 'echo mock-start'`（固定值，可预测）；新增 `mockWaitForPort`（固定返回 `true`，不发真实请求）、`mockCaptureScreenshot`（不调用 Playwright，直接 `fs.writeFileSync(outPath, 'MOCK_PNG')` 模拟截图产物，返回 `true`）、`mockKillByPort`（空操作）。`rebrandExecAuto` 里 mock 分支的 `deps` 对象补上这四个 mock 实现。

## 2. 数据持久化（`packages/core`）

`packages/core/src/db.ts` 迁移区追加一行：

```ts
ensureColumn(db, 'projects', 'rebrand_exec_result', 'TEXT')
```

存的是 `JSON.stringify(RebrandExecResult)`（跟 `candidates.score_detail` 同样"整块 JSON 塞 TEXT 列"的既有模式，不建子表）。`rebrandExec` 跑完后由调用方（server 路由）写入这一列，`rebrandExec` 本身不碰数据库（保持它现在"只操作文件系统+调用 deps"的纯函数风格，向后兼容现有单测）。

## 3. Server 路由（`packages/server/src/app.ts`）

新增（紧挨着现有 `POST /api/projects/:slug/rebrand` 之后）：

```ts
app.post('/api/projects/:slug/rebrand-exec', async (c) => {
  const slug = c.req.param('slug')
  const project = ctx.db.prepare('SELECT id FROM projects WHERE slug = ?').get(slug)
  if (!project) return c.json({ error: '项目不存在' }, 404)
  const taskId = queue.enqueue(async (log) => {
    const result = await rebrandExecAuto(ctx, slug, { onProgress: log })
    ctx.db.prepare('UPDATE projects SET rebrand_exec_result = ? WHERE slug = ?').run(JSON.stringify(result), slug)
    return result
  })
  return c.json({ taskId })
})
```

`GET /api/projects/:slug` 和 `GET /api/projects`（列表接口）已经用 `PROJECT_SELECT` 常量（`SELECT p.*, c.intro_detail ..., c.score_detail ... FROM projects p LEFT JOIN candidates c ...`）——`p.*` 会自动带出新列，这两个路由本身不用改。

## 4. Web 前端

### 4.1 触发入口（项目详情抽屉，`apps/web/src/drawers/ProjectDrawer.tsx`）

在现有"生成换皮清单"按钮同一行追加一个新按钮，态跟现有 `analyzing`/`rebranding` 那两个 state+按钮完全同构（新增 `execRunning`/`execLog` state，`POST .../rebrand-exec` + `subscribeTask`，完成后 `invalidateQueries(['project', slug])` 刷新）：

```tsx
<button className="btn-fire px-3 py-1 text-sm disabled:opacity-50"
  disabled={execRunning || !p.rebrandMd} onClick={runExec}>
  {execRunning ? '验收中…' : '跑验收（构建+启动+健康检查+截图）'}
</button>
```

### 4.2 "拆解"页新增区块（`apps/web/src/pages/board/ProjectGroups.tsx` 或新建 `AcceptanceSection.tsx`）

新建 `apps/web/src/pages/board/AcceptanceSection.tsx`，在 `ProjectsPage.tsx` 里 `<ProjectGroups>` 下面追加渲染，不改 `ProjectGroups.tsx` 本身：

- 待验收 = `projects.filter(p => p.stage === 'rebranding' && p.rebrand_exec_result)`
- 已完成 = `projects.filter(p => ['producing','publishing','selling'].includes(p.stage) && p.rebrand_exec_result)`

（`apps/web` 是浏览器包，不依赖 `@forgecast/core`，不能直接 import 后端的 `STAGES` 数组——`ProjectGroups.tsx` 里已经有一份平行声明的 `ALL_STAGES`/`GROUPS` 常量，这里直接写死"producing/publishing/selling 三个阶段名"字面量数组即可，跟现有 `ProjectGroups.tsx` 的既有写法一致，不新建共享常量模块。）

四关灯：4 个小圆点，`gates.build/start/health/screenshot` 各对应一个，绿/灰（不用红——没跑那关本来就是灰色未知，不是"失败"，只有 `status==='build-failed'` 时构建灯才显式标红）。

"验收通过"按钮：`onOpenProject` 之外新增 `onAdvanceStage(slug)` 回调，内部调用现有 `PATCH /api/projects/:slug { stage: 'producing' }`（复用 `ProjectsPage.tsx` 里已有的 `moveStage` mutation，作为 prop 往下传，不新建 mutation）。

"打开产物目录"：显示 `workspace/<slug>/source-full/` 这个路径文本（本地路径，不是可点击链接——浏览器不能直接打开本地文件系统路径），旁边加"查看报告"按钮跳转到项目详情抽屉的"换皮清单" tab（复用已有 `onOpenProject`）。

"打开演示站"：`p.demo_url` 非空时才渲染这个按钮（`<a href={p.demo_url} target="_blank">`），为空则不显示，不编造占位链接。

### 4.3 类型（`apps/web/src/api.ts`）

`Project` interface 追加：

```ts
rebrand_exec_result: string | null
```

## 5. 验收标准

- `pnpm --filter @forgecast/rebrand test` 全绿，新增：`healthcheck.ts`/`screenshot.ts`/`kill-port.ts` 各自的单测（用注入的 fake `fetch`/`spawnCapture`，不发真实网络/不真的截图/不真的杀进程）；`rebrandExec` 主流程新增"四关全绿路径"/"启动关自报失败则后两关不跑"/"健康检查失败则截图关不跑但仍收尾" 三个场景的 mock 测试。
- `pnpm --filter @forgecast/core test` 全绿，新增 `rebrand_exec_result` 列存在性测试（同 `favorite`/`source` 列先例）。
- `pnpm --filter @forgecast/server test` 全绿，新增 `POST /api/projects/:slug/rebrand-exec` 路由测试（mock 模式跑完后 `rebrand_exec_result` 列被正确写入）。
- `pnpm --filter web exec tsc --noEmit` 通过。
- 浏览器手动过一遍：项目详情抽屉能点"跑验收"，mock 模式下几秒内跑完，"拆解"页出现在"待验收"区块并显示四关灯（mock 全绿）；点"验收通过"后项目消失出"待验收"、出现在"已完成"；`demo_url` 为空的项目不显示"打开演示站"按钮。
