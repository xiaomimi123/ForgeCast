# 字幕时间轴真对齐（本地 ASR）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** TTS 合成出真实音频后，用本地 faster-whisper 转写+对齐，把字幕/旁白的估算时间轴换成对齐真实语音的时间轴；对齐失败一律静默回落现有估算，不阻断视频生成。

**Architecture:** 新 Python 脚本 `asr_align.py`（faster-whisper 转写 + `difflib` 字符级对齐原文，只吐时间戳不吐识别文字）→ 新 TS 包装函数 `alignCues`（spawn 脚本、读 JSON、失败返 null，跟现有 `analyzeBeats` 同款写法）→ `synthesizeVoice` 在真实 TTS（kokoro/melo/cosy/live）合成成功后调用它，替换掉原来纯估算的 cues。

**Tech Stack:** TypeScript, pnpm monorepo, vitest；Python 3 + faster-whisper（CTranslate2 重实现的 Whisper）+ 标准库 `difflib`。

## Global Constraints

- Node 22：跑任何 pnpm 命令前 `export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH"`（better-sqlite3 ABI）。
- **只对齐时间，不替换文字**：字幕/旁白展示的内容永远是我们自己生成的原文（`sentences`），ASR 识别出的文字只用来算时间戳、绝不进最终 `Cue.text`。
- **fail-soft，绝不因 ASR 而中断视频生成**：`asrPython` 未配置、脚本超时/崩溃/输出非法 JSON、句子数对不上，一律返回 `null`，调用方回落现有的按字数估算的 cues；不抛错、不改变现有函数的错误处理契约。
- 新增环境变量 `FORGECAST_ASR_PYTHON`：缺省时回落 `FORGECAST_MELO_PYTHON`（跟 `video.beatPython` 回落 `meloPython` 同样的写法，`packages/core/src/config.ts` 里已有先例）。两者都空 → `asrPython` 为空串 → `alignCues` 直接返回 `null`，不 spawn。
- `asrPython` **不**加进 `packages/core/src/settings.ts` 的 `SETTING_KEYS`（不走设置页 UI）——它和 `beatPython` 一样是技术性的 venv 路径配置，只走 `.env`/环境变量，这是仓库里 `beatPython` 已有的先例，本轮不新开设置页入口。
- 每个新增/改动的 TS 函数先写失败测试、跑确认失败、再实现、跑确认通过（TDD）；Python 脚本本身不进 vitest 套件（跟现有 `melo_infer.py`/`beat_grid.py`/`cosy_infer.py` 一致，脚本靠人工跑通验证，TS 侧只测 spawn 包装层，用注入的 mock `run` 函数模拟脚本行为）。
- 中文注释/commit message；commit message 末尾带 `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`。

---

## Task 1: Python 脚本 `asr_align.py`

**Files:**
- Create: `packages/studio/scripts/asr_align.py`

**Interfaces:**
- Consumes：CLI 参数 `<wav_path> <sentences_json_path> <out_json_path>`；`sentences_json_path` 内容是 `["句子1","句子2",...]`（原文，句子级，UTF-8 JSON 数组）。
- Produces：往 `out_json_path` 写 `{"ok": true, "cues": [{"start": number, "end": number}, ...]}`（数组长度必须等于输入句子数，按顺序一一对应）或 `{"ok": false, "reason": "<字符串>"}`。

这个脚本不进 vitest 套件（跟仓库里其它 python 脚本一致），Task 3 会给它的 Node 包装层（`alignCues`）写完整的 mock 测试。本 Task 只要求脚本本身逻辑正确、可独立运行。

- [ ] **Step 1: 写脚本**

