# Story 分镜节奏 polish 设计

> 真渲染验证发现的"后半段偏空"缺陷：Story 三段固定在 0-600 帧(20s)，但 calcMetadataFromCues 把总时长按旁白拉到 ~1780 帧 → 600 帧后只剩背景+字幕。本 pass 让分镜铺满实际总时长。

## 问题
- Story.tsx 三段固定：气泡 0-360、卖点 360-480、CTA 480-600（共 600 帧）。
- Root 的 `calcMetadataFromCues(600)` 依旁白 cues 末尾把 durationInFrames 拉长（59s→1780 帧）。
- 600 帧后无分镜 → `#ded6cc` 背景 + 字幕，后半空。

## 方案
Story 组件用 `useVideoConfig().durationInFrames` 拿实际总时长，三段按比例+下限分配：
```
ctaFrames = clamp(round(dur*0.10), 120, 180)   # CTA 收尾
spFrames  = clamp(round(dur*0.09), 120, 180)   # 卖点
bubblesFrames = max(180, dur - spFrames - ctaFrames)  # 气泡段占主体
```
- 气泡段 0..bubblesFrames：气泡仍按 `delay=i*30` 早揭示（前几秒成型），之后聊天场景**持续可见**作为叙述背景 → 填满中段。
- 卖点段、CTA 段依次接在末尾。
- **默认 600 帧(无 cues)时**：cta=120、sp=120、bubbles=360 —— 正好退回原 360/120/120，**默认行为不变**。
- 旁白拉长时气泡段吸收增量，无空尾。

## 验证（本机真渲染，stub 静音轨即可）
1. 备料：scout→pick→analyze→copy(story 钩子)。
2. `FORGECAST_VIDEO_MODE=render` 真渲 story → mp4。
3. ffprobe 确认时长与旁白对齐（~59s）；抽帧 @60% 与 @90% 处，确认非空——出现聊天场景/卖点/CTA + 字幕，而非纯背景。
4. 默认(无 audio)渲染路径行为不变（stub 测试全绿 + tsc）。

## 范围外
- 气泡内容扩展（仍 3 条，由 buildStoryProps 定）；真旁白逐句对齐气泡（cues 无逐句映射）；BGM。

## 约束
- 沿用：`@remotion/*` 动态、stub 测试不触发真渲染；中文注释；trailer；`pnpm -r test` 全绿。
