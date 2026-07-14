# Docker 部署（app 单容器：API + Web 静态托管）设计

> §12 部署落地。补齐"app = Hono API + Web 静态托管"（现缺静态托管），修 Dockerfile 使 `docker compose up` 真能跑出可用的 Web 控制台。本地 Docker 构建（路径含中文 → `DOCKER_BUILDKIT=0`）。

## 缺口
- server 无静态托管：app 容器只有 API，没 Web UI。
- Dockerfile CMD=`server dev`（只 API、dev 模式），未构建 web。
- server 硬编码绑 127.0.0.1 → 容器内绑 localhost，compose 端口映射到不了、host 访问不了。
- node:20-slim 缺 build 工具，better-sqlite3 需编译。

## 方案
### ① server 静态托管（packages/server/src/app.ts）
所有 /api 路由之后加 catch-all `/*`（零新依赖，用 fs）：
- webDist = `FORGECAST_WEB_DIST` ?? `<root>/apps/web/dist`；**dist 不存在则不注册**（本地 dev 用 Vite 不受影响）。
- `/api/*` 未匹配 → JSON 404；其余：命中 dist 内文件按 MIME 返回；否则 SPA 回落 index.html。
- 目录穿越防护：`resolve(file).startsWith(webDist)` 不成立则回落 index。
- 返回 `new Response(fs.readFileSync(file), {headers})`（避开 c.body Buffer 类型问题）。

### ② server 绑定 host（packages/server/src/index.ts）
`hostname = process.env.FORGECAST_HOST ?? '127.0.0.1'`。容器内设 `FORGECAST_HOST=0.0.0.0`（Dockerfile ENV），**安全靠 compose `127.0.0.1:4321:4321` host 侧只 localhost**。

### ③ Dockerfile（app）
加 `apt-get install python3 make g++ ca-certificates`（better-sqlite3 编译）；`pnpm install` 后 `pnpm --filter web build`（产 apps/web/dist 进镜像）；`ENV FORGECAST_HOST=0.0.0.0`；CMD `pnpm exec tsx packages/server/src/index.ts`（生产起 server，托管 API+Web）。

### ④ docker-compose.yml
`env_file` 改为可选（`- path: .env / required: false`，设置页时代 .env 非必需）。renderer 段不变（profile render，本轮不强制构建）。

### ⑤ .dockerignore
补 `apps/web/dist`（镜像内重建）、`.cache/`、`templates/knowledge/dbskill/`（CC BY-NC 不进镜像）、`docs`、`.superpowers`、`*.log`。

## 验证
1. 本地：`pnpm --filter web build` 后直接起 server → `curl :4321/` 返回 index.html、`/api/projects` 返回 JSON、未知 `/api/x` 返回 JSON 404。
2. Docker：`DOCKER_BUILDKIT=0 docker compose build app` 成功；`docker compose up -d app` 后 host `curl 127.0.0.1:4321/`(Web)+`/api/settings`(API) 通；浏览器加载看 UI。
3. 数据持久：db/workspace/templates 挂载到 host，容器重建不丢。

## 范围外
- renderer 镜像实际构建（Chromium+ffmpeg，重；本轮 app 为主，视频/封面渲染在 app 内因无 Chromium 会 fail-soft 降级，文档说明）。
- CN 服务器镜像源（本地 Mac 构建无需）。

## 约束
- `DOCKER_BUILDKIT=0`（中文路径）；`pnpm -r test` 仍全绿；server tsc；trailer；不破坏本地 dev（无 dist 不托管）。
