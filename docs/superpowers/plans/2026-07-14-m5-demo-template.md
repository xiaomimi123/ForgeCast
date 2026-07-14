# M5 子块③ — 模板A demo 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`).

**Goal:** 加 `generateVideo --tpl=demo`（产品演示型：钩子→痛点→录屏演示→报价→CTA），复用子块②的 TTS/字幕/renderVideo。stub 全链路可测；真实录屏渲染待录屏，未验证。

**Architecture:** 沿用 @forgecast/studio。Demo 模板演示段用 raw/ 录屏(`<OffthreadVideo>`)或占位框。generateVideo demo 分支找 raw/ 录屏 + TTS + 渲 Demo。`@remotion/*` 动态 import；所有测试 stub。

**Tech Stack:** Node 20 + pnpm 9；Remotion 4 + react；vitest；tsx。设计见 `docs/superpowers/specs/2026-07-14-m5-demo-template-design.md`。

## Global Constraints

- studio main=src/index.ts 无 build；所有测试 `FORGECAST_VIDEO_MODE=stub`（tts 默认 stub）；`pnpm -r test` 不真渲染/网络
- 产物 workspace/<slug>/videos/ 相对路径；Root.tsx Composition 用 `asComp` cast 绕 Remotion v4 泛型（同既有）
- 中文注释；TDD；commit trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

---

### Task 1: Demo 模板 + buildDemoProps + Root 注册

**Files:**
- Create: `packages/studio/src/remotion/Demo.tsx`
- Modify: `packages/studio/src/props.ts`, `packages/studio/src/remotion/Root.tsx`
- Test: `packages/studio/test/demo-props.test.ts`

**Interfaces:**
- Produces: `interface DemoProps {...}`；`buildDemoProps(doc:CopyDoc, brandName?):DemoProps`；Remotion `Demo` Composition

- [ ] **Step 1: 失败测试**

`packages/studio/test/demo-props.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { buildDemoProps } from '../src/props'

const doc = {
  titles: ['做电商还在手动回客户？', 't2', 't3'], xhsBody: '白天上班晚上回消息。微信旺旺来回切。漏一条就差评。',
  douyinScript: '【0-3s 钩子】开场\n【45-52s 报价锚点】外面几万我这一顿火锅钱\n【52-60s CTA】评论区扣1',
  cover: { main: '网店客服还在手动回？', sub: '一套系统扛三人份' }, comments: { questions: ['q1', 'q2'], replies: ['r1', 'r2', 'r3'] },
}
describe('buildDemoProps', () => {
  it('生成钩子/痛点/报价/CTA/品牌', () => {
    const p = buildDemoProps(doc as any, '快客通')
    expect(p.painTitle).toBe('网店客服还在手动回？')
    expect(Array.isArray(p.painPoints)).toBe(true)
    expect(p.painPoints.length).toBeGreaterThanOrEqual(1)
    expect(p.priceAnchor.length).toBeGreaterThan(0)
    expect(p.cta).toBe('评论区扣1')
    expect(p.brandName).toBe('快客通')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @forgecast/studio test`
Expected: FAIL（buildDemoProps 未定义）

- [ ] **Step 3: props.ts 追加 DemoProps + buildDemoProps**

`packages/studio/src/props.ts` 末尾追加（保留 Flash/Story）:
```ts
export interface DemoProps {
  painTitle: string
  painPoints: string[]
  demoVideoSrc?: string
  priceAnchor: string
  cta: string
  brandName: string
  audioSrc?: string
  cues?: Cue[]
}

/** 从文案生成演示模板参数（痛点从正文切句，报价从口播锚点段抽取，均兜底） */
export function buildDemoProps(doc: CopyDoc, brandName = 'forgecast'): DemoProps {
  const flash = buildFlashProps(doc, brandName)
  const painPoints = doc.xhsBody.split(/[。！？\n]+/).map((s) => s.trim()).filter(Boolean).slice(0, 3)
  const anchorMatch = doc.douyinScript.match(/【[^】]*报价[^】]*】\s*(.+)/)
  const priceAnchor = (anchorMatch?.[1] ?? '外面做要几万，我这套成本一顿火锅钱').trim()
  return {
    painTitle: flash.painTitle,
    painPoints: painPoints.length ? painPoints : [flash.painTitle],
    priceAnchor,
    cta: flash.cta,
    brandName,
  }
}
```
（`buildFlashProps`/`CopyDoc`/`Cue` 已在本文件可用。）