```python
#!/usr/bin/env python
"""字幕真对齐：<python> asr_align.py <wav> <sentences.json> <out.json>
faster-whisper 转写出词级时间戳，只用来对时间——识别出的文字本身丢弃不用，
我们展示的字幕内容始终是调用方传入的原文（sentences.json）。
对齐用标准库 difflib 做字符级序列匹配：把 ASR 转写的每个词展开成逐字符时间
（词内线性插值），拼成一条"ASR 字符流"，再跟原文整体拼接做 SequenceMatcher，
把每句原文的字符区间映射到 ASR 字符流上对应的时间区间。
任何一步失败（字符匹配率过低、某句完全没匹配上）都写 {"ok": false, "reason": ...}，
调用方（Node 侧 alignCues）据此回落到按字数估算的旧逻辑，不当成异常处理。
需要 faster-whisper（pip install faster-whisper，装进 FORGECAST_ASR_PYTHON 指向
的 venv；见 docs/hyperframes-deploy.md）。"""
import difflib
import json
import sys

MODEL_SIZE = "small"
MIN_MATCH_RATIO = 0.5  # 匹配到的字符占原文总字符数的最低比例，低于此判定对齐失败


def fail(out_path, reason):
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump({"ok": False, "reason": reason}, f)


def main():
    wav_path, sentences_path, out_path = sys.argv[1], sys.argv[2], sys.argv[3]
    with open(sentences_path, encoding="utf-8") as f:
        sentences = json.load(f)

    if not sentences:
        return fail(out_path, "无原文句子")

    from faster_whisper import WhisperModel

    model = WhisperModel(MODEL_SIZE, device="cpu", compute_type="int8")
    segments, _ = model.transcribe(wav_path, word_timestamps=True, language="zh")

    asr_chars = []
    asr_times = []
    for seg in segments:
        for w in seg.words:
            word = w.word.strip()
            if not word:
                continue
            n = len(word)
            span = (w.end - w.start) / n
            for i, ch in enumerate(word):
                asr_chars.append(ch)
                asr_times.append((w.start + i * span, w.start + (i + 1) * span))

    if not asr_chars:
        return fail(out_path, "ASR 未识别出任何文字（可能是静音音轨）")

    full_text = "".join(sentences)
    asr_text = "".join(asr_chars)

    sm = difflib.SequenceMatcher(None, full_text, asr_text, autojunk=False)
    matched = [None] * len(full_text)  # full_text 下标 → asr_chars 下标（未匹配为 None）
    total_matched = 0
    for block in sm.get_matching_blocks():
        for k in range(block.size):
            matched[block.a + k] = block.b + k
            total_matched += 1

    if len(full_text) == 0 or total_matched / len(full_text) < MIN_MATCH_RATIO:
        return fail(out_path, f"字符匹配率过低（{total_matched}/{len(full_text)}）")

    cues = []
    offset = 0
    last_end = 0.0
    for s in sentences:
        n = len(s)
        idxs = [matched[offset + i] for i in range(n) if matched[offset + i] is not None]
        offset += n
        if not idxs:
            return fail(out_path, "存在句子完全未匹配到 ASR 结果")
        start = asr_times[min(idxs)][0]
        end = asr_times[max(idxs)][1]
        if start < last_end:
            start = last_end
        if end < start:
            end = start + 0.1
        cues.append({"start": round(start, 3), "end": round(end, 3)})
        last_end = end

    with open(out_path, "w", encoding="utf-8") as f:
        json.dump({"ok": True, "cues": cues}, f)


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: 加可执行权限**

```bash
chmod +x packages/studio/scripts/asr_align.py
```

- [ ] **Step 3: 提交**

```bash
git add packages/studio/scripts/asr_align.py
git commit -m "feat(studio): asr_align.py——faster-whisper 转写+difflib 字符对齐，只吐时间戳"
```

---

## Task 2: 配置项 `FORGECAST_ASR_PYTHON`

**Files:**
- Modify: `packages/core/src/config.ts`
- Modify: `packages/core/test/config.test.ts`

**Interfaces:**
- Produces：`ForgecastConfig.tts.asrPython: string`（`FORGECAST_ASR_PYTHON || FORGECAST_MELO_PYTHON || ''`）。

- [ ] **Step 1: 改现有测试（这两个用 `toEqual` 做完整对象比对的用例，加字段后不改会一直挂红）**

`packages/core/test/config.test.ts` 第 49-52 行原样：

```ts
  it('tts 可设 stub，可设 live', () => {
    expect(loadConfig('/tmp/x', { FORGECAST_TTS_MODE: 'stub' }).tts).toEqual({ mode: 'stub', baseURL: 'https://aitoken.homes/v1', apiKey: '', model: '', voice: '', meloPython: '', cosyHome: '' })
    const cfg = loadConfig('/tmp/x', { FORGECAST_TTS_MODE: 'live', FORGECAST_TTS_KEY: 'k', FORGECAST_TTS_MODEL: 'm', FORGECAST_TTS_VOICE: 'v' })
    expect(cfg.tts).toEqual({ mode: 'live', baseURL: 'https://aitoken.homes/v1', apiKey: 'k', model: 'm', voice: 'v', meloPython: '', cosyHome: '' })
  })
