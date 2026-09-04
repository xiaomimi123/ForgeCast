# ForgeCast — 开源变现内容工厂

一条「筛选开源项目 → 换皮成自有产品 → 批量生成小红书/抖音素材 → 引流接定制单」的个人内容生产流水线。当前进度：主线（开发文档 §1–9）已落地；**「做内容」工位重构 P0 / P1 / P2 三阶段已收官**——七个二级 tab 收成 剪辑台 / 成片库 / 模板库 三视图，剪辑台为三栏编辑台本体（详见「做内容工位快捷键」与 `docs/剪辑台-实施说明.md`）。

## 技术栈
Node 22+ + TypeScript + pnpm monorepo；SQLite(better-sqlite3)；Hono；Vite + React + Tailwind；Playwright（封面截图）；Remotion（五模板视频渲染）+ HyperFrames（自定义模板与 Kokoro 配音链路）；vitest。

## 快速开始
> 需要 Node 22+（视频渲染依赖 Remotion / HyperFrames）。本地可 `nvm use`。首次真渲时 Remotion 会自行下载 chrome-headless-shell。
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
| FORGECAST_VIDEO_MODE | `render`（默认，真渲 mp4：五个内置模板走 Remotion，自定义模板走 HyperFrames）/ `stub`（写占位，测试用） |
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
forgecast video <slug> --tpl=flash|story|demo|changelog|insight [--asset=<id>] [--bgm=<name>|--no-bgm] [--mood=<tense|upbeat|tech|warm>] [--captions]  # Remotion 渲染竖屏视频（flash 文字快闪/story 微信气泡/demo 产品截图轮播/changelog 代码变更/insight 数据卡片解说）
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

## 做内容工位快捷键

**剪辑台**

| 键 | 动作 |
|---|---|
| `Ctrl/Cmd + Z` | 撤销（一次拖拽 = 一步） |
| `Shift + Ctrl/Cmd + Z` | 重做 |
| `Ctrl/Cmd + S` | 保存（落盘 spec） |

**成片库批量审片**（实施说明 §7）

| 键 | 动作 |
|---|---|
| `J` / `K` | 焦点下一条 / 上一条（自动滚入视口） |
| `Space` | 焦点卡播放 / 暂停（全列表只播一条，不滚页） |
| `A` | 通过（直接改状态，不弹窗，焦点跳到下一条待审） |
| `R` | 打回（本次会话内的本地标记，不改库内状态） |
| `E` | 用焦点这条成片进剪辑台 |
| `?` / `Esc` | 键位说明浮层 开 / 关 |

> 焦点在 input / textarea / select 里，或浮层开着、批量执行中，或带 Ctrl/Cmd/Alt 时，以上单键一律不触发。

## 口播合成（talk 模板，第六个模板）

把**自己拍的真人口播成片**当底片，叠 ForgeCast 生成的动效层（标题 / 卖点卡 / CTA）与手动字幕，在剪辑台里裁头尾、调音量后渲成品。设计见 `docs/superpowers/specs/2026-09-06-talk-composite-design.md`。

流程（**只有 Web 端有入口，CLI `forgecast video` 不支持 talk**）：

1. **上传**：做内容 → 成片库 →「上传成片」上传口播 mp4/mov/m4v（落 `workspace/<slug>/uploads/`，登记为 `origin='upload'` 的视频素材）。
2. **出片**：剪辑台右栏模板下拉选 `talk · 口播合成` → 多出的「口播素材」下拉里选刚上传的那条（没有上传素材时下拉换成提示，出片按钮禁用）→ 出片。成片时长 = ffprobe 量出的片源时长，视频层落在分镜轨第一条 Clip。
3. **剪辑台**：
   - **裁头尾**：拖视频 Clip 左缘=裁头（动片源起点 `trimStart`）、右缘=裁尾；与普通图层的 resize 语义不同。`spec.durationSec` 跟着联动，越界的动效层自动钳回。
   - **打字幕**：字幕轨空白处**双击**插一条手动字幕，在分镜文案列表里直接打字；字幕条可挪、可拖时长；**把文本清空即删除**这条字幕。
   - **音量**：右栏图层检查器对视频层给出 `trimStart` / `trimEnd` / `volume` 数字微调（volume 0~1）。