- [ ] **Step 4: Demo.tsx**

`packages/studio/src/remotion/Demo.tsx`:
```tsx
import type { FC, ReactNode } from 'react'
import { AbsoluteFill, Audio, OffthreadVideo, Sequence, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion'
import type { DemoProps } from '../props'
import { Subtitles } from './Subtitles'

const FONT = '"PingFang SC","Noto Sans CJK SC",sans-serif'

const Center: FC<{ children: ReactNode; bg: string }> = ({ children, bg }) => {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  const s = spring({ frame, fps, config: { damping: 200 } })
  return (
    <AbsoluteFill style={{ background: bg, justifyContent: 'center', alignItems: 'center', padding: 80, fontFamily: FONT, textAlign: 'center' }}>
      <div style={{ transform: `scale(${0.85 + s * 0.15})` }}>{children}</div>
    </AbsoluteFill>
  )
}

// 痛点逐条弹出（hook 只在本组件调一次，避免在 map 里调 hook）
const PainPoints: FC<{ points: string[] }> = ({ points }) => {
  const frame = useCurrentFrame()
  return (
    <AbsoluteFill style={{ background: '#16213e', justifyContent: 'center', padding: 80, fontFamily: FONT }}>
      {points.map((p, i) => {
        const op = interpolate(frame - i * 20, [0, 10], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })
        return <div key={i} style={{ color: '#fff', fontSize: 60, fontWeight: 700, margin: '20px 0', opacity: op }}>· {p}</div>
      })}
    </AbsoluteFill>
  )
}

// 模板A 产品演示型：钩子→痛点→录屏演示→报价锚点→CTA
export const Demo: FC<DemoProps> = ({ painTitle, painPoints, demoVideoSrc, priceAnchor, cta, brandName, audioSrc, cues }) => {
  return (
    <AbsoluteFill style={{ background: '#0f0f1a', fontFamily: FONT }}>
      {audioSrc ? <Audio src={audioSrc} /> : null}
      <Sequence from={0} durationInFrames={90}>
        <Center bg="linear-gradient(160deg,#1a1a2e,#16213e)"><div style={{ color: '#fff', fontSize: 96, fontWeight: 900, lineHeight: 1.3 }}>{painTitle}</div></Center>
      </Sequence>
      <Sequence from={90} durationInFrames={150}>
        <PainPoints points={painPoints} />
      </Sequence>
      <Sequence from={240} durationInFrames={1110}>
        <AbsoluteFill style={{ background: '#000' }}>
          {demoVideoSrc
            ? <OffthreadVideo src={demoVideoSrc} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            : <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center', border: '6px dashed #555', color: '#888', fontSize: 48, fontFamily: FONT }}>（演示录屏位）</AbsoluteFill>}
          <div style={{ position: 'absolute', top: 60, left: 60, background: 'rgba(0,0,0,.6)', color: '#ffd54f', fontSize: 40, fontWeight: 700, padding: '8px 20px', borderRadius: 10 }}>{painTitle}</div>
        </AbsoluteFill>
      </Sequence>
      <Sequence from={1350} durationInFrames={210}>
        <Center bg="linear-gradient(160deg,#0f3460,#16213e)"><div style={{ color: '#ffd54f', fontSize: 72, fontWeight: 800, lineHeight: 1.4 }}>{priceAnchor}</div></Center>
      </Sequence>
      <Sequence from={1560} durationInFrames={240}>
        <Center bg="#1a1a2e"><div><div style={{ color: '#fff', fontSize: 72, fontWeight: 800, marginBottom: 40 }}>{cta}</div><div style={{ color: '#8888aa', fontSize: 40 }}>@{brandName}</div></div></Center>
      </Sequence>
      {cues ? <Subtitles cues={cues} /> : null}
    </AbsoluteFill>
  )
}
```

- [ ] **Step 5: Root.tsx 注册 Demo**

