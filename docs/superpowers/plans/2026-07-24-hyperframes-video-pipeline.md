# HyperFrames 主视频流水线（全面替换 Remotion）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `forgecast video` 的渲染引擎从 Remotion 全面替换为 HyperFrames（HTML→headless Chrome+ffmpeg→MP4），配 Kokoro 离线中文配音，保持 `generateVideo` 对外签名与 CLI/server 集成点不变。

**Architecture:** 每条视频在 `workspace/<slug>/hf/` 生成一个 HyperFrames 项目：把数据填进带 `{{slot}}` 的 HTML 模板 → 写 index.html，生成 narration.wav，spawn `hyperframes render` 出 MP4。模板填充沿用 `copywriter/src/cover.ts` 的读文件+字符串替换套路。4 套模板（changelog/demo/story/flash），CJK 字体用 @font-face 打底。

**Tech Stack:** TypeScript、pnpm workspace、vitest、HyperFrames CLI（Node 22+）、Kokoro TTS（Python venv + kokoro-onnx + espeak-ng）、ffmpeg、Docker。

## Global Constraints

- 设计文档：`docs/superpowers/specs/2026-07-24-hyperframes-video-pipeline-design.md`，冲突时以它为准。
- **`generateVideo(ctx, input)` 对外签名、CLI `forgecast video`、server 视频路由保持不变**——换引擎只在内部。
- **HyperFrames CLI 要求 Node 22+**。forgecast 进程本身也须跑在 Node 22+（本地 `nvm use system` 到 v25，Docker 用 node:22 基镜像）。渲染包装器调 `hyperframes` 用 PATH 上的 node。
- **模板填充禁止用模板字符串拼 HTML 正文**——读 `templates/hf/<name>.html` + 具名 slot 替换（同 `cover.ts` 的 `buildCoverHtml`）。用户数据填进 HTML 前必须转义。
- **CJK 字体**：模板顶部 `@font-face` 指向 `templates/hf/fonts/NotoSansSC.otf`，`font-family` 用它，不靠宿主系统字体。
- **mock/降级可见**：TTS 缺 key/依赖降级时经 `modeNotes` 或进度输出说明，不静默（沿用现有约定）。
- 中文注释与中文提交信息。本仓库 vitest 只转译不做类型检查——改跨包类型/导出后额外 `npx tsc -p <pkg>/tsconfig.json --noEmit`。
- 每个任务结束跑 `pnpm -r test`，全绿才提交。

**参考产物**：会话中已真机试跑通一条 changelog 竖屏成片（1080×1920，中文正常，Kokoro `zf_xiaobei` 配音，代码 diff 卡片）。其 HTML 见 Task 5 的完整代码。

---

## 阶段一：核心引擎（changelog 端到端）

### Task 1: 项目升级到 Node 22+ 并声明

**Files:**
- Create: `.nvmrc`
- Modify: `package.json`（根，加 `engines`）
- Modify: `README.md`（快速开始注明 Node 22+）

**Interfaces:**
- Consumes: 无
- Produces: 项目声明 Node 22+，后续任务据此假设 `node`/`npx` 为 22+。

- [ ] **Step 1: 写 .nvmrc**

Create `.nvmrc`：

```
22
```

- [ ] **Step 2: 根 package.json 加 engines**

`package.json` 顶层对象加：

```json
  "engines": { "node": ">=22" },
```

- [ ] **Step 3: 验证当前环境有 22+**

Run: `node -v`（若 <22：`nvm use system` 或 `nvm install 22`，本机 system node 为 v25.8.2）
Expected: v22 或更高

- [ ] **Step 4: README 注明**

`README.md` 「快速开始」附近加一行：`> 需要 Node 22+（视频渲染依赖 HyperFrames）。本地可 \`nvm use\`。`

- [ ] **Step 5: 提交**

```bash
git add .nvmrc package.json README.md
git commit -m "chore: 项目要求 Node 22+（HyperFrames 视频渲染依赖）"
```

---

### Task 2: 配置层加 kokoro TTS 模式

**Files:**
- Modify: `packages/core/src/config.ts`
- Modify: `packages/core/src/settings.ts`（`normalizeModes`）
- Test: `packages/core/test/config.test.ts`、`packages/core/test/settings.test.ts`

**Interfaces:**
- Consumes: 无
- Produces: `TtsMode = 'stub' | 'live' | 'kokoro'`；`config.tts.mode` 可为 `'kokoro'`；`normalizeModes` 对 kokoro 缺依赖不崩（kokoro 无需 key，运行时缺 Python 依赖在 TTS 层降级，非 config 层）。

- [ ] **Step 1: 写失败测试**

追加到 `packages/core/test/config.test.ts`：

```typescript
it('FORGECAST_TTS_MODE=kokoro 被识别', () => {
  const c = loadConfig('/tmp/x', { FORGECAST_TTS_MODE: 'kokoro' })
  expect(c.tts.mode).toBe('kokoro')
})
it('kokoro 是默认 TTS 模式（未设时）', () => {
  const c = loadConfig('/tmp/x', {})
  expect(c.tts.mode).toBe('kokoro')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @forgecast/core test config`
Expected: FAIL —— mode 为 'stub' 而非 'kokoro'

- [ ] **Step 3: 改类型与默认**

`packages/core/src/config.ts`：

```typescript
export type TtsMode = 'stub' | 'live' | 'kokoro'
```

`loadConfig` 里 tts.mode 解析改为（默认 kokoro）：

```typescript
      mode: env.FORGECAST_TTS_MODE === 'live' ? 'live'
        : env.FORGECAST_TTS_MODE === 'stub' ? 'stub'
        : 'kokoro',
```

- [ ] **Step 4: normalizeModes 不误降 kokoro**

`packages/core/src/settings.ts` 的 `normalizeModes` 里，TTS 只在 `live` 缺 key 时降级；kokoro 不动。确认现有那行是：

```typescript
  if (config.tts.mode === 'live' && !config.tts.apiKey) {
    config.tts.mode = 'stub'
    notes.push('TTS 设为 live 但缺 key，已降级 stub（占位静音音轨）')
  }
```

