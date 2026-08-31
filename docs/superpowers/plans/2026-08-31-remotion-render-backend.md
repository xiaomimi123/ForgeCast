# Remotion 渲染后端 实施计划（做内容重构 子项目②）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把固定五模板（flash/story/demo/insight/changelog）的渲染后端从 HyperFrames 换成 Remotion，并把预览改为实时预览。

**Architecture:** 新增 `packages/compositions`（纯 React、零 Node 依赖）承载吃 `VideoSpec` 的合成组件；`packages/studio` 用 `@remotion/renderer` 渲染，`apps/web` 用 `@remotion/player` 预览，二者共用同一组件与同一份 spec。核心可测性决策：**「时刻 t 长什么样」做成纯函数、Remotion 只负责提供 t**——展示组件接收 `timeSec` 作为 prop，外层薄包装读 `useCurrentFrame()` 换算后传入。

**Tech Stack:** remotion 4.0.519 / @remotion/renderer / @remotion/bundler / @remotion/player、React 18.3、vitest + @testing-library/react + jsdom、pnpm 9.15.0 workspace、Node 22

**Spec:** `docs/superpowers/specs/2026-08-31-remotion-render-backend-design.md`

## Global Constraints

- **不改视觉**：五模板产出与现在等价。「顺手优化版式」属越界。②做完视频看起来和现在几乎一样是**预期结果**。
- **时间只存在于 `spec.layers`**：组件不得计算/推导/吸附任何起止时间，只读 `layer.start` / `layer.duration` / `layer.track`。
- **fps 固定 30，显式设定**（实测现有成片为 1080×1920 @ 30fps）。
- **`packages/compositions` 零 Node 依赖**：对 `@forgecast/studio` 只能 `import type`，任何值导入都会把 `better-sqlite3` 拖进浏览器包。此约束须有测试保障。
- **不动** `hyperframes.ts` 的 `build*Sections`、`mixAudio`、`analyzeBeats`、`runKokoroTts` 的既有行为。
- **保留 `render-html.ts` 与 `test/equivalence.test.ts`**（①的门禁），②期间不得删除——`lower()` 是两个渲染器共用层。
- 画布：portrait 1080×1920 / landscape 1920×1080，由 `spec.canvas` 给出，组件用 `useVideoConfig()` 自适应，**不做 10 个变体组件**。
- GSAP 默认缓动是 `power1.out`；Remotion 侧对应 `Easing.out(Easing.quad)`，不得用线性代替。
- 测试须 Node ≥22：`export NVM_DIR="$HOME/.nvm" && source "$NVM_DIR/nvm.sh" && nvm use 22.23.2 && ...`（**同一次 shell 调用内**），否则 `better-sqlite3` ABI 报大量假错。
- `apps/web` 无测试框架（`"test": "echo 'web: 人工验收，无单测'"`），项目约定，不得新增。
- **禁止 `pkill`/`killall` 等广谱杀进程**：用户 dev server 跑在 5173/4321，曾被此类命令整套杀掉。只能按自己启动的 PID 关闭。
- 提交信息不带 `Co-Authored-By` trailer。
- 已知无关的既有报错：`packages/studio/test/hyperframes.test.ts:591` 的 tsc 错误，忽略。

## 文件结构

```
packages/compositions/                 新包（纯 React，零 Node 依赖）
  package.json / tsconfig.json / vitest.config.ts
  src/
    videospec-types.ts   仅 `export type ... from '@forgecast/studio'` 的再导出（保证只有类型进出）
    time.ts              秒↔帧换算、fps 常量
    effects.ts           Effect[] + 时刻 t → { opacity, y, scale }（纯函数）
    decode.ts            逐字解码：字符索引 + t → 显示什么（纯函数，含 mulberry32）
    Text.tsx             文本分行 + decode 渲染（纯展示，收 timeSec）
    Image.tsx            phoneWrap / wideWrap / 裸图 + 路径编码（纯展示）
    Background.tsx       5 套科技背景 + 相机层（纯展示，收 timeSec）
    LayerView.tsx        单图层 → DOM（纯展示，收 timeSec）
    SpecView.tsx         VideoSpec → 全部图层（纯展示，收 timeSec）——内容断言门禁打这一层
    SpecComposition.tsx  薄包装：useCurrentFrame/useVideoConfig → timeSec → <SpecView>
    Root.tsx             Remotion <Composition> 注册
    styles/base.css      FX_CSS 通用部分 + 解码 CSS
    styles/{flash,story,demo,insight,changelog}.css
    index.ts
  test/
    effects.test.ts      每帧数值（对齐 render-html.ts 的 GSAP 数值）
    decode.test.ts       解码时序
    no-node-deps.test.ts 零 Node 依赖守卫
    content.test.tsx     内容断言主闸（复用①的 7 组 fixture）
    contract.test.tsx    durationInFrames / 画布 / 图层数
    video-layer.test.tsx 合成能力证明

packages/studio/src/
  remotion-render.ts     新：bundle 缓存 + renderMedia
  generate.ts            改：五模板改走 remotion-render
  videospec.ts           不动（类型留此，compositions 只 import type）
  render-html.ts         不动（①门禁继续用）

apps/web/src/pages/workshop/PreviewTab.tsx   改：@remotion/player
```

---

### Task 1: 新建 compositions 包 + 零 Node 依赖守卫

**Files:**
- Create: `packages/compositions/package.json`、`tsconfig.json`、`vitest.config.ts`、`src/index.ts`、`src/videospec-types.ts`、`src/time.ts`
- Test: `packages/compositions/test/no-node-deps.test.ts`

**Interfaces:**
- Produces: 包名 `@forgecast/compositions`；`export const FPS = 30`；`secToFrames(sec: number): number`；类型再导出 `VideoSpec` / `Layer` / `Effect` / `LayerStyle` / `LayerContent`

- [ ] **Step 1: 写失败测试（零 Node 依赖守卫）**

这条守卫不能只靠约定——一个值导入就会炸掉 `apps/web` 构建，而写的时候毫无感觉。