`packages/studio/src/remotion/Root.tsx`：在现有 Flash+Story 之外加 Demo（import Demo + defaultDemoProps + 一个 `<Composition id="Demo" component={asComp(Demo)} durationInFrames={1800} fps={30} width={1080} height={1920} defaultProps={defaultDemoProps as unknown as Record<string,unknown>} />`）。`defaultDemoProps: DemoProps = { painTitle:'还在用老办法？', painPoints:['现状很低效','每天多花好几小时'], priceAnchor:'外面几万，我这一顿火锅钱', cta:'评论区扣1', brandName:'forgecast' }`。

- [ ] **Step 6: 跑测试 + tsc**

Run: `pnpm --filter @forgecast/studio test`（demo-props 1 + 既有全绿）
Run: `pnpm --filter @forgecast/studio exec tsc --noEmit -p tsconfig.json`（0 错误）

- [ ] **Step 7: Commit**

```bash
git add packages/studio && git commit -m "feat(studio): 模板A demo（钩子/痛点/录屏演示/报价/CTA）+ buildDemoProps + Root 注册 Demo"
```

---

### Task 2: generateVideo 支持 tpl=demo（找录屏 + 渲染）

**Files:**
- Modify: `packages/studio/src/generate.ts`
- Test: `packages/studio/test/generate-demo.test.ts`

**Interfaces:**
- Produces: `generateVideo` 支持 `tpl:'flash'|'story'|'demo'`
- Consumes: Task 1 `buildDemoProps`、既有 `synthesizeVoice`/`renderVideo`

- [ ] **Step 1: 失败测试**

`packages/studio/test/generate-demo.test.ts`:
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
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-demo-'))
  const config = loadConfig(root, { FORGECAST_VIDEO_MODE: 'stub' })
  ctx = { db: openDb(config.paths.db), config, llm: createLlmClient(config.llm) }
  ctx.db.prepare("INSERT INTO projects (slug, brand_name) VALUES ('demo', '快客通')").run()
  const cd = path.join(root, 'workspace/demo/copy'); fs.mkdirSync(cd, { recursive: true })
  fs.writeFileSync(path.join(cd, 'pain-1.md'), copyFixtures.pain)
  ctx.db.prepare("INSERT INTO assets (project_id, type, hook, file_path) VALUES (1, 'copy', 'pain', 'demo/copy/pain-1.md')").run()
})

