# 情绪匹配自动选曲 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按文案 hook 类型自动匹配情绪，从对应情绪子曲库随机选 BGM；保留 `--bgm`/`--mood` 手动覆盖与 `--no-bgm` 干净版。

**Architecture:** 三层——(1) 纯映射 `HOOK_MOOD` + `resolveMood`；(2) 选曲 `pickBgm`(加随机) + `pickMoodBgm`(情绪子目录→根回落)；(3) 优先级链纯函数 `chooseBgmPath`，`selectBgm` 调它。全程 fail-soft，随机用可注入 `rand` 保测试确定性。

**Tech Stack:** TypeScript + pnpm monorepo + vitest。改动集中在 `@forgecast/studio` + `@forgecast/core` config + `cli.ts` + `.gitignore` + `templates/bgm/README.md`。

## Global Constraints

- 情绪键（文件夹名，英文）：`pain→tense`、`sideline→upbeat`、`infogap→tech`、`story→warm`。未知 hook → `''`。
- `HOOKS = ['sideline','infogap','story','pain']`（`@forgecast/core` 已有）。
- 优先级链（高→低）：`--bgm=<名>` 指定曲 > `--mood=<键>` > hook 自动映射 > 情绪文件夹空则回落 `templates/bgm/` 根 > 根空 / `--no-bgm`(`bgm==='none'`) → 不加 BGM。
- 情绪文件夹内**随机**挑；随机走可注入 `rand: () => number`（默认 `Math.random`）。
- 向后兼容：`pickBgm` 不传 `rand` = 原字典序行为（SFX 等现有调用不受影响）。
- 中文注释、中文提交信息、严格 TDD、频繁提交。
- 音频/缓存不入库：`.gitignore` 用递归 glob 覆盖子文件夹。

---

### Task 1: 情绪映射 + 配置项（纯逻辑）

**Files:**
- Modify: `packages/core/src/config.ts`（`video` 加 `mood`）
- Modify: `packages/core/test/config.test.ts`（video 断言补 `mood`）
- Modify: `packages/studio/src/hyperframes.ts`（加 `HOOK_MOOD` + `resolveMood`）
- Modify: `packages/studio/test/hyperframes.test.ts`（`resolveMood` 测试）

**Interfaces:**
- Consumes: 无
- Produces:
  - `config.video.mood: string`（默认 `''`；`FORGECAST_MOOD` env）
  - `HOOK_MOOD: Record<string, string>`（`{ pain:'tense', sideline:'upbeat', infogap:'tech', story:'warm' }`）
  - `resolveMood(hook: string, override?: string): string`——`override || HOOK_MOOD[hook] || ''`

- [ ] **Step 1: 写 config 失败测试**

改 `packages/core/test/config.test.ts` 里 `video 默认 render，可设 stub` 用例的两条 `toEqual`（补 `mood: ''`）并加一条 env 用例：

```typescript
    expect(loadConfig('/tmp/x', {}).video).toEqual({ mode: 'render', bgm: '', beatPython: '', captions: true, bg: 'grid', mood: '' })
    expect(loadConfig('/tmp/x', { FORGECAST_VIDEO_MODE: 'stub' }).video).toEqual({ mode: 'stub', bgm: '', beatPython: '', captions: true, bg: 'grid', mood: '' })
    expect(loadConfig('/tmp/x', { FORGECAST_CAPTIONS: 'off' }).video.captions).toBe(false)
    expect(loadConfig('/tmp/x', { FORGECAST_BG: 'synth' }).video.bg).toBe('synth')
    expect(loadConfig('/tmp/x', { FORGECAST_MOOD: 'tense' }).video.mood).toBe('tense')
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @forgecast/core test config`
Expected: FAIL —— video 无 `mood` 字段。

- [ ] **Step 3: 实现 config.mood**

`packages/core/src/config.ts` 的 `ForgecastConfig.video` 类型加 `mood: string`：

```typescript
  video: { mode: VideoMode; bgm: string; beatPython: string; captions: boolean; bg: string; mood: string }
```

`loadConfig` 的 `video:` 块，在 `bg:` 那行之后加：

```typescript
      // 情绪键（tense/upbeat/tech/warm）：空=按 hook 自动映射；显式指定则覆盖
      mood: env.FORGECAST_MOOD || '',
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @forgecast/core test config`
Expected: PASS

- [ ] **Step 5: 写 resolveMood 失败测试**

