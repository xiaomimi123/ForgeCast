# BGM + 卡点 + 音效（子项目①）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 forgecast 视频加 BGM 背景音乐（旁白 ducking 闪避）+ 段边界/截图卡点到节拍 + 强拍缩放脉冲与音效。

**Architecture:** 节拍分析（复用 melo venv 的 librosa，最小二乘拟合网格）+ 卡点吸附在 generate 算；BGM/SFX 混音在 HyperFrames 渲染后用 ffmpeg 做（sidechaincompress ducking）。全程 fail-soft：曲库空/分析失败/混音失败都降级出片，不中断。

**Tech Stack:** TypeScript、vitest、Python(librosa/numpy，melo venv)、ffmpeg、HyperFrames。

## Global Constraints

- 设计文档：`docs/superpowers/specs/2026-07-24-bgm-beat-sync-design.md`，冲突以它为准。
- **只做子项目①**（BGM+卡点+音效）。②情绪匹配、③编辑界面不在本计划。
- **BGM/SFX 音频二进制不入库**（gitignore，用户放；验收用测试素材）。
- **Fail-soft**：曲库空/`--no-bgm` → 跳过不报错；分析失败 → 加 BGM 不卡点 + ⚠；混音失败 → 保留无 BGM 原视频 + degraded。
- **不信 librosa 标量 tempo**——用最小二乘拟合网格反推 BPM/相位（见 beat_grid.py）。
- librosa 复用 melo venv：`FORGECAST_BEAT_PYTHON` 默认回落 `FORGECAST_MELO_PYTHON`。
- 中文注释与提交信息。vitest 只转译不做类型检查——改跨包类型后跑 `npx tsc -p packages/studio/tsconfig.json --noEmit` 与 `packages/core`。
- 每任务结束 `pnpm -r test` 全绿才提交。真渲/真混音/真分析由主控在 Node22 + melo venv 环境验证（subagent 做纯代码 + mock）。

**参考**：现有 `generate.ts` 四模板分支 + `renderAndRegister`（changelog/story/flash 用它收尾，demo 目前内联——本计划 Task 5 统一）。音轨注入见 `injectAudioCaptions`（`<!--HF_AUDIO-->`/`<!--HF_CAPTIONS-->` 标记）。

---

### Task 1: 节拍分析（beat_grid.py + analyzeBeats + 缓存）

**Files:**
- Create: `packages/studio/scripts/beat_grid.py`
- Modify: `packages/studio/src/hyperframes.ts`（加 `BeatGrid` 类型 + `analyzeBeats`）
- Test: `packages/studio/test/hyperframes.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `export interface BeatGrid { t0: number; T: number; bpm: number; beats: number[]; strongBeats: number[]; duration: number }`
  - `export async function analyzeBeats(bgmPath: string, beatPython: string, deps?: { run?: (args: string[]) => Promise<void> }): Promise<BeatGrid | null>` —— 读 `<bgmPath>.beats.json` 缓存；无则 spawn beatPython 跑 beat_grid.py 生成缓存再读；任何失败返 null。

- [ ] **Step 1: 写失败测试**

追加到 `packages/studio/test/hyperframes.test.ts`：

```typescript
import { analyzeBeats } from '../src/hyperframes'

