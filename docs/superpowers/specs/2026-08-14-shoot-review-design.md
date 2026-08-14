# 拍摄脚本 + 成片上传 + 审片打分设计（产品重心调整第三步 A1）

## 背景

产品重心调整三部曲（B 需求信号库、C 需求×项目匹配均已落地）的第三步 A：做内容主线从"系统直接渲染成片"换成人机协作——**系统当导演+教练，用户自己拍**。用户确认拆两轮：

- **A1（本 spec）**：拍摄脚本生成 + 成片上传 + 内容审片打分。
- **A2（后续）**：发布后真实数据（perf）结合审片报告，生成下一条视频的优化建议闭环。

已确认的取舍：审片=转写+结构指标+LLM 对照脚本（LLM 纯文本无视觉，帧仅展示不做 AI 分析——本轮连帧展示也不做，留最简）；拍摄脚本=独立素材类型；五个自动渲染模板降为辅助（tab 排位后移，功能保留）。

## 新素材类型与数据

`assets` 表新增两列（`ensureColumn` 幂等迁移，不改 schema）：
- `origin TEXT DEFAULT 'rendered'`——视频来源：`rendered`（模板渲染）/ `upload`（用户上传成片）。
- `review TEXT`——审片报告 JSON（覆盖式，同 perf 先例）：`{ scores: { hook, pacing, fidelity, cta, overall }, suggestions: string[], transcript?: string, metrics: { durationSec, charCount, charsPerSec }, scriptAssetId?: number, degraded?: string, reviewedAt: string }`。scores 各项 0-100。

新 `type` 值 `'script'`（拍摄脚本，type 列无约束直接用）：markdown 文件落 `workspace/<slug>/scripts/`，行为同 copy（draft/approved、可编辑、可删除）。

## 拍摄脚本生成（packages/copywriter/src/script.ts）

`generateShootScript(ctx, { slug, assetId?, onProgress? }) => Promise<{ assetId, filePath }>`：
- 取指定/最新 copy 素材 → `parseCopyOutput` 拿 `douyinScript`（已含【时间段 段落名】画面/台词结构）。
- LLM（`templates/prompts/shoot-script.md`）扩展成**可执行的拍摄脚本**：逐镜分镜表（时间段/画面内容/台词/拍摄要点：机位·景别·道具·真人出镜或录屏·注意事项）+ 开拍前准备清单。mock 走 fixture（heuristic：把 douyinScript 逐段搬进模板骨架，绝不调 ctx.llm）。
- 真实感红线：拍摄要点不编造数字类承诺；台词一律原样搬 copy 的台词，不改写（脚本是执行指导，不是二次创作）。
- 写文件 + INSERT assets(type='script', hook 继承 copy)。

## 转写与审片（packages/studio）

新脚本 `packages/studio/scripts/asr_transcribe.py`：`python asr_transcribe.py <wav> <out.json>`，faster-whisper 全文转写（zh），输出 `{ ok: true, text, segments: [{start, end, text}] }` 或 `{ ok: false, reason }`。与 asr_align.py 同一 venv（`ctx.config.tts.asrPython`）。

`packages/studio/src/review.ts`：
- `extractAudioWav(mp4Abs, wavAbs, deps?)`——ffmpeg `-vn -ar 16000 -ac 1`，`spawnWithTimeout` 模式。
- `probeDuration(mp4Abs, deps?)`——ffprobe 时长，失败返 null（fail-soft）。
- `transcribeAudio(wavAbs, asrPython, deps?) => Promise<{text, segments}|null>`——spawn asr_transcribe.py，未配 asrPython/失败返 null（fail-soft，同 alignCues 风格，deps 注入可测）。
- `reviewVideo(ctx, videoAssetId, { scriptAssetId?, onProgress? }) => Promise<ReviewReport>`：
  1. 校验 asset 存在且 type='video'。
  2. ffprobe 时长；抽音轨；转写（三步全 fail-soft，转写失败则 `degraded` 注明"未转写，仅结构建议"）。
  3. 结构指标：durationSec、转写字数、语速（字/秒）。
  4. 对照基准：`scriptAssetId` 指定的 script 素材 → 缺省取项目最新 script → 再缺省取最新 copy 的 douyinScript → 都没有则通用结构审（prompt 里注明无脚本基准）。
  5. LLM（`templates/prompts/video-review.md`）输出 JSON：`{ scores: {hook,pacing,fidelity,cta,overall 各0-100}, suggestions: string[] }`，校验（分数数值 0-100、suggestions 非空数组）失败整批抛错。mock 走 fixture。真实感红线：suggestions 不编数据。
  6. 写 `assets.review`（覆盖）。

## API / CLI / Web

server（app.ts）：
- `POST /api/projects/:slug/script`（body `{assetId?}`）→ 队列 `{taskId}`
- `POST /api/projects/:slug/upload-video`——multipart file，白名单 `mp4|mov|m4v`，落 `workspace/<slug>/uploads/`，INSERT assets(type='video', origin='upload')，返 `{ok, assetId, name}`
- `POST /api/assets/:id/review`（body `{scriptAssetId?}`）→ 队列 `{taskId}`
- `GET /files/*` MIME 表确认覆盖 `.mp4`（已有）/`.mov`（补）

CLI：`forgecast script <slug> [--asset=<id>]`、`forgecast review-video <assetId> [--script=<id>]`。

Web（做内容页改 5 tab，按新主线排序）：`文案 / 拍摄脚本 / 成片 / 出视频 / 卡点`
- **拍摄脚本 tab**（新 `workshop/ScriptTab.tsx`）：左栏选文案+「生成拍摄脚本」（队列+SSE）；右栏 script 素材卡片列表（markdown 预览、编辑保存、审核、删除——复用 AssetCard 的 copy 分支能力或轻量自建）。
- **成片 tab**（新 `workshop/UploadTab.tsx`）：上传区（mp4/mov，`fetch`+FormData 同 raw 上传先例）；上传成片列表（9:16 竖屏卡片，origin='upload'）；每条「审片」按钮（可选脚本下拉，默认最新脚本）→ SSE 完成后卡片展示报告：五项分数 + 建议列表 + 转写摘要（前 200 字）+ degraded 提示。
- **出视频 tab**：现 VideoTab 原样，只调 tab 排位（降辅助）；其素材列表过滤 `origin !== 'upload'`（渲染片），成片 tab 过滤 `origin === 'upload'`。
- AssetCard video 分支顶部加来源徽标（渲染/实拍）。

## 不做的事（A1 范围外）

- 不做发布后 perf 结合审片的下一条建议闭环（A2）。
- 不做帧抽取/展示、不做视觉 AI 分析（LLM 无视觉）。
- 不做上传分片/断点续传（本地工具，直接整文件 POST，无大小限制中间件）。
- 不删/不改五个自动渲染模板的任何渲染逻辑。
- 不做脚本的版本管理（重新生成=新素材行，同 copy 先例）。

## 验证

1. `pnpm test` 全仓 + 新增单测（script 生成 mock/解析、transcribe fail-soft、reviewVideo 全链路 mock/降级/校验失败不写脏数据、三条路由、上传白名单）。
2. 端到端（live）：选一条真实文案生成拍摄脚本 → 页面可读可编辑；上传一条真实 mp4（可用现有渲染成片文件充当）→ 审片 → 报告五项分数+建议合理、无编造数字；ASR 未配置场景验证降级提示。
3. 测试造的假数据清理；真实产物保留。
