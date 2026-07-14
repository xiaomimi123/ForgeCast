# ForgeCast — 开源变现内容工厂

一条「筛选开源项目 → 换皮成自有产品 → 批量生成小红书/抖音素材 → 引流接定制单」的个人内容生产流水线。当前进度：**P1 第 1-3 项**（core+server 骨架、M4 copywriter、Web 素材工坊+项目详情）。

## 技术栈
Node 20 + TypeScript + pnpm monorepo；SQLite(better-sqlite3)；Hono；Vite + React + Tailwind；Playwright（封面截图）；vitest。

## 快速开始
```bash
corepack enable && corepack use pnpm@9.15.0
pnpm install
pnpm --filter @forgecast/copywriter exec playwright install chromium  # 封面渲染依赖
cp .env.example .env    # 默认 mock 模式，无需任何 key
pnpm dev                # API :4321 + Web :5173
```
打开 http://localhost:5173 → 素材工坊 → 选 demo-project → 生成。

## 环境变量（.env）
| 变量 | 说明 |
|---|---|
| FORGECAST_LLM_MODE | `mock`（默认，无 key 演示）/ `live`（走中转站真实生成） |
| FORGECAST_LLM_BASE_URL | OpenAI 兼容中转地址，默认 aitoken.homes/v1 |
| FORGECAST_LLM_KEY | live 模式必填 |
| FORGECAST_MODEL_ANALYSIS / COPY / SCORING | 各环节模型 id |
| FORGECAST_GITHUB_MODE | `mock`（默认，无 token 用 fixture）/ `live`（走真实 GitHub API） |
| FORGECAST_GITHUB_TOKEN | live 模式可选，提升 GitHub API 限流额度 |

## CLI
```bash
pnpm exec tsx cli.ts copy <slug> --hook=pain|sideline|infogap|story [--n=N]
forgecast scout [--topics=..] [--limit=N]   # 发现开源项目、协议过滤+四维评分入候选池
forgecast scout --add=<repo-url>            # 手动投喂一个 repo
forgecast pick <owner/repo>                 # 立项：建 workspace + 落源 README/目录树到 source/
forgecast analyze <slug>                    # 生成商业化分析 analysis.md（读 source/README）
forgecast rebrand <slug>                    # 生成换皮改造清单 rebrand-plan.md（读 analysis.md）
forgecast video <slug> --tpl=flash|story|demo [--asset=<id>]  # 渲染视频（flash 文字/story 故事+配音/demo 演示，story·demo 的 TTS/真渲染需 key/录屏）
forgecast publish <id> --platform=<xhs|douyin> [--url=<link>]  # 回填发布（平台/链接）
forgecast perf <id> --views=N --likes=N --leads=N          # 回填曝光/赞/询单
forgecast lead <id> --wechat=<..> [--intent=<..>]           # 登记询单（归因到素材）
forgecast calendar                                          # 今日排期建议 + 库存/冷却
forgecast report [--since=YYYY-MM-DD]                       # 各钩子转化周报
```

## 目录结构
- `packages/core` 配置/SQLite/LLM client；`packages/copywriter` M4 文案与封面；`packages/studio` M5 视频（Remotion）；`packages/server` 本地 API
- `apps/web` Web 控制台；`templates/` 提示词与封面模板（核心资产）；`workspace/<slug>/` 每项目产物

## Docker（可选）
```bash
DOCKER_BUILDKIT=0 docker compose build   # 本机路径含中文，必须禁 BuildKit
docker compose up -d
```

## 路线图
见 `开源变现内容工厂-开发文档.md` §10：M1 抓取已交付引擎（CLI+API），Web 看板页待做；接下来是 M5 视频（Remotion）、M2 分析、M6 日历复盘。