describe('analyzeBeats', () => {
  it('缓存存在时不 spawn，直接读', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beat-'))
    const bgm = path.join(dir, 'x.mp3'); fs.writeFileSync(bgm, 'fake')
    fs.writeFileSync(bgm + '.beats.json', JSON.stringify({ t0: 0.1, T: 0.5, bpm: 120, beats: [0.1, 0.6], strongBeats: [0.1], duration: 30 }))
    const run = vi.fn()
    const g = await analyzeBeats(bgm, '/fake/py', { run })
    expect(run).not.toHaveBeenCalled()
    expect(g?.bpm).toBe(120)
    expect(g?.beats).toEqual([0.1, 0.6])
  })
  it('无缓存时 spawn 生成后读', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beat-'))
    const bgm = path.join(dir, 'y.mp3'); fs.writeFileSync(bgm, 'fake')
    const run = vi.fn(async () => { fs.writeFileSync(bgm + '.beats.json', JSON.stringify({ t0: 0, T: 0.5, bpm: 120, beats: [0], strongBeats: [], duration: 10 })) })
    const g = await analyzeBeats(bgm, '/fake/py', { run })
    expect(run).toHaveBeenCalledOnce()
    expect(g?.duration).toBe(10)
  })
  it('spawn 失败或缓存坏 → null', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beat-'))
    const bgm = path.join(dir, 'z.mp3'); fs.writeFileSync(bgm, 'fake')
    const run = vi.fn(async () => { throw new Error('librosa 挂了') })
    expect(await analyzeBeats(bgm, '/fake/py', { run })).toBeNull()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @forgecast/studio test hyperframes`
Expected: FAIL —— `analyzeBeats` 未导出

- [ ] **Step 3: 实现 beat_grid.py**

Create `packages/studio/scripts/beat_grid.py`：

```python
#!/usr/bin/env python
"""BGM 节拍分析：<python> beat_grid.py <bgm> <out.json>
librosa beat_track 取节拍 → 最小二乘拟合线性网格（不信标量 tempo，能差 2%+）→
40-160Hz 带通滤底鼓定强拍。输出 {t0,T,bpm,beats,strongBeats,duration}。需 librosa+numpy（melo venv 里有）。"""
import json
import sys
import numpy as np
import librosa

bgm, out = sys.argv[1], sys.argv[2]
y, sr = librosa.load(bgm, sr=None, mono=True)
duration = float(len(y) / sr)
_, beat_frames = librosa.beat.beat_track(y=y, sr=sr, tightness=400, units="frames")
beats = librosa.frames_to_time(beat_frames, sr=sr)

if len(beats) >= 2:
    # 最小二乘拟合 t_i = t0 + i*T
    i = np.arange(len(beats))
    A = np.vstack([i, np.ones_like(i)]).T
    (T, t0), *_ = np.linalg.lstsq(A, beats, rcond=None)
    T = float(T); t0 = float(t0)
    bpm = 60.0 / T if T > 0 else 0.0
else:
    T, t0, bpm = 0.5, float(beats[0]) if len(beats) else 0.0, 120.0

# 强拍：40-160Hz 带通滤底鼓 → onset 能量 → 落在拍上能量最强的几下
try:
    yk = librosa.effects.preemphasis(y)
    S = np.abs(librosa.stft(yk))
    freqs = librosa.fft_frequencies(sr=sr)
    band = (freqs >= 40) & (freqs <= 160)
    kick_env = S[band, :].sum(axis=0)
    times = librosa.frames_to_time(np.arange(len(kick_env)), sr=sr)
    strong = []
    for b in beats:
        idx = int(np.argmin(np.abs(times - b)))
        strong.append((float(kick_env[idx]), float(b)))
    strong.sort(reverse=True)
    n = max(2, len(beats) // 8)  # 取约 1/8 的拍作强拍
    strong_beats = sorted(b for _, b in strong[:n])
except Exception:
    strong_beats = [float(b) for b in beats[::8]]

json.dump({
    "t0": t0, "T": T, "bpm": bpm,
    "beats": [float(b) for b in beats],
    "strongBeats": [float(b) for b in strong_beats],
    "duration": duration,
}, open(out, "w"))
```

- [ ] **Step 4: 实现 analyzeBeats**

`packages/studio/src/hyperframes.ts` 顶部常量区加脚本路径：

```typescript
const BEAT_SCRIPT = fileURLToPath(new URL('../scripts/beat_grid.py', import.meta.url))
```

加类型与函数（放在 `runCosyTts` 附近）：

```typescript
export interface BeatGrid { t0: number; T: number; bpm: number; beats: number[]; strongBeats: number[]; duration: number }

/** 节拍分析：读 <bgm>.beats.json 缓存；无则 spawn beat_grid.py 生成再读。任何失败返 null（调用方降级不卡点）。 */
export async function analyzeBeats(
  bgmPath: string, beatPython: string,
  deps: { run?: (args: string[]) => Promise<void> } = {},
): Promise<BeatGrid | null> {
  const cache = `${bgmPath}.beats.json`
  const readCache = (): BeatGrid | null => {
    try {
      const g = JSON.parse(fs.readFileSync(cache, 'utf8'))
      if (Array.isArray(g.beats) && typeof g.T === 'number') return g as BeatGrid
      return null
    } catch { return null }
  }
  if (fs.existsSync(cache)) { const g = readCache(); if (g) return g }
  const run = deps.run ?? ((args: string[]) => spawnWithTimeout(args, { cmd: beatPython, timeoutMs: TTS_SPAWN_TIMEOUT_MS, label: 'beat_grid' }))
  try {
    await run([BEAT_SCRIPT, bgmPath, cache])
    return readCache()
  } catch { return null }
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm --filter @forgecast/studio test hyperframes` 与 `npx tsc -p packages/studio/tsconfig.json --noEmit`
Expected: PASS、无类型错误

- [ ] **Step 6: 提交**

```bash
git add packages/studio/scripts/beat_grid.py packages/studio/src/hyperframes.ts packages/studio/test/hyperframes.test.ts
git commit -m "feat(studio): BGM 节拍分析（librosa 网格拟合 + 缓存）"
```

---

### Task 2: 卡点吸附 + 曲库选曲（纯函数）

**Files:**
- Modify: `packages/studio/src/hyperframes.ts`（加 `snapToBeat`、`pickBgm`）
- Test: `packages/studio/test/hyperframes.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `BeatGrid`
- Produces:
  - `export function snapToBeat(t: number, beats: number[]): number` —— 返回最近的 beat 时间；beats 空则原样返回 t。
  - `export function pickBgm(bgmDir: string, name?: string): string | null` —— name 指定则返回 `bgmDir/name`（补 .mp3/.wav 后缀，存在才返回）；否则返回目录内字典序第一个音频；无则 null。

- [ ] **Step 1: 写失败测试**

追加到 `hyperframes.test.ts`：

```typescript
import { snapToBeat, pickBgm } from '../src/hyperframes'

describe('snapToBeat', () => {
  it('吸附到最近的拍', () => {
    expect(snapToBeat(3.1, [0, 1, 2, 3, 4])).toBe(3)
    expect(snapToBeat(3.6, [0, 1, 2, 3, 4])).toBe(4)
  })
  it('beats 空时原样返回', () => {
    expect(snapToBeat(3.1, [])).toBe(3.1)
  })
})

describe('pickBgm', () => {
  it('指定名命中（补后缀）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bgm-'))
    fs.writeFileSync(path.join(dir, 'tech.mp3'), 'a')
    expect(pickBgm(dir, 'tech')).toBe(path.join(dir, 'tech.mp3'))
  })
  it('不指定则取字典序第一个音频', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bgm-'))
    fs.writeFileSync(path.join(dir, 'b.mp3'), 'a'); fs.writeFileSync(path.join(dir, 'a.wav'), 'a')
    fs.writeFileSync(path.join(dir, 'note.txt'), 'x') // 非音频忽略
    expect(pickBgm(dir)).toBe(path.join(dir, 'a.wav'))
  })
  it('空目录/不存在返 null', () => {
    expect(pickBgm('/no/such/dir')).toBeNull()
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bgm-'))
    expect(pickBgm(dir)).toBeNull()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @forgecast/studio test hyperframes`
Expected: FAIL —— 未导出

- [ ] **Step 3: 实现**

`hyperframes.ts` 加：

```typescript
/** 返回最近的 beat 时间；beats 空则原样返回。 */
export function snapToBeat(t: number, beats: number[]): number {
  if (!beats.length) return t
  return beats.reduce((best, b) => (Math.abs(b - t) < Math.abs(best - t) ? b : best), beats[0])
}

/** 曲库选曲：name 指定则补 .mp3/.wav 后缀命中；否则字典序第一个音频；无则 null。 */
export function pickBgm(bgmDir: string, name?: string): string | null {
  if (!fs.existsSync(bgmDir)) return null
  if (name) {
    for (const ext of ['', '.mp3', '.wav', '.m4a']) {
      const p = path.join(bgmDir, name + ext)
      if (fs.existsSync(p) && fs.statSync(p).isFile()) return p
    }
    return null
  }
  const audio = fs.readdirSync(bgmDir).filter((f) => /\.(mp3|wav|m4a)$/i.test(f)).sort()
  return audio.length ? path.join(bgmDir, audio[0]) : null
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @forgecast/studio test hyperframes`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/studio/src/hyperframes.ts packages/studio/test/hyperframes.test.ts
git commit -m "feat(studio): 卡点吸附 snapToBeat + 曲库选曲 pickBgm"
```

---

### Task 3: BGM/SFX 混音（ffmpeg ducking + 音效）

**Files:**
- Modify: `packages/studio/src/hyperframes.ts`（加 `buildMixFilter`、`mixAudio`）
- Test: `packages/studio/test/hyperframes.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `BeatGrid`
- Produces:
  - `export function buildMixFilter(opts: { hasSfx: boolean; strongBeats: number[]; durationSec: number }): string` —— 纯函数，返回 ffmpeg `-filter_complex` 字符串（BGM loop+压-18dB+sidechaincompress ducking；SFX 各 strongBeat adelay 后 amix）。
  - `export async function mixAudio(mp4: string, opts: { bgmPath: string; sfxPath: string | null; strongBeats: number[]; durationSec: number; deps?: { run?: (args: string[]) => Promise<void> } }): Promise<void>` —— spawn ffmpeg 把 BGM/SFX 混进 mp4（旁白轨来自 mp4 自身）；失败抛错。

- [ ] **Step 1: 写失败测试**

追加到 `hyperframes.test.ts`：

```typescript
import { buildMixFilter, mixAudio } from '../src/hyperframes'

describe('buildMixFilter', () => {
  it('无 SFX：BGM 压低 + ducking + 与旁白 amix', () => {
    const f = buildMixFilter({ hasSfx: false, strongBeats: [], durationSec: 20 })
    expect(f).toContain('sidechaincompress')
    expect(f).toContain('amix')
    expect(f).not.toContain('adelay')
  })
  it('有 SFX：每个强拍 adelay 后并入', () => {
    const f = buildMixFilter({ hasSfx: true, strongBeats: [1.5, 3.0], durationSec: 20 })
    expect(f).toContain('adelay=1500')
    expect(f).toContain('adelay=3000')
  })
})

describe('mixAudio', () => {
  it('spawn ffmpeg 且失败抛错', async () => {
    const run = vi.fn(async () => { throw new Error('ffmpeg 挂') })
    await expect(mixAudio('/tmp/x.mp4', { bgmPath: '/tmp/b.mp3', sfxPath: null, strongBeats: [], durationSec: 10, deps: { run } }))
      .rejects.toThrow(/ffmpeg 挂/)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @forgecast/studio test hyperframes`
Expected: FAIL

- [ ] **Step 3: 实现**

`hyperframes.ts` 加（filtergraph：旁白=输入0音轨、BGM=输入1、SFX=输入2）：

```typescript
/** ffmpeg filter_complex：BGM 裁/loop 到时长+压 -18dB+被旁白 sidechaincompress；SFX 各强拍 adelay 后并入；最后与旁白 amix。 */
export function buildMixFilter(opts: { hasSfx: boolean; strongBeats: number[]; durationSec: number }): string {
  const ms = opts.durationSec * 1000
  // [0:a]=旁白 [1:a]=BGM [2:a]=SFX(单次)
  const parts: string[] = []
  parts.push('[0:a]asplit=2[narr][sc]')
  // BGM：截到时长、压低、以旁白(sc)为触发做 ducking
  parts.push(`[1:a]atrim=0:${opts.durationSec},volume=-18dB[bgmv]`)
  parts.push('[bgmv][sc]sidechaincompress=threshold=0.03:ratio=8:attack=5:release=300[bgmduck]')
  const mixIns = ['[narr]', '[bgmduck]']
  if (opts.hasSfx && opts.strongBeats.length) {
    opts.strongBeats.forEach((t, i) => {
      const delay = Math.round(t * 1000)
      parts.push(`[2:a]adelay=${delay}|${delay},volume=-6dB[sfx${i}]`)
      mixIns.push(`[sfx${i}]`)
    })
  }
  parts.push(`${mixIns.join('')}amix=inputs=${mixIns.length}:normalize=0:duration=first[aout]`)
  return parts.join(';')
}

/** 把 BGM/SFX 混进已渲染的 mp4（旁白轨来自 mp4）。失败抛错，调用方降级保留原视频。 */
export async function mixAudio(mp4: string, opts: {
  bgmPath: string; sfxPath: string | null; strongBeats: number[]; durationSec: number
  deps?: { run?: (args: string[]) => Promise<void> }
}): Promise<void> {
  const filter = buildMixFilter({ hasSfx: !!opts.sfxPath, strongBeats: opts.strongBeats, durationSec: opts.durationSec })
  const tmp = `${mp4}.mix.mp4`
  const args = ['-y', '-i', mp4, '-stream_loop', '-1', '-i', opts.bgmPath]
  if (opts.sfxPath) args.push('-i', opts.sfxPath)
  args.push('-filter_complex', filter, '-map', '0:v', '-map', '[aout]', '-c:v', 'copy', '-c:a', 'aac', tmp)
  const run = opts.deps?.run ?? ((a: string[]) => spawnWithTimeout(a, { cmd: 'ffmpeg', timeoutMs: RENDER_TIMEOUT_MS, label: 'ffmpeg mix' }))
  await run(args)
  fs.renameSync(tmp, mp4)
}
```

（注：`-stream_loop -1` 让 BGM 循环，`atrim` 截到时长。）

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @forgecast/studio test hyperframes`、`npx tsc -p packages/studio/tsconfig.json --noEmit`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/studio/src/hyperframes.ts packages/studio/test/hyperframes.test.ts
git commit -m "feat(studio): BGM/SFX 混音（ffmpeg ducking + 强拍音效）"
```

---

### Task 4: 配置 + CLI + 素材库脚手架

**Files:**
- Modify: `packages/core/src/config.ts`（tts 加 `bgm`、`bgmDir`、`beatPython`？——见下，放 video 配置）
- Create: `templates/bgm/README.md`、`templates/sfx/README.md`
- Modify: `.gitignore`
- Modify: `cli.ts`（`--bgm` / `--no-bgm`）
- Test: `packages/core/test/config.test.ts`

**Interfaces:**
- Consumes: 无
- Produces: `config.video` 加 `{ bgm: string; beatPython: string }`（`bgm`：''=自动挑/`none`=关/具体名=指定；`beatPython`：默认回落 melo）。CLI `--bgm=<name>`/`--no-bgm`。

- [ ] **Step 1: 写失败测试**

追加到 `packages/core/test/config.test.ts`：

```typescript
it('video 配置含 bgm 与 beatPython（beatPython 默认回落 melo）', () => {
  const c = loadConfig('/tmp/x', { FORGECAST_MELO_PYTHON: '/venv/melo/py' })
  expect(c.video.bgm).toBe('')
  expect(c.video.beatPython).toBe('/venv/melo/py')
  const c2 = loadConfig('/tmp/x', { FORGECAST_BGM: 'none', FORGECAST_BEAT_PYTHON: '/venv/beat/py' })
  expect(c2.video.bgm).toBe('none')
  expect(c2.video.beatPython).toBe('/venv/beat/py')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @forgecast/core test config`
Expected: FAIL —— video 无 bgm/beatPython

- [ ] **Step 3: 实现 config**

`packages/core/src/config.ts` 的 `video` 类型与构造：

```typescript
  video: { mode: VideoMode; bgm: string; beatPython: string }
```

`loadConfig` 里 `video:` 改为：

```typescript
    video: {
      mode: videoMode,
      bgm: env.FORGECAST_BGM ?? '',
      beatPython: env.FORGECAST_BEAT_PYTHON || env.FORGECAST_MELO_PYTHON || '',
    },
```

- [ ] **Step 4: 素材库 README + gitignore**

Create `templates/bgm/README.md`：

```markdown
# BGM 曲库

放无版权/可商用背景乐（.mp3/.wav/.m4a）。系统自动挑字典序第一个，或 `forgecast video ... --bgm=<文件名不含后缀>` 指定，`--no-bgm` 关闭。
首次用某曲会分析节拍并缓存 `<曲>.beats.json`（同目录）。
素材来源：Mixkit / Pixabay Music / YouTube Audio Library 等（注意各自授权，商用需确认）。
音频与 .beats.json 均 gitignore，不入库。
```

Create `templates/sfx/README.md`：

```markdown
# 音效库

放强拍音效（.mp3/.wav，如低音"哚"/whoosh）。系统取字典序第一个，在 BGM 节拍的强拍处混入。
无音效文件则不加音效（仅 BGM+卡点）。素材与授权同 BGM。gitignore 不入库。
```

`.gitignore` 追加：

```
templates/bgm/*.mp3
templates/bgm/*.wav
templates/bgm/*.m4a
templates/bgm/*.beats.json
templates/sfx/*.mp3
templates/sfx/*.wav
```

- [ ] **Step 5: CLI --bgm/--no-bgm**

`cli.ts` 的 `video` case 里，在 `generateVideo` 调用前解析并塞进 ctx.config.video.bgm（就地覆盖）：

```typescript
      if (rest.includes('--no-bgm')) ctx.config.video.bgm = 'none'
      else if (arg('bgm')) ctx.config.video.bgm = arg('bgm') as string
```

（放在 `const tpl = ...` 之后、`generateVideo` 之前。）

- [ ] **Step 6: 跑测试 + tsc + 提交**

**先修既有测试**：`config.test.ts` 的 `video 默认 render，可设 stub` 用例断言 `.toEqual({ mode: 'render' })`——加字段后必挂。改为：

```typescript
    expect(loadConfig('/tmp/x', {}).video).toEqual({ mode: 'render', bgm: '', beatPython: '' })
    expect(loadConfig('/tmp/x', { FORGECAST_VIDEO_MODE: 'stub' }).video).toEqual({ mode: 'stub', bgm: '', beatPython: '' })
```

Run: `pnpm --filter @forgecast/core test`、`npx tsc -p packages/core/tsconfig.json --noEmit`、`pnpm -r test`
Expected: 全绿（若 studio 有别处构造 video 配置对象的测试同样报，补 `bgm:'',beatPython:''`）

```bash
git add packages/core cli.ts templates/bgm/README.md templates/sfx/README.md .gitignore
git commit -m "feat: BGM 配置(bgm/beatPython) + CLI --bgm/--no-bgm + 素材库脚手架"
```

---

### Task 5: 接入 generate（选曲→分析→卡点→强拍→渲染→混音）+ 强拍动画 + 真渲里程碑

**Files:**
- Modify: `packages/studio/src/hyperframes.ts`（加 `injectBeatAccents`；`buildDemoSections`/`buildStorySections` 接受 beats 做截图/段吸附）
- Modify: `templates/hf/*.html`（4 个模板 script 里加 `<!--HF_ACCENTS-->` 标记）
- Modify: `packages/studio/src/generate.ts`（各分支选曲/分析/吸附/强拍/renderAndRegister 混音；demo 统一走 renderAndRegister）
- Test: `packages/studio/test/generate.test.ts`
- 真渲：主控

**Interfaces:**
- Consumes: Task 1-3 的 `analyzeBeats`/`snapToBeat`/`pickBgm`/`mixAudio`/`BeatGrid`
- Produces:
  - `injectBeatAccents(html: string, strongBeats: number[]): string` —— 填 `<!--HF_ACCENTS-->` 为 GSAP 脉冲行。
  - `renderAndRegister` 增参 `audioMix?: { bgmPath: string; sfxPath: string | null; strongBeats: number[]; durationSec: number }`——render 后调 mixAudio（失败 fail-soft，保留原视频 + onProgress ⚠）。

- [ ] **Step 1: 写失败测试（injectBeatAccents + fail-soft）**

追加到 `packages/studio/test/generate.test.ts`（stub 模式：无曲库跳过、mixAudio 不被调）：

```typescript
it('无 BGM 曲库时正常出片（不加 BGM 不报错）', async () => {
  const config = loadConfig(root, { FORGECAST_VIDEO_MODE: 'stub', FORGECAST_TTS_MODE: 'stub' })
  const fctx: CoreCtx = { db: ctx.db, config, llm: ctx.llm }
  const out = await generateVideo(fctx, { slug: 'demo', tpl: 'flash', onProgress: () => {} })
  expect(out.filePath).toContain('flash-')
  // hf 项目仍产出，无 BGM 分支不抛错
  expect(fs.existsSync(path.join(fctx.config.paths.workspace, 'demo', 'hf', 'index.html'))).toBe(true)
})
```

并加 `injectBeatAccents` 纯函数测试到 `hyperframes.test.ts`：

```typescript
import { injectBeatAccents } from '../src/hyperframes'
describe('injectBeatAccents', () => {
  it('每个强拍生成一个脉冲，替换标记', () => {
    const html = injectBeatAccents('<script>tl;<!--HF_ACCENTS--></script>', [1.0, 2.5])
    expect(html).toContain('1') ; expect(html).toContain('2.5')
    expect(html).not.toContain('<!--HF_ACCENTS-->')
    expect((html.match(/gsap|tl\./g) || []).length).toBeGreaterThanOrEqual(2)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @forgecast/studio test`
Expected: FAIL —— `injectBeatAccents` 未导出 / 无曲库测试引用的行为未实现（当前无 BGM 逻辑，flash 分支应仍通过——若通过则只有 injectBeatAccents 测试失败，符合预期）

- [ ] **Step 3: 实现 injectBeatAccents + 模板标记**

`hyperframes.ts` 加：

```typescript
/** 强拍脉冲：每个 strongBeat 给 #root 叠一个轻微 scale 弹跳（yoyo，幅度小防晕）。填 <!--HF_ACCENTS-->。 */
export function injectBeatAccents(html: string, strongBeats: number[]): string {
  const lines = strongBeats.map((t) =>
    `gsap.to("#root", { keyframes: [{ scale: 1.02, duration: 0.07 }, { scale: 1.0, duration: 0.08 }] }, ${t});`,
  ).join('\n')
  return html.replace('<!--HF_ACCENTS-->', () => lines)
}
```

4 个模板 `templates/hf/{changelog,demo,story,flash}.html` 的 `<script>` 里、`window.__timelines["main"] = tl;` **之前**加一行：

```html
      <!--HF_ACCENTS-->
```

（注：强拍脉冲与模板里已有的 `#root` 慢放大 `fromTo` 会叠加——gsap 会把两个 tween 叠算，脉冲是短暂 keyframes、幅度 0.02，视觉上是"在慢放大基础上轻微弹一下"，真渲时确认不冲突；若冲突，改脉冲目标为 `.clip` 首个可见段，主控真渲时定。）

- [ ] **Step 4: renderAndRegister 加 audioMix + generate 各分支接入**

`renderAndRegister` 签名加可选 `audioMix`，render 后：

```typescript
  await renderHyperframes(hfDir, outAbs, ctx.config.video.mode === 'stub' ? 'stub' : 'render', { onProgress })
  if (audioMix && ctx.config.video.mode !== 'stub') {
    try {
      onProgress('混入 BGM/音效…')
      await mixAudio(outAbs, audioMix)
    } catch (e) {
      onProgress(`⚠ BGM 混音失败，保留无背景乐版本：${e instanceof Error ? e.message : String(e)}`)
    }
  }
```

在每个模板分支（changelog/story/flash/demo）算完 `duration`、`voice` 后、渲染前，插入选曲+分析+吸附：

```typescript
  // BGM：选曲→分析节拍→（fail-soft）
  let grid: import('./hyperframes').BeatGrid | null = null
  let audioMix: { bgmPath: string; sfxPath: string | null; strongBeats: number[]; durationSec: number } | undefined
  if (ctx.config.video.bgm !== 'none') {
    const bgmDir = path.join(ctx.config.paths.templates, 'bgm')
    const bgmPath = pickBgm(bgmDir, ctx.config.video.bgm || undefined)
    if (bgmPath && ctx.config.video.beatPython) {
      grid = await analyzeBeats(bgmPath, ctx.config.video.beatPython)
      if (!grid) onProgress('⚠ 节拍分析失败，加 BGM 但不卡点')
      const sfxDir = path.join(ctx.config.paths.templates, 'sfx')
      const sfxPath = pickBgm(sfxDir) // 复用：取 sfx 目录第一个
      audioMix = { bgmPath, sfxPath, strongBeats: grid?.strongBeats ?? [], durationSec: duration }
    }
  }
```

卡点吸附：段边界/截图切换用 `grid ? snapToBeat(t, grid.beats) : t`。`buildDemoSections`/`buildStorySections` 增可选 `beats?: number[]` 参数，内部对每个 `clip(start,...)` 的 start 吸附。changelog/flash 的固定段边界同理吸附（在填 slot 的 duration/s2dur 前把边界值 snap）。强拍动画：`injectBeatAccents(html, grid?.strongBeats ?? [])` 在 injectAudioCaptions 之后调。渲染改走 `renderAndRegister(..., audioMix)`（demo 从内联改为 renderAndRegister，附 shotAssets——给 renderAndRegister 也加可选 `assets` 参转发 scaffoldHfProject，或 demo 保留内联但补同款 mix 逻辑；实现时择一，保持 DRY）。

- [ ] **Step 5: 跑测试 + tsc**

Run: `pnpm --filter @forgecast/studio test`、`npx tsc -p packages/studio/tsconfig.json --noEmit`
Expected: 全绿

- [ ] **Step 6: 真渲验证（主控，里程碑）**

放测试 BGM 到 `templates/bgm/`（主控用无版权测试音频）+ 测试 SFX 到 `templates/sfx/`。Node22 + melo venv（librosa）：

```bash
export PATH=<node22>:/opt/homebrew/bin:$PATH
export FORGECAST_MELO_PYTHON=~/.forgecast-venvs/melo/bin/python  # librosa 在此
export FORGECAST_TTS_MODE=melo FORGECAST_VIDEO_MODE=render
npx tsx cli.ts video demo-project --tpl=demo
```
验：① `<bgm>.beats.json` 生成；② 成片 ffprobe 有音轨、时长对；③ volumedetect 确认旁白清晰（ducking 生效）；④ 从成片提音频重新 librosa 拟合，对比设计卡点时间，漂移 ≤3 帧（借鉴 video-shotcraft 验证法）；⑤ 抽帧看段切换/截图切换是否落在拍上；⑥ `--no-bgm` 出片无 BGM。

- [ ] **Step 7: 提交**

```bash
git add packages/studio templates/hf
git commit -m "feat(studio): 接入 BGM+卡点+强拍动画/音效（各模板选曲→分析→吸附→混音，fail-soft）"
```

---

## 完成标准
- `pnpm -r test` 全绿；studio/core `tsc --noEmit` 无错。
- 有曲库时：成片含 BGM，旁白清晰（ducking），段/截图切换落在节拍（漂移 ≤3 帧），强拍有轻微脉冲 + 音效。
- 无曲库 / `--no-bgm`：出片同现在，无报错。
- 分析失败 / 混音失败：降级出片，进度打 ⚠。
- 音频二进制与 .beats.json 不入库。

## 已知非纯代码成本
- Task 5 真渲 + 节拍验证须主控在 Node22 + melo venv（librosa）环境做。
- 强拍脉冲与 #root 慢放大的视觉叠加、ducking 参数（threshold/ratio）、BGM 音量（-18dB）需看真片调。
- 测试 BGM/SFX 素材主控用无版权音频；用户日常曲库自备。
