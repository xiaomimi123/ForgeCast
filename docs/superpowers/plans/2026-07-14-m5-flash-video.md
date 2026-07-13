# M5 子块① — flash 视频（渲染管线 + 模板）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增 `@forgecast/studio`，把一个 copy 素材打包成 15 秒竖屏 flash 文字动效视频（Remotion 渲染），CLI/API/Web 三入口；渲染 stub/real 双模式，测试走 stub。

**Architecture:** 引擎/界面分离。`generateVideo` 读 copy 素材 → `parseCopyOutput` → `buildFlashProps` → 写 props.json → `renderFlash`（stub 写占位 / real 用 @remotion/bundler+renderer 动态加载）→ 写 mp4 → 登记 video asset。Remotion Compositions 只在 real 渲染时由 bundler 打包，不进 generateVideo 的 import 图。

**Tech Stack:** Node 20 + pnpm 9 monorepo；Remotion 4（remotion/@remotion/bundler/@remotion/renderer）+ react 18；better-sqlite3；vitest；tsx（无 build）。设计见 `docs/superpowers/specs/2026-07-14-m5-flash-video-design.md`。

## Global Constraints

- Node 20，pnpm 9；`@forgecast/studio` 的 `main` 直指 `src/index.ts`，无 build 步骤
- 包名 `@forgecast/studio`，依赖 `@forgecast/core` + `@forgecast/copywriter` + `remotion`/`react`/`react-dom`/`@remotion/bundler`/`@remotion/renderer`；devDeps 含 `@types/react`/`@types/react-dom`/`@types/better-sqlite3`/`@types/node`/`vitest`
- studio tsconfig 需 `"jsx":"react-jsx"` + `"lib":["ES2022","DOM","DOM.Iterable"]`（含 Remotion React 组件），参照 `apps/web/tsconfig.json`
- 渲染双模式：core config `video:{mode:'render'|'stub'}`，`FORGECAST_VIDEO_MODE` 默认 `render`；`@remotion/bundler`/`@remotion/renderer` 用**动态 import**（stub 与测试不加载）
- **所有测试用 `FORGECAST_VIDEO_MODE=stub`**；`pnpm -r test` 绝不真渲染
- flash 规格：1080×1920，30fps，durationInFrames=450（15s），字体 `"PingFang SC","Noto Sans CJK SC",sans-serif`
- 产物落 `workspace/<slug>/videos/`；assets `type='video'`，file_path 存相对 workspace 路径
- 服务只绑 127.0.0.1；文档注释中文；TDD；commit conventional，结尾 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

---

### Task 1: studio 脚手架 + config video 模式 + Remotion 模板 + props

**Files:**
- Create: `packages/studio/package.json`, `packages/studio/tsconfig.json`, `packages/studio/src/index.ts`, `packages/studio/src/props.ts`, `packages/studio/src/remotion/Flash.tsx`, `packages/studio/src/remotion/Root.tsx`, `packages/studio/src/remotion/entry.ts`
- Modify: `packages/core/src/config.ts`, `.env.example`
- Test: `packages/core/test/config.test.ts`, `packages/studio/test/props.test.ts`

**Interfaces:**
- Produces:
  - `ForgecastConfig.video: { mode: 'render' | 'stub' }`
  - `interface FlashProps { painTitle: string; sellingPoint: string; cta: string; brandName: string }`
  - `function buildFlashProps(doc: CopyDoc, brandName?: string): FlashProps`
- Consumes: `@forgecast/copywriter` `CopyDoc`

- [ ] **Step 1: config 与 props 失败测试**

在 `packages/core/test/config.test.ts` 的 `describe('loadConfig', ...)` 内追加：
```ts
  it('video 默认 render，可设 stub', () => {
    expect(loadConfig('/tmp/x', {}).video).toEqual({ mode: 'render' })
    expect(loadConfig('/tmp/x', { FORGECAST_VIDEO_MODE: 'stub' }).video).toEqual({ mode: 'stub' })
  })
```

