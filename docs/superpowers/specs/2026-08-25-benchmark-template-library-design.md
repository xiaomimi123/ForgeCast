# 对标视频拆解 → 模板库 设计

## 背景

现状"做内容"页「出视频」tab 只有 5 个写死的 HyperFrames 模板（flash/story/demo/changelog/insight），全部固定 1080×1920 竖屏，模板内容/节奏都是手写死代码。用户希望能上传一条对标视频，系统拆解它的结构节奏，生成一个可复用的新模板存进"模板库"，以后任何项目选中它就能用当前文案渲染视频；同时希望支持横屏/竖屏两种比例选择。

## 已与用户对齐的关键决定

1. **拆解深度**：只做结构节奏层面（分段时长/切换节奏），不做视觉风格分析（不看画面配色/字体），也不做语义理解（不做 ASR）。
2. **拆解方式**：纯自动，只用 ffprobe 时长 + ffmpeg 场景切换检测拿切镜时间点，不需要用户标注。
3. **产物形态**：每次拆解生成一个持久化的新模板，存入"模板库"，和现有 5 个模板平起平坐地出现在选择列表里（而不是一次性临时渲染）。
4. **视觉风格**：让 LLM 根据拆解出的节奏数据自由设计新模板的 HTML/CSS（不是套用现有模板换皮），用户额外提供一个选填的风格描述文本框帮 LLM 找方向。
5. **横竖屏比例**：只对新的"对标拆解模板"开放选择；现有 5 个内置模板保持固定竖屏不动（改造它们去适配横屏工作量大、有失真风险，不在本次范围内）。
6. **内容来源不变**：模板只定义结构容器（几段、每段多长、什么视觉处理），实际画面文字仍然来自当前项目的文案（口播稿切句/cue），不是照抄对标视频里说了什么。
7. **入口位置**：做内容页新增一个独立 tab"模板库"（现有 文案/拍摄脚本/成片/出视频/卡点 五 tab 之后）。

## 现有系统摸底

- `templates/hf/*.html`：现有 5 个模板文件，都遵循统一的 HyperFrames 标记契约——根节点 `data-composition-id="main" data-start="0" data-duration="{{duration}}" data-width="1080" data-height="1920"`；`<!--HF_AUDIO-->`/`<!--HF_CAPTIONS-->` 标记供 `injectAudioCaptions()` 注入配音轨与字幕；`<!--HF_FXCSS-->`/`<!--HF_BG-->`/`<!--HF_BGANIM-->` 标记供 `injectTechFx()` 注入科技背景体系；`<!--HF_SECTIONS-->` 标记（insight/demo/story 用）供各自的 `buildXSections()` 注入动态分段 HTML；`{{}}` 占位符（如 `{{duration}}`、`{{painTitle}}`）由 `fillTemplate(html, slots)` 纯字符串替换填充。
- `packages/studio/src/generate.ts`：`generateVideo(ctx, input)` 按 `tpl` 参数分支（flash/story/demo/changelog/insight），每支流程一致：TTS 配音 → 选 BGM → `fillTemplate` 填基础 slot → `injectTechFx` → `injectAudioCaptions` → `fillAccents` → `scaffoldHfProject` → `renderAndRegister`（spawn `hyperframes render`）。
- `packages/studio/src/hyperframes.ts`：`buildInsightSections()`（L505 附近）是最接近的既有先例——把 TTS cue 按时间点分桶塞进卡片段，产出 `{html, accents}` 供 `<!--HF_SECTIONS-->` 替换。`spawnWithTimeout()` 是所有子进程调用（render/tts/beat_grid）的统一超时包装。
- `packages/studio/src/review.ts`：`probeDuration(mp4Abs)`（ffprobe 时长，fail-soft 返 null）+ `ReviewDeps` 依赖注入模式（`runFfmpeg`/`probe` 可在测试里替身）——本次拆解步骤照此模式写。
- LLM capability mock/live 分支惯例（`score.ts`/`script.ts`/`retro.ts` 等一致写法）：`if (ctx.config.llm.mode === 'mock') return <fixture>` 否则读 `templates/prompts/<name>.md` 拼 prompt、`ctx.llm.complete({model: ctx.config.llm.models.xxx, system, prompt})`、解析校验，失败抛错不落库。
- `packages/server/src/app.ts` L335 `upload-video` 路由：multipart 文件上传的既有写法（`c.req.parseBody()`、扩展名白名单、`fs.writeFileSync`）。耗时任务统一走 `queue.enqueue((log) => ...)` 返回 `{taskId}`，前端 `subscribeTask` 订阅 SSE。
- `packages/core/src/db.ts`：`CREATE TABLE IF NOT EXISTS` + `ensureColumn` 幂等迁移惯例。