```ts
// packages/compositions/test/no-node-deps.test.ts
import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n)
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') || p.endsWith('.tsx') ? [p] : []
  })
}

describe('compositions 零 Node 依赖', () => {
  const files = walk(new URL('../src', import.meta.url).pathname)

  it('src 下没有任何 Node 内置模块导入', () => {
    const bad: string[] = []
    for (const f of files) {
      const s = readFileSync(f, 'utf-8')
      if (/from\s+['"](node:|fs|path|child_process|os|crypto)['"]/.test(s)) bad.push(f)
    }
    expect(bad).toEqual([])
  })

  it('对 @forgecast/studio 只能 import type，不得有值导入', () => {
    const bad: string[] = []
    for (const f of files) {
      for (const line of readFileSync(f, 'utf-8').split('\n')) {
        if (!line.includes('@forgecast/studio')) continue
        if (!/^\s*(import|export)\s+type\s/.test(line)) bad.push(`${f}: ${line.trim()}`)
      }
    }
    expect(bad).toEqual([])
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `export NVM_DIR="$HOME/.nvm" && source "$NVM_DIR/nvm.sh" && nvm use 22.23.2 && npx pnpm --filter @forgecast/compositions test`
Expected: FAIL —— 包还不存在

- [ ] **Step 3: 建包**

`packages/compositions/package.json`：

```json
{
  "name": "@forgecast/compositions",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "scripts": { "test": "vitest run", "typecheck": "tsc --noEmit" },
  "dependencies": {
    "react": "^18.3.0",
    "react-dom": "^18.3.0",
    "remotion": "4.0.519"
  },
  "devDependencies": {
    "@forgecast/studio": "workspace:*",
    "@testing-library/react": "^16.0.0",
    "@types/react": "^18.3.0",
    "jsdom": "^25.0.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

注意 `@forgecast/studio` 放在 **devDependencies**——只为类型解析，运行时不依赖。

`vitest.config.ts`：

```ts
import { defineConfig } from 'vitest/config'
export default defineConfig({ test: { environment: 'jsdom', globals: false } })
```

`tsconfig.json` 参照 `packages/studio/tsconfig.json`，追加 `"jsx": "react-jsx"`。

- [ ] **Step 4: 写类型再导出与时间换算**

```ts
// packages/compositions/src/videospec-types.ts
// 唯一允许触碰 @forgecast/studio 的文件，且只搬类型（值导入会把 Node 依赖拖进浏览器包）。
export type { VideoSpec, Semantic, Section, Layer, LayerContent, LayerStyle, Effect, AudioSpec } from '@forgecast/studio'
```

```ts
// packages/compositions/src/time.ts
/** 实测现有成片为 1080×1920 @ 30fps（HyperFrames 用其默认值）。改这个值会让所有卡点错位。 */
export const FPS = 30
export function secToFrames(sec: number): number { return Math.round(sec * FPS) }
export function framesToSec(frames: number): number { return frames / FPS }
```

`src/index.ts` 先导出这两个模块。

- [ ] **Step 5: 跑测试确认通过**

Run: `export NVM_DIR="$HOME/.nvm" && source "$NVM_DIR/nvm.sh" && nvm use 22.23.2 && npx pnpm install && npx pnpm --filter @forgecast/compositions test`
Expected: PASS（2 tests）

- [ ] **Step 6: 提交**

```bash
git add packages/compositions pnpm-lock.yaml
git commit -m "feat(compositions): 新建纯 React 合成包 + 零 Node 依赖守卫"
```

---

### Task 2: effects.ts —— 每帧求值（纯函数）

**Files:**
- Create: `packages/compositions/src/effects.ts`
- Test: `packages/compositions/test/effects.test.ts`

**Interfaces:**
- Consumes: `Effect`（`videospec-types.ts`）
- Produces: `export interface FrameStyle { opacity: number; y: number; scale: number }`；`export function styleAt(effects: Effect[], layerStart: number, layerDuration: number, timeSec: number, line: number | null): FrameStyle`

**背景（实现者必读）：** 现有实现把 effects 编译成 GSAP 行（`packages/studio/src/render-html.ts:139-173` `effectToAccentLine`），由 HyperFrames 的暂停时间线 seek 驱动。Remotion 是逐帧函数式渲染，改为**按时刻直接求值**。数值必须逐个对齐，不得"顺手调得更好看"。

对照表（左为 GSAP 语义，右为求值规则；`t0 = layerStart + (effect.at ?? 0)`，`d = effect.duration ?? 0.3`，`p = clamp((timeSec - t0)/d, 0, 1)` 且 **p 需经 `Easing.out(Easing.quad)` 即 `1-(1-p)²`**，因为 GSAP 默认缓动是 `power1.out`）：

| effect | GSAP 原式 | 求值 |
|---|---|---|
| `fadeIn`（默认） | `tl.from(target,{opacity:0,y:20,duration:d},t0)` | `opacity = e(p)`，`y = 20*(1-e(p))` |
| `fadeIn`（带 `params.scale`） | `tl.from(target,{opacity:0,scale:S,duration:d},t0)` | `opacity = e(p)`，`scale = S + (1-S)*e(p)` |
| `slideUp` | `tl.from(target,{opacity:0,y:40,duration:d},t0)` | `opacity = e(p)`，`y = 40*(1-e(p))` |
| `demote` | `tl.to(target,{opacity:.55,scale:.78,duration:d},t0)` | `opacity = 1-0.45*e(p)`，`scale = 1-0.22*e(p)`（**动完保持在终值**） |
| `pulse` | `tl.to(target,{keyframes:[{scale:1.06,duration:.08},{scale:1.0,duration:.12}]},t0)` | 见下方分段 |
| `exit` | `tl.to(...,{opacity:0,scale:.85,duration:d}, clipEnd-d)` + `tl.set(...,{opacity:0}, clipEnd)` | `exitAt = layerStart+layerDuration-d` 起算；`timeSec >= clipEnd` 时 `opacity=0` 硬收尾 |
| `decode` | 不落 accent（落成 `.tw` 类） | **本函数返回不受影响**，由 Task 3 处理 |

`fadeIn` 的 `params.y` 可覆盖默认 20（`videospec.ts` 注释：changelog 的 label 用 `y:-30`）。

**line 过滤规则**（迁自 `render-html.ts:142-143`）：effect 的 `params.line` 为数字时打到第 N 行子元素，否则打到整个 clip。故 `styleAt(..., line)` 只应用 `(e.params?.line ?? null) === line` 的 effect。

- [ ] **Step 1: 写失败测试**

```ts
// packages/compositions/test/effects.test.ts
import { describe, expect, it } from 'vitest'
import { styleAt } from '../src/effects'
import type { Effect } from '../src/videospec-types'

const near = (a: number, b: number) => expect(Math.abs(a - b)).toBeLessThan(1e-6)

describe('styleAt', () => {
  it('fadeIn：起点全透明、终点不透明且位移归零', () => {
    const fx: Effect[] = [{ type: 'fadeIn', at: 0, duration: 0.4 }]
    const a = styleAt(fx, 2, 5, 2, null)
    near(a.opacity, 0); near(a.y, 20)
    const b = styleAt(fx, 2, 5, 2.4, null)
    near(b.opacity, 1); near(b.y, 0)
  })

  it('fadeIn 用 power1.out 缓动，不是线性', () => {
    const fx: Effect[] = [{ type: 'fadeIn', at: 0, duration: 0.4 }]
    // 半程线性会是 0.5；power1.out 是 1-(1-.5)^2 = 0.75
    near(styleAt(fx, 0, 5, 0.2, null).opacity, 0.75)
  })

  it('fadeIn 带 params.scale 走缩放而非位移', () => {
    const fx: Effect[] = [{ type: 'fadeIn', at: 0, duration: 0.4, params: { scale: 0.9 } }]
    const a = styleAt(fx, 0, 5, 0, null)
    near(a.scale, 0.9); near(a.y, 0)
    near(styleAt(fx, 0, 5, 0.4, null).scale, 1)
  })

  it('demote 动完保持终值（0.55 / 0.78），不回弹', () => {
    const fx: Effect[] = [{ type: 'demote', at: 1, duration: 0.5 }]
    const end = styleAt(fx, 0, 10, 1.5, null)
    near(end.opacity, 0.55); near(end.scale, 0.78)
    const later = styleAt(fx, 0, 10, 8, null)
    near(later.opacity, 0.55); near(later.scale, 0.78)
  })

  it('exit 在 clip 结束时刻硬收尾为全透明', () => {
    const fx: Effect[] = [{ type: 'exit', duration: 0.5 }]
    // layerStart=2 duration=6 → clipEnd=8，exitAt=7.5
    near(styleAt(fx, 2, 6, 7.4, null).opacity, 1)
    near(styleAt(fx, 2, 6, 8, null).opacity, 0)
    near(styleAt(fx, 2, 6, 9, null).opacity, 0)
  })

  it('pulse：0.08s 到 1.06，再 0.12s 回 1.0，之后保持 1', () => {
    const fx: Effect[] = [{ type: 'pulse', at: 0 }]
    near(styleAt(fx, 0, 5, 0.08, null).scale, 1.06)
    near(styleAt(fx, 0, 5, 0.2, null).scale, 1)
    near(styleAt(fx, 0, 5, 3, null).scale, 1)
  })

  it('params.line 决定 effect 打在哪一行；不匹配的行拿到中性值', () => {
    const fx: Effect[] = [{ type: 'slideUp', at: 0, duration: 0.5, params: { line: 1 } }]
    near(styleAt(fx, 0, 5, 0, 1).opacity, 0)      // 第 1 行受影响
    near(styleAt(fx, 0, 5, 0, 0).opacity, 1)      // 第 0 行不受影响
    near(styleAt(fx, 0, 5, 0, null).opacity, 1)   // clip 本身不受影响
  })

  it('decode 不影响样式（它落成 .tw 类由 Text 处理）', () => {
    const s = styleAt([{ type: 'decode' }], 0, 5, 1, null)
    near(s.opacity, 1); near(s.scale, 1); near(s.y, 0)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `export NVM_DIR="$HOME/.nvm" && source "$NVM_DIR/nvm.sh" && nvm use 22.23.2 && npx pnpm --filter @forgecast/compositions test effects`
Expected: FAIL —— `styleAt` 未定义

- [ ] **Step 3: 实现**

```tsx
// packages/compositions/src/effects.ts
import type { Effect } from './videospec-types'

export interface FrameStyle { opacity: number; y: number; scale: number }

const clamp01 = (v: number) => Math.min(1, Math.max(0, v))
/** GSAP 默认缓动是 power1.out；线性会让运动手感明显不同，故必须保留。 */
const easeOutQuad = (p: number) => 1 - (1 - p) * (1 - p)

/**
 * 求 `timeSec` 时刻某个目标（clip 本身 line=null，或第 N 行）的叠加样式。
 * 数值逐个迁自 render-html.ts effectToAccentLine 编译出的 GSAP 行，不得改动。
 * 只读 layerStart/layerDuration，不计算它们（全局约束：时间只存在于 spec.layers）。
 */
export function styleAt(
  effects: Effect[], layerStart: number, layerDuration: number, timeSec: number, line: number | null,
): FrameStyle {
  const out: FrameStyle = { opacity: 1, y: 0, scale: 1 }
  for (const e of effects) {
    if ((e.params?.line ?? null) !== line) continue
    const t0 = layerStart + (e.at ?? 0)
    const d = e.duration ?? 0.3
    const p = easeOutQuad(clamp01(d > 0 ? (timeSec - t0) / d : 1))
    switch (e.type) {
      case 'fadeIn': {
        const s = e.params?.scale
        out.opacity *= p
        if (typeof s === 'number') out.scale *= s + (1 - s) * p
        else out.y += (typeof e.params?.y === 'number' ? e.params.y : 20) * (1 - p)
        break
      }
      case 'slideUp':
        out.opacity *= p
        out.y += 40 * (1 - p)
        break
      case 'demote':
        out.opacity *= 1 - 0.45 * p
        out.scale *= 1 - 0.22 * p
        break
      case 'pulse': {
        const rel = timeSec - t0
        if (rel >= 0 && rel < 0.08) out.scale *= 1 + 0.06 * easeOutQuad(rel / 0.08)
        else if (rel >= 0.08 && rel < 0.2) out.scale *= 1.06 - 0.06 * easeOutQuad((rel - 0.08) / 0.12)
        break
      }
      case 'exit': {
        const clipEnd = layerStart + layerDuration
        if (timeSec >= clipEnd) { out.opacity = 0; break }   // tl.set 硬收尾
        const q = easeOutQuad(clamp01(d > 0 ? (timeSec - (clipEnd - d)) / d : 0))
        out.opacity *= 1 - q
        out.scale *= 1 - 0.15 * q
        break
      }
      case 'decode':
        break   // 落成 .tw 类，见 Text.tsx
    }
  }
  return out
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: 同 Step 2
Expected: PASS（8 tests）

- [ ] **Step 5: 提交**

```bash
git add packages/compositions/src/effects.ts packages/compositions/test/effects.test.ts
git commit -m "feat(compositions): effects 每帧求值，数值对齐现有 GSAP 行"
```

---

### Task 3: decode.ts + Text.tsx —— 逐字解码与文本分行

**Files:**
- Create: `packages/compositions/src/decode.ts`、`packages/compositions/src/Text.tsx`
- Test: `packages/compositions/test/decode.test.ts`

**Interfaces:**
- Consumes: `styleAt`（Task 2）、`Layer`
- Produces: `export function charStateAt(charIndex: number, charCount: number, elemIndex: number, clipStart: number, timeSec: number): { kind: 'hidden' } | { kind: 'ghost'; glyph: string } | { kind: 'final' }`；`export function decodeTargets(layer: Layer): { all: boolean; lines: Set<number> }`；React 组件 `<TextContent layer timeSec elemIndexBase />`

**背景（实现者必读）：** 现有解码是注入浏览器的运行时脚本（`packages/studio/src/hyperframes.ts` `DECODE_RUNTIME`），HyperFrames 下**不能逐帧改 `textContent`**，所以用透明度叠层硬凑。Remotion 逐帧函数式渲染可以直接算"这一帧该显示什么"，实现变正常，**但观感必须一致**，故时序参数原样搬：

- 字符池 `POOL`（原样复制，含日/月/火…与 `#@%&*<>/|=+` 与片假名）
- 播种随机 `mulberry32`，种子 `(elemIndex+1)*73856093 ^ (charIndex+1)*19349663`
- `K = 5` 个鬼影，`gstep = 0.045`
- 字间步长 `step = min(0.055, 1.1 / max(1, charCount))`
- 第 i 字起点 `t0 = clipStart + i * step`
- `t0 <= t < t0 + 5*0.045` 显示第 `floor((t-t0)/gstep)` 个鬼影；`t >= t0 + 0.225` 显示真字；`t < t0` 不显示
- 空格字符不解码，`t0` 时刻直接出现

**`elemIndex` 的确定性**（关键，容易搬错）：原脚本用 `document.querySelectorAll('.tw')` 的**文档顺序序号**做种子。Remotion 侧必须复现同一序号：按 `spec.layers` 顺序遍历，层内按行号升序，只对被 decode 命中的行计数。序号错了随机字符就变了（观感差异，但门禁看不出来），故本任务必须有测试钉住。

- [ ] **Step 1: 写失败测试**

```ts
// packages/compositions/test/decode.test.ts
import { describe, expect, it } from 'vitest'
import { charStateAt, decodeTargets } from '../src/decode'
import type { Layer } from '../src/videospec-types'

const L = (effects: Layer['effects']): Layer => ({
  id: 'x', kind: 'text', from: null, overridden: false, start: 0, duration: 5, track: 1,
  content: { kind: 'text', text: 'a\nb' }, style: {}, effects,
})

describe('decodeTargets', () => {
  it('无 params.line 的 decode → 整层每行都解码', () => {
    const t = decodeTargets(L([{ type: 'decode' }]))
    expect(t.all).toBe(true)
  })
  it('带 params.line → 只有指定行解码', () => {
    const t = decodeTargets(L([{ type: 'decode', params: { line: 1 } }]))
    expect(t.all).toBe(false)
    expect([...t.lines]).toEqual([1])
  })
  it('没有 decode effect → 都不解码', () => {
    const t = decodeTargets(L([{ type: 'fadeIn' }]))
    expect(t.all).toBe(false)
    expect(t.lines.size).toBe(0)
  })
})

describe('charStateAt', () => {
  it('字符起点之前不显示', () => {
    expect(charStateAt(0, 4, 0, 2, 1.9).kind).toBe('hidden')
  })
  it('起点后先走 5 个鬼影，每个 0.045s', () => {
    const a = charStateAt(0, 4, 0, 2, 2.0)
    const b = charStateAt(0, 4, 0, 2, 2.05)
    expect(a.kind).toBe('ghost')
    expect(b.kind).toBe('ghost')
    if (a.kind === 'ghost' && b.kind === 'ghost') expect(a.glyph).not.toBe(b.glyph)
  })
  it('t0 + 5*0.045 = 0.225s 后锁定为真字', () => {
    expect(charStateAt(0, 4, 0, 2, 2 + 0.225).kind).toBe('final')
    expect(charStateAt(0, 4, 0, 2, 9).kind).toBe('final')
  })
  it('字间步长 = min(0.055, 1.1/字数)：长文本更快', () => {
    // 40 字 → 1.1/40 = 0.0275；第 2 字起点 = 0 + 2*0.0275 = 0.055
    expect(charStateAt(2, 40, 0, 0, 0.054).kind).toBe('hidden')
    expect(charStateAt(2, 40, 0, 0, 0.056).kind).not.toBe('hidden')
  })
  it('确定性：同参数两次调用得到同一鬼影字符', () => {
    const a = charStateAt(3, 10, 2, 0, 0.02 + 3 * 0.055)
    const b = charStateAt(3, 10, 2, 0, 0.02 + 3 * 0.055)
    expect(a).toEqual(b)
  })
  it('elemIndex 不同 → 鬼影序列不同（种子含元素序号）', () => {
    const a = charStateAt(0, 5, 0, 0, 0.01)
    const b = charStateAt(0, 5, 1, 0, 0.01)
    if (a.kind === 'ghost' && b.kind === 'ghost') expect(a.glyph).not.toBe(b.glyph)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `export NVM_DIR="$HOME/.nvm" && source "$NVM_DIR/nvm.sh" && nvm use 22.23.2 && npx pnpm --filter @forgecast/compositions test decode`
Expected: FAIL —— 模块不存在

- [ ] **Step 3: 实现 decode.ts**

```ts
// packages/compositions/src/decode.ts
import type { Layer } from './videospec-types'

/** 原样迁自 hyperframes.ts DECODE_RUNTIME，改动会改变观感。 */
const POOL = '日月火水木金土山川云电系统数据端口零一二三ABCDEF0123456789#@%&*<>/|=+アイウエオカキクケコサシスセソ'
const K = 5
const GSTEP = 0.045

function mulberry32(a: number): () => number {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export type CharState = { kind: 'hidden' } | { kind: 'ghost'; glyph: string } | { kind: 'final' }

/** 第 charIndex 个字在 timeSec 时刻的状态。elemIndex 必须与原脚本的 `.tw` 文档顺序序号一致。 */
export function charStateAt(
  charIndex: number, charCount: number, elemIndex: number, clipStart: number, timeSec: number,
): CharState {
  const step = Math.min(0.055, 1.1 / Math.max(1, charCount))
  const t0 = clipStart + charIndex * step
  if (timeSec < t0) return { kind: 'hidden' }
  const rel = timeSec - t0
  if (rel >= K * GSTEP) return { kind: 'final' }
  const j = Math.floor(rel / GSTEP)
  const rnd = mulberry32(((elemIndex + 1) * 73856093) ^ ((charIndex + 1) * 19349663))
  let glyph = POOL[0]
  for (let n = 0; n <= j; n++) glyph = POOL[(rnd() * POOL.length) | 0]
  return { kind: 'ghost', glyph }
}

/** 哪些行要解码（迁自 render-html.ts renderTextContent 的落位规则）。 */
export function decodeTargets(layer: Layer): { all: boolean; lines: Set<number> } {
  const ds = layer.effects.filter((e) => e.type === 'decode')
  return {
    all: ds.some((e) => e.params?.line === undefined),
    lines: new Set(ds.map((e) => e.params?.line).filter((l): l is number => typeof l === 'number')),
  }
}
```

**注意 ghost 的推进方式**：原脚本为每个字预生成 K 个鬼影（`rnd()` 连续调用 K 次），第 j 个鬼影在第 j 个窗口显示。上面的循环复现了这一点——第 j 窗口拿到的是第 j+1 次 `rnd()` 的结果。

- [ ] **Step 4: 实现 Text.tsx**

```tsx
// packages/compositions/src/Text.tsx
import React from 'react'
import { charStateAt, decodeTargets } from './decode'
import { styleAt } from './effects'
import type { Layer } from './videospec-types'

/**
 * 文本/字幕内容。多行按 '\n' 拆开，每行一个可寻址元素 `{layerId}-l{i}`（迁自 render-html.ts
 * renderTextContent——effects 的 params.line 靠这个落位）。解码行逐字渲染。
 * elemIndexBase：本层第 0 个解码行在全局 `.tw` 序列中的序号，由 SpecView 统一分配。
 */
export function TextContent(
  { layer, text, timeSec, elemIndexBase }: { layer: Layer; text: string; timeSec: number; elemIndexBase: number },
): React.ReactElement {
  const lines = text.split('\n')
  const targets = decodeTargets(layer)
  const Tag = lines.length > 1 ? 'div' : 'span'
  let twSeen = 0
  return (
    <>
      {lines.map((line, i) => {
        const isTw = targets.all || targets.lines.has(i)
        const s = styleAt(layer.effects, layer.start, layer.duration, timeSec, i)
        const style: React.CSSProperties = {
          opacity: s.opacity,
          transform: `translateY(${s.y}px) scale(${s.scale})`,
        }
        if (!isTw) {
          return <Tag key={i} id={`${layer.id}-l${i}`} style={style}>{line}</Tag>
        }
        const elemIndex = elemIndexBase + twSeen++
        const chars = Array.from(line)
        return (
          <Tag key={i} id={`${layer.id}-l${i}`} className="tw" style={style}>
            {chars.map((ch, ci) => {
              if (ch === ' ') {
                const t0 = layer.start + ci * Math.min(0.055, 1.1 / Math.max(1, chars.length))
                return <span key={ci} className="twc" style={{ opacity: timeSec >= t0 ? 1 : 0 }}>&nbsp;</span>
              }
              const st = charStateAt(ci, chars.length, elemIndex, layer.start, timeSec)
              if (st.kind === 'hidden') return <span key={ci} className="twc" style={{ opacity: 0 }}>{ch}</span>
              if (st.kind === 'ghost') return <span key={ci} className="twc"><span className="gh">{st.glyph}</span></span>
              return <span key={ci} className="twc"><span className="fin">{ch}</span></span>
            })}
          </Tag>
        )
      })}
    </>
  )
}

/** 本层消耗掉多少个 `.tw` 全局序号——SpecView 靠它累加，保证序号与原脚本文档顺序一致。 */
export function twCountOf(layer: Layer, text: string): number {
  const targets = decodeTargets(layer)
  return text.split('\n').filter((_, i) => targets.all || targets.lines.has(i)).length
}
```

**注意 hidden 态仍渲出字符本体并置 opacity 0**：这样布局宽度从第一帧就稳定，不会随解码进度跳动——与原脚本先清空 `textContent` 再逐个 append 的行为在观感上一致（原脚本靠透明度叠层，同样占位）。

- [ ] **Step 5: 跑测试确认通过**

Run: 同 Step 2
Expected: PASS（9 tests）

- [ ] **Step 6: 提交**

```bash
git add packages/compositions/src/decode.ts packages/compositions/src/Text.tsx packages/compositions/test/decode.test.ts
git commit -m "feat(compositions): 逐字解码改为逐帧求值，时序参数原样迁移"
```

---

### Task 4: Image.tsx —— 图片取景框与路径编码

**Files:**
- Create: `packages/compositions/src/Image.tsx`
- Test: `packages/compositions/test/image.test.tsx`

**Interfaces:**
- Produces: `export function encodePathForUrl(src: string): string`；React 组件 `<ImageContent src cssClass />`

**背景：** 迁自 `render-html.ts:78-109`。两件事必须原样保留：

1. **逐段 `encodeURIComponent`**，不是 `encodeURI`。`encodeURI` 放过 `#` 和 `?`，`my shot#1.png` 会被浏览器当锚点截断成 `/assets/my%20shot`，文件找不到。整串 `encodeURIComponent` 又会把 `/` 编成 `%2F` 拆掉子目录，所以必须按段编码。**这是①第 4 轮修复的结论，不要退回去。**
2. **两种取景框**：`phoneWrap`（竖图套手机外框）、`wideWrap`（横图居中 + 同图虚化背景）；未知 cssClass 退化成裸 `<img>`。朝向判断是 `lower()` 的活，这里只按 cssClass 分流。

- [ ] **Step 1: 写失败测试**

```tsx
// packages/compositions/test/image.test.tsx
import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { ImageContent, encodePathForUrl } from '../src/Image'

describe('encodePathForUrl', () => {
  it('编码空格与 # 与 ?，保留子目录分隔符', () => {
    expect(encodePathForUrl('my shot#1.png')).toBe('my%20shot%231.png')
    expect(encodePathForUrl('a?b.png')).toBe('a%3Fb.png')
    expect(encodePathForUrl('screens/a b.png')).toBe('screens/a%20b.png')
  })
})

describe('ImageContent', () => {
  it('phoneWrap 套手机外框', () => {
    const { container } = render(<ImageContent src="a.png" cssClass="phoneWrap" />)
    expect(container.querySelector('.phoneWrap .phone img')).not.toBeNull()
  })
  it('wideWrap 同时有虚化背景与前景图', () => {
    const { container } = render(<ImageContent src="a.png" cssClass="wideWrap" />)
    expect(container.querySelector('.wideBg')).not.toBeNull()
    expect(container.querySelector('.wideFg img')).not.toBeNull()
  })
  it('未知 cssClass 退化为裸 img', () => {
    const { container } = render(<ImageContent src="a.png" cssClass={undefined} />)
    expect(container.querySelector('img')).not.toBeNull()
    expect(container.querySelector('.phoneWrap')).toBeNull()
  })
  it('两处发射点都编码（img src 与 background-image）', () => {
    const { container } = render(<ImageContent src="my shot#1.png" cssClass="wideWrap" />)
    const bg = container.querySelector('.wideBg') as HTMLElement
    expect(bg.style.backgroundImage).toContain('my%20shot%231.png')
    expect(bg.style.backgroundImage).not.toContain('my shot#1.png')
    const img = container.querySelector('.wideFg img') as HTMLImageElement
    expect(img.getAttribute('src')).toBe('my%20shot%231.png')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `export NVM_DIR="$HOME/.nvm" && source "$NVM_DIR/nvm.sh" && nvm use 22.23.2 && npx pnpm --filter @forgecast/compositions test image`
Expected: FAIL —— 模块不存在

- [ ] **Step 3: 实现**

```tsx
// packages/compositions/src/Image.tsx
import React from 'react'

/**
 * 逐段编码：按 `/` 切开、每段 encodeURIComponent、再用 `/` 拼回。
 * 不能用 encodeURI（放过 `#`/`?`，含这两个字符的文件名会被浏览器截断）；
 * 也不能整串 encodeURIComponent（会把 `/` 编成 %2F 拆掉子目录）。
 */
export function encodePathForUrl(src: string): string {
  return src.split('/').map((seg) => encodeURIComponent(seg)).join('/')
}

export function ImageContent({ src, cssClass }: { src: string; cssClass: string | undefined }): React.ReactElement {
  const safe = encodePathForUrl(src)
  if (cssClass === 'phoneWrap') {
    return <div className="phoneWrap"><div className="phone"><img src={safe} /></div></div>
  }
  if (cssClass === 'wideWrap') {
    return (
      <div className="wideWrap">
        <div className="wideBg" style={{ backgroundImage: `url('${safe}')` }} />
        <div className="wideFg"><img src={safe} /></div>
      </div>
    )
  }
  return <img src={safe} />
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: 同 Step 2
Expected: PASS（5 tests）

- [ ] **Step 5: 提交**

```bash
git add packages/compositions/src/Image.tsx packages/compositions/test/image.test.tsx
git commit -m "feat(compositions): 图片取景框与逐段路径编码"
```

---

### Task 5: LayerView + SpecView + SpecComposition —— 图层遍历与 Remotion 接线

**Files:**
- Create: `packages/compositions/src/LayerView.tsx`、`src/SpecView.tsx`、`src/SpecComposition.tsx`、`src/Root.tsx`
- Modify: `packages/compositions/src/index.ts`
- Test: `packages/compositions/test/contract.test.tsx`

**Interfaces:**
- Consumes: `TextContent` / `twCountOf`（Task 3）、`ImageContent`（Task 4）、`styleAt`（Task 2）、`FPS` / `secToFrames`（Task 1）
- Produces: `<SpecView spec timeSec />`（纯展示，门禁打这一层）、`<SpecComposition spec />`（薄包装）、`<RemotionRoot />`

**关键分层（可测性核心）：** `SpecView` 是**纯展示组件**，接收 `timeSec` 作为 prop，不碰任何 Remotion hook——所以内容断言门禁用普通 React 测试即可，不需要起 Remotion 运行时。`SpecComposition` 只做一件事：读 `useCurrentFrame()`/`useVideoConfig()` 换算成秒后传给 `SpecView`。

**图层可见性：** 每个图层用 `<Sequence from={secToFrames(layer.start)} durationInFrames={secToFrames(layer.duration)}>` 包裹（对应 HyperFrames 的 clip 时间窗）。但 `SpecView` 是纯组件、不能用 `<Sequence>`，故 `SpecView` 内部**按 timeSec 自行判断可见性**（`layer.start <= t < layer.start + layer.duration`），`SpecComposition` 侧不再重复包 Sequence——单一可见性来源，避免两处判断不一致。

**track：** 同 track 不重叠是 `lower()` 保证的语义；这里 `track` 只用作 `zIndex`。

- [ ] **Step 1: 写失败测试**

```tsx
// packages/compositions/test/contract.test.tsx
import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { SpecView } from '../src/SpecView'
import { secToFrames, FPS } from '../src/time'
import type { Layer, VideoSpec } from '../src/videospec-types'

function layer(over: Partial<Layer>): Layer {
  return {
    id: 'l1', kind: 'text', from: null, overridden: false, start: 0, duration: 2, track: 1,
    content: { kind: 'text', text: 'hello' }, style: {}, effects: [], ...over,
  } as Layer
}
function spec(layers: Layer[], durationSec = 10): VideoSpec {
  return {
    version: 1, videoId: 'v1', slug: 's', template: 'flash', createdAt: '',
    semantic: { hook: null, sourceAssetId: null, sections: [] },
    canvas: { width: 1080, height: 1920 }, durationSec, layers,
    audio: { narration: null, bgm: null, beatGrid: null, captionsEnabled: false }, warnings: [],
  }
}

describe('SpecView 可见性', () => {
  it('图层只在 [start, start+duration) 内出现', () => {
    const s = spec([layer({ start: 2, duration: 3, content: { kind: 'text', text: '出现了' } })])
    expect(render(<SpecView spec={s} timeSec={1.9} />).container.textContent).not.toContain('出现了')
    expect(render(<SpecView spec={s} timeSec={2} />).container.textContent).toContain('出现了')
    expect(render(<SpecView spec={s} timeSec={4.9} />).container.textContent).toContain('出现了')
    expect(render(<SpecView spec={s} timeSec={5} />).container.textContent).not.toContain('出现了')
  })

  it('track 映射为 zIndex', () => {
    const s = spec([layer({ id: 'lz', track: 7 })])
    const el = render(<SpecView spec={s} timeSec={0} />).container.querySelector('#lz') as HTMLElement
    expect(el.style.zIndex).toBe('7')
  })

  it('图层带 clip 类与 cssClass', () => {
    const s = spec([layer({ id: 'lc', style: { cssClass: 'painT' } })])
    const el = render(<SpecView spec={s} timeSec={0} />).container.querySelector('#lc') as HTMLElement
    expect(el.className).toContain('clip')
    expect(el.className).toContain('painT')
  })

  it('video 图层本期不渲染内容（④ 预留）→ Task 8 再开', () => {
    const s = spec([layer({ id: 'lv', kind: 'video', content: { kind: 'video', src: 'a.mp4', muted: true } })])
    expect(() => render(<SpecView spec={s} timeSec={0} />)).not.toThrow()
  })
})

describe('时长契约', () => {
  it('秒转帧按 30fps', () => {
    expect(FPS).toBe(30)
    expect(secToFrames(12)).toBe(360)
    expect(secToFrames(6.2207)).toBe(187)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `export NVM_DIR="$HOME/.nvm" && source "$NVM_DIR/nvm.sh" && nvm use 22.23.2 && npx pnpm --filter @forgecast/compositions test contract`
Expected: FAIL —— `SpecView` 不存在

- [ ] **Step 3: 实现 LayerView.tsx**

```tsx
// packages/compositions/src/LayerView.tsx
import React from 'react'
import { styleAt } from './effects'
import { ImageContent } from './Image'
import { TextContent } from './Text'
import type { Layer, LayerStyle } from './videospec-types'

/** LayerStyle 通用几何/视觉属性 → 内联样式（迁自 render-html.ts styleAttr）。 */
function geom(style: LayerStyle): React.CSSProperties {
  const s: React.CSSProperties = {}
  if (style.x !== undefined) s.left = style.x
  if (style.y !== undefined) s.top = style.y
  if (style.width !== undefined) s.width = style.width
  if (style.height !== undefined) s.height = style.height
  if (style.color) s.color = style.color
  if (style.bg) s.background = style.bg
  if (style.opacity !== undefined) s.opacity = style.opacity
  if (style.align) s.textAlign = style.align
  if (style.fontSize !== undefined) s.fontSize = style.fontSize
  return s
}

/** 单图层。只读 layer.start/duration/track，不计算它们。 */
export function LayerView(
  { layer, timeSec, elemIndexBase }: { layer: Layer; timeSec: number; elemIndexBase: number },
): React.ReactElement {
  const clipFx = styleAt(layer.effects, layer.start, layer.duration, timeSec, null)
  const base = geom(layer.style)
  const style: React.CSSProperties = {
    ...base,
    zIndex: layer.track,
    opacity: (base.opacity as number ?? 1) * clipFx.opacity,
    transform: `translateY(${clipFx.y}px) scale(${clipFx.scale})`,
  }
  const cls = ['clip', layer.style.cssClass].filter(Boolean).join(' ')
  let inner: React.ReactNode = null
  switch (layer.content.kind) {
    case 'text':
    case 'caption':
      inner = <TextContent layer={layer} text={layer.content.text} timeSec={timeSec} elemIndexBase={elemIndexBase} />
      break
    case 'image':
      inner = <ImageContent src={layer.content.src} cssClass={layer.style.cssClass} />
      break
    case 'shape':
      inner = <div className={`shape shape-${layer.content.shape}`} />
      break
    case 'video':
      inner = null   // Task 8 开启
      break
  }
  return <div id={layer.id} className={cls} style={style}>{inner}</div>
}
```

- [ ] **Step 4: 实现 SpecView.tsx**

```tsx
// packages/compositions/src/SpecView.tsx
import React from 'react'
import { LayerView } from './LayerView'
import { twCountOf } from './Text'
import type { VideoSpec } from './videospec-types'

/**
 * 纯展示：给定 spec 与时刻，渲出该时刻应该看到的全部图层。**不碰任何 Remotion hook**——
 * 内容断言门禁直接打这一层，用普通 React 测试即可，不必起 Remotion 运行时。
 *
 * 可见性判断只在这里做一次（`SpecComposition` 不再包 <Sequence>），避免两处判断不一致。
 * `.tw` 全局序号按 spec.layers 顺序、层内按行号累加，复现原 DECODE_RUNTIME 的
 * `document.querySelectorAll('.tw')` 文档顺序——序号错了鬼影字符就变了。
 */
export function SpecView({ spec, timeSec }: { spec: VideoSpec; timeSec: number }): React.ReactElement {
  let twBase = 0
  const nodes: React.ReactElement[] = []
  for (const layer of spec.layers) {
    const base = twBase
    if (layer.content.kind === 'text' || layer.content.kind === 'caption') {
      twBase += twCountOf(layer, layer.content.text)
    }
    const visible = timeSec >= layer.start && timeSec < layer.start + layer.duration
    if (!visible) continue
    nodes.push(<LayerView key={layer.id} layer={layer} timeSec={timeSec} elemIndexBase={base} />)
  }
  return <div className="specRoot" style={{ position: 'absolute', inset: 0 }}>{nodes}</div>
}
```

**注意 `twBase` 在 `continue` 之前累加**：全局序号必须按 spec 里**所有**解码行计数，不能只数当前可见的——否则同一图层的鬼影字符会随时间变化。

- [ ] **Step 5: 实现 SpecComposition.tsx 与 Root.tsx**

```tsx
// packages/compositions/src/SpecComposition.tsx
import React from 'react'
import { useCurrentFrame, useVideoConfig } from 'remotion'
import { SpecView } from './SpecView'
import type { VideoSpec } from './videospec-types'

/** 薄包装：唯一职责是把 Remotion 的帧换算成秒。视觉逻辑全在 SpecView 里（便于纯测）。 */
export function SpecComposition({ spec }: { spec: VideoSpec }): React.ReactElement {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  return <SpecView spec={spec} timeSec={frame / fps} />
}
```

```tsx
// packages/compositions/src/Root.tsx
import React from 'react'
import { Composition } from 'remotion'
import { SpecComposition } from './SpecComposition'
import { FPS, secToFrames } from './time'
import type { VideoSpec } from './videospec-types'

const EMPTY: VideoSpec = {
  version: 1, videoId: '', slug: '', template: 'flash', createdAt: '',
  semantic: { hook: null, sourceAssetId: null, sections: [] },
  canvas: { width: 1080, height: 1920 }, durationSec: 12, layers: [],
  audio: { narration: null, bgm: null, beatGrid: null, captionsEnabled: false }, warnings: [],
}

/** 单一 composition，宽高/时长全部由 inputProps 里的 spec 决定（calculateMetadata）。
 *  故 portrait/landscape 共用一个组件，不做 10 个变体。 */
export const RemotionRoot: React.FC = () => (
  <Composition
    id="spec"
    component={SpecComposition as never}
    durationInFrames={secToFrames(EMPTY.durationSec)}
    fps={FPS}
    width={EMPTY.canvas.width}
    height={EMPTY.canvas.height}
    defaultProps={{ spec: EMPTY }}
    calculateMetadata={({ props }) => ({
      durationInFrames: secToFrames((props as { spec: VideoSpec }).spec.durationSec),
      width: (props as { spec: VideoSpec }).spec.canvas.width,
      height: (props as { spec: VideoSpec }).spec.canvas.height,
      fps: FPS,
    })}
  />
)
```

`src/index.ts` 导出 `SpecView` / `SpecComposition` / `RemotionRoot` / `FPS` / `secToFrames`。

- [ ] **Step 6: 跑测试确认通过**

Run: 同 Step 2
Expected: PASS（6 tests）

- [ ] **Step 7: 提交**

```bash
git add packages/compositions/src packages/compositions/test/contract.test.tsx
git commit -m "feat(compositions): 图层遍历与 Remotion 接线，纯展示层与帧换算分离"
```

---

### Task 6: 样式搬运 —— 五模板 CSS + 科技背景 + 相机层

**Files:**
- Create: `packages/compositions/src/styles/base.css`、`styles/{flash,story,demo,insight,changelog}.css`、`src/Background.tsx`
- Modify: `packages/compositions/src/SpecView.tsx`（挂背景与相机层）
- Test: `packages/compositions/test/background.test.tsx`

**Interfaces:**
- Produces: `<Background variant timeSec durationSec />`、`<Camera timeSec durationSec>{children}</Camera>`

**来源对照（照搬，不重新设计）：**

| 目标文件 | 来源 |
|---|---|
| `styles/base.css` | `packages/studio/src/hyperframes.ts` 的 `FX_CSS` 常量（约 4KB：相机层 `#cam`、5 套背景变体、解码 `.tw/.twc/.gh/.fin`） |
| `styles/flash.css` | `templates/hf/flash.html` 的 `<style>`（类：`brand cap center cta fill flowCap highlightCard painT sell`） |
| `styles/story.css` | `templates/hf/story.html`（`brand bubble cap center chat cta fill me sell sellFill them`） |
| `styles/demo.css` | `templates/hf/demo.html`（`brand cap center cta fill hookT pain painWrap phone phoneWrap price wideBg wideFg wideWrap`） |
| `styles/insight.css` | `templates/hf/insight.html`（`brand cap card center cta fill painT`） |
| `styles/changelog.css` | `templates/hf/changelog.html`（`brand cap center fill label sub tag title`） |
| `Background.tsx` | `hyperframes.ts` 的 `buildTechBg`（189 行，5 变体：grid / aurora / matrix / synth / mesh） |
| `Camera` | `hyperframes.ts` 的 `buildCameraKeyframes` |

**landscape 不另建文件**：原 `*-landscape.html` 与竖版差异只在尺寸相关的 CSS。用 `useVideoConfig()` 的宽高或 CSS 容器查询自适应；若某条规则确实需要按比例分叉，在同一个 css 文件里用 `@media (min-aspect-ratio: 1/1)` 区分。

**相机层参数（原样保留）：** `scale 1 → 1.06`、`x 0 → -14`、`y 0 → -8`，时长 `durationSec * 1.15`，缓动 `sine.inOut`。**×1.15 是刻意的**——曲线若在片尾收住，最后约 0.9 秒会慢到停死被判静止帧（原注释）。

**背景动效改写要点：** 原实现是 GSAP 挂主时间线（`tl.fromTo("#techbg .mv",{y:0},{y:80,...ease:"none"})` 之类）。Remotion 侧改为按 `timeSec` 直接算，`ease:"none"` 对应线性插值。

- [ ] **Step 1: 写失败测试**

```tsx
// packages/compositions/test/background.test.tsx
import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { Background, Camera } from '../src/Background'

describe('Background', () => {
  it.each(['grid', 'aurora', 'matrix', 'synth', 'mesh'])('变体 %s 渲出 #techbg', (v) => {
    const { container } = render(<Background variant={v} timeSec={1} durationSec={12} />)
    expect(container.querySelector('#techbg')).not.toBeNull()
  })

  it('变体缺省/none 时不渲背景（story 聊天场不加科技背景）', () => {
    const { container } = render(<Background variant={undefined} timeSec={1} durationSec={12} />)
    expect(container.querySelector('#techbg')).toBeNull()
  })

  it('背景随时间推进（不是静止帧）', () => {
    const at = (t: number) => (render(<Background variant="matrix" timeSec={t} durationSec={12} />)
      .container.querySelector('#techbg .mv') as HTMLElement).style.transform
    expect(at(0)).not.toBe(at(6))
  })
})

describe('Camera', () => {
  it('全片缓慢推移：起点 scale 1，中途已放大', () => {
    const at = (t: number) => (render(<Camera timeSec={t} durationSec={12}><i /></Camera>)
      .container.querySelector('#cam') as HTMLElement).style.transform
    expect(at(0)).toContain('scale(1)')
    expect(at(6)).not.toContain('scale(1)')
  })

  it('末键落在片长之外（×1.15），故片尾仍在移动', () => {
    const at = (t: number) => (render(<Camera timeSec={t} durationSec={12}><i /></Camera>)
      .container.querySelector('#cam') as HTMLElement).style.transform
    expect(at(11.0)).not.toBe(at(12.0))
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `export NVM_DIR="$HOME/.nvm" && source "$NVM_DIR/nvm.sh" && nvm use 22.23.2 && npx pnpm --filter @forgecast/compositions test background`
Expected: FAIL —— `Background` 不存在

- [ ] **Step 3: 搬 CSS**

逐个把上表来源里的 `<style>` 内容复制到对应 `.css` 文件。**只做机械搬运**：不改数值、不合并规则、不"顺手优化"。`#root` 相关的 HyperFrames 专属选择器（`.clip` 的显隐由框架控制那部分）去掉——Remotion 下可见性由 `SpecView` 决定。

搬完在 `src/index.ts` 顶部 `import './styles/base.css'` 及五个模板 css（Remotion 的 webpack 配置默认支持 css 导入）。

- [ ] **Step 4: 实现 Background.tsx**

```tsx
// packages/compositions/src/Background.tsx
import React from 'react'

const lerp = (a: number, b: number, p: number) => a + (b - a) * p
const clamp01 = (v: number) => Math.min(1, Math.max(0, v))
/** GSAP sine.inOut 对应曲线 */
const sineInOut = (p: number) => -(Math.cos(Math.PI * p) - 1) / 2

/**
 * 全程相机层。参数原样迁自 hyperframes.ts buildCameraKeyframes：
 * scale 1→1.06、x 0→-14、y 0→-8，时长 durationSec*1.15。
 * ×1.15 是刻意的：曲线若在片尾收住，最后约 0.9 秒会慢到停死并被判静止帧。
 */
export function Camera(
  { timeSec, durationSec, children }: { timeSec: number; durationSec: number; children: React.ReactNode },
): React.ReactElement {
  const p = sineInOut(clamp01(timeSec / (durationSec * 1.15)))
  const style: React.CSSProperties = {
    position: 'absolute', inset: 0, transformOrigin: '50% 50%',
    transform: `scale(${lerp(1, 1.06, p)}) translate(${lerp(0, -14, p)}px, ${lerp(0, -8, p)}px)`,
  }
  return <div id="cam" style={style}>{children}</div>
}

/**
 * 科技背景 5 变体。DOM 结构与类名迁自 hyperframes.ts buildTechBg，动效由 GSAP 挂主时间线
 * 改为按 timeSec 直接算（原 ease:"none" → 线性）。variant 省略或 'none' 时不渲染
 * （story 聊天场不加背景，保微信截图真实感）。
 */
export function Background(
  { variant, timeSec, durationSec }: { variant: string | undefined; timeSec: number; durationSec: number },
): React.ReactElement | null {
  if (!variant || variant === 'none') return null
  const p = clamp01(durationSec > 0 ? timeSec / durationSec : 0)
  return (
    <div id="techbg" className={`bg-${variant}`}>
      <div className="mv" style={{ transform: `translateY(${lerp(0, 80, p)}px)` }} />
      <div className="sweep" style={{ transform: `translateX(${lerp(0, 320, p)}%)` }} />
    </div>
  )
}
```

**实现者注意**：上面的 `mv`/`sweep` 是 `buildTechBg` 里 grid/matrix 变体用到的元素。逐个变体核对 `buildTechBg` 的真实 DOM 与动效行，缺什么补什么——五个变体的内部结构不完全相同，不要假设都一样。

- [ ] **Step 5: SpecView 挂上背景与相机**

`SpecView` 增加可选 prop `bgVariant?: string`，渲染结构改为：

```tsx
return (
  <div className="specRoot" style={{ position: 'absolute', inset: 0 }}>
    <Background variant={bgVariant} timeSec={timeSec} durationSec={spec.durationSec} />
    <Camera timeSec={timeSec} durationSec={spec.durationSec}>{nodes}</Camera>
  </div>
)
```

`SpecComposition` 从 `spec.template` 推出背景变体（沿用现有规则：story 不加背景，其余走配置/随机——查 `generate.ts` 的 `resolveTechBg` 调用点确认当前取值来源，把该取值写进 spec 或作为 inputProps 传入，**不要在组件里随机**，否则每帧结果不同、渲染必然闪烁）。

- [ ] **Step 6: 跑测试确认通过**

Run: 同 Step 2
Expected: PASS（8 tests）

- [ ] **Step 7: 提交**

```bash
git add packages/compositions/src/styles packages/compositions/src/Background.tsx packages/compositions/src/SpecView.tsx packages/compositions/test/background.test.tsx
git commit -m "feat(compositions): 搬运五模板 CSS、科技背景与相机层"
```

---

### Task 7: 内容断言门禁（主闸）+ 变异实验

**Files:**
- Create: `packages/compositions/test/content.test.tsx`、`packages/compositions/test/fixtures/specs.ts`
- Test: 同上

**Interfaces:**
- Consumes: `SpecView`（Task 5）

**背景（本任务是全计划最重要的一环，实现者必读）：**

子项目①的等价门禁只比对 clip 的 `id/start/duration/track/twCount/accentCount`，**看不见 cssClass、文本内容、src、DOM 嵌套**。结果是 6 个内容回归里 **5 个**从它眼皮底下溜过去，全部靠人工与评审发现：解码动效整体丢失、品牌名跨五模板丢失、字幕类丢失、图片路径编码丢失、编码函数选错。

②的产物**不可能与 HyperFrames 逐像素相同**（不同渲染器、不同字体光栅化），所以像素/SSIM 比对既脆弱又会给假绿——①里已有一次「相邻帧不相同」的空洞判据在坏产物上照样通过的先例。

因此本门禁**从第一天就断言内容**：在若干时刻渲染 `SpecView`，断言该出现的文本、类名、图片路径确实在 DOM 里。

**fixture 来源**：直接取 `packages/studio/test/equivalence.test.ts` 里那 7 组 fixture 的构造方式（flash / story / changelog / demo / demoCarousel / demoPlan / insight），跑一遍 `lower()` 得到真实 `VideoSpec` 并固化成 JSON 存进 `test/fixtures/`。**这样 ①②两个门禁盯的是同一批输入**，②的断言与①的时间轴基线可以互相印证。

- [ ] **Step 1: 生成 fixture**

写一次性脚本，用 `@forgecast/studio` 的 `buildSemantic` + `lower` 对 7 组输入生成 spec，落到 `packages/compositions/test/fixtures/*.json`。脚本可留在 `packages/compositions/test/fixtures/generate.ts` 并在注释里写明重生成方式。

- [ ] **Step 2: 写内容断言测试**

```tsx
// packages/compositions/test/content.test.tsx
import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { SpecView } from '../src/SpecView'
import type { VideoSpec } from '../src/videospec-types'
import flash from './fixtures/flash.json'
import story from './fixtures/story.json'
import changelog from './fixtures/changelog.json'
import demo from './fixtures/demo.json'
import demoCarousel from './fixtures/demoCarousel.json'
import demoPlan from './fixtures/demoPlan.json'
import insight from './fixtures/insight.json'

const FIXTURES: Array<[string, VideoSpec]> = [
  ['flash', flash as VideoSpec], ['story', story as VideoSpec], ['changelog', changelog as VideoSpec],
  ['demo', demo as VideoSpec], ['demoCarousel', demoCarousel as VideoSpec],
  ['demoPlan', demoPlan as VideoSpec], ['insight', insight as VideoSpec],
]

/** 图层中点时刻——保证该图层一定可见，且避开入场动画的极端帧。 */
const mid = (l: VideoSpec['layers'][number]) => l.start + l.duration / 2

describe.each(FIXTURES)('%s 内容断言', (_name, spec) => {
  it('每个图层在其中点时刻都出现在 DOM 中', () => {
    for (const layer of spec.layers) {
      const { container } = render(<SpecView spec={spec} timeSec={mid(layer)} />)
      expect(container.querySelector(`#${CSS.escape(layer.id)}`), `图层 ${layer.id} 未渲出`).not.toBeNull()
    }
  })

  it('文本图层的文字内容确实上屏（逐字解码后仍可读）', () => {
    for (const layer of spec.layers) {
      if (layer.content.kind !== 'text' && layer.content.kind !== 'caption') continue
      const text = layer.content.text.replace(/\s+/g, '')
      if (!text) continue
      // 取足够晚的时刻，保证解码已锁定（最后一个字 t0 + 0.225s 之后）
      const t = Math.min(layer.start + layer.duration - 0.01, layer.start + 1.5)
      const { container } = render(<SpecView spec={spec} timeSec={t} />)
      const el = container.querySelector(`#${CSS.escape(layer.id)}`) as HTMLElement
      const got = (el?.textContent ?? '').replace(/\s+/g, '')
      expect(got, `图层 ${layer.id} 文字丢失`).toContain(text.slice(0, Math.min(6, text.length)))
    }
  })

  it('cssClass 全部保留（.cap/.painT/.cta 这类类名丢失过一次）', () => {
    for (const layer of spec.layers) {
      if (!layer.style.cssClass) continue
      const { container } = render(<SpecView spec={spec} timeSec={mid(layer)} />)
      const el = container.querySelector(`#${CSS.escape(layer.id)}`) as HTMLElement
      expect(el?.className, `图层 ${layer.id} 丢了 cssClass`).toContain(layer.style.cssClass)
    }
  })

  it('图片图层的 src 出现且已编码', () => {
    for (const layer of spec.layers) {
      if (layer.content.kind !== 'image') continue
      const { container } = render(<SpecView spec={spec} timeSec={mid(layer)} />)
      const el = container.querySelector(`#${CSS.escape(layer.id)} img`) as HTMLImageElement
      expect(el, `图层 ${layer.id} 未渲出 img`).not.toBeNull()
      expect(el.getAttribute('src')).not.toContain(' ')   // 空格必须已编码
    }
  })

  it('品牌名上屏（跨五模板丢失过，修了四轮）', () => {
    const brandLayers = spec.layers.filter(
      (l) => (l.content.kind === 'text' || l.content.kind === 'caption') && l.content.text.includes('@'),
    )
    if (brandLayers.length === 0) return
    for (const layer of brandLayers) {
      const { container } = render(<SpecView spec={spec} timeSec={layer.start + layer.duration - 0.01} />)
      expect(container.textContent, `图层 ${layer.id} 品牌行丢失`).toContain('@')
    }
  })
})
```

- [ ] **Step 3: 跑测试确认通过**

Run: `export NVM_DIR="$HOME/.nvm" && source "$NVM_DIR/nvm.sh" && nvm use 22.23.2 && npx pnpm --filter @forgecast/compositions test content`
Expected: PASS

- [ ] **Step 4: 变异实验 —— 证明门禁会失败**

**这一步不可跳过。** ①里做过两次变异实验，分别抓出「门禁恒真」与「测试写松」两类问题；一个不会失败的门禁比没有门禁更危险，因为它给人虚假的安全感。

逐项做，每项做完立即还原并用 `git diff` 确认工作区干净：

1. 在 `LayerView.tsx` 里把 `cssClass` 从 className 拼接中去掉 → 跑测试 → **必须**看到「丢了 cssClass」失败 → 还原
2. 在 `Image.tsx` 里把 `encodePathForUrl` 换成原样返回 → 跑测试 → **必须**看到 src 断言失败 → 还原
3. 在 `SpecView.tsx` 里跳过某一类图层（如 `caption`）→ 跑测试 → **必须**看到「图层未渲出」失败 → 还原

把三次实验的结果写进本任务的报告。若某项变异**没有**让测试变红，说明该条断言是空的，必须先修断言再继续。

- [ ] **Step 5: 提交**

```bash
git add packages/compositions/test
git commit -m "test(compositions): 内容断言门禁 + 变异实验证明其非空转"
```

---

### Task 8: video 图层 —— 合成能力留缝

**Files:**
- Modify: `packages/compositions/src/LayerView.tsx`
- Test: `packages/compositions/test/video-layer.test.tsx`

**Interfaces:**
- Consumes: `LayerView`（Task 5）

**范围（严格遵守）：** `LayerContent` **已有** `video` 类型（`{ kind: 'video'; src: string; muted: boolean }`，`videospec.ts` 里标注「④ 预留」）。本任务只让它**真能渲**并证明「文字图层可以叠在视频图层之上」，**不建任何口播/数字人/绿幕功能，不改 `lower.ts` 去产出 video 图层**（那需要素材上传流程，属④）。

**不新增字段**：spec 设计稿里提过 `trimStart/trimEnd/volume`，但当前类型只有 `muted`，且本期没有消费方。按已有形状实现，多余字段留给④按真实需求再加。

- [ ] **Step 1: 写失败测试**

```tsx
// packages/compositions/test/video-layer.test.tsx
import { describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'
import { SpecView } from '../src/SpecView'
import type { Layer, VideoSpec } from '../src/videospec-types'

vi.mock('remotion', () => ({
  Video: (p: Record<string, unknown>) => <video data-testid="rv" src={p.src as string} muted={p.muted as boolean} />,
  useCurrentFrame: () => 0,
  useVideoConfig: () => ({ fps: 30, width: 1080, height: 1920, durationInFrames: 360 }),
}))

const spec = (layers: Layer[]): VideoSpec => ({
  version: 1, videoId: 'v', slug: 's', template: 'flash', createdAt: '',
  semantic: { hook: null, sourceAssetId: null, sections: [] },
  canvas: { width: 1080, height: 1920 }, durationSec: 10, layers,
  audio: { narration: null, bgm: null, beatGrid: null, captionsEnabled: false }, warnings: [],
})

describe('video 图层', () => {
  it('渲出 Remotion <Video> 并透传 src / muted', () => {
    const { getByTestId } = render(<SpecView spec={spec([{
      id: 'bg', kind: 'video', from: null, overridden: false, start: 0, duration: 10, track: 0,
      content: { kind: 'video', src: 'clip.mp4', muted: true }, style: {}, effects: [],
    }])} timeSec={1} />)
    const v = getByTestId('rv') as HTMLVideoElement
    expect(v.getAttribute('src')).toBe('clip.mp4')
    expect(v.muted).toBe(true)
  })

  it('文字图层能叠在视频图层之上（合成能力成立）', () => {
    const { container } = render(<SpecView spec={spec([
      { id: 'bg', kind: 'video', from: null, overridden: false, start: 0, duration: 10, track: 0,
        content: { kind: 'video', src: 'clip.mp4', muted: true }, style: {}, effects: [] },
      { id: 'title', kind: 'text', from: null, overridden: false, start: 0, duration: 10, track: 5,
        content: { kind: 'text', text: '动态标题' }, style: {}, effects: [] },
    ])} timeSec={1} />)
    const bg = container.querySelector('#bg') as HTMLElement
    const title = container.querySelector('#title') as HTMLElement
    expect(title.textContent).toContain('动态标题')
    expect(Number(title.style.zIndex)).toBeGreaterThan(Number(bg.style.zIndex))
  })

  it('视频路径同样逐段编码', () => {
    const { getByTestId } = render(<SpecView spec={spec([{
      id: 'bg', kind: 'video', from: null, overridden: false, start: 0, duration: 10, track: 0,
      content: { kind: 'video', src: 'my clip#1.mp4', muted: false }, style: {}, effects: [],
    }])} timeSec={1} />)
    expect((getByTestId('rv') as HTMLVideoElement).getAttribute('src')).toBe('my%20clip%231.mp4')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `export NVM_DIR="$HOME/.nvm" && source "$NVM_DIR/nvm.sh" && nvm use 22.23.2 && npx pnpm --filter @forgecast/compositions test video-layer`
Expected: FAIL —— 当前 `video` 分支返回 null

- [ ] **Step 3: 实现**

在 `LayerView.tsx` 顶部 `import { Video } from 'remotion'` 与 `import { encodePathForUrl } from './Image'`，把 `case 'video'` 改为：

```tsx
    case 'video':
      inner = <Video src={encodePathForUrl(layer.content.src)} muted={layer.content.muted} />
      break
```

- [ ] **Step 4: 跑测试确认通过**

Run: 同 Step 2
Expected: PASS（3 tests）

- [ ] **Step 5: 提交**

```bash
git add packages/compositions/src/LayerView.tsx packages/compositions/test/video-layer.test.tsx
git commit -m "feat(compositions): video 图层可渲，打通图层叠加视频的合成能力"
```

---

### Task 9: studio 侧 Remotion 渲染路径 + generate 接线

**Files:**
- Create: `packages/studio/src/remotion-render.ts`
- Modify: `packages/studio/src/generate.ts`（`renderAndRegister` 附近，现调用 `renderHyperframes` 处）、`packages/studio/package.json`
- Test: `packages/studio/test/remotion-render.test.ts`

**Interfaces:**
- Consumes: `@forgecast/compositions` 的 `RemotionRoot`
- Produces: `export async function renderRemotion(spec: VideoSpec, outAbs: string, opts: { mode: 'render' | 'stub'; publicDir: string; onProgress?: (m: string) => void; timeoutMs?: number }): Promise<void>`

**必须保留的既有行为（不得改动）：**
- `mode === 'stub'` 时不真渲（测试走这条路，不能 spawn 浏览器）
- 渲染后的 `mixAudio`（BGM/强拍音效 ffmpeg 后混）与其三级 fail-soft 保持不变
- `runKokoroTts` 继续用 `hyperframes tts`，与渲染解耦
- 超时可配（现有 `FORGECAST_RENDER_TIMEOUT_MS`）

**历史踩坑（来自已删除的旧 Remotion 实现，`git show 1431fb9^:packages/studio/src/render.ts` 可查）：**
- `bundle()` 接受 `publicDir`，`renderMedia()` **不接受**——静态资源（截图、字体、旁白 wav）必须通过 `bundle({ publicDir })` 暴露，组件内用相对路径引用
- 组件里的媒体路径需经 Remotion 的 `staticFile()` 解析

**bundle 缓存（性能要求）：** 每条视频都跑一次 `bundle()` 会显著拖慢。按「compositions 包内容指纹 + publicDir」缓存 bundle 目录，仅在指纹变化时重建。指纹用 `packages/compositions/src` 下所有文件的 mtime+size 即可，不必读内容。

- [ ] **Step 1: 写失败测试**

```ts
// packages/studio/test/remotion-render.test.ts
import { describe, expect, it } from 'vitest'
import { mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { renderRemotion } from '../src/remotion-render'
import type { VideoSpec } from '../src/videospec'

const spec: VideoSpec = {
  version: 1, videoId: 'v1', slug: 's', template: 'flash', createdAt: '',
  semantic: { hook: null, sourceAssetId: null, sections: [] },
  canvas: { width: 1080, height: 1920 }, durationSec: 12,
  layers: [{
    id: 'l1', kind: 'text', from: null, overridden: false, start: 0, duration: 3, track: 1,
    content: { kind: 'text', text: 'hi' }, style: {}, effects: [],
  }],
  audio: { narration: null, bgm: null, beatGrid: null, captionsEnabled: false }, warnings: [],
}

describe('renderRemotion', () => {
  it('stub 模式产出占位文件且不起浏览器', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rr-'))
    const out = join(dir, 'out.mp4')
    await renderRemotion(spec, out, { mode: 'stub', publicDir: dir })
    expect(existsSync(out)).toBe(true)
  })

  it('stub 模式不因缺少浏览器/资源而抛错', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rr-'))
    await expect(
      renderRemotion(spec, join(dir, 'o.mp4'), { mode: 'stub', publicDir: dir }),
    ).resolves.not.toThrow()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `export NVM_DIR="$HOME/.nvm" && source "$NVM_DIR/nvm.sh" && nvm use 22.23.2 && npx pnpm --filter @forgecast/studio test remotion-render`
Expected: FAIL —— 模块不存在

- [ ] **Step 3: 加依赖**

`packages/studio/package.json` 的 dependencies 增加：

```json
"@forgecast/compositions": "workspace:*",
"@remotion/bundler": "4.0.519",
"@remotion/renderer": "4.0.519"
```

- [ ] **Step 4: 实现 remotion-render.ts**

要点（实现者按此写）：

```ts
// packages/studio/src/remotion-render.ts
import { bundle } from '@remotion/bundler'
import { renderMedia, selectComposition } from '@remotion/renderer'
import type { VideoSpec } from './videospec'

let cached: { fingerprint: string; serveUrl: string } | null = null

/** compositions 包源码指纹（mtime+size），变了才重建 bundle——每条视频都 bundle 会显著拖慢。 */
function fingerprintCompositions(): string { /* 遍历 packages/compositions/src 拼 mtimeMs+size */ }

export async function renderRemotion(
  spec: VideoSpec, outAbs: string,
  opts: { mode: 'render' | 'stub'; publicDir: string; onProgress?: (m: string) => void; timeoutMs?: number },
): Promise<void> {
  if (opts.mode === 'stub') { /* 写占位文件后 return，绝不 bundle/起浏览器 */ }
  const fp = fingerprintCompositions()
  if (!cached || cached.fingerprint !== fp) {
    // publicDir 只有 bundle 接受，renderMedia 不接受——静态资源全靠这里暴露
    cached = { fingerprint: fp, serveUrl: await bundle({ entryPoint: /* compositions Root 入口 */, publicDir: opts.publicDir }) }
  }
  const composition = await selectComposition({ serveUrl: cached.serveUrl, id: 'spec', inputProps: { spec } })
  await renderMedia({
    composition, serveUrl: cached.serveUrl, codec: 'h264', outputLocation: outAbs, inputProps: { spec },
    onProgress: ({ progress }) => opts.onProgress?.(`渲染 ${Math.round(progress * 100)}%`),
  })
}
```

- [ ] **Step 5: 接线 generate.ts**

在 `renderAndRegister` 里，五个固定模板（flash/story/demo/insight/changelog）的渲染调用从 `renderHyperframes(hfDir, outAbs, mode, { onProgress })` 改为 `renderRemotion(spec, outAbs, { mode, publicDir, onProgress })`。

**保持不变**：`renderCustomTemplate` 分支继续走 `renderHyperframes`（自定义模板本期不迁）；`mixAudio` 调用与其 fail-soft 逻辑原样保留；warnings 落库不变。

- [ ] **Step 6: 跑全仓测试确认通过**

Run: `export NVM_DIR="$HOME/.nvm" && source "$NVM_DIR/nvm.sh" && nvm use 22.23.2 && npx pnpm test`
Expected: 全绿。**①的 `equivalence.test.ts` 必须仍然绿**——它守的是 `lower()`，本任务不应动到它。若它红了，说明改到了共享层，回去查而不是改基线。

- [ ] **Step 7: 提交**

```bash
git add packages/studio pnpm-lock.yaml
git commit -m "feat(studio): 五模板改走 Remotion 渲染，bundle 结果按源码指纹缓存"
```

---

### Task 10: 预览改 @remotion/player + 真渲验收 + 文档

**Files:**
- Modify: `apps/web/src/pages/workshop/PreviewTab.tsx`、`apps/web/package.json`、`README.md`、`docs/hyperframes-deploy.md`
- Test: 无自动化测试（`apps/web` 按项目约定人工验收）

**Interfaces:**
- Consumes: `@forgecast/compositions` 的 `SpecComposition`

**要替换的现有机制：** 当前 `PreviewTab.tsx` 把合成 HTML 塞进 iframe（`/files/<slug>/hf/<videoId>/index.html`），父页面直接驱动其中暂停的 GSAP 主时间线（`window.__timelines`）。这套是 HyperFrames 独有的，Remotion 下不存在，整块替换为 `<Player>`。

**必须保留的行为：**
- 取**最新**一条 `type==='video'` 且 `spec_path` 非空的素材。API（`packages/server/src/app.ts:231`）返回 `ORDER BY id DESC`，即**新的在前**，所以是 `assets.find(...)` 而**不是** `[...assets].reverse().find(...)`——后者取到最旧一条，是①里修过的 bug，不要退回去。
- `spec_path` 为 NULL 的历史素材（改造前生成的）沿用现有「没读到合成时间线」空状态，不崩不白屏。
- 宽高比由 spec 的 `canvas` 决定，默认 9:16。硬编码 16:9 会把竖屏产物裁掉大半，而「有画面/能播/拖动跟手」在裁切后的产物上照样全过——这个坑踩过。

- [ ] **Step 1: 加依赖并改写 PreviewTab**

`apps/web/package.json` 增加 `"@forgecast/compositions": "workspace:*"` 与 `"@remotion/player": "4.0.519"`。

`PreviewTab.tsx` 改为：拉取 `/files/<slug>/specs/<videoId>.json` 得到 spec，渲染

```tsx
<Player
  component={SpecComposition}
  inputProps={{ spec }}
  durationInFrames={Math.round(spec.durationSec * 30)}
  fps={30}
  compositionWidth={spec.canvas.width}
  compositionHeight={spec.canvas.height}
  style={{ width: '100%' }}
  controls
/>
```

- [ ] **Step 2: 构建检查**

Run: `export NVM_DIR="$HOME/.nvm" && source "$NVM_DIR/nvm.sh" && nvm use 22.23.2 && npx pnpm --filter web exec tsc --noEmit && npx pnpm --filter web build`
Expected: 通过。**若报出 `better-sqlite3` 之类 Node 模块无法打包，说明 compositions 包混入了值导入**——回到 Task 1 的守卫测试查。

- [ ] **Step 3: 浏览器人工验收**

用**自己的端口**起服务（如 4322/5174），**绝不碰用户的 5173/4321**，结束后只关自己启动的 PID。确认：预览加载、播放、拖动时间轴均正常；无 spec 的老项目显示空状态而非白屏。

- [ ] **Step 4: 真渲验收（五模板各一条）**

对 flash/story/demo/insight/changelog 各真渲一条，逐条验：

```bash
ffprobe -v error -select_streams v:0 -show_entries stream=width,height,r_frame_rate -of csv=p=0 <out.mp4>
ffmpeg -i <out.mp4> -af volumedetect -f null - 2>&1 | grep mean_volume
```

**验收判据（缺一不可）：**
- 分辨率 1080×1920、帧率 30
- `mean_volume` **不是** −91dB（那是静音特征；本项目因 `<audio>` 位置错误上线过静音视频，视频照常渲出、进度条走完、零报错）
- 抽帧目视：文字上屏、无泄漏的「（画面：…）」拍摄提示、CTA 有品牌名、画面未被裁切

**报告里必须区分「看着验的」与「推断的」**，并明确列出任何无法验证的项及原因。

- [ ] **Step 5: 更新文档**

- `README.md`：渲染引擎相关描述改为 Remotion（五模板）+ HyperFrames（自定义模板与 TTS）
- `docs/hyperframes-deploy.md`：标注 renderer 镜像在 Remotion 下**尚未验证**（Remotion 有自己的 Chromium 获取逻辑，与现在预装 Chromium + `HYPERFRAMES_BROWSER_PATH` 不同；上次构建该镜像踩过「chrome-headless-shell 无 Linux ARM64 官方构建」的坑）。**本期不要求 Docker 通过，但状态必须写清楚，不能让人以为它还能用。**

- [ ] **Step 6: 提交**

```bash
git add apps/web README.md docs/hyperframes-deploy.md pnpm-lock.yaml
git commit -m "feat(web): 预览改 @remotion/player 实时预览 + 文档同步"
```

---

## 计划自查

**1. Spec 覆盖**

| Spec 章节 | 对应任务 |
|---|---|
| §3 抽独立纯 React 包 | Task 1 |
| §3.1 类型归属与零 Node 依赖约束 | Task 1（守卫测试） |
| §4 VideoSpec → Remotion 映射 | Task 2/3/4/5 |
| §4 fps=30 显式 | Task 1（`FPS`）、Task 5（契约测试） |
| §4 逐字解码实现变化 | Task 3 |
| §5 音频与卡点不动 | Task 9（保留 mixAudio / TTS） |
| §6 预览 @remotion/player | Task 10 |
| §6 向后兼容（spec_path 为 NULL） | Task 10 |
| §7 合成能力留缝 | Task 8 |
| §8 三层门禁 | Task 7（第 1、2 层）、Task 10 Step 4（第 3 层） |
| §8 门禁变异实验 | Task 7 Step 4 |
| §8.1 保留 render-html.ts 与①门禁 | 全局约束 + Task 9 Step 6 |
| §9 bundle 缓存 | Task 9 |
| §9 Docker 状态标注 | Task 10 Step 5 |
| §9 字体 | Task 6（base.css 保留 `local()` 回落） |

**2. 占位符扫描**：无 TBD/TODO；每个代码步骤都给了可直接使用的代码。Task 9 Step 4 的 `fingerprintCompositions` 与 stub 分支给的是带明确要求的骨架而非完整实现——因为其内容取决于实现者选的遍历方式，但要求（指纹含 mtime+size、stub 绝不 bundle）已写死。

**3. 类型一致性**：`styleAt`（Task 2）→ `LayerView`/`Text` 调用一致；`charStateAt`/`decodeTargets`（Task 3）→ `Text.tsx` 一致；`twCountOf`（Task 3）→ `SpecView` 一致；`encodePathForUrl`（Task 4）→ `Image.tsx`/`LayerView`（Task 8）一致；`SpecView`（Task 5）→ Task 7/8 测试一致；`renderRemotion`（Task 9）→ `generate.ts` 一致。`FPS`/`secToFrames`（Task 1）贯穿 Task 5/9/10。

**4. 已修正的 spec 偏差**：spec §7 提议给 `video` 内容加 `trimStart/trimEnd/volume`，但 `videospec.ts` 里该类型**已存在**且形状是 `{ kind, src, muted }`。计划按已有形状实现（Task 8），不为没有消费方的功能提前加字段；多余字段留给④按真实需求再加。
