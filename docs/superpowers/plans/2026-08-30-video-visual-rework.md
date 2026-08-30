# 做内容视觉重做 + 页内预览 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 清掉三个已被 `hyperframes check` 确认的合成缺陷，加上基础运动层消灭静止帧，重做 insight 构图，并在「做内容」页内做出秒级预览。

**Architecture:** 改动集中在 `packages/studio/src/hyperframes.ts`（合成层）与 `apps/web`（预览 UI）；服务端只补一张 MIME 表。渲染管线、TTS/ASR、BGM/卡点、数据模型一律不动。

**Tech Stack:** TypeScript · HyperFrames 0.7.68（HTML + 暂停的 GSAP 主时间线，逐帧 seek 渲染）· React 18 · vitest（`packages/studio`）

**Spec:** `docs/superpowers/specs/2026-08-30-video-visual-rework-design.md`

## Global Constraints

- **只能动 transform / opacity 等 HyperFrames 白名单属性**；动效必须挂在暂停主时间线 `tl` 上（`tl.to` / `tl.set` / `tl.from`），**禁止 CSS `@keyframes`**（逐帧 seek 下不随帧走），**禁止裸 `gsap.to`**（不受 tl 控制，加载即跑完，渲不出来）。
- **禁止 `repeat: -1`**（HyperFrames 硬规则），循环一律用有限次数。
- **禁止逐帧改 `textContent`**（seek 渲染下不生效，项目已知限制）；显隐一律走 opacity 或 `.clip` 的 `data-start`/`data-duration`。
- **禁止 `Math.random()` / render-time 时钟**——本次正是要修它。新代码一律用种子化 PRNG。
- **同一 `data-track-index` 上的 clip 不得时间重叠**（官方硬规则，本次正是要修它）。
- `apps/web` **不引入单测框架**（`"test": "echo 'web: 人工验收，无单测'"` 是既定约定），前端靠 `npx tsc --noEmit` + 浏览器人工验收。
- **测试须用 Node ≥22**：本机 nvm 默认 v20，`better-sqlite3` ABI 不匹配会假红。跑测试前先
  `export NVM_DIR="$HOME/.nvm" && source "$NVM_DIR/nvm.sh" && nvm use 22.23.2`，用 `npx pnpm ...`。
- **不得用 `pkill` / `killall` 等广谱杀进程命令**——用户的 dev server 跑在 5173(web)/4321(api)，曾被误杀过整套栈。要关自己起的服务只能按 PID。
- 验收用的 `hyperframes` 命令一律 pin 版本：`npx --yes hyperframes@0.7.68 <sub>`。

---

### Task 1: 相机层可行性验证（spike，先于一切实现）

**这是本计划唯一未验证的技术假设。** 若不成立，Task 7 整体换设计（退回「不做全局相机，只给 clip 内元素加微动」），后续任务不受影响。**失败不是阻塞，是走备选分支。**

**Files:**
- 临时实验文件（不进 git）：`/private/tmp/.../cam-spike/`（把 `workspace/ant-design-pro/hf` 整份复制过去改，**不要直接改 workspace 原件**）

**Interfaces:**
- Consumes: 无
- Produces: 一个结论（成立 / 不成立）+ 若成立则给出可复用的 CSS 与 GSAP 写法，Task 7 直接照抄

- [ ] **Step 1: 复制一份实验工程**

```bash
R=/Users/lizhishaoniange/Documents/开源变现内容工厂
mkdir -p /tmp/cam-spike && cp -RL "$R/workspace/ant-design-pro/hf/." /tmp/cam-spike/
```

`-L` 让软链的 fonts 目录被复制成真文件（实验工程要自包含）。

- [ ] **Step 2: 手工加相机层**

编辑 `/tmp/cam-spike/index.html`：

1. CSS 里加（放在 `<style>` 内任意位置）：

```css
      #cam { position: absolute; inset: 0; transform-origin: 50% 50%; }
```

2. 把 `#root` 的**所有子元素**用 `<div id="cam">…</div>` 包起来（`#root` 自身的属性不动）。

3. 在 `<script>` 里、`tl` 已定义之后、`window.__timelines` 赋值之前，加一条全程相机曲线。
   **末键刻意落在片长之外**（`D * 1.15`），避免曲线在片尾收住导致最后 1 秒静止：

```js
        var D = parseFloat(document.getElementById('root').getAttribute('data-duration')) || 60;
        tl.fromTo('#cam', { scale: 1, x: 0, y: 0 }, { scale: 1.06, x: -14, y: -8, duration: D * 1.15, ease: 'sine.inOut' }, 0);
```

- [ ] **Step 3: 跑官方检查**

```bash
cd /tmp/cam-spike && export NVM_DIR="$HOME/.nvm" && source "$NVM_DIR/nvm.sh" && nvm use 22.23.2
npx --yes hyperframes@0.7.68 check 2>&1 | tail -30
```

预期：**不出现新的 lint 条目**（原有的 `non_deterministic_code` / `overlapping_clips_same_track` / `studio_missing_editable_id` 仍在，那是别的任务修；关键是不能新增关于 transform/层级/clip 的错误）。

- [ ] **Step 4: 抽帧验证 clip 显隐没被破坏、且画面真的在动**

```bash
cd /tmp/cam-spike && npx --yes hyperframes@0.7.68 snapshot --at 14 --at 20 --at 30
```