追加到 `packages/studio/test/hyperframes.test.ts`（导入处补 `HOOK_MOOD, resolveMood`）：

```typescript
describe('resolveMood 情绪映射', () => {
  it('四 hook 映射到情绪键', () => {
    expect(resolveMood('pain')).toBe('tense')
    expect(resolveMood('sideline')).toBe('upbeat')
    expect(resolveMood('infogap')).toBe('tech')
    expect(resolveMood('story')).toBe('warm')
  })
  it('override 覆盖 hook 映射', () => {
    expect(resolveMood('pain', 'warm')).toBe('warm')
  })
  it('未知 hook 且无 override → 空串', () => {
    expect(resolveMood('nope')).toBe('')
    expect(resolveMood('')).toBe('')
  })
})
```

- [ ] **Step 6: 跑测试确认失败**

Run: `pnpm --filter @forgecast/studio test hyperframes`
Expected: FAIL —— `resolveMood` 未导出。

- [ ] **Step 7: 实现 HOOK_MOOD + resolveMood**

`packages/studio/src/hyperframes.ts`，加在 `pickBgm` 函数之前：

```typescript
/** hook 类型 → 情绪键（文件夹名）。hook 本身即内容的情绪策略角度。 */
export const HOOK_MOOD: Record<string, string> = { pain: 'tense', sideline: 'upbeat', infogap: 'tech', story: 'warm' }
/** 情绪键：显式 override 优先，否则按 hook 映射；都无则空串（走根目录回落）。 */
export function resolveMood(hook: string, override?: string): string {
  return override || HOOK_MOOD[hook] || ''
}
```

- [ ] **Step 8: 跑测试确认通过 + tsc**

Run: `pnpm --filter @forgecast/studio test hyperframes`、`npx tsc -p packages/studio/tsconfig.json --noEmit`、`npx tsc -p packages/core/tsconfig.json --noEmit`
Expected: 全绿、tsc 无输出。

- [ ] **Step 9: 提交**

```bash
git add packages/core packages/studio
git commit -m "feat(studio): 情绪映射 HOOK_MOOD/resolveMood + config video.mood"
```

---

### Task 2: 随机选曲 + 情绪子目录查找

**Files:**
- Modify: `packages/studio/src/hyperframes.ts`（`pickBgm` 加 `rand`；加 `pickMoodBgm`）
- Modify: `packages/studio/test/hyperframes.test.ts`（随机 + 子目录测试）

**Interfaces:**
- Consumes: 无（`pickBgm` 已存在）
- Produces:
  - `pickBgm(bgmDir: string, name?: string, rand?: () => number): string | null`——加可选 `rand`：无 `name` 且给 `rand` 时从音频列表随机；否则字典序第一个（向后兼容）。
  - `pickMoodBgm(bgmDir: string, mood: string, rand?: () => number): string | null`——`mood` 非空且 `bgmDir/mood/` 有曲 → 该子目录随机；否则 `bgmDir/` 根随机；都空 → `null`。

- [ ] **Step 1: 写 pickBgm 随机 + pickMoodBgm 失败测试**

追加到 `packages/studio/test/hyperframes.test.ts`（导入处补 `pickMoodBgm`）：

