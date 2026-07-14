# M5（子块②）— TTS + 字幕 + 模板B story 设计

> M5 studio 第二口：给已做的 flash 管线加**配音(TTS)**、**字幕**、**模板B story**（聊天故事型，带旁白）。
> 上游：M4 的 copy 素材（口播脚本）；产物是带音频+硬字幕的 story mp4。
> **验证边界（用户已认可"先搭着不验证"）**：TTS 与视频渲染都做 stub/live 双模式；**stub 全链路可测**（占位音频 + 估算字幕，无 key 渲染出带字幕的故事视频）；**live TTS（MiniMax，需 key）与真实渲染本轮不验证**，作为最佳努力脚手架并明确标注。

## 目标

在 flash（子块①）之上，让 studio 能出第二种视频：**story 接单故事型**——聊天气泡逐条弹出 + TTS 旁白 + 逐句硬字幕 + CTA。为后续模板 A 复用音频/字幕层打基础。

## 范围

**做**：TTS 模块（`synthesizeVoice`，stub 出占位 wav + 估算字幕 cues / live 走 MiniMax 最佳努力）；core config 加 `tts:{mode,...}`；Story Remotion Composition + 字幕组件 + `buildStoryProps`；`generateVideo` 支持 `tpl='story'`（TTS 合成 → story 渲染，含音频+字幕）；render.ts 按 tpl 选 Composition；CLI `video <slug> --tpl=story`；server `video` 端点放开 `tpl` 参数；vitest 全 stub 覆盖可测部分。

**不做（本口）**：真实 MiniMax 音色克隆/调优（无 key 不验证）；模板A 录屏叠加（③）；videocut 剪辑（④）；Docker renderer（⑤）；BGM 音轨；Web 端模板选择（story 先经 CLI，Web「生成视频」仍默认 flash）。

## 架构

沿用 `@forgecast/studio`。新增/改动：
```
packages/studio/src/tts.ts                 # synthesizeVoice(ctx, text, outWavPath) → { audioRel|null, cues }
packages/studio/src/remotion/Story.tsx     # 模板B：气泡 + Audio + 字幕
packages/studio/src/remotion/Subtitles.tsx # 字幕组件（按 cues + frame 逐句显示）
packages/studio/src/remotion/Root.tsx      # 注册 Flash + Story 两个 Composition
packages/studio/src/props.ts               # 追加 StoryProps + buildStoryProps(doc)
packages/studio/src/render.ts              # renderVideo(entry, compId, props, out, mode)（泛化 flash 专用版）
packages/studio/src/generate.ts            # generateVideo 支持 tpl；tpl='story' 先 TTS 再渲染
```

### 数据流（story）
```
generateVideo(slug, {tpl:'story', assetId?})
  取 copy 素材 → parseCopyOutput → buildStoryProps(doc)（气泡/卖点/CTA）
  → synthesizeVoice(ctx, 口播文本, workspace/<slug>/videos/<base>.wav)
       stub: 写占位 wav（静音/标记）+ 按句估算 cues[{start,end,text}]
       live: MiniMax TTS（经中转站）→ wav + cues（最佳努力，未验证）
  → props.audioSrc = 相对路径; props.cues = cues
  → 写 <base>.props.json → renderVideo(entry,'Story',props,<base>.mp4, video.mode)
  → 登记 video 素材
```

**约定**：TTS stub 不发网络、不需 key（全 mock 可跑）；video 渲染 stub 不加载 Remotion（同子块①）。story 的 mock 全链路 = 占位音频 + 估算字幕 + 占位 mp4，可确定性测试。

## TTS（tts.ts + config）

- core config 加 `tts: { mode: 'stub' | 'live'; baseURL: string; apiKey: string; model: string }`：`FORGECAST_TTS_MODE`(默认 stub)、`FORGECAST_TTS_KEY`、`FORGECAST_TTS_BASE_URL`(默认中转站)、`FORGECAST_TTS_MODEL`。
- `interface VoiceResult { audioRel: string | null; cues: Array<{ start: number; end: number; text: string }> }`
- `async function synthesizeVoice(ctx, text, outWavAbs, opts?): Promise<VoiceResult>`：
  - **stub**：把文本按句号/换行/标点切句；每句时长 = `max(1.2, 字数 * 0.28)` 秒，累加成 cues（start/end 秒）；写一个占位 wav（一段极短静音字节或标记文件）到 outWavAbs；返回 `{audioRel: 相对workspace路径, cues}`。**不发网络、不需 key**。
  - **live**：调 `tts.baseURL` 的 TTS 端点（MiniMax/OpenAI 兼容，最佳努力）取 audio + 时间戳；失败或无 key 时**降级为 stub**（不阻断）。标注：未验证。
  - `@` 网络请求用注入的 fetchImpl（测试）；live 分支动态 import 不引重依赖。