```

改成（每个对象字面量补 `asrPython: ''`）：

```ts
  it('tts 可设 stub，可设 live', () => {
    expect(loadConfig('/tmp/x', { FORGECAST_TTS_MODE: 'stub' }).tts).toEqual({ mode: 'stub', baseURL: 'https://aitoken.homes/v1', apiKey: '', model: '', voice: '', meloPython: '', cosyHome: '', asrPython: '' })
    const cfg = loadConfig('/tmp/x', { FORGECAST_TTS_MODE: 'live', FORGECAST_TTS_KEY: 'k', FORGECAST_TTS_MODEL: 'm', FORGECAST_TTS_VOICE: 'v' })
    expect(cfg.tts).toEqual({ mode: 'live', baseURL: 'https://aitoken.homes/v1', apiKey: 'k', model: 'm', voice: 'v', meloPython: '', cosyHome: '', asrPython: '' })
  })
```

- [ ] **Step 2: 写新失败测试** — 整个测试文件是一个 `describe('loadConfig', () => { ... })` 块，文件末尾原样是：

```ts
  it('video 配置含 bgm 与 beatPython（beatPython 默认回落 melo）', () => {
    const c = loadConfig('/tmp/x', { FORGECAST_MELO_PYTHON: '/venv/melo/py' })
    expect(c.video.bgm).toBe('')
    expect(c.video.beatPython).toBe('/venv/melo/py')
    const c2 = loadConfig('/tmp/x', { FORGECAST_BGM: 'none', FORGECAST_BEAT_PYTHON: '/venv/beat/py' })
    expect(c2.video.bgm).toBe('none')
    expect(c2.video.beatPython).toBe('/venv/beat/py')
  })
})
```

在这个 `it` 块之后、外层 `describe` 收尾的 `})` 之前插入新用例（新用例要留在 `describe('loadConfig', ...)` 内部，不能落到外面），改成：

```ts
  it('video 配置含 bgm 与 beatPython（beatPython 默认回落 melo）', () => {
    const c = loadConfig('/tmp/x', { FORGECAST_MELO_PYTHON: '/venv/melo/py' })
    expect(c.video.bgm).toBe('')
    expect(c.video.beatPython).toBe('/venv/melo/py')
    const c2 = loadConfig('/tmp/x', { FORGECAST_BGM: 'none', FORGECAST_BEAT_PYTHON: '/venv/beat/py' })
    expect(c2.video.bgm).toBe('none')
    expect(c2.video.beatPython).toBe('/venv/beat/py')
  })
  it('asrPython 可显式设置，未设时回落 meloPython，都不设为空串', () => {
    const explicit = loadConfig('/tmp/x', { FORGECAST_ASR_PYTHON: '/venv/asr/py', FORGECAST_MELO_PYTHON: '/venv/melo/py' })
    expect(explicit.tts.asrPython).toBe('/venv/asr/py')
    const fallback = loadConfig('/tmp/x', { FORGECAST_MELO_PYTHON: '/venv/melo/py' })
    expect(fallback.tts.asrPython).toBe('/venv/melo/py')
    const empty = loadConfig('/tmp/x', {})
    expect(empty.tts.asrPython).toBe('')
  })
})
```

- [ ] **Step 3: 跑测试确认失败**

Run: `export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH" && pnpm --filter @forgecast/core test config`
Expected: FAIL（`asrPython` 属性不存在/`toEqual` 对象不匹配）

- [ ] **Step 4: 实现** — `packages/core/src/config.ts`

`ForgecastConfig` 接口里 `tts` 字段（现为 `{ mode: TtsMode; baseURL: string; apiKey: string; model: string; voice: string; meloPython: string; cosyHome: string }`）改成：

```ts
  tts: { mode: TtsMode; baseURL: string; apiKey: string; model: string; voice: string; meloPython: string; cosyHome: string; asrPython: string }
```

`loadConfig` 里 `tts: { ... }` 对象字面量（现以 `cosyHome: env.FORGECAST_COSY_HOME ?? '',` 结尾）补一行：

```ts
      cosyHome: env.FORGECAST_COSY_HOME ?? '',
      // 字幕对齐用 ASR 的 venv；缺省回落 meloPython（跟 video.beatPython 同样的回落写法）
      asrPython: env.FORGECAST_ASR_PYTHON || env.FORGECAST_MELO_PYTHON || '',
```

