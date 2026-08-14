# 拍摄脚本+成片上传+审片打分 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 做内容主线换人机协作：从文案生成可执行拍摄脚本（新素材类型 script）→ 用户自己拍并上传成片 → 系统审片（转写+结构指标+LLM 对照脚本）出分数与建议。

**Architecture:** 脚本生成放 `packages/copywriter/src/script.ts`（文案衍生物）；转写/审片放 `packages/studio/src/review.ts`（复用 spawnWithTimeout/asr venv/ffmpeg 先例，deps 注入可测）；`assets` 表 ensureColumn 加 `origin`/`review` 两列；做内容页扩成 5 tab（文案/拍摄脚本/成片/出视频/卡点，自动渲染降辅助）。

**Tech Stack:** TypeScript + better-sqlite3 + Hono + React/Vite + vitest + ffmpeg/ffprobe + faster-whisper（可选，fail-soft）。

**Spec:** `docs/superpowers/specs/2026-08-14-shoot-review-design.md`

## Global Constraints

- 每个命令前先 `export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH"`。
- mock 模式绝不调用 `ctx.llm`（fixture 直接返回固定数据）——仓库铁律。
- 两个新提示词模板都含真实感红线（拍摄要点/审片建议不编造数字类承诺）；拍摄脚本的台词必须原样照搬口播稿。
- 转写/时长探测/抽音轨全 fail-soft（ASR 未配置或任一步失败→`degraded` 降级审，绝不让审片任务因环境缺件而失败）；LLM 审片输出校验失败则整个任务失败且不写 `assets.review`。
- 不动五个自动渲染模板与 `generateVideo` 的任何逻辑。
- 测试全部用 `fs.mkdtempSync` 临时目录建库；外部进程（ffmpeg/ffprobe/python）在单测里用 deps 注入替身，不真 spawn（server 路由测试例外：审片任务走真实 fail-soft 路径，garbage 字节的 mp4 让 ffmpeg 失败→降级审，可确定性通过）。
- 提交信息结尾带 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`。

---

### Task 1: assets 迁移 + generateShootScript（copywriter）

**Files:**
- Modify: `packages/core/src/db.ts`（迁移段 `ensureColumn(db, 'topic_sources', 'last_scraped_at', 'TEXT')` 之后追加两行）
- Create: `packages/copywriter/src/script.ts`
- Create: `packages/copywriter/src/fixtures/script-fixture.ts`
- Modify: `packages/copywriter/src/index.ts`（补 `export * from './script'`）
- Create: `templates/prompts/shoot-script.md`
- Create: `packages/copywriter/test/script.test.ts`

**Interfaces:**
- Consumes: `parseCopyOutput`（同包 parser）、`advanceStage`（core）、copy 素材行。
- Produces: `generateShootScript(ctx, {slug, assetId?, onProgress?}) => Promise<{assetId, filePath}>`；`mockShootScript(douyinScript) => string`；assets 新列 `origin`（DEFAULT 'rendered'）/`review`。

- [ ] **Step 1: db.ts 迁移两行**

在 `ensureColumn(db, 'topic_sources', 'last_scraped_at', 'TEXT')` 之后追加：

```ts
  // 迁移：视频素材来源（rendered 模板渲染 / upload 用户上传成片）与审片报告 JSON（覆盖式，同 perf 先例）
  ensureColumn(db, 'assets', 'origin', "TEXT DEFAULT 'rendered'")
  ensureColumn(db, 'assets', 'review', 'TEXT')
```

- [ ] **Step 2: 写失败测试**

`packages/copywriter/test/script.test.ts`：

```ts
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { copyFixtures, createLlmClient, loadConfig, openDb, type CoreCtx } from '@forgecast/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { generateShootScript } from '../src/script'

let ctx: CoreCtx
let root: string
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-script-'))
  const config = loadConfig(root, {}) // llm mock
  ctx = { db: openDb(config.paths.db), config, llm: createLlmClient(config.llm) }
  ctx.db.prepare("INSERT INTO projects (slug, brand_name) VALUES ('demo', '快客通')").run()
  const copyDir = path.join(root, 'workspace/demo/copy')
  fs.mkdirSync(copyDir, { recursive: true })
  fs.writeFileSync(path.join(copyDir, 'pain-1.md'), copyFixtures.pain)
  ctx.db.prepare("INSERT INTO assets (project_id, type, hook, file_path) VALUES (1, 'copy', 'pain', 'demo/copy/pain-1.md')").run()
})

describe('generateShootScript mock', () => {
  it('从最新 copy 生成脚本文件+asset 行（type=script、hook 继承），不调 ctx.llm', async () => {
    const spy = vi.spyOn(ctx.llm, 'complete')
    const r = await generateShootScript(ctx, { slug: 'demo' })
    expect(spy).not.toHaveBeenCalled()
    expect(r.filePath).toMatch(/^demo\/scripts\/pain-.*\.md$/)
    const md = fs.readFileSync(path.join(ctx.config.paths.workspace, r.filePath), 'utf8')
    expect(md).toContain('拍摄脚本')
    expect(md).toContain('【0-3s 钩子】') // 口播稿原文段落搬进骨架
    const row: any = ctx.db.prepare('SELECT * FROM assets WHERE id = ?').get(r.assetId)
    expect(row.type).toBe('script')
    expect(row.hook).toBe('pain')
  })
  it('assetId 指定的 copy 不存在/不属于该项目 → 抛错', async () => {
    await expect(generateShootScript(ctx, { slug: 'demo', assetId: 999 })).rejects.toThrow(/文案/)
  })
  it('项目没有 copy → 抛错', async () => {
    ctx.db.prepare("INSERT INTO projects (slug) VALUES ('empty')").run()
    await expect(generateShootScript(ctx, { slug: 'empty' })).rejects.toThrow(/文案/)
  })
})

describe('generateShootScript live（假 LLM）', () => {
  it('输出过短 → 抛错不落盘', async () => {
    const config = loadConfig(root, { FORGECAST_LLM_MODE: 'live', FORGECAST_LLM_KEY: 'k' })
    config.paths.templates = path.resolve(__dirname, '../../../templates')
    const lctx: CoreCtx = { db: ctx.db, config, llm: { complete: vi.fn(async () => '太短') } as any }
    await expect(generateShootScript(lctx, { slug: 'demo' })).rejects.toThrow(/过短/)
    expect(ctx.db.prepare("SELECT COUNT(*) n FROM assets WHERE type='script'").get()).toEqual({ n: 0 })
  })
})
```

Run: `pnpm --filter @forgecast/copywriter exec vitest run test/script.test.ts` → FAIL（script.ts 不存在）

- [ ] **Step 3: fixture**

`packages/copywriter/src/fixtures/script-fixture.ts`：

```ts
/** mock 拍摄脚本：把口播脚本原文逐段搬进固定骨架。绝不调用 ctx.llm（仓库铁律）。 */
export function mockShootScript(douyinScript: string): string {
  return [
    '# 拍摄脚本（mock）',
    '',
    '## 开拍前准备',
    '- 手机竖屏 1080×1920，光线充足',
    '- 台词打印或提词器就位',
    '',
    '## 分镜表',
    '',
    douyinScript.trim(),
    '',
    '## 剪辑提示',
    '- mock 模式骨架：live 模式会为每镜补机位/景别/道具/拍摄要点',
  ].join('\n')
}
```

- [ ] **Step 4: script.ts**

`packages/copywriter/src/script.ts`：

```ts
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { advanceStage, type CoreCtx } from '@forgecast/core'
import { mockShootScript } from './fixtures/script-fixture'
import { parseCopyOutput } from './parser'

export interface ShootScriptResult { assetId: number; filePath: string }

/**
 * 从指定/最新 copy 素材扩展生成可执行拍摄脚本（分镜表+开拍准备清单），写 workspace/<slug>/scripts/
 * 并登记 type='script' 素材（hook 继承 copy）。mock 走 fixture（口播稿逐段搬进骨架，绝不调 ctx.llm）。
 * 台词一律原样照搬口播稿——脚本是执行指导，不是二次创作（提示词红线）。
 */