`packages/studio/test/props.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { buildFlashProps } from '../src/props'

const doc = {
  titles: ['t1', 't2', 't3'],
  xhsBody: 'body',
  douyinScript: '【0-3s 钩子】开场\n【52-60s CTA】评论区扣1领文档',
  cover: { main: '网店客服还在手动回？', sub: '一套系统扛住3个人的活' },
  comments: { questions: ['q1', 'q2'], replies: ['r1', 'r2', 'r3'] },
}

describe('buildFlashProps', () => {
  it('取封面主/副标题与 CTA', () => {
    const p = buildFlashProps(doc as any, '快客通')
    expect(p.painTitle).toBe('网店客服还在手动回？')
    expect(p.sellingPoint).toBe('一套系统扛住3个人的活')
    expect(p.cta).toBe('评论区扣1领文档')
    expect(p.brandName).toBe('快客通')
  })
  it('无 CTA 段时兜底非空', () => {
    const p = buildFlashProps({ ...doc, douyinScript: '没有那段' } as any)
    expect(p.cta.length).toBeGreaterThan(0)
    expect(p.brandName).toBe('forgecast')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @forgecast/core test`（video 用例 FAIL）
（studio 尚无包，先不跑 studio）

- [ ] **Step 3: 改 core config**

`packages/core/src/config.ts` 完整新版（在现有 github 基础上加 video；保留 INIT_CWD 兜底）：
```ts
import path from 'node:path'

export type LlmMode = 'mock' | 'live'
export type GithubMode = 'mock' | 'live'
export type VideoMode = 'render' | 'stub'

export interface ForgecastConfig {
  root: string
  llm: {
    mode: LlmMode
    baseURL: string
    apiKey: string
    models: { analysis: string; copy: string; scoring: string }
  }
  github: { mode: GithubMode; token: string }
  video: { mode: VideoMode }
  paths: { workspace: string; db: string; templates: string }
}

export function loadConfig(root?: string, env: NodeJS.ProcessEnv = process.env): ForgecastConfig {
  // 未传 root 时用 INIT_CWD 兜底（pnpm --filter 会把子进程 cwd 切到包目录）
  const resolvedRoot = root ?? env.INIT_CWD ?? process.cwd()
  const mode: LlmMode = env.FORGECAST_LLM_MODE === 'live' ? 'live' : 'mock'
  if (mode === 'live' && !env.FORGECAST_LLM_KEY) {
    throw new Error('FORGECAST_LLM_MODE=live 时必须设置 FORGECAST_LLM_KEY（.env）')
  }
  const githubMode: GithubMode = env.FORGECAST_GITHUB_MODE === 'live' ? 'live' : 'mock'
  const videoMode: VideoMode = env.FORGECAST_VIDEO_MODE === 'stub' ? 'stub' : 'render'
  return {
    root: resolvedRoot,
    llm: {
      mode,
      baseURL: env.FORGECAST_LLM_BASE_URL ?? 'https://aitoken.homes/v1',
      apiKey: env.FORGECAST_LLM_KEY ?? '',
      models: {
        analysis: env.FORGECAST_MODEL_ANALYSIS ?? 'claude-sonnet-5',
        copy: env.FORGECAST_MODEL_COPY ?? 'claude-sonnet-5',
        scoring: env.FORGECAST_MODEL_SCORING ?? 'claude-haiku-4-5',
      },
    },
    github: { mode: githubMode, token: env.FORGECAST_GITHUB_TOKEN ?? '' },
    video: { mode: videoMode },
    paths: {
      workspace: path.join(resolvedRoot, 'workspace'),
      db: path.join(resolvedRoot, 'db', 'forgecast.db'),
      templates: path.join(resolvedRoot, 'templates'),
    },
  }
}
```

`.env.example` 末尾追加：
```bash
# 视频渲染模式：render（默认，真渲 mp4，需 Remotion/Chromium/ffmpeg）| stub（写占位，测试用）
FORGECAST_VIDEO_MODE=render
```

