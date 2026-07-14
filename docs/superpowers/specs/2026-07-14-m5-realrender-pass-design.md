# M5 真渲染 pass（story/demo 媒体解析 + 时长对齐 + 本机验证）设计

> 硬化/验证 pass（非新功能）：把 M5②③ 的两处"未验证脚手架"真渲染跑通，无需外部 key/录屏。
> 用 systematic-debugging：改 → 真渲染 → 看 Remotion 实际报错 → 迭代，直到产出合法 mp4。

## 问题（M5②③ review 指出）
1. **媒体 src 不解析**：Story `<Audio src={audioSrc}>`、Demo `<OffthreadVideo src={demoVideoSrc}>` 传的是 workspace 相对路径（如 `demo/videos/x.wav`），Remotion 真渲染时按 bundle serve URL 的 public 解析，裸相对路径解析不到。
2. **时长不对齐**：Story 固定 600 帧、Demo 固定 1800 帧，与实际 TTS cues 长度不匹配 → 音频/字幕被截断或画面冻结。

## 方案（以真渲染验证为准，允许据实迭代）
- **媒体解析**：优先给 `renderMedia` 传 `publicDir` = workspace 目录，媒体 src 用相对 workspace 路径经 Remotion public 解析；或改用绝对 `file://`/`staticFile`——**以真渲染实际能加载音频/视频为准**。render.ts 的 `renderVideo` 增 `publicDir?` 参数，generate.ts 传 `ctx.config.paths.workspace`。
- **时长对齐**：Story/Demo 的 `<Composition>` 用 `calculateMetadata`（Remotion 4）据 props.cues 末尾算 `durationInFrames`（`Math.max(默认, ceil(lastCue.end*fps))`），兜底默认帧数。
- 兜底：无 audioSrc/无 cues 时行为不变（flash 不受影响）。

## 验证（本机真渲染，无 key/录屏）
1. `rm -rf db`；CLI 备料：scout→pick chatwoot→analyze→copy(story 与 pain 各一)。
2. `FORGECAST_VIDEO_MODE=render pnpm exec tsx cli.ts video chatwoot --tpl=story`（TTS 走 stub 静音轨 + 估算字幕）→ 产 mp4；`--tpl=demo`（无录屏→占位演示）→ 产 mp4。
3. ffprobe 验证两个 mp4：h264、1080×1920、时长与 cues 大致对应、非空可播放；抽帧确认字幕/中文字体正常。
4. flash 真渲染回归一次仍正常。

## 约束
- stub 单测保持全绿（`pnpm -r test`）；测试仍走 stub 不触发真渲染。
- 若某方案真渲染仍失败，据实换方案并在报告说明；确产出合法 mp4 才算完成。
- 中文注释；commit trailer。

## 未验证仍保留
- 真实 MiniMax 音频（需 key）、真实录屏演示（需录屏）——本 pass 只验证 stub 静音轨 + 占位演示的真渲染路径。