export async function generateShootScript(
  ctx: CoreCtx,
  input: { slug: string; assetId?: number; onProgress?: (msg: string) => void },
): Promise<ShootScriptResult> {
  const { slug, onProgress = () => {} } = input
  const project: any = ctx.db.prepare('SELECT * FROM projects WHERE slug = ?').get(slug)
  if (!project) throw new Error(`项目不存在: ${slug}`)
  const copy: any = input.assetId
    ? ctx.db.prepare("SELECT * FROM assets WHERE id = ? AND project_id = ? AND type = 'copy'").get(input.assetId, project.id)
    : ctx.db.prepare("SELECT * FROM assets WHERE project_id = ? AND type = 'copy' ORDER BY id DESC LIMIT 1").get(project.id)
  if (!copy) throw new Error(`没有可用的文案素材（先生成文案）: ${slug}`)

  onProgress('解析文案…')
  const doc = parseCopyOutput(fs.readFileSync(path.join(ctx.config.paths.workspace, copy.file_path), 'utf8'))

  let md: string
  if (ctx.config.llm.mode === 'mock') {
    onProgress('mock 模式：使用固定拍摄脚本骨架…')
    md = mockShootScript(doc.douyinScript)
  } else {
    onProgress('生成拍摄脚本（live 模式）…')
    const tpl = fs.readFileSync(path.join(ctx.config.paths.templates, 'prompts', 'shoot-script.md'), 'utf8')
    const system = '你是短视频拍摄导演，输出可直接照着拍的拍摄脚本，只输出 markdown。'
    const prompt = [tpl, `【口播脚本】\n${doc.douyinScript}`].join('\n\n---\n\n')
    md = await ctx.llm.complete({ model: ctx.config.llm.models.copy, system, prompt })
    if (md.trim().length < 100) throw new Error('拍摄脚本输出过短，疑似生成失败')
  }

  const dir = path.join(ctx.config.paths.workspace, slug, 'scripts')
  fs.mkdirSync(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const fileName = `${copy.hook ?? 'script'}-${stamp}-${randomBytes(4).toString('hex')}.md`
  const relPath = path.join(slug, 'scripts', fileName)
  fs.writeFileSync(path.join(dir, fileName), md, 'utf8')
  const info = ctx.db.prepare(
    'INSERT INTO assets (project_id, type, hook, file_path, warnings) VALUES (?, ?, ?, ?, ?)',
  ).run(project.id, 'script', copy.hook, relPath, '[]')
  advanceStage(ctx.db, project.id, 'producing')
  onProgress(`拍摄脚本完成: ${relPath}`)
  return { assetId: Number(info.lastInsertRowid), filePath: relPath }
}
```

`packages/copywriter/src/index.ts` 追加 `export * from './script'`。

- [ ] **Step 5: 提示词模板**

`templates/prompts/shoot-script.md`：

```markdown
你是短视频拍摄导演。把下方口播脚本扩展成一份"照着就能拍"的拍摄脚本，输出 markdown。

【输出结构】
# 拍摄脚本
## 开拍前准备
<清单：设备/场地/道具/着装等，逐条>
## 分镜表
逐镜输出，每镜格式：
### 镜N【时间段 段落名】
- 画面：<具体拍什么：机位、景别（特写/中景/近景）、真人出镜还是录屏、画面里出现什么>
- 台词：<原样照搬口播脚本的台词，一字不改>
- 拍摄要点：<怎么拍好这一镜：运镜/表情/节奏/常见翻车点>
## 剪辑提示
<转场/字幕/BGM 建议，逐条>

【红线】
- 台词必须原样照搬口播脚本，不改写不增删（脚本是执行指导，不是二次创作）
- 拍摄要点不编造数字类效果承诺（不说"这样拍播放翻X倍"这类话）
```

- [ ] **Step 6: 跑测试 + 全仓回归 + 提交**

Run: `pnpm --filter @forgecast/copywriter test` 全绿；`pnpm test` 全仓回归。

```bash
git add packages/core/src/db.ts packages/copywriter templates/prompts/shoot-script.md
git commit -m "feat(copywriter): generateShootScript 拍摄脚本生成 + assets origin/review 迁移

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: 转写脚本 + review.ts 基础件（studio）

**Files:**
- Create: `packages/studio/scripts/asr_transcribe.py`
- Create: `packages/studio/src/review.ts`（本任务只含 probeDuration/extractAudioWav/transcribeAudio 三个基础件与类型；reviewVideo 是 Task 3）
- Modify: `packages/studio/src/index.ts`（补 `export * from './review'`）
- Create: `packages/studio/test/review-base.test.ts`

**Interfaces:**
- Consumes: `spawnWithTimeout`（同包 hyperframes）、`ctx.config.tts.asrPython`。
- Produces: `probeDuration(mp4Abs) => Promise<number|null>`；`extractAudioWav(mp4Abs, wavAbs, deps?)`；`transcribeAudio(wavAbs, asrPython, deps?) => Promise<TranscribeResult|null>`；类型 `TranscribeResult`/`ReviewDeps`。

- [ ] **Step 1: 写失败测试**

`packages/studio/test/review-base.test.ts`：

```ts
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { extractAudioWav, probeDuration, transcribeAudio } from '../src/review'

describe('transcribeAudio（fail-soft）', () => {
  it('asrPython 为空 → null 不 spawn', async () => {
    expect(await transcribeAudio('/tmp/x.wav', '')).toBeNull()
  })
  it('脚本输出合法 → 解析返回 text+segments', async () => {
    const r = await transcribeAudio('/tmp/x.wav', '/fake/python', {
      runTranscribe: async (args) => {
        fs.writeFileSync(args[2], JSON.stringify({ ok: true, text: '你好世界', segments: [{ start: 0, end: 1.2, text: '你好世界' }] }))
      },
    })
    expect(r).toEqual({ text: '你好世界', segments: [{ start: 0, end: 1.2, text: '你好世界' }] })
  })
  it('脚本报 ok:false / 进程崩溃 → null', async () => {
    const r1 = await transcribeAudio('/tmp/x.wav', '/fake/python', {
      runTranscribe: async (args) => { fs.writeFileSync(args[2], JSON.stringify({ ok: false, reason: '静音' })) },
    })
    expect(r1).toBeNull()
    const r2 = await transcribeAudio('/tmp/x.wav', '/fake/python', {
      runTranscribe: async () => { throw new Error('boom') },
    })
    expect(r2).toBeNull()
  })
})

describe('extractAudioWav', () => {
  it('组装 ffmpeg 参数：-vn -ar 16000 -ac 1', async () => {
    let seen: string[] = []
    await extractAudioWav('/a/in.mp4', '/a/out.wav', { runFfmpeg: async (args) => { seen = args } })
    expect(seen).toEqual(['-y', '-i', '/a/in.mp4', '-vn', '-ar', '16000', '-ac', '1', '/a/out.wav'])
  })
})

describe('probeDuration（fail-soft）', () => {
  it('文件不存在 → null 不抛', async () => {
    expect(await probeDuration(path.join(os.tmpdir(), 'fc-nope-does-not-exist.mp4'))).toBeNull()
  })
})
```

Run: `pnpm --filter @forgecast/studio exec vitest run test/review-base.test.ts` → FAIL

- [ ] **Step 2: asr_transcribe.py**

`packages/studio/scripts/asr_transcribe.py`：

```python
#!/usr/bin/env python
"""成片转写：<python> asr_transcribe.py <wav> <out.json>
faster-whisper 全文转写（中文），输出 {"ok": true, "text": ..., "segments": [{"start","end","text"}]}
或 {"ok": false, "reason": ...}。与 asr_align.py 共用同一 venv（FORGECAST_ASR_PYTHON，
回落 FORGECAST_MELO_PYTHON；见 docs/hyperframes-deploy.md）。"""
import json
import sys

MODEL_SIZE = "small"


def fail(out_path, reason):
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump({"ok": False, "reason": reason}, f)


def main():
    wav_path, out_path = sys.argv[1], sys.argv[2]
    from faster_whisper import WhisperModel

    model = WhisperModel(MODEL_SIZE, device="cpu", compute_type="int8")
    segments, _ = model.transcribe(wav_path, language="zh")
    segs = [
        {"start": round(s.start, 3), "end": round(s.end, 3), "text": s.text.strip()}
        for s in segments if s.text.strip()
    ]
    if not segs:
        return fail(out_path, "未识别出任何文字（可能是静音音轨）")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump({"ok": True, "text": "".join(x["text"] for x in segs), "segments": segs}, f)


if __name__ == "__main__":
    main()
```

- [ ] **Step 3: review.ts 基础件**

`packages/studio/src/review.ts`（本任务版本，Task 3 再追加 reviewVideo）：

```ts
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { spawnWithTimeout } from './hyperframes'

const pExecFile = promisify(execFile)
const TRANSCRIBE_SCRIPT = fileURLToPath(new URL('../scripts/asr_transcribe.py', import.meta.url))
const FFMPEG_TIMEOUT_MS = 180_000
const TRANSCRIBE_TIMEOUT_MS = 300_000

export interface TranscribeResult { text: string; segments: Array<{ start: number; end: number; text: string }> }
/** 外部进程注入点（测试替身用）：ffmpeg 抽音轨 / python 转写 / ffprobe 时长 */
export interface ReviewDeps {
  runFfmpeg?: (args: string[]) => Promise<void>
  runTranscribe?: (args: string[]) => Promise<void>
  probe?: (mp4Abs: string) => Promise<number | null>
}

/** ffprobe 读时长（秒）；ffprobe 缺失/文件坏/解析失败一律返 null（fail-soft，绝不抛错） */
export async function probeDuration(mp4Abs: string): Promise<number | null> {
  try {
    const { stdout } = await pExecFile('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', mp4Abs])
    const v = Number(stdout.trim())
    return Number.isFinite(v) && v > 0 ? v : null
  } catch {
    return null
  }
}

/** 抽音轨为 16k 单声道 wav（faster-whisper 输入）；超时 kill（spawnWithTimeout），失败抛错由调用方兜 */
export async function extractAudioWav(mp4Abs: string, wavAbs: string, deps: ReviewDeps = {}): Promise<void> {
  const run = deps.runFfmpeg ?? ((args: string[]) => spawnWithTimeout(args, { cmd: 'ffmpeg', timeoutMs: FFMPEG_TIMEOUT_MS, label: 'ffmpeg extract-audio' }))
  await run(['-y', '-i', mp4Abs, '-vn', '-ar', '16000', '-ac', '1', wavAbs])
}

/**
 * 本地 faster-whisper 全文转写。asrPython 为空、脚本超时/崩溃/输出非法均返 null——
 * 调用方据此降级为"未转写仅结构审"，这里绝不抛错（同 alignCues 的 fail-soft 风格）。
 */
export async function transcribeAudio(wavAbs: string, asrPython: string, deps: ReviewDeps = {}): Promise<TranscribeResult | null> {
  if (!asrPython) return null
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-trans-'))
  const outPath = path.join(dir, 'out.json')
  try {
    const run = deps.runTranscribe ?? ((args: string[]) => spawnWithTimeout(args, { cmd: asrPython, timeoutMs: TRANSCRIBE_TIMEOUT_MS, label: 'asr_transcribe' }))
    await run([TRANSCRIBE_SCRIPT, wavAbs, outPath])
    const result = JSON.parse(fs.readFileSync(outPath, 'utf8'))
    if (!result.ok || typeof result.text !== 'string' || !Array.isArray(result.segments)) return null
    return { text: result.text, segments: result.segments }
  } catch {
    return null
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}
```

`packages/studio/src/index.ts` 追加 `export * from './review'`。

- [ ] **Step 4: 跑测试 + 提交**

Run: `pnpm --filter @forgecast/studio exec vitest run test/review-base.test.ts` → PASS（5 条）

```bash
git add packages/studio/scripts/asr_transcribe.py packages/studio/src/review.ts packages/studio/src/index.ts packages/studio/test/review-base.test.ts
git commit -m "feat(studio): asr_transcribe.py 全文转写 + review 基础件（时长/抽音轨/转写，全 fail-soft）

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: reviewVideo 审片主流程（studio）

**Files:**
- Modify: `packages/studio/src/review.ts`（追加 reviewVideo 及解析/类型）
- Create: `packages/studio/src/fixtures/review-fixture.ts`
- Create: `templates/prompts/video-review.md`
- Create: `packages/studio/test/review.test.ts`

**Interfaces:**
- Consumes: Task 2 三基础件、`parseCopyOutput`（`@forgecast/copywriter`，studio 已依赖）、assets 表（script/copy/video 行、review 列）。
- Produces: `reviewVideo(ctx, videoAssetId, {scriptAssetId?, onProgress?, deps?}) => Promise<ReviewReport>`；类型 `ReviewReport`/`ReviewScores`/`ReviewDraft`。

- [ ] **Step 1: 写失败测试**

`packages/studio/test/review.test.ts`：

```ts
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { copyFixtures, createLlmClient, loadConfig, openDb, type CoreCtx } from '@forgecast/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { reviewVideo, type ReviewDeps } from '../src/review'

let ctx: CoreCtx
let root: string
const okDeps: ReviewDeps = {
  probe: async () => 30,
  runFfmpeg: async () => {},
  runTranscribe: async (args) => {
    fs.writeFileSync(args[2], JSON.stringify({
      ok: true, text: '接外包的兄弟这句话你熟不熟每个项目都从零搭', segments: [
        { start: 0.2, end: 2.5, text: '接外包的兄弟这句话你熟不熟' },
        { start: 3.0, end: 6.0, text: '每个项目都从零搭' },
      ],
    }))
  },
}
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-review-'))
  const config = loadConfig(root, { FORGECAST_ASR_PYTHON: '/fake/python' }) // llm mock；asrPython 配上让转写走 deps 替身
  ctx = { db: openDb(config.paths.db), config, llm: createLlmClient(config.llm) }
  ctx.db.prepare("INSERT INTO projects (slug) VALUES ('demo')").run()
  const copyDir = path.join(root, 'workspace/demo/copy')
  fs.mkdirSync(copyDir, { recursive: true })
  fs.writeFileSync(path.join(copyDir, 'pain-1.md'), copyFixtures.pain)
  ctx.db.prepare("INSERT INTO assets (project_id, type, hook, file_path) VALUES (1, 'copy', 'pain', 'demo/copy/pain-1.md')").run()
  const upDir = path.join(root, 'workspace/demo/uploads')
  fs.mkdirSync(upDir, { recursive: true })
  fs.writeFileSync(path.join(upDir, 'take1.mp4'), 'FAKE_MP4')
  ctx.db.prepare("INSERT INTO assets (project_id, type, file_path, origin) VALUES (1, 'video', 'demo/uploads/take1.mp4', 'upload')").run()
})
const videoId = () => (ctx.db.prepare("SELECT id FROM assets WHERE type='video'").get() as any).id