- [ ] **Step 4: 建 studio 包与 Remotion 模板 + props**

`packages/studio/package.json`:
```json
{
  "name": "@forgecast/studio",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "scripts": { "test": "vitest run --passWithNoTests" },
  "dependencies": {
    "@forgecast/copywriter": "workspace:*",
    "@forgecast/core": "workspace:*",
    "@remotion/bundler": "^4.0.0",
    "@remotion/renderer": "^4.0.0",
    "react": "^18.3.0",
    "react-dom": "^18.3.0",
    "remotion": "^4.0.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.11",
    "@types/node": "^20.11.0",
    "@types/react": "^18.3.0",
    "@types/react-dom": "^18.3.0",
    "vitest": "^2.1.0"
  }
}
```

`packages/studio/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "jsx": "react-jsx", "lib": ["ES2022", "DOM", "DOM.Iterable"] },
  "include": ["src", "test"]
}
```

`packages/studio/src/props.ts`:
```ts
import type { CopyDoc } from '@forgecast/copywriter'

export interface FlashProps {
  painTitle: string
  sellingPoint: string
  cta: string
  brandName: string
}

/** 从解析后的文案取 flash 三段文字（均有兜底，不抛错） */
export function buildFlashProps(doc: CopyDoc, brandName = 'forgecast'): FlashProps {
  const ctaMatch = doc.douyinScript.match(/【[^】]*CTA[^】]*】\s*(.+)/)
  const cta = (ctaMatch?.[1] ?? doc.comments.replies[0] ?? '想要同款？评论区扣1').trim()
  return {
    painTitle: doc.cover.main || doc.titles[0] || '',
    sellingPoint: doc.cover.sub || doc.titles[1] || '',
    cta,
    brandName,
  }
}
```

`packages/studio/src/remotion/Flash.tsx`:
```tsx
import type { FC, ReactNode } from 'react'
import { AbsoluteFill, Sequence, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion'
import type { FlashProps } from '../props'

const FONT = '"PingFang SC", "Noto Sans CJK SC", sans-serif'

// 单段文字卡：弹入 + 淡入
const Card: FC<{ children: ReactNode; bg: string }> = ({ children, bg }) => {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  const s = spring({ frame, fps, config: { damping: 200 } })
  const opacity = interpolate(frame, [0, 12], [0, 1], { extrapolateRight: 'clamp' })
  return (
    <AbsoluteFill style={{ background: bg, justifyContent: 'center', alignItems: 'center', padding: 80, fontFamily: FONT, textAlign: 'center' }}>
      <div style={{ transform: `scale(${0.8 + s * 0.2})`, opacity }}>{children}</div>
    </AbsoluteFill>
  )
}

// flash 模板：痛点大字(0-4s) → 一句卖点(4-10s) → CTA(10-15s)
export const Flash: FC<FlashProps> = ({ painTitle, sellingPoint, cta, brandName }) => {
  return (
    <AbsoluteFill style={{ background: '#0f0f1a' }}>
      <Sequence from={0} durationInFrames={120}>
        <Card bg="linear-gradient(160deg,#1a1a2e,#16213e)">
          <div style={{ color: '#fff', fontSize: 96, fontWeight: 900, lineHeight: 1.3 }}>{painTitle}</div>
        </Card>
      </Sequence>
      <Sequence from={120} durationInFrames={180}>
        <Card bg="linear-gradient(160deg,#16213e,#0f3460)">
          <div style={{ color: '#ffd54f', fontSize: 84, fontWeight: 800, lineHeight: 1.3 }}>{sellingPoint}</div>
        </Card>
      </Sequence>
      <Sequence from={300} durationInFrames={150}>
        <Card bg="linear-gradient(160deg,#0f3460,#1a1a2e)">
          <div>
            <div style={{ color: '#fff', fontSize: 72, fontWeight: 800, marginBottom: 40 }}>{cta}</div>
            <div style={{ color: '#8888aa', fontSize: 40 }}>@{brandName}</div>
          </div>
        </Card>
      </Sequence>
    </AbsoluteFill>
  )
}
```