（kokoro 无 key 概念，不加降级分支——运行时缺 Python 依赖由 TTS 层处理。）追加一条测试到 `settings.test.ts`：

```typescript
it('kokoro 模式不被 normalizeModes 降级', () => {
  const config = loadConfig(root, {})
  config.tts.mode = 'kokoro'; config.tts.apiKey = ''
  normalizeModes(config)
  expect(config.tts.mode).toBe('kokoro')
})
```

- [ ] **Step 5: 跑测试 + tsc**

Run: `pnpm --filter @forgecast/core test` 与 `npx tsc -p packages/core/tsconfig.json --noEmit`
Expected: 全绿、无类型错误

- [ ] **Step 6: 提交**

```bash
git add packages/core
git commit -m "feat(core): TTS 加 kokoro 离线模式（默认）"
```

---

### Task 3: TTS 层重写（kokoro / live / stub）

**Files:**
- Modify: `packages/studio/src/tts.ts`
- Test: `packages/studio/test/tts.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `config.tts.mode: 'stub'|'live'|'kokoro'`
- Produces: `synthesizeVoice(ctx, text, outWavAbs, deps?)` 保持返回 `{ audioRel, cues, degraded? }`。新增内部 `synthesizeKokoro`。`deps` 可注入 `runKokoro`/`fetchImpl` 供测试。kokoro 缺依赖/失败 → 降级 stub 并带 `degraded` 原因。

- [ ] **Step 1: 写失败测试**

追加到 `packages/studio/test/tts.test.ts`：

```typescript
describe('synthesizeVoice kokoro', () => {
  it('kokoro 模式调 runKokoro 写 wav，成功不降级', async () => {
    const out = path.join(root, 'workspace/demo/videos/k.wav')
    const config = loadConfig(root, { FORGECAST_TTS_MODE: 'kokoro' })
    const kctx: CoreCtx = { db: ctx.db, config, llm: ctx.llm }
    const runKokoro = vi.fn(async (_text: string, outPath: string) => {
      fs.mkdirSync(path.dirname(outPath), { recursive: true })
      fs.writeFileSync(outPath, Buffer.from([1, 2, 3, 4]))
    })
    const r = await synthesizeVoice(kctx, '一句话。', out, { runKokoro })
    expect(runKokoro).toHaveBeenCalledOnce()
    expect(r.degraded).toBeUndefined()
    expect(fs.readFileSync(out).length).toBe(4)
    expect(r.cues.length).toBe(1)
  })

  it('kokoro 失败时降级占位并带原因', async () => {
    const out = path.join(root, 'workspace/demo/videos/kf.wav')
    const config = loadConfig(root, { FORGECAST_TTS_MODE: 'kokoro' })
    const kctx: CoreCtx = { db: ctx.db, config, llm: ctx.llm }
    const runKokoro = vi.fn(async () => { throw new Error('kokoro-onnx 未安装') })
    const r = await synthesizeVoice(kctx, '一句话。', out, { runKokoro })
    expect(r.degraded).toContain('kokoro-onnx 未安装')
    expect(fs.existsSync(out)).toBe(true) // 占位 wav
  })
})
```

（既有 stub/live 测试保留；把 `synthesizeVoice` 的第 4 参从 `fetchImpl` 改为 `deps` 对象后，旧 live 测试的 `fetchSpy as any` 传参改为 `{ fetchImpl: fetchSpy }`——一并更新。）

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @forgecast/studio test tts`
Expected: FAIL —— kokoro 分支未实现

- [ ] **Step 3: 重写 tts.ts**

`packages/studio/src/tts.ts` 顶部 import 加 `child_process`：

```typescript
import { spawn } from 'node:child_process'
```

新增 kokoro 运行器（默认实现，spawn `hyperframes tts`）：

```typescript
export interface TtsDeps {
  runKokoro?: (text: string, outWavAbs: string) => Promise<void>
  fetchImpl?: typeof fetch
}

/** 默认 Kokoro 运行器：spawn `hyperframes tts`。需环境已装 kokoro-onnx + espeak-ng（见部署文档）。 */
function defaultRunKokoro(voice: string): (text: string, outWavAbs: string) => Promise<void> {
  return (text, outWavAbs) => new Promise((resolve, reject) => {
    const args = ['hyperframes', 'tts', text, '--voice', voice, '--lang', 'zh', '--output', outWavAbs]
    const p = spawn('npx', args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let err = ''
    p.stderr.on('data', (d) => { err += d.toString() })
    p.on('error', reject)
    p.on('close', (code) => code === 0 ? resolve() : reject(new Error(`hyperframes tts 退出码 ${code}: ${err.slice(0, 300)}`)))
  })
}
```

把 `synthesizeVoice` 签名第 4 参从 `fetchImpl` 改为 `deps: TtsDeps = {}`，并加 kokoro 分支：

```typescript
export async function synthesizeVoice(
  ctx: CoreCtx, text: string, outWavAbs: string, deps: TtsDeps = {},
): Promise<VoiceResult> {
  const rel = path.relative(ctx.config.paths.workspace, outWavAbs)
  const cues = cuesFrom(splitSentences(text))
  const writeStub = () => { fs.mkdirSync(path.dirname(outWavAbs), { recursive: true }); fs.writeFileSync(outWavAbs, minimalWav()) }
  const degrade = (reason: string): VoiceResult => { writeStub(); return { audioRel: rel, cues, degraded: reason } }

  if (ctx.config.tts.mode === 'stub') { writeStub(); return { audioRel: rel, cues } }

  if (ctx.config.tts.mode === 'kokoro') {
    const run = deps.runKokoro ?? defaultRunKokoro('zf_xiaobei')
    try {
      await run(text, outWavAbs)
      if (!fs.existsSync(outWavAbs) || fs.statSync(outWavAbs).size === 0) return degrade('Kokoro 未产出音频')
      return { audioRel: rel, cues }
    } catch (err) {
      return degrade(`Kokoro 失败: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // live（原实现，fetchImpl 从 deps 取）
  const fetchImpl = deps.fetchImpl ?? fetch
  // ……（保留原 live 分支代码，把 fetchImpl 引用改为此处的 fetchImpl）