describe('reviewVideo mock', () => {
  it('全链路：转写成功 → 报告含 transcript/metrics、写 assets.review、不调 ctx.llm', async () => {
    const spy = vi.spyOn(ctx.llm, 'complete')
    const r = await reviewVideo(ctx, videoId(), { deps: okDeps })
    expect(spy).not.toHaveBeenCalled()
    expect(r.scores.overall).toBeGreaterThan(0)
    expect(r.suggestions.length).toBeGreaterThan(0)
    expect(r.transcript).toContain('接外包')
    expect(r.metrics.durationSec).toBe(30)
    expect(r.metrics.charsPerSec).toBeGreaterThan(0)
    expect(r.degraded).toBeUndefined()
    const row: any = ctx.db.prepare('SELECT review FROM assets WHERE id = ?').get(videoId())
    expect(JSON.parse(row.review).scores.overall).toBe(r.scores.overall)
  })
  it('转写失败 → degraded 降级但仍出报告', async () => {
    const r = await reviewVideo(ctx, videoId(), { deps: { ...okDeps, runTranscribe: async () => { throw new Error('boom') } } })
    expect(r.degraded).toMatch(/未转写/)
    expect(r.transcript).toBeUndefined()
    expect(r.scores.overall).toBeGreaterThan(0)
  })
  it('对照基准回落链：无 script 时用最新 copy 口播稿（scriptAssetId 字段缺省）', async () => {
    const r = await reviewVideo(ctx, videoId(), { deps: okDeps })
    expect(r.scriptAssetId).toBeUndefined()
  })
  it('有 script 素材时自动选中并记 scriptAssetId', async () => {
    const sDir = path.join(root, 'workspace/demo/scripts')
    fs.mkdirSync(sDir, { recursive: true })
    fs.writeFileSync(path.join(sDir, 's1.md'), '# 拍摄脚本')
    ctx.db.prepare("INSERT INTO assets (project_id, type, file_path) VALUES (1, 'script', 'demo/scripts/s1.md')").run()
    const r = await reviewVideo(ctx, videoId(), { deps: okDeps })
    expect(r.scriptAssetId).toBeTypeOf('number')
  })
  it('素材不存在/指定脚本不存在 → 抛错', async () => {
    await expect(reviewVideo(ctx, 9999, { deps: okDeps })).rejects.toThrow(/不存在/)
    await expect(reviewVideo(ctx, videoId(), { scriptAssetId: 9999, deps: okDeps })).rejects.toThrow(/不存在/)
  })
})