`packages/studio/src/remotion/Root.tsx`:
```tsx
import type { FC } from 'react'
import { Composition } from 'remotion'
import type { FlashProps } from '../props'
import { Flash } from './Flash'

const defaultFlashProps: FlashProps = {
  painTitle: '还在用老办法？',
  sellingPoint: '一套系统扛住3个人的活',
  cta: '想要同款？评论区扣1',
  brandName: 'forgecast',
}

// Remotion 根：注册 flash Composition（1080×1920 / 30fps / 15s）
export const RemotionRoot: FC = () => {
  return (
    <Composition
      id="Flash"
      component={Flash}
      durationInFrames={450}
      fps={30}
      width={1080}
      height={1920}
      defaultProps={defaultFlashProps}
    />
  )
}
```

`packages/studio/src/remotion/entry.ts`:
```ts
import { registerRoot } from 'remotion'
import { RemotionRoot } from './Root'

// Remotion 打包入口（bundler 从这里进）
registerRoot(RemotionRoot)
```

`packages/studio/src/index.ts`:
```ts
// @forgecast/studio — M5 视频。渲染/generate 在后续任务追加导出。
export * from './props'
```

- [ ] **Step 5: 安装 + 跑测试 + tsc 门禁**

Run: `pnpm install`（拉 remotion 等；镜像超时自动重试）
Run: `pnpm --filter @forgecast/core test`（config 全绿，含 video 用例）
Run: `pnpm --filter @forgecast/studio test`（props 2 个绿）
Run: `pnpm --filter @forgecast/studio exec tsc --noEmit -p tsconfig.json`（0 错误——Remotion 组件类型过关；若 Root.tsx 的 `React.FC` 报错按注释改用 `FC`）

- [ ] **Step 6: Commit**

```bash
git add packages/studio packages/core/src/config.ts packages/core/test/config.test.ts .env.example pnpm-lock.yaml
git commit -m "feat(studio): 包脚手架 + config video 模式 + flash Remotion 模板 + buildFlashProps"
```

---

### Task 2: renderFlash（stub/real）+ generateVideo

**Files:**
- Create: `packages/studio/src/render.ts`, `packages/studio/src/generate.ts`
- Modify: `packages/studio/src/index.ts`
- Test: `packages/studio/test/render.test.ts`, `packages/studio/test/generate.test.ts`

**Interfaces:**
- Produces:
  - `async function renderFlash(entry: string, inputProps: Record<string, unknown>, outPath: string, mode: 'render'|'stub', opts?: { onProgress?: (m: string) => void }): Promise<void>`
  - `interface GenerateVideoInput { slug: string; assetId?: number; tpl?: 'flash'; onProgress?: (msg: string) => void }`
  - `interface GeneratedVideo { assetId: number; filePath: string }`
  - `async function generateVideo(ctx: CoreCtx, input: GenerateVideoInput): Promise<GeneratedVideo>`
- Consumes: Task 1 `buildFlashProps`/`FlashProps`；`@forgecast/copywriter` `parseCopyOutput`

- [ ] **Step 1: 写失败测试**

`packages/studio/test/render.test.ts`:
```ts
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { renderFlash } from '../src/render'

describe('renderFlash stub', () => {
  it('写出非空占位文件（不加载 remotion）', async () => {
    const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fc-r-')), 'a.mp4')
    await renderFlash('entry', { painTitle: 'x', sellingPoint: 'y', cta: 'z', brandName: 'b' }, out, 'stub')
    expect(fs.existsSync(out)).toBe(true)
    expect(fs.statSync(out).size).toBeGreaterThan(0)
  })
})
```