- [ ] **Step 5: 跑测试确认通过**

Run: `export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH" && pnpm --filter @forgecast/core test config`
Expected: PASS

- [ ] **Step 6: 跑 core 全量确认无回归**

Run: `export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH" && pnpm --filter @forgecast/core test`
Expected: PASS（全绿，注意 `ctx.test.ts` 等其它文件不受影响）

- [ ] **Step 7: 提交**

```bash
git add packages/core/src/config.ts packages/core/test/config.test.ts
git commit -m "feat(core): tts.asrPython 配置项（FORGECAST_ASR_PYTHON，回落 meloPython）"
```

---

## Task 3: `alignCues` TS 包装函数

**Files:**
- Modify: `packages/studio/src/hyperframes.ts`（把 `spawnWithTimeout` 改为具名导出，供 `asr.ts` 复用）
- Create: `packages/studio/src/asr.ts`
- Create: `packages/studio/test/asr.test.ts`

**Interfaces:**
- Consumes：`hyperframes.ts` 导出的 `spawnWithTimeout(args: string[], opts: { cmd?: string; cwd?: string; timeoutMs: number; label: string; onStdout?: (s: string) => void }): Promise<void>`。
- Produces：
  - `interface AlignedCue { start: number; end: number }`
  - `interface AsrDeps { run?: (args: string[]) => Promise<void> }`
  - `alignCues(wavAbs: string, sentences: string[], asrPython: string, deps?: AsrDeps): Promise<AlignedCue[] | null>`

- [ ] **Step 1: 导出 `spawnWithTimeout`** — `packages/studio/src/hyperframes.ts`

第 23 行原样：

```ts
function spawnWithTimeout(args: string[], opts: { cmd?: string; cwd?: string; timeoutMs: number; label: string; onStdout?: (s: string) => void }): Promise<void> {
```

改成加 `export`：

```ts
export function spawnWithTimeout(args: string[], opts: { cmd?: string; cwd?: string; timeoutMs: number; label: string; onStdout?: (s: string) => void }): Promise<void> {
```

（此文件里其它调用 `spawnWithTimeout(...)` 的地方不用改，同文件内直接引用具名导出函数照常工作。）

- [ ] **Step 2: 写失败测试** — `packages/studio/test/asr.test.ts`

```ts
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { alignCues } from '../src/asr'

describe('alignCues', () => {
  it('asrPython 为空串时直接返回 null，不 spawn', async () => {
    const run = vi.fn()
    const r = await alignCues('/fake.wav', ['第一句', '第二句'], '', { run })
    expect(run).not.toHaveBeenCalled()
    expect(r).toBeNull()
  })

  it('sentences 为空数组时直接返回 null，不 spawn', async () => {
    const run = vi.fn()
    const r = await alignCues('/fake.wav', [], '/fake/py', { run })
    expect(run).not.toHaveBeenCalled()
    expect(r).toBeNull()
  })

  it('脚本成功、句子数匹配 → 返回对齐结果', async () => {
    const run = vi.fn(async (args: string[]) => {
      const outPath = args[3]
      fs.writeFileSync(outPath, JSON.stringify({ ok: true, cues: [{ start: 0, end: 1.2 }, { start: 1.2, end: 2.5 }] }))
    })
    const r = await alignCues('/fake.wav', ['第一句', '第二句'], '/fake/py', { run })
    expect(run).toHaveBeenCalledOnce()
    expect(r).toEqual([{ start: 0, end: 1.2 }, { start: 1.2, end: 2.5 }])
  })

  it('脚本返回 ok:false → 返回 null', async () => {
    const run = vi.fn(async (args: string[]) => {
      fs.writeFileSync(args[3], JSON.stringify({ ok: false, reason: '字符匹配率过低' }))
    })
    const r = await alignCues('/fake.wav', ['第一句'], '/fake/py', { run })
    expect(r).toBeNull()
  })

  it('脚本返回的 cues 数量与句子数不符 → 返回 null（不信任部分对齐结果）', async () => {
    const run = vi.fn(async (args: string[]) => {
      fs.writeFileSync(args[3], JSON.stringify({ ok: true, cues: [{ start: 0, end: 1 }] }))
    })
    const r = await alignCues('/fake.wav', ['第一句', '第二句'], '/fake/py', { run })
    expect(r).toBeNull()
  })

  it('spawn 抛错（超时/崩溃）→ 返回 null，不向上抛异常', async () => {
    const run = vi.fn(async () => { throw new Error('asr_align 超时（180000ms）已终止') })
    const r = await alignCues('/fake.wav', ['第一句'], '/fake/py', { run })
    expect(r).toBeNull()
  })

  it('out.json 内容不是合法 JSON → 返回 null', async () => {
    const run = vi.fn(async (args: string[]) => { fs.writeFileSync(args[3], 'not json') })
    const r = await alignCues('/fake.wav', ['第一句'], '/fake/py', { run })
    expect(r).toBeNull()
  })

  it('把 sentences 写进临时 JSON 文件传给脚本', async () => {
    let sentencesFileContent = ''
    const run = vi.fn(async (args: string[]) => {
      sentencesFileContent = fs.readFileSync(args[2], 'utf8')
      fs.writeFileSync(args[3], JSON.stringify({ ok: true, cues: [{ start: 0, end: 1 }] }))
    })
    await alignCues('/fake.wav', ['第一句'], '/fake/py', { run })
    expect(JSON.parse(sentencesFileContent)).toEqual(['第一句'])
  })
})
```

