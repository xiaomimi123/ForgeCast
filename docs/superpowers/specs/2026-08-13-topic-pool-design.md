# 选题库（同赛道爆款分析 → 文案风格参考）

> 日期：2026-08-13　状态：设计已确认，待写实施计划

## 背景

参照另一个本地项目 `ai自媒体智能体`（MediaPilot）调研后确认：内容成败里选题权重最高（>50%），但 ForgeCast 现在的文案生成完全靠 LLM 凭空想——4 种 hook 类型（pain/sideline/infogap/story）各自有一份固定的 prompt 公式，没有"先看同赛道爆款长什么样，再照着套"这一层。

MediaPilot 有类似思路（`inspiration-insight.ts`：喂几个手动挑的爆款视频，LLM 提炼标题结构/情绪类型/推荐选题），但它的爆款获取是一条条手动粘贴链接，不是批量扫同赛道账号；且它是纯内容分析工作台（Next.js+Postgres），跟 ForgeCast（Hono+SQLite 生成工作台）技术栈不同，没法直接合并代码，只能借鉴思路重新实现。

抓取方式的选择：不自建 Playwright 无人值守定时爬虫（MediaPilot 自己代码里承认"选择器脆弱"，且无人值守固定模式的抓取行为容易触发平台风控/封号）。改用"agent 会话内手动触发"模式——用户在对话里喊一声，由当前会话的浏览器自动化工具（复用用户已登录的真实小红书/抖音会话，行为上更接近真人操作）抓取，再导入 ForgeCast 数据库。这个决定的代价是选题库无法无人值守自动更新，需要用户定期主动触发。

## 功能设计

### 数据模型（新增，`packages/core/src/db.ts` 建表）

三张新表：

**`topic_sources`**（目标账号清单，手动维护）
- `id INTEGER PRIMARY KEY`
- `platform TEXT`（`'douyin'` | `'xiaohongshu'`）
- `handle TEXT`（账号 ID/用户名，平台内唯一）
- `display_name TEXT`
- `follower_count INTEGER`（最近一次已知粉丝数，人工更新或抓取时回填）
- `note TEXT`（备注，比如"同赛道，程序员知识区头部"）
- `created_at TEXT`
- 唯一约束：`(platform, handle)`

**`viral_notes`**（抓回来的笔记/视频原始数据）
- `id INTEGER PRIMARY KEY`
- `source_id INTEGER REFERENCES topic_sources(id)`
- `platform TEXT`
- `note_id TEXT`（平台内笔记/视频 ID，去重用）
- `title TEXT`
- `play_count INTEGER`
- `like_count INTEGER`
- `collect_count INTEGER`（可为空，小红书有、抖音的"收藏"字段名不同，统一映射进这个字段；缺失存 NULL）
- `follower_count_at_scrape INTEGER`（抓取那一刻的账号粉丝数，跟 `play_count` 一起算比值，比值不会因粉丝数后续变化而失真）
- `ratio REAL`（`play_count / follower_count_at_scrape`，导入时算好存下来，避免每次查询都要 join 计算；`follower_count_at_scrape` 为 0 或空时该行 `ratio` 存 NULL）
- `scraped_at TEXT`
- `raw_json TEXT`（原始抓取数据全量存一份，供后续排查/换算法用）
- 唯一约束：`(platform, note_id)`（同一笔记多次抓到只更新，不重复插入）

**`topic_patterns`**（LLM 从一批爆款笔记里提炼出的结构）
- `id INTEGER PRIMARY KEY`
- `hook_type TEXT`（`'pain'` | `'sideline'` | `'infogap'` | `'story'`，提炼时按输入笔记的内容倾向由 LLM 自己判断归到哪一类；不强制要求所有笔记同属一类，一批笔记可能被拆分成多条 `topic_patterns` 记录，每条对应一个 hook_type）
- `title_patterns TEXT`（JSON 数组，字符串标题结构模板，如 `"XX还在用原始方式干活？这个工具直接把效率翻X倍"`）
- `emotion_type TEXT`（情绪类型描述，如"同行吐槽""结果炫耀""身份认同"）
- `topic_clusters TEXT`（JSON 数组，选题聚类描述）
- `recommended_topics TEXT`（JSON 数组，3-7 条基于这批笔记推荐的具体选题方向）
- `sample_note_ids TEXT`（JSON 数组，本次提炼用了哪些 `viral_notes.id`，可追溯）
- `created_at TEXT`

`ensureColumn`/建表迁移沿用 `packages/core/src/db.ts` 现有约定（`CREATE TABLE IF NOT EXISTS`，新库直接建全，旧库靠迁移补列——这三张是全新表，不涉及旧库迁移列的问题，直接 `CREATE TABLE IF NOT EXISTS`）。

### 新包 `packages/topics`