describe('reviewVideo live（假 LLM）', () => {
  it('LLM 输出非法（分数越界）→ 抛错且不写 review 列', async () => {
    const config = loadConfig(root, { FORGECAST_LLM_MODE: 'live', FORGECAST_LLM_KEY: 'k', FORGECAST_ASR_PYTHON: '/fake/python' })
    config.paths.templates = path.resolve(__dirname, '../../../templates')
    const lctx: CoreCtx = { db: ctx.db, config, llm: { complete: vi.fn(async () => JSON.stringify({ scores: { hook: 150, pacing: 1, fidelity: 1, cta: 1, overall: 1 }, suggestions: ['x'] })) } as any }
    await expect(reviewVideo(lctx, videoId(), { deps: okDeps })).rejects.toThrow(/非法/)
    const row: any = ctx.db.prepare('SELECT review FROM assets WHERE id = ?').get(videoId())
    expect(row.review).toBeNull()
  })
})
```

Run → FAIL（reviewVideo 不存在）

- [ ] **Step 2: fixture**

`packages/studio/src/fixtures/review-fixture.ts`：

```ts
export interface ReviewScores { hook: number; pacing: number; fidelity: number; cta: number; overall: number }
export interface ReviewDraft { scores: ReviewScores; suggestions: string[] }

/** mock 审片：固定分数与建议。绝不调用 ctx.llm（仓库铁律）。 */
export function mockReviewReport(): ReviewDraft {
  return {
    scores: { hook: 70, pacing: 65, fidelity: 75, cta: 60, overall: 68 },
    suggestions: [
      '前3秒直接抛出痛点钩子，别先自我介绍',
      '结尾 CTA 停顿一拍再说，给观众反应时间（mock 示例）',
    ],
  }
}
```

- [ ] **Step 3: review.ts 追加 reviewVideo**

在 `review.ts` 末尾追加（import 区补 `import type { CoreCtx } from '@forgecast/core'`、`import { parseCopyOutput } from '@forgecast/copywriter'`、`import { mockReviewReport, type ReviewDraft, type ReviewScores } from './fixtures/review-fixture'`，并 `export type { ReviewDraft, ReviewScores } from './fixtures/review-fixture'`）：

```ts
export interface ReviewReport {
  scores: ReviewScores
  suggestions: string[]
  transcript?: string
  metrics: { durationSec: number | null; charCount: number; charsPerSec: number | null }
  scriptAssetId?: number
  degraded?: string
  reviewedAt: string
}

function stripFence(raw: string): string {
  return raw.trim().replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/```\s*$/, '').trim()
}

function parseReviewJson(raw: string): ReviewDraft {
  const v = JSON.parse(stripFence(raw))
  const s = v?.scores
  const scoresOk = s && (['hook', 'pacing', 'fidelity', 'cta', 'overall'] as const)
    .every((k) => typeof s[k] === 'number' && s[k] >= 0 && s[k] <= 100)
  if (!scoresOk || !Array.isArray(v.suggestions) || !v.suggestions.length) {
    throw new Error(`审片输出非法（需 scores 五项 0-100 + suggestions 非空）: ${raw.slice(0, 120)}`)
  }
  return { scores: s, suggestions: v.suggestions.map(String) }
}

/**
 * 审片主流程：时长探测→抽音轨→转写（三步全 fail-soft，失败降级 degraded）→结构指标→
 * LLM 对照基准评分（mock 走 fixture；输出校验失败整体抛错不写 review）→覆盖写 assets.review。
 * 对照基准回落链：scriptAssetId 指定 → 项目最新 script → 最新 copy 口播稿 → 无基准通用审。
 */
export async function reviewVideo(
  ctx: CoreCtx, videoAssetId: number,
  opts: { scriptAssetId?: number; onProgress?: (msg: string) => void; deps?: ReviewDeps } = {},
): Promise<ReviewReport> {
  const { onProgress = () => {}, deps = {} } = opts
  const asset: any = ctx.db.prepare("SELECT * FROM assets WHERE id = ? AND type = 'video'").get(videoAssetId)
  if (!asset) throw new Error(`视频素材不存在: #${videoAssetId}`)
  const mp4Abs = path.join(ctx.config.paths.workspace, asset.file_path)
  if (!fs.existsSync(mp4Abs)) throw new Error(`视频文件不存在: ${asset.file_path}`)

  onProgress('读取时长…')
  const durationSec = deps.probe ? await deps.probe(mp4Abs) : await probeDuration(mp4Abs)

  let baseline = ''
  let scriptAssetId: number | undefined
  if (opts.scriptAssetId !== undefined) {
    const s: any = ctx.db.prepare("SELECT * FROM assets WHERE id = ? AND type = 'script'").get(opts.scriptAssetId)
    if (!s) throw new Error(`拍摄脚本不存在: #${opts.scriptAssetId}`)
    baseline = fs.readFileSync(path.join(ctx.config.paths.workspace, s.file_path), 'utf8')
    scriptAssetId = s.id
  } else {
    const s: any = ctx.db.prepare("SELECT * FROM assets WHERE project_id = ? AND type = 'script' ORDER BY id DESC LIMIT 1").get(asset.project_id)
    if (s) {
      baseline = fs.readFileSync(path.join(ctx.config.paths.workspace, s.file_path), 'utf8')
      scriptAssetId = s.id
    } else {
      const cp: any = ctx.db.prepare("SELECT * FROM assets WHERE project_id = ? AND type = 'copy' ORDER BY id DESC LIMIT 1").get(asset.project_id)
      if (cp) {
        try { baseline = parseCopyOutput(fs.readFileSync(path.join(ctx.config.paths.workspace, cp.file_path), 'utf8')).douyinScript } catch { baseline = '' }
      }
    }
  }

  let transcript: TranscribeResult | null = null
  let degraded: string | undefined
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-review-'))
  try {
    onProgress('抽取音轨…')
    const wavAbs = path.join(tmp, 'audio.wav')
    try {
      await extractAudioWav(mp4Abs, wavAbs, deps)
      onProgress('转写台词…')
      transcript = await transcribeAudio(wavAbs, ctx.config.tts.asrPython, deps)
    } catch {
      transcript = null // 抽音轨失败也走降级（如无音轨/文件损坏）
    }
    if (!transcript) degraded = '未转写（ASR 未配置或音轨处理失败），仅按时长与脚本给结构建议'
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }

  const charCount = transcript?.text.length ?? 0
  const metrics = {
    durationSec, charCount,
    charsPerSec: transcript && durationSec ? +(charCount / durationSec).toFixed(2) : null,
  }

  onProgress('审片评分…')
  let draft: ReviewDraft
  if (ctx.config.llm.mode === 'mock') {
    draft = mockReviewReport()
  } else {
    const tpl = fs.readFileSync(path.join(ctx.config.paths.templates, 'prompts', 'video-review.md'), 'utf8')
    const system = '你是短视频内容教练，只输出给定 JSON 结构，不要多余文字。'
    const first3s = transcript ? transcript.segments.filter((s) => s.start < 3).map((s) => s.text).join('') : ''
    const prompt = [
      tpl,
      `【结构指标】时长 ${durationSec ?? '未知'} 秒；转写字数 ${charCount}；语速 ${metrics.charsPerSec ?? '未知'} 字/秒；前3秒台词：${first3s || '（无转写）'}`,
      baseline ? `【拍摄脚本基准】\n${baseline}` : '【拍摄脚本基准】（无——按通用短视频结构审）',
      transcript ? `【成片转写】\n${transcript.text}` : '【成片转写】（未转写）',
    ].join('\n\n---\n\n')
    draft = parseReviewJson(await ctx.llm.complete({ model: ctx.config.llm.models.copy, system, prompt }))
  }

  const report: ReviewReport = {
    scores: draft.scores,
    suggestions: draft.suggestions,
    ...(transcript && { transcript: transcript.text }),
    metrics,
    ...(scriptAssetId !== undefined && { scriptAssetId }),
    ...(degraded && { degraded }),
    reviewedAt: new Date().toISOString(),
  }
  ctx.db.prepare('UPDATE assets SET review = ? WHERE id = ?').run(JSON.stringify(report), videoAssetId)
  onProgress(`审片完成：总分 ${report.scores.overall}`)
  return report
}
```

- [ ] **Step 4: 提示词模板**

`templates/prompts/video-review.md`：

```markdown
你是短视频内容教练。根据结构指标、拍摄脚本基准和成片转写，为这条视频打分并给改进建议。

