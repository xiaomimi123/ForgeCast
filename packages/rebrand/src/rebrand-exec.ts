import fs from 'node:fs'
import path from 'node:path'
import type { CoreCtx } from '@forgecast/core'
import { detectAndRunBuild } from './detect-build'
import type { AgentResult } from './fixtures/rebrand-exec-fixture'
import { mockClone, mockRunAgent, mockRunBuild } from './fixtures/rebrand-exec-fixture'
import { spawnCapture } from './spawn-capture'

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

/** CLI 用的对外入口：按 ctx.config.rebrandExec.mode 自动选 mock/live deps，调用方不需要自己传 deps。 */
export function rebrandExecAuto(ctx: CoreCtx, slug: string, opts: { onProgress?: (msg: string) => void; fresh?: boolean } = {}): Promise<RebrandExecResult> {
  const deps: RebrandExecDeps = ctx.config.rebrandExec.mode === 'live'
    ? { clone: gitClone, runAgent: runClaudeHeadless, runBuild: detectAndRunBuild }
    : { clone: mockClone, runAgent: mockRunAgent, runBuild: mockRunBuild }
  return rebrandExec(ctx, slug, { ...opts, deps })
}
