# AI 产品介绍 B-roll 视频 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 ForgeCast 补三个小型可复用工具（SRT 转换器、产品介绍解说词生成、成片登记 CLI 命令）+ 一份操作手册文档，支撑"用已装好的 erduo-broll-loop-engineering Skill 给项目做产品介绍 B-roll 视频"这条 Claude-Code-人工驱动的工作流。

**Architecture:** 三个组件互相独立、无依赖关系，可以任意顺序实现（这次按"底层工具→内容生成→登记入口→操作手册"的顺序做）。核心原则：不重新实现 erduo Skill 内部任何逻辑，只补它跑起来之前（生成解说词+转 SRT）和跑完之后（登记成片）所需的胶水工具；这条工作流本身没有自动触发入口，靠操作手册文档承接。

**Tech Stack:** TypeScript, Vitest（后端测试），better-sqlite3。CLI 命令走 `cli.ts` 现有的 `switch(cmd)` 结构。

## Global Constraints

- **不做网页按钮/自动触发入口**——整条工作流只能由 Claude Code 会话人工发起，不接入 server 任务队列/REST API。
- **不重新实现 erduo-broll-loop-engineering Skill 内部的任何逻辑**（Director/Assets/Builder 编排、运行时排期、装配脚本等），本计划三个组件都是它跑之前/跑之后的胶水代码。
- **不用真实网站截图**——`docs/broll-intro-workflow.md` 里 AI 生图步骤明确是"概念示意图"，不追求写实还原，最终视频要注明"UI 画面为概念演示，非真实产品截图"。
- **不给 `broll_script` 素材类型加专属前端 UI tab**（YAGNI，本次没被要求）。
- **不改动 `synthesizeVoice`/`generateShootScript`/`POST /api/projects/:slug/upload-video` 路由的任何现有逻辑**，只新增文件、不修改这几个已有实现。
- mock 模式下的 `generateProductIntroScript` 走固定 fixture，绝不调用 `ctx.llm`（仓库铁律，照抄 `mockShootScript` 的约定）。
- 参考 spec：`docs/superpowers/specs/2026-08-18-broll-intro-video-design.md`。

---

### Task 1: cuesToSrt（SRT 转换器）

**Files:**
- Create: `packages/studio/src/srt.ts`
- Test: `packages/studio/test/srt.test.ts`
- Modify: `packages/studio/src/index.ts`（导出新模块）

**Interfaces:**
- Consumes: `Cue { start: number; end: number; text: string }`（已存在于 `packages/studio/src/tts.ts`）。
- Produces: `cuesToSrt(cues: Cue[]): string`——本计划无其它任务直接依赖它（操作手册文档里会引用，但那是文档不是代码依赖）。

- [ ] **Step 1: 写失败测试**

创建 `packages/studio/test/srt.test.ts`：

```ts
import { describe, expect, it } from 'vitest'
import { cuesToSrt } from '../src/srt'

describe('cuesToSrt', () => {
  it('空数组返回空串', () => {
    expect(cuesToSrt([])).toBe('')
  })
  it('单条 cue：序号1，时间戳补零+逗号分隔毫秒', () => {
    const srt = cuesToSrt([{ start: 0, end: 3000, text: '你好世界' }])
    expect(srt).toBe('1\n00:00:00,000 --> 00:00:03,000\n你好世界\n')
  })
  it('多条 cue：序号递增，块间空行分隔', () => {
    const srt = cuesToSrt([
      { start: 0, end: 1500, text: '第一句' },
      { start: 1500, end: 4200, text: '第二句' },
    ])
    expect(srt).toBe(
      '1\n00:00:00,000 --> 00:00:01,500\n第一句\n\n2\n00:00:01,500 --> 00:00:04,200\n第二句\n',
    )
  })
  it('超过一分钟的时间戳正确进位到分钟/小时', () => {
    const srt = cuesToSrt([{ start: 65000, end: 3665500, text: '跨小时' }])
    expect(srt).toBe('1\n00:01:05,000 --> 01:01:05,500\n跨小时\n')
  })
  it('文本含换行时原样保留在字幕块里', () => {
    const srt = cuesToSrt([{ start: 0, end: 2000, text: '第一行\n第二行' }])
    expect(srt).toBe('1\n00:00:00,000 --> 00:00:02,000\n第一行\n第二行\n')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/studio && npx vitest run test/srt.test.ts`
