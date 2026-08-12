# 字幕时间轴真对齐（本地 ASR）

> 日期：2026-08-13　状态：设计已确认，待写实施计划

## 背景

烧进视频的字幕/旁白时间轴目前完全靠估算：`cuesFrom`（`packages/studio/src/tts.ts`）按「字数×0.28秒/句」给每句分配时长，从不看真实合成出来的音频。TTS 语速、停顿、标点长度都会让这个估算跟真实语音对不上——字幕比嘴慢半拍或提前切走是当前视频质量差的主因之一。

修复方向：TTS 合成出音频后，用本地开源 ASR（[faster-whisper](https://github.com/SYSTRAN/faster-whisper)）跑一遍，拿到真实的时间信息，把估算出来的 cue 时间轴换成真实对齐的。**只取 ASR 的时间戳，不用它识别出的文字**——展示的字幕内容仍然是我们自己生成的原文，ASR 认错几个字不影响显示内容，只影响对齐精度。这样即使识别有偏差，最坏情况也只是退回现在的估算方式，不会让字幕显示错别字。

## 功能设计

### 流程

```
TTS 合成音频(kokoro/melo/cosy/live)
  → faster-whisper 转写（word-level 时间戳）
  → Python 标准库 difflib 把 ASR 识别文字与我们自己的原文做字符级对齐
  → 对齐成功 → 把每句原文的起止时间换成 ASR 真实时间点
  → 对齐失败 / 匹配度太低 / stub 模式(静音) → 回落现有的「字数×0.28秒」估算，不报错、不阻断渲染
```

对齐算法用字符级序列匹配（`difflib.SequenceMatcher`，Python 标准库，不引入额外依赖）：ASR 输出的每个词展开成逐字符估算时间点（词内按字符数线性插值），拼成一条"ASR 字符流+时间"；再拿我们自己的原文字符串跟这条流做匹配，找出每句原文在 ASR 流里对应的字符区间，取区间两端的时间作为该句的 start/end。

失败判定：ASR 转写出的总字符数明显少于原文（如 <50%，通常意味着静音/合成失败/ASR 没跑起来）、或匹配到的字符比例太低，一律判定失败，Python 脚本返回 `{"ok": false, "reason": "..."}`，Node 侧原样保留现有估算 cues。

### 模型与环境

- 模型尺寸：`small`（约 500MB，CPU 上单条几秒到十几秒，中文识别够用——我们只要时间戳，不追求转写完美）。
- 新增 Python venv 变量 `FORGECAST_ASR_PYTHON`：缺省时回落到 `FORGECAST_MELO_PYTHON`（已装 melo 的用户零额外配置，`pip install faster-whisper` 装进同一个 venv 即可）；两者都空则 ASR 直接跳过（走估算，不报错）。
- 新脚本 `packages/studio/scripts/asr_align.py`，跟现有 `melo_infer.py`/`beat_grid.py` 一样的「薄封装真实开源库」写法：`spawn <asrPython> asr_align.py <wav_path> <sentences.json> <out.json>`，Node 侧读 `out.json`。
- faster-whisper 首次运行会自动从 Hugging Face 下载模型并缓存本地，无需手动下载步骤（跟现有 melo/cosy 的"首次装依赖"体验一致）。

### 容错

- ASR 未配置（两个 python 变量都空）→ 跳过，直接用估算 cues，不报错。
- ASR 进程超时/崩溃/输出不合法 JSON → 同上，捕获异常回落估算。
- stub TTS 模式（静音占位 wav）→ ASR 对着静音跑没有意义，字符匹配率会很低，天然触发失败回落；不额外加特判。
- 对齐结果的句子数量必须与传入的原文句子数量一致（一一对应），数量对不上直接判失败回落——不做"部分句子对齐、部分句子估算"的混合模式，保持简单。

### 性能

- ASR 是在 TTS 音频合成**之后**多加的一步，会给视频生成流程增加几秒到十几秒（small 模型，CPU）。这个开销可接受——比 cosy 模式配音本身的 RTF 2.75x 慢得多的场景都能接受。
- 超时保护：沿用项目里 `TTS_SPAWN_TIMEOUT_MS`（180s）同一套超时机制，避免 ASR 卡死拖垮整条渲染流水线。

## 技术落点

- **新文件** `packages/studio/scripts/asr_align.py`：faster-whisper 转写 + difflib 字符对齐，输出 `{"ok": bool, "cues"?: [{start,end}], "reason"?: string}`。
- **新文件** `packages/studio/src/asr.ts`：`alignCues(wavAbs: string, sentences: string[], asrPython: string, deps?): Promise<{start:number,end:number}[] | null>`——spawn 脚本、读结果、失败返 `null`。签名/实现风格镜像 `hyperframes.ts` 里的 `analyzeBeats`。
- **修改** `packages/studio/src/tts.ts` 的 `synthesizeVoice`：TTS 音频合成成功后（kokoro/melo/cosy/live 四个真实模式，stub 不需要），调用 `alignCues`；拿到非 null 结果就替换掉 `cuesFrom` 算出来的估算 cues，否则保留估算值。
- **修改** `packages/core/src/config.ts`：`ForgecastConfig.tts` 加 `asrPython: string`（`FORGECAST_ASR_PYTHON || FORGECAST_MELO_PYTHON || ''`，跟现有 `beatPython` 回落 `meloPython` 的写法一致）。
- **修改** `docs/hyperframes-deploy.md`：加一节「本地 ASR 对齐字幕（`FORGECAST_ASR_PYTHON`）」，跟现有 MeloTTS/CosyVoice2 小节同样的格式（venv 搭建命令、模型说明、fail-soft 说明）。
- **修改** `README.md`：环境变量表加 `FORGECAST_ASR_PYTHON` 一行。

## 不做的事

- 不做词级字幕高亮/卡拉OK效果——只是把句子级字幕的起止时间对得更准，不改字幕的展示粒度（仍是 `splitSentences` 切出来的句子级 cue）。
- 不给 ASR 结果做人工复核/编辑界面——对齐失败就静默回落估算，不阻断、不额外提示用户去修。
- 不支持云端 ASR API（火山引擎/阿里云等）——按讨论结果只做本地开源方案，不给项目增加必须联网的外部依赖。
- 不改动 TTS 本身的音质/选型——这轮只修字幕时间轴，不动 kokoro/melo/cosy/live 的选择逻辑。

## 验证

- `packages/studio/test/asr.test.ts`（新）：mock spawn 的 python 进程（跟 `melo_infer`/`analyzeBeats` 测试同款写法）——对齐成功返回句子数匹配的 cues；对齐失败/超时/JSON 解析失败均返回 `null`；`asrPython` 为空字符串时不 spawn、直接返回 `null`。
- `packages/studio/test/tts.test.ts` 补用例：`synthesizeVoice` 在真实 TTS 模式下，`alignCues` mock 返回成功结果时，最终 cues 用的是对齐结果而不是估算值；mock 返回 `null` 时仍用估算值（回归，不破坏现有行为）。
- `tsc --noEmit`（studio/core 包类型检查）。
- 手工验证（需要本地装好 `FORGECAST_ASR_PYTHON` venv + faster-whisper）：生成一条真实视频（kokoro 或 melo 模式），抽帧检查字幕出现时机与旁白语音是否对上；对比修复前后同一条素材的字幕时间轴差异。
