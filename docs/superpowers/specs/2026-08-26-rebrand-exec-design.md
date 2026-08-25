# 换皮自动执行（rebrand-exec）设计

> 日期：2026-08-26　状态：设计已确认，待实施

## 背景

现有 `forgecast rebrand <slug>` 只生成一份 `rebrand-plan.md`——7 段改造清单（品牌替换/删除项/中文化/本土化新增功能/部署/录屏/合规自检），是文字建议，**不改任何源码**。`forgecast pick` 也只落 `source/README.md` + `source/tree.txt`，从没把完整源码克隆到本地。

本次要新增：真正把清单里**纯 UI/品牌层**的部分（1.品牌替换、2.删除项、3.中文化）执行到开源项目源码上，产出一份改造完的本地代码副本。「4.本土化新增功能」（动业务逻辑）、「5.部署」「6.录屏」（非代码操作）不在本次自动化范围内，仍留给人工。

打包 Windows/macOS 安装包是后续独立课题，不在本 spec 内。

## 目标与非目标

**目标**：`forgecast rebrand-exec <slug>` 一条命令，把已 clone 的开源项目源码按 `rebrand-plan.md` 的品牌层清单自动改完，跑 build 验证，产出报告。

**非目标**：
- 不执行「本土化新增功能」这类业务逻辑改动
- 不做部署/录屏
- 不做 Web UI（本次只 CLI）
- 不做安装包打包
- 不保证任意开源项目都能无差错改成功——build 失败会如实报告，不强行回滚或掩盖

## 整体流程

```
forgecast rebrand-exec <slug>
  │
  ├─ 1. 前置检查：rebrand-plan.md 存在？不存在则报错提示先跑 rebrand
  ├─ 2. Clone：workspace/<slug>/source-full/ 已存在则跳过（除非 --fresh）；
  │         否则 git clone --depth 1 <candidates.url> 到该目录，保留 .git
  ├─ 3. 执行（最多 3 轮）：
  │     ├─ 调 claude -p 无头模式，cwd=source-full/，读 rebrand-plan.md 只执行 1/2/3 段
  │     ├─ 结束后 ForgeCast 自己跑外层 build 验证（读 package.json scripts）
  │     └─ 验证失败 → 把报错拼进下一轮 prompt，重试；验证通过或轮数耗尽 → 结束
  └─ 4. 写报告：workspace/<slug>/rebrand-exec-report.md（状态/轮数/耗时/变更文件摘要）
```

## 新增/改动单元

### `packages/rebrand/src/rebrand-exec.ts`（新）

主入口 `rebrandExec(ctx: CoreCtx, slug: string, opts): Promise<{ status: 'done' | 'build-failed' | 'no-buildscript'; rounds: number; reportPath: string }>`

```ts
export interface RebrandExecOptions {
  onProgress?: (msg: string) => void
  fresh?: boolean            // 强制重新 clone
  deps?: {
    clone?: (url: string, dir: string) => Promise<void>
    runAgent?: (prompt: string, cwd: string) => Promise<AgentResult>
    runBuild?: (cwd: string) => Promise<{ ok: boolean; output: string }>
  }
}
interface AgentResult { status: 'done' | 'blocked'; summary: string; changedFiles: string[] }
```

- `deps` 全部可选注入点，测试用（mock 模式下不传真实实现，走 fixture）。
- 前置检查：`workspace/<slug>/rebrand-plan.md` 不存在 → 抛错「先跑 forgecast rebrand `<slug>`」。
- Clone：`SELECT candidates.url FROM projects JOIN candidates ON projects.candidate_id = candidates.id WHERE projects.slug = ?` 拿仓库地址；`source-full/` 已存在且非 `--fresh` 则跳过并 `onProgress` 提示复用旧 clone。
- **mode 开关**：`FORGECAST_REBRAND_EXEC_MODE`：
  - `mock`（默认，CI/测试用）：不真的 clone/调 claude，`clone` 写一个假 `package.json`+占位文件到 `source-full/`，`runAgent` 直接返回固定 mock 结果（改一处文件模拟"品牌名替换"），`runBuild` 固定返回 `{ok:true}`
  - `live`：真实 git clone + spawn claude CLI + 真实跑 build

### Clone（`deps.clone` 默认实现）

```ts
async function gitClone(url: string, dir: string): Promise<void> {
  await spawnCapture('git', ['clone', '--depth', '1', url, dir], { timeoutMs: 300_000, label: 'git clone' })
}
```

`spawnCapture` 是本文件内的小工具（不复用 `studio/hyperframes.ts` 的 `spawnWithTimeout`，因为那个只 resolve/reject void、失败只截 400 字节 stderr——这里需要完整 stdout/stderr 文本用于报告和重试反馈）：

```ts
function spawnCapture(cmd: string, args: string[], opts: { cwd?: string; timeoutMs: number; label: string }): Promise<{ code: number; stdout: string; stderr: string }>
```

### 执行 agent（`deps.runAgent` 默认实现）

```ts
async function runClaudeHeadless(prompt: string, cwd: string): Promise<AgentResult> {
  const schema = JSON.stringify({
    type: 'object', required: ['status', 'summary', 'changedFiles'],
    properties: {
      status: { enum: ['done', 'blocked'] },
      summary: { type: 'string' },
      changedFiles: { type: 'array', items: { type: 'string' } },
    },
  })
  const { stdout } = await spawnCapture('claude', [
    '-p', prompt,
    '--dangerously-skip-permissions',
    '--output-format', 'json',
    '--json-schema', schema,
  ], { cwd, timeoutMs: EXEC_TIMEOUT_MS, label: 'claude rebrand-exec' })
  const parsed = JSON.parse(stdout)
  // --output-format json 的确切外层结构（result 是字符串还是已解析对象）需实现时用一次真实调用核实，
  // 以下按最常见的「外层包一层 result 字符串字段」写，若实测不符按实测调整
  return (typeof parsed.result === 'string' ? JSON.parse(parsed.result) : parsed.result) as AgentResult
}
```