`packages/studio/test/generate.test.ts`:
```ts
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { copyFixtures, createLlmClient, loadConfig, openDb, type CoreCtx } from '@forgecast/core'
import { beforeEach, describe, expect, it } from 'vitest'
import { generateVideo } from '../src/generate'

let ctx: CoreCtx
let root: string
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-vid-'))
  const config = loadConfig(root, { FORGECAST_VIDEO_MODE: 'stub' })
  ctx = { db: openDb(config.paths.db), config, llm: createLlmClient(config.llm) }
  ctx.db.prepare("INSERT INTO projects (slug, brand_name) VALUES ('demo', '快客通')").run()
  const copyDir = path.join(root, 'workspace/demo/copy')
  fs.mkdirSync(copyDir, { recursive: true })
  fs.writeFileSync(path.join(copyDir, 'pain-1.md'), copyFixtures.pain)
  ctx.db.prepare("INSERT INTO assets (project_id, type, hook, file_path) VALUES (1, 'copy', 'pain', 'demo/copy/pain-1.md')").run()
})

describe('generateVideo (stub)', () => {
  it('产出 props.json + 占位 mp4 + 登记 video 素材', async () => {
    const out = await generateVideo(ctx, { slug: 'demo', tpl: 'flash' })
    expect(out.filePath).toMatch(/demo\/videos\/.*\.mp4$/)
    const abs = path.join(ctx.config.paths.workspace, out.filePath)
    expect(fs.existsSync(abs)).toBe(true)
    const propsFile = abs.replace(/\.mp4$/, '.props.json')
    expect(fs.existsSync(propsFile)).toBe(true)
    const props = JSON.parse(fs.readFileSync(propsFile, 'utf8'))
    expect(props.painTitle.length).toBeGreaterThan(0)
    expect(props.brandName).toBe('快客通')
    const row: any = ctx.db.prepare('SELECT * FROM assets WHERE id = ?').get(out.assetId)
    expect(row.type).toBe('video')
    expect(row.file_path).toBe(out.filePath)
  })
  it('无 copy 素材 → 抛错', async () => {
    ctx.db.prepare("INSERT INTO projects (slug) VALUES ('empty')").run()
    await expect(generateVideo(ctx, { slug: 'empty' })).rejects.toThrow(/文案/)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @forgecast/studio test`
Expected: FAIL（render.ts/generate.ts 不存在）

- [ ] **Step 3: 实现 render.ts**

```ts
import fs from 'node:fs'
import path from 'node:path'

const STUB_BYTES = Buffer.from('FORGECAST_STUB_MP4\n')

/** flash 渲染：stub 写占位文件；render 用 Remotion 真渲。@remotion/* 动态加载（stub/测试不触及）。 */
export async function renderFlash(
  entry: string,
  inputProps: Record<string, unknown>,
  outPath: string,
  mode: 'render' | 'stub',
  opts: { onProgress?: (m: string) => void } = {},
): Promise<void> {
  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  if (mode === 'stub') {
    fs.writeFileSync(outPath, STUB_BYTES)
    return
  }
  const { bundle } = await import('@remotion/bundler')
  const { selectComposition, renderMedia } = await import('@remotion/renderer')
  const serveUrl = await bundle({ entryPoint: entry })
  const composition = await selectComposition({ serveUrl, id: 'Flash', inputProps })
  await renderMedia({
    composition,
    serveUrl,
    codec: 'h264',
    outputLocation: outPath,
    inputProps,
    onProgress: ({ progress }) => opts.onProgress?.(`渲染 ${Math.round(progress * 100)}%…`),
  })
}
```

- [ ] **Step 4: 实现 generate.ts**