## 设计

### 1. 拆解：`analyzeBenchmark`（新文件 `packages/studio/src/benchmark.ts`）

```ts
export interface Pacing { durationSec: number; segments: { start: number; end: number }[] }
export interface BenchmarkDeps { probe?: (path: string) => Promise<number | null>; detect?: (path: string) => Promise<number[]> }
export async function analyzeBenchmark(videoPath: string, deps: BenchmarkDeps = {}): Promise<Pacing>
```

- `probe`：复用 `review.ts` 的 `probeDuration`。
- `detect`：`ffmpeg -i <path> -vf "select='gt(scene,0.4)',showinfo" -f null -`，解析 stderr 里 `showinfo` 的 `pts_time:` 提取切镜时间戳数组（fail-soft：解析失败/ffmpeg 缺失返回空数组，不抛错，走回退分段）。
- 分段规则：把切镜时间点转成连续区间；**少于 2 个分段**（单镜头到底/检测失败）时回退成默认 3 段均分（呼应现有 flash 的"开头钩子/中段/结尾 CTA"三段式）；**超过 8 个分段**时按时长均匀抽样保留 8 个代表性切点（避免过密切镜生成一个塞不下文字的模板）。`MIN_SEGMENTS=2`、`MAX_SEGMENTS=8` 定义为常量。
- 纯函数 + deps 注入，`ffmpeg`/`ffprobe` 均通过 `spawnWithTimeout`（复用 `hyperframes.ts` 现成的超时/kill 逻辑）调用，超时/失败均 fail-soft 走回退分段，不让整条流程因为一个探测失败而中断。

### 2. LLM 生成模板：`generateCustomTemplate`（新文件 `packages/studio/src/custom-template.ts`）

```ts
export interface CustomTemplateInput { pacing: Pacing; aspectRatio: 'portrait' | 'landscape'; styleNote?: string }
export interface CustomTemplateResult { html: string; segmentCount: number }
export async function generateCustomTemplate(ctx: CoreCtx, input: CustomTemplateInput): Promise<CustomTemplateResult>
```

- mock 模式：`mockCustomTemplateHtml(segmentCount, aspectRatio)`（新 fixture 文件 `packages/studio/src/fixtures/custom-template-fixture.ts`）——手写一个满足下方契约的简单模板（纯色背景+居中文字+淡入淡出），保证 mock 全链路可测、不烧 LLM 额度。
- live 模式：读 `templates/prompts/custom-template.md`，system 提示词给出**严格产出契约**（写进 prompt 而非代码校验里现拼）：
  - 根节点 `data-composition-id="main" data-start="0" data-duration="{{duration}}" data-width="<W>" data-height="<H>"`（`<W>/<H>` 按 aspectRatio 代入 `1080/1920` 竖屏或 `1920/1080` 横屏，prompt 里直接给出这两个数字，不留给 LLM 自己算）。
  - 恰好 `pacing.segments.length` 个分段 div，编号 `s0..s{N-1}`，每个必须带 `class="clip"` + `data-start="{{seg{K}_start}}"` + `data-duration="{{seg{K}_dur}}"` + `data-track-index="1"`，内部文字用 `{{seg{K}_text}}` 占位（K 为段序号，从 0 开始）。
  - 必须包含 `<!--HF_AUDIO-->` 和 `<!--HF_CAPTIONS-->` 两个标记各一次（配音轨/字幕注入点，不得自己写 `<audio>` 标签）。
  - CSS/字体/背景/GSAP 动效全部自由设计，可以参考风格描述文本；只需引入 `gsap.min.js`（已固定提供）。
  - 明确禁止：不出现 `<video>`/外链图片/外链字体（离线渲染环境不可用网络）。
  - `ctx.llm.complete({model: ctx.config.llm.models.copy, system, prompt})`，prompt 里把 `pacing.segments` 的相对时长比例、`aspectRatio`、`styleNote`（若有）都列进去。
