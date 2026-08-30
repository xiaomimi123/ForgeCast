# ForgeCast — 开源变现内容工厂

一条「筛选开源项目 → 换皮成自有产品 → 批量生成小红书/抖音素材 → 引流接定制单」的个人内容生产流水线。当前进度：**P1 第 1-3 项**（core+server 骨架、M4 copywriter、Web 素材工坊+项目详情）。

## 技术栈
Node 22+ + TypeScript + pnpm monorepo；SQLite(better-sqlite3)；Hono；Vite + React + Tailwind；Playwright（封面截图）；HyperFrames + Kokoro（视频/配音）；vitest。

## 快速开始
> 需要 Node 22+（视频渲染依赖 HyperFrames）。本地可 `nvm use`。
```bash
corepack enable && corepack use pnpm@9.15.0
pnpm install
pnpm --filter @forgecast/copywriter exec playwright install chromium  # 封面渲染依赖
cp .env.example .env    # 默认 mock 模式，无需任何 key
pnpm dev                # API :4321 + Web :5173
```
打开 http://localhost:5173 → 默认进「找项目」板块；做素材在「做内容」板块选一个已立项的项目 → 生成。

## 环境变量（.env）
| 变量 | 说明 |
|---|---|
| FORGECAST_LLM_MODE | `mock`（默认，无 key 演示）/ `live`（走中转站真实生成） |
| FORGECAST_LLM_BASE_URL | OpenAI 兼容中转地址，默认 aitoken.homes/v1 |
| FORGECAST_LLM_KEY | live 模式必填 |
| FORGECAST_MODEL_ANALYSIS / COPY / SCORING | 各环节模型 id |
| FORGECAST_GITHUB_MODE | `mock`（默认，无 token 用 fixture）/ `live`（走真实 GitHub API） |
| FORGECAST_GITHUB_TOKEN | live 模式可选，提升 GitHub API 限流额度 |
| FORGECAST_VIDEO_MODE | `render`（默认，HyperFrames 真渲 mp4）/ `stub`（写占位，测试用） |
| FORGECAST_REBRAND_EXEC_MODE | `mock`（默认，CI/测试用，不碰真实网络/claude）/ `live`（真实 git clone + 调用本机已登录的 claude CLI 无头模式改代码） |
| FORGECAST_REBRAND_EXEC_TIMEOUT_MS | live 模式下单轮 claude 无头执行超时（默认 1200000ms=20min） |
| FORGECAST_TTS_MODE | `kokoro`（默认，本地离线中文配音，免 key）/ `live`（OpenAI 兼容 /audio/speech）/ `stub`（静音占位） |
| FORGECAST_TTS_KEY / TTS_MODEL / TTS_BASE_URL | TTS live 模式必填（模型名缺失会降级并提示） |
| FORGECAST_BGM | 背景乐选曲：空=按文案 hook 情绪自动匹配 / `none`=关 / 具体文件名（不含后缀）=指定。素材放 `templates/bgm/`（gitignore），CLI 亦可 `--bgm=<name>` / `--no-bgm` |
| FORGECAST_MOOD | 手动指定情绪（覆盖 hook 自动映射）：`tense`(紧张,pain)/`upbeat`(热血,sideline)/`tech`(科技,infogap)/`warm`(温情,story)。曲子放 `templates/bgm/<情绪>/` 子文件夹，缺失则回落根目录。CLI 亦可 `--mood=<key>` |
| FORGECAST_BEAT_PYTHON | 节拍分析用的 python（含 librosa），默认回落 `FORGECAST_MELO_PYTHON`；缺失则加 BGM 但不卡点 |
| FORGECAST_ASR_PYTHON | 字幕真对齐用的本地 faster-whisper venv；缺省回落 FORGECAST_MELO_PYTHON；都不配则字幕退回按字数估算时间轴（不影响视频生成） |
| FORGECAST_CAPTIONS | 是否把旁白字幕烧进视频：默认关（模板大字标题已承担主要信息）；`on`/`1`/`true` 开。CLI 亦可 `--captions` |
| FORGECAST_BG | 科技背景变体(demo/flash/changelog)：`grid`(赛博网格,默认)/`aurora`(极光)/`matrix`(数据雨)/`synth`(合成波)/`mesh`(深空)/`random`(每条随机)。CLI 亦可 `--bg=<name>` |

> 模式设为 `live` 但缺 key 时会自动降级（LLM→mock、TTS→stub），并在命令输出里打印 `⚠` 说明——
> 看到该提示说明拿到的是 fixture 文案 / 占位音轨，不是真实生成结果。