【评分维度（各 0-100）】
- hook：前3秒是否抛出抓人钩子（有转写看台词，无转写按时长与脚本推断并保守给分）
- pacing：节奏（语速是否拖沓/过快、时长是否匹配平台习惯）
- fidelity：与拍摄脚本基准的贴合度（有基准时对照段落完整性；无基准给中性分并在建议里说明）
- cta：结尾是否有清晰行动号召
- overall：综合

【输出格式】只输出 JSON，不要任何其他文字：
{ "scores": { "hook": 0-100, "pacing": 0-100, "fidelity": 0-100, "cta": 0-100, "overall": 0-100 }, "suggestions": ["<具体可执行的改进建议，按重要度排序，3-6 条>"] }

【真实感红线】建议里不得编造数据类断言（不说"这样改播放能翻X倍"），只说做法与理由。
```

- [ ] **Step 5: 跑测试 + 全仓回归 + 提交**

Run: `pnpm --filter @forgecast/studio test` 全绿；`pnpm test`。

```bash
git add packages/studio/src/review.ts packages/studio/src/fixtures/review-fixture.ts templates/prompts/video-review.md packages/studio/test/review.test.ts
git commit -m "feat(studio): reviewVideo 审片主流程（转写+指标+LLM 对照脚本评分）

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: server 三路由（script/upload-video/review）

**Files:**
- Modify: `packages/server/src/app.ts`
- Create: `packages/server/test/shoot-review.test.ts`

**Interfaces:**
- Produces: `POST /api/projects/:slug/script`（队列）、`POST /api/projects/:slug/upload-video`（multipart，白名单 mp4/mov/m4v，登记 origin='upload' 素材）、`POST /api/assets/:id/review`（队列）；MIME 表补 `.mov`。

- [ ] **Step 1: 写失败测试**

`packages/server/test/shoot-review.test.ts`（beforeEach/runTask 照抄 `test/demand.test.ts` 模式，mkdtemp 前缀 `fc-shoot-`；seed 与 `test/video.test.ts` 相同的 demo 项目 + copy fixture）：

```ts
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { copyFixtures, createLlmClient, loadConfig, openDb, type CoreCtx } from '@forgecast/core'
import { beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/app'
import { createTaskQueue } from '../src/tasks'

let ctx: CoreCtx
let app: ReturnType<typeof createApp>
let queue: ReturnType<typeof createTaskQueue>
function wait(ms: number) { return new Promise((r) => setTimeout(r, ms)) }

beforeEach(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-shoot-'))
  const config = loadConfig(root, {})
  ctx = { db: openDb(config.paths.db), config, llm: createLlmClient(config.llm) }
  ctx.db.prepare("INSERT INTO projects (slug) VALUES ('demo')").run()
  const copyDir = path.join(root, 'workspace/demo/copy')
  fs.mkdirSync(copyDir, { recursive: true })
  fs.writeFileSync(path.join(copyDir, 'pain-1.md'), copyFixtures.pain)
  ctx.db.prepare("INSERT INTO assets (project_id, type, hook, file_path) VALUES (1, 'copy', 'pain', 'demo/copy/pain-1.md')").run()
  queue = createTaskQueue()
  app = createApp(ctx, queue)
})

async function runTask(taskId: string) {
  for (let i = 0; i < 200; i++) {
    await wait(20)
    const s = queue.get(taskId)!.status
    if (s === 'done') return
    if (s === 'failed') throw new Error(queue.get(taskId)!.events.at(-1)!.message)
  }
  throw new Error('任务超时')
}

function fakeVideoForm(name: string): FormData {
  const fd = new FormData()
  fd.append('file', new File(['FAKE_MP4_BYTES'], name, { type: 'video/mp4' }))
  return fd
}

describe('拍摄脚本/成片上传/审片', () => {
  it('POST script → 任务完成 → type=script 素材落库', async () => {
    const { taskId } = await (await app.request('/api/projects/demo/script', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    })).json() as any
    await runTask(taskId)
    const rows = ctx.db.prepare("SELECT * FROM assets WHERE type='script'").all() as any[]
    expect(rows).toHaveLength(1)
    expect(fs.existsSync(path.join(ctx.config.paths.workspace, rows[0].file_path))).toBe(true)
  })
  it('upload-video：缺 file 400、坏扩展名 400、mp4 成功 → origin=upload 素材+文件落盘', async () => {
    expect((await app.request('/api/projects/demo/upload-video', { method: 'POST', body: new FormData() })).status).toBe(400)
    const bad = new FormData()
    bad.append('file', new File(['x'], 'x.txt'))
    expect((await app.request('/api/projects/demo/upload-video', { method: 'POST', body: bad })).status).toBe(400)
    const r = await (await app.request('/api/projects/demo/upload-video', { method: 'POST', body: fakeVideoForm('take1.mp4') })).json() as any
    expect(r.ok).toBe(true)
    const row: any = ctx.db.prepare('SELECT * FROM assets WHERE id = ?').get(r.assetId)
    expect(row.type).toBe('video')
    expect(row.origin).toBe('upload')
    expect(fs.existsSync(path.join(ctx.config.paths.workspace, row.file_path))).toBe(true)
  })
  it('未知项目上传 → 404', async () => {
    expect((await app.request('/api/projects/nope/upload-video', { method: 'POST', body: fakeVideoForm('a.mp4') })).status).toBe(404)
  })
  it('review 任务：garbage mp4 → ffmpeg 失败走降级审（degraded）仍写 review', async () => {
    const up = await (await app.request('/api/projects/demo/upload-video', { method: 'POST', body: fakeVideoForm('take2.mp4') })).json() as any
    const { taskId } = await (await app.request(`/api/assets/${up.assetId}/review`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    })).json() as any
    await runTask(taskId)
    const row: any = ctx.db.prepare('SELECT review FROM assets WHERE id = ?').get(up.assetId)
    const report = JSON.parse(row.review)
    expect(report.scores.overall).toBeGreaterThan(0)
    expect(report.degraded).toMatch(/未转写/)
  })
  it('review 不存在的素材 → 任务失败', async () => {
    const { taskId } = await (await app.request('/api/assets/9999/review', { method: 'POST', body: '{}' })).json() as any
    await expect(runTask(taskId)).rejects.toThrow(/不存在/)
  })
})
```

（降级审测试依赖本机 ffmpeg 存在：garbage 字节让它非零退出→`extractAudioWav` 抛→被兜→degraded。mock LLM 走 fixture，全程确定性。）

- [ ] **Step 2: 跑测试确认失败**（404）

- [ ] **Step 3: 实现路由**

`app.ts` import 区：`@forgecast/copywriter` 行补 `generateShootScript`；`@forgecast/studio` 行补 `reviewVideo`。在 `POST /api/projects/:slug/screens` 路由之后插入：

