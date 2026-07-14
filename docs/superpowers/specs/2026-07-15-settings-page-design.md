# Web 设置页 + 配置持久化 设计

> 让用户在 Web 界面填 LLM/TTS/GitHub 的 key/模型/开关，存本地 SQLite，运行时生效（覆盖 env 默认），key 打码回显。为 Docker 部署后在容器 Web 里配置服务铺路。范围 v1 仅 key/模型/mode（不含 topics/权重/发布规则）。

## 安全底线（本地单用户工具）
- key 只存本地 `db/`(gitignored)、随 volume 走，不进代码仓/镜像；服务只绑 127.0.0.1。
- `GET /api/settings` 绝不回明文 key——回 `key_set` + `key_masked`("••••"+后4位)。
- `PUT`：key 字段留空=保持原值，填新值才覆盖。
- "测试连接"在服务端用当前 key 发请求，key 不出后端。

## ① 存储（core）
db.ts 加表：`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`。
新增 `packages/core/src/settings.ts`：
- `SETTING_KEYS`：`llm_mode, llm_key, llm_base_url, model_analysis, model_copy, model_scoring, tts_mode, tts_key, tts_model, tts_base_url, github_mode, github_token`（白名单，PUT 只认这些）。
- `getAllSettings(db): Record<string,string>`；`setSettings(db, kv: Record<string,string>)`（幂等 upsert）。
- `applyStoredSettings(config, db)`：读 settings，**非空值覆盖** config 对应字段（llm_key→llm.apiKey、model_*→llm.models.*、tts_*→tts.*、github_*→github.* 等）。
- `normalizeModes(config)`：`llm.mode==='live' && !llm.apiKey → mock`；`tts.mode==='live' && !tts.apiKey → stub`（live 缺 key 优雅降级，不崩）。
- `maskKey(v): string`（空→''；否则 '••••'+后4位）。

## ② 配置解析优先级
`createCtx`(ctx.ts) 流程改为：`loadConfig(env)` → `openDb` → `applyStoredSettings(config, db)` → `normalizeModes(config)`。
优先级：**stored 非空 > env > 默认**（loadConfig 已给 env/默认，stored 再覆盖）。CLI 与 server 都走 createCtx，故命令行也吃 UI 设置。
loadConfig 去掉"live 无 key 直接 throw"（改由 normalizeModes 降级），避免 UI 提供 key 的场景在启动即崩。

## ③ 即时生效（不重启）
server 持有单个 ctx。`PUT /api/settings` 写库后调 `refreshCtx(ctx)`：重跑 applyStoredSettings+normalizeModes 到 `ctx.config`（就地改子对象字段）并**重建 `ctx.llm = createLlmClient(ctx.config.llm)`**（因 mock/live 在创建时决定）。tts/github client 均调用时读 ctx.config，无需重建。

## ④ 后端接口（server/app.ts）
- `GET /api/settings` → `{ llm:{mode,key_set,key_masked,base_url,models:{analysis,copy,scoring}}, tts:{mode,key_set,key_masked,base_url,model}, github:{mode,token_set,token_masked} }`（打码）。
- `PUT /api/settings` body 部分字段：白名单校验；key 字段空串/缺省=不改，非空=覆盖；写库→refreshCtx→回新的打码视图。
- `POST /api/settings/test-llm` → 用当前 `ctx.llm` 发极小请求（如 prompt "ping"），回 `{ok:boolean, message:string}`；mock 模式回"当前为 mock，未用真实 key"。

## ⑤ 前端设置页（用 frontend-design skill 设计视觉）
导航加"设置"(/settings)。三段卡片 LLM / TTS / GitHub：每段 mode 开关(live/mock 或 live/stub)、key(password 输入，占位显示 key_masked)、baseURL、模型 id 输入；底部保存 + "测试连接"(仅 LLM)。保存成功 toast/提示；测试连接显示结果。TanStack Query 取/存。

## ⑥ 测试
- core: settings.ts —— setSettings/getAllSettings 往返；applyStoredSettings 覆盖优先级(stored>env)；normalizeModes(live 缺 key→降级)；maskKey。
- server: GET 打码不含明文；PUT 空 key 不覆盖、非空覆盖 + refreshCtx 后 ctx.llm 重建（可断言 mode 切换）；test-llm mock 分支。
- web: 人工走查（起服务，填假 key、保存、测试连接、刷新看打码）。

## 范围外
- video_mode/scout topics/评分权重/发布规则（保持 env/现状）。
- Docker 部署 = 第二阶段，本 spec 完成验证后单独做（`DOCKER_BUILDKIT=0`、构建重/慢）。

## 约束
- 沿用：中文；TDD（core/server）；trailer；`pnpm -r test` 全绿；Web 过 tsc+build；key 不落日志/不回明文。