- **校验（失败整批抛错，不落库，沿用仓库惯例）**：
  1. 正则检查产出 HTML 是否恰好包含要求的全部占位符（`{{duration}}`、每段 `{{segK_start}}/{{segK_dur}}/{{segK_text}}`、`<!--HF_AUDIO-->`/`<!--HF_CAPTIONS-->` 各恰好一次、`data-width="<W>" data-height="<H>"`）——未通过视为格式错误。
  2. 通过后，用示例值（`duration=15`，每段按均分时长、文字填"示例文字"）填一份临时 HTML，`scaffoldHfProject` 到临时目录，spawn `hyperframes check <dir>` 校验 HyperFrames 结构合法性。
  3. 1/2 任一失败：**重试一次**（把错误信息追加进 prompt 再问一遍 LLM）；仍失败则抛错，调用方不落库、把错误原样返回前端。

### 3. 存储：`custom_templates` 表 + 文件

`packages/core/src/db.ts` 新增：

```sql
CREATE TABLE IF NOT EXISTS custom_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  aspect_ratio TEXT NOT NULL,       -- 'portrait' | 'landscape'
  segment_count INTEGER NOT NULL,
  style_note TEXT,
  benchmark_path TEXT,              -- workspace 相对路径，留档用，不参与渲染
  segments_json TEXT NOT NULL,      -- Pacing.segments 原样存，供 generate.ts 按比例算 segK_start/segK_dur
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)
```

模板 HTML（含未填充的 `{{}}` token）落 `templates/hf/custom/<id>.html`（全局共享目录，不挂在项目下——任何项目都能选用）。对标视频原片存 `workspace/_templates/<id>/benchmark.<ext>`（`_templates` 前缀避开跟 slug 撞名）。

### 4. Server 路由（`packages/server/src/app.ts`）

- `POST /api/templates`：multipart（`file`/`aspectRatio`/`styleNote?`/`name`）。参照 `upload-video` 校验扩展名（mp4/mov/m4v）+ 同步写文件到 `workspace/_templates/<临时id>/benchmark.<ext>`；随后 `queue.enqueue((log) => createCustomTemplate(ctx, {...}, log))` 返回 `{taskId}`。`createCustomTemplate`（`custom-template.ts` 里的编排函数）串联 `analyzeBenchmark` → `generateCustomTemplate` → 校验通过后写文件+插入 `custom_templates` 行。
- `GET /api/templates`：列出 `custom_templates` 全部行（不含 html 正文，只要 id/name/aspect_ratio/segment_count/style_note/created_at）。
- `DELETE /api/templates/:id`：删行 + 删 `templates/hf/custom/<id>.html` + 删 `workspace/_templates/<id>/`。

### 5. 渲染接入（`generate.ts`）

`tpl` 参数新增约定：内置模板名不变（`flash`/`story`/`demo`/`changelog`/`insight`），自定义模板用 `custom-<id>` 前缀区分（如 `custom-3`）。`generateVideo` 顶部加一支分流：

```ts
if (tpl.startsWith('custom-')) {
  const id = Number(tpl.slice(7))
  const row = ctx.db.prepare('SELECT * FROM custom_templates WHERE id = ?').get(id)
  if (!row) throw new Error(`自定义模板不存在: ${tpl}`)
  return renderCustomTemplate(ctx, row, { slug, copy, video, onProgress })
}
```

`renderCustomTemplate`（新函数，`generate.ts` 内）流程与 flash 分支一致（TTS 配音 → 选 BGM → 组装 → 渲染），唯一差异是分段填充：`segK_start`/`segK_dur` 按 `row.segments_json` 里各段的**相对时长比例**乘以最终配音时长算出（复用"时长自适应"惯例，不是照搬对标视频的绝对秒数）；`segK_text` 按同样的比例区间从 TTS cue 里分桶取文字拼接（`buildInsightSections` 已有的分桶算法可直接复用/提取成共享函数）。填完后 `fillTemplate` → `injectAudioCaptions`（`<!--HF_FXCSS-->`/`<!--HF_BG-->` 若模板未包含则 `injectTechFx` 自然跳过，不强制）→ `scaffoldHfProject` → `renderAndRegister`。