- cues 单位：秒（Remotion 字幕组件按 `frame/fps` 秒判定当前句）。

## 模板B Story（Story.tsx + Subtitles.tsx）

- `interface StoryProps { bubbles: Array<{ who: 'them' | 'me'; text: string }>; sellingPoint: string; cta: string; brandName: string; audioSrc?: string; cues?: Array<{ start: number; end: number; text: string }> }`
- Composition `id="Story"`：1080×1920/30fps；时长按 cues 末尾或固定（默认 600 帧=20s，见实现取 `max(600, 末句end*fps)`）。段落：气泡逐条弹入（前段）→ 卖点 → CTA + 水印；若 `audioSrc` 有则挂 `<Audio src={staticFile? or path}>`（渲染时 Remotion 从 props 拿；stub 音频也挂，静音无妨）；底部 `<Subtitles cues fps>` 逐句硬字幕。
- `Subtitles`：`useCurrentFrame()/fps` 求当前秒，找命中 cue 显示其 text（底部大字白底黑边，抖音风）。
- `buildStoryProps(doc, brandName?)`：`bubbles` 从 doc 生成一段简短对话（如 `them: doc.titles[0]?`, `me: '可以，等我一天'`——模板化，具体见实现）；`sellingPoint=doc.cover.sub||doc.titles[1]`；`cta` 同 flash 的 CTA 抽取；均有兜底。旁白文本 = `doc.douyinScript`（传给 TTS）。

## generate/render 改动

- `render.ts`：把 `renderFlash` 泛化为 `renderVideo(entry, compositionId, inputProps, outPath, mode, opts)`（stub 写占位；render 动态 import + selectComposition(id=compositionId) + renderMedia）。保留 flash 调用（compositionId='Flash'）。
- `generate.ts` `GenerateVideoInput.tpl?: 'flash' | 'story'`（默认 flash）。tpl='story' 时：buildStoryProps → synthesizeVoice（写 wav 到 videos/）→ props 挂 audioSrc/cues → renderVideo(...,'Story',...)。tpl='flash' 走原路径。asset hook 记 copy.hook，type='video'（可加 `tpl` 进文件名区分）。

## 入口

- **CLI**：`forgecast video <slug> --tpl=story [--asset=<id>]`（现有 video case 已支持 --tpl，确认透传；默认 flash）。
- **REST**：`POST /api/projects/:slug/video` 放开 `tpl`：body `{assetId?, tpl?}`，`tpl` ∈ {flash,story} 才透传（现在硬编码 flash → 改为读 body.tpl，白名单校验，默认 flash）。
- Web：不改（生成视频仍默认 flash；story 经 CLI）。

## 测试策略（TDD，全 stub）

`packages/core/test/config.test.ts`：tts 默认 `{mode:'stub',...}`、可设 live+key。
`packages/studio/test/`：
- `buildStoryProps`：从 CopyDoc 得 bubbles(非空)/sellingPoint/cta/brandName。
- `synthesizeVoice` stub：给多句文本 → cues 数 = 句数、时间递增不重叠、写出占位 wav 文件、不调用注入的 fetch（`vi.fn` 断言未调用）。
- `generateVideo` tpl='story'（video stub + tts stub）：写 `.props.json`（含 bubbles/cues/audioSrc）+ `.wav` + 占位 `.mp4` + 登记 type='video' 素材；返回 {assetId, filePath}。
- Story/Subtitles/Root 组件：不单测，靠 `tsc --noEmit`。
`packages/server/test/`：`POST video {tpl:'story'}`（stub）→ 任务完成 → 有 video 素材（沿用现有 video 测试模式）。

里程碑末：**不做真实渲染/真实 TTS 走查**（无 key，用户已认可）。仅 `pnpm -r test` 全绿 + studio `tsc` 通过。**若将来有 MiniMax key**，跑 `FORGECAST_TTS_MODE=live FORGECAST_VIDEO_MODE=render forgecast video <slug> --tpl=story` 验证真实音频+字幕。

## 全局约束（沿用）

- Node 20/pnpm 9；studio main=src/index.ts 无 build；`@remotion/*` 与 live TTS 用动态 import（stub/测试不加载）；所有测试 `FORGECAST_VIDEO_MODE=stub` 且 `FORGECAST_TTS_MODE=stub`。
- 产物落 workspace/<slug>/videos/；file_path 相对；服务只绑 127.0.0.1；中文注释；TDD；commit trailer。

## 未决/后续

- 真实 MiniMax 音色克隆、Edge-TTS 兜底实装与验证（有 key 后）；抖音硬字幕样式打磨；模板A(③)复用本口的 Audio/字幕层；BGM。