```ts
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { CoreCtx } from '@forgecast/core'
import { parseCopyOutput } from '@forgecast/copywriter'
import { buildFlashProps } from './props'
import { renderFlash } from './render'

export interface GenerateVideoInput {
  slug: string
  assetId?: number
  tpl?: 'flash'
  onProgress?: (msg: string) => void
}
export interface GeneratedVideo { assetId: number; filePath: string }

// Remotion 打包入口（相对本文件定位到 src/remotion/entry.ts）
const ENTRY = fileURLToPath(new URL('./remotion/entry.ts', import.meta.url))

/** 取 copy 素材 → 解析 → buildFlashProps → 写 props.json → 渲染 mp4 → 登记 video 素材 */
export async function generateVideo(ctx: CoreCtx, input: GenerateVideoInput): Promise<GeneratedVideo> {
  const { slug, onProgress = () => {} } = input
  const project: any = ctx.db.prepare('SELECT * FROM projects WHERE slug = ?').get(slug)
  if (!project) throw new Error(`项目不存在: ${slug}`)

  const copy: any = input.assetId
    ? ctx.db.prepare("SELECT * FROM assets WHERE id = ? AND type = 'copy'").get(input.assetId)
    : ctx.db.prepare("SELECT * FROM assets WHERE project_id = ? AND type = 'copy' ORDER BY id DESC LIMIT 1").get(project.id)
  if (!copy) throw new Error(`没有可用的文案素材（先在素材工坊生成文案）: ${slug}`)

  onProgress('解析文案、组装视频参数…')
  const copyAbs = path.join(ctx.config.paths.workspace, copy.file_path)
  const doc = parseCopyOutput(fs.readFileSync(copyAbs, 'utf8'))
  const props = buildFlashProps(doc, project.brand_name ?? slug)

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const base = `${copy.hook ?? 'flash'}-${stamp}-${randomUUID().slice(0, 6)}`
  const videoDir = path.join(ctx.config.paths.workspace, slug, 'videos')
  fs.mkdirSync(videoDir, { recursive: true })
  fs.writeFileSync(path.join(videoDir, `${base}.props.json`), JSON.stringify(props, null, 2), 'utf8')

  onProgress(`渲染视频（${ctx.config.video.mode} 模式）…`)
  const relPath = path.join(slug, 'videos', `${base}.mp4`)
  await renderFlash(
    ENTRY,
    props as unknown as Record<string, unknown>,
    path.join(ctx.config.paths.workspace, relPath),
    ctx.config.video.mode,
    { onProgress },
  )

  const info = ctx.db.prepare(
    'INSERT INTO assets (project_id, type, hook, file_path, warnings) VALUES (?, ?, ?, ?, ?)',
  ).run(project.id, 'video', copy.hook, relPath, '[]')
  onProgress(`视频完成: ${relPath}`)
  return { assetId: Number(info.lastInsertRowid), filePath: relPath }
}
```

`packages/studio/src/index.ts` 追加：`export * from './generate'`（`render` 内部用，不必导出）

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm --filter @forgecast/studio test`
Expected: PASS（render 1 + generate 2 + 既有 props 2）
Run: `pnpm --filter @forgecast/studio exec tsc --noEmit -p tsconfig.json`（0 错误）

- [ ] **Step 6: Commit**

```bash
git add packages/studio && git commit -m "feat(studio): renderFlash（stub/real 动态加载 Remotion）与 generateVideo 主函数"
```

---

### Task 3: server 端点 + CLI video

**Files:**
- Modify: `packages/server/src/app.ts`, `packages/server/package.json`, `cli.ts`, `package.json`（根）
- Test: `packages/server/test/video.test.ts`

**Interfaces:**
- Consumes: Task 2 `generateVideo`（从 `@forgecast/studio`）、现有 `queue`、`createCtx`
- Produces（REST）: `POST /api/projects/:slug/video` → `{taskId}`（项目不存在 404）

- [ ] **Step 1: 加 server 依赖并写失败测试**

先给 `packages/server/package.json` 的 `dependencies` 加 `"@forgecast/studio": "workspace:*"`，`pnpm install`。

`packages/server/test/video.test.ts`:
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-vsrv-'))
  const config = loadConfig(root, { FORGECAST_VIDEO_MODE: 'stub' })
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
  for (let i = 0; i < 100; i++) {
    await wait(20)
    const s = queue.get(taskId)!.status
    if (s === 'done') return
    if (s === 'failed') throw new Error(queue.get(taskId)!.events.at(-1)!.message)
  }
  throw new Error('任务超时')
}

describe('video API (stub)', () => {
  it('POST video → 任务完成 → assets 出现 video 素材', async () => {
    const { taskId } = await (await app.request('/api/projects/demo/video', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    })).json() as any
    await runTask(taskId)
    const assets = await (await app.request('/api/projects/demo/assets')).json() as any[]
    expect(assets.some((a) => a.type === 'video')).toBe(true)
  })
  it('未知项目 → 404', async () => {
    expect((await app.request('/api/projects/nope/video', { method: 'POST' })).status).toBe(404)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @forgecast/server test`