4. **渲成片**：走剪辑台的「渲成片」（Remotion）。

几条硬边界：

- **人声来自视频本身**，talk 不跑 TTS（`audio.narration` 恒 null），也不自动生成字幕——字幕全部手动打（很多平台会自动配字幕，烧进去非必需）。
- **科技背景默认不加**（不遮人脸），需要时在渲染参数里手选；BGM 与既有链路一致（有曲库就垫，旁白 ducking 现成）。
- talk 是 **Remotion-only**，不产 HyperFrames `index.html`。
- 底片按「零拷贝」设计**软链**进 `hf/<videoId>/assets/talk-source.mp4`（几百 MB 的口播片不每版拷一份），软链建不了的文件系统回落真拷贝。

> ⚠️ **已知问题（真渲阻断，Task 8 验收发现）**：Remotion 的静态服务器对「最终路径是软链的文件」一律回 404（只有软链**目录**能解析），于是上面这条软链让真渲直接失败（`MEDIA_ELEMENT_ERROR: Format error`）。把该软链换成真文件后全链路真渲通过。修好之前 `FORGECAST_VIDEO_MODE=render` 下的 talk 出片不可用（stub 模式不受影响）。证据与定位见 `.superpowers/sdd/2026-09-06-talk-composite/task-8-report.md`。