```ts
  // —— 拍摄脚本（LLM 从文案扩展分镜表）/ 成片上传 / 审片（人机协作主线）——
  app.post('/api/projects/:slug/script', async (c) => {
    const slug = c.req.param('slug')
    if (!ctx.db.prepare('SELECT id FROM projects WHERE slug = ?').get(slug)) return c.json({ error: '项目不存在' }, 404)
    const body = await c.req.json().catch(() => ({}))
    const taskId = queue.enqueue((log) => generateShootScript(ctx, {
      slug, assetId: typeof body.assetId === 'number' ? body.assetId : undefined, onProgress: log,
    }))
    return c.json({ taskId })
  })

  app.post('/api/projects/:slug/upload-video', async (c) => {
    const slug = c.req.param('slug')
    const project: any = ctx.db.prepare('SELECT id FROM projects WHERE slug = ?').get(slug)
    if (!project) return c.json({ error: '项目不存在' }, 404)
    const body = await c.req.parseBody()
    const file = body.file
    if (!(file instanceof File)) return c.json({ error: '缺少 file 字段' }, 400)
    const safeName = path.basename(file.name)
    if (!/\.(mp4|mov|m4v)$/i.test(safeName)) return c.json({ error: '仅支持 mp4/mov/m4v' }, 400)
    const dir = path.join(ctx.config.paths.workspace, slug, 'uploads')
    fs.mkdirSync(dir, { recursive: true })
    // 同名文件不覆盖旧成片：加时间戳前缀（旧素材行还指着旧文件）
    const finalName = fs.existsSync(path.join(dir, safeName)) ? `${Date.now()}-${safeName}` : safeName
    fs.writeFileSync(path.join(dir, finalName), Buffer.from(await file.arrayBuffer()))
    const relPath = path.join(slug, 'uploads', finalName)
    const info = ctx.db.prepare(
      "INSERT INTO assets (project_id, type, hook, file_path, warnings, origin) VALUES (?, 'video', NULL, ?, '[]', 'upload')",
    ).run(project.id, relPath)
    return c.json({ ok: true, assetId: Number(info.lastInsertRowid), name: finalName })
  })

  app.post('/api/assets/:id/review', async (c) => {
    const id = Number(c.req.param('id'))
    const body = await c.req.json().catch(() => ({}))
    const taskId = queue.enqueue((log) => reviewVideo(ctx, id, {
      scriptAssetId: typeof body.scriptAssetId === 'number' ? body.scriptAssetId : undefined, onProgress: log,
    }))
    return c.json({ taskId })
  })
```

MIME 表补：`'.mov': 'video/quicktime',`。

- [ ] **Step 4: 跑测试 + 全服务回归 + 提交**

Run: `pnpm --filter @forgecast/server test`

```bash
git add packages/server/src/app.ts packages/server/test/shoot-review.test.ts
git commit -m "feat(server): script/upload-video/review 三路由（人机协作主线）

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: CLI script / review-video 子命令 + 真实冒烟

**Files:**
- Modify: `cli.ts`

- [ ] **Step 1: 实现**

import 区：`@forgecast/copywriter` 行补 `generateShootScript`；`@forgecast/studio` 行补 `reviewVideo`。在 `case 'video':` 块之后插入：

```ts
    case 'script': {
      const slug = rest.find((a) => !a.startsWith('--'))
      if (!slug) { console.error('用法: forgecast script <slug> [--asset=<copyId>]'); process.exit(1) }
      const ctx = ctxWithNotes()
      const assetArg = arg('asset')
      const { filePath } = await generateShootScript(ctx, {
        slug, assetId: assetArg ? Number(assetArg) : undefined, onProgress: (m) => console.log(`  ${m}`),
      })
      console.log(`拍摄脚本完成: workspace/${filePath}`)
      break
    }
    case 'review-video': {
      const id = rest.find((a) => !a.startsWith('--'))
      if (!id) { console.error('用法: forgecast review-video <videoAssetId> [--script=<scriptId>]'); process.exit(1) }
      const ctx = ctxWithNotes()
      const sArg = arg('script')
      const r = await reviewVideo(ctx, Number(id), {
        scriptAssetId: sArg ? Number(sArg) : undefined, onProgress: (m) => console.log(`  ${m}`),
      })
      console.log(`总分 ${r.scores.overall}（钩子${r.scores.hook}/节奏${r.scores.pacing}/贴合${r.scores.fidelity}/CTA${r.scores.cta}）${r.degraded ? `\n  ⚠ ${r.degraded}` : ''}`)
      for (const s of r.suggestions) console.log(`  · ${s}`)
      break
    }
```

- [ ] **Step 2: 真实冒烟（live，产物保留）**

```bash
pnpm exec tsx cli.ts script ant-design-pro --asset=1    # 真 LLM 生成拍摄脚本（产品数据保留）
sqlite3 db/forgecast.db "SELECT id, file_path FROM assets WHERE type='script' ORDER BY id DESC LIMIT 1;"
pnpm exec tsx cli.ts review-video 8                     # 对现有渲染成片真审一次（asr 未配则出 degraded，属预期）
```

Expected: 脚本 markdown 含分镜表且台词与文案一致；审片出五项分数+建议（转写是否降级都合法）。产物为产品数据，不清理。

- [ ] **Step 3: 提交**

```bash
git add cli.ts
git commit -m "feat(cli): script/review-video 子命令

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Web 拍摄脚本 tab + api.ts 类型

**Files:**
- Modify: `apps/web/src/api.ts`（Asset 接口扩展）
- Create: `apps/web/src/pages/workshop/ScriptTab.tsx`
- Modify: `apps/web/src/pages/workshop/CopyTab.tsx`（素材过滤修正）

**Interfaces:**
- Consumes: Task 4 的 script 路由 + 既有 `/api/assets/:id/content`（GET/PUT 通用，可编辑 script）+ PATCH/DELETE。

- [ ] **Step 1: api.ts Asset 接口更新**

`type` 联合加 `'script'`；接口补两字段（perf 之后）：

```ts
  /** 视频来源：rendered 模板渲染 / upload 用户上传成片（非 video 类型恒为默认 rendered） */
  origin: 'rendered' | 'upload'
  /** JSON 字符串审片报告 {scores,suggestions,transcript?,metrics,degraded?,reviewedAt}，自行解析 */
  review: string | null
```

- [ ] **Step 2: CopyTab 过滤修正**

`CopyTab.tsx` 的 `const list = assets.filter((a) => a.type !== 'video')` 改为：

```ts
  const list = assets.filter((a) => a.type === 'copy' || a.type === 'cover')
```

（否则新出现的 script 素材会混进文案列表。）

- [ ] **Step 3: ScriptTab**

`apps/web/src/pages/workshop/ScriptTab.tsx`：