Expected: FAIL（路由不存在）

- [ ] **Step 3: 实现 server 端点**

`packages/server/src/app.ts` 头部 import 追加：
```ts
import { generateVideo } from '@forgecast/studio'
```

createApp 内、`return app` 之前追加：
```ts
  // —— M5 视频 ——
  app.post('/api/projects/:slug/video', async (c) => {
    const slug = c.req.param('slug')
    if (!ctx.db.prepare('SELECT id FROM projects WHERE slug = ?').get(slug)) return c.json({ error: '项目不存在' }, 404)
    const body = await c.req.json().catch(() => ({}))
    const taskId = queue.enqueue((log) => generateVideo(ctx, {
      slug,
      assetId: typeof body.assetId === 'number' ? body.assetId : undefined,
      tpl: 'flash',
      onProgress: log,
    }))
    return c.json({ taskId })
  })
```

- [ ] **Step 4: 实现 CLI video**

先给根 `package.json` 的 `dependencies` 加 `"@forgecast/studio": "workspace:*"`，`pnpm install`。

`cli.ts` 头部 import 追加：
```ts
import { generateVideo } from '@forgecast/studio'
```

`switch (cmd)` 内、`case 'analyze'` 之后追加：
```ts
    case 'video': {
      const slug = rest.find((a) => !a.startsWith('--'))
      if (!slug) { console.error('用法: forgecast video <slug> --tpl=flash [--asset=<id>]'); process.exit(1) }
      const ctx = createCtx()
      const assetArg = arg('asset')
      const { filePath } = await generateVideo(ctx, {
        slug, tpl: 'flash', assetId: assetArg ? Number(assetArg) : undefined,
        onProgress: (m) => console.log(`  ${m}`),
      })
      console.log(`视频完成: workspace/${filePath}`)
      break
    }
```