逐张打开 `snapshots/*.png` 人眼核对两件事：
1. **卡片仍然出现**（相机层没有让 `.clip` 显隐失效）——14s/30s 应能看到卡片，与改造前一致；
2. **14s 与 30s 的画面不再逐像素相同**（背景/卡片位置有可见位移或缩放差异）。

- [ ] **Step 5: 记录结论**

把结论写进 Task 1 的报告：成立则附上第 2 步验证过的确切 CSS 与 GSAP 代码（Task 7 照抄）；
不成立则写清失败现象（哪条 lint / 哪个 clip 不显示 / 画面为何仍静止），Task 7 走备选分支。

- [ ] **Step 6: 清理**

```bash
rm -rf /tmp/cam-spike
```

本任务**不产生 git commit**（纯验证）。

---

### Task 2: 解码特效去随机化

**Files:**
- Modify: `packages/studio/src/hyperframes.ts`（`DECODE_RUNTIME`，约 213-237 行）
- Test: `packages/studio/test/hyperframes.test.ts`

**Interfaces:**
- Consumes: 无
- Produces: `DECODE_RUNTIME` 内不再出现 `Math.random`；导出一个可单测的 `mulberry32` 种子函数供测试断言（见下）

- [ ] **Step 1: 写失败测试**

在 `packages/studio/test/hyperframes.test.ts` 追加：

```ts
describe('DECODE_RUNTIME 确定性', () => {
  it('运行时脚本里不含 Math.random（HyperFrames 硬规则：渲染各帧须一致）', () => {
    expect(DECODE_RUNTIME).not.toContain('Math.random')
  })

  it('内联的 mulberry32 同种子产出同序列、不同种子产出不同序列', () => {
    // 把注入进合成产物的那份 mulberry32 原样抠出来跑，确保实现本身正确
    const src = DECODE_RUNTIME.match(/function mulberry32[\s\S]*?\n\s*\}/)
    expect(src, '未能从 DECODE_RUNTIME 中提取 mulberry32').toBeTruthy()
    const mulberry32 = new Function(`${src![0]}; return mulberry32`)() as (seed: number) => () => number

    /** 用给定种子取前 5 个数 */
    const take5 = (seed: number) => { const r = mulberry32(seed); return [r(), r(), r(), r(), r()] }

    expect(take5(42)).toEqual(take5(42))        // 同种子可复现
    expect(take5(42)).not.toEqual(take5(43))    // 不同种子有差异
    expect(take5(42).every((x) => x >= 0 && x < 1)).toBe(true)
  })
})
```

确保测试文件顶部 import 了 `DECODE_RUNTIME`（若未 import 则补进现有 import 语句）。

- [ ] **Step 2: 跑测试确认失败**

```bash
export NVM_DIR="$HOME/.nvm" && source "$NVM_DIR/nvm.sh" && nvm use 22.23.2
npx pnpm --filter @forgecast/studio test 2>&1 | tail -20
```

预期：第一条因 `DECODE_RUNTIME` 仍含 `Math.random` 而失败。

- [ ] **Step 3: 实现**

把 `DECODE_RUNTIME` 开头的 `rc()` 改成种子化。**种子必须只依赖元素序号与字符位置**（不依赖时间/随机），保证同一份 HTML 每次渲染结果一致：

```js
export const DECODE_RUNTIME = `(function () {
        var POOL = '日月火水木金土山川云电系统数据端口零一二三ABCDEF0123456789#@%&*<>/|=+アイウエオカキクケコサシスセソ';
        function mulberry32(a) {
          return function () {
            a |= 0; a = a + 0x6D2B79F5 | 0;
            var t = Math.imul(a ^ a >>> 15, 1 | a);
            t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
            return ((t ^ t >>> 14) >>> 0) / 4294967296;
          };
        }
        var K = 5, gstep = 0.045;
        document.querySelectorAll('.tw').forEach(function (el, ei) {
          var clip = el.closest('.clip') || el;
          var start = parseFloat(clip.getAttribute('data-start') || '0');
          var chars = Array.from(el.textContent);
          el.textContent = '';
          var step = Math.min(0.055, 1.1 / Math.max(1, chars.length));
          chars.forEach(function (ch, i) {
            var t0 = start + i * step;
            var rnd = mulberry32((ei + 1) * 73856093 ^ (i + 1) * 19349663);
            var c = document.createElement('span'); c.className = 'twc';
            if (ch === ' ') { c.innerHTML = '&nbsp;'; el.appendChild(c); tl.set(c, { opacity: 0 }, 0); tl.set(c, { opacity: 1 }, t0); return; }
            var fin = document.createElement('span'); fin.className = 'fin'; fin.textContent = ch; c.appendChild(fin);
            var ghosts = [];
            for (var j = 0; j < K; j++) { var g = document.createElement('span'); g.className = 'gh'; g.textContent = POOL[(rnd() * POOL.length) | 0]; c.appendChild(g); ghosts.push(g); }
            el.appendChild(c);
            tl.set(c, { opacity: 0 }, 0); tl.set(c, { opacity: 1 }, t0);
            tl.set(fin, { opacity: 0 }, 0);
            ghosts.forEach(function (g, j) { tl.set(g, { opacity: 0 }, 0); tl.set(g, { opacity: 1 }, t0 + j * gstep); tl.set(g, { opacity: 0 }, t0 + (j + 1) * gstep); });
            tl.set(fin, { opacity: 1 }, t0 + K * gstep);
          });
        });
      })();`
```

注意 `forEach(function (el, ei)`（新增 `ei` 形参）与 `rc()` 的删除。