describe('generateVideo tpl=demo (stub)', () => {
  it('无录屏：demoVideoSrc undefined，仍产 props+占位mp4+video 素材', async () => {
    const out = await generateVideo(ctx, { slug: 'demo', tpl: 'demo' })
    const abs = path.join(ctx.config.paths.workspace, out.filePath)
    expect(fs.existsSync(abs)).toBe(true)
    const props = JSON.parse(fs.readFileSync(abs.replace(/\.mp4$/, '.props.json'), 'utf8'))
    expect(Array.isArray(props.painPoints)).toBe(true)
    expect(props.demoVideoSrc).toBeUndefined()
    const row: any = ctx.db.prepare('SELECT * FROM assets WHERE id = ?').get(out.assetId)
    expect(row.type).toBe('video')
  })
  it('有 raw 录屏：demoVideoSrc 指向该文件（相对）', async () => {
    const rawDir = path.join(root, 'workspace/demo/raw'); fs.mkdirSync(rawDir, { recursive: true })
    fs.writeFileSync(path.join(rawDir, 'screen.mp4'), 'fake-video')
    const out = await generateVideo(ctx, { slug: 'demo', tpl: 'demo' })
    const props = JSON.parse(fs.readFileSync(path.join(ctx.config.paths.workspace, out.filePath).replace(/\.mp4$/, '.props.json'), 'utf8'))
    expect(props.demoVideoSrc).toBe(path.join('demo', 'raw', 'screen.mp4'))
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @forgecast/studio test`
Expected: FAIL（tpl 'demo' 未支持）

- [ ] **Step 3: generate.ts 加 demo 分支**

`packages/studio/src/generate.ts`：
- `GenerateVideoInput.tpl?: 'flash' | 'story' | 'demo'`；import `buildDemoProps`。
- 在 tpl 分支加 `demo`（与 story 并列）：
```ts
  } else if (tpl === 'demo') {
    const dp = buildDemoProps(doc, brandName)
    // 找 raw/ 下第一个录屏作演示底（无则占位）
    const rawDir = path.join(ctx.config.paths.workspace, slug, 'raw')
    if (fs.existsSync(rawDir)) {
      const vid = fs.readdirSync(rawDir).find((f) => /\.(mp4|mov)$/i.test(f))
      if (vid) dp.demoVideoSrc = path.join(slug, 'raw', vid)
    }
    onProgress('TTS 配音…')
    const wavAbs = path.join(videoDir, `${base}.wav`)
    const voice = await synthesizeVoice(ctx, doc.douyinScript, wavAbs)
    dp.audioSrc = voice.audioRel ?? undefined
    dp.cues = voice.cues
    props = dp as unknown as Record<string, unknown>
    compositionId = 'Demo'
  } else if (tpl === 'story') {
```
（即把现有 `if (tpl === 'story')` 改为 `if (tpl === 'demo') {...} else if (tpl === 'story') {...} else {flash}`；story/flash 分支不变。）

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @forgecast/studio test`（generate-demo 2 + 既有全绿）
Run: `pnpm --filter @forgecast/studio exec tsc --noEmit -p tsconfig.json`（0 错误）

- [ ] **Step 5: Commit**

```bash
git add packages/studio && git commit -m "feat(studio): generateVideo 支持 tpl=demo（找 raw 录屏作演示底 + TTS + 渲 Demo）"
```

---

### Task 3: server/CLI tpl 白名单加 demo

**Files:**
- Modify: `packages/server/src/app.ts`, `cli.ts`
- Test: `packages/server/test/video.test.ts`（追加 demo 用例）

- [ ] **Step 1: 追加失败测试**

在 `packages/server/test/video.test.ts` 追加：
```ts
  it('POST video {tpl:demo} → 任务完成 → video 素材', async () => {
    const { taskId } = await (await app.request('/api/projects/demo/video', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tpl: 'demo' }),
    })).json() as any
    await runTask(taskId)
    const assets = await (await app.request('/api/projects/demo/assets')).json() as any[]
    expect(assets.some((a) => a.type === 'video')).toBe(true)
  })
```

- [ ] **Step 2: 跑测试确认失败/通过判断**

Run: `pnpm --filter @forgecast/server test`
（当前 tpl 白名单只放 story，demo 会回落 flash——用例断言 video 素材存在仍会过；但为让 demo 真正走 Demo 模板，按 Step 3 放开。）

- [ ] **Step 3: 放开 demo**

`packages/server/src/app.ts` video 路由：把 `const tpl = body.tpl === 'story' ? 'story' : 'flash'` 改为：
```ts
    const tpl = ['story', 'demo'].includes(body.tpl) ? body.tpl : 'flash'
```

`cli.ts` video case：把 `const tpl = arg('tpl') === 'story' ? 'story' : 'flash'` 改为：
```ts
      const tpl = (['story', 'demo'] as const).includes(arg('tpl') as any) ? (arg('tpl') as 'story' | 'demo') : 'flash'
```
（并把用法提示更新为 `--tpl=flash|story|demo`。）

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @forgecast/server test`（video demo + 既有全绿）

- [ ] **Step 5: Commit**

```bash
git add packages/server cli.ts && git commit -m "feat(server+cli): video tpl 白名单加 demo（flash/story/demo）"
```

---

## 自查记录

- **Spec 覆盖**：Demo 模板+buildDemoProps+Root(T1)、generateVideo demo 分支+找录屏(T2)、server/CLI tpl(T3)。全 stub 可测；真实录屏渲染未验证。
- **类型一致**：`DemoProps`(T1) → generate demo 分支(T2) → server/CLI tpl(T3)；`Cue`/`Subtitles`/`synthesizeVoice`/`renderVideo` 复用子块②。
- **约定遵循**：demo 分支 stub 可测（无录屏回退占位）；Root cast 绕 Remotion 泛型；所有测试 stub。
- **未验证明确**：`<OffthreadVideo>` 录屏渲染、真实时长对齐待录屏——设计/计划已标注。