> 注：`run` 的签名是 `(args: string[]) => Promise<void>`，`args` 依次是 `[ASR_SCRIPT, wavAbs, sentencesPath, outPath]`（下标 0/1/2/3）——所有用例里 `args[3]` 是 `outPath`，「把 sentences 写进临时 JSON」这条用例额外读的 `args[2]` 是 `sentencesPath`。

- [ ] **Step 3: 跑测试确认失败**

Run: `export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH" && pnpm --filter @forgecast/studio test asr`
Expected: FAIL（`Cannot find module '../src/asr'`）

- [ ] **Step 4: 实现** — `packages/studio/src/asr.ts`

```ts
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnWithTimeout } from './hyperframes'

export interface AlignedCue { start: number; end: number }
export interface AsrDeps { run?: (args: string[]) => Promise<void> }

// 脚本相对本文件：packages/studio/src → packages/studio/scripts
const ASR_SCRIPT = fileURLToPath(new URL('../scripts/asr_align.py', import.meta.url))
const ASR_TIMEOUT_MS = 180_000

/**
 * 用本地 faster-whisper 转写 TTS 合成出的音频、跟原文句子做字符级对齐，拿真实起止时间。
 * 只用 ASR 的时间信息，识别出的文字本身丢弃不用——调用方展示的字幕内容始终是传入的 sentences。
 * asrPython 为空、sentences 为空、脚本超时/崩溃/输出非法、返回句子数对不上，均返回 null——
 * 调用方据此回落现有的按字数估算逻辑，这里绝不抛错。
 */
export async function alignCues(
  wavAbs: string, sentences: string[], asrPython: string, deps: AsrDeps = {},
): Promise<AlignedCue[] | null> {
  if (!asrPython || sentences.length === 0) return null
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-asr-'))
  const sentencesPath = path.join(dir, 'sentences.json')
  const outPath = path.join(dir, 'out.json')
  try {
    fs.writeFileSync(sentencesPath, JSON.stringify(sentences))
    const run = deps.run ?? ((args: string[]) => spawnWithTimeout(args, { cmd: asrPython, timeoutMs: ASR_TIMEOUT_MS, label: 'asr_align' }))
    await run([ASR_SCRIPT, wavAbs, sentencesPath, outPath])
    const result = JSON.parse(fs.readFileSync(outPath, 'utf8'))
    if (!result.ok || !Array.isArray(result.cues) || result.cues.length !== sentences.length) return null
    return result.cues
  } catch {
    return null
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH" && pnpm --filter @forgecast/studio test asr`
Expected: PASS（8 个用例全绿）

- [ ] **Step 6: 跑 studio 全量确认无回归（`spawnWithTimeout` 加 export 不该影响任何现有测试）**

Run: `export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH" && pnpm --filter @forgecast/studio test`
Expected: PASS（全绿）

- [ ] **Step 7: 提交**

```bash
git add packages/studio/src/hyperframes.ts packages/studio/src/asr.ts packages/studio/test/asr.test.ts
git commit -m "feat(studio): alignCues——spawn asr_align.py 拿真实字幕时间轴，失败回落 null"
```

---

## Task 4: 接入 `synthesizeVoice`

**Files:**
- Modify: `packages/studio/src/tts.ts`
- Modify: `packages/studio/test/tts.test.ts`