```

将原 live 分支中所有 `fetchImpl` 引用指向新的 `deps.fetchImpl ?? fetch`。

- [ ] **Step 4: 更新 generate.ts 与 server 的调用**

`packages/studio/src/generate.ts` 里两处 `await synthesizeVoice(ctx, doc.douyinScript, wavAbs)` 不变（第 4 参用默认）。`packages/server/src/app.ts` 的 `test-tts` 路由里 `synthesizeVoice(ctx, '连接测试', tmp)` 也不变（默认 deps）。确认无残留的 `fetchImpl` 位置传参。

- [ ] **Step 5: 跑测试 + tsc**

Run: `pnpm --filter @forgecast/studio test tts`、`pnpm --filter @forgecast/server test settings`、`npx tsc -p packages/studio/tsconfig.json --noEmit`
Expected: 全绿

- [ ] **Step 6: 提交**

```bash
git add packages/studio packages/server
git commit -m "feat(studio): TTS 层加 Kokoro 离线中文配音（spawn hyperframes tts，失败降级）"
```

---

### Task 4: HyperFrames 渲染包装器 + 项目脚手架 + CJK 字体

**Files:**
- Create: `packages/studio/src/hyperframes.ts`
- Create: `templates/hf/hyperframes.json`
- Create: `templates/hf/fonts/README.md`（字体获取说明）
- Test: `packages/studio/test/hyperframes.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `fillTemplate(tplHtml: string, slots: Record<string, string>): string` —— 具名 slot 替换 + HTML 转义。
  - `escapeHtml(s: string): string`
  - `scaffoldHfProject(destDir, indexHtml, assets): void` —— 写出 hyperframes.json + index.html + assets/ + fonts/ 链接。
  - `renderHyperframes(projectDir, outPath, mode, opts?): Promise<void>` —— stub 写占位；render spawn `hyperframes render`。

- [ ] **Step 1: 写失败测试**

Create `packages/studio/test/hyperframes.test.ts`：

```typescript
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { escapeHtml, fillTemplate, renderHyperframes, scaffoldHfProject } from '../src/hyperframes'

describe('fillTemplate', () => {
  it('替换具名 slot 并转义用户数据', () => {
    const out = fillTemplate('<h1>{{title}}</h1>', { title: 'a<b>&"c' })
    expect(out).toBe('<h1>a&lt;b&gt;&amp;&quot;c</h1>')
  })
  it('未提供的 slot 替换为空串', () => {
    expect(fillTemplate('x{{y}}z', {})).toBe('xz')
  })
})

describe('escapeHtml', () => {
  it('转义 & < > " 单引号', () => {
    expect(escapeHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;')
  })
})

describe('scaffoldHfProject', () => {
  it('写出 hyperframes.json + index.html + assets', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hf-'))
    scaffoldHfProject(dir, '<html>x</html>', { 'narration.wav': Buffer.from([1, 2]) })
    expect(fs.existsSync(path.join(dir, 'hyperframes.json'))).toBe(true)
    expect(fs.readFileSync(path.join(dir, 'index.html'), 'utf8')).toContain('x')
    expect(fs.readFileSync(path.join(dir, 'assets/narration.wav')).length).toBe(2)
  })
})

describe('renderHyperframes stub', () => {
  it('stub 模式写占位不 spawn', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hf-'))
    const out = path.join(dir, 'out.mp4')
    await renderHyperframes(dir, out, 'stub')
    expect(fs.existsSync(out)).toBe(true)
    expect(fs.statSync(out).size).toBeGreaterThan(0)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @forgecast/studio test hyperframes`
Expected: FAIL —— 模块不存在

- [ ] **Step 3: 实现 hyperframes.ts**

Create `packages/studio/src/hyperframes.ts`：

```typescript
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const STUB_BYTES = Buffer.from('FORGECAST_STUB_MP4\n')
// templates/hf 相对本文件：packages/studio/src → 仓库根/templates/hf
const HF_TEMPLATES = fileURLToPath(new URL('../../../templates/hf', import.meta.url))

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

/** 具名 slot 替换：{{key}} → escapeHtml(slots[key])；未提供的 slot 替空。 */
export function fillTemplate(tplHtml: string, slots: Record<string, string>): string {
  return tplHtml.replace(/\{\{(\w+)\}\}/g, (_, k) => (k in slots ? escapeHtml(slots[k]) : ''))
}

/** 读 templates/hf/<name>.html */
export function readTemplate(name: string): string {
  return fs.readFileSync(path.join(HF_TEMPLATES, `${name}.html`), 'utf8')
}

/** 脚手架：写 hyperframes.json + index.html + assets/*，软链 fonts。 */
export function scaffoldHfProject(destDir: string, indexHtml: string, assets: Record<string, Buffer> = {}): void {
  fs.mkdirSync(path.join(destDir, 'assets'), { recursive: true })
  fs.copyFileSync(path.join(HF_TEMPLATES, 'hyperframes.json'), path.join(destDir, 'hyperframes.json'))
  // fonts 目录软链（相对 index.html 的 assets/fonts 引用统一）
  const fontsSrc = path.join(HF_TEMPLATES, 'fonts')
  const fontsDst = path.join(destDir, 'assets', 'fonts')
  if (fs.existsSync(fontsSrc) && !fs.existsSync(fontsDst)) {
    try { fs.symlinkSync(fontsSrc, fontsDst, 'dir') } catch { fs.cpSync(fontsSrc, fontsDst, { recursive: true }) }
  }
  fs.writeFileSync(path.join(destDir, 'index.html'), indexHtml, 'utf8')
  for (const [name, buf] of Object.entries(assets)) fs.writeFileSync(path.join(destDir, 'assets', name), buf)
}

/** 渲染：stub 写占位；render spawn `hyperframes render`（需 Node 22+、已 ensure 浏览器）。 */
export async function renderHyperframes(
  projectDir: string, outPath: string, mode: 'render' | 'stub',
  opts: { onProgress?: (m: string) => void } = {},
): Promise<void> {
  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  if (mode === 'stub') { fs.writeFileSync(outPath, STUB_BYTES); return }
  await new Promise<void>((resolve, reject) => {
    const p = spawn('npx', ['hyperframes', 'render', '--output', outPath], { cwd: projectDir, stdio: ['ignore', 'pipe', 'pipe'] })
    let err = ''
    p.stdout.on('data', (d) => opts.onProgress?.(d.toString().trim().slice(0, 120)))
    p.stderr.on('data', (d) => { err += d.toString() })
    p.on('error', reject)
    p.on('close', (code) => code === 0 ? resolve() : reject(new Error(`hyperframes render 退出码 ${code}: ${err.slice(0, 400)}`)))
  })
}
```