并更新 default help：把"未实现"行去掉 `video/`，已实现列表加一行：
```
  video <slug> --tpl=flash         生成 flash 视频（渲染 copy 素材为 15s 竖屏）
```
使"未实现"行变为 `（rebrand/knowledge/calendar 属后续里程碑项，未实现）`。

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm --filter @forgecast/server test`
Expected: PASS（video ×2 + 既有全绿）

- [ ] **Step 6: Commit**

```bash
git add packages/server cli.ts package.json pnpm-lock.yaml
git commit -m "feat(server+cli): video 端点（入队走 SSE）与 forgecast video 命令"
```

---

### Task 4: Web — 素材工坊「生成视频」按钮 + 视频内嵌播放

**Files:**
- Modify: `apps/web/src/components/AssetCard.tsx`, `apps/web/src/pages/WorkshopPage.tsx`
- Test: 无单测（Web），门禁 = tsc + build

**Interfaces:**
- Consumes: Task 3 `POST /api/projects/:slug/video`；Task 13 `api`/`subscribeTask`

- [ ] **Step 1: 改 AssetCard——加 video 分支与「生成视频」按钮**

先读现有 `apps/web/src/components/AssetCard.tsx`。做两处改动：

1. 组件签名加一个可选回调 `onVideo`：
把 `export default function AssetCard({ asset, onRegenerate }: { asset: Asset; onRegenerate: (feedback: string) => void }) {`
改为
```tsx
export default function AssetCard({ asset, onRegenerate, onVideo }: {
  asset: Asset
  onRegenerate: (feedback: string) => void
  onVideo?: (assetId: number) => void
}) {
```

2. 在现有 `if (asset.type === 'cover') { ... }` 分支**之前**，加 video 分支：
```tsx
  if (asset.type === 'video') {
    return (
      <div className="rounded-lg border bg-white p-3 space-y-2">
        <div className="text-sm text-neutral-500">视频 · {asset.hook} · {asset.status}</div>
        <video src={`/files/${asset.file_path}`} controls className="w-full max-h-96 rounded border bg-black" />
      </div>
    )
  }
```

3. copy 卡底部「重新生成」那一行（`<div className="flex gap-2 border-t pt-2">` 里）追加一个「生成视频」按钮（放在重新生成按钮旁）：
```tsx
        {onVideo && (
          <button className="rounded border px-3 py-1 text-sm" onClick={() => onVideo(asset.id)}>生成视频</button>
        )}
```

- [ ] **Step 2: 改 WorkshopPage——传 onVideo 并发起视频任务**

先读现有 `apps/web/src/pages/WorkshopPage.tsx`。做两处改动：

1. 加一个 `makeVideo` 函数（复用现有 `logs`/`running`/`qc`/`selected`）——放在 `generate` 函数附近：
```tsx
  async function makeVideo(assetId: number) {
    if (!selected || running) return
    setRunning(true)
    setLogs([])
    try {
      const { taskId } = await api<{ taskId: string }>(`/api/projects/${selected}/video`, {
        method: 'POST', body: JSON.stringify({ assetId }),
      })
      subscribeTask(taskId, (e) => {
        setLogs((l) => [...l, `${e.type === 'error' ? '❌ ' : ''}${e.message}`])
        logRef.current?.scrollTo({ top: 999999 })
        if (e.type === 'done' || e.type === 'error') {
          setRunning(false)
          qc.invalidateQueries({ queryKey: ['assets', selected] })
        }
      })
    } catch (err) {
      setLogs((l) => [...l, `❌ ${err instanceof Error ? err.message : String(err)}`])
      setRunning(false)
    }
  }
```

2. 渲染素材列表处，给 `AssetCard` 传 `onVideo`：
把 `<AssetCard key={a.id} asset={a} onRegenerate={(fb) => generate(fb)} />`
改为
`<AssetCard key={a.id} asset={a} onRegenerate={(fb) => generate(fb)} onVideo={(id) => makeVideo(id)} />`

- [ ] **Step 3: 类型检查与构建**

Run: `pnpm --filter web exec tsc --noEmit -p tsconfig.json`
Expected: 0 错误
Run: `pnpm --filter web build`
Expected: 构建成功

- [ ] **Step 4: Commit**

```bash
git add apps/web && git commit -m "feat(web): 素材工坊「生成视频」按钮 + 视频素材内嵌播放"
```

---

## 自查记录

- **Spec 覆盖**：studio 包+config+Remotion模板+props(T1)、renderFlash+generateVideo(T2)、server 端点+CLI(T3)、Web 按钮+播放(T4)。测试全 stub；Remotion 组件靠 tsc + 里程碑末真渲染走查。
- **类型一致**：`FlashProps`/`buildFlashProps`(T1) → `renderFlash`/`generateVideo`(T2, 返回 `{assetId, filePath}`) → server enqueue(T3)/CLI(T3)/Web(T4) 一致；video asset `type='video'`、file_path 相对路径贯穿 generate/AssetCard/`/files/`。
- **占位扫描**：无 TBD/TODO；每步完整代码；Root.tsx 的 `React.FC` 类型给了 tsc 报错时的 fallback（改 `FC`）。
- **约定遵循**：`@remotion/*` 动态 import（stub/测试不加载）；所有测试 `FORGECAST_VIDEO_MODE=stub`；文件名加 `randomUUID().slice(0,6)` 防同秒覆盖（同 M4 教训）。
- **工具链现实**：真渲染只在里程碑末走查/真实使用触发；`pnpm -r test` 全 stub。studio tsconfig 用 jsx（含 Remotion React 组件）。
