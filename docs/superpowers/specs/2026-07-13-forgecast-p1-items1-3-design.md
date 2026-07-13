# ForgeCast P1（第 1-3 项）设计文档

> 日期：2026-07-13
> 依据：《开源变现内容工厂-开发文档.md》v1.0（下称"主文档"）
> 范围：P1 里程碑第 1-3 项 —— core+server 骨架、M4 copywriter、Web 控制台（素材工坊 + 项目详情）
> 关键约束：**当前没有任何 API key**（LLM / GitHub PAT / TTS 均未就绪）

---

## 1. 目标与验收标准

构建 forgecast monorepo 的第一个可运行垂直切片。验收标准（对应主文档附录 B）：

1. `forgecast dev` 一键启动：API（localhost:4321）+ Web 控制台（localhost:5173）
2. 在素材工坊页面选择 `workspace/demo-project`，点「生成」（pain 钩子）→ 产出文案 markdown + 封面图
3. 文案可行内编辑、可「审核通过」（draft → approved）
4. 全流程在 **mock LLM 模式**下无 key 跑通；后续在 `.env` 填 key 即切换真实生成，零代码改动

## 2. 范围边界

**做**：core（SQLite/config/LLM client/数据模型）、server（Hono REST + SSE + 静态托管）、copywriter（4 钩子提示词模板 + 3 套封面 HTML + 敏感词校验 + dbskill 知识层骨架）、Web 两页（素材工坊、项目详情）、CLI（dev/copy 两个命令）、Docker Compose 骨架、demo-project 示例数据。

**不做（后续 item 4-7 / P2）**：M5 studio（Remotion/TTS）、M2 analyst 执行逻辑、M1 scout 抓取、M6 日历与复盘、renderer 镜像实装、dbskill 真实上游同步（只建表 + 少量示例原子跑通 FTS 检索路径）。

## 3. 架构

严格遵循主文档 §1：引擎与界面分离，所有能力为 core 函数，Web 经本地 API 调用，CLI 是同一套函数的第二入口。

```
forgecast/（即本目录，pnpm monorepo）
├── packages/
│   ├── core/          # SQLite(better-sqlite3, WAL)、config 加载、LLM client、共享类型
│   ├── copywriter/    # M4：提示词组装、生成、敏感词校验、封面渲染、FTS 检索
│   └── server/        # Hono：REST + SSE 任务进度 + workspace/ 静态托管 + web 产物托管
├── apps/
│   └── web/           # Vite + React + shadcn/ui + TanStack Query
├── templates/
│   ├── prompts/       # analysis.md、copy-{sideline,infogap,story,pain}.md、funnel.md
│   ├── covers/        # 3 套封面 HTML（大字报 / 截图标注 / 对比）
│   └── knowledge/     # dbskill 知识包占位（P1 放示例 md）
├── workspace/demo-project/   # 含手写 analysis.md 的演示项目
├── docs/superpowers/specs/   # 设计文档（本文件）
├── forgecast.config.ts
├── cli.ts
├── docker-compose.yml + Dockerfile（app；renderer 仅留骨架注释）
└── .env.example
```

## 4. 核心设计决策

### 4.1 LLM client：mock/live 双模式（无 key 约束的核心解法）

`packages/core/src/llm.ts` 暴露统一接口 `complete(opts): Promise<string>`，OpenAI 兼容格式。

- 模式由 `FORGECAST_LLM_MODE=mock|live` 控制；**默认 mock**（无 key 也能跑），`.env` 有 `FORGECAST_LLM_KEY` 且 mode=live 时走 `https://aitoken.homes/v1`
- mock 实现：按钩子类型返回结构完整、内容真实感的 fixture 文案（标题×3 / 小红书正文 / 抖音口播脚本 / 封面文案 / 评论区运营），fixture 内容基于 demo-project 的 analysis.md 手写，保证界面演示可信
- live 实现：标准 chat completions 调用，模型名从 `forgecast.config.ts` 的 `models` 映射取
- 失败处理：live 模式重试 2 次（指数退避），仍失败则任务标记 failed 并经 SSE 透传错误；**不落盘部分产物**

### 4.2 数据层

- SQLite 文件在 `db/forgecast.db`，启动时执行迁移（建主文档 §2 的 candidates / projects / assets 三表 + §5.6 的 knowledge_atoms + atoms_fts）
- WAL 模式开启（主文档 §12.5）
- P1 实际读写：projects、assets、knowledge_atoms/atoms_fts；candidates 只建表

### 4.3 生成流水线（一次「生成」的完整数据流）