`EXEC_TIMEOUT_MS` 默认 20 分钟，可用 `FORGECAST_REBRAND_EXEC_TIMEOUT_MS` 覆盖（跟 `FORGECAST_RENDER_TIMEOUT_MS` 先例一致）。

**Prompt 内容**（首轮）：

```
你在 <source-full 绝对路径> 这个目录里工作，这是一个开源项目的本地克隆。
只允许修改这个目录内的文件，不要碰目录外的任何东西。

读 <rebrand-plan.md 绝对路径>，只执行其中「1. 品牌替换」「2. 删除项」「3. 中文化」
三段列出的改动，忽略「4. 本土化新增功能」及之后的段落。

品牌名统一用「<projects.brand_name，为空则用 slug>」。

改完后：
1. 找到并运行这个项目自己的 build/lint/typecheck 命令自检，修到能过为止
   （如果确实没有可运行的验证命令，在 summary 里说明）
2. 按给定的 JSON schema 输出最终结果
```

重试轮（第 2/3 轮）在此基础上追加：

```
上一轮改完后跑外层验证失败，报错如下，请修复：
<build 报错内容，截断到 4000 字符>
```

### 外层验证（`deps.runBuild` 默认实现）

```ts
async function detectAndRunBuild(cwd: string): Promise<{ ok: boolean; output: string } | null> {
  const pkgPath = path.join(cwd, 'package.json')
  if (!fs.existsSync(pkgPath)) return null   // 非 Node 项目：跳过外层验证，只信 agent 自报
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
  const script = ['build', 'typecheck', 'lint'].find((s) => pkg.scripts?.[s])
  if (!script) return null
  const pm = fs.existsSync(path.join(cwd, 'pnpm-lock.yaml')) ? 'pnpm'
    : fs.existsSync(path.join(cwd, 'yarn.lock')) ? 'yarn' : 'npm'
  if (!fs.existsSync(path.join(cwd, 'node_modules'))) {
    await spawnCapture(pm, ['install'], { cwd, timeoutMs: 300_000, label: `${pm} install` })
  }
  const { code, stdout, stderr } = await spawnCapture(pm, ['run', script], { cwd, timeoutMs: 300_000, label: `${pm} run ${script}` })
  return { ok: code === 0, output: (stdout + stderr).slice(0, 4000) }
}
```

返回 `null`（无可用验证脚本）时，`rebrandExec` 主流程把状态记为 `no-buildscript`，不触发重试循环，直接采信 agent 自报的 `status`。

### 主流程状态机

```ts
let round = 1
let lastAgentResult: AgentResult | null = null
let lastBuildOutput = ''
while (round <= 3) {
  onProgress(`第 ${round} 轮改造…`)
  const prompt = round === 1 ? buildInitialPrompt(...) : buildRetryPrompt(lastBuildOutput)
  lastAgentResult = await runAgent(prompt, sourceFullDir)
  const build = await runBuild(sourceFullDir)
  if (build === null) { status = 'no-buildscript'; break }
  if (build.ok) { status = 'done'; break }
  lastBuildOutput = build.output
  if (round === 3) { status = 'build-failed'; break }
  round++
}
```

### 报告（`rebrand-exec-report.md`）

```markdown
# <slug> 换皮执行报告

- 状态：done / build-failed / no-buildscript
- 轮数：<round>
- 耗时：<seconds>s
- 生成时间：<ISO>

## Agent 变更摘要
<agentResult.summary>

## 改动文件
- <changedFiles 逐行>

## 最后一次 build 输出（如有）
```
<build.output>
```
```

### CLI（`cli.ts` 新增子命令）

```
forgecast rebrand-exec <slug> [--fresh]
```

跟 `rebrand`/`analyze` 同风格：`onProgress` 打到 stdout，异常直接抛出让 CLI 顶层统一捕获打印。

## Mock 测试策略

沿用「每个新 LLM/外部进程能力都要有自己的 mock」的项目惯例：

- 单测里全部走 `deps` 注入的 fake 实现，不碰真实文件系统之外的网络/子进程
- 一个集成测试用真实文件系统（临时目录）+ fake `clone`/`runAgent`/`runBuild`，验证：
  - 首轮成功（`runBuild` 直接 ok）→ status=`done`，round=1，报告文件存在且含 summary
  - 首轮失败、第二轮成功 → round=2，report 里体现重试
  - 三轮全失败 → status=`build-failed`
  - `runBuild` 返回 `null`（无 build 脚本）→ status=`no-buildscript`，不重试
  - `rebrand-plan.md` 不存在 → 抛错
  - `source-full/` 已存在且未传 `--fresh` → 不调 `clone`
  - `--fresh` → 即使已存在也重新调 `clone`

## 风险与边界

- **无人监督执行代码改动**：限定在一次性 clone 出来的 `source-full/` 目录内，prompt 明确划定边界，不触碰仓库其余部分——已与用户确认接受此风险。
- **不保证成功**：目标项目结构差异极大，`build-failed` 是预期可能结果之一，不是 bug，报告如实呈现即可。
- **超大仓库/超长 build**：靠超时机制兜底（clone 5min / npm install+build 5min / claude 单轮 20min），超时即失败进入下一轮或终止，不会无限挂起。
- **claude CLI 未安装**：`spawnCapture` 会在 `spawn` 阶段直接 reject（ENOENT），报错信息里提示需要本机装好 Claude Code CLI 并登录。