跟 `packages/scout`/`packages/analyst` 同级，职责：管理 `topic_sources`/`viral_notes`/`topic_patterns` 三张表的读写、笔记导入与比值计算、LLM 提炼。不依赖 `packages/copywriter`（避免循环依赖——`copywriter` 会依赖 `topics` 来读取风格参考，方向不能反过来）。

**导入笔记**：`importNotes(ctx: CoreCtx, sourceHandle: string, platform: 'douyin'|'xiaohongshu', notes: RawNote[]): { imported: number; skipped: number }`
- `RawNote = { noteId: string; title: string; playCount: number; likeCount: number; collectCount?: number }`
- 若 `topic_sources` 里没有这个 `(platform, handle)`，直接抛错（"未知账号，请先在选题库页面添加目标账号"）——不允许导入笔记时顺手隐式创建账号，账号清单必须是用户明确维护的。
- 用 `topic_sources.follower_count` 作为这批笔记的 `follower_count_at_scrape`（导入时账号的粉丝数快照）；若该账号 `follower_count` 为空，则这批笔记的 `ratio` 全存 NULL（无法计算比值，但笔记本身仍然入库，只是排序/筛选时排到最后）。
- `(platform, note_id)` 已存在则更新 `play_count`/`like_count`/`collect_count`/`scraped_at`（同一笔记数据会随时间增长，允许覆盖更新），不重复插入。

**提炼选题模式**：`extractPatterns(ctx: CoreCtx, opts: { topN?: number; minRatio?: number }): Promise<TopicPattern[]>`
- 默认 `topN=30`：从 `viral_notes` 里按 `ratio DESC`（NULL 排最后）取前 N 条尚未被任何 `topic_patterns.sample_note_ids` 引用过的笔记（避免同一批笔记反复提炼产生大量重复模式；"尚未引用过"用 JS 层面过滤，SQLite 不便直接 JSON 数组包含查询，读全部 `topic_patterns.sample_note_ids` 解析后在内存里做集合减法即可，量级不大不必优化）。
- `minRatio`：可选下限过滤（比如只要 ratio ≥ 0.5 的笔记参与提炼），不传则不过滤（只按 ratio 排序取 top N）。
- mock 模式（`ctx.config.llm.mode==='mock'`）：不调用 `ctx.llm`，走独立的 `packages/topics/src/fixtures/topic-fixture.ts`，返回一份写死的 2-3 条 `TopicPattern`（覆盖不同 hook_type），遵循项目"每个 LLM 能力必须自带 mock、mock 分支绝不碰 ctx.llm"的规矩。
- live 模式：把这批笔记的标题+数据拼进 prompt（新建 `templates/prompts/topic-pattern-extract.md`），要求 LLM 输出结构化 JSON（`zod`-style 由 `packages/topics` 自己写校验函数，不引入 zod 依赖——沿用 `packages/scout/src/intro.ts` 里 `parseIntroJson`/`validateIntro` 手写校验的既有模式，不新增第三方 schema 校验库），可能识别出多个 hook_type 类别、拆成多条 `topic_patterns` 记录一次性写入。
- 校验失败（缺字段/JSON 解析失败）整批抛错，不写入部分脏数据——跟 `generateCandidateIntro` 现有的"生成失败不写脏缓存"规矩一致。

**查询接口**：`listPatterns(ctx: CoreCtx, hookType?: HookType): TopicPattern[]`、`listSources(ctx): TopicSource[]`、`addSource(ctx, { platform, handle, displayName?, followerCount?, note? })`、`updateSourceFollowerCount(ctx, sourceId, followerCount)`、`deleteSource(ctx, sourceId)`、`listNotes(ctx, sourceId?): ViralNote[]`。

### CLI 命令（`cli.ts` 新增）

- `forgecast topics add-source --platform=<douyin|xiaohongshu> --handle=<handle> [--name=<display_name>] [--followers=<N>] [--note=<text>]` — 加目标账号
- `forgecast topics import-notes --source=<handle> --platform=<douyin|xiaohongshu> --file=<notes.json>` — 导入一批笔记（`notes.json` 是 `RawNote[]` 数组，由 agent 会话手动抓取后写成文件）
- `forgecast topics extract [--top=N] [--min-ratio=R]` — 触发 LLM 提炼，打印本次新增的 `topic_patterns` 条数
- `forgecast topics list-patterns [--hook=<pain|sideline|infogap|story>]` — 列出选题库内容（终端查看用）

### server 路由（`packages/server/src/app.ts` 新增）