**Interfaces:**
- Consumes：Task 3 的 `alignCues(wavAbs, sentences, asrPython, deps?): Promise<AlignedCue[] | null>`；`ctx.config.tts.asrPython`（Task 2）。
- Produces：`synthesizeVoice` 的 `TtsDeps` 接口新增可选 `alignCues?: (wavAbs: string, sentences: string[], asrPython: string) => Promise<AlignedCue[] | null>`（测试注入用，生产环境不传，默认走真实 `alignCues`）。`VoiceResult.cues` 在真实 TTS（kokoro/melo/cosy/live）合成成功时，若 ASR 对齐成功则用对齐后的真实时间，否则保留原有的按字数估算时间——这个回落行为对调用方完全透明，`VoiceResult` 的形状不变。

- [ ] **Step 1: 写失败测试** — 追加到 `packages/studio/test/tts.test.ts`（放在文件末尾，`describe('synthesizeVoice cosy', ...)` 之后）

```ts
describe('synthesizeVoice ASR 对齐', () => {
  it('kokoro 成功后 ASR 对齐成功 → cues 用对齐结果而非估算值', async () => {
    const out = path.join(root, 'workspace/demo/videos/asr-ok.wav')
    const config = loadConfig(root, { FORGECAST_TTS_MODE: 'kokoro' })
    const kctx: CoreCtx = { db: ctx.db, config, llm: ctx.llm }
    const runKokoro = vi.fn(async (_text: string, outPath: string) => {
      fs.mkdirSync(path.dirname(outPath), { recursive: true })
      fs.writeFileSync(outPath, Buffer.from([1, 2, 3, 4]))
    })
    const alignCuesMock = vi.fn(async () => [{ start: 0.5, end: 1.9 }])
    const r = await synthesizeVoice(kctx, '一句话。', out, { runKokoro, alignCues: alignCuesMock })
    expect(alignCuesMock).toHaveBeenCalledWith(out, ['一句话'], '')
    expect(r.cues).toEqual([{ start: 0.5, end: 1.9, text: '一句话' }])
  })

  it('kokoro 成功但 ASR 对齐失败(返回 null) → cues 仍是原来的估算值（回归）', async () => {
    const out = path.join(root, 'workspace/demo/videos/asr-fail.wav')
    const config = loadConfig(root, { FORGECAST_TTS_MODE: 'kokoro' })
    const kctx: CoreCtx = { db: ctx.db, config, llm: ctx.llm }
    const runKokoro = vi.fn(async (_text: string, outPath: string) => {
      fs.mkdirSync(path.dirname(outPath), { recursive: true })
      fs.writeFileSync(outPath, Buffer.from([1, 2, 3, 4]))
    })
    const alignCuesMock = vi.fn(async () => null)
    const r = await synthesizeVoice(kctx, '一句话。', out, { runKokoro, alignCues: alignCuesMock })
    expect(alignCuesMock).toHaveBeenCalledOnce()
    expect(r.cues.length).toBe(1)
    expect(r.cues[0].text).toBe('一句话')
    expect(r.cues[0].start).toBe(0) // 原有估算逻辑：首句从 0 开始
  })

  it('stub 模式不调用 alignCues（没有真实音频可对齐）', async () => {
    // 注意：外层 beforeEach 的 ctx 用 loadConfig(root, {}) 建，TTS 默认模式是 kokoro 不是
    // stub（config.ts 未设 FORGECAST_TTS_MODE 时回落 'kokoro'）——这里必须显式建一个
    // stub 模式的 ctx，不能直接用外层 ctx，否则会真的尝试 spawn kokoro。
    const out = path.join(root, 'workspace/demo/videos/asr-stub.wav')
    const config = loadConfig(root, { FORGECAST_TTS_MODE: 'stub' })
    const stubCtx: CoreCtx = { db: ctx.db, config, llm: ctx.llm }
    const alignCuesMock = vi.fn(async () => [{ start: 0, end: 1 }])
    const r = await synthesizeVoice(stubCtx, '一句话。', out, { alignCues: alignCuesMock })
    expect(alignCuesMock).not.toHaveBeenCalled()
    expect(r.cues[0].text).toBe('一句话')
  })

  it('TTS 本身失败(降级 stub) → 不调用 alignCues', async () => {
    const out = path.join(root, 'workspace/demo/videos/asr-degrade.wav')
    const config = loadConfig(root, { FORGECAST_TTS_MODE: 'kokoro' })
    const kctx: CoreCtx = { db: ctx.db, config, llm: ctx.llm }
    const runKokoro = vi.fn(async () => { throw new Error('kokoro-onnx 未安装') })
    const alignCuesMock = vi.fn(async () => [{ start: 0, end: 1 }])
    const r = await synthesizeVoice(kctx, '一句话。', out, { runKokoro, alignCues: alignCuesMock })
    expect(alignCuesMock).not.toHaveBeenCalled()
    expect(r.degraded).toContain('kokoro-onnx 未安装')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH" && pnpm --filter @forgecast/studio test tts`