Expected: FAIL（`../src/srt` 模块不存在）

- [ ] **Step 3: 实现 `cuesToSrt`**

创建 `packages/studio/src/srt.ts`：

```ts
import type { Cue } from './tts'

/** 毫秒 → SRT 时间戳 HH:MM:SS,mmm（补零，跨分钟/小时正确进位） */
function msToSrtTimestamp(ms: number): string {
  const totalMs = Math.max(0, Math.round(ms))
  const h = Math.floor(totalMs / 3_600_000)
  const m = Math.floor((totalMs % 3_600_000) / 60_000)
  const s = Math.floor((totalMs % 60_000) / 1000)
  const msRemainder = totalMs % 1000
  const pad = (n: number, len: number) => String(n).padStart(len, '0')
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)},${pad(msRemainder, 3)}`
}

/** Cue[]（毫秒级 start/end + 文本）转标准 SRT 文本。空数组返回空串。不做任何文件 I/O。 */
export function cuesToSrt(cues: Cue[]): string {
  if (cues.length === 0) return ''
  return cues
    .map((cue, i) => `${i + 1}\n${msToSrtTimestamp(cue.start)} --> ${msToSrtTimestamp(cue.end)}\n${cue.text}\n`)
    .join('\n')
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd packages/studio && npx vitest run test/srt.test.ts`
Expected: PASS（全部 5 条用例）

- [ ] **Step 5: 导出新模块**

检查 `packages/studio/src/index.ts` 的导出方式：

Run: `cat "/Users/lizhishaoniange/Documents/开源变现内容工厂/packages/studio/src/index.ts"`

若是 `export * from './xxx'` 的通配导出列表，在里面加一行 `export * from './srt'`（按文件名字母序插入到合适位置）；若是具名导出列表，把 `cuesToSrt` 加进对应那行的具名导出里。

- [ ] **Step 6: 跑 studio 包全部测试确认无回归**

Run: `cd packages/studio && npx vitest run`
Expected: PASS（全部测试，含新增的 5 条）

- [ ] **Step 7: Commit**

```bash
cd "/Users/lizhishaoniange/Documents/开源变现内容工厂"
git add packages/studio/src/srt.ts packages/studio/test/srt.test.ts packages/studio/src/index.ts
git commit -m "feat(studio): 新增 cuesToSrt，Cue[] 转标准 SRT 文本"
```

---

### Task 2: generateProductIntroScript（产品介绍解说词生成）

**Files:**
- Create: `packages/copywriter/src/broll-script.ts`
- Create: `packages/copywriter/src/fixtures/broll-script-fixture.ts`
- Create: `templates/prompts/broll-script.md`
- Modify: `packages/copywriter/src/index.ts`（导出新模块）
- Test: `packages/copywriter/test/broll-script.test.ts`

**Interfaces:**
- Produces: `ProductIntroScriptResult { assetId: number; filePath: string }`、`generateProductIntroScript(ctx: CoreCtx, input: { slug: string; onProgress?: (msg: string) => void }): Promise<ProductIntroScriptResult>`——`docs/broll-intro-workflow.md`（Task 4）会引用这个函数名/调用方式，但不是代码依赖。

- [ ] **Step 1: 写失败测试**

创建 `packages/copywriter/test/broll-script.test.ts`（照抄 `packages/copywriter/test/script.test.ts` 的 `beforeEach` 建 ctx 方式，但不需要预置 copy 素材，改成预置 `analysis.md`）：

```ts
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createLlmClient, loadConfig, openDb, type CoreCtx } from '@forgecast/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { generateProductIntroScript } from '../src/broll-script'