- [ ] **Step 4: 写 hyperframes.json 脚手架**

Create `templates/hf/hyperframes.json`：

```json
{
  "$schema": "https://hyperframes.heygen.com/schema/hyperframes.json",
  "registry": "https://raw.githubusercontent.com/heygen-com/hyperframes/main/registry",
  "paths": { "blocks": "compositions", "components": "compositions/components", "assets": "assets" },
  "media": { "autoProxy": true }
}
```

- [ ] **Step 5: 字体说明占位**

Create `templates/hf/fonts/README.md`：

```markdown
# 打包字体

放置 `NotoSansSC.otf`（思源黑体 / Noto Sans SC，SIL OFL 协议，可商用）。
模板通过 @font-face 引用 `assets/fonts/NotoSansSC.otf`，保证 Docker 与本地渲染一致、不出豆腐块。

获取：https://github.com/notofonts/noto-cjk/releases （Sans/OTF/NotoSansSC-Regular.otf，重命名为 NotoSansSC.otf）
```

（真渲任务前需人工放入字体文件；见 Task 5 Step 6。）

- [ ] **Step 6: 跑测试确认通过**

Run: `pnpm --filter @forgecast/studio test hyperframes`
Expected: PASS

- [ ] **Step 7: 提交**

```bash
git add packages/studio/src/hyperframes.ts packages/studio/test/hyperframes.test.ts templates/hf
git commit -m "feat(studio): HyperFrames 渲染包装器 + 项目脚手架 + 模板填充"
```

---

### Task 5: changelog 模板 + 接进 generateVideo（端到端里程碑）

**Files:**
- Create: `templates/hf/changelog.html`
- Modify: `packages/studio/src/props.ts`（加 `buildChangelogProps`）
- Modify: `packages/studio/src/generate.ts`（加 changelog 分支，改用 hyperframes）
- Test: `packages/studio/test/props.test.ts`、`packages/studio/test/generate.test.ts`

**Interfaces:**
- Consumes: Task 3 `synthesizeVoice`、Task 4 `fillTemplate`/`readTemplate`/`scaffoldHfProject`/`renderHyperframes`
- Produces: `buildChangelogProps(doc, brandName): Record<string,string>`（slot 值全为 string）；`generateVideo` 支持 `tpl: 'changelog'`；`GenerateVideoInput.tpl` 类型加 `'changelog'`。

- [ ] **Step 1: 写失败测试（props）**

追加到 `packages/studio/test/props.test.ts`：

```typescript
import { buildChangelogProps } from '../src/props'

describe('buildChangelogProps', () => {
  it('产出 title/sellingPoint/cta/brandName 全为字符串', () => {
    const doc = {
      titles: ['看板改版'], xhsBody: '正文', douyinScript: '【52-60s CTA】评论区扣1',
      cover: { main: '看板改版', sub: '候选卡片' }, comments: { questions: [], replies: [] },
    } as any
    const p = buildChangelogProps(doc, '内容工厂')
    expect(typeof p.title).toBe('string')
    expect(p.title.length).toBeGreaterThan(0)
    expect(p.brandName).toBe('内容工厂')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @forgecast/studio test props`
Expected: FAIL —— `buildChangelogProps` 未导出

- [ ] **Step 3: 实现 buildChangelogProps**

`packages/studio/src/props.ts` 末尾加：

```typescript
/** changelog 模板 slot：全 string（HTML 填槽）。数据来自封面文案/标题，CTA 复用 flash 抽取。 */
export function buildChangelogProps(doc: CopyDoc, brandName = 'forgecast'): Record<string, string> {
  const flash = buildFlashProps(doc, brandName)
  return {
    label: '本周更新',
    title: doc.cover.main || doc.titles[0] || '本周更新',
    subtitle: doc.cover.sub || doc.titles[1] || '',
    cta: flash.cta,
    brandName,
  }
}
```

- [ ] **Step 4: 写 changelog.html 模板**

Create `templates/hf/changelog.html`（基于会话已真渲验证的 demo，slot 化；@font-face 打底 CJK；音轨/字幕由 generate 注入 `{{audioTag}}`/`{{captionScript}}`）：

```html
<!doctype html>
<html lang="zh">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=1080, height=1920" />
    <script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
    <style>
      @font-face { font-family: "NotoSC"; src: url("assets/fonts/NotoSansSC.otf"); }
      * { margin: 0; padding: 0; box-sizing: border-box; }
      html, body { width: 1080px; height: 1920px; overflow: hidden; background: #0d1117; font-family: "NotoSC", sans-serif; }
      .fill { position: absolute; inset: 0; } .pad { padding: 90px; }
      .label { display: inline-block; font-size: 34px; font-weight: 700; letter-spacing: 4px; color: #0d1117; background: #ffd54f; padding: 10px 26px; border-radius: 10px; }
      .title { font-size: 82px; font-weight: 900; line-height: 1.28; color: #f0f6fc; margin-top: 44px; }
      .sub { font-size: 40px; color: #8b949e; margin-top: 28px; }
      .brand { font-size: 96px; font-weight: 900; color: #f0f6fc; text-align: center; }
      .tag { font-size: 44px; color: #ffd54f; margin-top: 30px; font-weight: 700; text-align: center; }
      #cap { position: absolute; left: 0; right: 0; bottom: 150px; text-align: center; font-size: 46px; font-weight: 800; color: #fff; padding: 0 70px; text-shadow: 0 4px 22px rgba(0,0,0,.9); }
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="main" data-start="0" data-duration="12" data-width="1080" data-height="1920">
      <div id="s1" class="clip fill pad" data-start="0" data-duration="6" data-track-index="1" style="display:flex;flex-direction:column;justify-content:center">
        <div><span class="label">{{label}}</span></div>
        <div class="title">{{title}}</div>
        <div class="sub">{{subtitle}}</div>
      </div>
      <div id="s2" class="clip fill pad" data-start="6" data-duration="6" data-track-index="1" style="display:flex;flex-direction:column;justify-content:center;align-items:center">
        <div class="brand">{{brandName}}</div>
        <div class="tag">{{cta}}</div>
      </div>
      <div id="cap" class="clip" data-start="0" data-duration="12" data-track-index="9"></div>
      {{audioTag}}
    </div>
    <script>
      window.__timelines = window.__timelines || {};
      const tl = gsap.timeline({ paused: true });
      tl.from("#s1 .label", { opacity: 0, y: -30, duration: .5 }, 0.1)
        .from("#s1 .title", { opacity: 0, y: 40, duration: .7 }, 0.35)
        .from("#s1 .sub", { opacity: 0, duration: .5 }, 0.9);
      tl.from("#s2 .brand", { opacity: 0, scale: .85, duration: .7 }, 6.2)
        .from("#s2 .tag", { opacity: 0, y: 24, duration: .5 }, 6.9);
      tl.fromTo("#root", { scale: 1 }, { scale: 1.03, duration: 12, ease: "none" }, 0);
      window.__timelines["main"] = tl;
      {{captionScript}}
    </script>
  </body>
</html>
```

