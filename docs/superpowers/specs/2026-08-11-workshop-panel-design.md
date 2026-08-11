# 「做内容」生成面板补全

> 日期：2026-08-11　状态：已实施合入 main

## 背景

审计「做内容」板块（`/workshop`）发现后端能力（4 套视频模板、3 套封面模板、封面独立渲染、素材审核/删除/发布/回填表现、BGM/字幕/情绪/背景渲染参数）大部分没有被 Web 页面调用。最要命的两点：**(a) Web 端「生成视频」永远只出 flash**（前端调用时没传 `tpl`，同页的卡点编辑器因此是个死功能——编好的卡点方案只有 demo 模板会读）；**(b) video/cover 素材在 Web 上无法审核通过**，断了「做内容 → 发布日历」的流转。

本轮范围：视频模板选择 + BGM/情绪/背景/字幕渲染参数、封面独立生成（可选具体 raw 图）、video/cover 审核按钮、修复"重新生成"用错钩子的 bug、发布数据展示、shots/ 上传入口。

**不做**：videocut 剪辑集成（占位，真实实现需火山引擎 ASR key）、内容配比/账号人设约束展示、私域话术库接入 funnel.md、开发过程碎片登记 Web 入口、按平台单独出稿、TTS 音色克隆、渲染进度条、AI 生图辅助方案、Workshop 内新增发布表单（发布动作按 §8 设计属于「发布日历」板块职责）。

## 实现

### 1. 重新生成用错钩子的 bug

`WorkshopPage.tsx` 的 `generate()` 原来固定用页面顶部 `hook`/`n` state，`onRegenerate` 传的是当前面板选中的钩子而非素材自己的。改成 `generate(feedback?, hookOverride?, nOverride?)`，`onRegenerate={(fb) => generate(fb, a.hook ?? hook, 1)}`——重新生成用该素材自己的钩子，且只出 1 篇。

### 2. 视频渲染参数（bgm/mood/bg/captions）

`packages/studio/src/generate.ts` 的 `GenerateVideoInput` 加了 `bgm?/mood?/bg?/captions?` 四个覆盖字段。**关键坑**：CLI 原来是直接 `ctx.config.video.bgm = ...` 突变 `ctx`，这在短命令行进程里安全，但 server 是长驻进程、`ctx` 是所有请求共享的单例，突变会污染后续请求。改法是在 `generateVideo` 顶部算一份局部 `video` 配置对象（`{...ctx.config.video, ...覆盖值}`），四个模板分支和 `selectBgm` 都改读这个局部对象，绝不碰 `ctx.config.video` 本体。`renderAndRegister` 的 `ctx.config.video.mode`（stub/render）不开放覆盖，是系统级配置。

`POST /api/projects/:slug/video` body 透传这四个字段；新增 `GET /api/bgm` 返回 `{root, byMood}` 供前端拼 BGM 下拉（曲库当前只有 1 首 `templates/bgm/musictest120.wav`，属正常——树莓为空时下拉只剩"自动"/"无背景乐"两个固定选项）。

`WorkshopPage.tsx` 新增「视频参数」卡片：模板/BGM/情绪/背景四个下拉 + 字幕开关。**story 模板背景下拉禁用**（`injectTechFx` 在 story 分支不传 `bg`，选了也不生效）。

### 3. shots/ 上传

demo 模板依赖 `workspace/<slug>/shots/`，原来没有任何上传入口（`readShots` 只吃 png/jpg/webp）。照抄 `raw/` 上传的实现（`POST/GET /api/projects/:slug/raw`）改出 `POST/GET /api/projects/:slug/shots`，上传时按扩展名白名单校验（非法 400）。`ProjectDetailPage.tsx` 加一张同款上传卡片。

### 4. 封面独立生成

`packages/copywriter/src/cover.ts` 新增 `regenerateCover(ctx, copyAssetId, opts?)`：以一条 **copy** 素材为入口（读它已落盘的 md 重新解析封面文案，不重新生成正文）——这个设计避开了"copy↔cover 靠文件名同 rand 隐式关联、无法从 cover 素材反查"的问题。`opts.shot` 可指定 raw/ 目录下具体某个文件（图片转 data URI，视频走 ffmpeg 抽帧）；不指定则沿用原有的 `resolveCoverShot` 自动逻辑。`opts.template` 缺省时沿用 `coverShot ? 'annotate' : 'bigtext'` 的既有规则，`contrast` 模板本轮起变得可选（原来代码里从未被调用过）。渲染出的新封面**插入新 asset 行，不覆盖旧文件**，和"重新生成文案"的既有行为一致。

`POST /api/assets/:id/cover`（`:id` 是 copy 素材 id）走任务队列 SSE。`AssetCard.tsx` 的 copy 卡片底部加模板+raw图选择器 + 生成按钮。

### 5. 素材审核/删除/发布数据展示

`AssetCard.tsx` 的 `approve`/`del` mutation 本来就已定义在组件顶层，只是没接到 video/cover 分支的渲染上——加上就行，零新逻辑。`Asset` 类型补 `published_at/platform/published_url/perf`（这几个字段后端 `SELECT *` 早就在 wire 上返回了，只是前端类型没声明、没渲染），卡片顶部新增一行展示已发布信息和曝光/赞/询单数据。

## 验证

- `pnpm test` 全仓回归（`packages/studio` 新增 3 条 override 行为测试；`packages/server` 新增 `bgm.test.ts`/`shots.test.ts`/`cover-regenerate.test.ts`；`packages/copywriter` 新增 4 条 `regenerateCover` 错误路径测试——遵循仓库既有约定，不在单测里真实起 Playwright 渲染 copy 生成流程，但 `cover-regenerate.test.ts` 的路由测试确实真渲染了一次验证端到端，环境已装 chromium，约 1s）。
- `tsc --noEmit` + `vite build` 通过。
- 浏览器端到端：上传一张 shots 截图 → Workshop 选 demo 模板 → 生成视频 → 真实产出 `demo-*.mp4`（真实 HyperFrames + TTS + 节拍分析全链路跑通，非 stub）；点某条文案「重新生成封面」选 `contrast` 模板 → 新封面素材出现；video/cover 卡片点「审核通过」正常。
