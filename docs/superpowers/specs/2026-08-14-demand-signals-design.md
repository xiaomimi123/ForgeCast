# 需求信号库设计（产品重心调整第一步 B）

## 背景与定位

产品重心调整（用户 2026-08-14 确认）：核心从"内容生成工具"转向**需求驱动的选品+商业模式引擎**。整体拆三个子项目依次做：

- **B. 需求信号库**（本 spec）：采集需求侧信号（热点流量/情绪价值产品），建数据地基。
- **C. 需求×项目匹配 + 轻资产商业模式**（后续）：拿 starred 的需求信号反向匹配 GitHub 项目，分析报告升级为"开店卖货 or 私人定制"的轻资产模式建议。
- **A. 脚本/分镜指导 + 成片打分闭环**（后续）：做内容主线换成"系统出拍摄脚本+分镜表 → 用户自己拍 → 上传成片 → 内容审片打分 + 发布后数据修正 → 下条优化建议"；现有五个自动渲染模板降为辅助保留。

现状问题：找项目只扫 GitHub（供给侧），选出来的项目"star 高但不一定有人买单"。需求信号库补上需求侧：市场上什么在爆、用户在为什么买单，让 C 阶段的选品天生带流量和买单理由。

## 采集约束（更新版）

原约束"不做无人值守定时爬虫，人看人录"升级为：**仍不做无人值守定时爬虫，但采集由 agent 会话内用 ego-browser（ego-lite）自动浏览+分析+入库**——ego-lite 是对 AI Agent 友好的浏览器，Agent 在独立空间工作、复用用户登录态（不用反复扫码）。用户只负责触发（对话里喊，或 Web 页打"请求采集"标记）和抽查结果。系统代码里零抓取逻辑。

## v1 数据源（用户确认全选）

1. 抖音热点榜（热点流量型主来源）
2. 小红书热门/搜索发现（情绪价值型信号多）
3. GitHub Trending（供给侧热度）
4. 电商榜单（淘宝/拼多多热销；反爬严重时尽力而为、记录跳过，不阻塞其他源）

## 数据模型

新表 `demand_signals`（packages/core/src/db.ts）：

| 字段 | 类型 | 说明 |
|---|---|---|
| id | INTEGER PK | |
| source | TEXT | douyin_hot / xhs / github_trending / ecommerce |
| kind | TEXT | traffic(热点流量) / emotional(情绪价值) / supply(供给热度)；入库时可空，extract 后填 |
| title | TEXT NOT NULL | 信号名（热点词/商品名/仓库名） |
| summary | TEXT | 一句话说明 |
| evidence | TEXT (JSON) | 链接/热度值/销量/榜位等原始证据 |
| heat | REAL | 热度分（同源内可比即可，不跨源归一） |
| opportunity | TEXT | LLM 提炼的"可承接产品方向"一句话；extract 后填 |
| status | TEXT DEFAULT 'new' | new / starred(看好) / dismissed(忽略) / matched(已被 C 匹配) |
| captured_at | TEXT | 采集时间 |
| created_at | TEXT DEFAULT datetime('now') | |

去重键：UNIQUE(source, title)——同源同名信号重复导入视为更新（heat/evidence/captured_at 覆盖）。

## 模块结构（新包 packages/demand，同构于 packages/topics）

- `src/signals.ts`：addSignal / importSignals（批量 upsert）/ listSignals（按 source/kind/status 筛）/ setStatus
- `src/extract.ts`：extractSignals——取 kind 为空的新信号批量调 LLM 分类 + 生成 opportunity；mock 走 fixture，live 调 LLM；校验失败整批抛错不写脏数据（照抄 topics/patterns.ts 模式）
- `src/fixtures/demand-fixture.ts`：mock fixture（永不调 ctx.llm）
- `templates/prompts/demand-extract.md`：提炼提示词——输入原始信号清单，输出 JSON 数组 [{id, kind, opportunity}]；遵守真实感红线（opportunity 不编数字）

## 采集请求标记

不建新表——在 settings 表存 `demand_collect_requested_at` 键。Web 页「请求采集」按钮 → POST /api/demand/request-collect → 写当前时间戳；importSignals 成功后自动清除该键并写 `demand_last_collected_at`（同选题库 scrape_requested_at 语义）。对话里直接喊我采集则不经过标记，直接采集导入。

## API（packages/server/src/app.ts）

- GET /api/demand/signals?source=&kind=&status= — 列表
- POST /api/demand/import — body { source, signals: [{title, summary?, evidence?, heat?}] }，批量 upsert
- PATCH /api/demand/signals/:id — body { status }（star/忽略）
- POST /api/demand/extract — 任务队列+SSE（调 LLM）
- POST /api/demand/request-collect — 打采集请求标记
- GET /api/demand/collect-status — 返回 requested_at（前端显示"待采集"状态）

## CLI（cli.ts 新 case 'demand'）

- `forgecast demand import --source=<src> --file=<signals.json>`
- `forgecast demand list [--source=] [--kind=] [--status=]`
- `forgecast demand extract`
- `forgecast demand star <id>` / `forgecast demand dismiss <id>`

## Web 界面

找项目页（ScoutPage）外套 seg-tabs：「项目池 / 需求信号」（同 MarketPage/WorkshopPage 的 ?tab= 模式；现有 ScoutPage 内容原样变成"项目池" tab）。

需求信号 tab：
- 顶部：kind 筛选 chips（全部/热点流量/情绪价值/供给热度）+「请求采集」按钮（打标记，显示待采集状态）
- 卡片列表：title / source 徽标 / heat / opportunity / evidence 里的链接 / star·忽略按钮
- starred 的卡片视觉高亮（这是 C 阶段的输入）

## 给 C 留的接口语义

`status='starred'` 的信号 = C 阶段"需求×项目匹配"的候选输入。本轮不建匹配关联表、不改 candidates/projects 表。

## 不做的事

- 不做任何定时/无人值守抓取代码。
- 不做跨源热度归一化算法（同源内可比即可）。
- 不做 C 阶段的匹配逻辑（只留 starred 语义）。
- 不动选题库（topics）现有代码——两者并存，选题库管"内容怎么写"，需求库管"选什么品"。

## 验证

1. `pnpm test` 全仓 + 新包测试（signals CRUD/upsert 去重、extract mock 校验、API 路由、CLI 冒烟）。
2. 端到端：我用 ego-browser 实采一轮四个源 → import 入库 → extract 提炼 → Web 需求信号 tab 能看到带分类和机会方向的卡片 → star 一条 → CLI list 能筛出 starred。
3. 测试数据（非真实采集的）用完清理。