注：`{{label}}`/`{{title}}`/`{{subtitle}}`/`{{brandName}}`/`{{cta}}` 由 `fillTemplate` 转义填入；`{{audioTag}}`/`{{captionScript}}` 由 generate 直接字符串替换（非用户数据，不转义，见 Step 5）。

- [ ] **Step 5: generate.ts 接 changelog 分支**

`packages/studio/src/generate.ts`：

改 import（去 render/props 的 Remotion 相关，加 hyperframes）：

```typescript
import { buildChangelogProps, buildDemoProps, buildFlashProps, buildStoryProps } from './props'
import { fillTemplate, readTemplate, renderHyperframes, scaffoldHfProject } from './hyperframes'
import { synthesizeVoice } from './tts'
```

`GenerateVideoInput.tpl` 类型加 `'changelog'`：

```typescript
  tpl?: 'flash' | 'story' | 'demo' | 'changelog'
```

在 `if (tpl === 'demo')` 之前插入 changelog 分支（先只接 changelog，其余模板 Task 6-8 迁移；本任务 demo/story/flash 仍走旧 Remotion 路径以保持绿——见 Step 6 说明）：

本任务采用最小切换：**只让 changelog 走 HyperFrames，先证明端到端**。在 generateVideo 里，tpl==='changelog' 时完全独立成一条路径并 return，不碰现有 flash/story/demo：

```typescript
  if (tpl === 'changelog') {
    const slots = buildChangelogProps(doc, brandName)
    const hfDir = path.join(ctx.config.paths.workspace, slug, 'hf')
    // 配音
    onProgress('TTS 配音…')
    const wavAbs = path.join(hfDir, 'assets', 'narration.wav')
    const voice = await synthesizeVoice(ctx, doc.douyinScript, wavAbs)
    if (voice.degraded) onProgress(`⚠ TTS 降级：${voice.degraded}`)
    // 音轨标签 + 字幕脚本（非用户数据，直接替换不转义）
    const audioTag = voice.audioRel
      ? '<audio id="narration" class="clip" data-start="0" data-duration="12" data-track-index="0" data-audio="true" src="assets/narration.wav"></audio>'
      : ''
    const capScript = voice.cues.map((c) =>
      `tl.set(document.getElementById("cap"), { textContent: ${JSON.stringify(c.text)} }, ${c.start});`,
    ).join('\n')
    // 填模板 → 脚手架 → 渲染
    const html = fillTemplate(readTemplate('changelog'), slots)
      .replace('{{audioTag}}', audioTag).replace('{{captionScript}}', capScript)
    scaffoldHfProject(hfDir, html)
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const relPath = path.join(slug, 'videos', `changelog-${copy.hook ?? 'dev'}-${stamp}-${randomUUID().slice(0, 6)}.mp4`)
    const outAbs = path.join(ctx.config.paths.workspace, relPath)
    onProgress(`渲染视频（HyperFrames，${ctx.config.video.mode}）…`)
    await renderHyperframes(hfDir, outAbs, ctx.config.video.mode === 'stub' ? 'stub' : 'render', { onProgress })
    const info = ctx.db.prepare(
      'INSERT INTO assets (project_id, type, hook, file_path, warnings) VALUES (?, ?, ?, ?, ?)',
    ).run(project.id, 'video', copy.hook, relPath, '[]')
    onProgress(`视频完成: ${relPath}`)
    return { assetId: Number(info.lastInsertRowid), filePath: relPath }
  }
```

- [ ] **Step 6: 更新 generate 测试**

追加到 `packages/studio/test/generate.test.ts`（stub 模式，验证 changelog 端到端产出 asset 行 + hf 项目）：

```typescript
it('tpl=changelog 走 HyperFrames stub，产出 asset 行与 hf 项目', async () => {
  // 前置：建 project + copy 素材（沿用该文件既有 helper）
  // ……seedProjectAndCopy(ctx, 'demo') 之类；若无 helper 按既有测试写法内联
  const r = await generateVideo(ctx, { slug: 'demo', tpl: 'changelog', onProgress: () => {} })
  expect(r.filePath).toContain('changelog-')
  const hfIndex = path.join(ctx.config.paths.workspace, 'demo', 'hf', 'index.html')
  expect(fs.existsSync(hfIndex)).toBe(true)
  expect(fs.readFileSync(hfIndex, 'utf8')).toContain('data-composition-id="main"')
})
```

（该测试用默认 config，`FORGECAST_VIDEO_MODE` 未设为 render 时 `ctx.config.video.mode` 默认 'render'——本测试须传 stub。在 beforeEach 或本用例用 `loadConfig(root, { FORGECAST_VIDEO_MODE: 'stub', FORGECAST_TTS_MODE: 'stub' })` 构造 ctx，避免真 spawn。）

- [ ] **Step 7: 跑测试 + tsc**