```typescript
describe('pickBgm 随机 + 向后兼容', () => {
  it('给 rand 从音频列表随机挑（注入 rand 断言命中项）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bgm-'))
    fs.writeFileSync(path.join(dir, 'a.mp3'), 'x'); fs.writeFileSync(path.join(dir, 'b.mp3'), 'x'); fs.writeFileSync(path.join(dir, 'c.mp3'), 'x')
    // 排序后 [a,b,c]；rand=0→a，rand≈0.99→c
    expect(pickBgm(dir, undefined, () => 0)).toBe(path.join(dir, 'a.mp3'))
    expect(pickBgm(dir, undefined, () => 0.99)).toBe(path.join(dir, 'c.mp3'))
  })
  it('不给 rand 仍字典序第一个（向后兼容）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bgm-'))
    fs.writeFileSync(path.join(dir, 'b.mp3'), 'x'); fs.writeFileSync(path.join(dir, 'a.mp3'), 'x')
    expect(pickBgm(dir)).toBe(path.join(dir, 'a.mp3'))
  })
})

describe('pickMoodBgm 情绪子目录', () => {
  it('情绪子目录有曲 → 该子目录随机', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bgm-'))
    fs.mkdirSync(path.join(dir, 'tense'))
    fs.writeFileSync(path.join(dir, 'tense', 'x.mp3'), 'x')
    fs.writeFileSync(path.join(dir, 'root.mp3'), 'x') // 根目录也有，但情绪目录优先
    expect(pickMoodBgm(dir, 'tense', () => 0)).toBe(path.join(dir, 'tense', 'x.mp3'))
  })
  it('情绪子目录缺失/空 → 回落根目录随机', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bgm-'))
    fs.writeFileSync(path.join(dir, 'root.mp3'), 'x')
    expect(pickMoodBgm(dir, 'tense', () => 0)).toBe(path.join(dir, 'root.mp3'))       // 无 tense 子目录
    fs.mkdirSync(path.join(dir, 'warm'))                                              // 空子目录
    expect(pickMoodBgm(dir, 'warm', () => 0)).toBe(path.join(dir, 'root.mp3'))
  })
  it('mood 为空 → 直接根目录随机', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bgm-'))
    fs.writeFileSync(path.join(dir, 'root.mp3'), 'x')
    expect(pickMoodBgm(dir, '', () => 0)).toBe(path.join(dir, 'root.mp3'))
  })
  it('子目录与根都空 → null', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bgm-'))
    expect(pickMoodBgm(dir, 'tense', () => 0)).toBeNull()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @forgecast/studio test hyperframes`
Expected: FAIL —— `pickMoodBgm` 未导出、`pickBgm` 第三参未实现随机。

- [ ] **Step 3: 实现 pickBgm 随机 + pickMoodBgm**

`packages/studio/src/hyperframes.ts` 里 `pickBgm` 整个替换为（加 `rand` 参与随机分支）：

```typescript
/** 选曲：有 name 则补后缀命中；无 name 时给了 rand 从音频随机、否则字典序第一个（向后兼容）。 */
export function pickBgm(bgmDir: string, name?: string, rand?: () => number): string | null {
  if (!fs.existsSync(bgmDir)) return null
  if (name) {
    for (const ext of ['', '.mp3', '.wav', '.m4a']) {
      const p = path.join(bgmDir, name + ext)
      if (fs.existsSync(p) && fs.statSync(p).isFile()) return p
    }
    return null
  }
  const audio = fs.readdirSync(bgmDir).filter((f) => /\.(mp3|wav|m4a)$/i.test(f)).sort()
  if (!audio.length) return null
  const idx = rand ? Math.min(audio.length - 1, Math.floor(rand() * audio.length)) : 0
  return path.join(bgmDir, audio[idx])
}

/** 情绪选曲：mood 非空且 <dir>/<mood>/ 有曲 → 该子目录随机；否则根目录随机；都空 → null。 */
export function pickMoodBgm(bgmDir: string, mood: string, rand?: () => number): string | null {
  if (mood) {
    const hit = pickBgm(path.join(bgmDir, mood), undefined, rand)
    if (hit) return hit
  }
  return pickBgm(bgmDir, undefined, rand)
}
```

- [ ] **Step 4: 跑测试确认通过 + tsc**

Run: `pnpm --filter @forgecast/studio test hyperframes`、`npx tsc -p packages/studio/tsconfig.json --noEmit`
Expected: 全绿、tsc 无输出。

- [ ] **Step 5: 提交**

```bash
git add packages/studio
git commit -m "feat(studio): pickBgm 支持随机 + pickMoodBgm 情绪子目录选曲"
```

---

### Task 3: 优先级链接入 selectBgm + CLI + gitignore + README

**Files:**
- Modify: `packages/studio/src/hyperframes.ts`（加 `chooseBgmPath`）
- Modify: `packages/studio/src/generate.ts`（`selectBgm` 加 `hook` 参 + 用 `chooseBgmPath`；四调用点传 `copy.hook`）
- Modify: `packages/studio/test/hyperframes.test.ts`（`chooseBgmPath` 优先级测试）
- Modify: `cli.ts`（`--mood`）
- Modify: `.gitignore`（递归 glob）
- Modify: `templates/bgm/README.md`（情绪子文件夹约定）

**Interfaces:**
- Consumes: `resolveMood`(Task1)、`pickBgm`/`pickMoodBgm`(Task2)、`config.video.mood`(Task1)
- Produces:
  - `chooseBgmPath(bgmDir: string, opts: { bgm: string; mood: string; hook: string }, rand?: () => number): string | null`——优先级链纯函数。