Expected: FAIL（`alignCues` 不是 `TtsDeps` 的已知属性 / 实际 cues 仍是估算值，断言不通过）

- [ ] **Step 3: 实现** — `packages/studio/src/tts.ts`

顶部 import 区加一行：

```ts
import { alignCues, type AlignedCue } from './asr'
```

`TtsDeps` 接口（现有 4 个字段）追加：

```ts
export interface TtsDeps {
  runKokoro?: (text: string, outWavAbs: string) => Promise<void>
  runMelo?: (text: string, outWavAbs: string) => Promise<void>
  runCosy?: (text: string, outWavAbs: string) => Promise<void>
  fetchImpl?: typeof fetch
  alignCues?: (wavAbs: string, sentences: string[], asrPython: string) => Promise<AlignedCue[] | null>
}
```

`synthesizeVoice` 函数体开头（现在是）：

```ts
export async function synthesizeVoice(
  ctx: CoreCtx, text: string, outWavAbs: string, deps: TtsDeps = {},
): Promise<VoiceResult> {
  const rel = path.relative(ctx.config.paths.workspace, outWavAbs)
  // 去舞台提示后再念/切句：TTS 不念【节奏标记】（画面指示），字幕也用干净文本
  const clean = cleanNarrationText(text)
  const cues = cuesFrom(splitSentences(clean))
  const writeStub = () => { fs.mkdirSync(path.dirname(outWavAbs), { recursive: true }); fs.writeFileSync(outWavAbs, minimalWav()) }
  const degrade = (reason: string): VoiceResult => { writeStub(); return { audioRel: rel, cues, degraded: reason } }

  if (ctx.config.tts.mode === 'stub') {
    writeStub()
    return { audioRel: rel, cues }
  }
```

改成：

```ts
export async function synthesizeVoice(
  ctx: CoreCtx, text: string, outWavAbs: string, deps: TtsDeps = {},
): Promise<VoiceResult> {
  const rel = path.relative(ctx.config.paths.workspace, outWavAbs)
  // 去舞台提示后再念/切句：TTS 不念【节奏标记】（画面指示），字幕也用干净文本
  const clean = cleanNarrationText(text)
  const sentences = splitSentences(clean)
  const estimatedCues = cuesFrom(sentences)
  const writeStub = () => { fs.mkdirSync(path.dirname(outWavAbs), { recursive: true }); fs.writeFileSync(outWavAbs, minimalWav()) }
  const degrade = (reason: string): VoiceResult => { writeStub(); return { audioRel: rel, cues: estimatedCues, degraded: reason } }
  // 真实语音合成成功后才有音频可对齐：用本地 ASR 拿真实时间轴，失败/未配置则回落估算——对调用方透明
  const finish = async (): Promise<VoiceResult> => {
    const run = deps.alignCues ?? alignCues
    const aligned = await run(outWavAbs, sentences, ctx.config.tts.asrPython)
    const cues = aligned ? aligned.map((c, i) => ({ start: c.start, end: c.end, text: sentences[i] })) : estimatedCues
    return { audioRel: rel, cues }
  }

  if (ctx.config.tts.mode === 'stub') {
    writeStub()
    return { audioRel: rel, cues: estimatedCues }
  }
```

再往下，`kokoro`/`melo`/`cosy`/`live` 四个分支里，每个分支成功路径原来的 `return { audioRel: rel, cues }`（共 4 处：kokoro 分支、melo 分支、cosy 分支、live 分支末尾），全部改成：

```ts
      return await finish()
```

live 分支末尾那一处原样是：

```ts
    return { audioRel: rel, cues } // 真实时间轴待接 ASR，暂用估算
```

这行注释是改动前的状态说明，现在真接了 ASR，注释连同 `cues` 一起换掉，改成：

```ts
    return await finish()
```