Run: `pnpm --filter @forgecast/studio test`、`npx tsc -p packages/studio/tsconfig.json --noEmit`
Expected: 全绿

- [ ] **Step 8: 真渲验证（人工，里程碑）**

放入字体 `templates/hf/fonts/NotoSansSC.otf`。CLI 真跑：

```bash
nvm use system   # node 22+
export FORGECAST_TTS_MODE=stub   # 先不依赖 kokoro，验证渲染管线
npx tsx cli.ts video <已有copy素材的slug> --tpl=changelog
ffprobe <产物.mp4>   # 确认 1080x1920
```

抽帧确认中文非豆腐块。TTS 单独验证：`FORGECAST_TTS_MODE=kokoro` 再跑一次（需先装 kokoro，见部署文档）。

- [ ] **Step 9: 提交**

```bash
git add templates/hf/changelog.html packages/studio
git commit -m "feat(studio): changelog 模板接入 generateVideo（HyperFrames 端到端里程碑）"
```

---

## 阶段二：迁移余下模板

### Task 6: demo 模板（产品截图轮播 / 手机外框）

**Files:**
- Create: `templates/hf/demo.html`
- Modify: `packages/studio/src/props.ts`（`buildDemoProps` 产 slot + 截图列表）
- Modify: `packages/studio/src/generate.ts`（demo 分支改走 HyperFrames）
- Modify: `packages/studio/src/hyperframes.ts`（加 `readShots(dir)` 读截图目录 + 尺寸判向）
- Test: `packages/studio/test/props.test.ts`、`packages/studio/test/hyperframes.test.ts`

**Interfaces:**
- Consumes: Task 4/5 基建
- Produces: `readShots(shotsDir): Array<{ rel: string; orientation: 'portrait'|'landscape' }>`（读 png/jpg/webp 头解析宽高，损坏按 landscape 兜底）；demo 分支生成截图轮播段。

- [ ] **Step 1: 写失败测试（尺寸判向）**

追加到 `hyperframes.test.ts`：

```typescript
import { readShots } from '../src/hyperframes'
describe('readShots', () => {
  it('按文件名排序、解析竖/横向；非图片忽略；空目录空数组', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shots-'))
    // 1x2 png（竖）与 2x1 png（横）最小合法头
    fs.writeFileSync(path.join(dir, '02.png'), pngOf(1, 2))
    fs.writeFileSync(path.join(dir, '01.png'), pngOf(2, 1))
    fs.writeFileSync(path.join(dir, 'note.txt'), 'x')
    const shots = readShots(dir)
    expect(shots.map((s) => s.rel)).toEqual(['01.png', '02.png'])
    expect(shots[0].orientation).toBe('landscape')
    expect(shots[1].orientation).toBe('portrait')
  })
})
// 辅助：构造给定宽高的最小 PNG（IHDR 里写宽高即可，无需完整像素）
function pngOf(w: number, h: number): Buffer {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  const ihdr = Buffer.alloc(25)
  ihdr.writeUInt32BE(13, 0); ihdr.write('IHDR', 4)
  ihdr.writeUInt32BE(w, 8); ihdr.writeUInt32BE(h, 12)
  return Buffer.concat([sig, ihdr])
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @forgecast/studio test hyperframes`
Expected: FAIL —— `readShots` 未导出

- [ ] **Step 3: 实现 readShots**

`packages/studio/src/hyperframes.ts` 加（读 png/jpg/webp 头取宽高，纯 Node 无图像库）：

```typescript
export interface Shot { rel: string; orientation: 'portrait' | 'landscape' }

function imageSize(buf: Buffer): { w: number; h: number } | null {
  // PNG: 8B 签名 + IHDR
  if (buf.length >= 24 && buf[0] === 0x89 && buf[1] === 0x50) return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) }
  // JPEG: 扫 SOF0/2 段
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let o = 2
    while (o < buf.length) {
      if (buf[o] !== 0xff) { o++; continue }
      const m = buf[o + 1]
      if (m === 0xc0 || m === 0xc2) return { h: buf.readUInt16BE(o + 5), w: buf.readUInt16BE(o + 7) }
      o += 2 + buf.readUInt16BE(o + 2)
    }
  }
  // WEBP (VP8X/VP8/VP8L 简化：VP8X 有 24bit 宽高-1)
  if (buf.length >= 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const fmt = buf.toString('ascii', 12, 16)
    if (fmt === 'VP8X') return { w: (buf.readUIntLE(24, 3) & 0xffffff) + 1, h: (buf.readUIntLE(27, 3) & 0xffffff) + 1 }
  }
  return null
}

/** 读截图目录：按文件名排序，解析竖/横向；非图片忽略；损坏/无法解析按 landscape 兜底。 */
export function readShots(shotsDir: string): Shot[] {
  if (!fs.existsSync(shotsDir)) return []
  return fs.readdirSync(shotsDir).filter((f) => /\.(png|jpe?g|webp)$/i.test(f)).sort().map((f) => {
    const size = imageSize(fs.readFileSync(path.join(shotsDir, f)))
    return { rel: f, orientation: size && size.w < size.h ? 'portrait' : 'landscape' }
  })
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @forgecast/studio test hyperframes`
Expected: PASS

- [ ] **Step 5: demo.html 模板 + buildDemoProps slot 化 + generate demo 分支**

Create `templates/hf/demo.html`：五段（钩子→痛点→截图轮播→报价→CTA），竖图套手机外框（纯 CSS：圆角矩形+边框+刘海），横图居中缩放+同图虚化背景。截图轮播段由 generate 动态注入 `{{shotsHtml}}`（每张一个 clip，data-start 均分演示段总时长），GSAP 交叉淡入。@font-face 打底同 changelog。

`props.ts` 的 `buildDemoProps` 改为返回 `Record<string,string>`（painTitle/painPoints 拼成 HTML 片段或分 slot、priceAnchor/cta/brandName），并由 generate 组装截图段。generate 的 demo 分支：读 `workspace/<slug>/shots/`（`readShots`），无图报错退出（设计文档：shots 无图不出片）；有图则每张按方向生成 clip HTML，均分演示段 1110/图数 帧；配音/字幕同 changelog；`scaffoldHfProject` 时把截图 Buffer 一起写进 assets。