- [ ] **Step 4: 跑测试确认通过**

```bash
npx pnpm --filter @forgecast/studio test 2>&1 | tail -20
```

预期：全绿，含 2 条新用例；原有 190 条不受影响。

- [ ] **Step 5: 提交**

```bash
git add packages/studio/src/hyperframes.ts packages/studio/test/hyperframes.test.ts
git commit -m "fix(studio): 解码特效改用种子化 PRNG，消除 Math.random 非确定性"
```

---

### Task 3: 消除 insight 同轨 clip 重叠

**Files:**
- Modify: `packages/studio/src/hyperframes.ts`（`buildInsightSections`，约 631-680 行）
- Test: `packages/studio/test/hyperframes.test.ts`

**Interfaces:**
- Consumes: 无
- Produces: `buildInsightSections` 产出的卡片 clip **同组内每张卡占用不同 `data-track-index`**，返回值结构（`{ html, accents }`）不变

**背景（实测数据，供理解）**：现状三张卡全在 `data-track-index="2"`：
`insCard0_0` [10.22, 35.54]、`insCard1_0` [35.54, 58.0]、`insCard1_1` [41.9, 58.0]。
后两张在 track 2 上时间重叠——正是 lint 报的那条。卡片「累加显示」是模板的设计语义
（每组最多 3 张逐张累加），**不能靠截短时长来消除重叠**，正确解法是同组内每张卡各占一条轨道。

- [ ] **Step 1: 写失败测试**

```ts
describe('buildInsightSections 轨道分配', () => {
  const cues = [
    { start: 10, end: 14, text: '工期要 2-4周，一单多烧人力' },
    { start: 20, end: 24, text: '返工率高达 30%' },
    { start: 26, end: 30, text: '每单多花 3 个工作日' },
  ]
  it('同组内多张卡片不共用 track，避免 overlapping_clips_same_track', () => {
    const { html } = buildInsightSections({
      cues, durationSec: 60, painTitle: '标题', cta: '行动', brandName: '品牌',
    })
    // 收集所有卡片 clip 的 [track, start, end]
    const clips = [...html.matchAll(/id="insCard\d+_\d+"[^>]*data-start="([\d.]+)" data-duration="([\d.]+)" data-track-index="(\d+)"/g)]
      .map((m) => ({ start: +m[1], end: +m[1] + +m[2], track: +m[3] }))
    expect(clips.length).toBeGreaterThanOrEqual(2)
    for (const a of clips) {
      for (const b of clips) {
        if (a === b) continue
        if (a.track !== b.track) continue
        // 同轨则必须不重叠
        expect(a.end <= b.start || b.end <= a.start).toBe(true)
      }
    }
  })
  it('卡片轨道不与开场/结尾（track 1）和音轨（track 0）冲突', () => {
    const { html } = buildInsightSections({
      cues, durationSec: 60, painTitle: '标题', cta: '行动', brandName: '品牌',
    })
    const tracks = [...html.matchAll(/id="insCard\d+_\d+"[^>]*data-track-index="(\d+)"/g)].map((m) => +m[1])
    expect(tracks.every((t) => t >= 2)).toBe(true)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
npx pnpm --filter @forgecast/studio test 2>&1 | tail -20
```

预期：第一条失败（同组 3 张卡都在 track 2 且时间重叠）。

- [ ] **Step 3: 实现**

在 `buildInsightSections` 的 `group.forEach` 里，把写死的轨道 `2` 改成按组内序号偏移。
同时删掉未使用的 `sceneStart` 变量（当前是死代码）：

```ts
  groups.forEach((group, gi) => {
    const sceneEnd = Math.min(outroStart, groups[gi + 1]?.[0]?.start ?? outroStart)
    group.forEach((card, idx) => {
      const id = `insCard${gi}_${idx}`
      const color = INSIGHT_PALETTE[idx % INSIGHT_PALETTE.length]
      const inner = `<div class="card" style="--card-color:${color};top:${260 + idx * 220}px">`
        + `<div class="stat">${escapeHtml(card.stat)}</div><div class="label">${escapeHtml(card.label)}</div></div>`
      // 同组卡片是「累加共存」语义，必须各占一条轨道——同轨重叠会被 HyperFrames 判为渲染冲突。
      // 组内最多 3 张（见上方分组逻辑），故占用 track 2/3/4，不与音轨(0)和开场结尾(1)冲突。
      cardClips.push(clip(card.start, Math.max(0.5, sceneEnd - card.start), 2 + idx, inner, id))
      accentLines.push(`tl.from("#${id}", { opacity: 0, y: 24, duration: .45 }, ${card.start});`)
    })
  })
```

- [ ] **Step 4: 跑测试确认通过**

```bash
npx pnpm --filter @forgecast/studio test 2>&1 | tail -20
```

- [ ] **Step 5: 提交**

```bash
git add packages/studio/src/hyperframes.ts packages/studio/test/hyperframes.test.ts
git commit -m "fix(studio): insight 同组卡片各占一条轨道，消除同轨 clip 重叠"
```

---

### Task 4: 给时间轴元素补稳定 id

**Files:**
- Modify: `packages/studio/src/hyperframes.ts`（各 `build*Sections`：`buildInsightSections` 的开场/结尾 clip、`buildFlashSections`、`buildStorySections`、`buildDemoSections`、`buildChangelogSections`）
- Test: `packages/studio/test/hyperframes.test.ts`