- [ ] **Step 1: 写 chooseBgmPath 失败测试**

追加到 `packages/studio/test/hyperframes.test.ts`（导入处补 `chooseBgmPath`）：

```typescript
describe('chooseBgmPath 选曲优先级链', () => {
  function seed() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bgm-'))
    fs.mkdirSync(path.join(dir, 'tense')); fs.mkdirSync(path.join(dir, 'warm'))
    fs.writeFileSync(path.join(dir, 'tense', 't.mp3'), 'x')
    fs.writeFileSync(path.join(dir, 'warm', 'w.mp3'), 'x')
    fs.writeFileSync(path.join(dir, 'named.mp3'), 'x')
    fs.writeFileSync(path.join(dir, 'root.mp3'), 'x')
    return dir
  }
  it('--bgm 指定具体曲 → 跳过情绪匹配', () => {
    const dir = seed()
    expect(chooseBgmPath(dir, { bgm: 'named', mood: 'warm', hook: 'pain' }, () => 0)).toBe(path.join(dir, 'named.mp3'))
  })
  it('bgm=none → null（--no-bgm）', () => {
    const dir = seed()
    expect(chooseBgmPath(dir, { bgm: 'none', mood: '', hook: 'pain' }, () => 0)).toBeNull()
  })
  it('--mood 覆盖 hook 自动映射', () => {
    const dir = seed()
    // hook=pain 本应 tense；mood=warm 覆盖 → warm 子目录
    expect(chooseBgmPath(dir, { bgm: '', mood: 'warm', hook: 'pain' }, () => 0)).toBe(path.join(dir, 'warm', 'w.mp3'))
  })
  it('默认按 hook 自动映射情绪', () => {
    const dir = seed()
    expect(chooseBgmPath(dir, { bgm: '', mood: '', hook: 'pain' }, () => 0)).toBe(path.join(dir, 'tense', 't.mp3'))
  })
  it('情绪目录空 → 回落根目录', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bgm-'))
    fs.writeFileSync(path.join(dir, 'root.mp3'), 'x') // 无情绪子目录
    expect(chooseBgmPath(dir, { bgm: '', mood: '', hook: 'pain' }, () => 0)).toBe(path.join(dir, 'root.mp3'))
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @forgecast/studio test hyperframes`
Expected: FAIL —— `chooseBgmPath` 未导出。

- [ ] **Step 3: 实现 chooseBgmPath**

`packages/studio/src/hyperframes.ts`，加在 `pickMoodBgm` 之后：

```typescript
/** 选曲优先级链：bgm='none'→null；bgm 具体名→指定曲；否则按 resolveMood(hook,mood) 走情绪/根随机。 */
export function chooseBgmPath(bgmDir: string, opts: { bgm: string; mood: string; hook: string }, rand?: () => number): string | null {
  if (opts.bgm === 'none') return null
  if (opts.bgm) return pickBgm(bgmDir, opts.bgm)
  return pickMoodBgm(bgmDir, resolveMood(opts.hook, opts.mood), rand)
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @forgecast/studio test hyperframes`
Expected: PASS

- [ ] **Step 5: 接入 selectBgm（加 hook 参 + 用 chooseBgmPath）**

`packages/studio/src/generate.ts`：先在顶部 import 补 `chooseBgmPath`（与 `pickBgm` 同一行 import 追加）。然后 `selectBgm` 签名与选曲替换为：

```typescript
async function selectBgm(ctx: CoreCtx, durationSec: number, onProgress: (m: string) => void, hook: string): Promise<{ grid: BeatGrid | null; audioMix: AudioMix | undefined }> {
  let grid: BeatGrid | null = null
  let audioMix: AudioMix | undefined
  const bgmDir = path.join(ctx.config.paths.templates, 'bgm')
  // 优先级链：--bgm 指定 > --mood > hook 自动映射情绪 > 根回落 > none/空→不加
  const bgmPath = chooseBgmPath(bgmDir, { bgm: ctx.config.video.bgm, mood: ctx.config.video.mood, hook }, Math.random)
  if (bgmPath && ctx.config.video.beatPython && ctx.config.video.mode !== 'stub') {
    grid = await analyzeBeats(bgmPath, ctx.config.video.beatPython)
    if (!grid) onProgress('⚠ 节拍分析失败，加 BGM 但不卡点')
    const sfxDir = path.join(ctx.config.paths.templates, 'sfx')
    const sfxPath = pickBgm(sfxDir) // 复用：取 sfx 目录第一个（不分情绪）
    audioMix = { bgmPath, sfxPath, strongBeats: grid?.strongBeats ?? [], durationSec }
  }
  return { grid, audioMix }
}
```