（本步含较多 HTML 视觉编排，按 changelog 同法：真渲 → 抽帧 → 调参。完整 demo.html 在实现时基于 changelog.html 扩展，手机外框 CSS：）

```css
.phone { width: 620px; height: 1340px; margin: 0 auto; border: 14px solid #21262d; border-radius: 64px; overflow: hidden; position: relative; background:#000; }
.phone::before { content:""; position:absolute; top:0; left:50%; transform:translateX(-50%); width:180px; height:36px; background:#21262d; border-radius:0 0 22px 22px; z-index:2; }
.phone img { width:100%; height:100%; object-fit: cover; }
.landscape-bg { position:absolute; inset:0; background-size:cover; filter: blur(40px) brightness(.5); }
.landscape-fg { position:absolute; inset:0; display:flex; align-items:center; }
.landscape-fg img { width:100%; }
```

- [ ] **Step 6: 更新 props/generate 测试 + tsc**

props 测试：`buildDemoProps` 返回 string map。generate 测试：`tpl=demo` 无 shots/ 目录时抛错；有 shots（写两张 pngOf）时 stub 产出 asset。跑 `pnpm --filter @forgecast/studio test`、`npx tsc -p packages/studio/tsconfig.json --noEmit`。

- [ ] **Step 7: 真渲验证 + 提交**

造 2-3 张竖图放 `workspace/<slug>/shots/`，`--tpl=demo` 真渲，抽帧看手机外框与截图轮播。

```bash
git add templates/hf/demo.html packages/studio
git commit -m "feat(studio): demo 模板迁移 HyperFrames（产品截图轮播/手机外框）"
```

---

### Task 7: story 模板迁移

**Files:**
- Create: `templates/hf/story.html`
- Modify: `packages/studio/src/props.ts`（`buildStoryProps` 产 slot；气泡 HTML 片段）
- Modify: `packages/studio/src/generate.ts`（story 分支走 HyperFrames）
- Test: `packages/studio/test/props.test.ts`、`packages/studio/test/generate.test.ts`

**Interfaces:**
- Consumes: Task 4/5 基建
- Produces: story 分支走 HyperFrames；`buildStoryProps` 返回 `{ bubblesHtml, sellingPoint, cta, brandName }`（string map）。

- [ ] **Step 1: 写失败测试**