```tsx
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import ReactMarkdown from 'react-markdown'
import { api, subscribeTask, type Asset } from '../../api'

/** 单张拍摄脚本卡片：markdown 预览 / 编辑保存 / 审核 / 删除（编辑走通用 content 路由） */
function ScriptCard({ asset }: { asset: Asset }) {
  const qc = useQueryClient()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const content = useQuery({
    queryKey: ['asset-content', asset.id],
    queryFn: () => api<{ content: string }>(`/api/assets/${asset.id}/content`),
  })
  const save = useMutation({
    mutationFn: (c: string) => api(`/api/assets/${asset.id}/content`, { method: 'PUT', body: JSON.stringify({ content: c }) }),
    onSuccess: () => { setEditing(false); qc.invalidateQueries({ queryKey: ['asset-content', asset.id] }) },
  })
  const approve = useMutation({
    mutationFn: () => api(`/api/assets/${asset.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'approved' }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['assets'] }),
  })
  const del = useMutation({
    mutationFn: () => api(`/api/assets/${asset.id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['assets'] }),
  })
  return (
    <div className="card-forge space-y-3 p-4">
      <div className="flex items-center justify-between">
        <div className="text-sm text-sub">
          拍摄脚本 #{asset.id} · {asset.hook ?? '—'} ·
          <span className={asset.status === 'approved' ? 'text-green-600 font-medium' : ''}> {asset.status}</span>
        </div>
        <div className="flex gap-2">
          {!editing && (
            <button className="btn-ink px-3 py-1 text-sm"
              onClick={() => { setDraft(content.data?.content ?? ''); setEditing(true) }}>编辑</button>
          )}
          {asset.status === 'draft' && (
            <button className="btn-fire px-2 py-0.5 text-xs" onClick={() => approve.mutate()}>审核通过</button>
          )}
          <button className="rounded-md border-[1.5px] border-danger px-2 py-0.5 text-xs text-danger"
            onClick={() => { if (window.confirm('删除这份拍摄脚本？不可恢复')) del.mutate() }}>删除</button>
        </div>
      </div>
      {editing ? (
        <div className="space-y-2">
          <textarea className="h-80 w-full rounded-md border-[1.5px] border-ink bg-card p-2 font-mono text-sm"
            value={draft} onChange={(e) => setDraft(e.target.value)} />
          <div className="flex gap-2">
            <button className="btn-fire px-3 py-1 text-sm" onClick={() => save.mutate(draft)}>保存</button>
            <button className="btn-ink px-3 py-1 text-sm" onClick={() => setEditing(false)}>取消</button>
          </div>
        </div>
      ) : (
        <div className="max-h-96 overflow-y-auto border-t border-hairline pt-2 text-sm leading-relaxed [&_h1]:text-base [&_h1]:font-black [&_h2]:mt-3 [&_h2]:font-bold [&_h3]:mt-2 [&_h3]:font-semibold [&_li]:ml-4">
          <ReactMarkdown>{content.data?.content ?? '加载中…'}</ReactMarkdown>
        </div>
      )}
    </div>
  )
}

/** 拍摄脚本 tab：选一条文案 → LLM 扩展成可执行分镜表；脚本可编辑（拍摄前自己按实际情况调） */
export default function ScriptTab({ selected, copyAssets, scriptAssets, running, onRunningChange }: {
  selected: string
  copyAssets: Asset[]
  scriptAssets: Asset[]
  running: boolean
  onRunningChange: (v: boolean) => void
}) {
  const qc = useQueryClient()
  const [fromCopy, setFromCopy] = useState<number | ''>('')
  const chosen = fromCopy === '' ? copyAssets[0]?.id : fromCopy
  async function generate() {
    if (!selected || running) return
    onRunningChange(true)
    try {
      const { taskId } = await api<{ taskId: string }>(`/api/projects/${selected}/script`, {
        method: 'POST', body: JSON.stringify({ assetId: chosen }),
      })
      subscribeTask(taskId, (e) => {
        if (e.type === 'done' || e.type === 'error') {
          onRunningChange(false)
          qc.invalidateQueries({ queryKey: ['assets'] })
          if (e.type === 'error') alert('生成失败：' + e.message)
        }
      })
    } catch (err) {
      onRunningChange(false)
      alert('生成失败：' + (err instanceof Error ? err.message : String(err)))
    }
  }
  return (
    <div className="grid grid-cols-[320px_1fr] gap-6">
      <div className="card-forge h-fit space-y-3 p-4">
        <h3 className="text-sm font-semibold">生成拍摄脚本</h3>
        <div>
          <label className="text-sm text-sub">文案来源</label>
          <select className="mt-1 w-full rounded-md border-[1.5px] border-ink bg-card p-2 text-sm"
            value={chosen ?? ''} onChange={(e) => setFromCopy(Number(e.target.value))}>
            {copyAssets.length === 0 && <option value="">暂无文案，先去「文案」tab 生成</option>}
            {copyAssets.map((a) => <option key={a.id} value={a.id}>#{a.id} · {a.hook}</option>)}
          </select>
        </div>
        <p className="text-xs text-faint">从口播稿扩展成逐镜分镜表（画面/台词/拍摄要点）+ 开拍准备清单，生成后可编辑。</p>
        <button className="btn-fire w-full py-2 disabled:opacity-50"
          disabled={!selected || running || chosen == null} onClick={generate}>
          {running ? '生成中…' : '生成拍摄脚本'}
        </button>
      </div>
      <div className="space-y-4">
        {scriptAssets.length === 0 && <div className="text-sm text-faint">暂无拍摄脚本。选好文案点左侧生成。</div>}
        {scriptAssets.map((a) => <ScriptCard key={a.id} asset={a} />)}
      </div>
    </div>
  )
}
```

- [ ] **Step 4: 类型验证 + 提交**

Run: `pnpm --filter web exec tsc --noEmit`（此时 ScriptTab 尚未接入 WorkshopPage，仅验证自身类型）

```bash
git add apps/web/src/api.ts apps/web/src/pages/workshop/ScriptTab.tsx apps/web/src/pages/workshop/CopyTab.tsx
git commit -m "feat(web): 拍摄脚本 ScriptTab（生成/预览/编辑）+ Asset 类型扩展

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Web 成片 tab + WorkshopPage 5 tab 重排 + 来源徽标

**Files:**
- Create: `apps/web/src/pages/workshop/UploadTab.tsx`
- Modify: `apps/web/src/pages/WorkshopPage.tsx`（5 tab、素材分流、接入 ScriptTab/UploadTab）
- Modify: `apps/web/src/components/AssetCard.tsx`（video 分支加来源徽标）

- [ ] **Step 1: UploadTab**

`apps/web/src/pages/workshop/UploadTab.tsx`：

```tsx
import { useQueryClient } from '@tanstack/react-query'
import { useRef, useState } from 'react'
import { api, subscribeTask, type Asset } from '../../api'

interface ReviewReport {
  scores: { hook: number; pacing: number; fidelity: number; cta: number; overall: number }
  suggestions: string[]
  transcript?: string
  metrics: { durationSec: number | null; charCount: number; charsPerSec: number | null }
  degraded?: string
  reviewedAt: string
}

const DIM_LABELS: Array<[keyof ReviewReport['scores'], string]> = [
  ['hook', '钩子'], ['pacing', '节奏'], ['fidelity', '贴合'], ['cta', 'CTA'],
]

/** 分数条：0-100，>=70 绿 / >=50 琥珀 / 其余红（语义色例外，见 forge-theme spec） */
function ScoreBar({ label, value }: { label: string; value: number }) {
  const color = value >= 70 ? 'bg-green-600' : value >= 50 ? 'bg-amber-500' : 'bg-danger'
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="w-8 shrink-0 text-sub">{label}</span>
      <div className="h-2 flex-1 rounded-full bg-paper">
        <div className={`h-2 rounded-full ${color}`} style={{ width: `${Math.min(100, Math.max(0, value))}%` }} />
      </div>
      <span className="w-6 text-right font-bold">{value}</span>
    </div>
  )
}

/** 单条上传成片卡片：竖屏播放器 + 审片（可选脚本基准）+ 报告展示 */
function UploadCard({ asset, scriptAssets, onStatus, onDelete }: {
  asset: Asset
  scriptAssets: Asset[]
  onStatus: (id: number) => void
  onDelete: (id: number) => void
}) {
  const qc = useQueryClient()
  const [reviewing, setReviewing] = useState(false)
  const [scriptId, setScriptId] = useState<number | ''>('')
  let report: ReviewReport | null = null
  if (asset.review) { try { report = JSON.parse(asset.review) } catch { report = null } }

  async function runReview() {
    if (reviewing) return
    setReviewing(true)
    try {
      const { taskId } = await api<{ taskId: string }>(`/api/assets/${asset.id}/review`, {
        method: 'POST', body: JSON.stringify(scriptId === '' ? {} : { scriptAssetId: scriptId }),
      })
      subscribeTask(taskId, (e) => {
        if (e.type === 'done' || e.type === 'error') {
          setReviewing(false)
          qc.invalidateQueries({ queryKey: ['assets'] })
          if (e.type === 'error') alert('审片失败：' + e.message)
        }
      })
    } catch (err) {
      setReviewing(false)
      alert('审片失败：' + (err instanceof Error ? err.message : String(err)))
    }
  }

  return (
    <div className="card-forge space-y-2 p-2">
      <video src={`/files/${asset.file_path}`} controls preload="metadata"
        className="aspect-[9/16] w-full rounded-lg border-[1.5px] border-ink bg-black object-contain" />
      <div className="space-y-2 px-1">
        <div className="flex items-center justify-between gap-2">
          <div className="truncate text-xs text-sub">实拍 · {asset.status}{report ? ` · 总分 ${report.scores.overall}` : ''}</div>
          <div className="flex shrink-0 items-center gap-1.5">
            {asset.status === 'draft' && (
              <button className="btn-fire px-2 py-0.5 text-xs" onClick={() => onStatus(asset.id)}>审核通过</button>
            )}
            <button className="rounded-md border-[1.5px] border-danger px-2 py-0.5 text-xs text-danger"
              onClick={() => { if (window.confirm('删除这条成片？文件和记录都会删掉')) onDelete(asset.id) }}>删除</button>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <select className="min-w-0 flex-1 rounded-md border-[1.5px] border-ink bg-card px-1.5 py-1 text-xs"
            value={scriptId} onChange={(e) => setScriptId(e.target.value === '' ? '' : Number(e.target.value))}>
            <option value="">最新脚本基准（自动）</option>
            {scriptAssets.map((s) => <option key={s.id} value={s.id}>脚本 #{s.id} · {s.hook ?? '—'}</option>)}
          </select>
          <button className="btn-ink shrink-0 px-2 py-1 text-xs disabled:opacity-50" disabled={reviewing} onClick={runReview}>
            {reviewing ? '审片中…' : report ? '重新审片' : '审片'}
          </button>
        </div>
        {report && (
          <div className="space-y-1.5 border-t border-hairline pt-2">
            {DIM_LABELS.map(([k, label]) => <ScoreBar key={k} label={label} value={report!.scores[k]} />)}
            {report.degraded && (
              <div className="rounded border-[1.5px] border-amber-600 bg-amber-50 px-2 py-1 text-xs text-amber-800">{report.degraded}</div>
            )}
            <ul className="space-y-0.5 text-xs">
              {report.suggestions.map((s, i) => <li key={i}>· {s}</li>)}
            </ul>
            {report.transcript && (
              <div className="truncate text-xs text-faint" title={report.transcript}>转写：{report.transcript.slice(0, 60)}…</div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

/** 成片 tab：上传实拍视频 → 审片打分 → 按建议迭代下一条（人机协作主线） */
export default function UploadTab({ selected, uploadAssets, scriptAssets, onStatus, onDelete }: {
  selected: string
  uploadAssets: Asset[]
  scriptAssets: Asset[]
  onStatus: (id: number) => void
  onDelete: (id: number) => void
}) {
  const qc = useQueryClient()
  const fileRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)
  async function upload(file: File) {
    setUploading(true)
    try {
      const fd = new FormData()
      fd.append('file', file)
      const res = await fetch(`/api/projects/${selected}/upload-video`, { method: 'POST', body: fd })
      if (!res.ok) alert(`上传失败: ${await res.text()}`)
      qc.invalidateQueries({ queryKey: ['assets'] })
    } finally {
      setUploading(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }
  return (
    <div className="space-y-4">
      <div className="card-forge flex items-center gap-3 p-4">
        <input ref={fileRef} type="file" accept=".mp4,.mov,.m4v" className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f) }} />
        <button className="btn-fire px-4 py-2 disabled:opacity-50" disabled={!selected || uploading}
          onClick={() => fileRef.current?.click()}>
          {uploading ? '上传中…' : '上传成片（mp4/mov）'}
        </button>
        <p className="text-xs text-faint">按「拍摄脚本」拍好剪好后传上来，系统对照脚本审片打分并给下一条的改进建议。</p>
      </div>
      <div className="grid grid-cols-2 gap-4 2xl:grid-cols-3">
        {uploadAssets.length === 0 && <div className="text-sm text-faint">暂无实拍成片。</div>}
        {uploadAssets.map((a) => (
          <UploadCard key={a.id} asset={a} scriptAssets={scriptAssets} onStatus={onStatus} onDelete={onDelete} />
        ))}
      </div>
    </div>
  )
}
```

- [ ] **Step 2: WorkshopPage 5 tab 重排**

`apps/web/src/pages/WorkshopPage.tsx` 改动点（其余保持）：

```ts
import ScriptTab from './workshop/ScriptTab'
import UploadTab from './workshop/UploadTab'
```

TABS/normalizeTab 换成：

```ts
// 做内容五 tab：按人机协作主线排序（文案→拍摄脚本→成片上传审片）；自动渲染（出视频）降为辅助
const TABS = [
  { key: 'copy', label: '文案' },
  { key: 'script', label: '拍摄脚本' },
  { key: 'upload', label: '成片' },
  { key: 'video', label: '出视频' },
  { key: 'cut', label: '卡点' },
] as const
type TabKey = (typeof TABS)[number]['key']

function normalizeTab(v: string | null): TabKey {
  return v === 'script' || v === 'upload' || v === 'video' || v === 'cut' ? v : 'copy'
}
```

素材分流（`copyAssets`/`videoAssets` 定义处改为）：

```ts
  const copyAssets = (assets.data ?? []).filter((a) => a.type === 'copy')
  const scriptAssets = (assets.data ?? []).filter((a) => a.type === 'script')
  const uploadAssets = (assets.data ?? []).filter((a) => a.type === 'video' && a.origin === 'upload')
  const renderAssets = (assets.data ?? []).filter((a) => a.type === 'video' && a.origin !== 'upload')
```

新增两个状态操作透传（放 makeVideo 之后）：

```ts
  function setAssetStatus(id: number) {
    api(`/api/assets/${id}`, { method: 'PATCH', body: JSON.stringify({ status: 'approved' }) })
      .then(() => qc.invalidateQueries({ queryKey: ['assets', selected] }))
  }
  function deleteAsset(id: number) {
    api(`/api/assets/${id}`, { method: 'DELETE' })
      .then(() => qc.invalidateQueries({ queryKey: ['assets', selected] }))
      .catch((e) => alert('删除失败：' + (e instanceof Error ? e.message : String(e))))
  }
```

tab 渲染区：`{tab === 'copy' && ...}` 之后插入：

```tsx
      {tab === 'script' && (
        <ScriptTab selected={selected} copyAssets={copyAssets} scriptAssets={scriptAssets}
          running={running} onRunningChange={setRunning} />
      )}
      {tab === 'upload' && (
        <UploadTab selected={selected} uploadAssets={uploadAssets} scriptAssets={scriptAssets}
          onStatus={setAssetStatus} onDelete={deleteAsset} />
      )}
```

VideoTab 的 `videoAssets={videoAssets}` 改为 `videoAssets={renderAssets}`。

（ScriptTab 借用 shell 的 `running` 锁与文案/视频生成互斥——同一时间只跑一个 LLM 任务，行为与现状一致。）

- [ ] **Step 3: AssetCard 来源徽标**

video 分支元信息行 `{asset.hook} · {asset.status}` 改为：

```tsx
          <div className="truncate text-xs text-sub">{asset.origin === 'upload' ? '实拍' : '渲染'} · {asset.hook ?? '—'} · {asset.status}</div>
```

- [ ] **Step 4: 构建验证 + 提交**

Run: `pnpm --filter web exec tsc --noEmit && pnpm --filter web build`

```bash
git add apps/web/src/pages/workshop/UploadTab.tsx apps/web/src/pages/WorkshopPage.tsx apps/web/src/components/AssetCard.tsx
git commit -m "feat(web): 做内容五 tab（文案/拍摄脚本/成片/出视频/卡点）+ 成片上传审片界面

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: README + 全仓回归

**Files:**
- Modify: `README.md`

- [ ] **Step 1: README**

- CLI 段 `forgecast video ...` 行之后加两行：

```
forgecast script <slug> [--asset=<copyId>]        # 从文案生成可执行拍摄脚本（分镜表+开拍准备清单，做内容人机协作主线）
forgecast review-video <videoAssetId> [--script=<id>]  # 审片：转写(需 FORGECAST_ASR_PYTHON，缺则降级)+结构指标+LLM 对照脚本打分与建议
```

- 目录结构段「做内容 `/workshop`」描述里补一句：`；主线为人机协作五 tab（文案/拍摄脚本/成片上传审片/出视频(辅助)/卡点），见 docs/superpowers/specs/2026-08-14-shoot-review-design.md`。

- [ ] **Step 2: 全仓回归 + 提交**

Run: `pnpm test && pnpm --filter web exec tsc --noEmit && pnpm --filter web build`

```bash
git add README.md
git commit -m "docs: README 补拍摄脚本/审片命令与做内容五 tab 说明

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## 端到端验证（实施完成后，主会话手动执行）

1. 重启 dev server。
2. `/workshop`：五 tab 就位、默认文案；「拍摄脚本」tab 选真实文案生成 → 分镜表可读、台词与文案一致、可编辑保存。
3. 「成片」tab 上传一条真实 mp4（可拿现有渲染成片文件充当实拍）→ 审片（默认最新脚本基准）→ SSE 完成后分数条+建议+转写/降级提示展示正常；建议无编造数字。
4. 「出视频」tab 确认只剩渲染片（实拍片不混入）；文案 tab 确认脚本素材不混入。
5. CLI `forgecast review-video <id>` 输出与页面一致。
6. 真实产物保留；测试造的假数据清理。
