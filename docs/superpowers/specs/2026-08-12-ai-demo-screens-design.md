# AI 生成演示图（demo 视频模板配图）

> 日期：2026-08-12　状态：设计已确认，待写实施计划

## 背景

「做内容」板块上一轮补全后，Web 端已经能选 `demo` 视频模板（产品截图轮播）并上传 `shots/` 截图，但截图仍然要用户自己手动准备——多数开源项目换皮前用户手头并没有现成的产品截图，导致 demo 模板实际上很难用起来，做出来的视频缺配图、不够完整。

用户提出：能不能自动生成一批"看起来像产品界面"的配图，省掉手动截图这一步。确认方案是**让 LLM 现写完整 HTML 演示页面，再用 Playwright 截图**——这是项目里已有的技术路线（`packages/copywriter/src/cover.ts` 的封面生成就是同一套：LLM/模板产出 HTML → Playwright 截图），复用成熟模式而不是引入新的生成手段（比如真的去 clone 并跑起来开源项目本身，那是完全不同规模、有安全和环境依赖问题的工作）。

## 功能设计

### 入口

项目详情页右栏的 `shots` 卡片旁新增「AI 生成演示图」按钮（`btn-ink`，和「生成分析」「生成换皮清单」一样走 SSE 任务），旁边一行小字提示成本："会调用 3 次大模型 + 渲染，约十几秒到 1 分钟"。

### 内容来源（三级回退，复用项目里已有模式）

和 `ProjectDetailPage.tsx` 里"未分析时展示继承的产品说明书"是同一套回退逻辑：
1. `analysis.md` 存在 → 用其中的买家画像、痛点清单
2. 否则用候选期继承的 `intro_detail`（targetUser/painPoint/features）
3. 都没有 → 通用后台管理系统文案兜底，不因缺数据而报错

换皮方向建议里的"主打功能砍/留建议"（来自 `rebrand-plan.md`，如果已生成）也会喂给 LLM，让生成的列表页字段更贴近这个项目实际保留的功能——`rebrand-plan.md` 缺失时跳过这部分上下文，不强制要求。

### 三种页面类型

每次固定生成 3 张，对应后台产品最常见的三类页面，各自独立一次 LLM 调用（互不依赖，一张失败不影响另外两张）：

1. **数据概览仪表盘**：统计卡片 + 图表占位，体现"这个工具管理的是什么数据"
2. **核心业务列表页**：表格形式，字段呼应换皮清单里"留"的功能点
3. **详情/设置页**：表单或详情视图

Prompt 要求 LLM 输出**完整自包含的单份 HTML**（`<html>...</html>`，内联 `<style>`，不引用任何外部资源/CDN）——这是硬约束，保证 Playwright 离线渲染稳定、不因网络波动产生截图空白或加载失败。

### 渲染与产出

- Playwright 截图，视口 1600×1000（横屏，贴近桌面后台的观感；`readShots` 会按宽高判断 landscape/portrait，demo 模板对应走 `wideBg` 虚化背景处理，不是手机边框）
- 固定文件名 `ai-01-dashboard.png` / `ai-02-list.png` / `ai-03-detail.png`，落在 `workspace/<slug>/shots/`
- 加 `ai-` 前缀是为了和用户手动上传的截图区分、不会撞名覆盖；重新点按钮会覆盖这 3 个固定文件（不是每次新增一批，避免 shots/ 无限堆积）

### 容错

- 单张 HTML 校验不合法（缺 `<html>`/`</html>`，或空内容）→ 跳过这一张、`onProgress` 打警告，不阻断另外两张
- 单张渲染（Playwright 崩、超时）失败 → 同上，fail-soft
- **三张全部失败才向上抛错**（route 返回 error，SSE 显示失败）；至少出一张就算任务成功

### mock 模式

`ctx.config.llm.mode === 'mock'` 时，三种页面类型各有一份写死的 fixture HTML（品牌名做字符串替换），完全不调 `ctx.llm`——遵循项目里"每个 LLM 能力必须自带 mock、mock 分支绝不碰 ctx.llm"的既有规矩，方便离线测试和无 key 演示。

## 技术落点

- **新文件** `packages/copywriter/src/screens.ts`：`generateDemoScreens(ctx, slug, opts?: {onProgress}): Promise<{ok: string[]; failed: string[]}>`，内部按类型循环调用（LLM 或 fixture）→ 校验 → `renderScreen`（新的 Playwright 截图函数，viewport 1600×1000，比 `renderCover` 的 1242×1660 竖版参数不同，但同一套 `chromium.launch()` 模式）
- **新文件** `packages/copywriter/src/fixtures/screens-fixture.ts`：三个 mock HTML 生成函数，对齐 `packages/analyst/src/fixtures/analysis-fixture.ts`、`packages/rebrand/src/fixtures/rebrand-fixture.ts` 的命名与写法惯例
- **新路由** `POST /api/projects/:slug/screens`（`packages/server/src/app.ts`）：走任务队列 SSE，模式与 `/analyze`、`/rebrand` 完全同构；项目不存在 404
- **前端** `ProjectDetailPage.tsx` 的 shots 卡片：加按钮 + busy/log state（复用已有的 `analyze()`/`rebrand()` 那套 SSE 订阅模式），完成后 `invalidateQueries(['shots', slug])` 让文件列表刷新

## 不做的事

- 不真的 clone/npm install/跑起来开源项目本身去截图——安全风险和环境依赖都不可控，超出这轮范围
- 不做 shots/ 的删除接口（用户想去掉 AI 图目前只能覆盖重新生成或手动进 workspace 目录删文件）
- 不做"页面类型/数量可选"——固定 3 张、固定 3 种类型，先把最小可用版本做出来
- 不引入新的 CSS 框架/资源依赖，LLM 输出的 HTML 必须内联样式、零外部请求

## 验证

- `packages/copywriter/test/screens.test.ts`（新）：mock 分支产出 3 张、品牌名正确替换；HTML 校验失败时该张被跳过、其余正常；不在单测里真实调 LLM（沿用仓库现有约定），但可以像 `cover-regenerate.test.ts` 一样在 server 层做一次真实 Playwright 渲染的端到端测试（mock 模式下的 fixture HTML 一样要过 Playwright 真渲染这一关，只是不烧 LLM token）
- `packages/server/test/screens.test.ts`（新）：路由 404/200，SSE 任务完成后 `shots/` 目录出现 3 个文件
- `tsc --noEmit` + `vite build`
- 浏览器端到端：项目详情页点「AI 生成演示图」→ shots 卡片出现 3 张新文件 → 回「做内容」选 demo 模板 → 生成视频，确认新截图被用上