`props.test.ts` 加：`buildStoryProps` 返回含 `bubblesHtml`（含气泡对话 HTML）、`sellingPoint`、`cta`、`brandName` 且均为 string。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @forgecast/studio test props` → FAIL

- [ ] **Step 3: 实现**

`buildStoryProps` 改返回 string map：把三条气泡拼成 HTML（who=them/me 左右对齐、转义文本），其余同现值。Create `templates/hf/story.html`（气泡聊天场景→卖点→CTA，@font-face 打底，`{{bubblesHtml}}` 由 generate 直接替换——气泡文本在 buildStoryProps 内已 escapeHtml）。generate 的 story 分支同 changelog 结构（配音+字幕+scaffold+render）。

- [ ] **Step 4: 测试 + 真渲 + 提交**

Run: `pnpm --filter @forgecast/studio test`、tsc。真渲 `--tpl=story` 抽帧。

```bash
git add templates/hf/story.html packages/studio
git commit -m "feat(studio): story 模板迁移 HyperFrames"
```

---

### Task 8: flash 模板迁移 + 收口 generate

**Files:**
- Create: `templates/hf/flash.html`
- Modify: `packages/studio/src/props.ts`（`buildFlashProps` 保留，加 string-map 适配或直接返回 string map）
- Modify: `packages/studio/src/generate.ts`（flash 分支走 HyperFrames；删除所有 Remotion 调用，统一为一条 HyperFrames 路径）
- Test: `packages/studio/test/generate.test.ts`

**Interfaces:**
- Consumes: Task 4/5 基建
- Produces: 四套模板全走 HyperFrames；`generateVideo` 内不再有 Remotion 分支。

- [ ] **Step 1: 收口重构 generate.ts**

把四个 tpl 分支统一成一条路径：`const slots = builders[tpl](doc, brandName)` → 组装 audio/caption/截图段 → `fillTemplate(readTemplate(tpl), slots)` → scaffold → render → 落库。四个 builder 各产 string map 与各自模板对应。flash 无音轨（可选：flash 也加配音，与设计一致——本任务给 flash 也接配音+字幕，统一体验）。

- [ ] **Step 2: 写失败测试**

`generate.test.ts` 参数化四个 tpl（flash/story/demo/changelog）在 stub 下都产出 asset 行 + hf/index.html 含 `data-composition-id`。

- [ ] **Step 3: 跑测试确认失败 → 实现 → 通过**

Run: `pnpm --filter @forgecast/studio test generate`

- [ ] **Step 4: 真渲验证 + 提交**

四套模板各真渲一条，抽帧。

```bash
git add templates/hf/flash.html packages/studio
git commit -m "feat(studio): flash 模板迁移 + generateVideo 统一 HyperFrames 路径"
```

---

## 阶段三：删 Remotion + Docker + 文档

### Task 9: 删除 Remotion

**Files:**
- Delete: `packages/studio/src/remotion/`（整目录）、`packages/studio/src/render.ts`
- Modify: `packages/studio/package.json`（删 `@remotion/*`、`react`、`react-dom` 及对应 `@types/*`）
- Modify: `packages/studio/src/index.ts`、`packages/studio/src/generate.ts`（去 render.ts import）
- Test: 全量

**Interfaces:**
- Consumes: Task 8（四模板已不依赖 Remotion）
- Produces: studio 包无 Remotion 依赖。

- [ ] **Step 1: 删文件**

```bash
git rm -r packages/studio/src/remotion packages/studio/src/render.ts
```

- [ ] **Step 2: 清依赖**

`packages/studio/package.json` 删 `@remotion/bundler`、`@remotion/renderer`、`remotion`、`react`、`react-dom`、`@types/react`、`@types/react-dom`。

- [ ] **Step 3: 清 import**

删 `generate.ts` 顶部 `import { renderVideo } from './render'` 与 `ENTRY` 常量（若残留）；`index.ts` 去掉对 render 的再导出（若有）。

- [ ] **Step 4: 重装 + 全量测试 + tsc**

Run: `pnpm install`、`pnpm -r test`、`npx tsc -p packages/studio/tsconfig.json --noEmit`
Expected: 全绿、无对已删模块的引用

- [ ] **Step 5: 提交**

```bash
git add -A
git commit -m "refactor(studio): 删除 Remotion（引擎已全面替换为 HyperFrames）"
```

---

### Task 10: Docker renderer 镜像

**Files:**
- Modify: `Dockerfile.renderer`
- Create: `docs/hyperframes-deploy.md`（Kokoro/espeak/字体的部署踩坑）
- Modify: `docker-compose.yml`（renderer 服务环境变量）

**Interfaces:**
- Consumes: 全部前序
- Produces: 可真构建的 renderer 镜像（Node22 + Bun + hyperframes + ffmpeg + Python/kokoro + espeak + Noto CJK）。

- [ ] **Step 1: 写 Dockerfile.renderer**

替换 `Dockerfile.renderer` 为（`node:22-bookworm` + Bun + hyperframes + ffmpeg + Kokoro/espeak + Noto CJK）：

```dockerfile
FROM node:22-bookworm-slim
WORKDIR /app
# ffmpeg + 中文字体 + Chromium 运行依赖 + espeak-ng(Kokoro 中文音素) + python venv
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg fonts-noto-cjk fonts-noto-color-emoji espeak-ng \
    python3 python3-venv python3-pip curl unzip \
    libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 \
    libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2 \
    && rm -rf /var/lib/apt/lists/*
# Bun（HyperFrames 工具链）
RUN curl -fsSL https://bun.sh/install | bash && ln -s /root/.bun/bin/bun /usr/local/bin/bun
# Kokoro TTS venv
RUN python3 -m venv /opt/kokoro && /opt/kokoro/bin/pip install --no-cache-dir kokoro-onnx soundfile "misaki[zh]"
ENV HYPERFRAMES_PYTHON=/opt/kokoro/bin/python \
    ESPEAK_DATA_PATH=/usr/lib/x86_64-linux-gnu/espeak-ng-data \
    ESPEAKNG_DATA_PATH=/usr/lib/x86_64-linux-gnu/espeak-ng-data \
    PHONEMIZER_ESPEAK_PATH=/usr/bin/espeak-ng \
    FORGECAST_TTS_MODE=kokoro FORGECAST_VIDEO_MODE=render
RUN corepack enable
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages ./packages
COPY apps ./apps
COPY templates ./templates
COPY cli.ts tsconfig.base.json ./
RUN pnpm install --frozen-lockfile
# 预拉 chrome-headless-shell（HyperFrames 渲染用）
RUN npx --yes hyperframes browser ensure || true
CMD ["sleep", "infinity"]
```

注：`espeak-ng-data` 路径随 apt 包架构而定（arm64 为 `/usr/lib/aarch64-linux-gnu/espeak-ng-data`）——构建后 `find / -name phontab` 确认，必要时改 ENV。字体 `templates/hf/fonts/NotoSansSC.otf` 随 COPY templates 进镜像；系统 fonts-noto-cjk 作双保险。用国内 apt/pip/npm 源加速（见 [[cn-server-docker-build-mirrors]] memory）。

- [ ] **Step 2: 真构建**

Run: `DOCKER_BUILDKIT=0 docker compose build renderer`
Expected: 构建成功（首次慢，注意 espeak 数据路径与 chrome 拉取）

- [ ] **Step 3: 容器内真渲一条**

进容器跑一条 `--tpl=changelog --FORGECAST_TTS_MODE=kokoro`，确认 MP4 有声、中文非豆腐块。

- [ ] **Step 4: 写部署文档**

`docs/hyperframes-deploy.md` 记：Node22、Kokoro venv 与 espeak-ng 数据路径三个环境变量、字体放置、`DOCKER_BUILDKIT=0`、国内源。

- [ ] **Step 5: 提交**

```bash
git add Dockerfile.renderer docker-compose.yml docs/hyperframes-deploy.md
git commit -m "feat(deploy): HyperFrames renderer 镜像（Kokoro+espeak+Noto CJK），真构建验证"
```

---

### Task 11: README 与文档收尾

**Files:**
- Modify: `README.md`
- Modify: `docs/m5-videocut.md`（若提及 Remotion 需更新）

**Interfaces:**
- Consumes: 全部
- Produces: 文档与现状一致。

- [ ] **Step 1: 更新 README**

视频章节：Remotion → HyperFrames；`FORGECAST_TTS_MODE` 三档（kokoro/live/stub）；`FORGECAST_VIDEO_MODE`（render/stub）；四套模板（flash/story/demo/changelog）；Node 22+ 与 Kokoro 依赖指向 `docs/hyperframes-deploy.md`。

- [ ] **Step 2: 全量测试 + 提交**

Run: `pnpm -r test`

```bash
git add README.md docs
git commit -m "docs: README/文档更新为 HyperFrames 视频流水线"
```

---

## 完成标准

- `pnpm -r test` 全绿；`npx tsc -p packages/studio/tsconfig.json --noEmit` 无错。
- 四套模板（flash/story/demo/changelog）各真渲一条：1080×1920、中文非豆腐块、Kokoro 中文配音有声、字幕正常。
- demo 模板：无 shots/ 报错退出；有截图时手机外框/横图回落正常。
- `packages/studio` 无任何 `@remotion/*`/react 依赖与 remotion/ 目录。
- `DOCKER_BUILDKIT=0 docker compose build renderer` 成功，容器内真渲通。
- README 与 `docs/hyperframes-deploy.md` 与现状一致。

## 已知非纯代码成本（贯穿）

- Task 5/8 真渲、Task 10 Docker 真构建须人工在 Node22+ 环境验证（subagent 无法纯代码完成）。
- Kokoro 首装 espeak-ng 数据路径 yak-shaving（会话试跑已趟通，写进部署文档）。
- 每套模板真渲后需看真片回调运镜幅度/停留时长。