### 6. Web

- `apps/web/src/pages/WorkshopPage.tsx`：`TABS` 追加 `{ key: 'templates', label: '模板库' }`。
- 新文件 `apps/web/src/pages/workshop/TemplatesTab.tsx`：
  - 上传区：文件选择（mp4/mov/m4v）+ 比例单选（竖屏/横屏）+ 风格描述文本框（选填）+ 模板名输入 + "拆解并生成"按钮 → `POST /api/templates`（`FormData`）拿 `taskId` → 复用现有 `subscribeTask` 模式把进度打进日志区。
  - 列表区：`GET /api/templates` 展示已有自定义模板卡片（名字/比例/分段数/创建时间/删除按钮）。
- `apps/web/src/pages/workshop/VideoTab.tsx`：`VIDEO_TPLS` 数组由静态常量改成"内置 5 个 + 从 `useQuery(['templates'], ...)` 拉到的自定义模板列表"拼接（`value` 用 `custom-${id}`，`label` 用模板名 + "（对标拆解）"后缀区分）。
- `apps/web/src/api.ts`：新增 `CustomTemplate` 类型 + 两个 fetch 封装（列表/删除），上传走 `FormData` 直连 fetch（现有 `api()` 封装假设 JSON body，参照项目里其它文件上传处理方式——若 `api()` 已支持自定义 body 类型则复用，否则本页面单独写一个 fetch 调用，不强改公共封装）。

## 测试

- `packages/studio/test/benchmark.test.ts`：`analyzeBenchmark` 用 deps 注入假 `probe`/`detect`——验证 <2 段回退默认三段均分、>8 段裁剪到 8、正常场景直接透传；探测失败（deps 抛错/返回空）不抛错走回退。
- `packages/studio/test/custom-template.test.ts`：
  - mock 模式：`generateCustomTemplate` 返回的 HTML 满足占位符正则（用真实 `pacing` 跑一遍 fixture，断言每段 token 都在）。
  - live 模式：假 `ctx.llm`，第一次返回缺 token 的坏 HTML → 断言触发重试（第二次调用 prompt 里含错误提示）→ 第二次仍坏 → 断言抛错。
  - live 模式：假 `ctx.llm` 返回合法 HTML，假 `hyperframes check` 校验通过 → 正常返回。
- `packages/server/test`：`POST /api/templates` 上传+mock 全链路跑通，`custom_templates` 表插入一行；`GET`/`DELETE` 基本 CRUD。
- `packages/studio/test/generate.test.ts`：`generateVideo` 传 `tpl='custom-1'`（预先塞一行 fixture 数据 + fixture html）走 stub 渲染模式，断言 `renderCustomTemplate` 分支被正确路由、segK 占位符按比例填了数值。
- 前端不加自动化测试（沿用仓库惯例），`pnpm --filter web exec tsc --noEmit` + 人工点击验证（上传一条对标视频拆解出模板 → 出视频 tab 选中它 → 渲染出真实视频）。

## 不做的事

- **不做 ASR/语义理解**：拆解只拿切镜时间点，不分析对标视频说了什么、画面是什么内容。
- **不改造现有 5 个内置模板去适配横屏**：它们保持固定 1080×1920，横竖屏选择只对新的自定义模板开放。
- **不做模板编辑器**：生成后的模板 HTML 不提供可视化调整界面，不满意只能重新拆解生成一次（或删除重来），不做"微调已有模板"的能力。
- **不做多对标视频融合**：一次拆解只处理一条对标视频，不支持"揉合两条视频的节奏"。
- **不限制风格描述文本内容**：不做敏感词过滤/长度硬限制之外的校验，用户自己对输入负责。
- **不做模板质量自动评分**：生成后是否好看完全靠人工看渲染出的视频判断，系统只保证结构合法（`hyperframes check` 过）不保证美观。