## 目录结构
- `packages/core` 配置/SQLite/LLM client；`packages/copywriter` M4 文案与封面；`packages/studio` M5 视频（五模板 Remotion 渲染 + 自定义模板 HyperFrames + Kokoro TTS）；`packages/compositions` 五模板的纯 React/Remotion 合成组件（零 Node 依赖，渲染与 Web 预览共用同一套组件）；`packages/tailor` 定制项目板块（需求拆解→轮子搜索→评分→方案书）；`packages/topics` 选题库（目标账号+爆款笔记+LLM 提炼的选题模式，生成文案时作为风格参考注入）；`packages/server` 本地 API
- `apps/web` Web 控制台（单页应用，五个工位/板块通过顶部 tab 切换，不占独立 URL：找项目（候选卡片点「立项」打开右侧详情抽屉）/ 拆解需求（只展示分析/换皮两个拆解阶段，产素材及之后交给「做内容」「分发营销」；分析/换皮清单双 tab 读写 analysis.md + rebrand-plan.md；产物落地自动推进 stage+真实计数，手动改阶段用下拉，见 docs/superpowers/specs/2026-08-10-projects-board-upgrade-design.md、2026-08-11-rebrand-web-entry-design.md、2026-08-11-decompose-page-redesign.md）/ 做内容（原七 tab 收成三视图：**剪辑台**——真正的三栏编辑台本体：左栏内容队列（一条内容=一张 `ContentItem` 卡，聚合文案+封面+成片）+ 钩子筛选；中栏 9:16 播放器（@remotion/player 直播 `SpecComposition`）+ 分镜文案列表（改字失焦即重渲该镜画面、每镜可「让 LLM 重写这段文案」）；右栏检查器——图层属性（位置/字号/颜色/对齐/特效）即时生效，渲染参数（背景/BGM/情绪）暂存到本地草稿、点「用新参数重渲」才一次性提交（表头「改动 N 项」），模板/比例/字幕等需要重新生成的参数灰显只读；底部时间轴（**刻度/分镜/字幕/BGM 波形/卡点 五轨**：拖分镜移动、拖右缘改时长，吸附卡点、组内碰撞钳制；BGM 轨画当前曲子的波形峰值（`GET …/waveform`，ffmpeg 解码 ≤1000 个峰值，取不到只灰显「波形不可用」、不挡任何编辑）；卡点轨三态菱形——红实心=已用强拍、灰=检出未用（点一下把最近的分镜入点移到这一拍）、空心=手动卡点（卡点轨空白处**双击**添加、点它删除），手动卡点随 spec 落盘，换 BGM/情绪重析节拍时保留）。整条编辑链路走 `GET/PUT/reset/render/rewrite-section/pick-bgm/waveform` 七个 spec 端点，`Ctrl/Cmd+Z` 撤销、`Cmd/Ctrl+S` 保存，⋯ 菜单「重置为生成结果」按 `.orig.json` 快照逐字节回出厂。**用户须知**：撤销历史只在当前会话内有效（刷新页面即丢失，落盘的仍是最后一次保存点）；「重置为生成结果」丢弃的是磁盘上的手工改动，且此操作本身不可撤销；LLM 重写与直接改字都只换文案画面，旁白配音沿用上一版（不会重新配音，画面文字与旁白可能不一致）；换 BGM / 情绪走服务端 `POST …/pick-bgm`（选曲 + 重析节拍 + 落盘一体，librosa 不可用时**仍换曲**只是没网格可吸附），情绪下拉的选项来自 `templates/bgm/<情绪>/` 实际存在的子目录。窄屏 `<1240` 右栏收抽屉、`<1040` 左栏也收抽屉（时间轴同时降到 148 高、只留刻度/分镜/卡点三轨）。**成片库**——6 列网格批量审片（勾选批量通过 / 批量重渲，键盘流见上文「做内容工位快捷键」）+ 发布与表现数据只读回显；**模板库**——对标视频与模板资产。旧的独立「卡点」编辑器（`CutPlanEditor`）**入口已于 P2 移除**，卡点编辑全部由时间轴的卡点轨接管；组件文件与 `/api/projects/:slug/cutplan` 端点原样保留，老项目数据不丢。三视图间切换不跳出页面（切走剪辑台/切工位/打开项目详情三条路径都过「未保存改动」闸），工位面包屑压进顶部 Header，见 docs/剪辑台-实施说明.md、docs/superpowers/specs/2026-09-03-content-station-editor-design.md 与三份实施计划 docs/superpowers/plans/2026-09-0{3,4,5}-content-station-p{0,1,2}.md） / 分发营销 / 定制项目 / 选题库（目标账号清单 + 同赛道爆款笔记导入 + LLM 提炼标题结构/情绪类型，生成文案时自动引用，见 docs/superpowers/specs/2026-08-13-topic-pool-design.md）；项目详情、定制项目详情均为点卡片打开的右侧滑入抽屉，非独立页面）；`templates/` 提示词与封面模板（核心资产）；`workspace/<slug>/` 每项目产物；`workspace/tailor/<id>/` 定制方案书（proposal.md）
- `designs/` 设计稿与视觉体系参照（当前主题：生产控制台，见 docs/superpowers/specs/2026-08-28-production-console-shell-design.md；此前为锻造车间主题，见 docs/superpowers/specs/2026-08-09-forge-theme-design.md）

## Docker（可选）
```bash
DOCKER_BUILDKIT=0 docker compose build   # 本机路径含中文，必须禁 BuildKit
docker compose up -d
```

找项目板块支持收藏候选 / 每日自动抓取（server 内置调度，设置页配置开关与时间）/ 每日新增视图（按入库日期分组，14 天内）/ 点卡片打开右侧抽屉查看评分明细与产品说明书；含 项目池/需求信号 两个 tab。

## 路线图
见 `开源变现内容工厂-开发文档.md` §10。M5 视频引擎：五个内置模板（flash/story/demo/insight/changelog）已改由 **Remotion** 渲染（合成组件在 `packages/compositions`，Web 预览与成片共用），自定义模板与 Kokoro 离线中文配音、BGM/节拍卡点/强拍音效（librosa 节拍网格 + ffmpeg ducking 混音）仍走 **HyperFrames** 链路。
videocut 剪辑集成仍为脚手架（见 docs/m5-videocut.md）。renderer 镜像见 Dockerfile.renderer + docs/hyperframes-deploy.md——**该镜像尚未在 Remotion 下验证**，详见该文档。