（4 个分支各自的 `try`/`catch`、`degrade(...)` 调用不变——`degrade` 已经在上面改成读 `estimatedCues` 了，`cues`/`estimatedCues` 是新旧变量名的唯一区别，其余错误处理逻辑原样保留。）

- [ ] **Step 4: 跑测试确认通过**

Run: `export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH" && pnpm --filter @forgecast/studio test tts`
Expected: PASS（新增 4 个用例 + 原有全部通过）

- [ ] **Step 5: 跑 studio 全量确认无回归**

Run: `export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH" && pnpm --filter @forgecast/studio test`
Expected: PASS（全绿）

- [ ] **Step 6: 提交**

```bash
git add packages/studio/src/tts.ts packages/studio/test/tts.test.ts
git commit -m "feat(studio): synthesizeVoice 接入 ASR 真对齐，失败透明回落估算 cues"
```

---

## Task 5: 文档 + 全仓验证

**Files:**
- Modify: `docs/hyperframes-deploy.md`
- Modify: `README.md`

- [ ] **Step 1: `docs/hyperframes-deploy.md` 加一节** — 在现有 `### CosyVoice2 本地克隆配音（cosy 模式）` 小节之后（文件末尾附近）追加：

向 `docs/hyperframes-deploy.md` 追加下面这段（注意：这段本身含有内嵌的 ```bash 代码块，下面用四个反引号包裹整段，实际写入文件时不要把四反引号写进去，只写里面的内容）：

````markdown

### 字幕真对齐（faster-whisper，`FORGECAST_ASR_PYTHON`）

TTS 合成音频后，若配置了 `FORGECAST_ASR_PYTHON`（或已有 `FORGECAST_MELO_PYTHON`，缺省会自动回落），
会用本地 [faster-whisper](https://github.com/SYSTRAN/faster-whisper)（CTranslate2 重实现的 Whisper）
转写出真实词级时间戳，跟原文做字符级对齐，把字幕/旁白从"按字数估算时长"换成真实语音对齐的时间轴。
**只用 ASR 的时间信息，不用它识别出的文字**——字幕显示内容永远是我们自己生成的原文，识别偶尔认错字
不影响显示、只影响对齐精度；对齐失败（静音、匹配率过低）会静默回落原有估算，不阻断视频生成。

复用 melo 的 venv（装了 melo 就免配置）：

```bash
uv pip install --python ~/.forgecast-venvs/melo/bin/python faster-whisper
export FORGECAST_ASR_PYTHON=~/.forgecast-venvs/melo/bin/python
```

或单独建一个 venv：

```bash
uv venv --python 3.11 ~/.forgecast-venvs/asr
uv pip install --python ~/.forgecast-venvs/asr/bin/python faster-whisper
export FORGECAST_ASR_PYTHON=~/.forgecast-venvs/asr/bin/python
```

模型用 `small`（约 500MB，首次运行自动从 Hugging Face 下载并缓存，无需手动下载步骤），
CPU 上单条几秒到十几秒。不配置这个变量视频照常生成，只是字幕退回估算时间轴。
````

- [ ] **Step 2: `README.md` 环境变量表加一行** — 在 `FORGECAST_BEAT_PYTHON` 那一行之后加：

```markdown
| FORGECAST_ASR_PYTHON | 字幕真对齐用的本地 faster-whisper venv；缺省回落 FORGECAST_MELO_PYTHON；都不配则字幕退回按字数估算时间轴（不影响视频生成） |
```

- [ ] **Step 3: 全仓验证**

```bash
export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH"
pnpm test
pnpm --filter web exec tsc --noEmit
pnpm --filter web build
```

Expected: 全部通过。

- [ ] **Step 4: 提交**

```bash
git add docs/hyperframes-deploy.md README.md
git commit -m "docs: 字幕真对齐（FORGECAST_ASR_PYTHON）部署说明"
```

---

## 收尾（不在 SDD 自动任务范围内，需人工/后续会话补做）

- 手工验证需要本地装好 `FORGECAST_ASR_PYTHON` venv + faster-whisper：生成一条真实视频（kokoro 或 melo 模式），抽帧检查字幕出现时机与旁白语音是否对上；对比修复前后同一条素材的字幕时间轴差异。
- 若手工验证发现对齐质量不理想（比如匹配率阈值 `MIN_MATCH_RATIO=0.5` 不合适），回来调 `asr_align.py` 里的阈值常量即可，不需要改架构。