## CLI
```bash
pnpm exec tsx cli.ts copy <slug> --hook=pain|sideline|infogap|story [--n=N]
forgecast scout [--topics=..] [--limit=N]   # 发现开源项目、协议过滤+四维评分入候选池
forgecast scout --add=<repo-url>            # 手动投喂一个 repo
forgecast pick <owner/repo>                 # 立项：建 workspace + 落源 README/目录树到 source/
forgecast analyze <slug>                    # 生成商业化分析 analysis.md（读 source/README）
forgecast rebrand <slug>                    # 生成换皮改造清单 rebrand-plan.md（读 analysis.md）
forgecast rebrand-exec <slug> [--fresh]     # 执行换皮清单的品牌层（品牌替换/删除项/中文化）：clone→claude 无头模式改代码→build验证失败重试≤3轮→报告（live 模式需本机已装并登录 claude CLI）
forgecast video <slug> --tpl=flash|story|demo|changelog|insight [--asset=<id>] [--bgm=<name>|--no-bgm] [--mood=<tense|upbeat|tech|warm>] [--captions]  # HyperFrames 渲染竖屏视频（flash 文字快闪/story 微信气泡/demo 产品截图轮播/changelog 代码变更/insight 数据卡片解说）
#   demo 需 workspace/<slug>/shots/ 放产品截图；insight 适合文案里有具体数字的项目——数据卡片直接从口播稿里挖数字句，按 TTS 逐句节奏累加淡入，没数字则只出开场大字+结尾CTA；配音默认 Kokoro 离线中文；环境依赖见 docs/hyperframes-deploy.md
#   曲库非空时自动垫 BGM：旁白响时 ducking 闪避，段/截图切换吸附节拍（卡点），强拍加缩放脉冲 + 音效；见 docs/superpowers/specs/2026-07-24-bgm-beat-sync-design.md
#   出场特效：标题大字逐字解码(故障风)+科技背景——demo(截图轮播每4拍快切+图片弹跳)/flash/changelog/insight 全套；story 只结尾卖点/CTA解码保聊天真截图感；旁白字幕默认关，--captions 开
forgecast script <slug> [--asset=<copyId>]        # 从文案生成可执行拍摄脚本（分镜表+开拍准备清单，做内容人机协作主线）
forgecast review-video <videoAssetId> [--script=<id>]  # 审片：转写(需 FORGECAST_ASR_PYTHON，缺则降级)+结构指标+LLM 对照脚本打分与建议
forgecast retro <videoAssetId>                    # 复盘：审片报告×发布数据→下一条行动建议；下一次生成文案/拍摄脚本会自动引用
forgecast publish <id> --platform=<xhs|douyin> [--url=<link>]  # 回填发布（平台/链接）
forgecast perf <id> --views=N --likes=N --leads=N          # 回填曝光/赞/询单
forgecast lead <id> --wechat=<..> [--intent=<..>]           # 登记询单（归因到素材）
forgecast calendar                                          # 今日排期建议 + 库存/冷却
forgecast report [--since=YYYY-MM-DD]                       # 各钩子转化周报
forgecast knowledge sync [--source=<dir>] [--repo=<url>]     # 拉取 dbskill 上游 → atoms.jsonl 入库（喂文案生成）
forgecast knowledge list                                    # 列出已入库知识原子
forgecast tailor add|list|decompose|search|proposal   # 定制项目：需求拆解→GitHub 找轮子→拼装方案书
forgecast topics add-source --platform=<douyin|xiaohongshu> --handle=<handle> [--name=..] [--followers=N] [--note=..]  # 选题库：加目标账号
forgecast topics import-notes --source=<handle> --platform=<douyin|xiaohongshu> --file=<notes.json>  # 导入抓到的爆款笔记（抓取本身需在对话里让 Claude 用浏览器工具手动跑）
forgecast topics extract [--top=N] [--min-ratio=R]           # LLM 提炼选题模式（标题结构/情绪类型/推荐选题）
forgecast topics list-patterns [--hook=<pain|sideline|infogap|story>]  # 列出选题库
forgecast demand <import|list|extract|star|dismiss|request|match|matches>  # 需求信号库：agent 会话内 ego-browser 采集后导入、LLM 分类提炼、star 标记看好；match=对单条信号 GitHub 现搜+评分+轻资产商业模式建议（开店卖货/私人定制），Web 端信号卡片可一键找项目/入候选池
```

