# 口播合成（子项目④第一版：talk 模板）设计

> 日期：2026-09-06　状态：设计已确认，待写实施计划
>
> 「做内容重构」四子项目的第④个：① 素材包（done）→ ② Remotion 渲染器（done）→ ③ 工位重构+剪辑台（done）→ **④ 视频合成能力**。
> ④ 按场景分期，本 spec 只覆盖第一期「真人口播叠动效」；绿幕抠像、数字人、ASR 自动字幕、画中画多视频各自后续独立 spec。

## 0. 场景与决策

用户上传的真人口播成片当底层，叠 ForgeCast 生成的动效层（标题/卖点卡/CTA/手动字幕），剪辑台里 trim 头尾、打字幕、调时间，渲成品。与用户确认的四个决策：

| 决策点 | 结论 |
|---|---|
| 场景优先级 | 真人口播叠动效（绿幕/数字人后续） |
| 产物形态 | 新固定模板 `talk`（第六个）+ 剪辑台配套调整 |
| 字幕来源 | 剪辑台手动打（不上 ASR；很多平台自动配字幕，烧进去非必需） |
| trim | 要——`trimStart/trimEnd` 进 schema，剪辑台可调（口播头尾废片是刚需） |

## 1. 数据模型与渲染

### 1.1 schema（全部新增可选，①②门禁不受影响）

```ts
| { kind: 'video'; src: string; muted: boolean;
    trimStart?: number;   // 秒，片源起点偏移（裁掉的头）
    trimEnd?: number;     // 秒，片源终点（缺省=片源末尾）
    volume?: number }     // 0..1，缺省 1
```

### 1.2 Remotion 端（compositions）

`LayerView` video 分支改为 `<Sequence from={secToFrames(layer.start)} durationInFrames={secToFrames(layer.duration)}><Video startFrom={secToFrames(trimStart ?? 0)} volume={volume ?? 1} …/></Sequence>`。
一并还掉②Task 8 的债：**任何** `start>0` 的视频图层从此按 trim 点正确起播（不止 talk）。

### 1.3 `lowerTalk`

track 0 视频底层（`start:0, duration:durationSec`，`from:'sec-video'` 语义段——让 deriveShots 把它显示为分镜轨 Clip）+ 标题（hook）/卖点卡（body items）/CTA+品牌 动效层（时间按视频时长比例分配，节奏常数以 flash 为起点）+ 空字幕轨。
**时长跟随视频**：`spec.durationSec = 片源长 − trimStart − (片源长 − trimEnd)`；trim 变动联动 durationSec 并钳回越界动效层（§3 的 `trimVideoLayer`）。

### 1.4 样式与背景

`compositions/styles/talk.css`：以 flash 的标题/卡/CTA 规格为起点加 `.tpl-talk` 前缀（新模板无「不改视觉」包袱，但不做新设计——设计权在用户，起步够用）。科技背景默认 **none**（不遮人脸），bgVariant 仍可手选。

### 1.5 音频

`audio.narration` 恒 null（TTS 禁用，人声来自视频）；`captionsEnabled` 对 talk 无意义（字幕手动）；**BGM/mixAudio 零改动**——sidechain ducking 本就把成片 `[0:a]` 当人声压 BGM，口播音轨天然就是 `[0:a]`。

### 1.6 门禁边界

talk 是 **Remotion-only**：generate 的 talk 分支**不产 HyperFrames index.html**（那份 HTML 自②起不用于渲染）。①的 `equivalence.test.ts` 不覆盖 talk（它守五模板双渲染器等价，talk 无 HF 路径）；talk 的内容门禁走②的 compositions 内容断言——**新增 talk fixture**（含带 trim 的 video 图层），并补「fixture 集合覆盖面守护」的 video 类空缺（②Task 7 遗留）。

## 2. 生产流程

- **入口**：出片参数模板下拉加 `talk`，选中时多出「口播素材」下拉（本项目 `origin='upload'` 的视频；没有则提示先上传）。server `/video` talk 分支：校验 uploadAssetId（非 upload 视频 400）→ ffprobe 时长 → `lowerTalk` → `renderAndRegister`（Remotion）。
- **大文件零拷贝（关键决策）**：hfDir 里放**软链**指向 workspace 的上传视频，不拷贝——②已验证 `bundle()` 的 copy-dir 对 publicDir 内软链做 realpath 绝对化重建、不复制本体（Docker 链路同样成立）。几百 MB 的口播片渲染零拷贝。
- 聚合/成片库/批量审片零改动：talk 产的 video asset 照常带 `sourceAssetId`。

## 3. 剪辑台（talk 配套）

- **trim**：时间轴上视频层即分镜轨第一个 Clip；**左缘拖=裁头**（`trimStart += δ, duration −= δ`, start 保 0）、**右缘拖=裁尾**——与普通 resize 语义不同（动片源起点），封装 editing 新 op `trimVideoLayer(spec, edge, δ)`：联动 `durationSec` + 钳回越界动效层 + 裁到 <0.2s 钳住，纯函数带测试。Inspector 图层检查器对视频层出 trimStart/trimEnd/volume 数字微调。
- **加字幕**：字幕轨**双击空白=插一条字幕**（复用卡点轨双击模式；editing 新 op `addCaptionLayer(spec, tSec, text)` 管 track 分配与 id 唯一）；插完 ShotList 出现对应行直接打字（`updateLayerText` 现成）；字幕条可挪/拖时长（`moveLayer/resizeLayer` 现成）。
- **可拖区分从简**：`spec.template==='talk'` 时字幕轨整体可拖；五模板维持「跟随旁白不可拖」。不给 caption 加来源字段——按模板判够用（talk 无 TTS），刻意取舍。

## 4. 测试与验收

- **editing**：`trimVideoLayer`/`addCaptionLayer` 全量单测 + 变异实验（删 durationSec 联动/删钳回必须红）。
- **compositions**：Sequence/startFrom/volume 断言；talk fixture 进内容门禁 + video 类覆盖守护。
- **studio**：`lowerTalk` 单测；generate talk 分支 stub（软链建立、不产 index.html、sourceAssetId 透传、narration null）。
- **server**：talk 路由校验分支。
- **①②门禁全绿红线**：五模板 lower 不产 video 图层，`<Sequence>` 包装不应波及；红了查自己不改基线。
- **端到端真渲**：合成带已知画面标记+人声的测试视频 → upload → talk 生成 → 剪辑台裁头 2s + 加一条字幕 → 渲片 → 抽帧验四件事：视频从 trim 点起播（标记位置对）/ 字幕在打的位置上屏 / 动效叠层正确 / ②对照法验成片音轨为视频人声且 BGM ducking 生效。

## 5. 非目标

绿幕/数字人/ASR/多视频图层/画中画；talk 的 LLM 重写沿用③的能力边界（文本段可重写，`sec-video` 段不可）；不做视频转码/压缩（用户上传什么渲什么）；不动 upload 流程本身。

## 6. 风险与已知取舍

- 软链方案依赖 bundle 的 copy-dir 行为（②验证过 macOS+Docker）；若 Remotion 升级改变该行为，退路是 hfDir 真拷贝（付磁盘代价）。
- `<Sequence>` 包装改变 video 分支行为——②的 video-layer 测试要同步更新（当时断言的是裸 `<Video>`），属预期更新非门禁弱化，实施计划里明说。
- talk 动效层节奏抄 flash 起步，观感由用户真机验后再调（同③的模式）。