- [ ] **Step 6: 四模板分支把 copy.hook 传进 selectBgm**

`packages/studio/src/generate.ts` 里四处 `await selectBgm(ctx, duration, onProgress)` 全部改成 `await selectBgm(ctx, duration, onProgress, copy.hook)`（changelog/demo/story/flash 四分支各一处）。`copy` 在 generateVideo 顶部已取到、`copy.hook` 可用。

- [ ] **Step 7: 跑测试 + tsc**

Run: `pnpm --filter @forgecast/studio test`、`npx tsc -p packages/studio/tsconfig.json --noEmit`
Expected: 全绿、tsc 无输出。（既有 generate.test 的「无 BGM 曲库正常出片」「stub 不跑 librosa」仍应通过——曲库空时 chooseBgmPath 返 null。）

- [ ] **Step 8: CLI --mood**

`cli.ts` 的 `video` case，在 `if (arg('bg')) ...` 那行之后加：

```typescript
      if (arg('mood')) ctx.config.video.mood = arg('mood') as string
```

并把用法串补 `[--mood=<tense|upbeat|tech|warm>]`（在现有 `[--no-captions]` 之后）。

- [ ] **Step 9: .gitignore 递归 glob**

`.gitignore` 把 `templates/bgm/*.mp3`、`*.wav`、`*.m4a`、`*.beats.json` 四行改成递归（覆盖情绪子文件夹）：

```
templates/bgm/**/*.mp3
templates/bgm/**/*.wav
templates/bgm/**/*.m4a
templates/bgm/**/*.beats.json
```

（`/**/ ` 匹配零或多层目录，根与子目录都覆盖。SFX 两行不动，SFX 不分情绪。）

- [ ] **Step 10: templates/bgm/README.md 情绪子文件夹约定**

在 `templates/bgm/README.md` 末尾追加：

```markdown

## 情绪子文件夹（自动选曲）

按文案 hook 自动匹配情绪、从对应子文件夹随机选曲：

| hook | 子文件夹 | 情绪 |
|---|---|---|
| pain 痛点 | `tense/` | 紧张 / 悬念 |
| sideline 副业 | `upbeat/` | 热血 / 励志 |
| infogap 信息差 | `tech/` | 科技 / 好奇 |
| story 故事 | `warm/` | 温情 |

把曲子丢进对应子文件夹即可；子文件夹缺失或空时回落根目录（= 不分情绪）。
`--mood=<键>` 手动指定情绪，`--bgm=<名>` 指定具体曲（跳过情绪），`--no-bgm` 出无 BGM 干净版。
```

- [ ] **Step 11: 跑全套件 + tsc + 确认 gitignore**

Run: `pnpm --filter @forgecast/studio test`、`pnpm --filter @forgecast/core test`、`npx tsc -p packages/studio/tsconfig.json --noEmit`
Expected: 全绿。
再确认 gitignore 生效：`mkdir -p templates/bgm/tense && touch templates/bgm/tense/x.mp3 && git status --porcelain templates/bgm/tense`
Expected: 空输出（子文件夹音频被忽略）。之后 `rm -rf templates/bgm/tense`。

- [ ] **Step 12: 提交**

```bash
git add packages/studio cli.ts .gitignore templates/bgm/README.md
git commit -m "feat(studio): 选曲优先级链 chooseBgmPath 接入 selectBgm + --mood + gitignore 递归 + README"
```

---

## 完成标准
- `pnpm --filter @forgecast/studio test` + `pnpm --filter @forgecast/core test` 全绿；studio/core `tsc --noEmit` 无错。
- 有情绪子文件夹时：按 hook 自动进对应情绪目录随机选曲；`--mood` 覆盖；`--bgm` 指定跳过情绪；`--no-bgm` 不加。
- 无情绪子文件夹 / 空：回落根目录（= 现在行为），不报错。
- 情绪子文件夹里的音频/缓存不入库（gitignore 递归生效）。

## 已知非纯代码成本
- 无（本子项目纯选曲逻辑，混音/真渲管线已在①验证，不需真渲）。
- 用户需自行把曲子整理进情绪子文件夹才有情绪匹配效果；不整理则回落根目录，行为同现在。