1. Web 素材工坊点「生成」→ `POST /api/projects/:slug/copy { hook, n, feedback? }`
2. server 创建内存任务（单进程队列，并发 1），立即返回 taskId；前端订阅 `GET /api/tasks/:id/events`（SSE）
3. copywriter 组装提示词（顺序按主文档 §5.6）：钩子模板 + 知识包 md + FTS top-8 原子（检索词 = 钩子关键词 + analysis.md 行业/痛点词）+ analysis.md +（重新生成时）用户修改意见
4. 调 `core/llm.complete` → 解析产物 → **本地敏感词表二次校验**（命中则该篇标记 warning，不阻断，界面高亮提示）
5. 文案写入 `workspace/<slug>/copy/<hook>-<时间戳>-<n>.md`，assets 表插入 type=copy 记录
6. 封面：Playwright 加载 `templates/covers/` 模板（CSS 变量填槽封面文案）截图 1242×1660 → `covers/`，assets 插入 type=cover
7. SSE 逐步推进度（组装→生成→校验→封面→完成），前端实时显示日志

### 4.4 server API（P1 全集）

```
GET  /api/projects                     # 项目列表
GET  /api/projects/:slug               # 详情（含 analysis.md 内容）
PATCH /api/projects/:slug              # 编辑 demo_url/定价/买家画像
POST /api/projects/:slug/copy          # 触发生成 → { taskId }
GET  /api/tasks/:id/events             # SSE 进度
GET  /api/projects/:slug/assets        # 素材列表
GET  /api/assets/:id/content           # 文案 markdown 原文
PUT  /api/assets/:id/content           # 行内编辑保存（直接写回文件）
PATCH /api/assets/:id                  # 状态流转 draft→approved
POST /api/projects/:slug/raw           # raw/ 素材上传（multipart）
GET  /files/*                          # workspace/ 静态托管（预览封面/录屏）
```

### 4.5 Web 控制台（两页）

- **素材工坊**（核心页）：左侧项目 + 钩子选择 + 「生成」按钮 + SSE 实时日志；右侧素材列表 —— 文案 markdown 预览（react-markdown）+ 行内编辑（textarea 切换）、封面缩略图、每条 draft→approved 一键审核、「重新生成」附修改意见（拼入提示词重跑）
- **项目详情**：analysis.md 渲染阅读、项目字段编辑、raw/ 素材拖拽上传
- 无分页，全量拉取 + 前端过滤（主文档 §8）

### 4.6 CLI

`cli.ts` 提供 P1 需要的命令：`forgecast dev`（并起 server + vite）、`forgecast copy <slug> --hook=<型> --n=<篇数>`（直接调 copywriter core 函数，验证 CLI/Web 同源）。其余命令注册占位，打印"未实现（P1 item N）"。

### 4.7 Docker Compose 骨架

按主文档 §12 写 compose + app Dockerfile；renderer 服务在 compose 中注释占位（item 4 实装）。
**注意：本机路径含中文，构建时必须 `DOCKER_BUILDKIT=0`**（已知 buildx 对非 ASCII 路径有 bug）。P1 日常开发以宿主机 `forgecast dev` 为主，Docker 构建验证一次即可。

## 5. 模板资产（P1 交付的初版）

- `templates/prompts/copy-{hook}.md` ×4：按主文档 §5.1 公式各写一版骨架，硬编码违禁词规避规则（不出现"最/第一/保证赚钱"等），预留 `{{analysis}}` `{{knowledge}}` `{{feedback}}` 插槽
- `templates/prompts/funnel.md`：私域话术库初版（结尾钩子 ×2、评论回复模板）
- `templates/covers/` ×3 套 HTML：大字报型 / 截图+标注型 / 对比型，CSS 变量控制配色与文案槽
- 敏感词表 `packages/copywriter/src/banned-words.ts`：广告法 + 平台敏感词初版清单，纯本地字符串匹配

## 6. 测试策略

TDD（写实现前先写测试）。mock LLM 使全链路测试无需 key：

- core：config 加载、迁移建表、llm mock/live 切换逻辑（live 用 fetch stub）
- copywriter：提示词组装顺序、敏感词校验命中/放行、产物文件落盘与 assets 登记、FTS 检索 top-8
- server：API 集成测试（内存 SQLite + 临时 workspace），SSE 事件序列
- Web：不写 UI 单测（单人工具，人工验收），以最终 e2e 手动走查为准

## 7. 风险与对策

| 风险 | 对策 |
|---|---|
| mock 文案与真实 LLM 产物结构不一致，切 live 后解析失败 | 定义严格的产物 schema（markdown 分节约定），mock 与 live 共用同一解析器，解析失败即任务失败 |
| 中文路径破坏工具链（Docker/依赖） | Docker 构建禁 BuildKit；monorepo 内部全部相对路径 |
| Playwright 截图依赖 Chromium 下载 | `pnpm exec playwright install chromium` 纳入 setup 文档；失败时封面步骤可跳过（文案照常产出） |
| SQLite 并发 | P1 单进程写库，天然无冲突；WAL 先开好 |

## 8. 后续路径

item 4（M5 studio）→ item 5（M2 analyst）→ item 6（M1 scout + 看板）→ item 7（M6 + 日历/复盘页）。每项独立 spec 或直接按主文档执行，本设计的 core/server/任务队列/SSE 均为其复用基础。