Web 管理页需要的只读+轻量写接口（不含"抓取"本身，抓取只能靠 CLI+agent 会话）：
- `GET /api/topics/sources` — 目标账号清单
- `POST /api/topics/sources` — 新增账号，body `{ platform, handle, displayName?, followerCount?, note? }`
- `DELETE /api/topics/sources/:id` — 删除账号
- `PUT /api/topics/sources/:id` — 更新粉丝数/备注
- `GET /api/topics/patterns?hook=<type>` — 选题库列表（可按 hook_type 过滤）
- `POST /api/topics/extract` — 触发提炼（走任务队列 SSE，跟 `/analyze`/`/rebrand` 同构），body `{ top?, minRatio? }`

### 前端：新增"选题库"页面

挂载路径 `/topics`，导航栏新增一个入口（跟"找项目"/"拆解需求"/"做内容"/"分发营销"/"定制项目"平级）。两个区块：

1. **目标账号清单**：表格展示 platform/handle/display_name/follower_count/note，「添加账号」表单（弹窗或内联），每行「删除」「编辑粉丝数」。
2. **选题库列表**：按 `hook_type` 分 4 组卡片展示，每张卡片显示 `title_patterns`（列表）、`emotion_type`、`topic_clusters`、`recommended_topics`，卡片底部小字"基于 N 条笔记提炼于 <created_at>"。顶部「重新提炼」按钮（POST `/api/topics/extract`，SSE 订阅同 workshop 页面模式），旁边一行提示文案："抓取笔记数据需要在对话里让 Claude 帮你跑一次，这里只能对已导入的数据重新提炼。"

### 生成流程接入（`packages/copywriter/src/generate.ts`）

`assemblePrompt`（`packages/copywriter/src/assemble.ts`）现有顺序：hook 模板 → 知识库系统提示 → 检索到的知识原子 → analysis.md → 用户反馈。新增一步，插在"检索到的知识原子"之后、"analysis.md"之前：查 `packages/topics` 的 `listPatterns(ctx, hookType)`，取最新一条（`created_at DESC` 取第一条，不做复杂匹配排序——先跑通"有就用、没有就跳过"这个最简单版本），格式化成一段"参考风格"文本（标题结构示例 + 情绪类型 + 推荐选题方向），拼进 prompt。没有对应 hook_type 的模式记录时跳过这一步，不报错、不影响原有生成流程（`packages/topics` 是新增的可选依赖，`packages/copywriter` 加这个依赖后即使选题库完全是空的，生成流程也要能正常工作，等价于功能上线前的状态）。

### mock 模式

- `extractPatterns` 的 mock 分支：独立 fixture，不碰 `ctx.llm`（前面已说明）。
- `assemblePrompt` 读 `topic_patterns` 是纯 DB 查询，不涉及 LLM 调用，mock/live 两态都一样直接查表，查不到就跳过。

## 不做的事

- 不做无人值守定时爬虫——抓取永远是"用户喊一声，agent 会话内手动跑一次"。
- 不做 QR 码登录/cookie 加密持久化——复用当前 agent 会话已有的浏览器自动化能力（前提是那个浏览器里用户已经登录了小红书/抖音）。
- 暂不支持小红书/抖音之外的平台。
- 不做"选题库自动挑一条具体选题去生成"的全自动链路——`topic_patterns` 只作为文案生成时的风格参考文本拼进 prompt，不改变现有"选 hook 类型 → 生成"的交互，也不自动把某条 `recommended_topics` 塞进正文。
- 不做多账号矩阵分发策略。
- 不做前端触发抓取的按钮——Web 页面只能管理账号清单、浏览已入库的选题库、对已导入笔记重新提炼；抓取这一步永远在对话里发起。
- `topic_patterns` 的匹配逻辑先做最简单版本（按 hook_type 取最新一条），不做"更贴近当前项目/买家画像"的智能匹配排序——这轮先把链路跑通。

## 验证

- `packages/topics/test/*.test.ts`（新）：`importNotes` 未知账号抛错、比值计算正确、重复 note_id 更新不重复插入；`extractPatterns` mock 模式产出固定 fixture 不碰 `ctx.llm`、`topN`/`minRatio` 过滤正确、已被引用过的笔记不重复参与提炼、校验失败不写脏数据；`listPatterns`/`listSources` 等查询函数基本读写正确性。
- `packages/server/test/topics.test.ts`（新）：5 个路由的基本行为（404/200/SSE 任务完成）。
- `packages/copywriter/test/generate.test.ts` 补：`assemblePrompt` 在有/无匹配 `topic_patterns` 两种情况下的行为（有则拼进参考风格文本，无则跳过不报错，不影响其余生成逻辑）。
- `tsc --noEmit` + `vite build`。
- 手工验证：在对话里让 Claude 用浏览器工具抓一批真实笔记数据 → 通过 CLI 导入 → 跑一次 `extract`（live 模式）→ Web 选题库页面能看到提炼结果 → 生成一篇对应 hook 类型的文案，确认 prompt 里确实拼了参考风格文本、且不影响其余字段的生成质量。
