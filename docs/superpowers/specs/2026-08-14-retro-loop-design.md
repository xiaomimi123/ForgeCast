# 复盘闭环设计（产品重心调整收官 A2）

## 背景

三部曲最后一块。A1 已落地"脚本→拍→上传→审片"；发布数据回填（perf：曝光/赞/询单）机制早已存在（ops recordPerf + 分发营销复盘页）。A2 把两者合起来闭环：

**审片报告（内容质量）× perf（市场反馈）→ LLM 复盘 → 下一条视频的优化建议 → 自动注入下一次文案生成。**

用户早前已确认"内容审片+发布后数据两段式"的打分设计，本轮是其第二段的落地。

## 复盘生成（packages/studio/src/retro.ts）

`generateRetro(ctx, videoAssetId, {onProgress?}) => Promise<RetroReport>`：
- 校验 asset 存在且 type='video'；**必须已有 review**（未审片先审片，抛错提示）；perf 可选（没有就只按内容审复盘，报告注明"暂无发布数据"）。
- 汇入 LLM 的材料：审片报告（分数+建议+转写摘要）、perf JSON（曝光/赞/询单，缺省注明）、对照脚本/文案基准（沿用 review 里记的 scriptAssetId，读不到就跳过）。
- 输出 JSON：`{ verdict: string（一句话总评）, keep: string[]（下一条要保持的）, change: string[]（下一条要改的）, focus: string（下一条最优先改进的一件事） }`——校验四字段齐全非空，失败整批抛错。
- mock 走 fixture 绝不调 ctx.llm；提示词 `templates/prompts/video-retro.md` 含真实感红线（不编数据断言，perf 缺失时不得假装有数据）。
- 存 `assets.retro`（ensureColumn 新列，覆盖式 JSON：RetroReport + generatedAt + hadPerf）。

## 注入下一条（packages/copywriter）

`generateCopy` 组装提示词时新增可选块【上一条复盘（参考改进，不必逐条照做）】：查该项目最新一条带 retro 的 video 素材，格式化 verdict/keep/change/focus 注入（同 patternsMd 的可选块模式，没有就不出现）。`assemblePrompt` 的 `AssembleInput` 加 `retroMd?: string`。

`generateShootScript` 同样注入（拍摄层面的 keep/change 对脚本同样有用）。

## API / CLI / Web

- `POST /api/assets/:id/retro` → 任务队列 `{taskId}`。
- CLI `forgecast retro <videoAssetId>`。
- Web：成片 tab 的 UploadCard 在审片报告下方加「生成复盘」按钮（有 review 才显示；SSE）；有 retro 时展示：总评 + 保持/改进两列 + 下一条最优先（高亮）。perf 回填仍走分发营销复盘页（不重复建表单）。

## 不做的事

- 不做跨视频的批量复盘/趋势分析（单条视频复盘即可，趋势看分发营销周报）。
- 不改 perf 回填机制。
- 不做复盘历史版本（覆盖式，同 review/perf 先例）。

## 验证

1. `pnpm test` 全仓 + 新单测（generateRetro：无 review 抛错、无 perf 降级注明、mock 全链路、live 校验失败不写脏数据；注入块：有 retro 出现在 prompt、无则不出现；路由；CLI 冒烟）。
2. 端到端（live）：对已审片的成片生成复盘 → 页面展示合理、无编造数据；给该素材回填一条 perf 再复盘 → 报告体现发布数据；随后生成一条新文案，确认 prompt 注入了复盘块（日志/输出可感知）。
3. 测试假数据清理，真实产物保留。