let ctx: CoreCtx
let root: string
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-broll-script-'))
  const config = loadConfig(root, {}) // llm mock
  ctx = { db: openDb(config.paths.db), config, llm: createLlmClient(config.llm) }
  ctx.db.prepare("INSERT INTO projects (slug, brand_name) VALUES ('demo', '快客通')").run()
})

function writeAnalysis(content = '## 谁掏钱\n中小老板\n\n## 痛点\n效率低') {
  const dir = path.join(root, 'workspace/demo')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'analysis.md'), content, 'utf8')
}

describe('generateProductIntroScript mock', () => {
  it('走固定 fixture，不调 ctx.llm，写文件+登记 assets 行', async () => {
    writeAnalysis()
    const spy = vi.spyOn(ctx.llm, 'complete')
    const r = await generateProductIntroScript(ctx, { slug: 'demo' })
    expect(spy).not.toHaveBeenCalled()
    expect(r.filePath).toBe('demo/broll/script.md')
    const md = fs.readFileSync(path.join(ctx.config.paths.workspace, r.filePath), 'utf8')
    expect(md).toContain('产品介绍解说词')
    const row: any = ctx.db.prepare('SELECT * FROM assets WHERE id = ?').get(r.assetId)
    expect(row.type).toBe('broll_script')
    expect(row.hook).toBeNull()
    expect(row.file_path).toBe('demo/broll/script.md')
  })
  it('项目不存在 → 抛错', async () => {
    await expect(generateProductIntroScript(ctx, { slug: 'nope' })).rejects.toThrow(/项目不存在/)
  })
  it('缺少 analysis.md → 抛错，提示先跑 analyze', async () => {
    await expect(generateProductIntroScript(ctx, { slug: 'demo' })).rejects.toThrow(/analysis\.md/)
  })
})

