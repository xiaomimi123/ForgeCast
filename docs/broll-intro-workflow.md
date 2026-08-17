# AI 产品介绍 B-roll 视频操作手册

给某个已立项项目做一条"产品介绍"风格的 B-roll 视频，靠 Claude Code 会话人工触发、逐步执行——**没有网页按钮或自动化入口**，每次都需要用户在对话里明确提出"帮项目 X 做条产品介绍视频"。

设计背景：docs/superpowers/specs/2026-08-18-broll-intro-video-design.md

## 前提

- 项目已经 `pick` 立项，且已经跑过 `forgecast analyze <slug>` 生成 `workspace/<slug>/analysis.md`（产品介绍解说词的生成依据）。
- 本机已装好 `erduo-broll-loop-engineering` 和 `media-use` 两个 Skill（`~/.claude/skills/` 下能看到）。

## 步骤

1. **确认项目**：跟用户确认目标项目 slug，检查 `workspace/<slug>/analysis.md` 是否存在；不存在则先跑 `forgecast analyze <slug>`。

2. **生成产品介绍解说词**：调用 `generateProductIntroScript(ctx, { slug })`（`packages/copywriter/src/broll-script.ts`），产出 `workspace/<slug>/broll/script.md`。live 模式下（.env / 设置页配了真实 LLM key）会读 `analysis.md` 生成真实解说词；mock 模式下只是固定骨架，不适合直接拿去用。

3. **TTS 配音出时间轴**：调用 `synthesizeVoice(ctx, script, outPath)`（`packages/studio/src/tts.ts`）给解说词配音，拿到 `{ audioRel, cues }`。`cues` 是后续转 SRT 需要的时间轴数据。

4. **转 SRT**：调用 `cuesToSrt(cues)`（`packages/studio/src/srt.ts`），把结果写成一个 `.srt` 文件。写入路径按当时 erduo Skill 要求的输入位置来（它会在启动时说明期望 SRT 放在哪，通常是新建的产出目录里）——这是 erduo Skill 自己的接口细节，不在本文档里写死。

5. **生成概念 UI 效果图**：用 `media-use` Skill 生成 2-4 张"这个产品可能长什么样"的概念示意图，prompt 基于 `analysis.md` 里的产品描述（谁掏钱/解决什么问题/换皮方向）。**这些图没有真实依据，纯粹是概念演示**——生成时跟用户确认清楚这一点，不要让图片看起来像是"真实产品截图"。

6. **交给 erduo Skill**：用生成的 SRT + 概念图（作为 user media）调用 `erduo-broll-loop-engineering` Skill，走它自己完整的 Director → Assets → Builder → 装配预览流程。**不要跳过任何一步**，尤其是"给用户看动态预览"这一步——这是它的硬性要求，不能省略或用截图代替。

7. **用户确认**：把动态预览给用户看，收集反馈。有具体问题（比如某个 shotId 内容对不上、看不懂、发展太慢）就退回给对应的 Director 或 Builder 改，不要自己在 Parent 上下文里改内容或选素材。

8. **登记成片**：用户确认没问题、erduo Skill 出了最终 `master.mp4` 后，运行：

   ```bash
   forgecast broll-import <slug> <master.mp4的绝对路径> --hook=broll
   ```

   把成片登记进 ForgeCast 的 `assets` 表，`workspace/<slug>/uploads/` 下能看到文件，网页"做内容"页面成片 tab 能看到。

9. **标注概念图性质**：在视频描述、发布文案，或者跟用户交接时，明确提一句"视频里的 UI 画面是概念演示，不是真实产品截图"——避免观众误以为看到的是真实上线的产品界面。