**Interfaces:**
- Consumes: 无
- Produces: 所有 `build*Sections` 产出的顶层 clip 都带 `id`，命名规则 `<模板>-<角色>-<序号>`（全小写连字符），例如 `insight-intro`、`insight-outro`、`flash-hook`、`story-bubble-3`

**背景**：`hyperframes check` 报 `studio_missing_editable_id`：无 id 的元素「Studio 无法用稳定的编辑目标」。
实测缺 id 的是 `data-start="0"` 与 `data-start="58"` 两个 clip——即 insight 的开场与结尾（卡片本身已有 id）。
其余模板同样需要检查。**id 必须稳定**：禁止随机数/时间戳，否则每次生成都变，编辑器无法回指。

- [ ] **Step 1: 写失败测试**

```ts
describe('时间轴元素稳定 id', () => {
  const cues = [{ start: 5, end: 9, text: '返工率 30%' }]
  it('insight 的开场与结尾 clip 都带 id', () => {
    const { html } = buildInsightSections({
      cues, durationSec: 30, painTitle: '标题', cta: '行动', brandName: '品牌',
    })
    const topClips = [...html.matchAll(/<div class="clip"([^>]*)>/g)].map((m) => m[1])
    expect(topClips.length).toBeGreaterThan(0)
    for (const attrs of topClips) expect(attrs).toMatch(/\sid="[a-z0-9-]+"/)
  })
  it('id 稳定：同样输入两次生成得到完全相同的 id 集合', () => {
    const mk = () => buildInsightSections({
      cues, durationSec: 30, painTitle: '标题', cta: '行动', brandName: '品牌',
    }).html
    const ids = (h: string) => [...h.matchAll(/id="([^"]+)"/g)].map((m) => m[1])
    expect(ids(mk())).toEqual(ids(mk()))
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
npx pnpm --filter @forgecast/studio test 2>&1 | tail -20
```

预期：第一条失败（开场/结尾 clip 无 id）。

- [ ] **Step 3: 实现**

`buildInsightSections` 的 `html` 组装处，给开场与结尾传 id（`clip` 函数第 5 参已支持 `id`）：

```ts
  const html = [
    clip(0, introEnd, 1, `<div class="fill pad center"><div class="painT tw">${escapeHtml(painTitle)}</div></div>`, 'insight-intro'),
    cardClips.join('\n'),
    clip(outroStart, Math.max(0.5, durationSec - outroStart), 1, `<div class="fill pad center"><div class="cta tw">${escapeHtml(cta)}</div><div class="brand">@${escapeHtml(brandName)}</div></div>`, 'insight-outro'),
  ].join('\n')
```

然后**逐个检查其余四个 `build*Sections`**（`buildFlashSections` / `buildStorySections` / `buildDemoSections` / `buildChangelogSections`），凡是产出的顶层 clip 缺 `id` 的都补上，命名沿用 `<模板>-<角色>[-<序号>]` 规则（如 `flash-hook`、`flash-mid-0`、`flash-cta`、`changelog-title`、`story-bubble-0`）。
序号一律用**元素在该模板内的稳定序号**（数组下标），不得引入随机或时间来源。

- [ ] **Step 4: 跑测试确认通过 + 顺带确认没破坏既有断言**

```bash
npx pnpm --filter @forgecast/studio test 2>&1 | tail -20
```

若既有用例断言了具体 HTML 片段而因新增 `id` 失败，属预期，按新输出更新断言（**只更新受 id 影响的部分**，不得放宽无关断言）。

- [ ] **Step 5: 提交**

```bash
git add packages/studio/src/hyperframes.ts packages/studio/test/hyperframes.test.ts
git commit -m "feat(studio): 给时间轴 clip 生成稳定可读 id，供 Studio/编辑器定位元素"
```

---

### Task 5: `/files/*` 补 MIME，让合成产物能被浏览器正确加载

**Files:**
- Modify: `packages/server/src/app.ts`（`MIME` 表与 `/files/*` 路由，约 428-443 行）
- Test: `packages/server/test/`（新建或并入现有静态文件测试）

**Interfaces:**
- Consumes: 无
- Produces: `GET /files/<slug>/hf/index.html` 返回 `text/html; charset=utf-8`；`.js`/`.otf`/`.wav`/`.json`/`.css` 各返回正确 content-type。路由路径与鉴权行为不变。

**背景（实测）**：现有 `/files/*` 路由**已经能取到**合成产物的全部文件，包括透过 `assets/fonts` 那条指向
`templates/hf/fonts` 的软链（`path.resolve` 不解析软链故通过前缀校验，`readFileSync` 跟随软链读到真文件；
实测 index.html / gsap.min.js / 8.3MB 的 OTF / narration.wav 全部 HTTP 200）。
**唯一缺口是 content-type 全为 `application/octet-stream`**，iframe 不会把它当 HTML 渲染、`<script>` 不会执行、字体不会生效。

**安全说明（须写进代码注释）**：给 `/files/*` 加 `text/html` 意味着该路由能以同源身份返回 HTML。
本项目服务绑 127.0.0.1、单人本机使用、该目录内容全部由本工具自己生成（文案经 `escapeHtml`），
风险可接受；但**不要**把这条路由暴露到 loopback 之外。

- [ ] **Step 1: 写失败测试**

在 `packages/server/test/` 下新建 `files-mime.test.ts`（若已有静态文件测试则并入）：

该目录**没有共享 helper**，每个测试文件自己在 `beforeEach` 里建 ctx 与 app（已核对 `bgm.test.ts` 等）。
照此写：

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
beforeEach(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-files-'))
  const config = loadConfig(root, {})
  ctx = { db: openDb(config.paths.db), config, llm: createLlmClient(config.llm) }
  app = createApp(ctx, createTaskQueue())
})