describe('generateProductIntroScript live（假 LLM）', () => {
  it('输出过短 → 抛错不落盘', async () => {
    writeAnalysis()
    const config = loadConfig(root, { FORGECAST_LLM_MODE: 'live', FORGECAST_LLM_KEY: 'k' })
    config.paths.templates = path.resolve(__dirname, '../../../templates')
    const lctx: CoreCtx = { db: ctx.db, config, llm: { complete: vi.fn(async () => '太短') } as any }
    await expect(generateProductIntroScript(lctx, { slug: 'demo' })).rejects.toThrow(/过短/)
    expect(ctx.db.prepare("SELECT COUNT(*) n FROM assets WHERE type='broll_script'").get()).toEqual({ n: 0 })
  })
  it('live 模式正常生成时，prompt 里注入 analysis.md 全文', async () => {
    writeAnalysis('## 谁掏钱\n特定测试标记ABC123')
    const config = loadConfig(root, { FORGECAST_LLM_MODE: 'live', FORGECAST_LLM_KEY: 'k' })
    config.paths.templates = path.resolve(__dirname, '../../../templates')
    const complete = vi.fn(async () => '# 产品介绍解说词\n' + 'x'.repeat(120))
    const lctx: CoreCtx = { db: ctx.db, config, llm: { complete } as any }
    await generateProductIntroScript(lctx, { slug: 'demo' })
    expect(complete.mock.calls[0][0].prompt).toContain('特定测试标记ABC123')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/copywriter && npx vitest run test/broll-script.test.ts`
Expected: FAIL（`../src/broll-script` 模块不存在）

- [ ] **Step 3: 写 mock fixture**

创建 `packages/copywriter/src/fixtures/broll-script-fixture.ts`（照抄 `script-fixture.ts` 的"固定骨架、不编造具体数据"约定）：

```ts
/** mock 产品介绍解说词：固定骨架，不读 analysis.md 内容（mock 不编造）。绝不调用 ctx.llm（仓库铁律）。 */
export function mockProductIntroScript(slug: string): string {
  return [
    '# 产品介绍解说词（mock）',
    '',
    `## 开场`,
    `${slug} 是一款面向特定场景的开源工具，本片将带你快速了解它能做什么。`,
    '',
    '## 核心能力',
    '（此处应描述产品的 2-3 个核心功能亮点）',
    '',
    '## 结尾',
    '如果你也有类似需求，欢迎了解更多。',
    '',
    '## 说明',
    '- mock 模式骨架：live 模式会读取 analysis.md 生成真实的产品介绍解说词',
  ].join('\n')
}
```

- [ ] **Step 4: 写 live prompt 模板**

创建 `templates/prompts/broll-script.md`（照抄仓库其它 prompt 模板的"角色说明+要求列表"风格，参考 `templates/prompts/shoot-script.md` 的格式）：

```markdown
你是产品宣传片解说词撰稿人，为一款开源项目改造后的产品写一段"产品介绍"解说词。

## 语气要求
- 类比官方产品发布视频的解说语气，不是短视频钩子体（不要用"家人们""绝了"这类短视频用语）。
- 面向完全不了解这个项目的普通用户，说清楚"这是什么、能解决什么问题、核心功能有哪些"。
- 结构清晰：开场引入 → 核心能力介绍（2-4 点）→ 结尾号召了解更多。

## 真实感红线（必须遵守）
- 只能使用下面提供的"产品分析"里出现的信息，不得编造分析材料之外的具体数字、客户案例、用户证言。
- 如果分析材料里没有具体数字支撑，用定性描述（"显著提升效率"）而不是编造精确数字（"提升 300% 效率"）。

## 输出格式
直接输出解说词正文（可以用小标题分段），不要输出多余的说明文字。

## 产品分析材料
{{analysis}}
```

- [ ] **Step 5: 实现 `generateProductIntroScript`**

创建 `packages/copywriter/src/broll-script.ts`（结构照抄 `packages/copywriter/src/script.ts` 的 `generateShootScript`）：

```ts
import fs from 'node:fs'
import path from 'node:path'
import type { CoreCtx } from '@forgecast/core'
import { mockProductIntroScript } from './fixtures/broll-script-fixture'

export interface ProductIntroScriptResult { assetId: number; filePath: string }

/**
 * 生成"产品介绍"B-roll 视频用的解说词：读 analysis.md 当依据，mock 走固定骨架（绝不调 ctx.llm），
 * live 读 templates/prompts/broll-script.md 模板注入 analysis.md 全文调 LLM。
 * 写 workspace/<slug>/broll/script.md，登记 type='broll_script' 素材。不推进项目阶段（可选辅助产出物）。
 */
export async function generateProductIntroScript(
  ctx: CoreCtx,
  input: { slug: string; onProgress?: (msg: string) => void },
): Promise<ProductIntroScriptResult> {
  const { slug, onProgress = () => {} } = input
  const project: any = ctx.db.prepare('SELECT * FROM projects WHERE slug = ?').get(slug)
  if (!project) throw new Error(`项目不存在: ${slug}`)

  const analysisPath = path.join(ctx.config.paths.workspace, slug, 'analysis.md')
  if (!fs.existsSync(analysisPath)) {
    throw new Error(`缺少 analysis.md: ${analysisPath}（先 forgecast analyze ${slug}）`)
  }
  const analysis = fs.readFileSync(analysisPath, 'utf8')

  let md: string
  if (ctx.config.llm.mode === 'mock') {
    onProgress('mock 模式：使用固定产品介绍解说词骨架…')
    md = mockProductIntroScript(slug)
  } else {
    onProgress('生成产品介绍解说词（live 模式）…')
    const tpl = fs.readFileSync(path.join(ctx.config.paths.templates, 'prompts', 'broll-script.md'), 'utf8')
    const system = '你是产品宣传片解说词撰稿人，输出可直接用于配音的解说词正文，只输出 markdown。'
    const prompt = tpl.replace('{{analysis}}', analysis)
    md = await ctx.llm.complete({ model: ctx.config.llm.models.copy, system, prompt })
    if (md.trim().length < 100) throw new Error('产品介绍解说词输出过短，疑似生成失败')
  }

  const dir = path.join(ctx.config.paths.workspace, slug, 'broll')
  fs.mkdirSync(dir, { recursive: true })
  const relPath = path.join(slug, 'broll', 'script.md')
  fs.writeFileSync(path.join(dir, 'script.md'), md, 'utf8')
  const info = ctx.db.prepare(
    "INSERT INTO assets (project_id, type, hook, file_path, warnings) VALUES (?, 'broll_script', NULL, ?, '[]')",
  ).run(project.id, relPath)
  onProgress(`产品介绍解说词完成: ${relPath}`)
  return { assetId: Number(info.lastInsertRowid), filePath: relPath }
}
```

- [ ] **Step 6: 跑测试确认通过**

Run: `cd packages/copywriter && npx vitest run test/broll-script.test.ts`
Expected: PASS（全部 5 条用例）

- [ ] **Step 7: 导出新模块**

检查 `packages/copywriter/src/index.ts` 的导出方式（参照 Task 1 Step 5 的做法），把 `broll-script` 模块加进去。

- [ ] **Step 8: `.gitignore` 加 `workspace/*/broll/`**

`.gitignore` 里找到这一段：

```
# workspace 运行时产物（analysis.md 等种子数据仍跟踪）
workspace/*/copy/
workspace/*/covers/
workspace/*/raw/
workspace/*/videos/
workspace/*/hf/
workspace/*/shots/
workspace/*/scripts/
workspace/*/uploads/
```

在 `workspace/*/uploads/` 后面加一行 `workspace/*/broll/`。

- [ ] **Step 9: 跑 copywriter 包全部测试确认无回归**

Run: `cd packages/copywriter && npx vitest run`
Expected: PASS（全部测试，含新增的 5 条）

- [ ] **Step 10: Commit**

```bash
cd "/Users/lizhishaoniange/Documents/开源变现内容工厂"
git add packages/copywriter/src/broll-script.ts packages/copywriter/src/fixtures/broll-script-fixture.ts \
  packages/copywriter/src/index.ts packages/copywriter/test/broll-script.test.ts \
  templates/prompts/broll-script.md .gitignore
git commit -m "feat(copywriter): 新增 generateProductIntroScript 产品介绍解说词生成"
```

---

### Task 3: forgecast broll-import CLI 命令

**Files:**
- Modify: `cli.ts`

**Interfaces:**
- 无新导出接口（CLI 命令是终端交互入口，不是被其它代码调用的函数）。

无自动化测试（本仓库 `cli.ts` 现有多数命令——包括 `scout`/`pick`/`analyze`/`rebrand`/`script`/`review-video` 等——均无测试文件，本任务遵循既有约定，走人工命令行验证）。

- [ ] **Step 1: 在 `case 'script':` 块之后新增 `case 'broll-import':`**

`cli.ts` 顶部不需要新增 import（`fs`/`path` 需要确认已导入——检查文件顶部，若 `path` 模块尚未在 `cli.ts` 顶部导入，加一行 `import path from 'node:path'`；`fs` 已经导入）。

在 `case 'script':` 块结束的 `}` 之后、`case 'review-video':` 之前插入：

```ts
    case 'broll-import': {
      const positional = rest.filter((a) => !a.startsWith('--'))
      const [slug, srcPath] = positional
      if (!slug || !srcPath) {
        console.error('用法: forgecast broll-import <slug> <本地mp4绝对路径> [--hook=<hook>]')
        process.exit(1)
      }
      if (!fs.existsSync(srcPath)) { console.error(`源文件不存在: ${srcPath}`); process.exit(1) }
      if (!/\.(mp4|mov|m4v)$/i.test(srcPath)) { console.error('仅支持 mp4/mov/m4v'); process.exit(1) }
      const ctx = ctxWithNotes()
      const project: any = ctx.db.prepare('SELECT id FROM projects WHERE slug = ?').get(slug)
      if (!project) { console.error(`项目不存在: ${slug}`); process.exit(1) }
      const safeName = path.basename(srcPath)
      const dir = path.join(ctx.config.paths.workspace, slug, 'uploads')
      fs.mkdirSync(dir, { recursive: true })
      const finalName = fs.existsSync(path.join(dir, safeName)) ? `${Date.now()}-${safeName}` : safeName
      fs.copyFileSync(srcPath, path.join(dir, finalName))
      const relPath = path.join(slug, 'uploads', finalName)
      const info = ctx.db.prepare(
        "INSERT INTO assets (project_id, type, hook, file_path, warnings, origin) VALUES (?, 'video', ?, ?, '[]', 'upload')",
      ).run(project.id, arg('hook') ?? null, relPath)
      console.log(`已登记成片: workspace/${relPath}（assetId=${Number(info.lastInsertRowid)}）`)
      console.log('可在网页「做内容」页面成片 tab 看到')
      break
    }
```

- [ ] **Step 2: 更新用法说明字符串**

`cli.ts` 末尾 `default:` 分支的用法字符串里，在 `video <slug> --tpl=flash  生成 flash 视频（渲染 copy 素材为 15s 竖屏）` 那一行之后加一行：

```
  broll-import <slug> <mp4路径> [--hook=<hook>]  登记外部产出的成片（如 erduo B-roll 定稿）为 video 素材
```

- [ ] **Step 3: 人工验证**

```bash
cd "/Users/lizhishaoniange/Documents/开源变现内容工厂"
export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH"
# 先确认有一个已存在的项目 slug（用 sqlite3 db/forgecast.db "SELECT slug FROM projects LIMIT 1;" 查一个）
# 用仓库里任意一个已有 mp4 测试文件跑一遍（若没有现成的，用 ffmpeg 生成一个 1 秒黑屏测试视频：
#   ffmpeg -f lavfi -i color=c=black:s=320x240:d=1 -y /tmp/test-broll.mp4）
npx tsx cli.ts broll-import <替换成真实slug> /tmp/test-broll.mp4 --hook=broll
```

预期：打印"已登记成片: workspace/<slug>/uploads/test-broll.mp4（assetId=N）"，`sqlite3 db/forgecast.db "SELECT * FROM assets WHERE id=N;"` 能查到这一行，`type='video', origin='upload', hook='broll'`，文件确实复制到了 `workspace/<slug>/uploads/test-broll.mp4`。测试完手动删掉这行测试数据和文件（`sqlite3 db/forgecast.db "DELETE FROM assets WHERE id=N;"` + `rm workspace/<slug>/uploads/test-broll.mp4`），不留测试脏数据。

- [ ] **Step 4: Commit**

```bash
cd "/Users/lizhishaoniange/Documents/开源变现内容工厂"
git add cli.ts
git commit -m "feat(cli): 新增 broll-import 命令，登记外部成片为 video 素材"
```

---

### Task 4: docs/broll-intro-workflow.md（操作手册）

**Files:**
- Create: `docs/broll-intro-workflow.md`

**Interfaces:**
- Consumes（文档引用，非代码依赖）：`generateProductIntroScript`（Task 2）、`synthesizeVoice`（已有）、`cuesToSrt`（Task 1）、`erduo-broll-loop-engineering` Skill（已装好）、`media-use` Skill（已装好）、`forgecast broll-import`（Task 3）。

- [ ] **Step 1: 写文档**

创建 `docs/broll-intro-workflow.md`：

```markdown
# AI 产品介绍 B-roll 视频操作手册

给某个已立项项目做一条"产品介绍"风格的 B-roll 视频，靠 Claude Code 会话人工触发、逐步执行——**没有网页按钮或自动化入口**，每次都需要用户在对话里明确提出"帮项目 X 做条产品介绍视频"。

设计背景：docs/superpowers/specs/2026-08-18-broll-intro-video-design.md

## 前提

- 项目已经 `pick` 立项，且已经跑过 `forgecast analyze <slug>` 生成 `workspace/<slug>/analysis.md`（产品介绍解说词的生成依据）。
- 本机已装好 `erduo-broll-loop-engineering` 和 `media-use` 两个 Skill（`~/.claude/skills/` 下能看到）。

## 步骤

1. **确认项目**：跟用户确认目标项目 slug，检查 `workspace/<slug>/analysis.md` 是否存在；不存在则先跑 `forgecast analyze <slug>`。

2. **生成产品介绍解说词**：调用 `generateProductIntroScript(ctx, { slug })`（`packages/copywriter/src/broll-script.ts`），产出 `workspace/<slug>/broll/script.md`。live 模式下（.env / 设置页配了真实 LLM key）会读 `analysis.md` 生成真实解说词；mock 模式下只是固定骨架，不适合直接拿去用。

3. **TTS 配音出时间轴**：调用 `synthesizeVoice(ctx, script, outPath)`（`packages/studio/src/tts.ts`）给解说词配音，拿到 `{ audioRel, cues }`。`cues` 是后续转 SRT 需要的时间轴数据。

4. **转 SRT**：调用 `cuesToSrt(cues)`（`packages/studio/src/srt.ts`），把结果写成一个 `.srt` 文件。写入路径按当时 erduo Skill 要求的输入位置来（它会在启动时说明期望 SRT 放在哪，通常是新建的产出目录里）——这是 erduo Skill 自己的接口细节，不在本文档里写死。

5. **生成概念 UI 效果图**：用 `media-use` Skill 生成 2-4 张"这个产品可能长什么样"的概念示意图，prompt 基于 `analysis.md` 里的产品描述（谁掏钱/解决什么问题/换皮方向）。**这些图没有真实依据，纯粹是概念演示**——生成时跟用户确认清楚这一点，不要让图片看起来像是"真实产品截图"。

6. **交给 erduo Skill**：用生成的 SRT + 概念图（作为 user media）调用 `erduo-broll-loop-engineering` Skill，走它自己完整的 Director → Assets → Builder → 装配预览流程。**不要跳过任何一步**，尤其是"给用户看动态预览"这一步——这是它的硬性要求，不能省略或用截图代替。

7. **用户确认**：把动态预览给用户看，收集反馈。有具体问题（比如某个 shotId 内容对不上、看不懂、发展太慢）就退回给对应的 Director 或 Builder 改，不要自己在 Parent 上下文里改内容或选素材。

8. **登记成片**：用户确认没问题、erduo Skill 出了最终 `master.mp4` 后，运行：

   ```bash
   forgecast broll-import <slug> <master.mp4的绝对路径> --hook=broll
   ```

   把成片登记进 ForgeCast 的 `assets` 表，`workspace/<slug>/uploads/` 下能看到文件，网页"做内容"页面成片 tab 能看到。

9. **标注概念图性质**：在视频描述、发布文案，或者跟用户交接时，明确提一句"视频里的 UI 画面是概念演示，不是真实产品截图"——避免观众误以为看到的是真实上线的产品界面。
```

- [ ] **Step 2: Commit**

```bash
cd "/Users/lizhishaoniange/Documents/开源变现内容工厂"
git add docs/broll-intro-workflow.md
git commit -m "docs: 新增 AI 产品介绍 B-roll 视频操作手册"
```

---

## 验证（全部任务完成后）

1. `export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH"`
2. `pnpm test` 全仓回归（重点看 `@forgecast/studio`、`@forgecast/copywriter`）
3. 人工跑一遍 Task 3 的 `broll-import` 验证步骤（若还没跑过）
4. 通读一遍 `docs/broll-intro-workflow.md`，确认九个步骤跟三个新工具的函数名/命令名对得上（尤其是函数签名跟 Task 1/2 实际实现是否一致）
