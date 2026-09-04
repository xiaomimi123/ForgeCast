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

---

## 7. 实现偏差（Task 8 收官时如实补记）

本节记录**落地结果与上文设计不一致**的地方。上文各节保持设计当时的原样，不回改，以便对照。
逐条的详细取舍在 `.superpowers/sdd/2026-09-06-talk-composite/task-{1..8}-report.md` 的账本里。

1. **软链零拷贝（§2「大文件零拷贝（关键决策）」）未成立——真渲阻断，待修。**
   `bundle()` 的 copy-dir 确实原样保留了 publicDir 里的软链（不复制本体，符合设计预期），
   但 Remotion 渲染页面的静态服务器（serve-handler 用 `lstat`）对**最终路径是软链的文件**一律回 404，
   于是 `<Video src="assets/talk-source.mp4">` 拿不到片源、渲染以
   `MEDIA_ELEMENT_ERROR: Format error` 失败。这一点其实早已写在
   `packages/studio/src/remotion-render.ts` 的 `linkPublicDirToBundleRoot` 注释里
   （「链目录可以，链单个文件不行」），设计时没把它与本决策联系起来。
   Task 8 用两组对照实验钉死了成因：把该软链换成真文件 → 全链路真渲通过；
   把它换成**指向同目录内真文件的相对软链** → 仍 404（故与「链接目标逃出服务根」「路径含非 ASCII」无关，
   就是软链文件本身）。**退路即 §6 已写的「hfDir 真拷贝（付磁盘代价）」**，另一条路是让
   publicDir 侧只出现软链**目录**（例如软链 `assets/talk-src/` 整个目录、片源放在里面）。
   修复未在本期做（Task 8 的职责是验收，不是改实现）。

2. **底片在剪辑台里单独占一轨**（§3 原文是「时间轴上视频层即分镜轨第一个 Clip」）。
   真 spec 上分镜轨会画坏（hook 段 0 宽、底片只画满 15%），故 Task 7 给 talk 加了独立的底片轨，
   代价是 talk 的时间轴高度 212（五模板仍 186），`EditorPage` 的网格行高改为从 `timelineHeight()` 取。

3. **`trimVideoLayer` 的吐尾钳制落在纯函数里**（§3 只写了「裁到 <0.2s 钳住」）：
   `trimEnd` 不得越过片源物理末尾，判据是新增的 `content.sourceDurationSec`（由 `lowerTalk` 落值）。
   放在 UI 上钳不彻底——Inspector 的数字输入照样能填越界值。`sourceDurationSec` 缺省的老 spec 维持原行为。

4. **手动字幕「清空文本即删除」**（§3 未写删除路径）：新增 `removeCaptionLayer`，
   只接受 `cap-manual-` 前缀的 id；五模板 TTS 生成的 `cap0/1/2` 不走这条路（它们与旁白一一对应）。

5. **`spec.durationSec` 不套 `MIN_DURATION.talk`**：口播成片的长度就是这段口播本身，
   补到 6s 只会在片源后挂一段黑屏。`MIN_DURATION.talk` 成为暂无读取方的预留常量。

6. **动效层版式沿用五模板的既有行为**（§6 已预告「观感由用户真机验后再调」）：
   真渲实测标题/卖点卡/CTA 都是文档流里的块级 `.clip`，贴在画面顶部；`.card` 与 flash 的
   `.highlightCard` 同源，没有字号/颜色规则，在真人底片上是默认小字。**与 flash 逐帧对照过，
   两者表现一致**，不是 talk 引入的回归，但 talk 的底片是真人画面，观感问题比五模板更显眼。
