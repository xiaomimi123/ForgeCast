# 情绪匹配自动选曲（BGM 子项目②）设计

> 日期：2026-07-25　状态：设计已确认，待写实施计划
>
> 承接 BGM 子项目①（[2026-07-24-bgm-beat-sync-design.md](2026-07-24-bgm-beat-sync-design.md)）。①做了 BGM 混音 + 卡点 + 音效；本子项目②只做「按内容情绪自动挑合适的 BGM」。③卡点编辑界面另立 spec。

## 目标

现在 `pickBgm` 只按字典序取第一首（或 `--bgm=` 指定）。加：**按文案的 hook 类型自动匹配情绪 → 从对应情绪曲库随机选一首 BGM**。保留手动覆盖与 `--no-bgm` 干净版。

**为什么按 hook 映射情绪**：hook 本身就是写这条内容时选的情绪策略角度（痛点=紧张、故事=温情…），零成本、确定、可测；不额外调 LLM 读内容。

**为什么保留 `--no-bgm` 干净版**：用户发布流程是混合的（一部分视频自带情绪 BGM；一部分出无 BGM 干净版，上传时在平台加热门原声——平台热曲有版权、挂在平台曲库，无法合法烧进本地渲染的 mp4）。`--no-bgm` 已支持，是这条路的逃生口。

## 情绪映射（hook → 情绪键）

固定映射表 `HOOK_MOOD`（纯函数，可测）：

| hook | 情绪键（文件夹名，英文避免中文路径坑） | 中文 |
|---|---|---|
| `pain`（痛点） | `tense` | 紧张 / 悬念 |
| `sideline`（副业） | `upbeat` | 热血 / 励志 |
| `infogap`（信息差） | `tech` | 科技 / 好奇 |
| `story`（故事） | `warm` | 温情 |

未知/缺失 hook → 无情绪键（走根目录回落）。

## 曲库结构

```
templates/bgm/
├── tense/   *.mp3|wav|m4a   ← 紧张类
├── upbeat/  ...
├── tech/    ...
├── warm/    ...
└── *.mp3                    ← 未分类通用曲（回落用）
```

- 子文件夹**可选**：一个都不建也能跑（全部回落根目录 = 现在的行为），不破坏现有用法。
- 音频与 `.beats.json` 缓存仍全 gitignore（同①）。`.beats.json` 缓存与曲子同目录（子文件夹里的曲，缓存也在该子文件夹）。
- SFX 库不动：仍 `templates/sfx/` 根目录、不分情绪（YAGNI）。
- README 写清中英情绪对照 + 无版权曲渠道。

## 选曲优先级链（从高到低）

1. `--bgm=<文件名>`（或 `FORGECAST_BGM=<名>`）→ 根目录指定曲，**跳过情绪匹配**。命中即用。
2. `--mood=<键>`（或 `FORGECAST_MOOD=<键>`）→ 手动指定情绪，覆盖 hook 自动映射。
3. 默认 → `HOOK_MOOD[copy.hook]` 得情绪键 → 进 `templates/bgm/<情绪键>/` **随机**挑一首。
4. 情绪文件夹缺失 / 空 → 回落 `templates/bgm/` 根目录随机挑。
5. 根目录也空 / `--bgm=none`（`--no-bgm`）→ 不加 BGM（同现在，fail-soft）。

**情绪文件夹内随机挑**：同一个 hook 反复出片时 BGM 会换，内容池不单调（这是本功能的核心价值）。随机用可注入的 `rand`（测试确定性）。

## 改动单元

### `packages/core/src/config.ts`（改）
`video` 加 `mood: string`（默认 `''`；`FORGECAST_MOOD` env）。`''` = 按 hook 自动。

### `packages/studio/src/hyperframes.ts`（改）
- `HOOK_MOOD: Record<string, string>` 映射表（`pain→tense` 等）。
- `resolveMood(hook: string, override?: string): string`——纯函数：`override || HOOK_MOOD[hook] || ''`。
- `pickBgm` 增可选随机：`pickBgm(dir, name?, rand?)`——有 `name` 补后缀命中；无 `name` 时，给了 `rand` 则从音频文件里随机挑、否则字典序第一个（保持对 SFX 等现有调用向后兼容：不传 `rand` = 原字典序行为）。
- `pickMoodBgm(dir, mood, rand?): string | null`——`mood` 非空且 `dir/mood/` 有曲 → 该子目录随机；否则 `dir/` 根随机；都空 → null。

### `packages/studio/src/generate.ts`（改）
`selectBgm(ctx, durationSec, onProgress, hook)` 增 `hook` 参：按优先级链选曲——
```
bgmDir = templates/bgm
if config.video.bgm 且 !== 'none' 且 !== '':  bgmPath = pickBgm(bgmDir, config.video.bgm)   // 链①
elif config.video.bgm === 'none':             bgmPath = null                                 // --no-bgm
else:  mood = resolveMood(hook, config.video.mood); bgmPath = pickMoodBgm(bgmDir, mood, rand) // 链②③④
```
四模板分支把 `copy.hook` 传进 `selectBgm`。其余（analyzeBeats / audioMix / mixAudio）不变。

### `cli.ts`（改）
`video` 命令加 `--mood=<键>` → `ctx.config.video.mood`。用法串补 `[--mood=<tense|upbeat|tech|warm>]`。

### `templates/bgm/README.md`（改）
补情绪子文件夹约定 + 中英对照表。

### `.gitignore`（改，**重要**）
现有规则 `templates/bgm/*.mp3` 等只匹配根目录，**子文件夹里的音频/缓存不会被忽略**（会误入库）。改成递归 glob 覆盖子目录：`templates/bgm/**/*.mp3`、`**/*.wav`、`**/*.m4a`、`**/*.beats.json`。保留 SFX 现有规则。验收时确认 `git status` 不出现子文件夹里的测试曲。

## Fail-soft（逐条，全保留）
- 曲库空 / 情绪文件夹空且根空 / `--no-bgm` → 不加 BGM，出片同现在，不报错。
- 选到曲但节拍分析失败 → 加 BGM 不卡点（同①）。
- 混音失败 → 保留无 BGM 原视频（同①）。
- `--mood=` 给了不存在的情绪键 → 该子目录空 → 回落根目录（不报错）。

## 测试
| 层 | 用例 |
|---|---|
| `HOOK_MOOD` / `resolveMood` | 四 hook 映射正确；`override` 覆盖；未知 hook → `''`；`override` 优先于 hook |
| `pickBgm` 随机 | 给 `rand` 从音频里随机（注入 `rand` 断言命中项）；不给 `rand` 仍字典序（向后兼容）；`name` 命中不受影响 |
| `pickMoodBgm` | 子目录命中随机；子目录空 → 根回落；根也空 → null；mood 为空 → 直接根随机 |
| `selectBgm` 优先级 | `--bgm` 指定跳过情绪；`--mood` 覆盖 hook；默认按 hook；`none` 不选（mock，不真跑 librosa/ffmpeg） |

真渲不需要：选曲是纯逻辑，混音管线已在①真渲验证。

## 不做（本子项目）
- SFX 情绪化、多情绪混排 BGM。
- 按 BPM / 音频特征分析情绪（本设计用 hook 映射，不做音频内容分析）。
- ③卡点编辑界面（另立 spec）。
- LLM 读内容判情绪（评估后选了零成本的 hook 映射）。