### 知识层（knowledge sync，§5.6）
`knowledge sync` 默认克隆/更新 [dbskill](https://github.com/dontbesilent2025/dbskill) 上游到 `.cache/dbskill`，导入 `知识库/原子库/atoms.jsonl`（约 4176 条原子：`knowledge`→content、`topics[0]`→topic、整行→meta）入 `knowledge_atoms`，并复制 `知识库/Skill知识包/*.md` 到 `templates/knowledge/dbskill/`。文案生成时按钩子关键词 + 目标买家检索 top-8 原子注入（已 sync 用检索、未 sync 回落本地整包 md）。检索当前用 LIKE（中文短词 FTS 召回差），FTS5/embedding 属后续。

`--source=<本地 dbskill checkout 或普通 md 目录>` 可跳过克隆（普通 md 目录走 parseAtoms 回退）。**合规**：dbskill 为 CC BY-NC 4.0，仅内部创作提效；`.cache/` 与 `templates/knowledge/dbskill/` 已 gitignore，其内容不提交进本仓、不打包进对外产品（§5.6 边界）。

## 目录结构
- `packages/core` 配置/SQLite/LLM client；`packages/copywriter` M4 文案与封面；`packages/studio` M5 视频（HyperFrames + Kokoro TTS）；`packages/tailor` 定制项目板块（需求拆解→轮子搜索→评分→方案书）；`packages/topics` 选题库（目标账号+爆款笔记+LLM 提炼的选题模式，生成文案时作为风格参考注入）；`packages/server` 本地 API
- `apps/web` Web 控制台（单页应用，五个工位/板块通过顶部 tab 切换，不占独立 URL：找项目（候选卡片点「立项」打开右侧详情抽屉）/ 拆解需求（只展示分析/换皮两个拆解阶段，产素材及之后交给「做内容」「分发营销」；分析/换皮清单双 tab 读写 analysis.md + rebrand-plan.md；产物落地自动推进 stage+真实计数，手动改阶段用下拉，见 docs/superpowers/specs/2026-08-10-projects-board-upgrade-design.md、2026-08-11-rebrand-web-entry-design.md、2026-08-11-decompose-page-redesign.md）/ 做内容（文案+视频生成；视频可选模板/BGM/情绪/背景/字幕，封面可独立选模板+raw 图重新生成，素材审核/发布数据展示齐全，见 docs/superpowers/specs/2026-08-11-workshop-panel-design.md；含卡点编辑器；项目详情页可一键 AI 生成 demo 模板配图，见 docs/superpowers/specs/2026-08-12-ai-demo-screens-design.md；主线为人机协作五 tab（文案/拍摄脚本/成片上传审片/出视频(辅助)/卡点），见 docs/superpowers/specs/2026-08-14-shoot-review-design.md；另加「预览」tab，iframe 加载合成产物 hf/index.html 直接驱动其 GSAP 时间线做页内秒级播放/暂停/拖动，只读不改） / 分发营销 / 定制项目 / 选题库（目标账号清单 + 同赛道爆款笔记导入 + LLM 提炼标题结构/情绪类型，生成文案时自动引用，见 docs/superpowers/specs/2026-08-13-topic-pool-design.md）；项目详情、定制项目详情均为点卡片打开的右侧滑入抽屉，非独立页面）；`templates/` 提示词与封面模板（核心资产）；`workspace/<slug>/` 每项目产物；`workspace/tailor/<id>/` 定制方案书（proposal.md）
- `designs/` 设计稿与视觉体系参照（当前主题：生产控制台，见 docs/superpowers/specs/2026-08-28-production-console-shell-design.md；此前为锻造车间主题，见 docs/superpowers/specs/2026-08-09-forge-theme-design.md）

## Docker（可选）
```bash
DOCKER_BUILDKIT=0 docker compose build   # 本机路径含中文，必须禁 BuildKit
docker compose up -d
```

找项目板块支持收藏候选 / 每日自动抓取（server 内置调度，设置页配置开关与时间）/ 每日新增视图（按入库日期分组，14 天内）/ 点卡片打开右侧抽屉查看评分明细与产品说明书；含 项目池/需求信号 两个 tab。

## 路线图
见 `开源变现内容工厂-开发文档.md` §10。M5 视频引擎已从 Remotion 全面替换为 HyperFrames（四模板 + Kokoro 离线中文配音，见 docs/hyperframes-deploy.md），并支持 BGM 背景乐 + 节拍卡点 + 强拍音效（librosa 节拍网格 + ffmpeg ducking 混音）。
videocut 剪辑集成仍为脚手架（见 docs/m5-videocut.md）。renderer 镜像见 Dockerfile.renderer + docs/hyperframes-deploy.md。