describe('GET /files/* 的 content-type', () => {
  it('html/js/otf/wav 各返回正确 MIME，而非 octet-stream', async () => {
    const dir = path.join(ctx.config.paths.workspace, 'p1', 'hf')
    fs.mkdirSync(path.join(dir, 'assets', 'fonts'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><html></html>')
    fs.writeFileSync(path.join(dir, 'gsap.min.js'), '/*js*/')
    fs.writeFileSync(path.join(dir, 'assets', 'fonts', 'F.otf'), Buffer.from([0, 1]))
    fs.writeFileSync(path.join(dir, 'assets', 'n.wav'), Buffer.from([0, 1]))

    const ct = async (p: string) => (await app.request(`/files/${p}`)).headers.get('content-type')
    expect(await ct('p1/hf/index.html')).toMatch(/^text\/html/)
    expect(await ct('p1/hf/gsap.min.js')).toMatch(/javascript/)
    expect(await ct('p1/hf/assets/fonts/F.otf')).toMatch(/font/)
    expect(await ct('p1/hf/assets/n.wav')).toMatch(/audio/)
  })

  it('路径穿越仍被拒（回归：不得因加 MIME 放宽边界校验）', async () => {
    const res = await app.request('/files/../package.json')
    expect(res.status).toBe(404)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
npx pnpm --filter @forgecast/server test 2>&1 | tail -20
```

预期：MIME 断言失败（当前全是 `application/octet-stream`）。

- [ ] **Step 3: 实现**

扩充 `packages/server/src/app.ts:429` 的 `MIME` 表（**只加条目，不动路由逻辑与边界校验**）：

```ts
  // —— workspace 静态文件（封面/视频预览 + hf 合成产物页内预览）——
  // 注：合成产物 hf/ 需要以 text/html 提供才能在 iframe 里渲染。本服务绑 127.0.0.1、
  // 单人本机使用、该目录内容全部由本工具自己生成（文案经 escapeHtml），风险可接受；
  // 切勿把本路由暴露到 loopback 之外。
  const MIME: Record<string, string> = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
    '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.m4v': 'video/mp4', '.md': 'text/markdown; charset=utf-8',
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
    '.otf': 'font/otf', '.ttf': 'font/ttf', '.woff2': 'font/woff2',
    '.wav': 'audio/wav', '.mp3': 'audio/mpeg',
  }
```

- [ ] **Step 4: 跑测试确认通过**

```bash
npx pnpm --filter @forgecast/server test 2>&1 | tail -20
```

- [ ] **Step 5: 提交**

```bash
git add packages/server/src/app.ts packages/server/test/files-mime.test.ts
git commit -m "feat(server): /files 补全 MIME，使 hf 合成产物可在浏览器内预览"
```

---

### Task 6: 「做内容」页加预览 tab

**Files:**
- Create: `apps/web/src/pages/workshop/PreviewTab.tsx`
- Modify: `apps/web/src/pages/WorkshopPage.tsx`（TABS 数组 + 渲染分支）

**Interfaces:**
- Consumes: Task 5 的 `/files/<slug>/hf/index.html`（`text/html`）
- Produces: 无

**关键实现事实（已实测，照此实现即可，不要另找方案）**：
- 合成产物在 `window.__timelines[<composition-id>]` 上暴露一条**暂停的 GSAP timeline**，
  自带 `play()` / `pause()` / `seek(t)` / `time()` / `duration()`。
- iframe 与父页面**同源**（都经 4321 / vite 代理），父页面可直接访问 `iframe.contentWindow`。
- **不使用官方 `<hyperframes-player>`**——它会从 `cdn.jsdelivr.net` 拉运行时，与本项目「数据不出 localhost」冲突。

- [ ] **Step 1: 新建 PreviewTab**

创建 `apps/web/src/pages/workshop/PreviewTab.tsx`：

```tsx
import { useEffect, useRef, useState } from 'react'

/** 合成产物页内预览：iframe 加载 hf/index.html，父页面直接驱动其 window.__timelines 上的 GSAP 时间线。
 *  只读预览（播放/暂停/拖动），不做编辑。 */
export default function PreviewTab({ slug }: { slug: string }) {
  const frameRef = useRef<HTMLIFrameElement>(null)
  const [dur, setDur] = useState(0)
  const [t, setT] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [err, setErr] = useState('')
  const rafRef = useRef<number | null>(null)

  /** 取 iframe 内那条暂停的 GSAP 主时间线；拿不到返回 null（合成产物还没生成/结构不符） */
  function timeline(): any | null {
    try {
      const w = frameRef.current?.contentWindow as any
      const tls = w?.__timelines
      if (!tls) return null
      const first = Object.values(tls)[0] as any
      return first && typeof first.seek === 'function' ? first : null
    } catch { return null }
  }

  function onLoad() {
    const tl = timeline()
    if (!tl) { setErr('没读到合成时间线——该项目可能还没生成过视频'); return }
    setErr(''); tl.pause(); setDur(tl.duration()); setT(0); tl.seek(0)
  }

  // 播放：用 rAF 推进 seek，不依赖任何第三方播放器
  useEffect(() => {
    if (!playing) return
    let last = performance.now()
    const step = (now: number) => {
      const tl = timeline()
      if (!tl) { setPlaying(false); return }
      const next = tl.time() + (now - last) / 1000
      last = now
      if (next >= tl.duration()) { tl.seek(tl.duration()); setT(tl.duration()); setPlaying(false); return }
      tl.seek(next); setT(next)
      rafRef.current = requestAnimationFrame(step)
    }
    rafRef.current = requestAnimationFrame(step)
    return () => { if (rafRef.current != null) cancelAnimationFrame(rafRef.current) }
  }, [playing])

  const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`

  return (
    <div className="space-y-3">
      <div className="card p-3">
        <div className="mb-2 text-xs text-faint">
          预览的是该项目**最近一次生成**的合成产物（每个项目一份、每次生成覆盖），不是选中的某条历史视频。
        </div>
        <iframe
          ref={frameRef} onLoad={onLoad} title="composition preview"
          src={`/files/${slug}/hf/index.html`}
          className="aspect-video w-full rounded border border-hairline bg-black"
        />
        {err && <div className="mt-2 text-sm text-danger">{err}</div>}
        <div className="mt-3 flex items-center gap-3">
          <button className="btn px-3 py-1 text-sm" disabled={!dur}
            onClick={() => { const tl = timeline(); if (tl) { setPlaying((p) => !p) } }}>
            {playing ? '暂停' : '播放'}
          </button>
          <input type="range" min={0} max={dur || 0} step={0.05} value={t} disabled={!dur}
            className="flex-1"
            onChange={(e) => { const v = Number(e.target.value); const tl = timeline(); if (tl) { tl.seek(v); setT(v) } }} />
          <span className="font-mono text-xs text-sub">{fmt(t)} / {fmt(dur)}</span>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: 接进 WorkshopPage**

在 `apps/web/src/pages/WorkshopPage.tsx`：

1. import：`import PreviewTab from './workshop/PreviewTab'`
2. `TABS` 数组末尾追加一项：`{ key: 'preview', label: '预览' }`
3. 渲染分支追加（放在其它 tab 分支旁）：

```tsx
      {tab === 'preview' && selected && <PreviewTab key={selected} slug={selected} />}
```

`key={selected}` 强制切项目时重挂载 iframe，否则会残留上一个项目的合成产物。

- [ ] **Step 3: 类型检查**

```bash
cd apps/web && npx tsc --noEmit
```

预期：无输出。

- [ ] **Step 4: 浏览器人工验收**

确认 dev server 在跑（`lsof -i:5173 | grep LISTEN`；不在则从仓库根 `npx pnpm dev`）。
打开 `http://localhost:5173` →「做内容」→ 选一个已生成过视频的项目（如 `ant-design-pro`）→「预览」tab，确认：
1. iframe 里出现合成画面（不是空白/不是下载提示）；
2. 点「播放」画面动起来，进度条与时间同步推进；
3. 拖动进度条画面跟随跳转；
4. 选一个从没生成过视频的项目，应显示那句错误提示而不是白屏或报错崩溃。

- [ ] **Step 5: 提交**

```bash
git add apps/web/src/pages/workshop/PreviewTab.tsx apps/web/src/pages/WorkshopPage.tsx
git commit -m "feat(web): 做内容页加预览 tab，页内秒级预览合成产物"
```

---

### Task 7: 基础运动层（相机层 + idle 微动）

**⚠ 本任务的实现路线由 Task 1 的结论决定。** Task 1 成立 → 按 A 案；不成立 → 按 B 案。
两案的验收口径相同。

**Files:**
- Modify: `packages/studio/src/hyperframes.ts`（`FX_CSS` 加相机层样式；新增相机曲线与 idle 的生成函数；`injectTechFx` 注入）
- Modify: `templates/hf/*.html`（10 个模板：加 `#cam` 包裹层与新标记）
- Test: `packages/studio/test/hyperframes.test.ts`

**Interfaces:**
- Consumes: Task 1 的结论与其验证过的 CSS/GSAP 写法
- Produces: 合成产物在整片任意时刻至少有一层在动

- [ ] **Step 1: 写失败测试（纯函数部分）**

相机曲线与 idle 相位错开是可单测的纯函数。先定义并测试：

```ts
describe('相机曲线', () => {
  it('末键落在片长之外，避免片尾收住导致静止', () => {
    const k = buildCameraKeyframes(60)
    expect(k.durationSec).toBeGreaterThan(60)
  })
  it('缩放幅度温和（1 → 1.02~1.10 之间），不至于把画面推爆', () => {
    const k = buildCameraKeyframes(60)
    expect(k.to.scale).toBeGreaterThan(1.01)
    expect(k.to.scale).toBeLessThanOrEqual(1.10)
  })
})

describe('idle 相位错开', () => {
  it('相邻序号的相位不同，避免同屏元素同步呼吸', () => {
    expect(idlePhase(0)).not.toBeCloseTo(idlePhase(1), 5)
  })
  it('同序号恒定（确定性）', () => {
    expect(idlePhase(7)).toBe(idlePhase(7))
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
npx pnpm --filter @forgecast/studio test 2>&1 | tail -20
```

预期：`buildCameraKeyframes` / `idlePhase` 未定义而失败。

- [ ] **Step 3A（Task 1 成立时）：实现相机层**

在 `hyperframes.ts` 导出：

```ts
/** 全程相机曲线关键帧。末键刻意落在片长之外（×1.15）——曲线若在片尾收住，
 *  最后约 0.9 秒会慢到停死，仍会被判静止（HyperFrames 逐帧渲染下实测可见）。 */
export function buildCameraKeyframes(durationSec: number): {
  durationSec: number; from: { scale: number; x: number; y: number }; to: { scale: number; x: number; y: number }
} {
  return {
    durationSec: durationSec * 1.15,
    from: { scale: 1, x: 0, y: 0 },
    to: { scale: 1.06, x: -14, y: -8 },
  }
}

/** idle 微动相位：按元素稳定序号错开，避免同屏元素同步呼吸。确定性，无随机。 */
export function idlePhase(index: number): number {
  return ((index * 0.6180339887) % 1) * Math.PI * 2
}
```

`FX_CSS` 追加：

```css
      #cam { position: absolute; inset: 0; transform-origin: 50% 50%; }
```

`injectTechFx` 内追加相机 GSAP 行的注入。**新增一个专属标记 `<!--HF_CAM-->`**，不要并进
`<!--HF_BGANIM-->`——后者只在 `bg` 存在时才被填充（`story` 不传 bg，见现有 `injectTechFx` 的 if/else），
相机层必须**所有模板无条件都有**，共用标记会让 story 拿不到相机曲线。

`injectTechFx` 改成：`<!--HF_FXCSS-->`、`<!--HF_DECODE-->`、`<!--HF_CAM-->` 三个无条件填充，
`<!--HF_BG-->` / `<!--HF_BGANIM-->` 维持现有的按 bg 条件填充。

10 个模板各自：
1. 把 `#root` 的子元素用 `<div id="cam">…</div>` 包起来；
2. 在 `<script>` 里 `tl` 定义之后、`window.__timelines` 赋值之前，加一行 `<!--HF_CAM-->` 标记。

GSAP 行按 Task 1 验证过的写法、用 `buildCameraKeyframes(durationSec)` 的返回值生成。

- [ ] **Step 3B（Task 1 不成立时）：退回逐元素微动**

不加全局 `#cam`。改为对各 `build*Sections` 产出的主体元素追加持续 idle 补间，
用有限 repeat + yoyo（**禁止 `repeat: -1`**），重复次数按片长算足：

```ts
// 每个周期 4s，算够覆盖片长的重复次数（有限次，HyperFrames 禁止 repeat:-1）
const cycles = Math.ceil(durationSec / 4) + 1
accentLines.push(`tl.to("#${id}", { y: "+=3", scale: 1.005, duration: 2, ease: "sine.inOut", yoyo: true, repeat: ${cycles * 2} }, ${idlePhase(idx).toFixed(3)});`)
```

- [ ] **Step 4: 跑测试 + 合成产物验收**

```bash
npx pnpm --filter @forgecast/studio test 2>&1 | tail -20
```

再对一份真实合成产物验收（用现有 `workspace/ant-design-pro/hf`，**先备份再覆盖**，或重新生成一条）：

```bash
cd workspace/<slug>/hf
npx --yes hyperframes@0.7.68 check 2>&1 | tail -30
npx --yes hyperframes@0.7.68 snapshot --at 5,14,22,30,40,50 --no-end
```

**注意 `--at` 是逗号分隔的单参数**，重复传 `--at 5 --at 14` 只有最后一个生效（Task 1 实测）。

验收：
1. `check` 的 lint **0 error**（Task 2/3/4 已清掉三条，本任务不得引入新的）；
2. **单测断言**：10 个模板（含 story 两个）产出的合成 HTML 里都含相机曲线注入结果，
   且不再残留旧的 `tl.fromTo("#root"` 那条；
3. **人工看图**：打开抽出的 6 帧，判断画面是否在可感知地推进。
   **不要用逐像素比对或 SSIM 当门禁**——实测当前这个有问题的产物四帧两两 `cmp` 全「不同」、
   SSIM(14s,20s)=0.885，任何整帧阈值都会误判通过：科技背景的 `.mv`/`.sweep` 一直在流动，
   而真正静止的是内容层。整帧指标与本任务要解决的问题不相关。

- [ ] **Step 5: 提交**

```bash
git add packages/studio/src/hyperframes.ts packages/studio/test/hyperframes.test.ts templates/hf/*.html
git commit -m "feat(studio): 加基础运动层（相机曲线 + idle 微动），消灭整段静止帧"
```

---

### Task 8: insight 构图重做

**Files:**
- Modify: `templates/hf/insight.html`、`templates/hf/insight-landscape.html`
- Modify: `packages/studio/src/hyperframes.ts`（`buildInsightSections` 的卡片排布与时长）
- Test: `packages/studio/test/hyperframes.test.ts`

**Interfaces:**
- Consumes: Task 6 的预览（**边改边看，不要靠完整渲染迭代**）
- Produces: 无

**背景（实测数据）**：61 秒的片子只提取出 3 张卡（`INSIGHT_STAT_RE` 数字正则命中率低），
且第一张被拉长到 25.32 秒填满整个分组窗口 → 画面 88% 长期空白且完全静止。
横屏卡片写死 `right: 140px; width: 560px`（560/1920 ≈ 29%），左侧 1200px 是结构性永久空白。

**硬约束（来自 spec §5，不是风格建议）**：
1. 内容区宽度 ≥ 画布宽度的 55%；卡片不得再恒定贴右。
2. 任意时刻同屏卡片 2~3 张；超过 3 张时最旧的一张真退场（缩小 + 降透明度移出），不是无限堆叠。
3. 单卡驻留 ≤ 8 秒；超过则必须有新卡进场或旧卡退场。
4. 保留至少一个空象限，但不允许「内容缩在一角、其余三面全空」。
5. 同屏多卡时只有一张享受主视觉造型（大字号/高亮色），其余降次级。
6. 竖屏与横屏**各自独立成立**，不共用一套绝对定位数值。

- [ ] **Step 1: 写失败测试（可断言的部分）**

版式好坏无法自动断言，但「单卡驻留上限」与「同屏卡片数」可以：

```ts
describe('insight 构图约束', () => {
  const cues = Array.from({ length: 8 }, (_, i) => ({
    start: 5 + i * 6, end: 9 + i * 6, text: `第${i}项返工率 ${10 + i}%`,
  }))
  it('单张卡片驻留不超过 8 秒', () => {
    const { html } = buildInsightSections({ cues, durationSec: 60, painTitle: 'T', cta: 'C', brandName: 'B' })
    const durs = [...html.matchAll(/id="insCard\d+_\d+"[^>]*data-duration="([\d.]+)"/g)].map((m) => +m[1])
    expect(durs.length).toBeGreaterThan(0)
    for (const d of durs) expect(d).toBeLessThanOrEqual(8)
  })
  it('任意时刻同屏卡片不超过 3 张', () => {
    const { html } = buildInsightSections({ cues, durationSec: 60, painTitle: 'T', cta: 'C', brandName: 'B' })
    const clips = [...html.matchAll(/id="insCard\d+_\d+"[^>]*data-start="([\d.]+)" data-duration="([\d.]+)"/g)]
      .map((m) => ({ s: +m[1], e: +m[1] + +m[2] }))
    for (let t = 0; t <= 60; t += 0.5) {
      const live = clips.filter((c) => t >= c.s && t < c.e).length
      expect(live).toBeLessThanOrEqual(3)
    }
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
npx pnpm --filter @forgecast/studio test 2>&1 | tail -20
```

预期：驻留上限那条失败（当前会算出 25 秒级的时长）。

- [ ] **Step 3: 实现**

改 `buildInsightSections` 的时长计算：卡片时长不再是「到本组结束」，而是
`min(8, 下一张卡的 start - 本卡 start, sceneEnd - 本卡 start)` 的下限保护版本；
同屏 >3 时最旧的先退场。同时改两个 insight 模板的 `.card` 版式满足上面 6 条硬约束。

**版式的具体数值边改边在 Task 6 的预览里看**，不要靠完整渲染迭代。

- [ ] **Step 4: 跑测试 + 预览验收 + 抽帧验收**

```bash
npx pnpm --filter @forgecast/studio test 2>&1 | tail -20
```

重新生成一条 insight 视频（或手工改一份合成产物），在「做内容 → 预览」里拖着看整条，
确认 6 条硬约束逐条成立；再 `snapshot --at` 抽 6 帧人眼复核构图。

- [ ] **Step 5: 提交**

```bash
git add packages/studio/src/hyperframes.ts packages/studio/test/hyperframes.test.ts templates/hf/insight.html templates/hf/insight-landscape.html
git commit -m "feat(studio): insight 构图重做——消除结构性空白、限制单卡驻留、控制同屏卡数"
```

---

### Task 9: 全量回归 + 一条真渲染

**Files:**
- Modify: `README.md`（仅当其中有描述做内容页 tab 或视频能力的段落需要同步；没有则跳过）

**Interfaces:**
- Consumes: Task 1-8 全部产出
- Produces: 无

- [ ] **Step 1: 全量测试**

```bash
export NVM_DIR="$HOME/.nvm" && source "$NVM_DIR/nvm.sh" && nvm use 22.23.2
npx pnpm test 2>&1 | grep -E "FAIL|Test Files|Tests  "
```

预期：11 个 package 全绿。已知并行满载 flake（`packages/studio` 的 `tts.test.ts`、
`packages/rebrand` 的 `kill-port` / `screenshot`）若命中，单独重跑该文件确认通过即可，不算回归。

- [ ] **Step 2: 前端构建**

```bash
cd apps/web && npx tsc --noEmit && npx vite build
```

- [ ] **Step 3: 合成产物终检**

对一份最新生成的合成产物：

```bash
cd workspace/<slug>/hf
npx --yes hyperframes@0.7.68 check 2>&1 | tail -30
npx --yes hyperframes@0.7.68 snapshot --at 5,14,22,30,40,50 --no-end
```

预期：**lint 0 error**（三条已知 error 全清）。warning 允许保留但须在报告里列出。
抽出的 6 帧人工过目，确认内容在推进、构图不再大面积空白（`--at` 是逗号分隔单参数，勿用重复 flag）。

- [ ] **Step 4: 真渲染一条**

`check` + `snapshot` 覆盖不到「只在完整渲染才暴露」的问题（如音轨、编码、字体在真渲下的表现）。
用 Web 界面或 CLI 真渲一条 insight 视频，确认：
1. 渲染成功产出 MP4；
2. 播放确认中文字体正确、画面不再长时间静止、构图不再大面积空白；
3. `ffmpeg -i <mp4> -af volumedetect -f null -` 确认音轨非静音（`mean_volume` 不接近 -91dB）
   ——项目有过「静音降级但全程无报错」的先例。

- [ ] **Step 5: README 检查**

```bash
grep -n "做内容\|预览\|视频" README.md | head -20
```

有相关段落则同步（新增预览 tab）；没有则跳过，不为此强行加章节。

- [ ] **Step 6: 提交（若有 README 改动）**

```bash
git add README.md
git commit -m "docs: README 同步做内容页预览能力"
```
