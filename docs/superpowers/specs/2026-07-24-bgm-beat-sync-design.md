# BGM 背景音乐 + 卡点剪切 + 强拍音效（子项目①）设计

> 日期：2026-07-24　状态：设计已确认，待实施
>
> 借鉴 [video-shotcraft](https://github.com/Vincentwei1021/video-shotcraft) 的 librosa 节拍网格拟合技法，落到 forgecast 的 HyperFrames 视频管线（秒级 `data-start`）。
>
> **本 spec 只覆盖子项目①（核心：BGM + 卡点 + 音效）**。②情绪匹配自动选曲、③卡点编辑界面各自独立 spec，依赖①先落地。

## 目标

现有视频只有旁白、没背景乐，段切换是固定均分。加：
1. **BGM 背景音乐**——本地曲库，垫在旁白下面，旁白响时自动 ducking 闪避。
2. **卡点剪切**——段边界、demo 截图切换吸附到 BGM 节拍，画面跟音乐切。
3. **强拍动画 + 音效**——鼓点重拍上加轻微缩放脉冲 + 音效"哚"。

抖音/小红书的音乐床 + 卡点是专业感的关键，这是继四模板/配音后画面质感的大提升。

## 架构

**节拍分析 + 卡点在 generate 算；BGM/音效混音在渲染后用 ffmpeg 做。** HyperFrames 只管视频 + 旁白轨（同现在），BGM/SFX 是渲染后叠加的音轨。把「节拍分析」「ducking」「音效混音」握在自己手里（librosa + ffmpeg），不依赖 HyperFrames。

流程（以 demo 为例）：
```
1. 选 BGM（曲库自动挑 / --bgm=<name> / --no-bgm 关）
2. 节拍分析（复用 melo venv 的 librosa）→ 网格 {t0,T,bpm,beats[],strongBeats[]}，缓存 <track>.beats.json
3. 时长跟旁白末尾对齐（同现在）
4. 段边界 / demo 截图切换点 → snapToBeat 吸附最近拍（保持单调 + 最小时长）
5. strongBeats 上注入缩放脉冲 GSAP 关键帧
6. 填模板 + 旁白 + 字幕 → HyperFrames 渲染 → mp4（含旁白轨）
7. ffmpeg 后处理：BGM 裁到时长+压 -18dB+被旁白 sidechaincompress ducking；SFX 在 strongBeats 混入
   → amix 进 mp4 → 成片
```

## 新增/改动单元

### `packages/studio/scripts/beat_grid.py`（新）
librosa 节拍分析，输出 JSON。借鉴 video-shotcraft：
- `librosa.beat_track(tightness=400)` 取节拍时间戳
- **最小二乘拟合线性网格** `t_i = t₀ + i·T`（不信 librosa 标量 tempo，能差 2%+）：
  ```python
  i = np.arange(len(beats)); A = np.vstack([i, np.ones_like(i)]).T
  (T, t0), *_ = np.linalg.lstsq(A, beats, rcond=None); bpm = 60.0 / T
  ```
- 强拍：40–160Hz 带通滤底鼓 + onset 能量，取落在整数拍上、能量最强的几下
- 输出 `{t0, T, bpm, beats:[秒...], strongBeats:[秒...], duration}`

### `templates/bgm/` + `templates/sfx/`（新）
- 曲库/音效库。mp3/wav 二进制**用户放**（像字体一样 gitignore + README 说明找无版权可商用素材，如 Mixkit/Pixabay）。验收时主控用测试素材。
- `<track>.beats.json` 缓存与曲同目录（首次分析后写入，命中不重算）。

### `packages/studio/src/hyperframes.ts`（改）
- `analyzeBeats(bgmPath, beatPython): Promise<BeatGrid | null>`——读缓存 / spawn beat_grid.py；失败返 null（降级不卡点）。
- `snapToBeat(t: number, grid: BeatGrid): number`——纯函数，返回最近 beat 时间。
- `pickBgm(bgmDir, name?): string | null`——曲库选曲（指定/按索引，空返 null）。
- `mixAudio(mp4, opts): Promise<void>`——ffmpeg 后处理：BGM 裁/loop 到时长 + 压低 + sidechaincompress ducking + SFX 在 strongBeats 混入 + 与旁白 amix，替换视频音轨。失败抛错（调用方降级保留原视频）。

### `packages/studio/src/generate.ts`（改）
各模板分支：选 BGM → analyzeBeats → 段边界/截图切换 snapToBeat → strongBeats 注入脉冲动画 → 渲染 → mixAudio。全程 fail-soft（见下）。

### 配置
- `FORGECAST_BGM`（可选，指定曲名；`none` 关闭）；CLI `--bgm=<name>` / `--no-bgm`。
- `FORGECAST_BEAT_PYTHON`（默认复用 `FORGECAST_MELO_PYTHON`，librosa 在 melo venv 里）。

## 关键细节

**吸附规则**：段边界目标时间 → 最近 beat 替换；**约束**段序单调递增 + 每段最小时长下限（避免两拍太近压成 0 段）。demo 截图轮播：每张切换点吸附节拍（约每 2–4 拍一张，按图数/窗口）。

**Ducking 混音**（ffmpeg）：BGM 裁到时长（短则 loop）→ 压 ~-18dB → `sidechaincompress`（旁白轨触发，旁白响 BGM 再降）→ 与旁白 amix。

**强拍动画**：strongBeats 时间点给当前可见段注入 `scale` 脉冲（1.0→1.02→1.0，~0.15s）GSAP 关键帧，幅度小防晕。

**强拍音效**：`templates/sfx/` 取一个 hit（如低音"哚"），在每个 strongBeat 时间 `adelay` 后 amix 进最终音轨，音量适中不盖旁白。

## Fail-soft（逐条）
- 曲库空 / `--no-bgm` → 完全跳过 BGM/SFX/卡点，出片同现在，不报错。
- 节拍分析失败（librosa 挂/文件坏）→ 加 BGM 但不卡点（固定时长），进度打 ⚠。
- ffmpeg 混音失败 → 保留无 BGM 的原视频，带 degraded 原因，不中断。
- 缺 beatPython → 视为分析失败降级。

## 测试

| 层 | 用例 |
|---|---|
| snapToBeat | 纯函数：吸附最近拍、保持单调、最小时长约束、无网格原样返回 |
| pickBgm | 曲库空返 null、指定名命中、按索引挑 |
| beat 缓存 | 有缓存不 spawn、无缓存才 spawn（mock spawn） |
| mixAudio | stub 参数组装可测；真混音靠成片验 |
| generate | fail-soft：无曲库跳过、分析失败降级仍出片（mock） |
| 真渲 | 放测试 BGM+SFX，真渲一条，ffprobe 确认混音音轨；抽帧看卡点；用 video-shotcraft 那招从成片提音频重新拟合验漂移 ≤3 帧 |

## 不做（本子项目）
- ②情绪匹配自动选曲、③卡点编辑界面（各自独立 spec）。
- 多段 BGM 拼接（短视频用不上）。
- 卡点手动微调（属③）。
